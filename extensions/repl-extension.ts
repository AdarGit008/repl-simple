import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { maskSecrets, redact } from "../src/redact.js";
import { ReplRunner } from "../src/repl.js";
import type { RunTrace, TracedCall, TraceStatus } from "../src/repl.js";
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

/** The command that calls `ReplRunner.acceptPreamble()` (#198, decision 5). */
export const ACCEPT_PREAMBLE_COMMAND = "repl-accept-preamble";

// ── Approval dialog ──────────────────────────────────────────────

/**
 * The four answers to an approval dialog, in the order they are offered.
 *
 * Approve first because it is the common answer, deny second because it is
 * the safe one, "decide later" third because it is the one that needs
 * reading, and "deny remaining" last because it is the one that needs the
 * most: it refuses this call *and every gated call after it* in the same
 * `repl` / `repl_resume` call, without asking again (#35). They are constants
 * rather than inline strings because the choice comes back from `ui.select`
 * as the string itself: a typo in one of the two places would silently become
 * a denial. Exported for the same reason — a test that retyped them would be
 * pinning its own copy, not the dialog.
 */
export const APPROVE_CHOICE = "Approve — run this call";
export const DENY_CHOICE = "Deny — refuse this call";
export const LATER_CHOICE = "Decide later — keep it waiting";
export const DENY_REMAINING_CHOICE =
  "Deny remaining — refuse this and every later call in this run";

// ── Dialog cap (#35) ─────────────────────────────────────────────

/**
 * The most approval dialogs one `repl` or `repl_resume` call may open.
 *
 * One call once produced twenty dialogs back to back: the sandbox asks once
 * per gated call with no memory of having asked, and a `try/except
 * PermissionError` loop reaches the gate again after every denial. That is a
 * fatigue primitive — vary the command until the user clicks yes once — and
 * the answer is a bound, not a nicer dialog.
 *
 * Only dialogs actually opened count. A headless run, yolo mode and an
 * already-aborted turn answer before the counter, and a call served from the
 * replay cache never reaches the callback at all. Past the cap, every further
 * gated call in the same tool call is denied without a dialog and the result
 * tells the model why. The counter lives in the closure `makeOnApproval`
 * mints per tool call, so `repl_resume` starts a fresh count.
 *
 * Eight is small enough that one run cannot wear anyone down and large enough
 * for a snippet that legitimately touches several files; a user who wants more
 * is one `repl_resume` — or `/repl-approvals yolo` — away. Exported so a test
 * pins the number, not a copy of it.
 */
export const MAX_DIALOGS_PER_CALL = 8;

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
 *
 * This bound, and not the run's host wall clock, is what ends a dialog nobody
 * answers: the wait is not charged to `REPL_MAX_WALL_CLOCK_SECS` (see
 * `RunLimits` in src/types.ts), so the expiry arrives as the denial above
 * rather than as a run timeout. It follows that `0` leaves an unanswered
 * dialog — and the run's pooled worker — waiting until it is answered,
 * dismissed or aborted.
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

// ── The trace on `details` (#46) ─────────────────────────────────
//
// Every host-tool call a `repl` / `repl_resume` call made is reported on the
// tool result's `details` — the channel pi persists to the session file,
// emits over RPC and hands to `renderResult` — so a jailed read and a gated
// fetch are auditable after the fact instead of having to be believed. The
// runner hands over the calls verbatim (`ReplRunner.runWithTrace`); this is
// where they become display-safe, because `details` outlives the call: pi
// writes it to disk. Arguments are masked with the shared redaction helper
// and cut head-only; the built-in tools' own details are projected down to
// their facts; results, `stdout` and return values are never in the trace.
// Each call carries its place in the run (`seq`) and the byte of `stdout` at
// which it was dispatched (`stdoutOffset`), and `details` records where the
// stdout section of the result text lies, so the expanded view can put every
// call back where it happened (#69 finding 4, D144). Nothing about the
// model-facing text changes.

/** Byte ceiling on one call's rendered argument list, marker included. */
export const TRACE_ARGS_MAX_BYTES = 256;

/** Columns `TraceView` wraps at when pi hands it a width it cannot use. */
const DEFAULT_COLUMNS = 80;

/** A line the truncator wrote into `stdout`: the head before it is verbatim, nothing after it is positioned. */
const STDOUT_MARKER_LINE = /^\[… .* …\]$/m;

/** The separator `formatResult` puts between `stdout` and the value of an ok result. */
const RESULT_SEPARATOR = "\n[result]\n";

/** The heading `formatResult` puts before `stdout` on an error result. */
const STDOUT_HEADING = "\n\n[stdout]\n";

/** Most calls one `details` carries; the rest are counted, head-only. */
export const TRACE_MAX_CALLS = 1000;

/**
 * Characters of a string argument the renderer masks and shows. Nothing past
 * the first few hundred bytes can reach a line of `TRACE_ARGS_MAX_BYTES`, so a
 * 64 KiB `write` body is not masked whole — but the window is cut *after*
 * masking, never before, so no token is split by the cut (D114).
 */
const TRACE_LEAF_WINDOW = 4096;

/**
 * Characters dropped from the end of a windowed leaf after masking: longer
 * than any known token prefix plus the 16 characters masking needs to
 * recognise one, so a token that straddled the window's edge leaves no
 * prefix behind.
 */
const TRACE_LEAF_GUARD = 64;

