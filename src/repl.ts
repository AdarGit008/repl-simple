import { Session, type GrantSummary } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { createPiBridgeTools } from "./bridge.js";
import { createBuiltinTools } from "./builtins.js";
import { loadSavedTools } from "./toolstore.js";
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

// ── ReplRunner ─────────────────────────────────────────────────────

/**
 * Manages persistent REPL sessions.
 *
 * Each session (keyed by `sessionId`) wraps a `Session` with a composed
 * tool registry (bridge + builtins) and auto-loaded toolstore preamble.
 * No RLM tools — this is a direct REPL, not an RLM loop.
 */
export class ReplRunner {
  private sessions = new Map<string, Session>();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
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
    const session = await this.getOrCreateSession(sessionId);
    const result = await session.run(code, { onApproval, signal });
    return formatResult(result, sessionId);
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      return `No session '${sessionId}' exists. Run some code first.`;
    }
    if (!session.isSuspended()) {
      return (
        `Session '${sessionId}' has nothing waiting for approval. ` +
        `Nothing was resumed — run code with repl to continue.`
      );
    }
    const result = await session.resume({ onApproval, signal });
    return formatResult(result, sessionId);
  }

  /**
   * Discard a pending suspension without approving or denying.
   *
   * @returns which of the three states the session was in — see
   *          {@link AbandonOutcome}.
   */
  abandon(sessionId: string): AbandonOutcome {
    const session = this.sessions.get(sessionId);
    if (!session) return "no-session";
    return session.abandon() ? "abandoned" : "nothing-pending";
  }

  /**
   * Clear all state in a session.
   *
   * @returns whether the session existed, and the approval grants that were
   *          live when the reset happened — empty for an unknown session, and
   *          empty in the usual case where no call is paused at a suspension.
   */
  reset(sessionId: string): ResetOutcome {
    const session = this.sessions.get(sessionId);
    if (!session) return { existed: false, revoked: [] };
    return { existed: true, revoked: session.reset() };
  }

  // ── Private helpers ─────────────────────────────────────────

  private async getOrCreateSession(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const session = await this.createSession();
    this.sessions.set(sessionId, session);
    return session;
  }

  private async createSession(): Promise<Session> {
    const bridgeTools = createPiBridgeTools(this.cwd, { gateMutating: true });
    const builtinTools = createBuiltinTools({ root: this.cwd });
    const registry = new ToolRegistry([...bridgeTools, ...builtinTools]);
    const sandboxOpts: SandboxOptions = { registry };
    const preamble = await loadSavedTools({ root: this.cwd });
    return new Session(sandboxOpts, preamble || undefined);
  }
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
