import { readFileSync } from "node:fs";
// `@pydantic/monty/node`, not the package root, here and in every other file.
//
// The root's `exports` map points `types` at `index.d.ts` while pointing every
// runtime condition at `node.js` — and `index.d.ts` is the portable subset,
// missing `MountDir` among others. So the root specifier hands the compiler a
// narrower surface than it hands the process: `MountDir` resolves fine at
// runtime and does not exist to `tsc`. `/node` is the same module with the
// types that match it.
//
// It also states what this package requires. The native worker is where crash
// isolation and the surviving event loop come from; the `wasm` entry runs
// Python in-process with neither, which is 0.0.18's failure mode wearing
// 0.0.21's API (see docs/platform-support.md).
import {
  FunctionSnapshot,
  FutureSnapshot,
  MontyComplete,
  MontyCrashedError,
  MontyRuntimeError,
  MontySyntaxError,
  MontyTypingError,
  MountDir,
  type MontySession,
  NameLookupSnapshot,
  type PrintCallback,
  type ResourceLimits,
  type Snapshot,
} from "@pydantic/monty/node";
import { SandboxUnavailableError, withSandboxSession } from "./pool.js";
import { type ToolRegistry, probeTypeCheckerGaps } from "./registry.js";
import {
  Truncator,
  truncateText,
  STDOUT_MAX_BYTES,
  STDOUT_MAX_LINES,
  STDOUT_HEAD_RATIO,
  STDOUT_RECOVERY,
  OUTPUT_MAX_BYTES,
  VALUE_HEAD_RATIO,
  VALUE_RECOVERY,
} from "./truncate.js";
import { HostToolError } from "./types.js";
import { SubmitSignal } from "./submit_signal.js";
import type {
  HostTool,
  RunResult,
  RunError,
  RunErrorKind,
  RunSuspended,
  ToolCallTrace,
  ApprovalRequest,
  ApprovalDecision,
  RunOptions,
  RunLimits,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MAX_STDOUT = STDOUT_MAX_BYTES;
const DEFAULT_MAX_OUTPUT = OUTPUT_MAX_BYTES;

/**
 * Raise `pythonType` inside the sandbox with `message`.
 *
 * The channel is the error's **`name`**, which is the whole reason this helper
 * exists rather than an object literal at each call site. 0.0.18 took a
 * `{ exception: { type, message } }` record; 0.0.21's `resumeError` reads
 * `err.name`, accepts it only if it is one of the 37 names in monty's
 * `PYTHON_EXC_NAMES`, and quietly substitutes `RuntimeError` otherwise — the
 * same fallback 0.0.18's native binding applied to an unknown type name, so no
 * call site changes meaning. Passing a plain object instead is not a type
 * error and not a runtime error: it surfaces in Python as
 * `RuntimeError: [object Object]` (measured).
 */
function pythonError(pythonType: string, message: string): Error {
  const err = new Error(message);
  err.name = pythonType;
  return err;
}

// ── Dispatch loop accumulators ───────────────────────────────────

/**
 * Mutable state carried across iterations of the dispatch loop.
 *
 * Owned by the entry point that builds it and mutated in place — by the loop,
 * and concurrently by the print callback and abort listener Monty invokes while
 * the loop awaits a resume. Nothing may hold a copy of any field (#27).
 *
 * `stdout` is a projection of the `Truncator`, not a field: the accumulator
 * keeps a bounded head and tail plus true counters, and renders the elided form
 * only when a result is built.
 */
class DispatchAccumulators {
  readonly calls: ToolCallTrace[];
  aborted = false;
  private readonly out: Truncator;

  constructor(maxStdout: number, prior?: RunSuspended) {
    this.out = new Truncator({
      maxBytes: maxStdout,
      headRatio: STDOUT_HEAD_RATIO,
      maxLines: STDOUT_MAX_LINES,
      recovery: STDOUT_RECOVERY,
      truncatedBefore: prior?.stdoutTruncated,
    });
    this.calls = prior ? [...prior.calls] : [];
    // Stdout carried across a suspend/resume boundary is re-accumulated from
    // its rendered form: `RunSuspended` transports the string, not the head,
    // tail and counters behind it. Cross-call stdout semantics are #61's.
    if (prior?.stdout) this.out.push(prior.stdout);
  }

  print(text: string): void {
    this.out.push(text);
  }

  get stdout(): string {
    return this.out.render();
  }

  get stdoutTruncated(): boolean {
    return this.out.truncated;
  }
}

/** Assemble a `RunError` around whatever the accumulators hold. */
function runError(kind: RunErrorKind, error: string, acc: DispatchAccumulators): RunError {
  return {
    status: "error",
    error,
    errorKind: kind,
    stdout: acc.stdout,
    stdoutTruncated: acc.stdoutTruncated,
    calls: acc.calls,
  };
}

/**
 * Classify an error thrown by *resuming Python* into a `RunError`.
 *
 * Every `resume()` in this file can raise `MontyRuntimeError`: the resumed code
 * may raise, and — once #32 lands default limits — may breach `maxDurationSecs`
 * or `maxMemory` on any instruction it executes after the resume. That is a run
 * outcome, not a host fault, so it becomes a `RunError`. Anything else is a bug
 * in this file and rethrows unchanged.
 *
 * It exists as a function so the guard is one shape at every call site. The
 * defect behind #36 was not a wrong classification — it was a `resume()` that
 * sat inside a `try` written for something else and so reached a handler with
 * no branch for this case at all.
 *
 * `MontyCrashedError` is new with the worker pool and is emphatically not a
 * host fault to rethrow. It is what a runaway now *becomes*: the host watchdog
 * kills the worker, the pool replaces it, and this run is over. On 0.0.18 the
 * same code froze the event loop until something SIGKILLed the whole process,
 * so there was no error to classify. It gets its own kind rather than folding
 * into `runtime` because the consequence differs — the session's Python state
 * is gone, not merely errored, and a caller that resumes or retries against it
 * is working with nothing.
 */
function classifyResumeError(err: unknown, acc: DispatchAccumulators): RunError {
  if (err instanceof MontyRuntimeError) return runError(runtimeKind(err), err.message, acc);
  if (err instanceof MontyCrashedError) return runError("crashed", crashMessage(err), acc);
  throw err;
}

/**
 * Which ceiling a `MontyRuntimeError` represents, if any.
 *
 * Read off `exception.typeName` rather than matched against the message, which
 * carries the measured figures (`time limit exceeded: 2.000000044s > 2s`) and
 * is upstream's to reword. The two names are the ones Monty raises for the two
 * limits we set — verified on 0.0.21, alongside `RecursionError`, which stays
 * `runtime`: it is the caller's own recursion, not a ceiling of ours.
 *
 * Every other name is genuinely the user's code failing, which is what
 * `runtime` means to a model reading the feedback.
 */
function runtimeKind(err: MontyRuntimeError): RunErrorKind {
  switch (err.exception.typeName) {
    case "TimeoutError":
      return "timeout";
    case "MemoryError":
      return "memory";
    default:
      return "runtime";
  }
}

/**
 * Classify an error thrown by *starting* Python — everything
 * `classifyResumeError` covers, plus the two that can only happen before the
 * first instruction runs.
 *
 * The syntax/typing split needs explaining. 0.0.18 parsed and type-checked in
 * two separate calls, so the two error classes arrived separately and this
 * code merely labelled them. 0.0.21 type-checks as part of the feed, and the
 * checker parses first: with `typeCheck: true`, `def (` raises
 * **`MontyTypingError`**, not `MontySyntaxError` — its diagnostics simply lead
 * with `error[invalid-syntax]` (measured). Reading the diagnostic code back
 * out is the only thing left that separates "this is not Python" from "this is
 * Python that does not type-check", and the distinction is worth keeping: it
 * is the difference between a model that mistyped and a model that
 * misunderstood. `MontySyntaxError` still arrives from the paths that do not
 * type-check, such as stub validation.
 *
 * The reported text is `display()`, not `message`. `MontyTypingError`'s
 * constructor keeps only the **first line** of the rendered diagnostics as its
 * message — so `message` drops every diagnostic after the first, and drops the
 * source echo that `typeCheckFormat: "full"` is selected for, which lives on
 * the lines below each one. 0.0.18 put the whole rendering in `message`, so
 * reading it here would have been a silent regression in what the model is
 * told: two unresolved names would report one, with no indication of the
 * other.
 */
function classifyStartError(err: unknown, acc: DispatchAccumulators): RunError {
  if (err instanceof MontySyntaxError) return runError("syntax", err.message, acc);
  if (err instanceof MontyTypingError) {
    const diagnostics = err.display();
    const kind = diagnostics.includes("error[invalid-syntax]") ? "syntax" : "typing";
    return runError(kind, diagnostics, acc);
  }
  return classifyResumeError(err, acc);
}

/**
 * What to tell the caller about a dead worker. `timedOut` is the one
 * distinction that changes what they should do: a watchdog kill means the code
 * ran too long, which is actionable, while a bare crash is not the caller's
 * doing.
 */
function crashMessage(err: MontyCrashedError): string {
  return err.timedOut
    ? `execution exceeded its time budget and the sandbox was terminated: ${err.message}`
    : `the sandbox worker died: ${err.message}`;
}

/**
 * The one print callback. Both entry points hand this to Monty — as
 * `startOpts.printCallback` and as `MontySnapshot.load()`'s — and it is the
 * only thing that writes stdout.
 */
function makePrintCallback(
  acc: DispatchAccumulators,
  runOpts: RunOptions | undefined,
): (stream: string, text: string) => void {
  return (_stream: string, text: string) => {
    // Unconditional, and before the accumulator: the human's live stream is not
    // the model's context window and must not share its budget. Gating this on
    // truncation silenced the terminal mid-run (M9).
    runOpts?.onPrint?.(text);
    acc.print(text);
  };
}

// ── Options ──────────────────────────────────────────────────────

/** Options for creating a sandbox runner. */
export interface SandboxOptions {
  /** Tool registry with host tools available to Python code. */
  registry: ToolRegistry;
}

// ── Memory guards ────────────────────────────────────────────────

/**
 * Refuse to start new sandbox work when memory is already gone.
 *
 * These are backstops against a runaway, not a fix for one. The leak that
 * motivated them — `probeTypeCheckerGaps()` re-running per call and leaking
 * ~41 MB each time — is fixed at source in #68, which took the full suite from
 * 9040 MB to 1615 MB. What remains is the general case: sandboxed code, or a
 * caller looping over it, can still exhaust a host, and the failure is silent
 * at every layer. A native allocation is invisible to V8, so no GC pressure
 * builds and no heap-limit abort fires; the process simply grows until the
 * kernel kills something.
 *
 * Two independent limits, because there are two independent ways to get there:
 *   - CEILING catches one process running away on its own. On by default.
 *   - FLOOR catches many well-behaved processes adding up — two suites in
 *     parallel, a second agent. No single process is at fault, so a per-process
 *     limit cannot see it. **Off by default**: whether the host as a whole is
 *     short of memory is not this library's business to police, and a shipped
 *     extension that refuses to run because the user has a browser open would
 *     be diagnosing the wrong thing. Repositories running heavy suites opt in.
 */
export class SandboxMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxMemoryError";
  }
}

