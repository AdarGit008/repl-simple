import { runInSandbox, resumeSuspended, resolveToolArgs, type SandboxOptions } from "./sandbox.js";
import { ToolRegistry } from "./registry.js";
import type {
  HostTool,
  RunResult,
  RunOk,
  RunSuspended,
  RunOptions,
  ToolCallTrace,
  ApprovalRequest,
  ApprovalDecision,
  DiscardedSuspension,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

/**
 * How many executions one approval authorises, by default.
 *
 * One. An approval answers the question it was shown — "run *this* call?" —
 * and authorises nothing past it. The knob exists because #44 requires the
 * count to be a real, enforced ceiling rather than a comment, and because
 * bucket 5's richer dialog will want to hand out "allow the next N" grants
 * from a prompt that actually says so. Until such a prompt exists, the only
 * honest default is the number the current dialog implies.
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
  /** ToolCallTrace entries up to the suspension point */
  calls: ToolCallTrace[];
}

/** Wire format for Session.dump() / Session.load(). */
interface SessionDump {
  version: number;
  snippets: string[];
  /** Ordered list — one entry per actual tool call from prior snippets */
  callCache: CacheEntry[];
  suspended?: SuspendedState;
  /** The code string that caused the suspension (needed for resume) */
  suspendedCode?: string;
  /** RunOptions active when the suspension happened */
  suspendedRunOpts?: RunOptions;
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

/** A replay-cached registry, plus the one question the approval gate asks it. */
interface CachingRegistry {
  registry: ToolRegistry;
  /**
   * True when a call with this key is the *next* entry the replay cursor will
   * serve — so it will be answered from the cache and will not execute.
   *
   * This is the only place the cursor is visible outside the replay itself,
   * and it is deliberately here rather than in the gate: when #40 removes
   * transcript replay, this function and its caller's `true` branch go with
   * it, and the grant model above is untouched.
   */
  willReplayKey(key: string): boolean;
}

/**
 * Wraps a parent ToolRegistry with a replay cache.
 *
 * `replayEntries` contains the ordered list of cached tool calls
 * from prior successful snippets. During execution, calls are served
 * from this list **in order** until it is exhausted. After that,
 * calls execute for real and are recorded into `newEntries`.
 */
function createCachingRegistry(
  parent: ToolRegistry,
  replayEntries: CacheEntry[],
  newEntries: CacheEntry[],
): CachingRegistry {
  let replayIndex = 0;

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
          return entry.result;
        }
        // Key mismatch: the cache no longer matches the current
        // execution. This can happen if code changed between runs
        // (e.g., a snippet was removed). Fall through to real exec.
      }

      // 2. Execute for real
      const result = await originalExecute(args);

      // 3. Record for future replays
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
      replayIndex < replayEntries.length && replayEntries[replayIndex].key === key,
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
 * as `this.suspended`, and the stored suspension must stay a description of
 * itself.
 */
function withDiscardNotice(result: RunResult, discarded?: DiscardedSuspension): RunResult {
  if (!discarded) return result;
  return { ...result, discardedSuspension: discarded };
}

// ── Session ──────────────────────────────────────────────────────

/**
 * Persistent Python execution session.
 *
 * Maintains state across multiple `run()` calls via transcript replay:
 * each run concatenates all prior successful snippets + new code in a
 * fresh sandbox session. Host-tool side effects are deduplicated
 * through an ordered call cache so they don't repeat on replay.
 */
export class Session {
  // ── State ──────────────────────────────────────────────────

  private snippets: string[] = [];
  /** Ordered list of all tool calls from successful snippets. */
  private callCacheEntries: CacheEntry[] = [];
  private sandboxOptions: SandboxOptions;
  private preamble: string | undefined;
  private suspended: RunSuspended | null = null;
  private suspendedCode: string | null = null;
  private suspendedRunOpts: RunOptions | undefined;
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

  // ── Constructor ────────────────────────────────────────────

  constructor(sandboxOptions: SandboxOptions, preamble?: string, options: SessionOptions = {}) {
    this.sandboxOptions = sandboxOptions;
    this.preamble = preamble;

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
    return this.suspended !== null;
  }

  // ── run ────────────────────────────────────────────────────

