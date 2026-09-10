import { resolve } from "node:path";
import { Session, type GrantSummary } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { createPiBridgeTools } from "./bridge.js";
import { createBuiltinTools } from "./builtins.js";
import {
  loadSavedTools,
  savedToolNames,
  createToolStoreTools,
  createPreambleManifestStore,
  resolvePreambleStoreDir,
  PreambleStoreInsideProjectError,
  PREAMBLE_STORE_DIR_VAR,
  TOOLSTORE_TOOL_NAMES,
  escapeNoticeName,
} from "./toolstore.js";
import type {
  ManifestChange,
  RefusedTool,
  UnreadableTool,
  UnacceptedReason,
  UnacceptedTool,
  PreambleFileIdentity,
  PreambleManifestStore,
  PreambleStatus,
  SavedToolsPreamble,
} from "./toolstore.js";
import { resolveToolArgs, type SandboxOptions } from "./sandbox.js";
import type {
  ApprovalRequest,
  ApprovalDecision,
  DiscardedSuspension,
  HostTool,
  RunErrorKind,
  RunResult,
  RunLimits,
  ToolCallTrace,
} from "./types.js";

// ── The trace (#46) ────────────────────────────────────────────────
//
// `run` and `resume` return the text the model reads, and until #46 that was
// all that left the runner: `RunResult.calls` — every ungated `read`, every
// gated call and how it was decided — was dropped on the floor, so a jailed
// read and a gated fetch could be believed but not seen. `runWithTrace` and
// `resumeWithTrace` return the same text plus the calls; the string API is
// `.text` of the same call (decision 11: additive and byte-identical). The
// trace is in dispatch order; its position relative to `stdout` is the
// sandbox's to report, per call, not this runner's to reconstruct.

/**
 * One host-tool call as the trace reports it: the sandbox's entry, plus the
 * bridged pi tool's own `details` where there are any (#46).
 *
 * Verbatim and therefore **sensitive**: `args` carry whatever the script
 * passed — a `write` body, a `bash` command line — exactly as the replay
 * cache does (decision 13). The library's caller is trusted host code; the
 * extension masks and cuts before anything reaches pi's session file.
 */
export interface TracedCall extends ToolCallTrace {
  /**
   * The built-in pi tool's own `details`, for the seven bridged tools:
   * truncation facts, `bash`'s full-output path, `edit`'s diff and patch.
   * `undefined` for a builtin or toolstore tool, for a bridged tool that
   * returns none (`write`), and for a call that failed.
   */
  details?: unknown;
}

/**
 * What a traced call ended in. The first three are the sandbox's; the other
 * three are `resume`'s early returns, each with no calls: the session does
 * not exist, it has nothing waiting, or a trust change during the pause
 * rebuilt it and the pending call was dropped (see `resume`).
 */
export type TraceStatus =
  | "ok"
  | "error"
  | "suspended"
  | "no-session"
  | "nothing-pending"
  | "trust-changed";

/** What `runWithTrace` / `resumeWithTrace` return: the text `run` / `resume` would, and the trace. */
export interface RunTrace {
  /** Exactly the string `run` / `resume` returns for the same call. */
  text: string;
  sessionId: string;
  status: TraceStatus;
  /** Present when `status` is `error`. */
  errorKind?: RunErrorKind;
  /**
   * The host-tool calls that **executed** in this call, in dispatch order —
   * for a resume, the whole run from its start. A call served from the replay
   * cache executed nothing and is not listed (see `alignTrace`).
   */
  calls: TracedCall[];
  /** The call waiting for approval, when `status` is `suspended`. */
  suspendedCall?: ApprovalRequest;
  /** A pending approval this run dropped, as `RunResult` reports it (#129). */
  discardedSuspension?: DiscardedSuspension;
}

/** One real host-tool execution, as the session's recorder saw it. */
interface ExecutionRecord {
  tool: string;
  /** The tool name and the resolved arguments — what the replay cache keys on too. */
  key: string;
  ok: boolean;
  /** The bridged tool's `details`, handed over by `BridgeOptions.onDetails`. */
  details?: unknown;
}

/**
 * The recorder every host tool in a session reports into.
 *
 * It sits *inside* `Session`'s replay cache, so a call served from the cache
 * never reaches it: the records are exactly the executions. `Session` strips
 * replayed entries from every outcome (D125), but its trace carries no
 * `details` — the bridged tool's own report travels this way, matched to the
 * execution it came from.
 */
interface ExecutionSink {
  records: ExecutionRecord[];
  /** The bridge's `details` for the execution in flight, consumed by `recordExecutions`. */
  pendingDetails?: unknown;
}

/** The key both sides of the alignment compute: tool name plus resolved arguments. */
function executionKey(tool: string, resolved: Record<string, unknown>): string {
  // A Monty int past 2^53 arrives as a BigInt, which JSON refuses; the replay
  // cache fails such a call before it executes, so it can only ever be on the
  // trace side, and it is spelled out rather than thrown on.
  const json = JSON.stringify(resolved, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
  return `${tool}::${json}`;
}

/** Wrap `tool` so every real execution — success or throw — is recorded in `sink`. */
function recordExecutions(tool: HostTool, sink: ExecutionSink): HostTool {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(args) {
      const key = executionKey(tool.name, args);
      sink.pendingDetails = undefined;
      try {
        const result = await execute(args);
        sink.records.push({ tool: tool.name, key, ok: true, details: sink.pendingDetails });
        return result;
      } catch (err) {
        sink.records.push({ tool: tool.name, key, ok: false });
        throw err;
      } finally {
        sink.pendingDetails = undefined;
      }
    },
  };
}

/**
 * The calls that executed, aligned with the recorder — per tool, from the end.
 *
 * A trace entry is real when a record with the same tool, outcome and key
 * stands at the cursor; an `ok: true` entry with no such record was served
 * from the replay cache and is dropped. An `ok: false` entry is always kept:
 * the cache stores successes only, so a failure never replays — it consumes
 * the cursor's record when that is a failure too, and a resolution failure
 * (no record, since it never reached `execute`) consumes nothing. The key is
 * not consulted for failures: the sandbox records a resolution failure with
 * arguments it could not resolve, and a failure's record carries no details
 * to misplace anyway.
 *
 * From the end because replayed entries come first: the transcript replays
 * the earlier snippets before the new code runs, and the replay cursor never
 * advances on a mismatch. This is exact under deterministic replay and
 * degrades, on a non-deterministic transcript, to a swap of `details`
 * between two calls with identical arguments. (`Session.withoutReplayedCalls`
 * has already dropped the served entries, positionally, before the calls
 * reach here; this alignment is about the details.)
 */
