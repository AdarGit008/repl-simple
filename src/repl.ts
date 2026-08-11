import { Session } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { createPiBridgeTools } from "./bridge.js";
import { createBuiltinTools } from "./builtins.js";
import { loadSavedTools } from "./toolstore.js";
import type { SandboxOptions } from "./sandbox.js";
import type { ApprovalRequest, ApprovalDecision, RunResult } from "./types.js";

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
   */
  async run(
    code: string,
    sessionId = "default",
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
  ): Promise<string> {
    const session = await this.getOrCreateSession(sessionId);
    const result = await session.run(code, { onApproval });
    return formatResult(result);
  }

  /**
   * Resume a suspended session.
   *
   * Calls `onApproval` for the pending gated call. If the resumed
   * execution suspends again (nested gated calls), returns a
   * suspended message so the LLM can call `repl_resume` again.
   *
   * @throws If the session has no pending suspension.
   */
  async resume(
    sessionId: string,
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return `No session '${sessionId}' exists. Run some code first.`;
    }
    const result = await session.resume({ onApproval });
    return formatResult(result);
  }

  /**
   * Discard a pending suspension without approving or denying.
   *
   * @returns `true` if there was a suspension to abandon, `false` otherwise.
   */
  abandon(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.abandon();
  }

  /** Clear all state in a session. */
  reset(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.reset();
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

function formatResult(result: RunResult): string {
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

  // suspended
  return (
    `Tool '${result.suspendedCall.tool}' requires approval.\n` +
    `${result.suspendedCall.description}\n\n` +
    `Use repl_resume to approve or repl_abandon to discard.`
  );
}