  /**
   * Execute Python code in this session.
   *
   * Prior successful snippets are replayed first so variables,
   * imports, and function definitions persist. Host-tool calls from
   * prior snippets are served from an ordered call cache to avoid
   * repeating side effects.
   *
   * On success the snippet is appended for future runs.
   * On error the snippet is dropped.
   * On suspension the state is saved for later `resume()`.
   *
   * **A pending suspension does not survive this call.** Running new code is
   * the caller moving on, so the deferred decision is discarded here and
   * reported on the result — see {@link DiscardedSuspension} for why it cannot
   * simply be left pending (#129).
   */
  async run(code: string, runOpts?: RunOptions): Promise<RunResult> {
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
    // one doing the prepending.
    const lineOffset = parts
      .slice(0, -1)
      .reduce((total, part) => total + part.split("\n").length, 0);

    // Record the cache length BEFORE this run (for trace filtering)
    const priorEntryCount = this.callCacheEntries.length;

    // A grant belongs to one call. The discard above already cleared the only
    // path that can leave one behind — a suspension that was never resumed —
    // and this keeps that true however the previous call ended.
    this.grants.clear();

    // New entries discovered during this run
    const newEntries: CacheEntry[] = [];

    // Build caching registry with the current replay list
    const { registry: cachingRegistry, willReplayKey } = createCachingRegistry(
      this.sandboxOptions.registry,
      this.callCacheEntries,
      newEntries,
    );

    const wrappedRunOpts: RunOptions = {
      ...runOpts,
      lineOffset,
      onApproval: this.makeApprovalGate(runOpts?.onApproval, willReplayKey),
    };

    const result = await runInSandbox(
      allCode,
      { ...this.sandboxOptions, registry: cachingRegistry },
      wrappedRunOpts,
    );

    // Anything but a suspension ends the call, and the grants with it.
    if (result.status !== "suspended") this.grants.clear();

    // Post-process based on result
    if (result.status === "ok") {
      // Success: add snippet, append new entries, filter trace
      this.snippets.push(code);
      this.callCacheEntries.push(...newEntries);
      return withDiscardNotice(this.filterCachedCalls(result, priorEntryCount), discarded);
    } else if (result.status === "suspended") {
      // Save suspension state — the raw result, so the notice about the *last*
      // suspension is not carried into the state describing this one.
      this.suspended = result;
      this.suspendedCode = code;
      this.suspendedRunOpts = runOpts;
      // Don't add to snippets or cache — the snippet didn't complete
      return withDiscardNotice(result, discarded);
    } else {
      // Error: drop snippet, don't update cache
      return withDiscardNotice(result, discarded);
    }
  }

  // ── resume ─────────────────────────────────────────────────

  /**
   * Resume execution after an approval-gate suspension.
   *
   * Uses `runOpts.onApproval(suspendedCall)` to decide the suspended tool
   * call's fate. All three answers are honoured: approve, deny, and
   * `"suspend"` — "not now", which leaves the suspension exactly where it was.
   * If no callback is provided, the call is denied.
   *
   * On success the original code is appended to the snippet list.
   *
   * @throws If there is no pending suspension.
   */
  async resume(runOpts?: RunOptions): Promise<RunResult> {
    if (!this.suspended) {
      throw new Error("No suspended execution to resume");
    }

    // Resolve the decision for the suspended call. The type is
    // `ApprovalDecision`, not `boolean`: narrowing here is what silently turned
    // every "decide later" into a denial, one layer below the extension that
    // was discarding it too (#51). Two layers each dropping the same value is
    // why both had to widen for either to matter.
    let decision: ApprovalDecision;
    if (runOpts?.onApproval) {
      decision = await runOpts.onApproval(this.suspended.suspendedCall);
    } else {
      decision = false; // No callback → deny
    }

    // "Decide later" is not a decision, so nothing happens: no grant, no
    // snapshot restored, no state advanced. Answering it by round-tripping the
    // snapshot through a fresh worker would be the same restore that #129 had
    // to make faithful, run for a call that has not been decided — so the
    // stored suspension is simply handed back, and the next `resume` asks
    // again. `resumeSuspended` still handles this case for its own callers.
    if (decision === "suspend") return this.suspended;

    // An approval here is the user answering the dialog for *this* call, so it
    // grants what any other approval grants — including the one use this call
    // is about to spend, which is why the grant recorded is one short.
    const suspendedCall = this.suspended.suspendedCall;
    if (decision) this.recordGrant(this.keyFor(suspendedCall), suspendedCall.tool);

    // Use a caching registry so the suspended tool's return value
    // (and any subsequent tool calls) are captured for future replays.
    // resumeSuspended calls tool.execute() directly on the suspended
    // call (bypassing the approval gate), so the caching wrapper sees
    // it without double-execution.
    const newEntries: CacheEntry[] = [];
    const { registry: cachingRegistry, willReplayKey } = createCachingRegistry(
      this.sandboxOptions.registry,
      [], // No replay entries — the suspended call was already decided
      newEntries,
    );

    // The same gate as `run()`. With no replay entries its cache branch is
    // dead here, so every gated call in the resumed continuation is decided by
    // a grant or by the user — never by "something like it ran once".
    const wrappedRunOpts: RunOptions = {
      ...runOpts,
      onApproval: this.makeApprovalGate(runOpts?.onApproval, willReplayKey),
    };

    const result = await resumeSuspended(
      this.suspended,
      decision,
      { ...this.sandboxOptions, registry: cachingRegistry },
      wrappedRunOpts,
    );

    // The call is over unless it suspended again.
    if (result.status !== "suspended") this.grants.clear();

    // Save copies before clearing
    const suspendedCode = this.suspendedCode!;

    // Clear suspension state
    this.suspended = null;
    this.suspendedCode = null;
    this.suspendedRunOpts = undefined;

    if (result.status === "ok") {
      // Append cached tool calls (including the suspended call's result)
      this.callCacheEntries.push(...newEntries);
      this.snippets.push(suspendedCode);
      return result;
    } else if (result.status === "suspended") {
      // Suspended again on a later gated call
      this.suspended = result;
      this.suspendedCode = suspendedCode;
      this.suspendedRunOpts = runOpts;
      return result;
    } else {
      // Error: don't add snippet
      return result;
    }
  }

