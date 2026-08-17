import type { RlmIteration, RlmOptions, RlmResult, RunResult } from "./types.js";
import { runInSandbox } from "./sandbox.js";
import type { SandboxOptions } from "./sandbox.js";
import {
  truncateText,
  STDOUT_MAX_BYTES,
  STDOUT_HEAD_RATIO,
  STDOUT_RECOVERY,
  OUTPUT_MAX_BYTES,
  VALUE_HEAD_RATIO,
  VALUE_RECOVERY,
} from "./truncate.js";

// ── Feedback budgets ────────────────────────────────────────────
//
// The sandbox already caps `stdout` (32 KiB) and `output` (16 KiB), but a
// caller may raise either ceiling via `runOptions`. The feedback must not
// inherit that raised ceiling, so it re-caps here with the same budgets and
// the same shared helper — the normal path is a marker-free no-op (#74, D1).

/** Byte ceiling for `stdout` in a feedback message. */
const FEEDBACK_STDOUT_MAX_BYTES = STDOUT_MAX_BYTES;

/** Byte ceiling for `output` in a feedback message. */
const FEEDBACK_OUTPUT_MAX_BYTES = OUTPUT_MAX_BYTES;

/** Byte ceiling for `result.error` in a feedback message (16 KiB, value shape). */
const ERROR_MAX_BYTES = 16 * 1024;

/**
 * Route to an elided error: the model owns the Python, so it can wrap the
 * failing code in `try/except` and print the full traceback to see the whole
 * exception the feedback truncated away (#144, D7).
 */
const ERROR_RECOVERY = "Catch the exception and print the full traceback to see more.";

// ── Conversation budget ─────────────────────────────────────────
//
// The feedback caps bound each turn, but the conversation as a whole grows by
// two messages per iteration with no ceiling of its own. The cumulative budget
// below is the backstop: when the whole conversation exceeds it, the oldest
// middle turns are dropped in whole assistant+feedback pairs (#74, D2).

/** Byte ceiling on the whole RLM conversation, over every message's content. */
const MAX_CONVERSATION_BYTES = 256 * 1024;

// ── Initial-prompt aggregate cap ───────────────────────────────
//
// Each input renders a bounded ~5 KB head/tail preview, but the aggregate
// still scales with the input count. The assembled input section is re-cut as
// one flat head+tail so the initial message cannot grow with N (#74, D6).

/** Byte ceiling on the rendered input-preview section of the initial prompt. */
const INPUT_PREVIEW_MAX_BYTES = 32 * 1024;

/**
 * Route to an elided input: each input is already declared as a named sandbox
 * variable, so the recovery is to slice that variable — no assignment step is
 * needed (unlike `VALUE_RECOVERY`, where the value has no name yet).
 */
const INPUT_PREVIEW_RECOVERY =
  "Each input is available as a named Python variable — slice it in Python to see more.";

/** Byte ceiling for the `question` in the initial prompt (64 KiB, value shape). */
const QUESTION_MAX_BYTES = 64 * 1024;

/**
 * Route to an elided question: the question is not a sandbox variable, so the
 * model cannot slice it — the marker must not advertise a route it cannot
 * honour (policy Q3). It directs the model to answer from the part shown and
 * flag ambiguity instead (#144, D8).
 */
const QUESTION_RECOVERY =
  "The question was truncated. Answer from the part shown and state the assumption if ambiguous.";

/**
 * UTF-8 length of a message's content — the unit the conversation budget is
 * measured in. `TextEncoder` yields the same count without reintroducing
 * byte-level measurement here (the shared truncator owns that, #74 invariant 4).
 */
const textEncoder = new TextEncoder();

function contentBytes(text: string): number {
  return textEncoder.encode(text).length;
}

// ── System prompt ────────────────────────────────────────────────

export const DEFAULT_RLM_SYSTEM_PROMPT = `\
You are a Python data analyst. You have access to a sandboxed Python environment.

Each iteration runs in a fresh sandbox. No variables, imports, or state carry
over between iterations: every code snippet you submit must be self-contained,
re-declaring or recomputing whatever it needs.

Your job: investigate the user's question by writing Python code, running it,
interpreting the results, and submitting your final answer.

Rules:
- Write ONLY Python code between \`\`\`python fences.
- Use print() to inspect data. stdout is returned to you.
- The last expression value is also returned.
- Call llm_query(prompt) to ask for reasoning help.
- Call SUBMIT(answer) exactly once when you have the final answer.
- NEVER call SUBMIT without first investigating.
- If code errors, read the error message, fix the code, and retry.
- Be thorough. Don't jump to conclusions.`;

