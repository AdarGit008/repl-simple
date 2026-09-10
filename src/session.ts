import {
  runInSandbox,
  resumeSuspended,
  resolveToolArgs,
  buildApprovalRequest,
  type SandboxOptions,
} from "./sandbox.js";
import { ToolRegistry } from "./registry.js";
import { maskSecrets, redact } from "./redact.js";
import { HostToolError } from "./types.js";
import type {
  HostTool,
  RunError,
  RunResult,
  RunSuspended,
  RunOptions,
  ToolCallTrace,
  ApprovalRequest,
  ApprovalDecision,
  DiscardedSuspension,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

/**
 * Dump format version.
 *
 * 2 since W2-2: a v2 dump carries the stdout mark beside every retained
 * snippet (#61) and the pre-gate cache entries beside a suspension (#62 A14),
 * and nothing of the run's options (D129). A v1 dump has neither figure, so
 * a restore from one would re-emit its whole transcript on the next run and
 * re-execute every call made before a gate; it is refused, not upgraded.
 */
const CURRENT_VERSION = 2;

/**
 * Snippets a session retains before `run()` refuses to add another (#62 A17).
 *
 * Replay is O(transcript) per call, so an unbounded session is an unbounded
 * cost paid on every later call. The refusal is a `RunError` before anything
 * runs, and `reset()` is the way out.
 */
const MAX_SNIPPETS = 256;

/**
 * Cache entries a session retains before the call that would add one more
 * is refused (#62 A17). Enforced inside the caching registry, *before* the
 * tool executes, so the refused call has no side effect and a replay meets
 * the same refusal at the same position.
 */
const MAX_CACHE_ENTRIES = 1024;

/**
 * Byte ceiling on a dump, checked on the serialized text — before it is
 * parsed on the way in, and before it is handed back on the way out (#63).
 */
const MAX_DUMP_BYTES = 1_048_576;

/** Per-value byte budget in the redacted export (D130). */
const REDACTED_VALUE_MAX_BYTES = 4096;
/** Recovery clause on a redacted cut. Names a route that exists: the verbatim dump. */
const REDACTED_RECOVERY = "The verbatim value is only in the unredacted dump.";

/**
 * How many executions one approval authorises, by default.
 *
 * One. An approval answers the question it was shown — "run *this* call?" —
 * and authorises nothing past it. The knob exists because #44 requires the
 * count to be a real, enforced ceiling rather than a comment, and so that a
 * dialog offering "allow the next N" could hand out such a grant from a
 * prompt that actually says so. #35's dialog added *deny remaining* and,
 * deliberately, no such option (docs/approval-grants.md), so the only honest
 * default is the number the shipped dialog implies.
 *
 * Note what this is *not*: it is not the escape hatch. A user who wants to
 * stop being asked switches approval mode (`/repl-approvals yolo`), which is
 * a decision they make once, out loud, and can see in `repl_reset`'s output —
 * rather than one inferred from a single tired click on one dialog.
 */
export const DEFAULT_GRANT_USES = 1;

// ── Types ────────────────────────────────────────────────────────

/** A single cached tool call: the key + the result it produced. */
interface CacheEntry {
  key: string;
  result: string;
  /**
   * Set on entries `load()` restored from a dump; never serialized.
   *
   * A restored entry answers a non-gated replay as any entry does. For the
   * approval gate it is not a replay at all: the file says the call was
   * approved once, and a file's word is not consent (#63, D128). The gate
   * asks; if the user says yes the call runs for real, its real result
   * replaces the file's in place, and the flag is cleared — from then on the
   * entry is this session's own.
   */
  restored?: boolean;
}

/** A cache entry as it is written: the key and the result, nothing else. */
interface PersistedCacheEntry {
  key: string;
  result: string;
}

/** Serialized form of the suspended state within a Session dump. */
interface SuspendedState {
  /** Base64-encoded suspended-snapshot buffer */
  snapshot: string;
  /** The ApprovalRequest that triggered the suspension */
  suspendedCall: ApprovalRequest;
  /** Stdout accumulated up to the suspension point */
  stdout: string;
  /** Whether stdout was truncated before suspension */
  stdoutTruncated: boolean;
  /** ToolCallTrace entries up to the suspension point — this call's own */
  calls: ToolCallTrace[];
  /** Bytes this call printed before the gate: its share of the stdout mark (D121). */
  stdoutBytes: number;
  /** Cache entries recorded before the gate, appended when the continuation succeeds (A14, D123). */
  preGateCache: PersistedCacheEntry[];
}

/**
 * The run options a suspension keeps, and `resume()` hands back — within one
 * process.
 *
 * Exactly the options `resumeSuspended` reads that describe *the run being
 * continued* rather than the invocation continuing it: the resource limits,
 * the mounts (host paths are not in the snapshot — a restore without them
 * turns every read of a mounted file into `PermissionError`, #38), and the
 * two byte caps. A `Pick`, not `RunOptions`, so that what survives a
 * suspension is a list someone wrote down rather than whatever the caller
 * happened to pass (#84).
 *
 * None of it is written to a dump: mounts are a capability, `limits` can
 * say `"unbounded"`, the caps are the host's, and a file is not the host
 * (D129). Whoever resumes a restored suspension supplies them, as
 * `RunSuspended` documents for `resumeSuspended`'s own callers.
 *
 * What is deliberately not here, and why, is at {@link Session.resume}.
 */
type CarriedRunOptions = Pick<RunOptions, "limits" | "mount" | "maxStdoutBytes" | "maxOutputBytes">;

/** The carried subset of `opts`, with nothing else along for the ride. */
function carriedRunOptions(opts: CarriedRunOptions | undefined): CarriedRunOptions {
  return {
    limits: opts?.limits,
    mount: opts?.mount,
    maxStdoutBytes: opts?.maxStdoutBytes,
    maxOutputBytes: opts?.maxOutputBytes,
  };
}

/** Wire format for Session.dump() / Session.load(). Validated by `validateSessionDump`. */
interface SessionDump {
  version: number;
  snippets: string[];
  /** Bytes each retained snippet printed when it ran, parallel to `snippets` (D121). */
  stdoutBytes: number[];
  /** Ordered list — one entry per actual tool call from prior snippets */
  callCache: PersistedCacheEntry[];
  suspended?: SuspendedState;
  /** The code string that caused the suspension (needed for resume) */
  suspendedCode?: string;
}

/**
 * A suspension the session is holding, and everything a later `resume()`
 * needs that the `RunSuspended` itself does not carry.
 *
 * One object rather than parallel fields so that the six things either all
 * exist or none do: a suspension that had lost its code, or its pre-gate
 * entries, would be a resume that silently did less than the run it was
 * continuing.
 */
interface PendingSuspension {
  /** The sandbox result, its `calls` already filtered to this call's own. */
  result: RunSuspended;
  /** The code that suspended; appended as a snippet when the continuation succeeds. */
  code: string;
  /** The carried options (in-process only — `undefined` for a restored suspension, D129). */
  runOpts: CarriedRunOptions | undefined;
  /** Cache entries recorded before the gate, across every segment so far (A14, D123). */
  preGate: CacheEntry[];
  /** Bytes printed so far by this call, across every segment (D121). */
  stdoutBytes: number;
  /** Names of the inputs the suspended run was given, for the A15 note. */
  inputNames: string[];
}

// ── Caching helpers ─────────────────────────────────────────────

/** Build a deterministic cache key from tool name + resolved args. */
function cacheKey(toolName: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((obj, key) => {
      obj[key] = args[key];
      return obj;
    }, {});
  return `${toolName}::${JSON.stringify(sorted)}`;
}

/** A replay-cached registry, plus what the session needs to know about what it did. */
interface CachingRegistry {
  registry: ToolRegistry;
  /**
   * True when a call with this key is the *next* entry the replay cursor will
   * serve — so it will be answered from the cache and will not execute.
   *
   * False for an entry restored from a dump even when the key matches: the
   * cursor will still serve a non-gated one, but the gate — the only caller
   * of this function — must ask, because a file cannot have approved anything
   * (D128).
   *
   * This is the only place the cursor is visible outside the replay itself,
   * and it is deliberately here rather than in the gate: the grant model is
   * replay-independent, and this function is the whole of what ties the two
   * together.
   */
  willReplayKey(key: string): boolean;
  /**
   * One flag per `execute` the wrapped tools saw, in dispatch order: `true`
   * when the call was answered from the cache and nothing ran, `false` when
   * the tool executed — a cache miss, a call past the cursor, the call the
   * cap refused, or a restored gated entry the user approved (D128), which
   * advances the cursor and still runs. `withoutReplayedCalls` pairs this
   * with the sandbox's trace positionally, so a trace entry is dropped
   * because *this* invocation was served, never because its key matches an
   * entry that was (D154d).
   */
  invocations: boolean[];
}

/**
 * Wraps a parent ToolRegistry with a replay cache.
 *
 * `replayEntries` contains the ordered list of cached tool calls
 * from prior successful snippets. During execution, calls are served
 * from this list **in order** until it is exhausted. After that,
 * calls execute for real and are recorded into `newEntries` — at most
 * `capacity` of them (#62 A17): the call that would exceed it is refused
 * before it executes, as a Python `RuntimeError` naming the limit.
 */
function createCachingRegistry(
  parent: ToolRegistry,
  replayEntries: CacheEntry[],
  newEntries: CacheEntry[],
  capacity: number,
): CachingRegistry {
  let replayIndex = 0;
  const invocations: boolean[] = [];

  const tools = parent.list().map((tool): HostTool => {
    const originalExecute = tool.execute;

    const wrappedExecute = async (args: Record<string, unknown>): Promise<string> => {
      const key = cacheKey(tool.name, args);

      // 1. Serve from replay cache if there are remaining entries
      //    AND the key matches the expected next entry.
      if (replayIndex < replayEntries.length) {
        const entry = replayEntries[replayIndex];
        if (entry.key === key) {
          replayIndex++;
          if (!entry.restored || !tool.requiresApproval) {
            invocations.push(true);
            return entry.result;
          }
          // A gated call restored from a file. The gate did not treat it as a
          // replay, so the user was asked and — this code being reached —
          // said yes. It runs for real, and its real result replaces the
          // file's in place: this is the last time the file speaks for it.
          invocations.push(false);
          const real = await originalExecute(args);
          entry.result = real;
          entry.restored = undefined;
          return real;
        }
        // Key mismatch: the cache no longer matches the current
        // execution. This can happen if code changed between runs
        // (e.g., a snippet was removed). Fall through to real exec.
      }

      // Logged before the cap and the execution: a refusal and a throw are
      // both traced by the sandbox as this invocation, `ok: false`.
      invocations.push(false);

      // 2. The cap, before the side effect (A17). Deterministic on replay:
      //    the same transcript fills the same cache to the same point.
      if (newEntries.length >= capacity) {
        throw new HostToolError(
          "RuntimeError",
          `session replay cache is full (${MAX_CACHE_ENTRIES} entries): the call was not ` +
            "executed. Reset the session (repl_reset, or Session.reset()) to continue.",
        );
      }

      // 3. Execute for real
      const result = await originalExecute(args);

      // 4. Record for future replays
      newEntries.push({ key, result });
      return result;
    };

    return {
      ...tool,
      execute: wrappedExecute,
    };
  });

  return {
    registry: new ToolRegistry(tools),
    willReplayKey: (key) =>
      replayIndex < replayEntries.length &&
      replayEntries[replayIndex].key === key &&
      !replayEntries[replayIndex].restored,
    invocations,
  };
}

/** The entry as it is written: `restored` is in-process knowledge, never a fact in a file. */
function persisted({ key, result }: CacheEntry): PersistedCacheEntry {
  return { key, result };
}

/** The entry as it comes back from a file. */
function restored({ key, result }: PersistedCacheEntry): CacheEntry {
  return { key, result, restored: true };
}

// ── Stdout accounting ───────────────────────────────────────────

/** What one call printed, measured on the unconditional live stream. */
interface PrintedBytes {
  bytes: number;
}

/**
 * The `onPrint` the session hands the sandbox: counts this call's bytes,
 * then forwards to the caller's stream.
 *
 * Measured here rather than reported by the sandbox because the sandbox's
 * accumulator re-pushes the pre-gate stdout on a resume (in rendered, possibly
 * truncated form) and could not tell the true total across a suspension. The
 * live stream is exact: it is called once per callback the mark let through,
 * unconditionally — truncation-policy invariant 6 is what this relies on.
 */
function countingPrint(
  printed: PrintedBytes,
  inner: RunOptions["onPrint"],
): NonNullable<RunOptions["onPrint"]> {
  return (text) => {
    printed.bytes += Buffer.byteLength(text, "utf8");
    inner?.(text);
  };
}

// ── Approval grants ──────────────────────────────────────────────

/** A live approval, and what is left of it. */
interface Grant {
  /** Tool name, kept for reporting — the key itself carries the args. */
  tool: string;
  /** Executions still authorised. Reaching 0 means the next call re-prompts. */
  remaining: number;
}

/**
 * An outstanding grant, as reported by `outstandingGrants()`.
 *
 * The arguments are deliberately not included. They are in the key, and the
 * key is a `bash` command line — the one string in this system most likely to
 * hold a credential someone pasted. The tool name and the count are what a
 * user needs to decide whether to reset.
 */
export interface GrantSummary {
  tool: string;
  remaining: number;
}

/** Per-session knobs that are not sandbox configuration. */
export interface SessionOptions {
  /** Executions one approval authorises. Default {@link DEFAULT_GRANT_USES}. */
  grantUses?: number;
}

// ── Discarded suspensions ────────────────────────────────────────

/**
 * Attach the discard notice to a result, or return it untouched.
 *
 * A copy, never a mutation: the caller of `run` may be holding the same object
 * as the stored suspension, and the stored suspension must stay a description
 * of itself.
 */
function withDiscardNotice(result: RunResult, discarded?: DiscardedSuspension): RunResult {
  if (!discarded) return result;
  return { ...result, discardedSuspension: discarded };
}

// ── Dump validation ─────────────────────────────────────────────
//
// Reject, never coerce (#63, D127). Every object is closed — an unknown key
// is an error, `__proto__` included — every field is typed, and nothing is
// assigned to a session until the whole input has passed. The shape checked
// is the final one; anything a dump used to carry and no longer does
// (`suspendedRunOpts`, a raw `signal`) is refused by name rather than
// narrowed. What cannot be checked here is the snapshot's *contents*: those
// are Monty's, and a malformed one is a `runtime` RunError at resume
// (measured: "protocol violation: failed to load session"), not a throw.

function fail(path: string, reason: string): never {
  throw new Error(`Invalid session dump: ${path} ${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly the keys listed: every required one present, no others. */
function closedObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(path, `has an unexpected key "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is missing");
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

/**
 * A byte count: a non-negative *safe* integer. `Number.isInteger(1e308)` is
 * true, and one such stdout mark emptied the next run's output while two
 * summed to `Infinity` and re-emitted the whole transcript (D154b, measured);
 * a count no file could have measured is refused, not carried.
 */
function expectCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value;
}

function expectFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function expectArray(value: unknown, path: string, max?: number): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (max !== undefined && value.length > max) {
    fail(path, `has ${value.length} entries, over the cap of ${max}`);
  }
  return value;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, "must be an object");
  return value;
}

