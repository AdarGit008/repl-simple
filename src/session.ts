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
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

// ── Types ────────────────────────────────────────────────────────

/** A single cached tool call: the key + the result it produced. */
interface CacheEntry {
  key: string;
  result: string;
}

/** Serialized form of the suspended state within a Session dump. */
interface SuspendedState {
  /** Base64-encoded MontySnapshot buffer */
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
): ToolRegistry {
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

  return new ToolRegistry(tools);
}

// ── Session ──────────────────────────────────────────────────────

/**
 * Persistent Python execution session.
 *
 * Maintains state across multiple `run()` calls via transcript replay:
 * each run concatenates all prior successful snippets + new code in a
 * fresh Monty interpreter. Host-tool side effects are deduplicated
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

  // ── Constructor ────────────────────────────────────────────

  constructor(sandboxOptions: SandboxOptions, preamble?: string) {
    this.sandboxOptions = sandboxOptions;
    this.preamble = preamble;
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
   */
  async run(code: string, runOpts?: RunOptions): Promise<RunResult> {
    // Build the full transcript: preamble + prior snippets + new code
    const parts: string[] = [];
    if (this.preamble) parts.push(this.preamble);
    parts.push(...this.snippets, code);
    const allCode = parts.join("\n");

    // Record the cache length BEFORE this run (for trace filtering)
    const priorEntryCount = this.callCacheEntries.length;

    // Build a lookup set of cache keys for quick approval bypass
    const cachedKeys = new Set(this.callCacheEntries.map((e) => e.key));

    // New entries discovered during this run
    const newEntries: CacheEntry[] = [];

    // Build caching registry with the current replay list
    const cachingRegistry = createCachingRegistry(
      this.sandboxOptions.registry,
      this.callCacheEntries,
      newEntries,
    );

    // Auto-approve gated tool calls that are in the replay cache.
    // The approval gate fires before tool.execute(), so the caching
    // wrapper alone can't suppress it. We check the cache here.
    const userOnApproval = runOpts?.onApproval;
    const wrappedRunOpts: RunOptions = {
      ...runOpts,
      onApproval: async (req) => {
        // Resolve args to build the cache key
        const tool = this.sandboxOptions.registry.get(req.tool);
        if (tool) {
          let resolved: Record<string, unknown>;
          try {
            resolved = resolveToolArgs(tool, req.args, req.kwargs as Record<string, unknown>);
            const key = cacheKey(req.tool, resolved);
            if (cachedKeys.has(key)) {
              return true; // Already approved and cached — auto-approve
            }
          } catch {
            // Can't resolve — fall through to user callback
          }
        }
        // Not in cache — delegate to user callback, or deny
        return userOnApproval ? userOnApproval(req) : false;
      },
    };

    const result = await runInSandbox(
      allCode,
      { ...this.sandboxOptions, registry: cachingRegistry },
      wrappedRunOpts,
    );

    // Post-process based on result
    if (result.status === "ok") {
      // Success: add snippet, append new entries, filter trace
      this.snippets.push(code);
      this.callCacheEntries.push(...newEntries);
      return this.filterCachedCalls(result, priorEntryCount);
    } else if (result.status === "suspended") {
      // Save suspension state
      this.suspended = result;
      this.suspendedCode = code;
      this.suspendedRunOpts = runOpts;
      // Don't add to snippets or cache — the snippet didn't complete
      return result;
    } else {
      // Error: drop snippet, don't update cache
      return result;
    }
  }

  // ── resume ─────────────────────────────────────────────────

  /**
   * Resume execution after an approval-gate suspension.
   *
   * Uses `runOpts.onApproval(suspendedCall)` to decide whether to
   * approve or deny the suspended tool call. If no callback is
   * provided, the call is denied.
   *
   * On success the original code is appended to the snippet list.
   *
   * @throws If there is no pending suspension.
   */
  async resume(runOpts?: RunOptions): Promise<RunResult> {
    if (!this.suspended) {
      throw new Error("No suspended execution to resume");
    }

    // Resolve the decision for the suspended call
    let decision: boolean;
    if (runOpts?.onApproval) {
      const d = await runOpts.onApproval(this.suspended.suspendedCall);
      decision = d === true;
    } else {
      decision = false; // No callback → deny
    }

    // Use a caching registry so the suspended tool's return value
    // (and any subsequent tool calls) are captured for future replays.
    // resumeSuspended calls tool.execute() directly on the suspended
    // call (bypassing the approval gate), so the caching wrapper sees
    // it without double-execution.
    const newEntries: CacheEntry[] = [];
    const cachingRegistry = createCachingRegistry(
      this.sandboxOptions.registry,
      [], // No replay entries — the suspended call was already decided
      newEntries,
    );

    // Auto-approve any subsequent gated calls that are already cached
    const userOnApproval = runOpts?.onApproval;
    const wrappedRunOpts: RunOptions = {
      ...runOpts,
      onApproval: async (req) => {
        const tool = this.sandboxOptions.registry.get(req.tool);
        if (tool) {
          let resolved: Record<string, unknown>;
          try {
            resolved = resolveToolArgs(tool, req.args, req.kwargs as Record<string, unknown>);
            const key = cacheKey(req.tool, resolved);
            if (this.callCacheEntries.some((e) => e.key === key)) {
              return true;
            }
          } catch {
            /* fall through */
          }
        }
        return userOnApproval ? userOnApproval(req) : false;
      },
    };

    const result = await resumeSuspended(
      this.suspended,
      decision,
      { ...this.sandboxOptions, registry: cachingRegistry },
      wrappedRunOpts,
    );

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
    return true;
  }

  // ── reset ──────────────────────────────────────────────────

  /** Clear all session state: snippets, cache, and any suspension. */
  reset(): void {
    this.snippets = [];
    this.callCacheEntries = [];
    this.suspended = null;
    this.suspendedCode = null;
    this.suspendedRunOpts = undefined;
  }

  // ── dump ───────────────────────────────────────────────────

  /**
   * Serialize the session to a JSON string for persistent storage.
   * The returned string can be passed to `Session.load()`.
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
   * @param json  Serialized session state.
   * @param sandboxOptions  Sandbox configuration (ToolRegistry, etc.).
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