/** Per-process RSS ceiling, MB. 0 disables. */
const DEFAULT_MEMORY_CEILING_MB = 5120;
/** Host available-memory floor, MB. 0 disables — see above for why that is the default. */
const DEFAULT_MEMORY_FLOOR_MB = 0;

/** Read at call time, not module load, so a caller can change it between runs. */
function envMb(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * This process's cgroup v2 memory ceiling and current usage, or null when
 * unlimited or unreadable.
 *
 * Necessary because `/proc/meminfo` is **not** namespaced: inside a scope
 * capped at 512 MB it still reports the host's figure (measured: 21.7 GB).
 * Without this, both guards are inert in exactly the environments where a
 * memory limit is real — containers, Kubernetes, CI, and the transient scopes
 * `scripts/contained.mjs` itself creates.
 */
function cgroupMemory(): { max: number; current: number } | null {
  try {
    const own = readFileSync("/proc/self/cgroup", "utf8").trim().split(":").pop();
    if (!own) return null;
    const base = `/sys/fs/cgroup${own}`;
    const raw = readFileSync(`${base}/memory.max`, "utf8").trim();
    if (raw === "max") return null;
    const max = Number(raw);
    const current = Number(readFileSync(`${base}/memory.current`, "utf8").trim());
    return Number.isFinite(max) && Number.isFinite(current) ? { max, current } : null;
  } catch {
    return null;
  }
}

/**
 * Available memory in bytes, or null where that cannot be known — the smaller
 * of what the host reports and what this process's cgroup still allows.
 *
 * `os.freemem()` is not a substitute for the host half: on Linux it reports
 * MemFree, which excludes reclaimable page cache and so reads as alarmingly low
 * on a healthy box. Only MemAvailable answers "could an allocation succeed".
 * Absent on macOS, where the check is skipped rather than guessed.
 */
function availableMemoryBytes(): number | null {
  let host: number | null = null;
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    host = match ? Number(match[1]) * 1024 : null;
  } catch {
    host = null;
  }
  const cg = cgroupMemory();
  const cgAvailable = cg ? Math.max(0, cg.max - cg.current) : null;
  if (host === null) return cgAvailable;
  if (cgAvailable === null) return host;
  return Math.min(host, cgAvailable);
}