/** Rendered characters after which the argument renderer stops descending. */
const TRACE_RENDER_CAP = 8192;

/** Nesting the renderer follows before writing `…`. */
const TRACE_DEPTH = 4;

const TRACE_ARGS_RECOVERY = "The trace keeps only the head of the arguments.";
const TRACE_ERROR_RECOVERY = "The trace keeps only the head of the error.";

/** One host-tool call as `details` carries it: display-safe, JSON-safe. */
export interface TraceCallView {
  tool: string;
  ok: boolean;
  /** `true` approved, `false` denied; absent for an ungated call. */
  approved?: boolean;
  durationMs: number;
  /** The argument list, rendered, masked and head-cut. */
  args: string;
  /** The failure, masked and head-cut. */
  error?: string;
  /** The built-in pi tool's own details, projected to their facts. */
  details?: unknown;
  /** The call's place in its run (`ToolCallTrace.seq`); absent on an entry restored from a dump. */
  seq?: number;
  /** The byte of the run's `stdout` at which the call was dispatched (`ToolCallTrace.stdoutOffset`). */
  stdoutOffset?: number;
}

/** Where the stdout section of a result's text lies, as `[start, end)` code-unit offsets. */
export interface StdoutSpan {
  start: number;
  end: number;
}

/** `details` on all four tools: the trace, or an empty one with the tool's own status. */
export interface ReplDetails {
  sessionId: string;
  status: TraceStatus | "reset" | "abandoned";
  calls: TraceCallView[];
  /** Calls past `TRACE_MAX_CALLS`, counted rather than listed. */
  omittedCalls: number;
  /** The call waiting for approval, when `status` is `suspended`. */
  suspendedCall?: { tool: string; args: string };
  /** The stdout section of the result text, when it has one (D144). */
  stdoutSpan?: StdoutSpan;
}

/**
 * Mask a string leaf whole, then window it.
 *
 * Masking runs over the whole window before anything is cut, so a token
 * inside it is replaced entire; a token straddling the window's end is
 * removed with the guard. Beyond the window the leaf is never looked at —
 * it cannot reach a 256-byte line.
 */
function maskLeaf(text: string): string {
  if (text.length <= TRACE_LEAF_WINDOW) return maskSecrets(text).text;
  const masked = maskSecrets(text.slice(0, TRACE_LEAF_WINDOW)).text;
  return masked.slice(0, Math.max(0, masked.length - TRACE_LEAF_GUARD));
}

/**
 * A Python-ish repr with a work cap.
 *
 * Strings in JSON quotes — the spelling the approval dialog already uses —
 * `None`, `True`, `False`, `{k: v}` for a dict (Monty hands one over as a
 * `Map`), `{…}` for a set, `<bytes n>` for bytes. Every string leaf is masked
 * on the way in. Rendering stops once the output is past `TRACE_RENDER_CAP`:
 * the line is cut to `TRACE_ARGS_MAX_BYTES` anyway, and a deep structure must
 * not cost more than that to show.
 */
class ArgRenderer {
  private readonly parts: string[] = [];
  private length = 0;

  get text(): string {
    return this.parts.join("");
  }

  get full(): boolean {
    return this.length > TRACE_RENDER_CAP;
  }

  push(text: string): void {
    if (this.full) return;
    this.parts.push(text);
    this.length += text.length;
  }

  value(value: unknown, depth: number): void {
    if (this.full) return;
    const scalar = this.scalar(value);
    if (scalar !== undefined) {
      this.push(scalar);
    } else if (depth >= TRACE_DEPTH) {
      this.push("…");
    } else if (Array.isArray(value)) {
      this.push("[");
      this.list(value, depth);
      this.push("]");
    } else if (value instanceof Set) {
      this.push("{");
      this.list([...value], depth);
      this.push("}");
    } else {
      this.push("{");
      this.entries(value instanceof Map ? [...value] : Object.entries(value as object), depth);
      this.push("}");
    }
  }

  /** The repr of a non-container, or `undefined` for a container. */
  private scalar(value: unknown): string | undefined {
    if (value === null || value === undefined) return "None";
    if (typeof value === "string") return JSON.stringify(maskLeaf(value));
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (value instanceof Uint8Array) return `<bytes ${value.byteLength}>`;
    if (typeof value !== "object") return `<${typeof value}>`;
    return undefined;
  }

  private list(items: unknown[], depth: number): void {
    items.forEach((item, i) => {
      if (i > 0) this.push(", ");
      this.value(item, depth + 1);
    });
  }

  private entries(entries: Array<[unknown, unknown]>, depth: number): void {
    entries.forEach(([key, value], i) => {
      if (i > 0) this.push(", ");
      this.value(key, depth + 1);
      this.push(": ");
      this.value(value, depth + 1);
    });
  }
}

/**
 * Render a call's argument list the way the approval dialog spells a call:
 * positional values, then `name=value` for keywords — masked, and cut
 * head-only at `TRACE_ARGS_MAX_BYTES` with a magnitude-free marker.
 */
export function viewArgs(args: readonly unknown[], kwargs: Record<string, unknown>): string {
  const renderer = new ArgRenderer();
  args.forEach((arg, i) => {
    if (i > 0) renderer.push(", ");
    renderer.value(arg, 0);
  });
  Object.entries(kwargs).forEach(([name, value], i) => {
    if (i > 0 || args.length > 0) renderer.push(", ");
    renderer.push(`${name}=`);
    renderer.value(value, 0);
  });
  return redact(renderer.text, { maxBytes: TRACE_ARGS_MAX_BYTES, recovery: TRACE_ARGS_RECOVERY })
    .text;
}