  // ── abandon ────────────────────────────────────────────────

  /**
   * Discard the pending suspension.
   *
   * @returns `true` if there was a suspension to abandon, `false` if
   *          the session was not suspended.
   */
  abandon(): boolean {
    if (!this.suspended) return false;
    this.suspended = null;
    this.suspendedCode = null;
    this.suspendedRunOpts = undefined;
    // Abandoning ends the call the grants belonged to.
    this.grants.clear();
    return true;
  }

  // ── reset ──────────────────────────────────────────────────

  /**
   * Clear all session state: snippets, cache, grants, and any suspension.
   *
   * @returns the grants that were live at the moment of the reset, so the
   *          caller can tell the user what it just revoked.
   */
  reset(): GrantSummary[] {
    const revoked = this.outstandingGrants();
    this.snippets = [];
    this.callCacheEntries = [];
    this.suspended = null;
    this.suspendedCode = null;
    this.suspendedRunOpts = undefined;
    this.grants.clear();
    return revoked;
  }

  // ── dump ───────────────────────────────────────────────────

  /**
   * Serialize the session to a JSON string for persistent storage.
   * The returned string can be passed to `Session.load()`.
   *
   * **Grants are not included, and must not be.** They authorise executions in
   * the call that is running now; a grant that survives into another process
   * is the unbounded lifetime #44 removed, rebuilt through the back door. A
   * restored session re-asks.
   */
  dump(): string {
    const obj: SessionDump = {
      version: CURRENT_VERSION,
      snippets: [...this.snippets],
      callCache: [...this.callCacheEntries],
    };

    if (this.suspended) {
      obj.suspended = {
        snapshot: this.suspended.snapshot.toString("base64"),
        suspendedCall: this.suspended.suspendedCall,
        stdout: this.suspended.stdout,
        stdoutTruncated: this.suspended.stdoutTruncated,
        calls: this.suspended.calls,
      };
      obj.suspendedCode = this.suspendedCode!;
      obj.suspendedRunOpts = this.suspendedRunOpts;
    }

    return JSON.stringify(obj, null, 2);
  }

  // ── load (static) ──────────────────────────────────────────