/**
 * The effective RSS ceiling in MB. A cgroup cap below the configured ceiling
 * wins — otherwise a 5120 MB default is unreachable inside a 512 MB container
 * and the guard never fires where it is needed most. 90% leaves room to throw
 * rather than be OOM-killed mid-message.
 */
function effectiveCeilingMb(configuredMb: number): number {
  if (configuredMb === 0) return 0; // an explicit 0 disables, cgroup or not
  const cg = cgroupMemory();
  if (!cg) return configuredMb;
  return Math.min(configuredMb, Math.floor((cg.max * 0.9) / 1_048_576));
}

/**
 * The guards as they would apply right now, in MB. Exists so a test can assert
 * that the shipped defaults are actually live: every other test here sets the
 * environment explicitly, so shipping both defaults as 0 — the whole feature
 * off — passed all of them. `ceilingMb` of 0 means disabled.
 */
export function memoryGuardConfig(): { ceilingMb: number; floorMb: number } {
  return {
    ceilingMb: effectiveCeilingMb(envMb("REPL_MEMORY_CEILING_MB", DEFAULT_MEMORY_CEILING_MB)),
    floorMb: envMb("REPL_MEMORY_FLOOR_MB", DEFAULT_MEMORY_FLOOR_MB),
  };
}

/**
 * Throws rather than returning a `RunError`. That is deliberate but it is a
 * real cost: #36 established that escaping a function typed to return a
 * discriminated union strands callers who have no reason to be in a `try`. The
 * distinction is that a `RunError` describes the *user's code* failing, and
 * every caller renders it back to the model as feedback to retry against. This
 * is the *host* out of memory, where retrying is precisely wrong. Callers that
 * hold accumulated state catch it and return what they have — see
 * `RLMLoop.run`.
 */
function assertMemoryHeadroom(): void {
  const ceilingMb = effectiveCeilingMb(envMb("REPL_MEMORY_CEILING_MB", DEFAULT_MEMORY_CEILING_MB));
  if (ceilingMb > 0) {
    const rssMb = Math.round(process.memoryUsage.rss() / 1_048_576);
    if (rssMb >= ceilingMb) {
      throw new SandboxMemoryError(
        `sandbox refused: this process holds ${rssMb} MB, at or above the ${ceilingMb} MB ceiling. ` +
          "A process this large is about to be OOM-killed, which would take the whole session with " +
          "it. Restart the process, or raise REPL_MEMORY_CEILING_MB if you know what you are doing.",
      );
    }
  }

  const floorMb = envMb("REPL_MEMORY_FLOOR_MB", DEFAULT_MEMORY_FLOOR_MB);
  if (floorMb > 0) {
    const available = availableMemoryBytes();
    if (available !== null) {
      const availableMb = Math.round(available / 1_048_576);
      if (availableMb <= floorMb) {
        throw new SandboxMemoryError(
          `sandbox refused: only ${availableMb} MB available on this host, at or below the ` +
            `${floorMb} MB floor. Something is exhausting memory — often a second test suite or ` +
            "a Stryker run. Wait for it, or raise REPL_MEMORY_FLOOR_MB.",
        );
      }
    }
  }
}

// ── Private helpers ──────────────────────────────────────────────

/**
 * Build the type-check stub file: tool stubs + input and gap declarations.
 * Gaps are runtime names Monty's type checker rejects (e.g. `open`,
 * `PermissionError`) — we declare them as `name: Any = None`.
 *
 * The contents are what 0.0.18 prepended to the user's source as
 * `typeCheckPrefixCode`. They now travel as `typeCheckStubs`, which the
 * checker resolves out-of-band, so a diagnostic on line 3 of the user's
 * snippet reports line 3 (measured) instead of line 3 + the prefix's height.
 * That removes the type-check contribution to #77's shift; the ~90 lines the
 * RLM preamble adds are ours and remain.
 */
async function buildTypeCheckStubs(registry: ToolRegistry, inputNames: string[]): Promise<string> {
  const stubs = await registry.renderTypeStubs();
  const gaps = await probeTypeCheckerGaps();
  const parts: string[] = [];
  // "from typing import Any" must come first for gap/stub/input declarations
  const needsAny =
    gaps.length > 0 || inputNames.length > 0 || (stubs.length > 0 && stubs.includes("Any"));
  if (needsAny) {
    parts.push("from typing import Any");
  }
  if (stubs) parts.push(stubs);
  if (inputNames.length > 0) {
    parts.push(...inputNames.map((name) => `${name}: Any = None`));
  }
  if (gaps.length > 0) {
    parts.push(...gaps.map((name) => `${name}: Any = None`));
  }
  return parts.join("\n");
}