/**
 * Base64 by shape: the alphabet, at most two `=` of padding, a length that
 * is a whole number of quanta, and at least one quantum — a suspension
 * always has a snapshot. `Buffer.from(…, "base64")` would silently skip
 * anything else, which is the coercion this function exists to refuse.
 */
function expectBase64(value: unknown, path: string): string {
  const text = expectString(value, path);
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    fail(path, "must be base64");
  }
  return text;
}

function cacheEntries(value: unknown, path: string, max: number): PersistedCacheEntry[] {
  return expectArray(value, path, max).map((item, i) => {
    const entryPath = `${path}[${i}]`;
    const entry = closedObject(item, entryPath, ["key", "result"]);
    return {
      key: expectString(entry.key, `${entryPath}.key`),
      result: expectString(entry.result, `${entryPath}.result`),
    };
  });
}

function approvalRequest(value: unknown, path: string): ApprovalRequest {
  const request = closedObject(value, path, ["tool", "args", "kwargs", "description"]);
  return {
    tool: expectString(request.tool, `${path}.tool`),
    args: expectArray(request.args, `${path}.args`),
    kwargs: expectObject(request.kwargs, `${path}.kwargs`),
    description: expectString(request.description, `${path}.description`),
  };
}

function traces(value: unknown, path: string): ToolCallTrace[] {
  return expectArray(value, path).map((item, i) => {
    const tracePath = `${path}[${i}]`;
    const raw = closedObject(
      item,
      tracePath,
      ["tool", "args", "kwargs", "durationMs", "ok"],
      ["error", "approved"],
    );
    const trace: ToolCallTrace = {
      tool: expectString(raw.tool, `${tracePath}.tool`),
      args: expectArray(raw.args, `${tracePath}.args`),
      kwargs: expectObject(raw.kwargs, `${tracePath}.kwargs`),
      durationMs: expectFinite(raw.durationMs, `${tracePath}.durationMs`),
      ok: expectBoolean(raw.ok, `${tracePath}.ok`),
    };
    if (raw.error !== undefined) trace.error = expectString(raw.error, `${tracePath}.error`);
    if (raw.approved !== undefined) {
      trace.approved = expectBoolean(raw.approved, `${tracePath}.approved`);
    }
    return trace;
  });
}

