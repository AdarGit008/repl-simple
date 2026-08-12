/**
 * The one truncator.
 *
 * Every model-facing field that can grow without bound — `stdout`, `output`,
 * and the `builtins` file/HTTP reads — is cut here, by this code, so the three
 * sites cannot drift apart again. The policy it implements is recorded in
 * `docs/truncation-policy.md`; that document is normative and this module is
 * what asserts against it.
 *
 * The invariants, restated because they are what the tests check:
 *
 * 1. **The budget is a ceiling, marker included.** `byteLength(result) <=
 *    maxBytes`, always. The marker's cost comes out of the payload.
 * 2. **Never split a character.** Cuts land on UTF-8 boundaries. Truncation
 *    never introduces U+FFFD, and never exceeds the budget to avoid it.
 * 3. **Prefer not to split a line**, when a newline is close to the cut.
 * 4. **One implementation** — this file.
 * 5. **Counters keep counting.** The marker's totals are the true totals, not
 *    the totals of what survived.
 */

// ── Budgets ──────────────────────────────────────────────────────

/** Byte ceiling for `stdout`. */
export const STDOUT_MAX_BYTES = 32 * 1024;

/** Byte ceiling for `output` / `[result]`. */
export const OUTPUT_MAX_BYTES = 16 * 1024;

/** Line ceiling for `stdout`. Bytes are the MUST; this is the SHOULD. */
export const STDOUT_MAX_LINES = 1000;

/**
 * Share of the payload budget given to the head.
 *
 * `stdout` is chronological and its payload usually sits at the end — the last
 * print before an exception, the final tally after a loop — but a pure tail
 * discards what the stream *was*. 25/75 keeps enough head to identify it.
 */
export const STDOUT_HEAD_RATIO = 0.25;

/**
 * A single value is identified by both ends at once: `[1, 2, 3, … , 998, 999]`
 * gives the type, the element shape and the extent. A head-only cut of a long
 * list looks exactly like a short list.
 */
export const VALUE_HEAD_RATIO = 0.5;

/** Head-only: everything to the head, nothing kept from the tail. */
export const HEAD_ONLY_RATIO = 1;

// ── Recovery clauses ─────────────────────────────────────────────
//
// Truncation is an affordance, not a dead end: every marker names a route to
// the rest. See Q3 of the policy.

export const STDOUT_RECOVERY = "Re-run with a narrower print to see more.";
/**
 * Deliberately *not* "the value is still bound as `_`". Measured: `_` is
 * usable only when declared as an input or assigned, and wiring it through
 * `Session` would break replay — a stored snippet referencing `_` re-executes
 * against whatever `_` holds later, not what it held then. Assigning the
 * expression to a name is a route that is true today.
 */
export const VALUE_RECOVERY = "Assign the value to a name and slice it to see more.";
export const FILE_RECOVERY = "Read a narrower slice of the file to see more.";
export const HTTP_RECOVERY = "Request a narrower range to see more.";

// ── Internals ────────────────────────────────────────────────────

/** Snap a cut back to a line boundary when one is this close to it. */
const LINE_SNAP_RATIO = 0.2;

const NEWLINE = 0x0a;

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function countNewlines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** True when `buf[i]` is a UTF-8 continuation byte (`0b10xxxxxx`). */
function isContinuation(buf: Buffer, i: number): boolean {
  return (buf[i] & 0xc0) === 0x80;
}

/**
 * End index of the longest prefix of `buf` that fits `maxBytes` without
 * splitting a character, snapped back to a line boundary when one is near.
 */
function headEnd(buf: Buffer, maxBytes: number): number {
  if (buf.length <= maxBytes) return buf.length;
  if (maxBytes <= 0) return 0;
  let end = maxBytes;
  while (end > 0 && isContinuation(buf, end)) end--;
  const nl = end > 0 ? buf.lastIndexOf(NEWLINE, end - 1) : -1;
  if (nl >= 0 && end - (nl + 1) <= Math.floor(maxBytes * LINE_SNAP_RATIO)) {
    return nl + 1;
  }
  return end;
}

/**
 * Start index of the longest suffix of `buf` that fits `maxBytes` without
 * splitting a character, snapped forward to a line boundary when one is near.
 */
function tailStart(buf: Buffer, maxBytes: number): number {
  if (maxBytes <= 0) return buf.length;
  if (buf.length <= maxBytes) return 0;
  let start = buf.length - maxBytes;
  while (start < buf.length && isContinuation(buf, start)) start++;
  const nl = buf.indexOf(NEWLINE, start);
  if (nl >= 0 && nl + 1 - start <= Math.floor(maxBytes * LINE_SNAP_RATIO)) {
    return nl + 1;
  }
  return start;
}