function alignTrace(
  calls: readonly ToolCallTrace[],
  records: readonly ExecutionRecord[],
  registry: ToolRegistry,
): TracedCall[] {
  const byTool = new Map<string, ExecutionRecord[]>();
  for (const record of records) {
    const list = byTool.get(record.tool) ?? [];
    list.push(record);
    byTool.set(record.tool, list);
  }
  const cursor = new Map<string, number>();
  const kept: Array<TracedCall | undefined> = new Array(calls.length);

  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    const list = byTool.get(call.tool) ?? [];
    const index = cursor.get(call.tool) ?? list.length - 1;
    const record = index >= 0 ? list[index] : undefined;

    if (!call.ok) {
      if (record?.ok === false) cursor.set(call.tool, index - 1);
      kept[i] = { ...call };
      continue;
    }
    // An ok entry resolved its arguments once already, in the sandbox, so the
    // same resolution cannot throw here.
    const tool = registry.get(call.tool);
    const key = tool ? executionKey(call.tool, resolveToolArgs(tool, call.args, call.kwargs)) : "";
    if (record?.ok && record.key === key) {
      cursor.set(call.tool, index - 1);
      kept[i] = record.details === undefined ? { ...call } : { ...call, details: record.details };
    }
  }
  return kept.filter((call): call is TracedCall => call !== undefined);
}

// ── Outcomes ───────────────────────────────────────────────────────
//
// `abandon` and `reset` used to answer `boolean` and `GrantSummary[]`, which
// both fold two different states into one: "no such session" and "the session
// is there and has nothing pending" are indistinguishable, so the extension
// could only ever print one sentence for both. The model acts differently on
// each — one means run some code, the other means the approval it was waiting
// for is already gone — so each state gets its own name here and its own
// sentence at the call site (#48).

/** What `ReplRunner.abandon` found when it went looking for a suspension. */
export type AbandonOutcome = "abandoned" | "nothing-pending" | "no-session";

/** What `ReplRunner.reset` cleared, and whether there was anything to clear. */
export interface ResetOutcome {
  /** `false` when the session was never created — nothing was reset. */
  existed: boolean;
  /** Approval grants live at the moment of the reset. Empty for an unknown session. */
  revoked: GrantSummary[];
}

/**
 * What `ReplRunner.acceptPreamble` did (#198).
 *
 * - `accepted`: the manifest now records the sha256 of every file that loads
 *   — `accepted` names them, in load order. Live sessions keep the preamble
 *   they were built with; a new `sessionId` loads the accepted set.
 * - `untrusted`: nothing was read. The trust gate comes first: accepting
 *   files the user never agreed to run would be the gate's own bypass.
 * - `refused`: the preamble shadows a host tool (#54) and cannot be accepted
 *   in part; the manifest is untouched.
 * - `store-unavailable`: the manifest could not be written — the store is
 *   inside the project, or unwritable — and nothing changed.
 * - `unreadable`: `.pi/code-tools` exists but could not be listed (`EACCES`,
 *   `EIO`), so nothing is known about what is there. Nothing was accepted
 *   and the manifest is untouched: an empty set written here would erase the
 *   acceptance record over a transient permission error, and report success
 *   for a directory that was never seen.
 */
export type AcceptPreambleOutcome =
  | { status: "accepted"; accepted: string[]; manifestPath: string }
  | { status: "untrusted" }
  | { status: "refused"; refused: RefusedTool[] }
  | { status: "store-unavailable"; reason: string }
  | { status: "unreadable"; reason: string };

// ── Project trust ──────────────────────────────────────────────────

/** Construction-time options for {@link ReplRunner}. */
export interface ReplRunnerOptions {
  /**
   * Reads the project's trust decision, live, at every call.
   *
   * `.pi/code-tools/*.py` is executed before user code on every run, with
   * full host-tool access and no approval, and `.pi/` travels with a clone —
   * so cloning a hostile repository and asking anything that touches `repl`
   * used to be enough to run its code (#53). This is the gate.
   *
   * A function rather than a boolean because the decision can change while pi
   * is running, and a snapshot taken at construction would keep executing code
   * the user has since said no to.
   *
   * **Defaults to untrusted.** A caller who has no trust decision to offer has
   * not made one, and the failure mode of guessing wrong in the other
   * direction is arbitrary code execution.
   */
  isProjectTrusted?: () => boolean;

  /**
   * Maximum number of live sessions in the pool.
   *
   * When a new session would exceed the cap, the least-recently-used session
   * is evicted — except one with a pending approval, which is never evicted.
   * Defaults to `REPL_MAX_SESSIONS` (a positive integer) or 32; an explicit
   * option wins over both. Non-positive values fall back the same way (#59).
   */
  maxSessions?: number;

  /**
   * Where the accepted-set manifests live (#198).
   *
   * A trusted project's saved tools are hashed when they are first loaded,
   * and the manifest is what every later session build compares against: a
   * file added or rewritten since — pulled in by a compromised upstream,
   * say — is withheld until the set is accepted again. The manifest must
   * therefore live **outside** the project: `.pi/` is what the attacker
   * writes. A store that resolves inside the project is refused, and the
   * session fails closed.
   *
   * Defaults to `REPL_PREAMBLE_STORE_DIR`, then `$XDG_STATE_HOME/repl-simple`,
   * then `~/.local/state/repl-simple`; an explicit option wins over all three.
   */
  preambleStoreDir?: string;

  /**
   * Told when the store resolves inside the project, at each point that
   * refusal costs something: a session build that withholds saved tools for
   * it, a `save_tool` or `delete_tool` that cannot record, an
   * `acceptPreamble()` that cannot write. `store` and `project` are the two
   * paths compared.
   *
   * The refusal is unchanged and the model is still told in the tool output;
   * this is for the host to tell the user, the only one who can move the
   * store. Never called for an untrusted project, which never touches the
   * store, nor for a store unusable for any other reason. Called every time —
   * deduplicating is the host's business.
   */
  onPreambleStoreInsideProject?: (where: { store: string; project: string }) => void;
}

/**
 * The mutable half of a session's `PreambleStatus` (#198 carry-over).
 *
 * The tools answer from the view the session was built with; these two
 * collections are the same objects the view holds, kept here so the agent's
 * own `save_tool` / `delete_tool` and `acceptPreamble()` can move a name from
 * "not accepted" to "accepted since" in place, instead of the list repeating
 * a creation-time answer the manifest no longer supports.
 */
interface PreambleView {
  unaccepted: Map<string, UnacceptedReason>;
  acceptedSince: Set<string>;
}