function suspendedState(value: unknown, path: string): SuspendedState {
  const raw = closedObject(value, path, [
    "snapshot",
    "suspendedCall",
    "stdout",
    "stdoutTruncated",
    "calls",
    "stdoutBytes",
    "preGateCache",
  ]);
  const stdout = expectString(raw.stdout, `${path}.stdout`);
  const stdoutTruncated = expectBoolean(raw.stdoutTruncated, `${path}.stdoutTruncated`);
  const stdoutBytes = expectCount(raw.stdoutBytes, `${path}.stdoutBytes`);
  // The one mark the dump carries a length for. The figure counts the live
  // stream the call printed and `stdout` is the same stream rendered, so
  // unless the rendering cut it the two agree to the byte (D154b, measured
  // across a partial line, UTF-8 and a re-suspension). Cut, the rendering
  // carries a marker that can outweigh the dropped tail, so nothing is
  // asserted beyond the safe-integer bound.
  const retained = Buffer.byteLength(stdout, "utf8");
  if (!stdoutTruncated && stdoutBytes !== retained) {
    fail(
      `${path}.stdoutBytes`,
      `is ${stdoutBytes} but ${path}.stdout holds ${retained} bytes and nothing was truncated`,
    );
  }
  return {
    snapshot: expectBase64(raw.snapshot, `${path}.snapshot`),
    suspendedCall: approvalRequest(raw.suspendedCall, `${path}.suspendedCall`),
    stdout,
    stdoutTruncated,
    calls: traces(raw.calls, `${path}.calls`),
    stdoutBytes,
    preGateCache: cacheEntries(raw.preGateCache, `${path}.preGateCache`, MAX_CACHE_ENTRIES),
  };
}

/**
 * The whole validation, input text to typed dump. The size bound comes
 * first, on the serialized text, so a 100 MB input is refused for its length
 * before any parser sees it (measured: `Buffer.byteLength` over 100 MB in
 * under 100 ms).
 */
function validateSessionDump(json: string): SessionDump {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_DUMP_BYTES) {
    fail("input", `is ${bytes} bytes, over the ${MAX_DUMP_BYTES}-byte bound (1 MiB)`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Invalid session JSON");
  }
  if (!isPlainObject(raw)) fail("input", "must be a JSON object");

  if (typeof raw.version !== "number") fail("version", "must be a number");
  if (raw.version !== CURRENT_VERSION) {
    throw new Error(`Unsupported session version: ${raw.version} (expected ${CURRENT_VERSION})`);
  }
  if (raw.redacted === true) {
    throw new Error(
      "Invalid session dump: a redacted export is not a restorable dump (see Session.dumpRedacted)",
    );
  }

  const top = closedObject(
    raw,
    "dump",
    ["version", "snippets", "stdoutBytes", "callCache"],
    ["suspended", "suspendedCode"],
  );
  const snippets = expectArray(top.snippets, "snippets", MAX_SNIPPETS).map((item, i) =>
    expectString(item, `snippets[${i}]`),
  );
  const stdoutBytes = expectArray(top.stdoutBytes, "stdoutBytes").map((item, i) =>
    expectCount(item, `stdoutBytes[${i}]`),
  );
  if (stdoutBytes.length !== snippets.length) {
    fail("stdoutBytes", `has ${stdoutBytes.length} entries for ${snippets.length} snippets`);
  }
  // The marks are summed into the one figure handed to the sandbox; a sum
  // past the safe range is a mark no run could have measured (D154b).
  const mark = stdoutBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (!Number.isSafeInteger(mark)) {
    fail("stdoutBytes", `sums to ${mark}, past Number.MAX_SAFE_INTEGER`);
  }
  const dump: SessionDump = {
    version: CURRENT_VERSION,
    snippets,
    stdoutBytes,
    callCache: cacheEntries(top.callCache, "callCache", MAX_CACHE_ENTRIES),
  };

  if ((top.suspended === undefined) !== (top.suspendedCode === undefined)) {
    fail("suspendedCode", "and suspended must be present together");
  }
  if (top.suspended !== undefined) {
    dump.suspended = suspendedState(top.suspended, "suspended");
    dump.suspendedCode = expectString(top.suspendedCode, "suspendedCode");
    // One cap over both lists, plus the entry the continuation records for
    // the suspended call itself: a dump the cache could not admit that call
    // into is one whose approval can never be honoured, and it is refused
    // here by name rather than at resume as "the cache is full" (D154c,
    // measured: 1023 + 1 loaded and the approved call was refused).
    const cached = dump.callCache.length;
    const preGate = dump.suspended.preGateCache.length;
    if (cached + preGate + 1 > MAX_CACHE_ENTRIES) {
      fail(
        "callCache",
        `(${cached} entries) and suspended.preGateCache (${preGate}) hold ${cached + preGate} ` +
          `together, and the suspended call needs one more: the replay cache holds ` +
          `${MAX_CACHE_ENTRIES} entries at most`,
      );
    }
  }
  return dump;
}