/**
 * Decode a byte range as UTF-8, discarding any partial character at either
 * edge rather than emitting U+FFFD for it.
 *
 * Needed wherever a caller slices bytes it did not choose the boundaries of —
 * `read_file` seeking to a file's tail, for instance.
 */
export function decodeWhole(buf: Buffer): string {
  let start = 0;
  while (start < buf.length && isContinuation(buf, start)) start++;
  // Walk back over a trailing lead byte whose continuation bytes were cut off.
  let end = buf.length;
  let scan = end - 1;
  while (scan >= start && isContinuation(buf, scan)) scan--;
  if (scan >= start) {
    const lead = buf[scan];
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
    if (scan + width > end) end = scan;
  }
  return buf.subarray(start, end).toString("utf8");
}

/** Keep at most `maxLines` lines from the start of `text`. */
function capHeadLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  let seen = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    seen++;
    if (seen === maxLines) return text.slice(0, i + 1);
  }
  return text;
}

/** Keep at most `maxLines` lines from the end of `text`. */
function capTailLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  // A trailing newline terminates the last line rather than starting a new one.
  const searchFrom = text.endsWith("\n") ? text.length - 2 : text.length - 1;
  let seen = 0;
  for (let i = text.lastIndexOf("\n", searchFrom); i !== -1; i = text.lastIndexOf("\n", i - 1)) {
    seen++;
    if (seen === maxLines) return text.slice(i + 1);
    if (i === 0) break;
  }
  return text;
}

/** pi's size format, so the two agree when they share a context window. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Truncator ────────────────────────────────────────────────────

export interface TruncatorOptions {
  /** Hard byte ceiling on the rendered result, marker included. */
  maxBytes: number;
  /** Share of the payload budget given to the head. See the ratio constants. */
  headRatio: number;
  /** Recovery clause in the marker — how the reader gets at the rest. */
  recovery: string;
  /**
   * Report a line range in the marker, and enforce `maxLines`. For streams;
   * meaningless for a single value.
   */
  maxLines?: number;
  /**
   * The true byte total, when the caller knows it but will not push all of it —
   * `read_file` stats the file and then reads only its two ends.
   */
  totalBytes?: number;
  /**
   * Set when the caller stopped reading early and cannot know the total. The
   * marker then states where it cut instead of how much it dropped, because
   * invariant 5 forbids inventing a total.
   */
  unknownTotal?: boolean;
  /** Seed the truncated flag — carried across a suspend/resume boundary. */
  truncatedBefore?: boolean;
}

/**
 * Accumulates text and renders it head + tail with an elided middle.
 *
 * Streaming-safe and memory-bounded: while the content fits the budget it is
 * held whole, and the moment it does not, it collapses to a frozen head plus a
 * ring of recent chunks. Nothing between them is retained — but the counters
 * keep counting, so the marker can state the true magnitude of what went.
 */
export class Truncator {
  private readonly maxBytes: number;
  private readonly headRatio: number;
  private readonly recovery: string;
  private readonly maxLines: number;
  private readonly countLines: boolean;
  private readonly unknownTotal: boolean;
  private readonly declaredTotal?: number;

  /** The whole text, while it still fits. */
  private buffer = "";
  /** The frozen head, once it does not. */
  private head = "";
  /** Recent chunks, bounded by the tail budget. */
  private tailChunks: string[] = [];
  private tailBytes = 0;

  private overflowed: boolean;
  private hasSpilled = false;
  private pushedBytes = 0;
  private newlines = 0;
  private endsWithNewline = true;

  constructor(opts: TruncatorOptions) {
    this.maxBytes = Math.max(0, opts.maxBytes);
    this.headRatio = opts.headRatio;
    this.recovery = opts.recovery;
    this.maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY;
    this.countLines = opts.maxLines !== undefined;
    this.unknownTotal = opts.unknownTotal ?? false;
    this.declaredTotal = opts.totalBytes;
    this.overflowed = opts.truncatedBefore ?? false;
  }

  /** True byte total seen, whether or not it was retained. */
  get totalBytes(): number {
    return this.declaredTotal ?? this.pushedBytes;
  }

  /** True line total seen. */
  get totalLines(): number {
    if (this.pushedBytes === 0) return 0;
    return this.newlines + (this.endsWithNewline ? 0 : 1);
  }

  get truncated(): boolean {
    return this.overflowed || this.overBudget();
  }

