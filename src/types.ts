// Shared types for repl-simple Pi extension

/** Parameter definition for a HostTool */
export interface HostToolParam {
  name: string;
  type: "str" | "bool" | "int" | "float";
  description: string;
  optional?: boolean;
}

/** A host-side tool available to sandboxed Python code */
export interface HostTool {
  name: string;
  description: string;
  params: HostToolParam[];
  returns: "str" | "void";
  execute(args: Record<string, unknown>): string | Promise<string>;
  requiresApproval?: boolean;
  /**
   * Consequence text appended to the approval dialog description.
   *
   * Present for gated tools whose effect outlives the call — `save_tool` is
   * the canonical case: approving it runs code at the start of every future
   * session, which "save a tool" understates. Omitted for the ordinary case.
   */
  approvalNote?: string;
}

/** Approval request from a gated tool call */
export interface ApprovalRequest {
  tool: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  description: string;
}

/** Approval decision: true = approved, false = denied, 'suspend' = pause for later resume */
export type ApprovalDecision = boolean | "suspend";

/**
 * Resource limits for a sandbox run. Every field is optional; an omitted one
 * takes the default from `limitsConfig()` rather than meaning "unlimited" —
 * see `RunOptions.limits` for the escape hatch.
 *
 * **Two clocks, and they measure different things.**
 *
 * `maxDurationSecs` is enforced *inside* the worker and advances only while
 * the interpreter executes. It stops while the sandbox is suspended on a host
 * call, so `bash("npm test")` costs it nothing (measured). It is a compute
 * budget, and that is all it is. Note this inverted with 0.0.21: on 0.0.18 the
 * same knob was wall clock and charged host-tool time against the run, which
 * is why anything written before that migration reads the opposite way.
 *
 * `maxWallClockSecs` is enforced on the *host* and covers the whole run, tool
 * time included. It is the only thing that bounds a host tool that never
 * returns — Monty's clock cannot fire while the worker is idle awaiting our
 * answer — and the only thing that returns that run's pooled worker.
 *
 * **Suspension resets the sandbox clock.** A run that suspends for approval is
 * resumed against a fresh checkout, so `maxDurationSecs` starts over and a
 * script that trips a gated tool in a loop has no total ceiling from it.
 * `maxWallClockSecs` is per-call and does not span the suspension either. Neither
 * is a budget across a suspend/resume chain; a caller that needs one must keep
 * it (#38, #84).
 *
 * **`maxAllocations` is deliberately absent.** Monty 0.0.18 accepted it and did
 * not enforce it — `{maxAllocations: 1000}` let a 500,000-iteration append loop
 * finish normally (measured) — and 0.0.21 removed it upstream. Exposing it would
 * advertise containment that does not exist.
 */
export interface RunLimits {
  /** Interpreter compute seconds. Excludes host-tool time. Breach → `TimeoutError`. */
  maxDurationSecs?: number;
  /** Sandbox heap ceiling in bytes. Breach → `MemoryError`. */
  maxMemory?: number;
  /** Host wall-clock seconds for the whole run, host-tool time included. */
  maxWallClockSecs?: number;
  /** Instructions between sandbox GC cycles. Monty's default when omitted. */
  gcInterval?: number;
  /** Python recursion ceiling. Monty defaults to 1000; breach → `RecursionError`. */
  maxRecursionDepth?: number;
}

/** Runtime options for a sandbox execution */
export interface RunOptions {
  inputs?: Record<string, string>;
  mount?: Record<string, string>;
  signal?: AbortSignal;
  onPrint?: (text: string) => void;
  onApproval?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
  /** Byte ceiling on `stdout`. Default 32 KiB. */
  maxStdoutBytes?: number;
  /** Byte ceiling on `output`. Default 16 KiB. */
  maxOutputBytes?: number;
  scriptName?: string;
  /**
   * Resource limits, or `"unbounded"` to run with none at all.
   *
   * Omitting this does **not** mean unlimited: every unset knob falls back to
   * `limitsConfig()`. Opting out has to be spelled, so that it is a decision
   * someone made and a string anyone can grep for, never the consequence of a
   * caller that said nothing.
   *
   * `"unbounded"` disables the host wall clock too, which is what returns the
   * pooled worker. An unbounded runaway therefore holds its worker for as long
   * as it runs, and nothing short of `closeSandboxPool()` reclaims it.
   */
  limits?: RunLimits | "unbounded";
}

/** Trace of a single host-tool call during execution */
export interface ToolCallTrace {
  tool: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: string;
  approved?: boolean;
}

/**
 * Kinds of run errors.
 *
 * `crashed` is what a runaway became when the sandbox moved into a worker
 * process: the host watchdog killed the worker and the pool replaced it. It is
 * separate from `runtime` because the session's Python state is gone rather
 * than merely errored — there is nothing left to resume against.
 *
 * `timeout` and `memory` were both flattened into `runtime` until #32. They are
 * separate because they are the two failures a model can actually act on:
 * "you ran too long" and "you allocated too much" call for different rewrites,
 * and neither is served by being told to check its logic. Both are ceilings
 * this library imposes, so it owes the caller the name of the one it hit.
 *
 * `unavailable` is the sandbox refusing to start: no worker could be checked
 * out of the pool before the checkout timeout. Nothing ran, so unlike every
 * other kind it says nothing about the caller's code.
 */