// ── Helpers ──────────────────────────────────────────────────────

/** What a reply yields for the loop: code (fenced or raw), or a direct answer. */
export type CodeExtraction =
  | { kind: "code"; code: string; from: "fence" | "raw" }
  | { kind: "answer"; answer: string };

/**
 * Extract Python code from an LLM reply.
 *
 * Priority order:
 * 1. The **last complete fenced block** — a later block is a correction of an
 *    earlier one (#73). The tag is tolerated (py, python, python3, any other,
 *    case-insensitive), as are single-line fences, fences with no newline
 *    before the close, and indented fences. Unclosed fences are skipped.
 * 2. A **direct answer** — a fence-less reply whose tail matches
 *    `extractDirectAnswer`. Recognised, never executed as code.
 * 3. Raw fall-through — the whole reply is treated as code, marked
 *    `from: "raw"` so the loop can tell the model what happened.
 */
export function extractPythonCode(text: string): CodeExtraction {
  // Two-stage scan: an opening fence and its matching close delimit a block.
  // One regex per shape (as before) never expressed that structure. The close
  // must be a backtick run at line end (EOL-anchored lookahead): a ``` inside
  // the content — `print("```")` — is not a close. The open scan skips past a
  // consumed close, so a close line can never be re-consumed as an opening.
  const fenceOpen = /^([ \t]*)```([A-Za-z0-9_+-]*)[^\S\r\n]*(?:\r?\n)?/gm;
  const fenceClose = /```(?=[^\S\r\n]*(?:\r?\n|$))/g;

  let fenced: string | null = null;
  fenceOpen.lastIndex = 0;
  let open = fenceOpen.exec(text);
  while (open !== null) {
    const indent = open[1];
    fenceClose.lastIndex = fenceOpen.lastIndex;
    const close = fenceClose.exec(text);
    // No close after this open means none after any later open either (opens
    // advance monotonically), so the scan is linear, not O(k·n) — a reply of
    // unclosed openings used to re-scan the whole suffix per open.
    if (!close) break;
    const raw = text.slice(fenceOpen.lastIndex, close.index);
    fenced = cleanFenceContent(raw, indent);
    fenceOpen.lastIndex = fenceClose.lastIndex;
    open = fenceOpen.exec(text);
  }
  if (fenced !== null) return { kind: "code", code: fenced, from: "fence" };

  const answer = extractDirectAnswer(text);
  if (answer !== null) return { kind: "answer", answer };

  return { kind: "code", code: text.trim(), from: "raw" };
}

/**
 * Strip the fence structure from raw block content: the newline directly
 * before the closing fence belongs to the fence (and the close line's own
 * indentation goes with it), then dedent by the opening fence's indent — an
 * indented fence implies uniformly indented content.
 */
function cleanFenceContent(raw: string, fenceIndent: string): string {
  // Normalise CRLF first so dedent splits on \n only and never leaks a \r
  // into the middle of a line; trim handles the fence's own trailing
  // whitespace (structural newline and the close line's indent alike).
  const trimmed = raw.replace(/\r\n/g, "\n").trim();
  if (!fenceIndent) return trimmed;
  return trimmed
    .split("\n")
    .map((line) => (line.startsWith(fenceIndent) ? line.slice(fenceIndent.length) : line))
    .join("\n");
}

/**
 * The direct-answer contract (#73, reused by #76's salvage). The reply is
 * searched for the LAST anchor occurrence (linear `lastIndexOf` over the four
 * variants) and only that tail is validated against an anchored pattern — a
 * `$`-anchored scan over every anchor occurrence backtracks quadratically on
 * adversarial replies. A decimal (e.g. "The answer is 3.14.") matches first,
 * then the general fragment rule: no sentence-final punctuation or newlines —
 * so "The answer is 42. Let me submit." is NOT an answer, while leading prose
 * is fine ("Based on the data, the answer is 42."). Surrounding quotes and
 * markdown emphasis are stripped to a fixpoint; an empty result is rejected.
 * A comma hedge ("42, I think") is submitted verbatim — pinned by test,
 * refinement deferred to #76's synthesis.
 */
