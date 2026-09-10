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
 * **Across a suspension the two clocks behave differently.** `maxDurationSecs`
 * is a budget over the whole run: the snapshot a suspended run leaves behind
 * carries the limit *and* the compute already spent, so the continuation
 * resumes with what is left (measured: a 493 ms burn under a 0.5 s budget
 * breached 16 ms into the resume) and a script that trips a gated tool in a
 * loop cannot buy itself a fresh budget. Nor can whoever resumes it: the
 * `limits` passed to a resume neither lift nor lower the snapshot's
 * `maxDurationSecs` (measured: a 0.2 s snapshot resumed under 60 s died at
 * 200 ms; a 60 s snapshot resumed under 0.1 s kept its 60 s). The memory
 * ceiling travels the same way (#177). `maxWallClockSecs` is per-segment: it
 * restarts on every resume, so each approved continuation gets a fresh window
 * for its host-tool time (decision 1, 2026-09-08). This doc used to say the
 * opposite — that suspension resets the sandbox clock — which was 0.0.18's
 * behaviour and was measured false on 0.0.21 (#38, #84).
 *
 * **`maxSuspensions` counts crossings, not time** (Monty 0.0.23). Every
 * host-tool call — a call a `Session` serves from its replay cache included —
 * name lookup and OS call is one; past the budget the feed is aborted with a
 * `RuntimeError` Python cannot catch. Across a suspension it is a ceiling that
 * only tightens: the restored run is held to the lower of its own value and
 * the resume's, and the count starts again at the restore (measured). The
 * `repl` tool does not let the model set it, so a model-driven run gets the
 * operator's `REPL_MAX_SUSPENSIONS` (see `limitsConfig()`).
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
  /**
   * Host crossings per run segment. Breach → uncatchable `RuntimeError`,
   * `errorKind: "runtime"`. Defaults from `limitsConfig()`, not Monty's 1000.
   */
  maxSuspensions?: number;
}

/**
 * Runtime options for a sandbox execution.
 *
 * Some describe the run and some describe the invocation, and the difference
 * shows at a suspension: `Session.resume` carries `limits`, `mount`,
 * `maxStdoutBytes` and `maxOutputBytes` from the suspended run (the resume
 * call's own value wins where it gives one) and takes `onApproval`, `signal`
 * and `onPrint` from the resume call alone. The rule and its reasons are at
 * `Session.resume`.
 */
export interface RunOptions {
  /**
   * Bound as globals before the code runs. Part of the snapshot from then on,
   * so a resume needs nothing re-supplied.
   *
   * **Per-call, not session state** (#62 A15, decision 12). A `Session`
   * binds them fresh on every `run()`; the replayed transcript sees the
   * *current* call's values, so a snippet that read `x` at call 1 reads
   * whatever call 2 binds — a changed value changes what earlier code
   * computed, and an omitted one fails the replay. Re-supply the same inputs
   * on every call that depends on them. Values are never persisted and never
   * appear in a dump. See docs/session-replay.md.
   */
  inputs?: Record<string, string>;
  /**
   * Host directories mounted into the sandbox, virtual path → host path.
   * Never stored in a snapshot; whoever resumes must hand it back, and
   * `Session` does (#38, #84).
   */
  mount?: Record<string, string>;
  signal?: AbortSignal;
  onPrint?: (text: string) => void;
  onApproval?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
  /** Byte ceiling on `stdout`. Default 32 KiB. Carried across a suspension by `Session`. */
  maxStdoutBytes?: number;
  /** Byte ceiling on `output`. Default 16 KiB. Carried across a suspension by `Session`. */
  maxOutputBytes?: number;
  /**
   * Name of the feed in syntax and typing diagnostics. Read when the code is
   * first fed; a resume is past both kinds of diagnostic, so it is not carried.
   */
  scriptName?: string;
  /**
   * Number of lines prepended before the caller's code in the assembled
   * script (preamble, prior snippets, …). When the sandbox renders a
   * diagnostic against the assembled script, this offset is subtracted from
   * every reported line number, and excerpt lines whose line number is at or
   * before the prefix are dropped — prefix source must never reach the caller
   * (or the model it feeds). Absent or `0` means no prefix: the diagnostics
   * are rendered as-is, which is the historical behavior.
   *
   * Applies to syntax and typing diagnostics alike. `typeCheckStubs` removes
   * only the stub file's contribution out-of-band; the prefix the caller
   * assembled still shifts typing diagnostics, and they are corrected here.
   */
  lineOffset?: number;
  /**
   * Leading bytes of print output that belong to a replayed prefix and are
   * dropped before `onPrint` and the `stdout` accumulator see anything. A
   * callback straddling the mark is sliced at it. `Session` owns this figure
   * exactly as it owns `lineOffset`: it is the number of bytes the retained
   * transcript printed when it ran, so what remains is this call's own output
   * and the `stdout` budget applies to that alone (#61, D121). Absent or `0`
   * means nothing is dropped — the historical behavior, and what a resume
   * passes, since a restored snapshot continues where it paused and replays
   * nothing.
   */
  stdoutSkipBytes?: number;
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

/**
 * Trace of a single host-tool call during execution.
 *
 * `seq` and `stdoutOffset` say where in the run the call happened (#69
 * finding 4, D143). `seq` is a per-run counter, strictly increasing across
 * every outcome the sandbox traces — a call that ran, threw, was denied, or
 * could not resolve its arguments — and continuing after the carried entries
 * when a suspended run resumes. `stdoutOffset` is the byte of the run's own
 * `stdout` (after the replay mark, before truncation) at which the call was
 * dispatched: everything printed before the call lies below it, output Monty
 * had buffered included — it flushes at every host boundary. A consumer that
 * filters entries out — replay filtering does — leaves gaps; the order is the
 * point.
 *
 * Both are optional in the type because a `Session` dump restores entries
 * through a validator that predates them, and they are deliberately *not*
 * serialised by `JSON.stringify` (the entry carries a `toJSON` that yields
 * the validator's shape) — in-process copies keep them. Always present on an
 * entry the sandbox produced.
 */
export interface ToolCallTrace {
  tool: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: string;
  approved?: boolean;
  /** Position of the call in its run; strictly increasing, gaps allowed. */
  seq?: number;
  /** Byte offset into the run's own `stdout` at which the call was dispatched. */
  stdoutOffset?: number;
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
 * `unavailable` is a refusal to start: no worker could be checked out of the
 * pool before the checkout timeout, or a `Session` holds its full complement
 * of retained snippets and will not add another until it is reset (#62 A17,
 * docs/session-replay.md). Nothing ran, so unlike every other kind it says
 * nothing about the caller's code.
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

/**
 * Successful run result.
 *
 * `output` is **always a string** (decision 15, Option A; #65, D139): the
 * `SUBMIT` answer verbatim when the run ended in `SUBMIT` — a non-`str`
 * answer never gets here, it is a Python `TypeError` in the run — else the
 * value of the last expression rendered by `formatValue` (`src/truncate.ts`):
 * Python's spelling (`{'a': 1}`, `[1, 2]`, `True`, `None`, `b'..'`,
 * `ValueError('bad')`), a bare `str` verbatim, elided between the elements of
 * the outermost value when it exceeds `maxOutputBytes`. The boundary's losses
 * are documented there and in docs/truncation-policy.md: a tuple renders as a
 * list, `1.0` as `1`, a frozenset as a set, `1e400` as `inf`.
 */
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

/**
 * Suspended run result (waiting for approval).
 *
 * The snapshot is the whole of the run's state: globals, `inputs` included,
 * and the resource limits it started under together with the compute already
 * spent against `maxDurationSecs` — so a resume continues the same budget and
 * cannot lift it (see `RunLimits`). Two things are *not* in it and must be
 * handed back by whoever resumes: the mounts, because host paths are never
 * stored in a dump (a restore without them keeps running, having turned every
 * read of a mounted file into `PermissionError`), and the byte caps on
 * `stdout` and `output`, which are the host's. `Session` carries all of those
 * across a suspension in the same process (see `Session.resume`); a caller of
 * `resumeSuspended` directly is responsible for them itself, and so is
 * whoever resumes a suspension restored from a `Session` dump — a dump
 * carries the run's state, never the host's policy (docs/session-replay.md).
 *
 * The host wall clock (`maxWallClockSecs`) does not span the suspension: it
 * restarts on every resume, so each approved continuation gets a fresh
 * window for its host-tool time (decision 1). There is no elapsed field here
 * for that reason, and none for the compute budget because the snapshot
 * already carries it.
 *
 * `stdout`, `stdoutTruncated` and `calls` are what the run produced up to the
 * gate; a resume re-accumulates from them, so the final result reports the
 * whole run.
 */
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
