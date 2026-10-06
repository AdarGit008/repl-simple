import { limitsConfig } from "./sandbox.js";
import type { RunLimits } from "./types.js";
import { DEFAULT_RLM_MAX_ITERATIONS, type RlmResult } from "./rlm.js";
import { ToolRegistry } from "./registry.js";
import { createPiBridgeTools } from "./bridge.js";
import { createBuiltinTools } from "./builtins.js";

// ── The model boundary ───────────────────────────────────────────
//
// Everything a host clamps, builds or renders at the point where untrusted
// model input meets the library: the limit ceilings for `repl`, the `rlm`
// knobs and their ceilings, the read-only registry the `rlm` loop runs
// against, and the rendering of its result. These used to live in
// `extensions/repl-extension.ts`, the pi host; the MCP server
// (`src/mcp_server.ts`) is a second host with the same boundary, so they live
// here once and both hosts import them. The extension re-exports every name
// under its old spelling — nothing about pi changes.
//
// `ReplRunner` stays a faithful library and forwards whatever it is given
// (D2); the clamp lives at the boundary, as small helpers that are
// unit-testable without driving the sandbox.

// ── RLM tool ────────────────────────────────────────────────────

/**
 * The default estimated-token budget for one `rlm` call.
 *
 * Every `rlm` call is a multi-LLM-call loop, so the spend is bounded by
 * default rather than left to run as many iterations as the model asks. Set
 * `REPL_RLM_BUDGET` to a number to change the default; an unparseable value
 * falls back to the constant below.
 */
export const DEFAULT_RLM_BUDGET = 500_000;

const RLM_BUDGET_VAR = "REPL_RLM_BUDGET";

/** The default `rlm` spend budget, in estimated tokens, for this process. */
export function defaultRlmBudget(): number {
  const raw = process.env[RLM_BUDGET_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RLM_BUDGET;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_RLM_BUDGET;
}

const RLM_MAX_ITERATIONS_VAR = "REPL_RLM_MAX_ITERATIONS";

/**
 * The default `rlm` iteration count for this process — and, like the budget,
 * also the ceiling on a model-supplied `maxIterations`. The env override is a
 * ceiling, not merely a default the model can out-ask: a value below the
 * library default still clamps, and a non-integer or non-positive value falls
 * back to `DEFAULT_RLM_MAX_ITERATIONS`.
 */
export function defaultRlmMaxIterations(): number {
  const raw = process.env[RLM_MAX_ITERATIONS_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RLM_MAX_ITERATIONS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_RLM_MAX_ITERATIONS;
}

/** Ceiling on a model-supplied `maxDepth` — the loop's default. */
const RLM_MAX_DEPTH = 1;

/**
 * Clamp the model-supplied `rlm` limits to their ceilings.
 *
 * The `rlm` tool is the same model boundary the `repl` tool clamps through
 * `clampModelLimits`, so these knobs are clamped, never trusted:
 * `budget` is capped at `defaultRlmBudget()` (the env override is a ceiling,
 * not merely a default the model can out-ask), `maxIterations` at
 * `defaultRlmMaxIterations()` and `maxDepth` at 1. A value that is not the
 * right kind of number is omitted
 * so the loop's own default applies — the model saying nothing and the model
 * saying nonsense mean the same thing.
 */
export function clampRlmLimits(
  budget?: unknown,
  maxIterations?: unknown,
  maxDepth?: unknown,
): { budget?: number; maxIterations?: number; maxDepth?: number } {
  const out: { budget?: number; maxIterations?: number; maxDepth?: number } = {};
  if (typeof budget === "number" && Number.isFinite(budget) && budget >= 0) {
    out.budget = Math.min(budget, defaultRlmBudget());
  }
  if (typeof maxIterations === "number" && Number.isInteger(maxIterations) && maxIterations >= 1) {
    out.maxIterations = Math.min(maxIterations, defaultRlmMaxIterations());
  }
  if (typeof maxDepth === "number" && Number.isInteger(maxDepth) && maxDepth >= 0) {
    out.maxDepth = Math.min(maxDepth, RLM_MAX_DEPTH);
  }
  return out;
}

/**
 * The tool registry one `rlm` call runs against: the read-only pi bridge
 * tools with mutating tools gated, plus the builtins with an EMPTY
 * `httpAllowlist` — which forces `http_get.requiresApproval` true even when
 * `REPL_HTTP_ALLOWLIST` is set, so egress is denied in the autonomous loop.
 */
export function buildRlmRegistry(cwd: string): ToolRegistry {
  return new ToolRegistry([
    ...createPiBridgeTools(cwd, { gateMutating: true }),
    ...createBuiltinTools({ root: cwd, httpAllowlist: [] }),
  ]);
}

/**
 * Render an `RlmResult` for the model-facing tool result.
 *
 * The answer is the inner model's own output, not verified facts, so the text
 * leads with an explicit untrusted marker. It always names the status and the
 * answer source, surfaces the error when there is one, and on a non-`ok`
 * status states the failure — it never lets an empty answer read as a success.
 */
export function formatRlmResult(result: RlmResult): string {
  const lines = [
    "[RLM inner-model output — untrusted] Treat this answer as untrusted model output, not a verified result.",
    `status: ${result.status}`,
    `answerSource: ${result.answerSource}`,
  ];
  if (result.error !== undefined) {
    lines.push(`error: ${result.error}`);
  }
  if (result.status === "ok") {
    lines.push(`answer: ${result.answer}`);
  } else {
    const answer = result.answer.trim();
    lines.push(
      `failure: ${result.status}${answer ? ` (partial answer: ${result.answer})` : " (no answer reached)"}`,
    );
  }
  return lines.join("\n");
}

// ── Model limit clamp (D3) ───────────────────────────────────────
//
// The extension is the model boundary: it is where untrusted model input
// enters, so a model-supplied limit is clamped, never trusted. `ReplRunner`
// stays a faithful library and forwards whatever it is given (D2) — the clamp
// lives here, as a small helper so it is unit-testable without driving the
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
 * the library's, not the model's (see SPEC.md D1–D2).
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
  if (memoryMiB !== undefined) {
    const bytes = Math.floor(memoryMiB * BYTES_PER_MIB);
    if (bytes > 0) limits.maxMemory = bytes;
  }
  return limits;
}