/** A live session, plus what the preamble decision for it was. */
interface LiveSession {
  session: Session;
  /** The registry the session runs on — the trace resolves argument keys against it. */
  registry: ToolRegistry;
  /** The recorder of real host-tool executions (#46). */
  sink: ExecutionSink;
  /** The session's preamble view, for in-place refresh. */
  view: PreambleView;
  /** The trust value this session's preamble was loaded (or withheld) under. */
  trusted: boolean;
  /** Whether that decision actually put saved code in front of every run. */
  hasPreamble: boolean;
  /**
   * How many `run`/`resume` calls are executing right now.
   *
   * A count, not a flag, so nested calls cannot reset each other. Eviction
   * skips busy sessions: a session whose run is mid-flight — with an approval
   * dialog open, say — is not `isSuspended()` yet, and evicting it would
   * orphan the answer the user was asked to give (#59).
   */
  busy: number;
  /**
   * Whether the one-shot `[trust changed]` notice has been delivered to this
   * session. Two concurrent discarders of the same rebuilt session must not
   * deliver it twice (#59).
   */
  trustChangeNoticed: boolean;
  /**
   * A one-shot notice about the preamble, prepended to the next result.
   *
   * Cleared once delivered. It is written at the moment the environment was
   * decided — session creation — because that is the only moment it is news.
   */
  notice?: string;
}

// ── Pool cap ───────────────────────────────────────────────────

/**
 * Default pool cap.
 *
 * A session retains every snippet it ever ran plus its full call cache, so
 * the cap is the only thing standing between a model that mints session ids
 * and unbounded memory. 32 follows the preamble's `DEFAULT_PREAMBLE_LIMITS`
 * precedent: a session is strictly heavier than a preamble file (#59).
 */
const DEFAULT_MAX_SESSIONS = 32;

/** Positive integer or fallback — the same rule `src/pool.ts` applies. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The pool cap: explicit option > `REPL_MAX_SESSIONS` env > default. */
function sessionCap(explicit: number | undefined): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit > 0) return explicit;
  return envInt("REPL_MAX_SESSIONS", DEFAULT_MAX_SESSIONS);
}

// ── ReplRunner ─────────────────────────────────────────────────────

/**
 * Manages persistent REPL sessions.
 *
 * Each session (keyed by `sessionId`) wraps a `Session` with a composed
 * tool registry (bridge + builtins) and, **in a trusted project only**, the
 * auto-loaded toolstore preamble. No RLM tools — this is a direct REPL, not an
 * RLM loop.
 */
export class ReplRunner {
  private sessions = new Map<string, LiveSession>();
  /**
   * Creations in flight, keyed by session id.
   *
   * The promise is stored *before* awaiting anything, so a concurrent caller
   * joins the same creation instead of starting a second. On success the
   * promise inserts the session and removes itself; on rejection it removes
   * itself and rethrows — one failed creation must not poison the id for
   * every later caller, which is the same contract `getSandboxPool` pins for
   * the worker pool (#59).
   */
  private inflight = new Map<string, Promise<LiveSession>>();
  private cwd: string;
  private isProjectTrusted: () => boolean;
  private maxSessions: number;
  /** This project's accepted-set manifest (#198). Never touched while the project is untrusted. */
  private manifest: PreambleManifestStore;
  /** `onPreambleStoreInsideProject` with this runner's two paths bound; a no-op when unset. */
  private reportStoreInsideProject: () => void;