/** A free-text field of the trace — an error, a path — masked and head-cut. */
function viewText(text: string, recovery: string): string {
  return redact(text, { maxBytes: TRACE_ARGS_MAX_BYTES, recovery }).text;
}

/** The only keys of a built-in tool's details whose string value is carried. */
const DETAIL_STRING_KEYS = new Set(["fullOutputPath", "truncatedBy"]);

/** Nesting the projection follows into a built-in tool's details. */
const DETAIL_DEPTH = 3;

/**
 * Project a built-in tool's `details` down to its facts, fail-closed.
 *
 * Numbers, booleans and `null` survive anywhere; a string survives only
 * under a key known to hold a path or a label, masked and cut; everything
 * else — `TruncationResult.content`, which is the truncated body itself,
 * `edit`'s `diff` and `patch`, any string a future tool adds — is dropped.
 * Bodies never reach `details`. `undefined` when nothing is left.
 */
function viewDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || Array.isArray(value) || depth >= DETAIL_DEPTH) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string") {
      if (DETAIL_STRING_KEYS.has(key)) out[key] = viewText(inner, TRACE_ARGS_RECOVERY);
      continue;
    }
    const projected = viewDetails(inner, depth + 1);
    if (projected !== undefined) out[key] = projected;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function viewCall(call: TracedCall): TraceCallView {
  const view: TraceCallView = {
    tool: call.tool,
    ok: call.ok,
    durationMs: call.durationMs,
    args: viewArgs(call.args, call.kwargs),
  };
  if (call.approved !== undefined) view.approved = call.approved;
  if (call.error !== undefined) view.error = viewText(call.error, TRACE_ERROR_RECOVERY);
  const details = viewDetails(call.details);
  if (details !== undefined) view.details = details;
  if (Number.isFinite(call.seq)) view.seq = call.seq;
  if (Number.isFinite(call.stdoutOffset)) view.stdoutOffset = call.stdoutOffset;
  return view;
}

/**
 * The stdout section of a result's text, or `null` when it has none.
 *
 * Read off the shapes `formatResult` (`src/repl.ts`) produces: an ok result
 * is `stdout` then `\n[result]\n` then the value — the *last* separator is
 * the real one, since the value's repr never holds a raw newline followed by
 * `[result]` while printed text can hold anything; an error result puts
 * `stdout` last, after `\n\n[stdout]\n`; a suspension and the resume's early
 * returns carry no stdout. A discard notice (#129) precedes the body when the
 * trace says one was dropped: its description sits on its own line, one more
 * line follows, then a blank line — the section starts after that, and when
 * the notice cannot be found where the trace says it is, nothing is guessed.
 *
 * Best effort by construction: the text is what the model reads and a print
 * can imitate any of these markers. A wrong span misplaces trace lines in a
 * display; it never changes what ran or what the model was told.
 */
export function stdoutSpan(
  text: string,
  status: ReplDetails["status"],
  discarded?: { tool: string; description: string },
): StdoutSpan | null {
  let start = 0;
  if (discarded !== undefined) {
    const line = `\n${discarded.description}\n`;
    const at = text.indexOf(line);
    if (at < 0) return null;
    const blank = text.indexOf("\n\n", at + line.length - 1);
    if (blank < 0) return null;
    start = blank + 2;
  }
  if (status === "ok") {
    const separator = text.lastIndexOf(RESULT_SEPARATOR);
    return separator >= start ? { start, end: separator } : null;
  }
  if (status === "error") {
    const heading = text.indexOf(STDOUT_HEADING, start);
    return heading < 0 ? null : { start: heading + STDOUT_HEADING.length, end: text.length };
  }
  return null;
}

/** The `details` for a `repl` / `repl_resume` result: the trace, display-safe. */
export function buildDetails(trace: RunTrace): ReplDetails {
  const kept = trace.calls.slice(0, TRACE_MAX_CALLS);
  const details: ReplDetails = {
    sessionId: trace.sessionId,
    status: trace.status,
    calls: kept.map(viewCall),
    omittedCalls: trace.calls.length - kept.length,
  };
  if (trace.suspendedCall) {
    details.suspendedCall = {
      tool: trace.suspendedCall.tool,
      args: viewArgs(trace.suspendedCall.args, trace.suspendedCall.kwargs),
    };
  }
  const span = stdoutSpan(trace.text, trace.status, trace.discardedSuspension);
  if (span !== null) details.stdoutSpan = span;
  return details;
}

/** The `details` for a tool that ran no code: the same shape, nothing to list. */
function emptyDetails(sessionId: string, status: ReplDetails["status"]): ReplDetails {
  return { sessionId, status, calls: [], omittedCalls: 0 };
}