/** Format a Monty value for output. Python `None` → `"None"`. */
function formatOutput(value: unknown): string {
  if (value === null || value === undefined) return "None";
  return String(value);
}

/**
 * Cap `output` at its byte budget.
 *
 * Applied wherever a `RunOk` is built, not at the point the tool result is
 * rendered, so that every consumer is covered by one cap: the `repl` tool
 * result, and the RLM loop, whose prompts otherwise grow by a full copy of any
 * snippet ending in a bare expression (A23).
 *
 * Uniform across the SUBMIT paths too. A field with two truncation policies
 * depending on which return site produced it is exactly the drift
 * docs/truncation-policy.md exists to prevent.
 */
function capOutput(
  text: string,
  runOpts: RunOptions | undefined,
): { output: string; outputTruncated: boolean } {
  const { text: output, truncated } = truncateText(text, {
    maxBytes: runOpts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
    headRatio: VALUE_HEAD_RATIO,
    recovery: VALUE_RECOVERY,
  });
  return { output, outputTruncated: truncated };
}

/**
 * Build an ApprovalRequest from a tool and the raw Monty args/kwargs.
 * Constructs a human-readable description from the tool's metadata.
 */
function buildApprovalRequest(
  tool: HostTool,
  args: unknown[],
  kwargs: Record<string, unknown>,
): ApprovalRequest {
  const paramParts = tool.params.map((p, i) => {
    const val = i < args.length ? args[i] : kwargs[p.name];
    return `${p.name}=${JSON.stringify(val)}`;
  });
  return {
    tool: tool.name,
    args,
    kwargs,
    description: `${tool.name}(${paramParts.join(", ")})`,
  };
}

/** Resolve tool args from Monty positional+keyword into a flat Record. */
export function resolveToolArgs(
  tool: HostTool,
  args: unknown[],
  kwargs: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (let i = 0; i < tool.params.length; i++) {
    const param = tool.params[i];
    // Python-style: positional takes priority, keyword duplicate is an error
    const hasPositional = i < args.length;
    const hasKeyword = param.name in kwargs;
    if (hasPositional && hasKeyword) {
      throw new HostToolError(
        "TypeError",
        `${tool.name}() got multiple values for argument '${param.name}'`,
      );
    }
    if (hasPositional) {
      resolved[param.name] = args[i];
    } else if (hasKeyword) {
      resolved[param.name] = kwargs[param.name];
    }
    // If neither, param is left undefined (caller handles optional/defaults)
  }
  return resolved;
}

// ── Resource limits ──────────────────────────────────────────────
//
// Every default here exists because its absence fails open, and fails open
// silently. Before #32, `toResourceLimits` returned `undefined` for a caller
// who passed nothing — and nothing in this repository passed anything — so the
// shipped configuration was no limits at all. On 0.0.21 that is not merely
// permissive: an unbounded `while True: pass` never returns and never releases
// its pooled worker, so `REPL_POOL_MAX_PROCESSES` runaways deny service to
// every later caller in the process (measured).
//
// Opting out is still possible, but only by saying `limits: "unbounded"`.

/** Interpreter compute seconds. Not wall clock — host-tool time is free. */
const DEFAULT_MAX_DURATION_SECS = 30;
/** Sandbox heap ceiling, MB. A bare session holds ~8.7 MB before user code. */
const DEFAULT_MAX_MEMORY_MB = 512;
/**
 * Host wall-clock seconds for a whole run, host-tool time included. Generous
 * on purpose: its job is to catch a tool that will never return, not to
 * second-guess a slow one. `bash("npm test")` is a legitimate five minutes.
 */
const DEFAULT_MAX_WALL_CLOCK_SECS = 300;

/**
 * The limits as they would apply right now. Exists for the same reason
 * `memoryGuardConfig()` and `poolConfig()` do: every test that cares sets its
 * own, so shipping defaults that never take effect would pass all of them.
 */
export function limitsConfig(): {
  maxDurationSecs: number;
  maxMemory: number;
  maxWallClockSecs: number;
} {
  return {
    maxDurationSecs: envInt("REPL_MAX_DURATION_SECS", DEFAULT_MAX_DURATION_SECS),
    maxMemory: envInt("REPL_MAX_MEMORY_MB", DEFAULT_MAX_MEMORY_MB) * 1_048_576,
    maxWallClockSecs: envInt("REPL_MAX_WALL_CLOCK_SECS", DEFAULT_MAX_WALL_CLOCK_SECS),
  };
}

/**
 * Positive-integer env reader. Zero and negatives fall back to the default: a
 * budget of 0 would fail closed to the point of running nothing, and it is the
 * shape a caller reaches for when they mean "off" — which is
 * `limits: "unbounded"`, not an environment variable.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Convert our `RunLimits` to Monty's `ResourceLimits`, filling every unset knob
 * from `limitsConfig()`.
 *
 * Returns `undefined` — genuinely no limits — only for the explicit
 * `"unbounded"`. That is the whole point: the one path to an uncontained run is
 * one a caller had to type.
 *
 * `maxWallClockSecs` is ours and is not passed on; Monty has no host-side
 * clock. `gcInterval` and `maxRecursionDepth` are passed through undefaulted,
 * so Monty's own defaults apply — they are tuning knobs, not containment, and
 * dropping a knob the caller set is the other half of the bug being fixed here.
 *
 * Exported for the test that asserts the mapping field by field. `gcInterval`
 * has no observable effect to assert behaviourally, so a silent drop of it —
 * the exact defect being fixed — is catchable only here.
 */
