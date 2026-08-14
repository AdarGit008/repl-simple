import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ReplRunner } from "../src/repl.js";
import type { ApprovalRequest, ApprovalDecision } from "../src/types.js";

/**
 * Approval mode. The user's decision about how much they want to be asked.
 *
 * `strict` is the default and the only mode a session can start in: every
 * gated execution is approved on its own, once, and authorises nothing else
 * (see `DEFAULT_GRANT_USES` in `src/session.ts`).
 *
 * `yolo` approves everything without a dialog. It exists because the honest
 * alternative to a strict gate is not a lenient gate — it is a user who
 * approves without reading. Making "stop asking me" an explicit, visible mode
 * keeps the strict path meaningful for everyone who has not chosen it.
 *
 * It is deliberately **per-process and not persisted**: a restart is back to
 * `strict`, so the blast radius of the choice is the session it was made in.
 */
type ApprovalMode = "strict" | "yolo";

const MODE_HELP = "Usage: /repl-approvals [strict|yolo]";

/** Extension registration surface — the subset of pi's API this file uses. */
interface ReplExtensionApi {
  registerTool: (tool: ReturnType<typeof defineTool>) => void;
  registerCommand: (
    name: string,
    options: {
      description?: string;
      handler: (
        args: string,
        ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } },
      ) => Promise<void>;
    },
  ) => void;
}

/**
 * Repl-simple Pi extension.
 *
 * Registers tools for sandboxed Python execution with persistent sessions:
 * - `repl` — execute Python code
 * - `repl_resume` — approve/deny a pending gated tool call
 * - `repl_reset` — clear session state
 * - `repl_abandon` — discard a pending suspension
 *
 * And one command:
 * - `/repl-approvals [strict|yolo]` — read or set the approval mode
 */
export default function (pi: ReplExtensionApi) {
  let approvalMode: ApprovalMode = "strict";
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
      // Fail closed first, and before the mode is consulted. `yolo` is set by
      // a human at a terminal; a headless run has nobody who could have set
      // it and nobody watching what it approves, so it stays denied either
      // way. This ordering is what `extension.test.ts` pins.
      if (!ctx.hasUI) return false;
      if (approvalMode === "yolo") return true;
      const approved = await ctx.ui.confirm("Approve tool call?", `Allow ${req.description}?`);
      return approved;
    };
  }

  // ── /repl-approvals ────────────────────────────────────────

  pi.registerCommand("repl-approvals", {
    description: "Show or set the repl approval mode (strict | yolo).",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();

      if (!requested) {
        ctx.ui.notify(`repl approvals: ${approvalMode}. ${MODE_HELP}`, "info");
        return;
      }

      if (requested !== "strict" && requested !== "yolo") {
        ctx.ui.notify(`Unknown approval mode '${requested}'. ${MODE_HELP}`, "error");
        return;
      }

      approvalMode = requested;

      if (approvalMode === "yolo") {
        // Loud on the way in, quiet on the way out: turning the gate off is
        // the half of this toggle that deserves a warning.
        ctx.ui.notify(
          "repl approvals: yolo — bash, edit and write now run without asking. " +
            "Back to strict with /repl-approvals strict, or by restarting pi.",
          "warning",
        );
      } else {
        ctx.ui.notify("repl approvals: strict — every gated call asks.", "info");
      }
    },
  });

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
        const sessionId = params.sessionId ?? "default";
        const revoked = getRunner(ctx.cwd).reset(sessionId);

        // State the approval posture on the way out. A reset is the moment
        // someone is asking what this session is still holding, and "which
        // mode am I in" is half of that answer.
        const parts = [`Session '${sessionId}' reset.`, `Approval mode: ${approvalMode}.`];
        parts.push(
          revoked.length === 0
            ? "No approval grants were outstanding."
            : `Revoked ${revoked.length} approval grant(s): ` +
                revoked.map((g) => `${g.tool} (${g.remaining} use(s) left)`).join(", "),
        );

        return {
          content: [{ type: "text" as const, text: parts.join(" ") }],
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
