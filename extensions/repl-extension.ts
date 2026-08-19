import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ReplRunner } from "../src/repl.js";
import { limitsConfig } from "../src/sandbox.js";
import type { ApprovalRequest, ApprovalDecision, RunLimits } from "../src/types.js";

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

// ── Approval dialog ──────────────────────────────────────────────

/**
 * The three answers to an approval dialog, in the order they are offered.
 *
 * Approve first because it is the common answer, deny second because it is
 * the safe one, and "decide later" last because it is the one that needs
 * reading. They are constants rather than inline strings because the choice
 * comes back from `ui.select` as the string itself: a typo in one of the two
 * places would silently become a denial. Exported for the same reason — a
 * test that retyped them would be pinning its own copy, not the dialog.
 */
export const APPROVE_CHOICE = "Approve — run this call";
export const DENY_CHOICE = "Deny — refuse this call";
export const LATER_CHOICE = "Decide later — keep it waiting";

// ── Dialog lifetime ──────────────────────────────────────────────

/**
 * Milliseconds an approval dialog stays open before it denies itself.
 *
 * This is not a UX preference, it is the last line of defence against a
 * permanently wedged Pi (#49). `showExtensionSelector` overwrites
 * `this.extensionSelector` without invoking the previous component's
 * `onSelect`/`onCancel`, so a second dialog opened while a first is up leaves
 * the first `await ctx.ui.select` unsettled forever — and on abort the agent
 * loop still awaits every in-flight tool, which makes Escape a permanent no-op.
 * The orphaned component's countdown keeps ticking, so a timeout is what
 * eventually settles it.
 *
 * `executionMode: "sequential"` below is what should stop two dialogs from
 * overlapping in the first place; this is what stops the failure being
 * unrecoverable if anything else opens one anyway.
 *
 * Five minutes is long enough to read a `bash` command and decide, and the
 * expiry denies, so the fail-closed posture is unchanged. Set
 * `REPL_APPROVAL_TIMEOUT_MS` to change it, or to `0` to remove the bound.
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
const APPROVAL_TIMEOUT_VAR = "REPL_APPROVAL_TIMEOUT_MS";

/** The dialog timeout as it applies right now, or `undefined` for unbounded. */
function approvalTimeoutMs(): number | undefined {
  const raw = process.env[APPROVAL_TIMEOUT_VAR];
  if (raw === undefined) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  // An unparseable value is a typo, not a request to remove the bound.
  if (!Number.isFinite(parsed)) return DEFAULT_APPROVAL_TIMEOUT_MS;
  return parsed > 0 ? parsed : undefined;
}

// ── Model limit clamp (D3) ───────────────────────────────────────
//
// The extension is the model boundary: it is where untrusted model input
// enters, so a model-supplied limit is clamped, never trusted. `ReplRunner`
// stays a faithful library and forwards whatever it is given (D2) — the clamp
// lives here, as a pure helper so it is unit-testable without driving the
// sandbox. Each ceiling is `min(specCap, limitsConfig() effective value)`:
// `MAX_MODEL_DURATION_SECS` / `MAX_MODEL_MEMORY_MIB` are the absolute upper
// bound, while `limitsConfig()` supplies the operator's `REPL_*` env knob or
// the sandbox default — so the operator's knob is a true ceiling the model
// cannot out-ask, not a default it can override.

/** Ceiling on a model-supplied `maxDurationSecs`. */
const MAX_MODEL_DURATION_SECS = 300;
/** Ceiling on a model-supplied `maxMemory`, in MiB. */
const MAX_MODEL_MEMORY_MIB = 1024;
/** Bytes per MiB — `RunLimits.maxMemory` speaks bytes, the model speaks MiB. */
const BYTES_PER_MIB = 1_048_576;

/**
 * Clamp a model-supplied limit to a ceiling, or omit it.
 *
 * Upper bound only: a shorter/smaller request is honoured, never raised. A
 * value that is not a positive finite number (`≤0`, `NaN`, `Infinity`, or
 * non-numeric) is omitted so the sandbox's fail-safe default applies — the
 * model saying nothing and the model saying nonsense must mean the same thing.
 */
function clampCeiling(value: unknown, cap: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(value, cap);
}

/**
 * Build the `RunLimits` for a `repl` call from the two model-exposed knobs.
 *
 * `maxDurationSecs` and `maxMemory` are clamped to ceilings derived from
 * `limitsConfig()` (each `min(specCap, operator value)`), so the operator's
 * `REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB` env vars are honoured, not
 * overridden by a model-supplied value. `maxMemory` is in MiB here, clamped
 * and converted to bytes. Both are omitted when not a positive finite number.
 * The result is always an object, never `"unbounded"` — that escape hatch is
 * the library's, not the model's (D2/D3).
 *
 * Reads `process.env` via `limitsConfig()` at call time, so it is no longer a
 * strictly pure function.
 */