export function toResourceLimits(limits?: RunLimits | "unbounded"): ResourceLimits | undefined {
  if (limits === "unbounded") return undefined;
  const defaults = limitsConfig();
  return {
    maxDurationSecs: limits?.maxDurationSecs ?? defaults.maxDurationSecs,
    maxMemory: limits?.maxMemory ?? defaults.maxMemory,
    gcInterval: limits?.gcInterval,
    maxRecursionDepth: limits?.maxRecursionDepth,
  };
}

/**
 * When the host budget runs out, as an absolute timestamp — or null when the
 * caller opted out.
 *
 * Absolute rather than a duration because the clock starts at the top of the
 * call and the timer is armed later, once a worker is in hand: the budget is
 * the caller's whole wait, not just the part after the queue.
 */
function hostDeadlineAt(limits?: RunLimits | "unbounded"): number | null {
  if (limits === "unbounded") return null;
  return Date.now() + (limits?.maxWallClockSecs ?? limitsConfig().maxWallClockSecs) * 1000;
}

/**
 * How long an abort gives the run to end itself before the race ends it.
 *
 * Not zero, and that is the whole subtlety. The dispatch loop notices
 * `acc.aborted` at the top of its next iteration and returns an `aborted`
 * result with a complete trace — including the tool call that was in flight
 * when the abort arrived, which really did run and whose side effects really
 * did happen. Racing that loop instantly would drop it from the trace, telling
 * the caller nothing ran when a `bash` or a `write` already had (the reverse
 * of #28's mistake, and just as wrong). So the loop is given a moment to
 * finish saying so, and only a run that cannot — one parked in a tool that
 * will not return — is cut off without it.
 */
const ABORT_SETTLE_GRACE_MS = 250;

/**
 * Bound `fn` by the host wall clock and the abort signal.
 *
 * This is the fail-safe the in-sandbox limits cannot be. Monty's clock is
 * polled inside the worker and advances only while the interpreter executes,
 * so it cannot fire while the host is awaiting a tool: `bash("sleep 99999")`
 * would hang the `repl` tool forever with every `ResourceLimits` field armed.
 *
 * It also has a second job the issue did not have when filed, and that job
 * dictates where this sits. `withSandboxSession` returns the pooled worker in a
 * `finally` reached only once its body settles, so under a hung tool the worker
 * is held for as long as the hang lasts — and losing this race is what settles
 * that body. It therefore has to be *inside* the checkout, not wrapped around
 * it: raced from outside, the deadline returns to the caller on time and leaves
 * the worker held forever, which is the leak restated rather than fixed
 * (measured, on the first draft of this change).
 *
 * What this does *not* do is stop the losing work. A host tool's promise runs
 * to completion in the background; a runaway inside the sandbox is stopped by
 * `maxDurationSecs`, not by this. It bounds the caller and frees the worker.
 */
