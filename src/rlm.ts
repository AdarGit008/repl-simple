import type { RlmIteration, RlmOptions, RlmResult, RunResult } from "./types.js";
import { runInSandbox } from "./sandbox.js";
import type { SandboxOptions } from "./sandbox.js";

// ── System prompt ────────────────────────────────────────────────

export const DEFAULT_RLM_SYSTEM_PROMPT = `\
You are a Python data analyst. You have access to a sandboxed Python environment.

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
  // One regex per shape (as before) never expressed that structure.
  const fenceOpen = /^([ \t]*)```([A-Za-z0-9_+-]*)[^\S\r\n]*(?:\r?\n)?/gm;
  const fenceClose = /[ \t]*```/g;

  let fenced: { code: string } | null = null;
  fenceOpen.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = fenceOpen.exec(text)) !== null) {
    const indent = open[1];
    fenceClose.lastIndex = fenceOpen.lastIndex;
    const close = fenceClose.exec(text);
    if (!close) continue; // Unclosed fence — not a complete block.
    const raw = text.slice(fenceOpen.lastIndex, close.index);
    fenced = { code: cleanFenceContent(raw, indent) };
  }
  if (fenced) return { kind: "code", code: fenced.code, from: "fence" };

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
  const detrailed = raw.replace(/\r?\n[ \t]*$/, "");
  const trimmed = detrailed.trim();
  if (!fenceIndent) return trimmed;
  return trimmed
    .split("\n")
    .map((line) => (line.startsWith(fenceIndent) ? line.slice(fenceIndent.length) : line))
    .join("\n");
}

/**
 * The direct-answer contract (#73, reused by #76's salvage): the tail of the
 * reply matches an explicit anchor, and the captured fragment cannot contain
 * sentence-final punctuation or newlines — so "The answer is 42. Let me
 * submit." is NOT an answer, while leading prose is fine ("Based on the
 * data, the answer is 42."). Surrounding quotes and markdown emphasis are
 * stripped; an empty result is rejected.
 */
const DIRECT_ANSWER_RE =
  /(?:the answer is|answer is|the answer:|answer:)\s*([^.!?\n]+)["'“”]?\s*[.!?]?\s*$/i;

export function extractDirectAnswer(text: string): string | null {
  const m = text.match(DIRECT_ANSWER_RE);
  if (!m) return null;
  let answer = m[1].trim();
  answer = stripWrapping(answer, ["'", '"', "“", "”"]);
  answer = stripWrapping(answer, ["**", "__", "*", "_"]);
  return answer.length > 0 ? answer : null;
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
  const parts = [`# Question\n${question}`];
  for (const [name, value] of Object.entries(inputs)) {
    const header = name === "context" ? "# Context" : "# Input";
    parts.push(`\n${header} (available as \`${name}\` variable)`);
    if (value) {
      const preview =
        value.length > 5000 ? `${value.slice(0, 2500)}\n...\n${value.slice(-2500)}` : value;
      parts.push(`\`\`\`\n${preview}\n\`\`\``);
    }
  }
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
    let feedback = `Error: ${result.error}\nstdout: ${result.stdout}`;
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

  const output = result.output !== "None" ? result.output : "";
  const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : "";
  return `Output: ${output}${stdout}`;
}

// ── Main API ─────────────────────────────────────────────────────

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

    // 2. Extract Python code
    const code = extractPythonCode(llmResponse);

    // 3. Build full script: preamble (if any) + code
    const fullCode = options.preamble ? `${options.preamble}\n${code}` : code;

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
    const feedback = buildFeedback(result);
    messages.push({ role: "user", content: feedback });
  }

  // Max iterations exhausted
  const lastAnswer = extractBestAnswer(iterations);
  return { status: "max_iterations", answer: lastAnswer, iterations };
}