export function clampModelLimits(maxDurationSecs?: unknown, maxMemoryMiB?: unknown): RunLimits {
  const cfg = limitsConfig();
  const durationCap = Math.min(MAX_MODEL_DURATION_SECS, cfg.maxDurationSecs);
  const memoryCapMiB = Math.min(MAX_MODEL_MEMORY_MIB, cfg.maxMemory / BYTES_PER_MIB);

  const limits: RunLimits = {};
  const duration = clampCeiling(maxDurationSecs, durationCap);
  if (duration !== undefined) limits.maxDurationSecs = duration;
  const memoryMiB = clampCeiling(maxMemoryMiB, memoryCapMiB);
  if (memoryMiB !== undefined) limits.maxMemory = Math.floor(memoryMiB * BYTES_PER_MIB);
  return limits;
}

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

  /**
   * Pi's project-trust decision, as of the most recent tool call.
   *
   * The runner reads it through a closure rather than receiving a boolean,
   * because the runner outlives the `ctx` that built it and the decision can
   * change while pi runs — trusting a project mid-session, or withdrawing it,
   * has to reach the next `repl` call (#53). Refreshed on the way in below;
   * `false` until a real `ctx` has been seen, which is the same fail-closed
   * default `ReplRunner` applies for callers that pass nothing.
   */
  let projectTrusted = false;

  function getRunner(ctx: { cwd: string; isProjectTrusted(): boolean }): ReplRunner {
    projectTrusted = ctx.isProjectTrusted();
    if (!runner) runner = new ReplRunner(ctx.cwd, { isProjectTrusted: () => projectTrusted });
    return runner;
  }

  /**
   * Build an onApproval callback that uses Pi's native select dialog.
   *
   * Three answers, because there are three (#51). `confirm` offers two and
   * cannot distinguish Escape from "No" — `showExtensionConfirm` returns
   * `result === "Yes"`, so cancel, timeout and abort all arrive as a denial —
   * and the third answer the sandbox already understands, `"suspend"`, had
   * nowhere to come from. A `select` can say all three and can tell a
   * dismissal from an answer.
   *
   * `signal` is the abort signal for the tool call the approval belongs to. It
   * is handed to the dialog so that Escape dismisses it and the promise
   * settles, rather than leaving a dialog nobody can answer and a tool nobody
   * can stop (#49).
   */
  function makeOnApproval(
    ctx: {
      hasUI: boolean;
      ui: {
        select: (
          title: string,
          options: string[],
          opts?: { signal?: AbortSignal; timeout?: number },
        ) => Promise<string | undefined>;
      };
    },
    signal?: AbortSignal,
  ): (req: ApprovalRequest) => Promise<ApprovalDecision> {
    return async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      // Fail closed first, and before the mode is consulted. `yolo` is set by
      // a human at a terminal; a headless run has nobody who could have set
      // it and nobody watching what it approves, so it stays denied either
      // way. This ordering is what `extension.test.ts` pins.
      if (!ctx.hasUI) return false;
      if (approvalMode === "yolo") return true;
      // An already-aborted turn has nobody left to ask: opening a dialog here
      // would put one on screen after the user has said stop.
      if (signal?.aborted) return false;

      const choice = await ctx.ui.select(
        `Allow ${req.description}?`,
        [APPROVE_CHOICE, DENY_CHOICE, LATER_CHOICE],
        { signal, timeout: approvalTimeoutMs() },
      );

      if (choice === APPROVE_CHOICE) return true;
      if (choice === LATER_CHOICE) return "suspend";
      // `undefined` is Escape, the timeout, or the abort — no answer at all.
      // It denies, deliberately: the one property that must not regress is
      // that a call nobody approved does not run. "Decide later" is the
      // answer for a user who wants to keep the call alive, and it is on
      // screen next to this one, so a dismissal does not have to carry that
      // meaning as well.
      return false;
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
          "repl approvals: yolo — bash, edit, write and save_tool now run without asking. " +
            "Back to strict with /repl-approvals strict, or by restarting pi.",
          "warning",
        );
      } else {
        ctx.ui.notify("repl approvals: strict — every gated call asks.", "info");
      }
    },
  });

  // ── repl ──────────────────────────────────────────────────
  //
  // Every tool below declares `executionMode: "sequential"`. `ToolDefinition`
  // defaults to `parallel`, so two `repl` calls in one assistant message —
  // which a model does whenever it wants two sessions, or simply retries —
  // execute concurrently. Three consequences, each worse than the last (#49):
  //
  //  1. Two sessions is not what concurrency buys here. These four tools all
  //     mutate one `ReplRunner` keyed by `sessionId`, and two calls on the
  //     same session interleave into a state neither of them asked for
  //     (`repl.ts` in-flight race, #59) — a `repl_reset` racing a `repl` being
  //     the sharpest case.
  //  2. Two approval dialogs at once wedges Pi. The second overwrites the
  //     first without settling it (`showExtensionSelector`), and the agent
  //     loop then awaits an in-flight tool that will never return, so Escape
  //     stops working. See `DEFAULT_APPROVAL_TIMEOUT_MS` above.
  //  3. Nothing is lost by serialising. A REPL call is a human-scale
  //     interaction with a shared interpreter; there is no throughput here
  //     that parallelism was buying.

  pi.registerTool(
    defineTool({
      name: "repl",
      executionMode: "sequential",
      label: "Python REPL",
      description:
        "Execute Python code in a sandboxed environment with persistent sessions. " +
        "Variables, imports, and function definitions persist across calls with the " +
        "same sessionId. File system, shell, and HTTP tools are available as Python " +
        "functions. If the session has a tool call waiting for approval, running new " +
        "code discards it — call repl_resume first if you still want that call. " +
        "Cancelling a repl call stops it between tool calls, but a pure-Python loop " +
        "with no pause points runs until the duration limit (maxDurationSecs).",
      parameters: Type.Object({
        code: Type.String({ description: "Python code to execute." }),
        sessionId: Type.Optional(
          Type.String({
            description:
              "Session identifier. Reuse to persist variables across calls. Default: 'default'.",
          }),
        ),
        maxDurationSecs: Type.Optional(
          Type.Number({
            description:
              "Maximum interpreter compute time in seconds, capped at 300. " +
              "Omitted uses the sandbox default (30).",
          }),
        ),
        maxMemory: Type.Optional(
          Type.Number({
            description:
              "Maximum sandbox heap in MiB, capped at 1024. " +
              "Omitted uses the sandbox default (512 MiB).",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const r = getRunner(ctx);
        const text = await r.run(
          params.code,
          params.sessionId ?? "default",
          makeOnApproval(ctx, signal),
          signal,
          clampModelLimits(params.maxDurationSecs, params.maxMemory),
        );
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }),
  );

  // ── repl_resume ────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "repl_resume",
      executionMode: "sequential",
      label: "Resume REPL",
      description:
        "Resume a suspended REPL session. Call after a tool requires " +
        "approval — this asks the user to approve, deny, or keep the call " +
        "waiting. If they keep it waiting the session stays suspended and " +
        "calling this again asks once more.",
      parameters: Type.Object({
        sessionId: Type.Optional(
          Type.String({ description: "Session to resume. Default: 'default'." }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const r = getRunner(ctx);
        const text = await r.resume(
          params.sessionId ?? "default",
          makeOnApproval(ctx, signal),
          signal,
        );
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }),
  );

  // ── repl_reset ─────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "repl_reset",
      executionMode: "sequential",
      label: "Reset REPL session",
      description: "Clear all state (variables, imports, tool call cache) in a REPL session.",
      parameters: Type.Object({
        sessionId: Type.Optional(
          Type.String({ description: "Session to reset. Default: 'default'." }),
        ),
      }),
      // _signal stays underscored: reset is synchronous and non-abortable, so a signal
      // is meaningless here, and noUnusedParameters makes the _-prefix the correct idiom
      // for a fixed-arity unused param.
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = params.sessionId ?? "default";
        const { existed, revoked } = getRunner(ctx).reset(sessionId);

        // State the approval posture on the way out. A reset is the moment
        // someone is asking what this session is still holding, and "which
        // mode am I in" is half of that answer.
        const parts = [
          existed
            ? `Session '${sessionId}' reset.`
            : `No session '${sessionId}' exists — nothing to reset.`,
          `Approval mode: ${approvalMode}.`,
        ];
        // A session that was never created held nothing, so the grant
        // sentence would be true and useless. Report it only where it is
        // about something ([N12], #48).
        if (existed) {
          parts.push(
            revoked.length === 0
              ? "No approval grants were outstanding."
              : `Revoked ${revoked.length} approval grant(s): ` +
                  revoked.map((g) => `${g.tool} (${g.remaining} use(s) left)`).join(", "),
          );
        }

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
      executionMode: "sequential",
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
      // _signal stays underscored: abandon is synchronous and non-abortable, so a signal
      // is meaningless here, and noUnusedParameters makes the _-prefix the correct idiom
      // for a fixed-arity unused param.
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const r = getRunner(ctx);
        const sessionId = params.sessionId ?? "default";

        // Three states, three sentences. "No pending suspension" for a
        // session that does not exist reads as a bug report about the one
        // the caller meant, and the two states need different next moves:
        // one is "run some code", the other is "the pause is over" (#48).
        const text = {
          abandoned: `Suspension in session '${sessionId}' abandoned. The suspended code was dropped; the session is ready for new code.`,
          "nothing-pending": `Session '${sessionId}' exists but has no pending approval. Nothing to abandon.`,
          "no-session": `No session '${sessionId}' exists. Nothing to abandon — run some code first.`,
        }[r.abandon(sessionId)];

        return {
          content: [{ type: "text" as const, text }],
          details: {},
        };
      },
    }),
  );
}
