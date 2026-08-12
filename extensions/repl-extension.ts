import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ReplRunner } from "../src/repl.js";
import type { ApprovalRequest, ApprovalDecision } from "../src/types.js";

/**
 * Repl-simple Pi extension.
 *
 * Registers tools for sandboxed Python execution with persistent sessions:
 * - `repl` — execute Python code
 * - `repl_resume` — approve/deny a pending gated tool call
 * - `repl_reset` — clear session state
 * - `repl_abandon` — discard a pending suspension
 */
export default function (pi: { registerTool: (tool: ReturnType<typeof defineTool>) => void }) {
  // Defer ReplRunner construction until first execute() —
  // ctx.cwd is only available inside execute(), not at module load.
  let runner: ReplRunner | null = null;

  function getRunner(cwd: string): ReplRunner {
    if (!runner) runner = new ReplRunner(cwd);
    return runner;
  }

  /** Build an onApproval callback that uses Pi's native confirm dialog. */
  function makeOnApproval(ctx: {
    hasUI: boolean;
    ui: { confirm: (title: string, message: string) => Promise<boolean> };
  }): (req: ApprovalRequest) => Promise<ApprovalDecision> {
    return async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      if (!ctx.hasUI) return false;
      const approved = await ctx.ui.confirm("Approve tool call?", `Allow ${req.description}?`);
      return approved;
    };
  }

  // ── repl ──────────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "repl",
      label: "Python REPL",
      description:
        "Execute Python code in a sandboxed environment with persistent sessions. " +
        "Variables, imports, and function definitions persist across calls with the " +
        "same sessionId. File system, shell, and HTTP tools are available as Python " +
        "functions.",
      parameters: Type.Object({
        code: Type.String({ description: "Python code to execute." }),
        sessionId: Type.Optional(
          Type.String({
            description:
              "Session identifier. Reuse to persist variables across calls. Default: 'default'.",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const r = getRunner(ctx.cwd);
        const text = await r.run(params.code, params.sessionId ?? "default", makeOnApproval(ctx));
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }),
  );

  // ── repl_resume ────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "repl_resume",
      label: "Resume REPL",
      description:
        "Resume a suspended REPL session. Call after a tool requires " +
        "approval — this shows a confirmation dialog for the pending tool call.",
      parameters: Type.Object({
        sessionId: Type.Optional(
          Type.String({ description: "Session to resume. Default: 'default'." }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const r = getRunner(ctx.cwd);
        const text = await r.resume(params.sessionId ?? "default", makeOnApproval(ctx));
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }),
  );

  // ── repl_reset ─────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "repl_reset",
      label: "Reset REPL session",
      description: "Clear all state (variables, imports, tool call cache) in a REPL session.",
      parameters: Type.Object({
        sessionId: Type.Optional(
          Type.String({ description: "Session to reset. Default: 'default'." }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        getRunner(ctx.cwd).reset(params.sessionId ?? "default");
        return {
          content: [
            {
              type: "text" as const,
              text: `Session '${params.sessionId ?? "default"}' reset.`,
            },
          ],
          details: {},
        };
      },
    }),
  );

  // ── repl_abandon ───────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "repl_abandon",
      label: "Abandon REPL suspension",
      description:
        "Discard a pending tool approval in a REPL session. The suspended " +
        "code is dropped and the session can continue with new code.",
      parameters: Type.Object({
        sessionId: Type.Optional(
          Type.String({
            description: "Session to abandon suspension for. Default: 'default'.",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const r = getRunner(ctx.cwd);
        const ok = r.abandon(params.sessionId ?? "default");
        return {
          content: [
            {
              type: "text" as const,
              text: ok ? "Suspension abandoned." : "No pending suspension.",
            },
          ],
          details: {},
        };
      },
    }),
  );
}