// ── Session ──────────────────────────────────────────────────────

/**
 * Persistent Python execution session.
 *
 * Maintains state across multiple `run()` calls via transcript replay:
 * each run concatenates all prior successful snippets + new code in a
 * fresh sandbox session. Host-tool side effects are deduplicated
 * through an ordered call cache so they don't repeat on replay, and the
 * replayed output is dropped at a byte mark so each call reports only what
 * it printed. The semantics — what replays, what is cached, what a dump is
 * and is not — are written down in docs/session-replay.md.
 */
export class Session {
  // ── State ──────────────────────────────────────────────────

  private snippets: string[] = [];
  /**
   * Bytes each retained snippet printed when it ran, parallel to
   * {@link snippets}; the first figure includes whatever the preamble
   * printed. Their sum is {@link prefixStdoutBytes}, the mark handed to the
   * sandbox as `stdoutSkipBytes` (#61, D121).
   */
  private snippetStdoutBytes: number[] = [];
  /**
   * Running total of lines in the assembled prefix: the preamble plus every
   * snippet appended to {@link snippets}. Incremented on each successful
   * `run()`/`resume()` append and reset in `reset()`/`load()`, so
   * {@link prefixLineCount} is O(1) (#145, D28).
   */
  private prefixLineTotal = 0;
  /** Running sum of {@link snippetStdoutBytes}, maintained the same way. */
  private prefixStdoutBytes = 0;
  /** Ordered list of all tool calls from successful snippets. */
  private callCacheEntries: CacheEntry[] = [];
  private sandboxOptions: SandboxOptions;
  private preamble: string | undefined;
  private pending: PendingSuspension | null = null;
  /**
   * Names of the inputs any retained snippet was given (#62 A15, D124).
   * Names only, in memory only: inputs are per-call, and the one thing the
   * session does with this is explain a failed replay that omitted them.
   */
  private inputNamesSeen = new Set<string>();
  /**
   * Approvals granted by the user, live only for the current logical call.
   *
   * Keyed by `cacheKey(tool, resolvedArgs)`. Cleared when a `run()` starts and
   * again when a call finishes, so a grant reaches the next `repl` call only
   * by way of a suspension — which is the same call, paused. Never serialized:
   * see `dump()`.
   */
  private grants = new Map<string, Grant>();
  private grantUses: number;
  /**
   * The tail of the call queue. `run()` and `resume()` are serialised through
   * it so that concurrent calls behave exactly as sequential ones (D131):
   * measured without it, two concurrent resumes of one suspension both
   * approved and executed the gated call, and two concurrent runs assembled
   * prefixes that did not include each other. Never rejects — a failed call
   * is its caller's to see, not the next caller's.
   */
  private queue: Promise<unknown> = Promise.resolve();

  // ── Constructor ────────────────────────────────────────────

  constructor(sandboxOptions: SandboxOptions, preamble?: string, options: SessionOptions = {}) {
    this.sandboxOptions = sandboxOptions;
    this.preamble = preamble;
    // Seed the running prefix-line total with the preamble; each snippet is
    // added as it is appended (see run/resume), so the total never needs a
    // re-scan of the whole list (#145, D28).
    this.prefixLineTotal = preamble ? preamble.split("\n").length : 0;

    const uses = options.grantUses ?? DEFAULT_GRANT_USES;
    if (!Number.isInteger(uses) || uses < 1) {
      // Refused rather than clamped: 0 and 0.5 are both someone believing
      // something false about the approval model, and a security ceiling
      // should not be quietly rounded into a different one.
      throw new RangeError(`grantUses must be an integer >= 1, got ${uses}`);
    }
    this.grantUses = uses;
  }

  // ── Grants ─────────────────────────────────────────────────

  /**
   * Approvals still live in this session, for `repl_reset` to report.
   *
   * Non-empty only while a call is paused at a suspension, or when
   * `grantUses > 1` left something over.
   */
  outstandingGrants(): GrantSummary[] {
    return [...this.grants.values()]
      .filter((g) => g.remaining > 0)
      .map((g) => ({ tool: g.tool, remaining: g.remaining }));
  }

  // ── Suspension state ───────────────────────────────────────

  /**
   * Whether a gated call is paused here, waiting for a decision.
   *
   * `resume()` throws without one, which is the right contract for a caller
   * that knows the state. `ReplRunner` does not — the model chooses when to
   * call `repl_resume` — so it asks first and answers in a sentence (#48).
   */
  isSuspended(): boolean {
    return this.pending !== null;
  }

  // ── run ────────────────────────────────────────────────────

  /**
   * Execute Python code in this session.
   *
   * Prior successful snippets are replayed first so variables,
   * imports, and function definitions persist. Host-tool calls from
   * prior snippets are served from an ordered call cache to avoid
   * repeating side effects, and their output is dropped at the stdout mark
   * so `stdout` is what this call printed.
   *
   * On success the snippet is appended for future runs.
   * On error the snippet is dropped: none of its bindings and none of its
   * calls are replayed later, though its side effects happened and its trace
   * says so (A16).
   * On suspension the state is saved for later `resume()`.
   *
   * **A pending suspension does not survive this call.** Running new code is
   * the caller moving on, so the deferred decision is discarded here and
   * reported on the result — see {@link DiscardedSuspension} for why it cannot
   * simply be left pending (#129).
   *
   * **Caps.** A session that already holds {@link MAX_SNIPPETS} snippets
   * refuses the call before anything runs (`unavailable`), and a call that
   * would push the cache past {@link MAX_CACHE_ENTRIES} entries fails at that
   * call, before its side effect (`runtime`); `reset()` is the way out of
   * either (A17).
   *
   * Calls on one session are serialised: a `run()` issued while another
   * `run()` or `resume()` is in flight waits for it and then sees its result,
   * exactly as a sequential caller would (D131).
   */
  async run(code: string, runOpts?: RunOptions): Promise<RunResult> {
    return this.serialised(() => this.runNow(code, runOpts));
  }