/** What a built-in tool's projected details add to a call's line. */
function detailNotes(details: unknown): string[] {
  if (details === null || typeof details !== "object") return [];
  const facts = details as Record<string, unknown>;
  const notes: string[] = [];
  const truncation = facts.truncation;
  if (truncation !== null && typeof truncation === "object") {
    const t = truncation as Record<string, unknown>;
    if (t.truncated === true) {
      notes.push(
        `output truncated${typeof t.truncatedBy === "string" ? ` by ${t.truncatedBy}` : ""}`,
      );
    }
  }
  if (typeof facts.fullOutputPath === "string") notes.push(`full output: ${facts.fullOutputPath}`);
  for (const [key, label] of [
    ["entryLimitReached", "entry limit"],
    ["matchLimitReached", "match limit"],
    ["resultLimitReached", "result limit"],
  ]) {
    if (typeof facts[key] === "number") notes.push(`${label} ${facts[key]}`);
  }
  if (facts.linesTruncated === true) notes.push("long lines cut");
  return notes;
}

function formatCall(call: TraceCallView): string {
  const approval = call.approved === true ? " approved" : call.approved === false ? " denied" : "";
  const error = call.error === undefined ? "" : ` — ${call.error}`;
  const notes = detailNotes(call.details)
    .map((note) => ` · ${note}`)
    .join("");
  const mark = call.ok ? "✓" : "✗";
  return `  ${mark} ${call.tool}(${call.args})${approval} ${Math.round(call.durationMs)}ms${error}${notes}`;
}

/**
 * The trace as lines: collapsed, one summary; expanded, one line per call,
 * the omitted count, and the call waiting for approval. Pure — the component
 * below is a container for what this returns.
 */
export function formatTrace(details: ReplDetails, options: { expanded: boolean }): string[] {
  const total = details.calls.length + details.omittedCalls;
  const waiting = details.suspendedCall;
  if (total === 0 && waiting === undefined) return ["[trace] no host-tool calls"];

  if (!options.expanded) {
    let ok = 0;
    let denied = 0;
    let failed = 0;
    for (const call of details.calls) {
      if (call.ok) ok++;
      else if (call.approved === false) denied++;
      else failed++;
    }
    const pending = waiting === undefined ? "" : `; ${waiting.tool} waiting for approval`;
    return [
      `[trace] ${total} host-tool call(s): ${ok} ok, ${denied} denied, ${failed} failed${pending} — expand to list them`,
    ];
  }

  return [
    `[trace] ${total} host-tool call(s)`,
    ...details.calls.map(formatCall),
    ...closingLines(details),
  ];
}

/** The lines that close an expanded trace: the omitted count and the call waiting for approval. */
function closingLines(details: ReplDetails): string[] {
  const lines: string[] = [];
  if (details.omittedCalls > 0) {
    lines.push(
      `  … ${details.omittedCalls} more call(s) not listed (trace capped at ${TRACE_MAX_CALLS})`,
    );
  }
  const waiting = details.suspendedCall;
  if (waiting !== undefined)
    lines.push(`  ⏸ ${waiting.tool}(${waiting.args}) waiting for approval`);
  return lines;
}

/**
 * The expanded view with every call put back where it happened (D144), or
 * `null` when the text has no stdout section to place anything in.
 *
 * Each call with an offset lands at that byte of the section: at a line
 * start, before the line; inside a line, after it — a call made in the middle
 * of a partially printed line is shown once the line completes; at the end,
 * after the last line. Only the verbatim head of a truncated stdout takes
 * calls: an offset at or past the truncator's marker line has no place in
 * what is shown. Whatever cannot be placed — no offset (an entry restored
 * from a dump), an offset past the head, a call past `TRACE_MAX_CALLS` — is
 * listed under the closing `[trace]` line as before.
 */
function interleave(
  text: string,
  details: ReplDetails,
): { lines: string[]; placed: number; unplaced: TraceCallView[] } | null {
  const span = details.stdoutSpan;
  if (
    span === undefined ||
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start ||
    span.end > text.length
  ) {
    return null;
  }
  const stdout = text.slice(span.start, span.end);
  const markerAt = stdout.search(STDOUT_MARKER_LINE);
  const head = markerAt < 0 ? stdout : stdout.slice(0, markerAt);

  // Byte offset → code-unit index, for offsets that land on a character
  // boundary of the head (the sandbox counts whole callbacks, so they do).
  // Walked per code point: an astral character is two code units but four
  // bytes, not the six that measuring each unit alone would count.
  const indexAtByte = new Map<number, number>([[0, 0]]);
  let byte = 0;
  let index = 0;
  for (const ch of head) {
    byte += Buffer.byteLength(ch, "utf8");
    index += ch.length;
    indexAtByte.set(byte, index);
  }

  const insertions: Array<{ at: number; text: string; seq: number }> = [];
  const unplaced: TraceCallView[] = [];
  for (const call of details.calls) {
    const index = call.stdoutOffset === undefined ? undefined : indexAtByte.get(call.stdoutOffset);
    if (index === undefined) {
      unplaced.push(call);
      continue;
    }
    const line = formatCall(call);
    const seq = call.seq ?? Number.MAX_SAFE_INTEGER;
    if (index === 0 || head[index - 1] === "\n") {
      insertions.push({ at: index, text: `${line}\n`, seq });
    } else {
      const newline = head.indexOf("\n", index);
      insertions.push({ at: newline < 0 ? head.length : newline, text: `\n${line}`, seq });
    }
  }
  insertions.sort((a, b) => a.at - b.at || a.seq - b.seq);

  let placed = "";
  let cursor = 0;
  for (const insertion of insertions) {
    placed += head.slice(cursor, insertion.at) + insertion.text;
    cursor = insertion.at;
  }
  placed += head.slice(cursor);
  const rendered =
    text.slice(0, span.start) + placed + stdout.slice(head.length) + text.slice(span.end);
  return { lines: rendered.split("\n"), placed: insertions.length, unplaced };
}