  constructor(cwd: string, options: ReplRunnerOptions = {}) {
    this.cwd = cwd;
    this.isProjectTrusted = options.isProjectTrusted ?? (() => false);
    this.maxSessions = sessionCap(options.maxSessions);
    const storeDir = resolvePreambleStoreDir(options.preambleStoreDir);
    this.reportStoreInsideProject = () =>
      options.onPreambleStoreInsideProject?.({ store: resolve(storeDir), project: resolve(cwd) });
    // Every write goes through here — `acceptPreamble()`, a first load's
    // implicit accept, the tools' updates — so a store refused for being
    // inside the project is reported in one place. A read is reported by the
    // session build, and only when it withheld something.
    const store = createPreambleManifestStore(storeDir, cwd);
    this.manifest = {
      ...store,
      write: (files) => this.reportingInsideProject(store.write(files)),
      update: (mutate) => this.reportingInsideProject(store.update(mutate)),
    };
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Execute Python code in a named session.
   *
   * Creates the session on first use. The `onApproval` callback is
   * wired to `RunOptions.onApproval` and handles gated tool calls
   * (bash, edit, write). Session auto-approves cached calls on replay.
   *
   * `signal` is the caller's abort — Pi's turn signal, when the caller is the
   * extension. Passing it is what makes Escape mean something: Pi checks
   * `signal.aborted` only *between* tool calls and never cancels one that is
   * running, so a tool that ignores its signal is a tool the user cannot stop
   * (#49). The sandbox honours it and returns an `aborted` result.
   *
   * `limits` is forwarded verbatim to the sandbox (`RunLimits` or
   * `"unbounded"`); omitted means the sandbox's fail-safe defaults apply via
   * `limitsConfig()`. This runner never clamps — clamping is the model
   * boundary's job (D2).
   *
   * An aborted run is dropped from the transcript — later runs do not see its
   * variable bindings, as if it never ran. Host-tool side effects that
   * executed before the abort (a file written, a `bash` command run) persist;
   * they are not rolled back (D4).
   *
   * The text of {@link runWithTrace}, and nothing else: the same call, so the
   * two cannot differ by a byte (#46).
   */
  async run(
    code: string,
    sessionId = "default",
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal?: AbortSignal,
    limits?: RunLimits | "unbounded",
  ): Promise<string> {
    return (await this.runWithTrace(code, sessionId, onApproval, signal, limits)).text;
  }

  /**
   * {@link run}, plus the trace: every host-tool call that executed, with its
   * arguments, duration, outcome and approval status, and the bridged tool's
   * own details (#46). Same parameters, same text. See {@link RunTrace} for
   * what the calls carry, and why they are the caller's to redact.
   */
  async runWithTrace(
    code: string,
    sessionId = "default",
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal?: AbortSignal,
    limits?: RunLimits | "unbounded",
  ): Promise<RunTrace> {
    const live = await this.getOrCreateSession(sessionId);
    live.busy++;
    // A run is a fresh call. Records a suspension left behind are not this
    // run's — `Session.run` drops that suspension anyway — unless another
    // call is mid-flight on the session, whose records must not be pulled
    // out from under it (calls on one session are sequential in practice:
    // the extension serialises them, and #59 documents the library's stance).
    if (live.busy === 1) live.sink.records = [];
    try {
      const result = await live.session.run(code, { onApproval, signal, limits });
      return this.traceOf(live, sessionId, result);
    } finally {
      live.busy--;
    }
  }

  /**
   * Resume a suspended session.
   *
   * Calls `onApproval` for the pending gated call. If the resumed
   * execution suspends again (nested gated calls), returns a
   * suspended message so the LLM can call `repl_resume` again.
   *
   * `signal` carries the same meaning as in `run`.
   *
   * `limits` carries the same meaning as in `run`: forwarded verbatim to the
   * sandbox, never clamped here (D2).
   *
   * Never throws: the model decides when to call `repl_resume`, so every state
   * it can believe it is in — no such session, session with nothing pending —
   * gets a sentence back rather than an exception (#48).
   *
   * The text of {@link resumeWithTrace}, and nothing else (#46).
   */
  async resume(
    sessionId: string,
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal?: AbortSignal,
    limits?: RunLimits | "unbounded",
  ): Promise<string> {
    return (await this.resumeWithTrace(sessionId, onApproval, signal, limits)).text;
  }

  /**
   * {@link resume}, plus the trace (#46). A resumed result reports the whole
   * run — the calls before the gate and after it — because that is what the
   * sandbox accumulates. The three early returns are statuses of their own
   * with no calls; see {@link TraceStatus}.
   */
  async resumeWithTrace(
    sessionId: string,
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal?: AbortSignal,
    limits?: RunLimits | "unbounded",
  ): Promise<RunTrace> {
    const noSession = (): RunTrace => ({
      text: `No session '${sessionId}' exists. Run some code first.`,
      sessionId,
      status: "no-session",
      calls: [],
    });
    const live = this.sessions.get(sessionId);
    if (!live) return noSession();
    this.touch(sessionId, live);
    // Resuming replays the whole transcript, preamble included, so a trust
    // decision made during the pause has to be honoured here too — otherwise
    // revoking trust and answering the pending dialog runs the withdrawn code
    // anyway.
    if (await this.trustChangeDiscards(sessionId, live)) {
      return {
        text: trustChangedMessage(sessionId, live.session.isSuspended()),
        sessionId,
        status: "trust-changed",
        calls: [],
      };
    }
    // The trust check awaited; the entry may have been evicted in the gap
    // (D3 parity with `run`): a resumed call on a session the pool no longer
    // holds must not report a result for it.
    if (this.sessions.get(sessionId) !== live) return noSession();
    if (!live.session.isSuspended()) {
      return {
        text:
          `Session '${sessionId}' has nothing waiting for approval. ` +
          `Nothing was resumed — run code with repl to continue.`,
        sessionId,
        status: "nothing-pending",
        calls: [],
      };
    }
    live.busy++;
    try {
      const result = await live.session.resume({ onApproval, signal, limits });
      return this.traceOf(live, sessionId, result);
    } finally {
      live.busy--;
    }
  }

  /**
   * Discard a pending suspension without approving or denying.
   *
   * @returns which of the three states the session was in — see
   *          {@link AbandonOutcome}.
   */
  abandon(sessionId: string): AbandonOutcome {
    const live = this.sessions.get(sessionId);
    if (!live) return "no-session";
    this.touch(sessionId, live);
    if (!live.session.abandon()) return "nothing-pending";
    // The dropped call's run is over; its records have nothing left to align.
    live.sink.records = [];
    return "abandoned";
  }

  /**
   * Clear all state in a session, and remove it from the pool.
   *
   * The entry is evicted, not hollowed: a cleared-but-kept session would keep
   * answering "nothing waiting" on `resume` — a session the model believes is
   * still there. The next `run` on the id recreates it fresh (#59).
   *
   * @returns whether the session existed, and the approval grants that were
   *          live when the reset happened — empty for an unknown session, and
   *          empty in the usual case where no call is paused at a suspension.
   */
  reset(sessionId: string): ResetOutcome {
    const live = this.sessions.get(sessionId);
    if (!live) return { existed: false, revoked: [] };
    const revoked = live.session.reset();
    this.sessions.delete(sessionId);
    return { existed: true, revoked };
  }

  /**
   * The number of live sessions in the pool.
   *
   * A diagnostic for hosts and tests, not a model-facing tool: the issue's
   * definition of done demands eviction be asserted on the map size, and a
   * size that cannot be observed cannot be asserted. Creations still in
   * flight are not counted — they are not sessions yet.
   */
  liveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Accept the saved tools as they are on disk now (#198).
   *
   * Re-hashes every file that loads — with the same loader and the same
   * host-tool names a session build uses, so what is accepted is exactly
   * what would run — and writes the manifest. This is the explicit half of
   * the accepted-set model: the first trusted load accepts implicitly, and
   * everything that changes afterwards waits for this call. The pi command
   * that exposes it is `/repl-accept-preamble` (`extensions/repl-extension.ts`);
   * `save_tool` is the in-band path, its approval dialog being the consent.
   *
   * Live sessions are not rebuilt: they keep the preamble they were built
   * with, exactly as they keep a deleted tool, and the notice that named the
   * withheld files says to run `repl` with a new `sessionId`.
   */
  async acceptPreamble(): Promise<AcceptPreambleOutcome> {
    if (!this.isProjectTrusted()) return { status: "untrusted" };
    const load = await loadSavedTools({
      root: this.cwd,
      hostToolNames: this.buildRegistry().hostToolNames,
    });
    // A directory that cannot be listed — or that resolves outside the
    // project — is not an empty one. Accepting "nothing" here would be
    // accepting a set the loader never saw (#198).
    if (load.escaped !== undefined) return { status: "unreadable", reason: load.escaped };
    if (load.unlistable !== undefined) return { status: "unreadable", reason: load.unlistable };
    if (load.refused.length > 0) return { status: "refused", refused: load.refused };
    let manifestPath: string;
    try {
      manifestPath = await this.manifest.write(hashesOf(load.loadedIdentity));
    } catch (err) {
      return { status: "store-unavailable", reason: (err as Error).message };
    }
    // Live sessions keep their preamble; their tools stop calling the files
    // "not accepted" (#198 carry-over). Only names this accept covers move.
    const accepted = new Set(load.loaded);
    for (const live of this.sessions.values()) {
      for (const name of [...live.view.unaccepted.keys()]) {
        if (accepted.has(name)) applyManifestChange(live.view, { name, change: "accepted" });
      }
    }
    return { status: "accepted", accepted: load.loaded, manifestPath };
  }

  // ── Private helpers ─────────────────────────────────────────

  /** `operation`, reporting a store refused for being inside the project on its way out. */
  private async reportingInsideProject<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (err) {
      if (err instanceof PreambleStoreInsideProjectError) this.reportStoreInsideProject();
      throw err;
    }
  }

  /**
   * The trace for a finished `run` / `resume` call, and the recorder's next
   * state: cleared once the call is over, kept across a suspension so the
   * resumed result — which reports the whole run — aligns from its start.
   */
  private traceOf(live: LiveSession, sessionId: string, result: RunResult): RunTrace {
    const calls = alignTrace(result.calls, live.sink.records, live.registry);
    if (result.status !== "suspended") live.sink.records = [];
    const trace: RunTrace = {
      text: withNotice(live, formatResult(result, sessionId)),
      sessionId,
      status: result.status,
      calls,
    };
    if (result.status === "error") trace.errorKind = result.errorKind;
    if (result.status === "suspended") trace.suspendedCall = result.suspendedCall;
    if (result.discardedSuspension) trace.discardedSuspension = result.discardedSuspension;
    return trace;
  }

  /**
   * The session for `sessionId`, built under the trust decision in force now.
   *
   * A session whose trust value no longer matches is **discarded, not
   * reused**. The preamble is not something a session merely loaded once: it
   * is prepended to the transcript on every `run()`, so a session created
   * while trusted goes on executing that code for as long as it lives. Keeping
   * it would make the gate apply only to sessions that do not exist yet.
   *
   * The cost is that a trust change clears variables, and it is charged in
   * both directions so the rule stays one sentence rather than two.
   */
  private async getOrCreateSession(sessionId: string): Promise<LiveSession> {
    let trustChanged = false;
    for (;;) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        this.touch(sessionId, existing);
        if (!(await this.trustChangeDiscards(sessionId, existing))) {
          // The trust check awaited, and awaits are where another caller
          // acts: the session may have been evicted or rebuilt in the gap.
          // Hand out only the object the map still holds.
          if (this.sessions.get(sessionId) !== existing) continue;
          if (trustChanged) {
            this.attachTrustChangeNotice(sessionId, existing);
            trustChanged = false;
          }
          return existing;
        }
        // trustChangeDiscards deleted the entry. The replacement must say so
        // — but which session replaces it is decided by whoever lands the
        // shared flight, so the notice is attached after landing, not baked
        // into the creation (the `rebuilt` argument used to be, and a racy
        // joiner could start the replacement flight without it).
        trustChanged = true;
      }
      // Await the flight, then re-enter the loop: the landed entry must pass
      // through the same trust revalidation as a pre-existing one. Returning
      // it directly would hand a session built under a now-revoked trust
      // decision to its first run — the stale snapshot the live callback
      // exists to prevent. A rejected creation still propagates out.
      await this.joinOrStartCreation(sessionId);
    }
  }

  /**
   * Deliver the one-shot `[trust changed]` notice to a rebuilt session.
   *
   * Prepended so it stays the first thing the model reads, in front of any
   * preamble notice the rebuild produced. Guarded per session: two callers
   * that both observed the discard deliver it once (#59).
   */
  private attachTrustChangeNotice(sessionId: string, live: LiveSession): void {
    if (live.trustChangeNoticed) return;
    live.trustChangeNoticed = true;
    const message = trustChangedMessage(sessionId, false);
    live.notice = live.notice === undefined ? message : `${message}\n\n${live.notice}`;
  }

  /**
   * Join the in-flight creation for `sessionId`, or start one.
   */
  private joinOrStartCreation(sessionId: string): Promise<LiveSession> {
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const promise = this.createSession(this.isProjectTrusted())
      .then((live) => {
        this.inflight.delete(sessionId);
        this.insert(sessionId, live);
        return live;
      })
      .catch((err: unknown) => {
        this.inflight.delete(sessionId);
        throw err;
      });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  /**
   * Mark a live session as most recently used.
   *
   * Map iteration order is insertion order, so delete + set moves the entry
   * to the tail: the head is "oldest", the tail "most recent". Every
   * retrieval of a live session — `run`, `resume`, `abandon` — touches.
   * `reset` does not: it removes the entry outright (#59).
   */
  private touch(sessionId: string, live: LiveSession): void {
    if (this.sessions.get(sessionId) !== live) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, live);
  }

  /**
   * Insert a finished creation, evicting past the cap.
   *
   * Eviction takes the oldest session that is **neither suspended nor
   * mid-call**, and never the one just inserted. A suspended session is a
   * call the user was asked to approve, and a busy one may be about to
   * suspend — evicting either would lose a call with the model never told,
   * so the pool exceeds its cap rather than discard one. The decision is the
   * one #59 demands be recorded: refuse to evict, never report-and-drop.
   *
   * The over-cap state is self-limiting — every suspension demands user
   * attention, and the protection ends the moment the session is no longer
   * suspended or busy (resumed, abandoned, or overwritten).
   */
  private insert(sessionId: string, live: LiveSession): void {
    this.sessions.set(sessionId, live);
    if (this.sessions.size <= this.maxSessions) return;

    for (const [key, entry] of this.sessions) {
      if (key === sessionId) continue;
      if (entry.session.isSuspended()) continue;
      if (entry.busy > 0) continue;
      this.sessions.delete(key);
      if (this.sessions.size <= this.maxSessions) return;
    }
  }

  /**
   * Bring a live session into line with the trust decision in force now.
   *
   * A session is discarded only when the change alters **what runs**: losing
   * trust matters when saved code is being prepended to every run, gaining it
   * matters when there is saved code to gain. A trust decision that changes
   * neither is recorded and costs the user nothing — wiping variables for a
   * preamble that is empty either way would be a wipe with no security in it.
   *
   * @returns whether the session was dropped and must be rebuilt.
   */
  private async trustChangeDiscards(sessionId: string, live: LiveSession): Promise<boolean> {
    const trusted = this.isProjectTrusted();
    if (live.trusted === trusted) return false;

    const changesPreamble = trusted
      ? (await savedToolNames({ root: this.cwd })).length > 0
      : live.hasPreamble;

    if (!changesPreamble) {
      live.trusted = trusted;
      return false;
    }

    // D3 parity on the delete path: a stale checker whose await resolved late
    // must not destroy a session a concurrent caller has since rebuilt under
    // the current decision.
    if (this.sessions.get(sessionId) === live) this.sessions.delete(sessionId);
    return true;
  }

  /**
   * The registry a session starts with, and every host-tool name it will
   * have.
   *
   * The shadowing gates (#54 load, #56 write) must see every host-tool name
   * the session will have — including the toolstore's own, which are not in
   * the registry yet: a preamble `def save_tool` would shadow the registered
   * tool exactly like a bridge or builtin name (#57). `acceptPreamble` uses
   * the same list, so what it accepts is what a session build would run.
   */
  private buildRegistry(sink?: ExecutionSink): { registry: ToolRegistry; hostToolNames: string[] } {
    // With a recorder, every tool reports its executions to it and the
    // bridge hands over pi's details for the execution in flight (#46).
    const bridgeTools = createPiBridgeTools(this.cwd, {
      gateMutating: true,
      onDetails: sink
        ? (event) => {
            sink.pendingDetails = event.details;
          }
        : undefined,
    });
    const builtinTools = createBuiltinTools({ root: this.cwd });
    const tools = [...bridgeTools, ...builtinTools].map((tool) =>
      sink ? recordExecutions(tool, sink) : tool,
    );
    const registry = new ToolRegistry(tools);
    const hostToolNames = [...registry.list().map((tool) => tool.name), ...TOOLSTORE_TOOL_NAMES];
    return { registry, hostToolNames };
  }

  /**
   * Load a trusted project's preamble against its accepted set (#198).
   *
   * Three manifest states, one load:
   * - **absent** — the first load since trust. The trust dialog covered the
   *   files present now, so everything loads and the manifest is written,
   *   empty set included: a project trusted before it had any saved tools
   *   must still catch the first one that appears. A write that fails is
   *   not shrugged off — an acceptance that cannot be recorded would make
   *   every later load "first-ever", and first-ever accepts — so the load
   *   is redone with an empty accepted set, and everything is withheld.
   * - **ok** — files the set does not cover are withheld and named; accepted
   *   names that are in no bucket at all are reported as removed, notice
   *   only.
   * - **unavailable** — unreadable, malformed, inside the project: fail
   *   closed, withhold everything that would have loaded, say why.
   *
   * Two things come before any of that. A refused preamble (#54) is the
   * whole story: nothing loads, nothing is accepted, and the refusal notice
   * says why. And a tools directory that cannot be listed loads nothing and
   * **records nothing**: it is not an empty set — an implicit accept of a set
   * the loader never saw would write `{}` over a real acceptance record on a
   * transient EACCES, and a comparison against it would call every accepted
   * file removed — so the manifest is left exactly as it was, and the model
   * is told the directory could not be read.
   *
   * The unverified notice is delivered only when something was actually
   * withheld: a project with nothing to load has nothing to be told.
   */
  private async loadVerifiedPreamble(
    hostToolNames: readonly string[],
  ): Promise<{ load: SavedToolsPreamble; notices: string[] }> {
    const root = this.cwd;
    const read = await this.manifest.read();

    // What the loader compares against: the accepted set; nothing at all
    // when the manifest cannot be trusted (everything is withheld); no
    // comparison on a first-ever load (everything is accepted).
    let accepted: ReadonlyMap<string, string> | undefined;
    if (read.status === "ok") accepted = read.files;
    else if (read.status === "unavailable") accepted = new Map();
    const load = await loadSavedTools({ root, hostToolNames, accepted });

    // Nothing was seen, so nothing is compared or recorded — and a store
    // that could not be used is reported alongside rather than after the
    // directory becomes readable (#198 carry-over): one diagnostic each.
    if (load.escaped !== undefined || load.unlistable !== undefined) {
      const notices = [
        load.escaped !== undefined
          ? escapedNotice(load.escaped)
          : unlistableNotice(load.unlistable ?? ""),
      ];
      if (read.status === "unavailable") notices.push(storeUnavailableNotice(read.reason));
      return { load, notices };
    }
    if (load.refused.length > 0) return { load, notices: [] };

    if (read.status === "unavailable") {
      // The host hears of it only when it cost the user something.
      if (read.kind === "inside-project" && load.unaccepted.length > 0) {
        this.reportStoreInsideProject();
      }
      return { load, notices: unverifiedNotices(read.reason, load.unaccepted) };
    }

    if (read.status === "absent") {
      try {
        await this.manifest.write(hashesOf(load.loadedIdentity));
        return { load, notices: [] };
      } catch (err) {
        const withheld = await loadSavedTools({ root, hostToolNames, accepted: new Map() });
        return {
          load: withheld,
          notices: unverifiedNotices((err as Error).message, withheld.unaccepted),
        };
      }
    }

    const removed = removedSince(read.files, load);
    const changed = load.unaccepted.length > 0 || removed.length > 0;
    return { load, notices: changed ? [changedNotice(load.unaccepted, removed)] : [] };
  }

  private async createSession(trusted: boolean): Promise<LiveSession> {
    const sink: ExecutionSink = { records: [] };
    const { registry, hostToolNames } = this.buildRegistry(sink);
    const sandboxOpts: SandboxOptions = { registry };

    const notices: string[] = [];

    // The two collections the tools and the runner keep current in place.
    const view: PreambleView = { unaccepted: new Map(), acceptedSince: new Set() };

    let preamble = "";
    let preambleStatus: PreambleStatus;
    if (trusted) {
      // The reserved names are the live registry's — never a hardcoded list.
      // A file that binds one of them refuses the whole preamble (#54), and
      // the loader reports it with the offending file and symbols. The
      // accepted-set check (#198) rides on the same load.
      const verified = await this.loadVerifiedPreamble(hostToolNames);
      const load = verified.load;
      preamble = load.preamble;
      // The tool names, for the honest tool answers: `refused`/`unreadable`
      // carry `.py` file names, the status sets carry the names the tools and
      // the model use.
      for (const u of load.unaccepted) view.unaccepted.set(u.name, u.reason);
      preambleStatus = {
        trusted: true,
        loaded: new Set(load.loaded),
        withheld: new Set(),
        skipped: new Set(load.skipped),
        refused: new Set(load.refused.map((r) => r.file.slice(0, -3))),
        unreadable: new Set(load.unreadable.map((u) => u.file.slice(0, -3))),
        identity: load.loadedIdentity,
        unaccepted: view.unaccepted,
        acceptedSince: view.acceptedSince,
      };
      // The accepted-set notices first: they are the security news.
      notices.push(...verified.notices);
      if (load.refused.length > 0) notices.push(refusalNotice(load.refused));
      if (load.unreadable.length > 0) notices.push(unreadableNotice(load.unreadable));
      if (load.skipped.length > 0) notices.push(limitNotice(load.skipped));
    } else {
      // Names only. Reading the listing is not reading the files, and the
      // model needs the names or it will call a tool that is not defined and
      // get a NameError it cannot explain. The manifest is not consulted
      // either: an untrusted project never touches the store.
      const withheld = await savedToolNames({ root: this.cwd });
      preambleStatus = {
        trusted: false,
        loaded: new Set(),
        withheld: new Set(withheld),
        skipped: new Set(),
        refused: new Set(),
        unreadable: new Set(),
        unaccepted: view.unaccepted,
        acceptedSince: view.acceptedSince,
      };
      if (withheld.length > 0) notices.push(untrustedNotice(withheld));
    }

    // Registered in every session, trusted or untrusted (#57): the tools
    // answer from the status above — listing what actually loaded, refusing
    // reads the project never trusted — and the write-time shadowing check
    // (#56) finally sees the live registry's names. The live trust callback
    // keeps the read gate honest across trust flips that keep the session,
    // and the manifest lets the agent's own writes keep the accepted set
    // current (#198) — and the view with it. Recorded like every other tool,
    // so a replayed `list_saved_tools` is not a listed one (#46).
    for (const tool of createToolStoreTools({
      root: this.cwd,
      hostToolNames,
      preambleStatus,
      isTrusted: this.isProjectTrusted,
      manifest: this.manifest,
      onManifestChange: (change) => applyManifestChange(view, change),
    })) {
      registry.add(recordExecutions(tool, sink));
    }

    return {
      session: new Session(sandboxOpts, preamble || undefined),
      registry,
      sink,
      view,
      trusted,
      hasPreamble: preamble !== "",
      busy: 0,
      trustChangeNoticed: false,
      notice: notices.length > 0 ? notices.join("\n\n") : undefined,
    };
  }
}

/**
 * Move a name between the view's buckets after the manifest changed (#198
 * carry-over): accepted — by the agent's own `save_tool`, or by
 * `acceptPreamble()` — leaves "not accepted" for "accepted since"; removed
 * leaves both, since the file is gone and the list no longer shows it.
 */
function applyManifestChange(view: PreambleView, change: ManifestChange): void {
  view.unaccepted.delete(change.name);
  if (change.change === "accepted") view.acceptedSince.add(change.name);
  else view.acceptedSince.delete(change.name);
}

// ── Preamble notices ─────────────────────────────────────────────
//
// Silence about a withheld preamble trades one bug for another: the tools are
// still on disk and still listed by `list_saved_tools`, so a model that is not
// told will call one and get a bare NameError (#53).

/** What the model is told when project trust withheld the saved tools. */
function untrustedNotice(withheld: string[]): string {
  // Names come from readdir — escape before rendering, as every notice does.
  const names = withheld.map(escapeNoticeName).join(", ");
  return (
    `[preamble withheld] ${withheld.length} saved tool(s) in .pi/code-tools were not loaded ` +
    `because this project is not trusted: ${names}. ` +
    `They are not defined in this session — calling one raises NameError. ` +
    `list_saved_tools() shows what is on disk, and read_tool() refuses while the project ` +
    `is untrusted. Trust the project in pi to load them, or paste the code you need.`
  );
}

/** What the model is told when the preamble limits dropped some tools. */
function limitNotice(skipped: string[]): string {
  const names = skipped.map(escapeNoticeName).join(", ");
  return (
    `[preamble truncated] ${skipped.length} saved tool(s) were not loaded because the ` +
    `preamble size limit was reached: ${names}. ` +
    `They are not defined in this session — calling one raises NameError. ` +
    `Delete tools you no longer need with delete_tool.`
  );
}

/**
 * What the model is told when the preamble was refused for shadowing (#54).
 *
 * A preamble definition silently replaces a host tool — host tools resolve
 * only for names Python has not already bound, and the preamble runs first —
 * so one offending file refuses the whole preamble rather than running in
 * part. Naming the file and symbol is what lets a developer who did it
 * accidentally fix it in seconds.
 */
function refusalNotice(refused: RefusedTool[]): string {
  const offenders = refused
    .map((r) => `${escapeNoticeName(r.file)} binds ${r.symbols.map((s) => `'${s}'`).join(", ")}`)
    .join("; ");
  return (
    `[preamble refused] No saved tools were loaded: ${offenders} — those names are host tools, ` +
    `and a preamble that shadows one is refused whole, never run in part. ` +
    `Calling a saved tool raises NameError in this session. ` +
    `Rewrite the offending file(s) — read_tool() shows the code, delete_tool() removes one — ` +
    "then run `repl` with a new `sessionId` to load the preamble."
  );
}

/**
 * What the model is told when an entry in `.pi/code-tools` could not be read
 * and was left out of the preamble (#55).
 *
 * One bad entry skips that entry, not the batch — the other saved tools did
 * load, so this notice never says "no tools". Naming the file is what lets
 * the developer fix it; "could not be read" is true for every reason — a
 * directory, a FIFO, a symlink, a permissions error.
 */
function unreadableNotice(unreadable: UnreadableTool[]): string {
  const files = unreadable.map((u) => escapeNoticeName(u.file)).join(", ");
  return (
    `[preamble unreadable] ${unreadable.length} saved tool file(s) could not be read and were ` +
    `not loaded: ${files}. They are not defined in this session — calling one raises ` +
    `NameError. Fix or remove the file(s) under .pi/code-tools, ` +
    "then run `repl` with a new `sessionId` to load the preamble."
  );
}

/**
 * What the model is told when `.pi/code-tools` exists but could not be
 * listed (#198): nothing loaded, and — the part that matters for the accepted
 * set — nothing was recorded. The reason is an errno string, attacker-
 * influenced through the path; it is escaped like every notice.
 */
function unlistableNotice(reason: string): string {
  return (
    `[preamble unreadable] .pi/code-tools could not be listed (${escapeNoticeName(reason)}), ` +
    "so no saved tools were loaded — none is defined in this session, and calling one raises " +
    "NameError. The accepted set was left as it was. Fix the directory's permissions, then run " +
    "`repl` with a new `sessionId` to load the preamble."
  );
}

/**
 * What the model is told when `.pi/code-tools` resolves outside the project
 * root and was therefore not read (#198 carry-over). Before this the loader's
 * empty answer was compared against the manifest and every accepted file
 * was reported "no longer in .pi/code-tools" — true of the listing, false of
 * the cause. Nothing is executed from behind the link, as before; the
 * notice now says why, and the accepted set is left alone.
 */
function escapedNotice(reason: string): string {
  return (
    `[preamble unreadable] .pi/code-tools was not read: it resolves outside the project root ` +
    `(${escapeNoticeName(reason)}). Saved tools are loaded only from inside the project — a ` +
    "symlinked .pi or code-tools directory is not followed — so none is defined in this session, " +
    "and calling one raises NameError. The accepted set was left as it was. Replace the link " +
    "with a real directory, then run `repl` with a new `sessionId` to load the preamble."
  );
}

/**
 * What the model is told when the manifest store could not be used while the
 * tools directory could not be read either (#198 carry-over). Nothing was
 * withheld for the store — nothing loaded anyway — but a store that stays
 * broken withholds everything the moment the directory is readable, so it is
 * named now rather than then.
 */
function storeUnavailableNotice(reason: string): string {
  return (
    `[preamble unverified] The accepted-set manifest for this project could not be used either ` +
    `(${escapeNoticeName(reason)}). Nothing was withheld for that — no saved tool loaded anyway — ` +
    "but once .pi/code-tools is readable everything would be. The manifest store is " +
    `${PREAMBLE_STORE_DIR_VAR} or, unset, the user's state dir (~/.local/state/repl-simple); fix ` +
    "it too."
  );
}

/** The manifest's shape from a load: tool name → sha256 of the bytes that loaded (#198). */
function hashesOf(identity: ReadonlyMap<string, PreambleFileIdentity>): Map<string, string> {
  return new Map([...identity].map(([name, id]) => [name, id.sha256]));
}

/**
 * Accepted names that this load found in no bucket at all (#198).
 *
 * A name that is merely unreadable, skipped by a cap, or withheld pending
 * acceptance has its own notice; calling it "removed" as well would say the
 * same thing twice, and the second time wrongly.
 */
function removedSince(accepted: ReadonlyMap<string, string>, load: SavedToolsPreamble): string[] {
  const present = new Set([
    ...load.loaded,
    ...load.unaccepted.map((u) => u.name),
    ...load.skipped,
    ...load.unreadable.map((u) => u.file.slice(0, -3)),
  ]);
  return [...accepted.keys()].filter((name) => !present.has(name)).sort();
}

/**
 * What the model is told when the saved tools differ from the accepted set
 * (#198): added or changed files were withheld, removed ones are named.
 *
 * "Accept" has two in-band spellings the model can act on now — `save_tool`
 * re-saves a file under an approval dialog, `delete_tool` removes one — and
 * one for the host, `ReplRunner.acceptPreamble()`. Naming the reason per
 * file (`added` / `changed`) is what lets the user tell a new helper from a
 * rewritten one at a glance.
 */
function changedNotice(unaccepted: UnacceptedTool[], removed: string[]): string {
  const parts: string[] = [];
  if (unaccepted.length > 0) {
    const names = unaccepted.map((u) => `${escapeNoticeName(u.name)} (${u.reason})`).join(", ");
    parts.push(
      `[preamble changed] ${unaccepted.length} saved tool(s) in .pi/code-tools were added or ` +
        `changed since this project's saved tools were last accepted, and were NOT loaded: ` +
        `${names}. They are not defined in this session — calling one raises NameError. ` +
        `Review each with read_tool(); delete_tool() removes one; re-saving one with ` +
        `save_tool() (which asks for approval) accepts it. The user accepts the whole current ` +
        "set with /repl-accept-preamble in pi (the host API is ReplRunner.acceptPreamble()); " +
        "then run `repl` with a new `sessionId` to load them.",
    );
  }
  if (removed.length > 0) {
    const names = removed.map(escapeNoticeName).join(", ");
    parts.push(
      `${parts.length === 0 ? "[preamble changed] " : ""}${removed.length} accepted saved ` +
        `tool(s) are no longer in .pi/code-tools: ${names}. Nothing was withheld for that; ` +
        "they are simply not defined in this session.",
    );
  }
  return parts.join(" ");
}

/**
 * What the model is told when the accepted set could not be consulted and
 * everything that would have loaded was withheld instead (#198).
 *
 * Delivered only when something was withheld — an empty list is an empty
 * array, and the caller pushes nothing. The reason is operator-facing (a
 * path, an errno); it is escaped like every notice, since the store path is
 * whatever the environment said it was.
 */
function unverifiedNotices(reason: string, withheld: UnacceptedTool[]): string[] {
  if (withheld.length === 0) return [];
  const names = withheld.map((u) => escapeNoticeName(u.name)).join(", ");
  return [
    `[preamble unverified] The accepted-set manifest for this project could not be used ` +
      `(${escapeNoticeName(reason)}), so ${withheld.length} saved tool(s) that would have ` +
      `loaded were withheld: ${names}. They are not defined in this session — calling one ` +
      `raises NameError. The manifest store is ${PREAMBLE_STORE_DIR_VAR} or, unset, the user's ` +
      "state dir (~/.local/state/repl-simple); fix it, then run `repl` with a new `sessionId`.",
  ];
}

/**
 * What the model is told when a trust change discarded its session.
 *
 * `lostSuspension` is what turns this from housekeeping into news: a pending
 * approval that goes away without being answered means the call never ran, and
 * that is the same thing `formatResult` reports for a discarded suspension.
 */
function trustChangedMessage(sessionId: string, lostSuspension: boolean): string {
  return (
    `[trust changed] The project's trust decision changed, so session '${sessionId}' was ` +
    `rebuilt: variables, imports and cached tool calls are gone, and the saved-tool preamble ` +
    `now follows the new decision.` +
    (lostSuspension
      ? ` The approval that was pending went with it — that call never executed. Run it again if you still want it.`
      : "")
  );
}

/** Prepend a session's one-shot notice to a result, and consume it. */
function withNotice(live: LiveSession, body: string): string {
  const notice = live.notice;
  if (notice === undefined) return body;
  live.notice = undefined;
  return `${notice}\n\n${body}`;
}

// ── Output formatting ────────────────────────────────────────────

/**
 * Render a `RunResult` as the tool result the model sees.
 *
 * Both interpolated fields arrive already bounded — `stdout` at 32 KiB and
 * `output` at 16 KiB, capped in `sandbox.ts` where the `RunResult` is built so
 * that every consumer shares one cap rather than each rendering site inventing
 * its own. One tool result is therefore bounded at 48 KiB plus this framing.
 * See docs/truncation-policy.md.
 */
function formatResult(result: RunResult, sessionId: string): string {
  const body = formatOutcome(result, sessionId);
  const discarded = result.discardedSuspension;
  if (!discarded) return body;

  // First, not last. The model may stop reading at the result it asked for,
  // and this is the line telling it that an approval it is still expecting to
  // answer is gone — and that the side effect behind it never happened (#129).
  return (
    `[discarded] An approval was still pending in session '${sessionId}' and running this ` +
    `code dropped it. The '${discarded.tool}' call never executed:\n` +
    `${discarded.description}\n` +
    `Run it again if you still want it.\n\n${body}`
  );
}

/** The result itself, without the discard notice `formatResult` may prepend. */
function formatOutcome(result: RunResult, sessionId: string): string {
  if (result.status === "ok") {
    const parts: string[] = [];
    if (result.stdout) {
      parts.push(result.stdout);
    }
    parts.push(`[result]\n${result.output}`);
    return parts.join("\n");
  }

  if (result.status === "error") {
    const parts: string[] = [];
    parts.push(`[error: ${result.errorKind}]`);
    parts.push(result.error);
    if (result.stdout) {
      parts.push(`\n[stdout]\n${result.stdout}`);
    }
    return parts.join("\n");
  }

  // Suspended. The session is named because more than one can be live at
  // once, and "use repl_resume" without saying what to resume leaves the
  // model to guess which (#48).
  return (
    `Tool '${result.suspendedCall.tool}' requires approval.\n` +
    `${result.suspendedCall.description}\n\n` +
    `Session: '${sessionId}'. Use repl_resume(sessionId='${sessionId}') to approve, ` +
    `or repl_abandon(sessionId='${sessionId}') to discard.`
  );
}