  private overBudget(): boolean {
    return this.totalBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  private get tailBudget(): number {
    return this.maxBytes - Math.floor(this.maxBytes * this.headRatio);
  }

  push(text: string): void {
    if (!text) return;
    this.pushedBytes += byteLength(text);
    this.newlines += countNewlines(text);
    this.endsWithNewline = text.endsWith("\n");

    if (!this.hasSpilled) {
      this.buffer += text;
      if (this.overBudget()) this.spill();
      return;
    }
    this.pushTail(text);
  }

  /** Collapse the whole-text buffer into a frozen head plus a tail ring. */
  private spill(): void {
    this.overflowed = true;
    this.hasSpilled = true;
    const buf = Buffer.from(this.buffer, "utf8");
    const end = headEnd(buf, Math.floor(this.maxBytes * this.headRatio));
    this.head = buf.subarray(0, end).toString("utf8");
    this.buffer = "";
    this.tailChunks = [];
    this.tailBytes = 0;
    this.pushTail(buf.subarray(end).toString("utf8"));
  }

  private pushTail(text: string): void {
    if (!text) return;
    let chunk = text;
    const budget = this.tailBudget;
    if (byteLength(chunk) > budget) {
      // A single chunk larger than the whole tail budget: keep only its end,
      // and drop everything before it — it is all older than what we keep.
      const buf = Buffer.from(chunk, "utf8");
      chunk = buf.subarray(tailStart(buf, budget)).toString("utf8");
      this.tailChunks = [];
      this.tailBytes = 0;
    }
    this.tailChunks.push(chunk);
    this.tailBytes += byteLength(chunk);
    while (this.tailChunks.length > 1) {
      const oldest = this.tailChunks[0];
      if (this.tailBytes - byteLength(oldest) < budget) break;
      this.tailChunks.shift();
      this.tailBytes -= byteLength(oldest);
    }
  }

  private buildMarker(elided: number, from: number, to: number): string {
    const magnitude = this.unknownTotal
      ? `truncated at ${formatSize(this.maxBytes)}`
      : `${formatSize(elided)} of ${formatSize(this.totalBytes)} elided`;
    const lines =
      this.countLines && !this.unknownTotal && to >= from
        ? ` (lines ${from}-${to} of ${this.totalLines})`
        : "";
    return `[… ${magnitude}${lines}. ${this.recovery} …]`;
  }

  render(): string {
    if (!this.hasSpilled) return this.buffer;
    const tail = this.tailChunks.join("");

    // Reserve the marker at its widest for this content — every number in it
    // is at its maximum here, so the marker computed after slicing can only be
    // shorter, and the ceiling holds without a second slicing pass.
    const lineMax = this.totalLines;
    const reserve = byteLength(`\n${this.buildMarker(this.totalBytes, lineMax, lineMax)}\n`);
    const payload = this.maxBytes - reserve;
    // No room for both a marker and any content: a partial marker is
    // misinformation, so emit nothing and let `truncated` carry the fact.
    if (payload <= 0) return "";

    const headBudget = Math.floor(payload * this.headRatio);
    const keptHead = this.slice(this.head, headBudget, true);
    // Head-only mode keeps nothing from the tail, even when line snapping
    // left the head short of its budget.
    const tailBudget = this.headRatio >= 1 ? 0 : payload - byteLength(keptHead);
    const keptTail = this.slice(tail, tailBudget, false);

    const elided = Math.max(0, this.totalBytes - byteLength(keptHead) - byteLength(keptTail));
    const from = countNewlines(keptHead) + 1;
    const to = this.totalLines - this.lineCount(keptTail);
    const marker = this.buildMarker(elided, from, to);

    const before = keptHead === "" || keptHead.endsWith("\n") ? "" : "\n";
    const after = keptTail === "" || keptTail.startsWith("\n") ? "" : "\n";
    return `${keptHead}${before}${marker}${after}${keptTail}`;
  }

  private lineCount(text: string): number {
    if (!text) return 0;
    return countNewlines(text) + (text.endsWith("\n") ? 0 : 1);
  }

  private slice(text: string, maxBytes: number, fromHead: boolean): string {
    if (maxBytes <= 0) return "";
    const buf = Buffer.from(text, "utf8");
    const cut = fromHead
      ? buf.subarray(0, headEnd(buf, maxBytes)).toString("utf8")
      : buf.subarray(tailStart(buf, maxBytes)).toString("utf8");
    if (!this.countLines || this.maxLines === Number.POSITIVE_INFINITY) return cut;
    const lineBudget = Math.max(
      1,
      Math.floor(this.maxLines * (fromHead ? this.headRatio : 1 - this.headRatio)),
    );
    return fromHead ? capHeadLines(cut, lineBudget) : capTailLines(cut, lineBudget);
  }
}

/**
 * Truncate a string already in hand. The streaming path and this one share the
 * whole implementation — this is `Truncator` with a single push.
 */
export function truncateText(
  text: string,
  opts: TruncatorOptions,
): { text: string; truncated: boolean } {
  const t = new Truncator(opts);
  t.push(text);
  return { text: t.render(), truncated: t.truncated };
}