  private async runNow(code: string, runOpts?: RunOptions): Promise<RunResult> {
    // The snippet cap, before anything runs and before the pending
    // suspension is touched: nothing about the session changes on a refusal.
    if (this.snippets.length >= MAX_SNIPPETS) return this.snippetCapRefusal("nothing ran");

    // Before anything replays: the old call is over, whatever it was waiting
    // for. Doing this first is what keeps `snippets` in execution order.
    const discarded = this.discardPendingSuspension();

    // Build the full transcript: preamble + prior snippets + new code
    const parts: string[] = [];
    if (this.preamble) parts.push(this.preamble);
    parts.push(...this.snippets, code);
    const allCode = parts.join("\n");

    // Everything before the last part is the prefix the sandbox numbers its
    // diagnostics from, so the session owns the offset: the line count of the
    // actual assembled prefix (preamble + stacked prior snippets), computed
    // from the parts really joined — never a hardcoded constant (#77, D1).
    // A caller-supplied `lineOffset` cannot be right here: the session is the
    // one doing the prepending. The stdout mark is the session's for the same
    // reason (#61).
    const lineOffset = this.prefixLineCount();

    // A grant belongs to one call. The discard above already cleared the only
    // path that can leave one behind — a suspension that was never resumed —
    // and this keeps that true however the previous call ended.
    this.grants.clear();

    // New entries discovered during this run
    const newEntries: CacheEntry[] = [];

    // Build caching registry with the current replay list. Its invocation
    // log is what tells this call's trace apart from the replayed one.
    const {
      registry: cachingRegistry,
      willReplayKey,
      invocations,
    } = createCachingRegistry(
      this.sandboxOptions.registry,
      this.callCacheEntries,
      newEntries,
      MAX_CACHE_ENTRIES - this.callCacheEntries.length,
    );

    const printed: PrintedBytes = { bytes: 0 };
    const wrappedRunOpts: RunOptions = {
      ...runOpts,
      lineOffset,
      stdoutSkipBytes: this.prefixStdoutBytes,
      onPrint: countingPrint(printed, runOpts?.onPrint),
      onApproval: this.makeApprovalGate(runOpts?.onApproval, willReplayKey),
    };

    const result = await runInSandbox(
      allCode,
      { ...this.sandboxOptions, registry: cachingRegistry },
      wrappedRunOpts,
    );

    // Anything but a suspension ends the call, and the grants with it.
    if (result.status !== "suspended") this.grants.clear();

    // Every outcome reports this call's calls, not the replayed ones (A16,
    // D125) — the error trace and the suspension used to carry both.
    const calls = this.withoutReplayedCalls(result.calls, invocations);
    const inputNames = Object.keys(runOpts?.inputs ?? {});

    // Post-process based on result
    if (result.status === "ok") {
      this.retain(code, printed.bytes, newEntries, inputNames);
      return withDiscardNotice({ ...result, calls }, discarded);
    }
    if (result.status === "suspended") {
      // Save suspension state — the raw result, so the notice about the *last*
      // suspension is not carried into the state describing this one. The
      // entries recorded before the gate travel with it (A14).
      const stored: RunSuspended = { ...result, calls };
      this.pending = {
        result: stored,
        code,
        runOpts: carriedRunOptions(runOpts),
        preGate: newEntries,
        stdoutBytes: printed.bytes,
        inputNames,
      };
      return withDiscardNotice(stored, discarded);
    }
    // Error: drop snippet, don't update cache. Say so if the replay was
    // asked to run without inputs an earlier snippet had (A15).
    return withDiscardNotice(
      { ...result, calls, error: this.withInputsNote(result.error, runOpts?.inputs) },
      discarded,
    );
  }

  // ── resume ─────────────────────────────────────────────────

  /**
   * Resume execution after an approval-gate suspension.
   *
   * Uses `runOpts.onApproval(suspendedCall)` to decide the suspended tool
   * call's fate. All three answers are honoured: approve, deny, and
   * `"suspend"` — "not now", which leaves the suspension exactly where it was.
   * If no callback is provided, the call is denied. A caller whose `signal`
   * is already aborted is not asked at all: an aborted turn has nobody left
   * to answer a dialog, so the call is denied and the sandbox's abort gate
   * reports `aborted` before anything runs (#47).
   *
   * **What the continuation runs with.** The run being continued was given
   * options when it started; the call continuing it is a different
   * invocation with options of its own. Four fields describe the run and are
   * carried across the suspension — `limits`, `mount`, `maxStdoutBytes`,
   * `maxOutputBytes` — and for each the rule is **the resume call wins**:
   * `caller ?? suspended` (D74, matching #177 D4). A caller that says nothing
   * gets what the run was given; a caller that says something is describing
   * this invocation and is obeyed. Through `ReplRunner.resume`, which passes
   * `{ onApproval, signal, limits }`, that means the mount and the byte caps
   * come from the suspended run and the limits are re-clamped for this call.
   * A suspension restored by `load()` carries none of the four — a dump holds
   * the run's state, not the host's policy (D129) — so there the caller's
   * values, or the defaults, are all there is.
   *
   * Not carried, by design:
   * - `onApproval`, `signal`, `onPrint` — who is asking, whose turn can be
   *   cancelled, whose terminal is watching. All three belong to the current
   *   invocation, and a stale signal handed forward would abort a resume the
   *   user just asked for.
   * - `inputs` — bound as globals by `feedStart`, so they are in the snapshot
   *   already and nothing re-supplies them.
   * - `scriptName` — names the feed for the syntax and typing diagnostics
   *   `feedStart` raises; a resume is past both.
   * - `lineOffset` and `stdoutSkipBytes` — the session's to compute, here as
   *   in `run()`; a resume replays nothing, so the mark is zero.
   *
   * `limits.maxDurationSecs` and `maxMemory` are carried for the checkout,
   * not for effect: the snapshot pins the budget the run started with,
   * compute already spent included, and a resume can neither lift nor lower
   * it (measured; see {@link RunLimits}). `maxWallClockSecs` is the one knob
   * in `limits` a resume caller changes — it restarts on every resume.
   * `maxSuspensions` sits between the two: the snapshot pins it too, so a
   * resume cannot lift it — neither a carried value nor a caller's larger one,
   * and not across `dump()`/`load()`, which drops the carried `limits` but not
   * the snapshot — while a caller's *smaller* value does tighten it, and the
   * count starts again at each resume (measured on Monty 0.0.23; pinned in
   * test/session.test.ts).
   *
   * On success the original code is appended to the snippet list, with the
   * calls it made before the gate and after it, in order (A14). Whatever
   * happens — a result, a re-suspension, or a throw out of the sandbox — the
   * suspension this call consumed is cleared, so a continuation that fails to
   * start leaves the session usable rather than pinned to it (#47).
   *
   * Serialised with `run()` (D131): a second `resume()` issued while the
   * first is in flight waits for it, and then finds either the re-suspension
   * the first produced or nothing pending at all.
   *
   * @throws If there is no pending suspension, or if the sandbox refuses to
   *   start (`SandboxMemoryError`); in the latter case the suspension is gone
   *   and the grants the call was holding are revoked.
   */
  async resume(runOpts?: RunOptions): Promise<RunResult> {
    return this.serialised(() => this.resumeNow(runOpts));
  }

