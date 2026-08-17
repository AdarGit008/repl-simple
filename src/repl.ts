import { Session, type GrantSummary } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { createPiBridgeTools } from "./bridge.js";
import { createBuiltinTools } from "./builtins.js";
import {
  loadSavedTools,
  savedToolNames,
  createToolStoreTools,
  TOOLSTORE_TOOL_NAMES,
  escapeNoticeName,
} from "./toolstore.js";
import type { RefusedTool, UnreadableTool, PreambleStatus } from "./toolstore.js";
import type { SandboxOptions } from "./sandbox.js";
import type { ApprovalRequest, ApprovalDecision, RunResult } from "./types.js";

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
}

/** A live session, plus what the preamble decision for it was. */
interface LiveSession {
  session: Session;
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

  constructor(cwd: string, options: ReplRunnerOptions = {}) {
    this.cwd = cwd;
    this.isProjectTrusted = options.isProjectTrusted ?? (() => false);
    this.maxSessions = sessionCap(options.maxSessions);
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
   */
  async run(
    code: string,
    sessionId = "default",
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal?: AbortSignal,
  ): Promise<string> {
    const live = await this.getOrCreateSession(sessionId);
    live.busy++;
    try {
      const result = await live.session.run(code, { onApproval, signal });
      return withNotice(live, formatResult(result, sessionId));
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
   * Never throws: the model decides when to call `repl_resume`, so every state
   * it can believe it is in — no such session, session with nothing pending —
   * gets a sentence back rather than an exception (#48).
   */
  async resume(
    sessionId: string,
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal?: AbortSignal,
  ): Promise<string> {
    const live = this.sessions.get(sessionId);
    if (!live) {
      return `No session '${sessionId}' exists. Run some code first.`;
    }
    this.touch(sessionId, live);
    // Resuming replays the whole transcript, preamble included, so a trust
    // decision made during the pause has to be honoured here too — otherwise
    // revoking trust and answering the pending dialog runs the withdrawn code
    // anyway.
    if (await this.trustChangeDiscards(sessionId, live)) {
      return trustChangedMessage(sessionId, live.session.isSuspended());
    }
    // The trust check awaited; the entry may have been evicted in the gap
    // (D3 parity with `run`): a resumed call on a session the pool no longer
    // holds must not report a result for it.
    if (this.sessions.get(sessionId) !== live) {
      return `No session '${sessionId}' exists. Run some code first.`;
    }
    if (!live.session.isSuspended()) {
      return (
        `Session '${sessionId}' has nothing waiting for approval. ` +
        `Nothing was resumed — run code with repl to continue.`
      );
    }
    live.busy++;
    try {
      const result = await live.session.resume({ onApproval, signal });
      return withNotice(live, formatResult(result, sessionId));
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
    return live.session.abandon() ? "abandoned" : "nothing-pending";
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

  // ── Private helpers ─────────────────────────────────────────

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

  private async createSession(trusted: boolean): Promise<LiveSession> {
    const bridgeTools = createPiBridgeTools(this.cwd, { gateMutating: true });
    const builtinTools = createBuiltinTools({ root: this.cwd });
    const registry = new ToolRegistry([...bridgeTools, ...builtinTools]);
    const sandboxOpts: SandboxOptions = { registry };

    const notices: string[] = [];

    // The shadowing gates (#54 load, #56 write) must see every host-tool name
    // the session will have — including the toolstore's own, which are not in
    // the registry yet: a preamble `def save_tool` would shadow the registered
    // tool exactly like a bridge or builtin name (#57).
    const hostToolNames = [...registry.list().map((tool) => tool.name), ...TOOLSTORE_TOOL_NAMES];

    let preamble = "";
    let preambleStatus: PreambleStatus;
    if (trusted) {
      // The reserved names are the live registry's — never a hardcoded list.
      // A file that binds one of them refuses the whole preamble (#54), and
      // the loader reports it with the offending file and symbols.
      const load = await loadSavedTools({
        root: this.cwd,
        hostToolNames,
      });
      preamble = load.preamble;
      // The tool names, for the honest tool answers: `refused`/`unreadable`
      // carry `.py` file names, the status sets carry the names the tools and
      // the model use.
      preambleStatus = {
        trusted: true,
        loaded: new Set(load.loaded),
        withheld: new Set(),
        skipped: new Set(load.skipped),
        refused: new Set(load.refused.map((r) => r.file.slice(0, -3))),
        unreadable: new Set(load.unreadable.map((u) => u.file.slice(0, -3))),
        identity: load.loadedIdentity,
      };
      if (load.refused.length > 0) notices.push(refusalNotice(load.refused));
      if (load.unreadable.length > 0) notices.push(unreadableNotice(load.unreadable));
      if (load.skipped.length > 0) notices.push(limitNotice(load.skipped));
    } else {
      // Names only. Reading the listing is not reading the files, and the
      // model needs the names or it will call a tool that is not defined and
      // get a NameError it cannot explain.
      const withheld = await savedToolNames({ root: this.cwd });
      preambleStatus = {
        trusted: false,
        loaded: new Set(),
        withheld: new Set(withheld),
        skipped: new Set(),
        refused: new Set(),
        unreadable: new Set(),
      };
      if (withheld.length > 0) notices.push(untrustedNotice(withheld));
    }

    // Registered in every session, trusted or untrusted (#57): the tools
    // answer from the status above — listing what actually loaded, refusing
    // reads the project never trusted — and the write-time shadowing check
    // (#56) finally sees the live registry's names. The live trust callback
    // keeps the read gate honest across trust flips that keep the session.
    for (const tool of createToolStoreTools({
      root: this.cwd,
      hostToolNames,
      preambleStatus,
      isTrusted: this.isProjectTrusted,
    })) {
      registry.add(tool);
    }

    return {
      session: new Session(sandboxOpts, preamble || undefined),
      trusted,
      hasPreamble: preamble !== "",
      busy: 0,
      trustChangeNoticed: false,
      notice: notices.length > 0 ? notices.join("\n\n") : undefined,
    };
  }
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
 * Render a filename inside a model-facing notice.
 *
 * The shared escaper lives in `toolstore.ts` — `escapeNoticeName` — so the
 * tools and every notice render attacker-controlled filenames the same way.
 */
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