/**
 * The result view: pi's `Component` (`pi-tui/tui.d.ts:10-31`) implemented
 * structurally, because `@earendil-works/pi-tui` is nested under pi's own
 * install and not resolvable from here. It holds lines and wraps them to the
 * width; there is nothing to cache and nothing to invalidate.
 */
class TraceView {
  private lines: string[] = [];

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  render(width: number): string[] {
    // A width that is not a usable number — `NaN` made the wrap below grow
    // its output until the array length limit — renders at the default.
    const columns = Number.isFinite(width) && width >= 1 ? Math.floor(width) : DEFAULT_COLUMNS;
    const out: string[] = [];
    for (const line of this.lines) {
      let rest = [...line];
      if (rest.length === 0) out.push("");
      while (rest.length > 0) {
        if (rest.length <= columns) {
          out.push(rest.join(""));
          break;
        }
        // Break at the last space that fits, so a sentence wraps between
        // words; a run with no space in it breaks at the width.
        const space = rest.lastIndexOf(" ", columns);
        const cut = space > 0 ? space : columns;
        out.push(rest.slice(0, cut).join(""));
        rest = rest.slice(space > 0 ? cut + 1 : cut);
      }
    }
    return out;
  }

  invalidate(): void {
    // Nothing is cached: `render` reads the lines every time.
  }
}

/** Whether a result's `details` is a trace this extension built. */
function isReplDetails(details: unknown): details is ReplDetails {
  return (
    details !== null && typeof details === "object" && Array.isArray((details as ReplDetails).calls)
  );
}

/**
 * `renderResult` for the two tools that run code: the result text with the
 * calls placed in its stdout when expanded (D144), then the trace — the whole
 * of it collapsed, the rest of it expanded.
 */
function renderTrace(
  result: { content: Array<{ type: string; text?: string }>; details: unknown },
  options: { expanded: boolean },
  context: { lastComponent: unknown },
): TraceView {
  const view = context.lastComponent instanceof TraceView ? context.lastComponent : new TraceView();
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const body = text === "" ? [] : text.split("\n");
  const details = isReplDetails(result.details) ? result.details : undefined;
  const placed = details !== undefined && options.expanded ? interleave(text, details) : null;
  if (details === undefined || placed === null || placed.placed === 0) {
    view.setLines([...body, ...(details === undefined ? [] : formatTrace(details, options))]);
    return view;
  }
  const total = details.calls.length + details.omittedCalls;
  view.setLines([
    ...placed.lines,
    `[trace] ${total} host-tool call(s), ${placed.placed} shown in place`,
    ...placed.unplaced.map(formatCall),
    ...closingLines(details),
  ]);
  return view;
}

/**
 * The slice of pi's `ExtensionContext` a lifecycle handler here reads
 * (`types.d.ts:209-249`): the directory the runner is keyed by, the trust
 * decision, and a way to tell the user what a shutdown dropped.
 */
interface SessionLifecycleCtx {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

/** A `session_start` / `session_shutdown` handler, as pi's `on` accepts it. */
type SessionLifecycleHandler = (
  event: { reason: string },
  ctx: SessionLifecycleCtx,
) => void | Promise<void>;

/**
 * The slice of pi's `ExtensionCommandContext` a command here reads: the
 * directory and the trust decision, so `/repl-accept-preamble` reaches the
 * same runner a `repl` call would, and a way to answer.
 */
interface CommandCtx {
  cwd: string;
  isProjectTrusted(): boolean;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

/** Extension registration surface — the subset of pi's API this file uses. */
interface ReplExtensionApi {
  registerTool: (tool: ReturnType<typeof defineTool>) => void;
  registerCommand: (
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: CommandCtx) => Promise<void>;
    },
  ) => void;
  /**
   * Lifecycle events (`ExtensionAPI.on`, `types.d.ts:869` / `:875`).
   * `session_start` fires when a conversation begins — startup, reload,
   * `/new`, `/resume`, `/fork` — and `session_shutdown` before its runtime is
   * torn down — quit, reload, `/new`, `/resume`, `/fork`.
   */
  on(event: "session_start", handler: SessionLifecycleHandler): void;
  on(event: "session_shutdown", handler: SessionLifecycleHandler): void;
}

// ── Runner per working directory (#60) ───────────────────────────

/**
 * A `ReplRunner` for one working directory, with the state the extension
 * keeps beside it.
 *
 * `trusted` is Pi's project-trust decision as of the most recent event for
 * this directory. The runner reads it through a closure rather than
 * receiving a boolean, because the runner outlives the `ctx` that built it
 * and the decision can change while pi runs — trusting a project
 * mid-session, or withdrawing it, has to reach the next `repl` call (#53).
 * `false` until a real `ctx` has been seen, which is the same fail-closed
 * default `ReplRunner` applies for callers that pass nothing.
 *
 * `sessionIds` is every id a `repl` call has handed the runner. `ReplRunner`
 * offers no way to list its sessions, and a shutdown has to abandon and
 * release each one to say what it dropped.
 *
 * `waiting` is the tool each suspended session is holding a call for, read
 * off the trace API's suspended result and kept until that suspension is
 * over — so the shutdown report can name it (D146). The name only: the
 * arguments can hold a pasted credential, which is why `GrantSummary` omits
 * them too.
 */