  private async resumeNow(runOpts?: RunOptions): Promise<RunResult> {
    const pending = this.pending;
    if (!pending) {
      throw new Error("No suspended execution to resume");
    }
    // The snippet cap, here as in `run()` (D154a): a successful continuation
    // appends a snippet, and a session at the cap has no room for it — it
    // would dump into a file `load()` refuses. Refused before the dialog and
    // before anything runs; the suspension stays pending, and `reset()` or
    // `abandon()` is the way out. Only a hand-built dump can get here: a
    // live session refuses at the cap before it can suspend.
    if (this.snippets.length >= MAX_SNIPPETS) {
      return this.snippetCapRefusal(
        "the continuation did not run and the call is still waiting for its decision",
      );
    }
    const suspendedCall = pending.result.suspendedCall;

    // Resolve the decision for the suspended call. The type is
    // `ApprovalDecision`, not `boolean`: narrowing here is what silently turned
    // every "decide later" into a denial, one layer below the extension that
    // was discarding it too (#51). Two layers each dropping the same value is
    // why both had to widen for either to matter.
    let decision: ApprovalDecision;
    if (runOpts?.signal?.aborted) {
      // Before the callback, not after it: the extension guards this at its
      // own dialog, the library entry did not, so a pre-aborted resume put a
      // dialog on screen for a call already cancelled (#47, PR #151 INFO #1).
      // Denied rather than deferred — the call is over — and `resumeSuspended`
      // reports it as `aborted` before the tool or Python can run.
      decision = false;
    } else if (runOpts?.onApproval) {
      decision = await runOpts.onApproval(suspendedCall);
    } else {
      decision = false; // No callback → deny
    }

    // "Decide later" is not a decision, so nothing happens: no grant, no
    // snapshot restored, no state advanced. Answering it by round-tripping the
    // snapshot through a fresh worker would be the same restore that #129 had
    // to make faithful, run for a call that has not been decided — so the
    // stored suspension is simply handed back, and the next `resume` asks
    // again. `resumeSuspended` still handles this case for its own callers.
    if (decision === "suspend") return pending.result;

    // An approval here is the user answering the dialog for *this* call, so it
    // grants what any other approval grants — including the one use this call
    // is about to spend, which is why the grant recorded is one short.
    if (decision) this.recordGrant(this.keyFor(suspendedCall), suspendedCall.tool);

    // Use a caching registry so the suspended tool's return value
    // (and any subsequent tool calls) are captured for future replays.
    // resumeSuspended calls tool.execute() directly on the suspended
    // call (bypassing the approval gate), so the caching wrapper sees
    // it without double-execution. The cap counts what the cache holds plus
    // what this call recorded before the gate.
    const newEntries: CacheEntry[] = [];
    const { registry: cachingRegistry, willReplayKey } = createCachingRegistry(
      this.sandboxOptions.registry,
      [], // No replay entries — the suspended call was already decided
      newEntries,
      MAX_CACHE_ENTRIES - this.callCacheEntries.length - pending.preGate.length,
    );

    // The same gate as `run()`. With no replay entries its cache branch is
    // dead here, so every gated call in the resumed continuation is decided by
    // a grant or by the user — never by "something like it ran once".
    const carried = pending.runOpts;
    const printed: PrintedBytes = { bytes: 0 };
    const wrappedRunOpts: RunOptions = {
      ...runOpts,
      // The carried four, caller-wins — the rule is written in the doc above.
      limits: runOpts?.limits ?? carried?.limits,
      mount: runOpts?.mount ?? carried?.mount,
      maxStdoutBytes: runOpts?.maxStdoutBytes ?? carried?.maxStdoutBytes,
      maxOutputBytes: runOpts?.maxOutputBytes ?? carried?.maxOutputBytes,
      lineOffset: this.prefixLineCount(),
      stdoutSkipBytes: 0,
      onPrint: countingPrint(printed, runOpts?.onPrint),
      onApproval: this.makeApprovalGate(runOpts?.onApproval, willReplayKey),
    };

    let result: RunResult;
    try {
      result = await resumeSuspended(
        pending.result,
        decision,
        { ...this.sandboxOptions, registry: cachingRegistry },
        wrappedRunOpts,
      );
    } catch (err) {
      // A throw ends the call as surely as a result does — the memory guard
      // refusing the checkout, say — and the grants belonged to that call.
      this.grants.clear();
      throw err;
    } finally {
      // Cleared whatever happened, and before any branch below re-suspends:
      // a continuation that never started must not leave the session pinned
      // to it, `isSuspended()` true and every `resume()` retrying into the
      // same failure (#47).
      this.pending = null;
    }

    // The call is over unless it suspended again.
    if (result.status !== "suspended") this.grants.clear();

    // What the call has printed and recorded across every segment so far.
    const stdoutBytes = pending.stdoutBytes + printed.bytes;
    const entries = [...pending.preGate, ...newEntries];

    if (result.status === "ok") {
      // Append cached tool calls — the pre-gate ones first, then the suspended
      // call's result and whatever followed it — and the snippet.
      this.retain(pending.code, stdoutBytes, entries, pending.inputNames);
      return result;
    }
    if (result.status === "suspended") {
      // Suspended again on a later gated call. What it carries is what this
      // continuation ran with — the merged options — so a later resume that
      // says nothing gets the same mount and caps this one did; and the
      // entries and bytes accumulated so far, so nothing is dropped twice.
      this.pending = {
        result,
        code: pending.code,
        runOpts: carriedRunOptions(wrappedRunOpts),
        preGate: entries,
        stdoutBytes,
        inputNames: pending.inputNames,
      };
      return result;
    }
    // Error: don't add snippet
    return result;
  }

  // ── abandon ────────────────────────────────────────────────

  /**
   * Discard the pending suspension.
   *
   * @returns `true` if there was a suspension to abandon, `false` if
   *          the session was not suspended.
   */
  abandon(): boolean {
    if (!this.pending) return false;
    this.pending = null;
    // Abandoning ends the call the grants belonged to.
    this.grants.clear();
    return true;
  }

  // ── reset ──────────────────────────────────────────────────

  /**
   * Clear all session state: snippets, the stdout mark, cache, grants, and
   * any suspension.
   *
   * @returns the grants that were live at the moment of the reset, so the
   *          caller can tell the user what it just revoked.
   */
  reset(): GrantSummary[] {
    const revoked = this.outstandingGrants();
    this.snippets = [];
    this.snippetStdoutBytes = [];
    this.prefixLineTotal = this.preamble ? this.preamble.split("\n").length : 0;
    this.prefixStdoutBytes = 0;
    this.callCacheEntries = [];
    this.pending = null;
    this.inputNamesSeen.clear();
    this.grants.clear();
    return revoked;
  }

  // ── dump ───────────────────────────────────────────────────