  /**
   * Restore a session from a JSON string produced by `dump()`.
   *
   * **The dump is half a session.** The registry, the preamble and every
   * toolstore-side view of them are not serialized — the caller must rebuild
   * them exactly as session creation did (`ReplRunner.createSession` is the
   * reference): a registry whose toolstore tools were built with a **fresh**
   * `PreambleStatus` (loaded/withheld/refused/skipped/unreadable **and**
   * `identity`, from a new `loadSavedTools`/`savedToolNames` pass), a **live**
   * `isTrusted` callback (omitted, the tools fall back to the snapshot and a
   * stale `true` reads files the user no longer trusts), and the preamble
   * string re-derived through the trusted load path. A restored session
   * whose disk changed since the dump also replays its cached tool results
   * verbatim — treat them as the snapshots they are.
   *
   * `grantUses` is likewise not serialized: a restored session gets
   * {@link DEFAULT_GRANT_USES}. Grants are excluded by design — they
   * authorise executions in the call that is running now.
   *
   * @param json  Serialized session state.
   * @param sandboxOptions  Sandbox configuration (ToolRegistry, etc.).
   * @param preamble  The preamble to prepend — rebuilt by the caller, not read
   *   from the dump.
   * @throws If the JSON version is unsupported or the format is invalid.
   */
  static load(json: string, sandboxOptions: SandboxOptions, preamble?: string): Session {
    let obj: SessionDump;
    try {
      obj = JSON.parse(json) as SessionDump;
    } catch {
      throw new Error("Invalid session JSON");
    }

    if (!obj.version || typeof obj.version !== "number") {
      throw new Error("Missing or invalid session version");
    }
    if (obj.version !== CURRENT_VERSION) {
      throw new Error(`Unsupported session version: ${obj.version} (expected ${CURRENT_VERSION})`);
    }

    const session = new Session(sandboxOptions, preamble);
    session.snippets = obj.snippets ?? [];
    session.callCacheEntries = obj.callCache ?? [];

    if (obj.suspended && obj.suspendedCode) {
      const snapshot = Buffer.from(obj.suspended.snapshot, "base64");
      session.suspended = {
        status: "suspended",
        suspendedCall: obj.suspended.suspendedCall,
        snapshot,
        stdout: obj.suspended.stdout,
        stdoutTruncated: obj.suspended.stdoutTruncated,
        calls: obj.suspended.calls,
      };
      session.suspendedCode = obj.suspendedCode;
      session.suspendedRunOpts = obj.suspendedRunOpts;
    }

    return session;
  }

  // ── Private helpers ────────────────────────────────────────

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
    const pending = this.suspended;
    if (!pending) return undefined;
    const { tool, description } = pending.suspendedCall;
    this.abandon();
    return { tool, description };
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
   *    gets reverted.
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
   * Remove ToolCallTrace entries that were served from the replay
   * cache (the first `priorEntryCount` entries in the cache).
   *
   * We match by resolving each trace entry's args/kwargs via
   * `resolveToolArgs`, building the cache key, and checking whether
   * it matches one of the prior cache entries.
   */
  private filterCachedCalls(result: RunOk, priorEntryCount: number): RunOk {
    if (priorEntryCount === 0) return result;

    const registry = this.sandboxOptions.registry;
    // Write-only counter: incremented below, never read. This is the linter's
    // first catch that tsc structurally could not make — `noUnusedLocals`
    // (enabled in #23) treats the increment as a use. Kept rather than deleted
    // because it is evidence of an unfinished implementation, filed alongside
    // `numToSkip` in the bucket 11 dead-code sweep (#83).
    // biome-ignore lint/correctness/noUnusedVariables: evidence for #83
    let skipped = 0;
    const filtered: ToolCallTrace[] = [];

    // Build a lookup of the prior cache keys (in order) for matching
    const priorKeys = this.callCacheEntries.slice(0, priorEntryCount).map((e) => e.key);
    let keyIdx = 0;

    for (const call of result.calls) {
      if (keyIdx >= priorKeys.length) {
        // All prior entries consumed — keep remaining calls
        filtered.push(call);
        continue;
      }

      const tool = registry.get(call.tool);
      if (!tool) {
        filtered.push(call);
        continue;
      }

      let resolved: Record<string, unknown>;
      try {
        resolved = resolveToolArgs(tool, call.args, call.kwargs);
      } catch {
        filtered.push(call);
        continue;
      }

      const key = cacheKey(call.tool, resolved);
      if (key === priorKeys[keyIdx]) {
        // Matches a prior cache entry — skip
        keyIdx++;
        skipped++;
      } else {
        // No match — keep (shouldn't normally happen if replay is
        // deterministic, but be safe)
        filtered.push(call);
      }
    }

    return { ...result, calls: filtered };
  }
}