async function withHostDeadline(
  deadlineAt: number | null,
  runOpts: RunOptions | undefined,
  acc: DispatchAccumulators,
  fn: () => Promise<RunResult>,
): Promise<RunResult> {
  const signal = runOpts?.signal;
  if (deadlineAt === null && !signal) return await fn();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // `Promise.race` subscribes to every entry, so a body that loses and rejects
  // later is already observed and cannot surface as an unhandled rejection.
  const racers: Promise<RunResult>[] = [fn()];

  if (deadlineAt !== null) {
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    racers.push(
      new Promise<RunResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              runError(
                "timeout",
                "run exceeded its host wall-clock budget — a host tool did not return in time, " +
                  "or the run as a whole took too long. This budget covers host-tool time, " +
                  "which the sandbox's own duration limit does not.",
                acc,
              ),
            ),
          remainingMs,
        );
      }),
    );
  }

  if (signal) {
    racers.push(
      new Promise<RunResult>((resolve) => {
        const cutOff = () => {
          abortTimer = setTimeout(
            () => resolve(runError("aborted", "execution aborted", acc)),
            ABORT_SETTLE_GRACE_MS,
          );
        };
        onAbort = cutOff;
        if (signal.aborted) cutOff();
        else signal.addEventListener("abort", cutOff, { once: true });
      }),
    );
  }

  try {
    return await Promise.race(racers);
  } finally {
    // All three are mandatory, not tidiness: a live timer keeps the event loop
    // alive past the run that armed it, and a listener left on a caller-owned
    // signal outlives every run that shares it.
    if (timer !== undefined) clearTimeout(timer);
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run `fn` with the mounts from `RunOptions` open, and close them afterwards
 * whatever happens.
 *
 * The close is not housekeeping. A `MountDir` now holds an open handle to the
 * host directory for its lifetime, and on Windows an open handle blocks the
 * host from renaming or deleting that directory — so a mount left open by a
 * run that threw would keep a user's own folder hostage until the process
 * exits. JS has no deterministic drop, so the `finally` is the whole mechanism.
 *
 * The constructor also changed shape: 0.0.18 took `(virtualPath, hostPath)`
 * positionally, 0.0.21 takes a named record, having concluded that mount tools
 * disagree about which path comes first often enough to make positional
 * arguments a hazard.
 */
async function withMounts<T>(
  mount: Record<string, string> | undefined,
  fn: (mounts: MountDir[] | undefined) => Promise<T>,
): Promise<T> {
  const entries = Object.entries(mount ?? {});
  if (entries.length === 0) return await fn(undefined);
  const dirs = entries.map(
    ([virtualPath, hostPath]) => new MountDir({ virtualPath, hostPath, mode: "overlay" }),
  );
  try {
    return await fn(dirs);
  } finally {
    for (const dir of dirs) dir.close();
  }
}

// ── Shared dispatch loop ─────────────────────────────────────────

/**
 * Core start/resume loop shared by `runInSandbox()` and
 * `resumeSuspended()`.
 *
 * Dispatches Monty pauses (Complete → NameLookup → Snapshot)
 * in a `while(true)` loop until execution completes, errors,
 * or suspends awaiting tool approval.
 *
 * `acc` is owned by the caller and mutated in place — by this loop, and
 * concurrently by the caller's `printCallback` and abort listener, which
 * Monty invokes while the loop is awaiting a resume.
 */
async function runDispatchLoop(
  current: Snapshot,
  registry: ToolRegistry,
  runOpts: RunOptions | undefined,
  acc: DispatchAccumulators,
): Promise<RunResult> {
  while (true) {
    // Abort check between iterations
    if (acc.aborted) {
      return runError("aborted", "execution aborted", acc);
    }

    if (current instanceof MontyComplete) {
      return {
        status: "ok",
        ...capOutput(formatOutput(current.output), runOpts),
        stdout: acc.stdout,
        stdoutTruncated: acc.stdoutTruncated,
        calls: acc.calls,
      };
    }

    if (current instanceof NameLookupSnapshot) {
      const name = current.variableName;
      const tool = registry.get(name);
      try {
        // Resolving the name to itself is what makes a tool a first-class
        // value: the sandbox binds a proxy, so `f = echo; f("x")` and
        // `[echo][0]("x")` both come back as calls to `echo`. 0.0.18 had to
        // hand over a `SENTINEL` function here and recover the real name at
        // call time, which worked only for a direct call — aliasing raised
        // `NameError: SENTINEL` (#66). There is no sentinel to leak now.
        current = tool ? await current.resume(name) : await current.resume();
      } catch (err) {
        return classifyResumeError(err, acc);
      }
      continue;
    }

    if (current instanceof FutureSnapshot) {
      // Unreachable by construction: a future is only registered when a call
      // is answered with `resumeFuture()` or by `resumeAuto()` against an
      // async external, and this loop does neither — every host tool is
      // awaited here and resumed with its settled value. If one ever arrives,
      // the sandbox is blocked on a promise nothing in this process is
      // holding, so there is no honest value to resume it with. Thrown rather
      // than returned as a `RunError`: this is a defect in this file, not the
      // user's code failing, and #36's lesson was about the reverse mistake.
      throw new Error(
        `sandbox received a FutureSnapshot for call ids [${current.pendingCallIds.join(", ")}], ` +
          "which this dispatch loop never registers",
      );
    }

    // FunctionSnapshot — an external call.
    const snapshot: FunctionSnapshot = current;

    if (snapshot.isOsFunction) {
      // An OS call: `open()`, `Path.read_text()`, and friends. `feedStart`
      // surfaces these as snapshots too — unlike 0.0.18, where mounts were
      // serviced inside the interpreter and never reached the host — and
      // `resumeAuto()` is what offers them to the feed's mounts. Getting this
      // branch wrong does not fail loudly: `resumeNotHandled()` also returns a
      // snapshot and the run completes, having turned every read of a mounted
      // file into `PermissionError` (measured).
      try {
        current = await snapshot.resumeAuto();
      } catch (err) {
        return classifyResumeError(err, acc);
      }
      continue;
    }

    const funcName = snapshot.functionName;
    const tool = registry.get(funcName);

    if (!tool) {
      try {
        current = await snapshot.resumeNotFound();
      } catch (err) {
        return classifyResumeError(err, acc);
      }
      continue;
    }

    // Resolve args from positional+keyword to flat Record
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveToolArgs(
        tool,
        snapshot.args as unknown[],
        snapshot.kwargs as Record<string, unknown>,
      );
    } catch (err) {
      acc.calls.push({
        tool: tool.name,
        args: snapshot.args as unknown[],
        kwargs: snapshot.kwargs as Record<string, unknown>,
        durationMs: 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        current = await snapshot.resumeError(
          pythonError(
            err instanceof HostToolError ? err.pythonType : "TypeError",
            err instanceof Error ? err.message : String(err),
          ),
        );
      } catch (resumeErr) {
        return classifyResumeError(resumeErr, acc);
      }
      continue;
    }

    // Approval gate
    let approved: boolean | undefined;
    if (tool.requiresApproval) {
      const req = buildApprovalRequest(
        tool,
        snapshot.args as unknown[],
        snapshot.kwargs as Record<string, unknown>,
      );
      const decision = runOpts?.onApproval ? await runOpts.onApproval(req) : false;

      if (decision === "suspend") {
        return {
          status: "suspended",
          suspendedCall: req,
          snapshot: await snapshot.dump(),
          stdout: acc.stdout,
          stdoutTruncated: acc.stdoutTruncated,
          calls: acc.calls,
        };
      }

      if (!decision) {
        // Denied (or no callback) → PermissionError in Python
        acc.calls.push({
          tool: tool.name,
          args: snapshot.args as unknown[],
          kwargs: snapshot.kwargs as Record<string, unknown>,
          durationMs: 0,
          ok: false,
          approved: false,
          error: `tool '${tool.name}' requires approval`,
        });
        try {
          current = await snapshot.resumeError(
            pythonError("PermissionError", `tool '${tool.name}' requires approval`),
          );
        } catch (err) {
          return classifyResumeError(err, acc);
        }
        continue;
      }

      approved = true;
    }

    // Execute the tool.
    //
    // This `try` covers `tool.execute` and nothing else. `snapshot.resume` used
    // to sit inside it, which made a `MontyRuntimeError` from *Python resuming*
    // — a duration, memory or recursion breach — arrive at a handler written
    // for tool faults: it pushed a second trace entry for a call already
    // recorded `ok: true`, then resumed the same snapshot a second time, and
    // the resulting `GenericFailure` escaped `runInSandbox` uncaught (#36).
    const t0 = performance.now();
    let returnValue: unknown;
    try {
      returnValue = await tool.execute(resolvedArgs);
    } catch (err) {
      const durationMs = performance.now() - t0;
      // SubmitSignal — clean termination
      if (err instanceof SubmitSignal) {
        acc.calls.push({
          tool: tool.name,
          args: snapshot.args as unknown[],
          kwargs: snapshot.kwargs as Record<string, unknown>,
          durationMs,
          ok: true,
          approved,
        });
        return {
          status: "ok",
          ...capOutput(err.answer, runOpts),
          stdout: acc.stdout,
          stdoutTruncated: acc.stdoutTruncated,
          calls: acc.calls,
        };
      }
      // A `HostToolError` carries the Python type to re-raise; anything else
      // reaches Python as a RuntimeError.
      const message = err instanceof Error ? err.message : String(err);
      const pythonType = err instanceof HostToolError ? err.pythonType : "RuntimeError";
      acc.calls.push({
        tool: tool.name,
        args: snapshot.args as unknown[],
        kwargs: snapshot.kwargs as Record<string, unknown>,
        durationMs,
        ok: false,
        error: message,
        approved,
      });
      try {
        current = await snapshot.resumeError(pythonError(pythonType, message));
      } catch (resumeErr) {
        return classifyResumeError(resumeErr, acc);
      }
      continue;
    }

    // The tool returned. Trace it once, here — the resume below is outside the
    // `try` above precisely so it cannot reach a handler that would record this
    // same call a second time.
    acc.calls.push({
      tool: tool.name,
      args: snapshot.args as unknown[],
      kwargs: snapshot.kwargs as Record<string, unknown>,
      durationMs: performance.now() - t0,
      ok: true,
      approved,
    });
    try {
      current = await snapshot.resume(returnValue);
    } catch (err) {
      return classifyResumeError(err, acc);
    }
    // Loop back for next pause point
  }
}

// ── Main API ─────────────────────────────────────────────────────

/**
 * Execute Python code in a sandboxed Monty interpreter.
 *
 * Returns a discriminated `RunResult`:
 * - `{ status: "ok" }` — code ran to completion
 * - `{ status: "error" }` — syntax/typing/runtime/aborted error
 * - `{ status: "suspended" }` — awaiting approval on a gated tool call
 */
export async function runInSandbox(
  code: string,
  options: SandboxOptions,
  runOpts?: RunOptions,
): Promise<RunResult> {
  assertMemoryHeadroom();
  const registry = options.registry;
  const maxStdout = runOpts?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const scriptName = runOpts?.scriptName ?? "<repl>";

  // Accumulators. Built here, before `printCallback` and `onAbort`, because
  // both mutate `acc` and both are handed to Monty before the dispatch loop
  // is entered. Nothing below may read a local copy of this state.
  const acc = new DispatchAccumulators(maxStdout);

  const onAbort = () => {
    acc.aborted = true;
  };
  if (runOpts?.signal) {
    runOpts.signal.addEventListener("abort", onAbort, { once: true });
    if (runOpts.signal.aborted) acc.aborted = true;
  }

  const printCallback = makePrintCallback(acc, runOpts);

  // Started here, not at the checkout: the budget is the caller's whole wait,
  // and the stub build below can queue for a worker of its own.
  const deadlineAt = hostDeadlineAt(runOpts?.limits);

  try {
    // ── 1. Build the type-check stub file ───────────────────────
    const inputNames = Object.keys(runOpts?.inputs ?? {});
    const typeCheckStubs = await buildTypeCheckStubs(registry, inputNames);

    // ── 2. Check out a worker and feed the code ─────────────────
    //
    // Type checking is now part of the feed rather than a separate call, so
    // there is one `try` here where 0.0.18 needed three: a syntax error, a type
    // error and a runtime error all arrive from `feedStart`.
    return await withMounts(runOpts?.mount, async (mount) =>
      withSandboxSession(
        {
          scriptName,
          typeCheck: true,
          typeCheckStubs: typeCheckStubs || undefined,
          // Explicit, though it is also the default: `full` echoes the offending
          // source lines under the diagnostic, which is the shape 0.0.18
          // produced and the more useful one for a model rewriting its own code.
          // `concise` collapses each diagnostic to a single line and drops the
          // echo.
          typeCheckFormat: "full",
          limits: toResourceLimits(runOpts?.limits),
        },
        // Inside the checkout, so that losing the race settles this body and
        // runs the `finally` that returns the worker.
        async (session) =>
          await withHostDeadline(deadlineAt, runOpts, acc, async () => {
            let current: Snapshot;
            try {
              current = await session.feedStart(code, {
                inputs: runOpts?.inputs,
                printCallback,
                mount,
              });
            } catch (err) {
              return classifyStartError(err, acc);
            }
            return await runDispatchLoop(current, registry, runOpts, acc);
          }),
      ),
    );
  } catch (err) {
    // The checkout that never succeeded. It escapes from outside every
    // `classify*` guard — `buildTypeCheckStubs` reaches the pool before any
    // user code exists to blame — and this function is contracted to return a
    // `RunResult`, so it is turned into one here rather than thrown at a caller
    // with no reason to be in a `try` (#36).
    if (err instanceof SandboxUnavailableError) return runError("unavailable", err.message, acc);
    throw err;
  }
}

// ── Resume suspended execution ──────────────────────────────────

/**
 * Resume a sandbox execution that was suspended for tool approval.
 *
 * Restores the serialized snapshot from `suspended.snapshot` into a fresh
 * worker, applies the approval `decision`, and continues the dispatch loop.
 *
 * Returns the same discriminated `RunResult` as `runInSandbox()`.
 */
export async function resumeSuspended(
  suspended: RunSuspended,
  decision: ApprovalDecision,
  options: SandboxOptions,
  runOpts?: RunOptions,
): Promise<RunResult> {
  assertMemoryHeadroom();
  const maxStdout = runOpts?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;

  // Accumulators — carry over from suspended state. Built here, before
  // `printCallback` and `onAbort`, because both mutate `acc` and both are
  // handed to Monty before the dispatch loop is entered. The prologue below
  // pushes through `acc.calls` for the same reason.
  const acc = new DispatchAccumulators(maxStdout, suspended);

  const onAbort = () => {
    acc.aborted = true;
  };
  if (runOpts?.signal) {
    runOpts.signal.addEventListener("abort", onAbort, { once: true });
    if (runOpts.signal.aborted) acc.aborted = true;
  }

  // Abort before the prologue, not after it. `runDispatchLoop` checks
  // `acc.aborted` at the top of every iteration, but the approval replay below
  // runs *before* that loop is entered, so its check reports an abort the side
  // effect has already outrun. The calls that reach this path are by definition
  // the gated ones — `bash`, `write`, `edit` — so "too late" means the shell
  // command ran or the file was written (#28). Returning here also spares the
  // deny branch a pointless Python resume. Nothing has been traced yet, and
  // nothing should be: the trace must not claim a call that never ran.
  if (acc.aborted) {
    return runError("aborted", "execution aborted", acc);
  }

  const printCallback = makePrintCallback(acc, runOpts);

  // The suspended run's worker was released when it suspended — the dump is
  // the whole of its state — so resuming takes a fresh one. The mounts have to
  // be handed back: host paths are not in the dump, and a snapshot restored
  // without them keeps running, having silently turned every read of a mounted
  // file into `PermissionError` (measured). 0.0.18's `MontySnapshot.load()`
  // could not re-establish them at all, which is #38; the half of that issue
  // living in `session.ts`, where the run options are saved and never read
  // back, is #84 and is untouched here.
  const deadlineAt = hostDeadlineAt(runOpts?.limits);

  try {
    return await withMounts(runOpts?.mount, async (mount) =>
      withSandboxSession(
        { limits: toResourceLimits(runOpts?.limits) },
        async (session) =>
          await withHostDeadline(
            deadlineAt,
            runOpts,
            acc,
            async () =>
              await resumeInSession(session, suspended, decision, options, runOpts, acc, {
                printCallback,
                mount,
              }),
          ),
      ),
    );
  } catch (err) {
    if (err instanceof SandboxUnavailableError) return runError("unavailable", err.message, acc);
    throw err;
  }
}

/** The approval replay and dispatch, against a session holding the restored snapshot. */
async function resumeInSession(
  session: MontySession,
  suspended: RunSuspended,
  decision: ApprovalDecision,
  options: SandboxOptions,
  runOpts: RunOptions | undefined,
  acc: DispatchAccumulators,
  loadOpts: { printCallback: PrintCallback; mount: MountDir[] | undefined },
): Promise<RunResult> {
  const registry = options.registry;

  let snapshot: Snapshot;
  try {
    snapshot = await session.loadSnapshot(suspended.snapshot, loadOpts);
  } catch (err) {
    return classifyStartError(err, acc);
  }
  if (!(snapshot instanceof FunctionSnapshot)) {
    // A dump taken anywhere but at a gated call. `resumeSuspended` is only
    // reachable from a `RunSuspended`, which only the approval gate produces.
    throw new Error(`restored snapshot is a ${snapshot.constructor.name}, not a paused call`);
  }

  const tool = registry.get(suspended.suspendedCall.tool);

  // Replay the approval decision.
  //
  // Each branch decides *what* to resume Python with and traces the call; the
  // single guarded resume below then performs it. Keeping the resume out of the
  // branches is the point: this prologue carried the same defect as the
  // dispatch loop — the resume sat inside the `try` guarding `tool.execute`,
  // so a resource-limit breach on resume was handled as a tool fault and its
  // `GenericFailure` escaped `resumeSuspended` uncaught (#36).
  let resumeWith: { returnValue: unknown } | { raise: Error };

  if (decision === true && tool) {
    const t0 = performance.now();
    try {
      const resolvedArgs = resolveToolArgs(
        tool,
        suspended.suspendedCall.args,
        suspended.suspendedCall.kwargs,
      );
      const returnValue = await tool.execute(resolvedArgs);
      acc.calls.push({
        tool: tool.name,
        args: suspended.suspendedCall.args,
        kwargs: suspended.suspendedCall.kwargs,
        durationMs: performance.now() - t0,
        ok: true,
        approved: true,
      });
      resumeWith = { returnValue };
    } catch (err) {
      const durationMs = performance.now() - t0;
      if (err instanceof SubmitSignal) {
        acc.calls.push({
          tool: tool.name,
          args: suspended.suspendedCall.args,
          kwargs: suspended.suspendedCall.kwargs,
          durationMs,
          ok: true,
          approved: true,
        });
        return {
          status: "ok",
          ...capOutput(err.answer, runOpts),
          stdout: acc.stdout,
          stdoutTruncated: acc.stdoutTruncated,
          calls: acc.calls,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      const pythonType = err instanceof HostToolError ? err.pythonType : "RuntimeError";
      acc.calls.push({
        tool: tool.name,
        args: suspended.suspendedCall.args,
        kwargs: suspended.suspendedCall.kwargs,
        durationMs,
        ok: false,
        error: message,
        approved: true,
      });
      resumeWith = { raise: pythonError(pythonType, message) };
    }
  } else if (decision === false || !tool) {
    const excType = !tool ? "NameError" : "PermissionError";
    const excMsg = !tool
      ? `name '${suspended.suspendedCall.tool}' is not defined`
      : `tool '${tool.name}' requires approval`;
    acc.calls.push({
      tool: suspended.suspendedCall.tool,
      args: suspended.suspendedCall.args,
      kwargs: suspended.suspendedCall.kwargs,
      durationMs: 0,
      ok: false,
      approved: false,
      error: excMsg,
    });
    resumeWith = { raise: pythonError(excType, excMsg) };
  } else {
    return {
      status: "suspended",
      suspendedCall: suspended.suspendedCall,
      snapshot: suspended.snapshot,
      stdout: acc.stdout,
      stdoutTruncated: acc.stdoutTruncated,
      calls: acc.calls,
    };
  }

  let current: Snapshot;
  try {
    current =
      "raise" in resumeWith
        ? await snapshot.resumeError(resumeWith.raise)
        : await snapshot.resume(resumeWith.returnValue);
  } catch (err) {
    return classifyResumeError(err, acc);
  }

  // Continue via shared dispatch loop
  return await runDispatchLoop(current, registry, runOpts, acc);
}