export type RunErrorKind =
  | "syntax"
  | "typing"
  | "runtime"
  | "timeout"
  | "memory"
  | "aborted"
  | "crashed"
  | "unavailable";

/** Successful run result */
export interface RunOk {
  status: "ok";
  output: string;
  /** True when `output` was elided to fit `maxOutputBytes`. */
  outputTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  calls: ToolCallTrace[];
}

/** Errored run result */
export interface RunError {
  status: "error";
  error: string;
  errorKind: RunErrorKind;
  stdout: string;
  stdoutTruncated: boolean;
  calls: ToolCallTrace[];
}

/** Suspended run result (waiting for approval) */
export interface RunSuspended {
  status: "suspended";
  suspendedCall: ApprovalRequest;
  /** Serialized suspended snapshot — pass to resumeSuspended() to continue. */
  snapshot: Buffer;
  stdout: string;
  stdoutTruncated: boolean;
  calls: ToolCallTrace[];
}

/**
 * A suspension that a later `run()` threw away, reported on that run's result.
 *
 * A suspension belongs to the call that created it. When the caller runs new
 * code instead of resuming, `Session.run` drops the pending decision — and has
 * to say so, because the alternative is a side effect the caller stopped
 * expecting firing later, against variables the newer code has moved past
 * (#129). The description is the same string the approval dialog showed, so
 * the notice names the call the user was actually looking at.
 */
export interface DiscardedSuspension {
  /** The tool whose approval was pending. */
  tool: string;
  /** The dialog description of the call that will now never run. */
  description: string;
}

/**
 * Discriminated union of run outcomes.
 *
 * `discardedSuspension` sits on the union rather than inside the three
 * variants because it is not something the sandbox can produce: `runInSandbox`
 * knows about one execution, and only `Session` knows a previous one was left
 * pending. It rides along on whatever this run turned out to be — ok, error,
 * or a fresh suspension — because the discard happened either way.
 */
export type RunResult = (RunOk | RunError | RunSuspended) & {
  discardedSuspension?: DiscardedSuspension;
};

// ── RLM types ────────────────────────────────────────────────────

import type { ToolRegistry } from "./registry.js";

/**
 * LLM client for generating Python code in RLM loops.
 *
 * Injected by the caller — repl-simple has no LLM dependency of its own.
 * Tests use a mock that returns canned responses from an array.
 */
export interface LlmClient {
  query(
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string>;
}

/** A single iteration of the RLM loop. */
export interface RlmIteration {
  /** Index (0-based). */
  index: number;
  /** Python code generated by the LLM for this iteration. */
  code: string;
  /** Result of sandbox execution. */
  result: RunResult;
  /** Raw LLM response (before code extraction). */
  llmResponse: string;
}

/** RLM loop options. */
export interface RlmOptions {
  /** LLM client for code generation. REQUIRED. */
  llmClient: LlmClient;
  /** Tool registry for the sandbox (must include RLM tools: llm_query, rlm_query, SUBMIT). */
  registry: ToolRegistry;
  /** Python preamble injected before user code (e.g. repl_server.py). */
  preamble?: string;
  /**
   * System prompt for the LLM. Defaults to `DEFAULT_RLM_SYSTEM_PROMPT`.
   * Note: a caller-supplied prompt replaces the default wholesale — the
   * sentinel-authentication rule (D17) lives only in the default, so a
   * custom prompt drops that rule while `truncateWithSentinels` wrapping
   * still happens. Callers who override it should restate the rule.
   */
  systemPrompt?: string;
  /** Max RLM iterations before giving up. Default: 10. */
  maxIterations?: number;
  /** Abort signal — checked between iterations. */
  signal?: AbortSignal;
  /** Callback invoked after each iteration completes. */
  onIteration?: (iteration: RlmIteration) => void;
  /**
   * Inputs declared in the sandbox and **announced to the LLM**: every key
   * and value is rendered into the initial prompt (5 KiB head/tail preview
   * per value with an elision marker beyond that). Never pass secrets or
   * data the model must not see — the model reads these values from the
   * prompt and from sandbox code.
   * `context` is always declared and defaults to `""` when absent.
   */
  inputs?: Record<string, string>;
  /** Sandbox RunOptions propagated to each sandbox run. */
  runOptions?: RunOptions;
}

/** RLM loop result. */
export interface RlmResult {
  /** "ok" when SUBMIT was called, "max_iterations" when loop exhausted. */
  status: "ok" | "max_iterations";
  /** The answer string (from SUBMIT, or best-effort extraction). */
  answer: string;
  /** All iterations executed. */
  iterations: RlmIteration[];
}

/**
 * Error thrown by a host tool that should surface as a Python exception
 * in the sandbox.
 *
 * The `pythonType` property maps to the Python exception class name
 * (e.g. "TypeError", "PermissionError", "RuntimeError", "_SubmitSignal").
 */
export class HostToolError extends Error {
  pythonType: string;

  constructor(pythonType: string, message: string) {
    super(message);
    this.name = "HostToolError";
    this.pythonType = pythonType;
  }
}