const ANCHORS = ["the answer is", "answer is", "the answer:", "answer:"];

/** Index of the LAST anchor occurrence (case-insensitive), or -1. */
function lastAnchorIndex(text: string): number {
  let best = -1;
  const lower = text.toLowerCase();
  for (const anchor of ANCHORS) {
    const idx = lower.lastIndexOf(anchor);
    if (idx > best) best = idx;
  }
  return best;
}

const DECIMAL_ANSWER_RE =
  /^(?:the answer is|answer is|the answer:|answer:)\s*([+-]?\d+\.\d+)\s*[.!?]?\s*$/i;
const DIRECT_ANSWER_RE =
  /^(?:the answer is|answer is|the answer:|answer:)\s*([^.!?\n]+)["'“”]?\s*[.!?]?\s*$/i;

export function extractDirectAnswer(text: string): string | null {
  const idx = lastAnchorIndex(text);
  if (idx === -1) return null;
  const tail = text.slice(idx);
  const decimal = tail.match(DECIMAL_ANSWER_RE);
  if (decimal) return decimal[1];
  const m = tail.match(DIRECT_ANSWER_RE);
  if (!m) return null;
  const answer = stripWrappers(m[1].trim());
  return answer.length > 0 ? answer : null;
}

/** Strip quote and emphasis pairs alternately, to a fixpoint (bounded). */
function stripWrappers(s: string): string {
  let out = s;
  for (let i = 0; i < 4; i++) {
    const emph = stripWrapping(stripWrapping(out, ["'", '"', "“", "”"]), ["**", "__", "*", "_"]);
    if (emph === out) return out;
    out = emph;
  }
  return out;
}

/** Remove one surrounding pair from `wrappers` (longest first), if present. */
function stripWrapping(s: string, wrappers: string[]): string {
  for (const w of wrappers) {
    if (s.length >= 2 * w.length && s.startsWith(w) && s.endsWith(w)) {
      return s.slice(w.length, s.length - w.length);
    }
  }
  return s;
}

/**
 * Race a promise against an AbortSignal.
 * If the signal fires first, throws DOMException("AbortError").
 * Does NOT abort the underlying operation — just rejects this call.
 */
async function raceAgainstSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Build the initial user message for the RLM loop.
 *
 * Announces every sandbox input by name so the model knows it exists: data
 * present in the sandbox but unnamed in the instructions is invisible (#72).
 * `context` keeps its legacy header; other keys get the parallel `# Input`
 * header. Values render as preview blocks — head-and-tail beyond 5000 chars —
 * and empty values render header-only, never an empty fence.
 */
function buildInitialPrompt(question: string, inputs: Record<string, string>): string {
  const inputParts: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    const header = name === "context" ? "# Context" : "# Input";
    inputParts.push(`${header} (available as \`${name}\` variable)`);
    if (value) {
      const preview =
        value.length > 5000 ? `${value.slice(0, 2500)}\n...\n${value.slice(-2500)}` : value;
      inputParts.push(`\`\`\`\n${preview}\n\`\`\``);
    }
  }

  // Per-value previews bound each input, but not their sum. Cut the assembled
  // section as one flat head+tail so N inputs cannot scale the initial prompt
  // past this budget (#74, D6).
  const { text: inputSection } = truncateText(inputParts.join("\n"), {
    maxBytes: INPUT_PREVIEW_MAX_BYTES,
    headRatio: VALUE_HEAD_RATIO,
    recovery: INPUT_PREVIEW_RECOVERY,
  });

  // The question is never dropped from `messages[0]`, so its budget bounds the
  // worst case while leaving every realistic question untouched (#144, D8).
  const { text: q } = truncateText(question, {
    maxBytes: QUESTION_MAX_BYTES,
    headRatio: VALUE_HEAD_RATIO,
    recovery: QUESTION_RECOVERY,
  });

  const parts = [`# Question\n${q}`];
  if (inputSection) parts.push(`\n${inputSection}`);
  parts.push(`\nWrite Python code to answer the question. Call SUBMIT(answer) when done.`);
  return parts.join("\n");
}

/** Extract the best available answer when max iterations are exhausted. */
function extractBestAnswer(iterations: RlmIteration[]): string {
  // Last successful output, or last error message
  for (let i = iterations.length - 1; i >= 0; i--) {
    const r = iterations[i].result;
    if (r.status === "ok" && r.output && r.output !== "None") return r.output;
  }
  // Fallback: last iteration's stdout
  for (let i = iterations.length - 1; i >= 0; i--) {
    if (iterations[i].result.stdout) return iterations[i].result.stdout;
  }
  return "(no answer)";
}

/**
 * Build the feedback message for the LLM after a sandbox run.
 * Tells the LLM what happened and what to do next.
 *
 * Exported for the test over every `RunErrorKind`. Two of the kinds are only
 * reachable in anger by exhausting a real worker pool, which is not something a
 * unit test should do to the process it shares with the rest of the suite —
 * and a kind that falls through this chain silently tells the model nothing at
 * all, which is the failure being guarded against.
 */
export function buildFeedback(result: RunResult): string {
  if (result.status === "error") {
    const { text: stdout } = truncateText(result.stdout, {
      maxBytes: FEEDBACK_STDOUT_MAX_BYTES,
      headRatio: STDOUT_HEAD_RATIO,
      recovery: STDOUT_RECOVERY,
    });
    const { text: error } = truncateText(result.error, {
      maxBytes: ERROR_MAX_BYTES,
      headRatio: VALUE_HEAD_RATIO,
      recovery: ERROR_RECOVERY,
    });
    let feedback = `Error: ${error}\nstdout: ${stdout}`;
    if (result.errorKind === "syntax") {
      feedback += "\n\nFix the syntax error in your Python code.";
    } else if (result.errorKind === "typing") {
      feedback += "\n\nFix the type error in your Python code.";
    } else if (result.errorKind === "runtime") {
      feedback += "\n\nFix the runtime error. Check your logic.";
    } else if (result.errorKind === "timeout") {
      // Not "check your logic": the code may be perfectly correct and simply
      // too expensive, and a model told to fix a bug it cannot find will
      // rewrite the wrong thing. What it can act on is the cost.
      feedback +=
        "\n\nExecution ran out of time. Do less work: shrink the input, lower the " +
        "iteration count, or split the task across turns.";
    } else if (result.errorKind === "memory") {
      feedback +=
        "\n\nExecution ran out of memory. Hold less at once: stream or chunk the data " +
        "instead of building the whole result in a list.";
    } else if (result.errorKind === "unavailable") {
      // Nothing ran, so there is nothing to fix. Saying so keeps the model from
      // "correcting" code that was never the problem.
      feedback +=
        "\n\nThe sandbox could not be started — the host was out of capacity, not your code. " +
        "Retry the same code.";
    } else if (result.errorKind === "aborted") {
      feedback += "\n\nExecution was aborted.";
    } else if (result.errorKind === "crashed") {
      // Distinct advice, because the situation is distinct: the sandbox is
      // gone rather than merely unhappy, so every variable, import and
      // definition from earlier in the run went with it. Telling the model to
      // "fix the error" would invite it to build on state that no longer
      // exists.
      feedback +=
        "\n\nThe sandbox was terminated and all its state was lost. " +
        "Retry with self-contained code that does not rely on anything " +
        "defined earlier, and make it cheaper — the usual cause is running " +
        "too long.";
    }
    return feedback;
  }

  if (result.status === "suspended") {
    return (
      "Error: execution suspended (tool requires approval). " +
      "Do not use tools that require approval. " +
      "Use print() and basic Python operations instead."
    );
  }

  // result.status === "ok"
  if (result.output === "None" && !result.stdout) {
    return "Your code ran without errors and produced no output. Write more code to investigate.";
  }

  const { text: output } = truncateText(result.output !== "None" ? result.output : "", {
    maxBytes: FEEDBACK_OUTPUT_MAX_BYTES,
    headRatio: VALUE_HEAD_RATIO,
    recovery: VALUE_RECOVERY,
  });
  const { text: stdout } = truncateText(result.stdout, {
    maxBytes: FEEDBACK_STDOUT_MAX_BYTES,
    headRatio: STDOUT_HEAD_RATIO,
    recovery: STDOUT_RECOVERY,
  });
  const stdoutSection = stdout ? `\nstdout:\n${stdout}` : "";
  return `Output: ${output}${stdoutSection}`;
}

// ── Main API ─────────────────────────────────────────────────────

/**
 * Prepended to the feedback when a fence-less reply was treated as raw code.
 * Without it, a SyntaxError on prose is baffling: the model is told to fix a
 * syntax error in code it never wrote (#73).
 */
const RAW_FALLBACK_NOTICE = "Note: no code block found — treating the whole reply as Python code.";

/**
 * The D3 notice emitted when oldest-middle turns are dropped. User role,
 * pi-style ellipsis vocabulary, consistent with the truncation markers: the
 * model must know the history it sees is partial, not assume completeness.
 */
function historyDropMarker(droppedTurns: number): string {
  return `[… ${droppedTurns} earlier turns dropped — conversation bounded at 256KB. The most recent context follows. …]`;
}

/**
 * Bound the conversation to `MAX_CONVERSATION_BYTES` (D2).
 *
 * Drops the oldest middle turns in whole assistant+feedback pairs — the
 * initial user message and the newest pair are never dropped — so a feedback
 * never dangles without its assistant message. When anything is dropped, a
 * user-role marker (D3) is inserted right after the initial message and
 * counts toward the budget. A single over-budget message (an LLM reply the
 * loop cannot truncate without summarising) is kept and may exceed the budget
 * transiently until it ages out (#74, Assumption 4).
 *
 * `droppedTurns` is the cumulative count across iterations; the function
 * returns the updated count.
 */
function boundConversation(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  droppedTurns: number,
): number {
  // A prior marker always sits at index 1, right after the initial message,
  // and is the only user-role message that can occupy that slot (a feedback
  // never appears there while pairs are whole). Strip it before dropping so
  // `splice(1, 2)` always removes a whole assistant+feedback pair, then
  // re-insert a fresh marker with the cumulative count below.
  if (messages.length >= 2 && messages[1].role === "user") {
    messages.splice(1, 1);
  }

  const totalBytes = () =>
    messages.reduce((sum, message) => sum + contentBytes(message.content), 0);

  // Drop the oldest pairs while over budget. A droppable pair is the oldest
  // assistant+feedback pair after the initial message; dropping needs at least
  // two pairs — one to drop and the newest to keep — i.e. five messages.
  while (totalBytes() > MAX_CONVERSATION_BYTES && messages.length >= 5) {
    messages.splice(1, 2);
    droppedTurns++;
  }

  if (droppedTurns === 0) return 0;

  // The marker counts toward the budget; if it would push the conversation
  // back over, drop more oldest pairs first.
  let marker = historyDropMarker(droppedTurns);
  while (totalBytes() + contentBytes(marker) > MAX_CONVERSATION_BYTES && messages.length >= 5) {
    messages.splice(1, 2);
    droppedTurns++;
    marker = historyDropMarker(droppedTurns);
  }

  messages.splice(1, 0, { role: "user", content: marker });
  return droppedTurns;
}

/**
 * Run the Repeated LLM → Monty loop.
 *
 * Takes a question, iteratively generates Python code via the LLM,
 * runs it in a Monty sandbox, feeds results back, and repeats until
 * the code calls SUBMIT(answer) or max iterations are exhausted.
 *
 * SUBMIT throws `SubmitSignal` which the sandbox catches and returns
 * as `{ status: "ok", output: answer }` with a SUBMIT call in the
 * trace. The loop detects this and terminates.
 */
export async function runRlm(question: string, options: RlmOptions): Promise<RlmResult> {
  // Validate required options
  if (!options.llmClient || typeof options.llmClient.query !== "function") {
    throw new Error("options.llmClient is required and must implement LlmClient.query()");
  }

  const llmClient = options.llmClient;
  const registry = options.registry;
  const maxIterations = options.maxIterations ?? 10;
  const systemPrompt = options.systemPrompt ?? DEFAULT_RLM_SYSTEM_PROMPT;
  const iterations: RlmIteration[] = [];

  // Build sandbox options
  const sandboxOpts: SandboxOptions = { registry };

  // Build sandbox RunOptions (combine RLM-level runOptions with inputs/scriptName)
  const sandboxRunOpts = options.runOptions ? { ...options.runOptions } : {};
  // `context` is always declared, defaulting to "" — the shipped preamble
  // (repl_server.py) references it from its helper bodies, and an undeclared
  // input is a deterministic type-check failure on every iteration (#72).
  const runInputs: Record<string, string> = {
    ...(sandboxRunOpts.inputs ?? {}),
    ...(options.inputs ?? {}),
  };
  runInputs.context = runInputs.context ?? "";
  sandboxRunOpts.inputs = runInputs;
  sandboxRunOpts.scriptName = sandboxRunOpts.scriptName ?? "rlm.py";
  if (options.signal) {
    sandboxRunOpts.signal = options.signal;
  }

  // Build initial conversation
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    {
      role: "user",
      content: buildInitialPrompt(question, runInputs),
    },
  ];

  // Cumulative number of whole turns dropped by the conversation bound (D3).
  let droppedTurns = 0;

  for (let i = 0; i < maxIterations; i++) {
    // Abort check between iterations
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    // 1. Call LLM (with abort race)
    const llmResponse = await raceAgainstSignal(
      llmClient.query(systemPrompt, messages),
      options.signal,
    );

    // 2. Extract the payload: a fenced block, a direct answer, or the
    // raw reply treated as code. A direct answer is executed as a
    // synthesised SUBMIT — it exits through the same RunOk + ok-SUBMIT
    // trace as a model-written call, so provenance is unchanged (#76
    // layers on top); the prose itself is never executed.
    const extraction = extractPythonCode(llmResponse);
    const code =
      extraction.kind === "answer"
        ? `SUBMIT(${JSON.stringify(extraction.answer)})`
        : extraction.code;

    // 3. Build full script: preamble (if any) + code
    const fullCode = options.preamble ? `${options.preamble}\n${code}` : code;
    if (options.preamble) {
      // The preamble is the prefix the sandbox numbers its diagnostics from,
      // so the loop owns the offset: computed from the preamble string
      // actually used, never a hardcoded constant (#77, D1).
      sandboxRunOpts.lineOffset = options.preamble.split("\n").length;
    }

    // 4. Run in sandbox
    const result = await runInSandbox(fullCode, sandboxOpts, sandboxRunOpts);

    // 5. Record iteration
    const iteration: RlmIteration = {
      index: i,
      code,
      result,
      llmResponse,
    };
    iterations.push(iteration);
    options.onIteration?.(iteration);

    // 6. Check for SUBMIT
    //
    // SubmitSignal → sandbox returns status:"ok" with output=answer and a
    // SUBMIT entry in the trace with ok:true. `ok` is the whole condition, not
    // decoration: a call whose arguments do not resolve — `SUBMIT("a",
    // **{"answer": "b"})`, which Monty's checker cannot see through — is traced
    // ok:false and re-raised into Python as a TypeError. Stopping on it
    // returned either that TypeError or, if the model caught it, the script's
    // last expression value, both presented as the final answer (#71).
    // Requiring ok lets the error reach the next iteration's feedback instead.
    // The status test is the same invariant read from the other end — a
    // successful SubmitSignal short-circuits the sandbox to "ok" — and it is
    // what lets `output` be read without a fallback for a status that cannot
    // occur here.
    const submitted = result.calls.some((c) => c.tool === "SUBMIT" && c.ok);
    if (submitted && result.status === "ok") {
      return { status: "ok", answer: result.output, iterations };
    }

    // 7. Append iteration to conversation
    messages.push({ role: "assistant", content: llmResponse });

    // 8. Build feedback for next iteration
    const feedback =
      (extraction.kind === "code" && extraction.from === "raw"
        ? `${RAW_FALLBACK_NOTICE}\n\n`
        : "") + buildFeedback(result);
    messages.push({ role: "user", content: feedback });

    // 9. Bound the conversation: drop the oldest middle turns in whole pairs
    // and tell the model when history was dropped (#74, D2/D3).
    droppedTurns = boundConversation(messages, droppedTurns);
  }

  // Max iterations exhausted
  const lastAnswer = extractBestAnswer(iterations);
  return { status: "max_iterations", answer: lastAnswer, iterations };
}