class CwdRunner {
  trusted = false;
  readonly runner: ReplRunner;
  readonly sessionIds = new Set<string>();
  private readonly waiting = new Map<string, string>();

  constructor(cwd: string) {
    this.runner = new ReplRunner(cwd, { isProjectTrusted: () => this.trusted });
  }

  /** Remember what a `repl` / `repl_resume` call left waiting, or that nothing is. */
  noteOutcome(sessionId: string, trace: RunTrace): void {
    const tool = trace.status === "suspended" ? trace.suspendedCall?.tool : undefined;
    if (tool === undefined) this.waiting.delete(sessionId);
    else this.waiting.set(sessionId, tool);
  }

  /** The suspension is over by another route: `repl_reset`, `repl_abandon`. */
  forget(sessionId: string): void {
    this.waiting.delete(sessionId);
  }

  /**
   * Abandon and release every session this runner was handed.
   *
   * @returns the sessions that were holding a call for approval, with the
   *          tool's name — each is a call that never executed and that
   *          somebody was asked about. A suspension only ever arrives through
   *          the two tools that call `noteOutcome`, so an abandoned session
   *          always has a name here.
   */
  dispose(): Array<{ sessionId: string; tool: string }> {
    const dropped: Array<{ sessionId: string; tool: string }> = [];
    for (const sessionId of this.sessionIds) {
      const tool = this.waiting.get(sessionId);
      if (this.runner.abandon(sessionId) === "abandoned" && tool !== undefined) {
        dropped.push({ sessionId, tool });
      }
      this.runner.reset(sessionId);
    }
    this.sessionIds.clear();
    this.waiting.clear();
    return dropped;
  }
}

// ── Approval gate ────────────────────────────────────────────────

/**
 * The approval callback minted for one `repl` / `repl_resume` call, and the
 * explanation for the model when it denied calls without opening a dialog.
 */
interface ApprovalGate {
  onApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** `undefined` while every denial this call made was one the user gave. */
  notice(): string | undefined;
}