  /**
   * Serialize the session to a JSON string for persistent storage.
   * The returned string can be passed to `Session.load()`.
   *
   * **Verbatim, and therefore sensitive.** The replay cache holds every tool
   * result exactly as the tool returned it — file contents, command output,
   * response bodies — because that is what a replay must serve; a dump is as
   * sensitive as the most sensitive thing the session read. Treat it as a
   * credential file. {@link dumpRedacted} is the form to show or export.
   *
   * **Grants are not included, and must not be.** They authorise executions in
   * the call that is running now; a grant that survives into another process
   * is the unbounded lifetime #44 removed, rebuilt through the back door. A
   * restored session re-asks — and re-asks for every cached gated call too,
   * the first time it is replayed (D128).
   *
   * **Nor are the run's options** (mount, limits, byte caps): a dump carries
   * the run's state, not the host's policy (D129). And nor are inputs, which
   * are per-call (A15).
   *
   * @throws If the serialized dump exceeds {@link MAX_DUMP_BYTES}: `load()`
   *   would refuse it, so it is refused here, where the caller can still
   *   reset the session or keep less in it.
   */
  dump(): string {
    const json = JSON.stringify(this.toDump(), null, 2);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > MAX_DUMP_BYTES) {
      throw new Error(
        `session dump is ${bytes} bytes, over the ${MAX_DUMP_BYTES}-byte bound (1 MiB); ` +
          "reset the session, or keep less in it, before persisting",
      );
    }
    return json;
  }

  private toDump(): SessionDump {
    const obj: SessionDump = {
      version: CURRENT_VERSION,
      snippets: [...this.snippets],
      stdoutBytes: [...this.snippetStdoutBytes],
      callCache: this.callCacheEntries.map(persisted),
    };

    if (this.pending) {
      const { result, code, preGate, stdoutBytes } = this.pending;
      obj.suspended = {
        snapshot: result.snapshot.toString("base64"),
        suspendedCall: result.suspendedCall,
        stdout: result.stdout,
        stdoutTruncated: result.stdoutTruncated,
        calls: result.calls,
        stdoutBytes,
        preGateCache: preGate.map(persisted),
      };
      obj.suspendedCode = code;
    }

    return obj;
  }

  /**
   * The session for display or export: the shape of {@link dump}, passed
   * through `src/redact.ts` (D130, decision 13).
   *
   * Secrets are masked in snippets, cache keys (a `bash` command line),
   * descriptions and trace errors; cache results and stdout are masked and
   * cut head-only at {@link REDACTED_VALUE_MAX_BYTES}. Two things are
   * omitted rather than redacted, because no pattern can see into them: the
   * snapshot, which is opaque interpreter state and may hold a secret in a
   * variable, and call arguments. It carries `redacted: true` and `load()`
   * refuses it — a redacted cache cannot serve a replay.
   */
  dumpRedacted(): string {
    const mask = (text: string) => maskSecrets(text).text;
    const cut = (text: string) =>
      redact(text, { maxBytes: REDACTED_VALUE_MAX_BYTES, recovery: REDACTED_RECOVERY }).text;
    const entry = (e: CacheEntry) => ({ key: mask(e.key), result: cut(e.result) });
    const trace = (c: ToolCallTrace) => ({
      tool: c.tool,
      durationMs: c.durationMs,
      ok: c.ok,
      ...(c.error === undefined ? {} : { error: mask(c.error) }),
      ...(c.approved === undefined ? {} : { approved: c.approved }),
    });

    const out: Record<string, unknown> = {
      redacted: true,
      version: CURRENT_VERSION,
      snippets: this.snippets.map(mask),
      stdoutBytes: [...this.snippetStdoutBytes],
      callCache: this.callCacheEntries.map(entry),
    };
    if (this.pending) {
      const { result, code, preGate, stdoutBytes } = this.pending;
      out.suspended = {
        tool: result.suspendedCall.tool,
        description: mask(result.suspendedCall.description),
        stdout: cut(result.stdout),
        stdoutTruncated: result.stdoutTruncated,
        calls: result.calls.map(trace),
        stdoutBytes,
        preGateCache: preGate.map(entry),
      };
      out.suspendedCode = mask(code);
    }
    return JSON.stringify(out, null, 2);
  }

  // ── load (static) ──────────────────────────────────────────

  /**
   * Restore a session from a JSON string produced by `dump()`.
   *
   * **Validated first, wholesale.** The input is checked against its size
   * bound before it is parsed and against the v2 schema before anything is
   * assigned — reject, never coerce (#63, D127). What the schema cannot
   * check is the snapshot's contents, which Monty refuses at resume as a
   * `runtime` error.
   *
   * **A file cannot approve anything.** Every restored cache entry is marked
   * so that a gated call reached in replay asks the user; approved, it runs
   * for real and its real result replaces the file's (D128). The suspended
   * call's description is re-derived from the live tool and the stored
   * arguments, so the dialog shows what would run, whatever the file said.
   *
   * **The dump is half a session.** The registry, the preamble and every
   * toolstore-side view of them are not serialized — the caller must rebuild
   * them exactly as session creation did (`ReplRunner.createSession` is the
   * reference): a registry whose toolstore tools were built with a **fresh**
   * `PreambleStatus` (loaded/withheld/refused/skipped/unreadable **and**
   * `identity`, from a new `loadSavedTools`/`savedToolNames` pass), a **live**
   * `isTrusted` callback (omitted, the tools fall back to the snapshot and a
   * stale `true` reads files the user no longer trusts), and the preamble
   * string re-derived through the trusted load path — the *same* preamble,
   * too: the first snippet's stdout mark includes what the preamble printed.
   * A restored session whose disk changed since the dump also replays its
   * cached tool results verbatim — treat them as the snapshots they are.
   *
   * Not restored, by design: the run's options for a pending suspension
   * (the resume caller supplies them, D129); `grantUses` (a restored session
   * gets {@link DEFAULT_GRANT_USES}); grants; input names (the A15 note is
   * in-process knowledge).
   *
   * @param json  Serialized session state.
   * @param sandboxOptions  Sandbox configuration (ToolRegistry, etc.).
   * @param preamble  The preamble to prepend — rebuilt by the caller, not read
   *   from the dump.
   * @throws If the input is over the size bound, not JSON, not the current
   *   version, a redacted export, or not the v2 shape — with an error naming
   *   the field.
   */
  static load(json: string, sandboxOptions: SandboxOptions, preamble?: string): Session {
    const dump = validateSessionDump(json);

    const session = new Session(sandboxOptions, preamble);
    session.snippets = dump.snippets;
    session.snippetStdoutBytes = dump.stdoutBytes;
    // The constructor seeded the preamble's lines; add the restored snippets'
    // lines so the running total matches the split-based count byte-for-byte,
    // and sum the marks the same way.
    for (const snippet of session.snippets) {
      session.prefixLineTotal += snippet.split("\n").length;
    }
    for (const bytes of session.snippetStdoutBytes) {
      session.prefixStdoutBytes += bytes;
    }
    session.callCacheEntries = dump.callCache.map(restored);

    if (dump.suspended !== undefined && dump.suspendedCode !== undefined) {
      const state = dump.suspended;
      // The description is display text derived from the arguments. A tool
      // the registry knows re-derives it; an unknown tool keeps the stored
      // text, and its resume raises NameError before anything can run.
      const tool = sandboxOptions.registry.get(state.suspendedCall.tool);
      const suspendedCall = tool
        ? buildApprovalRequest(tool, state.suspendedCall.args, state.suspendedCall.kwargs)
        : state.suspendedCall;
      session.pending = {
        result: {
          status: "suspended",
          suspendedCall,
          snapshot: Buffer.from(state.snapshot, "base64"),
          stdout: state.stdout,
          stdoutTruncated: state.stdoutTruncated,
          calls: state.calls,
        },
        code: dump.suspendedCode,
        runOpts: undefined,
        preGate: state.preGateCache.map(restored),
        stdoutBytes: state.stdoutBytes,
        inputNames: [],
      };
    }

    return session;
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * The `RunError` a call at the snippet cap gets, from `run()` and from
   * `resume()` alike (A17, D154a): `unavailable`, because nothing ran and the
   * code is not the reason; `detail` says what did not happen.
   */
  private snippetCapRefusal(detail: string): RunError {
    return {
      status: "error",
      errorKind: "unavailable",
      error:
        `session holds ${MAX_SNIPPETS} snippets, the replay cap; ${detail}. ` +
        "Reset the session (repl_reset, or Session.reset()) to continue.",
      stdout: "",
      stdoutTruncated: false,
      calls: [],
    };
  }

  /**
   * Run one call after every call queued before it (D131).
   *
   * The queue never rejects: a failed call is handed to its own caller and
   * the next call starts regardless.
   */
  private serialised<T>(call: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(call);
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /**
   * Append a snippet that completed, with everything replay needs to stand in
   * for it later: the bytes it printed (so they are dropped next time), the
   * calls it made (so they are served next time) and the input names it was
   * given (so a replay without them can be explained).
   */
  private retain(
    code: string,
    stdoutBytes: number,
    entries: CacheEntry[],
    inputNames: string[],
  ): void {
    this.snippets.push(code);
    this.snippetStdoutBytes.push(stdoutBytes);
    this.prefixLineTotal += code.split("\n").length;
    this.prefixStdoutBytes += stdoutBytes;
    this.callCacheEntries.push(...entries);
    for (const name of inputNames) this.inputNamesSeen.add(name);
  }

  /**
   * The number of lines the assembled transcript prepends before the code
   * being run right now: the preamble plus every stacked prior snippet.
   *
   * This is the `RunOptions.lineOffset` the session hands the sandbox, and
   * the same figure applies to a resumed run: the resumed transcript is the
   * one `run()` assembled for the suspended snippet, and `snippets` cannot
   * have changed since — the run that suspended never appended its snippet,
   * and any later `run()` discards the pending suspension before touching
   * the list (#129). Maintained as a running total — seeded with the
   * preamble at construction, added to on each append, and reset where the
   * snippet list is rebuilt (`reset()`, `load`) — rather than re-split from
   * the parts on every call (#77, #145 D28). The returned number is
   * byte-identical to the split-based count.
   */
  private prefixLineCount(): number {
    return this.prefixLineTotal;
  }

  /**
   * Close out a suspension left over from an earlier call, if there is one.
   *
   * Abandon rather than refuse: deferring an approval means "not now", and a
   * fresh `run` is the caller deciding to move on. Refusing would turn a
   * forgotten decision into a wall the caller must clear before the session
   * works again. What abandoning costs is silence — which is why the call it
   * dropped is described back to the caller rather than only discarded.
   */
  private discardPendingSuspension(): DiscardedSuspension | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    const { tool, description } = pending.result.suspendedCall;
    this.abandon();
    return { tool, description };
  }

  /**
   * The A15 note, when it applies: the replay was run without inputs an
   * earlier snippet was given. Appended to an error rather than raised on its
   * own, because the session cannot know whether the omission is what failed
   * — only that it is the first thing to check, and that the diagnostic it
   * otherwise leaves points at a prefix line the caller cannot see.
   */
  private withInputsNote(error: string, inputs: RunOptions["inputs"]): string {
    const supplied = new Set(Object.keys(inputs ?? {}));
    const missing = [...this.inputNamesSeen].filter((name) => !supplied.has(name));
    if (missing.length === 0) return error;
    return (
      `${error}\n\nNote: inputs are per-call, not session state. Earlier snippets in this ` +
      `session ran with inputs [${missing.join(", ")}] that this call did not supply, and ` +
      "replaying them may be what failed. Re-supply the same inputs on every call " +
      "(docs/session-replay.md)."
    );
  }

  /**
   * The approval gate, shared by `run()` and `resume()`.
   *
   * Three ways a gated call gets through, in order:
   *
   * 1. **It is a replay.** The caching registry is about to answer this exact
   *    call from the cache, in cursor order, so nothing executes. Approving
   *    what will not run is not a grant; it is the absence of a question. This
   *    is the one branch that must keep working — a session that re-asks for
   *    every prior call on every run is a session nobody keeps, and the fix
   *    gets reverted. An entry restored from a dump is not a replay for this
   *    purpose (D128): it asks, once, and is the session's own from then on.
   * 2. **A live grant.** The user approved this exact tool and arguments
   *    earlier in *this* call and the grant has uses left.
   * 3. **The user says so.** Anything else reaches the callback. No callback
   *    means no approval — this is the fail-closed path, and dropping it is
   *    mutation M22.
   *
   * What is gone is the fourth way: matching any key ever executed, forever.
   */
  private makeApprovalGate(
    userOnApproval: RunOptions["onApproval"],
    willReplayKey: (key: string) => boolean,
  ): NonNullable<RunOptions["onApproval"]> {
    return async (req) => {
      const key = this.keyFor(req);

      if (key !== null) {
        if (willReplayKey(key)) return true;

        const grant = this.grants.get(key);
        if (grant && grant.remaining > 0) {
          grant.remaining--;
          return true;
        }
      }

      const decision = userOnApproval ? await userOnApproval(req) : false;
      // A `"suspend"` is not consent — it defers the question to `resume()`,
      // which records the grant if the answer there is yes.
      if (decision === true) this.recordGrant(key, req.tool);
      return decision;
    };
  }

  /**
   * The cache key for an approval request, or `null` if the arguments cannot
   * be resolved.
   *
   * `null` is not an error path with a fallback — it means this call cannot be
   * matched against anything, so it can neither replay nor be covered by a
   * grant, and has to be asked about.
   */
  private keyFor(req: ApprovalRequest): string | null {
    const tool = this.sandboxOptions.registry.get(req.tool);
    if (!tool) return null;
    try {
      const resolved = resolveToolArgs(tool, req.args, req.kwargs as Record<string, unknown>);
      return cacheKey(req.tool, resolved);
    } catch {
      return null;
    }
  }

  /**
   * Record the grant an approval leaves behind.
   *
   * One use is spent by the call being approved right now, so a `grantUses` of
   * 1 — the default — stores nothing at all: the next identical call asks
   * again. That is the intended shape, not a degenerate case.
   */
  private recordGrant(key: string | null, tool: string): void {
    if (key === null) return;
    const remaining = this.grantUses - 1;
    if (remaining < 1) return;
    this.grants.set(key, { tool, remaining });
  }

  /**
   * The trace entries that were served from the replay cache, removed —
   * whatever the outcome of the run: the trace of an error, and of a
   * suspension, is this call's as much as the trace of a success is (A16,
   * D125).
   *
   * Positional, never by key (D154d). The caching registry logs one flag per
   * `execute` it saw, in dispatch order; the sandbox pushes one trace entry
   * per `execute` (a return, a throw, a `SubmitSignal`) plus one for each of
   * the two calls that never reach it — a resolution failure and a denial.
   * Walking the trace, the entries that reached the registry are paired with
   * the log in order and the served ones dropped. A key comparison dropped a
   * restored gated entry the user approved: its key matched the entry it
   * replaced, and it had executed (measured, P1). The surviving entries are
   * the sandbox's own objects, every field intact.
   */
  private withoutReplayedCalls(
    calls: ToolCallTrace[],
    invocations: readonly boolean[],
  ): ToolCallTrace[] {
    if (!invocations.includes(true)) return calls;

    const kept: ToolCallTrace[] = [];
    let next = 0;
    for (const call of calls) {
      if (!this.reachedRegistry(call)) {
        kept.push(call);
        continue;
      }
      // A trace shorter than the log (an abort mid-execute) pairs what it
      // has; a longer one cannot happen, and its tail would be kept.
      const served = next < invocations.length && invocations[next];
      next++;
      if (!served) kept.push(call);
    }
    return kept;
  }

  /**
   * Whether a trace entry stands for an `execute` the caching registry saw.
   *
   * The two entries that never got there: a denial — the gate refused, and
   * the sandbox says so with `approved: false` — and a resolution failure,
   * which the sandbox records with the arguments it could not resolve, so
   * resolving them again throws again. Resolution is deterministic on the
   * arguments, and the caching registry mirrors this registry's tools, so a
   * tool unknown here was never wrapped either.
   */
  private reachedRegistry(call: ToolCallTrace): boolean {
    if (call.approved === false) return false;
    const tool = this.sandboxOptions.registry.get(call.tool);
    if (!tool) return false;
    try {
      resolveToolArgs(tool, call.args, call.kwargs);
    } catch {
      return false;
    }
    return true;
  }
}