/** Append the gate's explanation, when it has one, to what the runner returned. */
function withApprovalNotice(text: string, gate: ApprovalGate): string {
  const notice = gate.notice();
  return notice === undefined ? text : `${text}\n\n${notice}`;
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
 * Two commands:
 * - `/repl-approvals [strict|yolo]` — read or set the approval mode
 * - `/repl-accept-preamble` — accept the saved tools as they are now (#198)
 *
 * And two lifecycle handlers, `session_start` and `session_shutdown`, that
 * bind every REPL session to the Pi conversation that created it (#60).
 *
 * Every tool result carries the trace of the host-tool calls it made on
 * `details`, and the two tools that run code render it (#46).
 */
export default function (pi: ReplExtensionApi) {
  let approvalMode: ApprovalMode = "strict";

  /**
   * One runner per working directory, for the current Pi conversation.
   *
   * Keyed by `ctx.cwd` (#60): a conversation that spans directories gets a
   * runner rooted at each — the path jail, the preamble root and the bridge
   * tools all point where the call was made — instead of one runner rooted
   * wherever the first call happened to be. Construction waits for the first
   * event that carries a `ctx` (`session_start`, or a tool call); `ctx.cwd` is
   * not available at module load. Emptied by `session_shutdown`.
   */
  const runners = new Map<string, CwdRunner>();

  function getRunner(ctx: { cwd: string; isProjectTrusted(): boolean }): CwdRunner {
    let entry = runners.get(ctx.cwd);
    if (!entry) {
      entry = new CwdRunner(ctx.cwd);
      runners.set(ctx.cwd, entry);
    }
    // Refreshed on the way in, every time — see `CwdRunner.trusted`.
    entry.trusted = ctx.isProjectTrusted();
    return entry;
  }

  /**
   * Build the approval gate for one tool call, on Pi's native select dialog.
   *
   * Four answers. `confirm` offers two and cannot distinguish Escape from
   * "No" — `showExtensionConfirm` returns `result === "Yes"`, so cancel,
   * timeout and abort all arrive as a denial — and the third answer the
   * sandbox already understands, `"suspend"`, had nowhere to come from (#51).
   * A `select` can say all of them and can tell a dismissal from an answer.
   * The fourth, "deny remaining", is the way out of a queue of dialogs (#35).
   *
   * `signal` is the abort signal for the tool call the approval belongs to. It
   * is handed to the dialog so that Escape dismisses it and the promise
   * settles, rather than leaving a dialog nobody can answer and a tool nobody
   * can stop (#49).
   *
   * The gate is per call: the counter behind `MAX_DIALOGS_PER_CALL` and the
   * "deny remaining" latch live in this closure and die with it, so
   * `repl_resume` starts clean and neither can become a remembered
   * preference. Both only ever reduce what gets approved.
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
  ): ApprovalGate {
    /** Dialogs this call has opened. Only a `ctx.ui.select` call counts. */
    let opened = 0;
    /**
     * Why gated calls are being denied without a dialog, once they are: the
     * cap was reached, or the user answered "deny remaining". Set once, never
     * cleared — the closure is one call's, so the latch is too.
     */
    let closed: "cap" | "deny-remaining" | null = null;
    /** Gated calls denied without a dialog since `closed` was set. */
    let deniedUnasked = 0;

    const onApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      // Fail closed first, and before the mode is consulted. `yolo` is set by
      // a human at a terminal; a headless run has nobody who could have set
      // it and nobody watching what it approves, so it stays denied either
      // way. This ordering is what `extension.test.ts` pins.
      if (!ctx.hasUI) return false;
      if (approvalMode === "yolo") return true;
      // An already-aborted turn has nobody left to ask: opening a dialog here
      // would put one on screen after the user has said stop.
      if (signal?.aborted) return false;

      // The bound (#35): reached when a dialog *past* the cap would open — a
      // run that opens exactly the cap is not capped — or latched below by the
      // user's fourth answer. Either way the sandbox sees a plain denial and
      // Python a PermissionError; `notice()` is how the reason reaches the
      // model, so it does not read the errors as bad luck and retry.
      if (closed === null && opened >= MAX_DIALOGS_PER_CALL) closed = "cap";
      if (closed !== null) {
        deniedUnasked++;
        return false;
      }

      opened++;
      const choice = await ctx.ui.select(
        `Allow ${req.description}? (dialog ${opened} of ${MAX_DIALOGS_PER_CALL})`,
        [APPROVE_CHOICE, DENY_CHOICE, LATER_CHOICE, DENY_REMAINING_CHOICE],
        { signal, timeout: approvalTimeoutMs() },
      );

      if (choice === APPROVE_CHOICE) return true;
      if (choice === LATER_CHOICE) return "suspend";
      // The fourth answer denies this call exactly as the second does, and
      // latches the closure so nothing after it asks (#35).
      if (choice === DENY_REMAINING_CHOICE) closed = "deny-remaining";
      // `undefined` is Escape, the timeout, or the abort — no answer at all.
      // It denies, deliberately: the one property that must not regress is
      // that a call nobody approved does not run. "Decide later" is the
      // answer for a user who wants to keep the call alive, and it is on
      // screen next to this one, so a dismissal does not have to carry that
      // meaning as well.
      return false;
    };

    const notice = (): string | undefined => {
      if (closed === "cap") {
        return (
          `[approval cap] This call opened ${MAX_DIALOGS_PER_CALL} approval dialogs, the most ` +
          `one repl or repl_resume call may open, and ${deniedUnasked} later gated call(s) were ` +
          "denied without asking (each raised PermissionError). The count restarts on the next " +
          "repl or repl_resume call. Do not simply retry: ask the user how to proceed, or make " +
          "fewer gated calls."
        );
      }
      if (closed === "deny-remaining") {
        // Chosen at the last gated call: the answer refused that call, and
        // there was nothing after it to refuse — say so, rather than count
        // zero later calls.
        if (deniedUnasked === 0) {
          return (
            `[approvals denied] The user chose "Deny remaining" at an approval dialog; it was ` +
            "the last gated call in this run, so nothing else was denied. Do not retry it — " +
            "ask the user how to proceed."
          );
        }
        return (
          `[approvals denied] The user chose "Deny remaining" at an approval dialog, so ` +
          `${deniedUnasked} later gated call(s) in this call were denied without asking (each ` +
          "raised PermissionError). Do not retry them — ask the user how to proceed."
        );
      }
      return undefined;
    };

    return { onApproval, notice };
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

  // ── /repl-accept-preamble (#198, decision 5) ───────────────
  //
  // A trusted project's saved tools are checked against the set the trust
  // decision covered; a file added or changed since is withheld until the
  // set is accepted again. `save_tool` re-saves one under its own dialog;
  // this is the user's word for the whole current set. It goes through
  // `getRunner` so the trust cell is refreshed on the way in, and prints one
  // line per outcome — nothing is accepted silently, and nothing is refused
  // without its reason.

  pi.registerCommand(ACCEPT_PREAMBLE_COMMAND, {
    description:
      "Accept the project's saved tools (.pi/code-tools) as they are now, so files added or " +
      "changed since the project was trusted load in new sessions.",
    handler: async (_args, ctx) => {
      const outcome = await getRunner(ctx).runner.acceptPreamble();
      switch (outcome.status) {
        case "accepted": {
          const names = outcome.accepted.length === 0 ? "(none)" : outcome.accepted.join(", ");
          ctx.ui.notify(
            `repl: accepted ${outcome.accepted.length} saved tool(s) as the current set: ${names}. ` +
              `Recorded in ${outcome.manifestPath}. Live sessions keep the preamble they were ` +
              "built with — run repl with a new sessionId to load the accepted set.",
            "info",
          );
          return;
        }
        case "untrusted":
          ctx.ui.notify(
            "repl: this project is not trusted, so its saved tools were not read and nothing " +
              "was accepted. Trust the project in pi first.",
            "warning",
          );
          return;
        case "refused": {
          const offenders = outcome.refused
            .map((r) => `${r.file} binds ${r.symbols.map((s) => `'${s}'`).join(", ")}`)
            .join("; ");
          ctx.ui.notify(
            `repl: the preamble was refused and nothing was accepted: ${offenders} — those names ` +
              `are host tools. Fix the file(s), then run /${ACCEPT_PREAMBLE_COMMAND} again.`,
            "error",
          );
          return;
        }
        case "store-unavailable":
          ctx.ui.notify(
            `repl: the accepted-set manifest could not be written (${outcome.reason}); nothing ` +
              "was accepted. Set REPL_PREAMBLE_STORE_DIR to a writable directory outside the " +
              "project.",
            "error",
          );
          return;
        case "unreadable":
          ctx.ui.notify(
            `repl: .pi/code-tools could not be read (${outcome.reason}); nothing was accepted ` +
              "and the accepted set was left as it was.",
            "error",
          );
          return;
      }
    },
  });

  // ── Session lifecycle (#60) ────────────────────────────────
  //
  // Sessions belong to one Pi conversation. Pi emits `session_shutdown`
  // before it tears a conversation's runtime down (`/new`, `/resume`,
  // `/fork`, reload, quit) and `session_start` when the next one begins.
  // Without these, REPL state lived in the extension closure for the life of
  // the process — the next conversation could inherit variables, imports and
  // a pending approval from the last one, with nothing saying so.
  //
  // Pi 0.84.1 also re-runs this factory for every conversation
  // (`loader.js:407-409`), so `runners` is fresh either way. The shutdown
  // handler is the contract regardless of that detail: the disposal is
  // explicit, and a pending approval is reported rather than garbage-collected.

  pi.on("session_start", (_event, ctx) => {
    // The conversation's runner exists from its first event. Constructing a
    // `ReplRunner` reads no file and runs no code: sessions — and the
    // saved-tool preamble, which runs at session creation — are created only
    // by `repl`, after `isProjectTrusted()` has been consulted for that call.
    getRunner(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Idempotent by construction: a second shutdown finds nothing to dispose.
    for (const entry of runners.values()) {
      for (const { sessionId, tool } of entry.dispose()) {
        // The session id and the tool's name, nothing else. The approval
        // description can hold a pasted credential, which is why
        // `GrantSummary` omits it too.
        ctx.ui.notify(
          `repl: session '${sessionId}' still had a '${tool}' call waiting for approval when ` +
            "this conversation ended. It was dropped and never executed; nothing was approved.",
          "warning",
        );
      }
    }
    runners.clear();
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
        "with no pause points runs until the duration limit (maxDurationSecs). " +
        `One repl or repl_resume call opens at most ${MAX_DIALOGS_PER_CALL} approval ` +
        "dialogs; gated calls past that are denied and the result says why. " +
        "The sessionId is scoped to this Pi session: when the conversation ends " +
        "(/new, /resume, /fork, quit) every REPL session is disposed, a pending approval " +
        "is dropped, and the same sessionId in the next conversation is a new, empty REPL.",
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
              "Maximum interpreter compute time in seconds, capped at 300, or lower if the " +
              "operator sets REPL_MAX_DURATION_SECS (default 30). " +
              "Omitted uses the sandbox default (30).",
          }),
        ),
        maxMemory: Type.Optional(
          Type.Number({
            description:
              "Maximum sandbox heap in MiB, capped at 1024, or lower if the operator sets " +
              "REPL_MAX_MEMORY_MB (default 512 MiB). " +
              "Omitted uses the sandbox default (512 MiB).",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const entry = getRunner(ctx);
        const sessionId = params.sessionId ?? "default";
        // The only tool that creates sessions, so the only place the runner
        // learns an id it will have to dispose (#60).
        entry.sessionIds.add(sessionId);
        const gate = makeOnApproval(ctx, signal);
        const trace = await entry.runner.runWithTrace(
          params.code,
          sessionId,
          gate.onApproval,
          signal,
          clampModelLimits(params.maxDurationSecs, params.maxMemory),
        );
        entry.noteOutcome(sessionId, trace);
        return {
          content: [{ type: "text" as const, text: withApprovalNotice(trace.text, gate) }],
          details: buildDetails(trace),
        };
      },
      renderResult(result, options, _theme, context) {
        return renderTrace(result, options, context);
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
        // A fresh gate, so the dialog count restarts here (#35).
        const gate = makeOnApproval(ctx, signal);
        const entry = getRunner(ctx);
        const sessionId = params.sessionId ?? "default";
        const trace = await entry.runner.resumeWithTrace(sessionId, gate.onApproval, signal);
        entry.noteOutcome(sessionId, trace);
        return {
          content: [{ type: "text" as const, text: withApprovalNotice(trace.text, gate) }],
          details: buildDetails(trace),
        };
      },
      renderResult(result, options, _theme, context) {
        return renderTrace(result, options, context);
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
        const entry = getRunner(ctx);
        const { existed, revoked } = entry.runner.reset(sessionId);
        // Reset evicts the session, so there is nothing left to dispose.
        entry.sessionIds.delete(sessionId);
        entry.forget(sessionId);

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
          details: emptyDetails(sessionId, existed ? "reset" : "no-session"),
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
        const entry = getRunner(ctx);
        const sessionId = params.sessionId ?? "default";

        // Three states, three sentences. "No pending suspension" for a
        // session that does not exist reads as a bug report about the one
        // the caller meant, and the two states need different next moves:
        // one is "run some code", the other is "the pause is over" (#48).
        const outcome = entry.runner.abandon(sessionId);
        entry.forget(sessionId);
        const text = {
          abandoned: `Suspension in session '${sessionId}' abandoned. The suspended code was dropped; the session is ready for new code.`,
          "nothing-pending": `Session '${sessionId}' exists but has no pending approval. Nothing to abandon.`,
          "no-session": `No session '${sessionId}' exists. Nothing to abandon — run some code first.`,
        }[outcome];

        return {
          content: [{ type: "text" as const, text }],
          details: emptyDetails(sessionId, outcome),
        };
      },
    }),
  );
}
