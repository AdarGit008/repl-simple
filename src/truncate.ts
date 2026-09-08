/**
 * The one truncator.
 *
 * Every model-facing field that can grow without bound — `stdout`, `output`,
 * the `builtins` file/HTTP reads, every RLM prompt section and the redaction
 * cut — is cut here, by this code, so the sites cannot drift apart again (the
 * consumers are `src/sandbox.ts`, `src/builtins.ts`, `src/rlm.ts` and
 * `src/redact.ts`). The policy it implements is recorded in
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

// ── Value repr (#69 finding 1, D140) ──────────────────────────────
//
// `output` is the value of a snippet's last expression, rendered. It used to
// be `String(value)`, which spelled a dict `[object Map]`, a list `1,2,3` and
// `True` `true` — and made an empty dict and a populated one the same string.
// The values arrive intact (a dict is a real `Map`, measured on 0.0.21), so
// the loss was in the rendering, and the rendering is fixed here: Python's
// spelling, and — because this module knows the budget — elision *between
// the elements* of the outermost value instead of a cut through the flattened
// text (Q4 of docs/truncation-policy.md).
//
// What the boundary loses is documented rather than hidden: a tuple arrives
// as a list, `1.0` as `1`, `-0.0` as `0`, a frozenset as a set, `1e400` as
// `inf` (Python's own literal is `inf` too), and a lone top-level `str` is
// rendered verbatim — as `print` would, since inspecting text is what a REPL
// is for — so `'1'` and `1` collide at the top level and nowhere else.

/** Levels of nested container the elision descends when the outer ends fit nothing. */
const ELIDE_DEPTH = 4;

/** Monty's tag on the records it builds for values with no JS shape (`Exception`, `Type`). */
function montyTag(value: object): string | undefined {
  const tag = (value as { __monty_type__?: unknown }).__monty_type__;
  return typeof tag === "string" ? tag : undefined;
}

/**
 * The Python type name of a value that crossed the boundary — what a
 * `TypeError` names (`must be str, not int`). Integral numbers are `int`:
 * Monty hands `1.0` over as `1`, so the float is not knowable here.
 */
export function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "bigint":
      return "int";
    case "string":
      return "str";
    case "function":
      return "function";
    case "symbol":
      return "symbol";
    default:
      break;
  }
  const obj = value as object;
  if (obj instanceof Uint8Array) return "bytes";
  if (Array.isArray(obj)) return "list";
  if (obj instanceof Map) return "dict";
  if (obj instanceof Set) return "set";
  const tag = montyTag(obj);
  if (tag === "Exception") {
    const excType = (obj as { excType?: unknown }).excType;
    return typeof excType === "string" ? excType : "Exception";
  }
  if (tag === "Type") return "type";
  return tag ?? "object";
}

/** `repr()` of a number: Python names the non-finite ones; the rest JS spells the same way. */
function reprNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  return String(value);
}

/**
 * What a `str` repr escapes: the quotes and the backslash, the C0/C1 controls
 * and DEL (`\p{Cc}`), and a lone surrogate (`\p{Cs}` — under the `u` flag a
 * paired one is a single astral code point and does not match). Everything
 * else, printable non-ASCII included, is kept as Python 3 keeps it. One
 * native scan replaces the per-character loop: a 10 MB string with nothing
 * to escape costs the scan, not a million appends.
 */
const STRING_ESCAPES = /["'\\\p{Cc}\p{Cs}]/gu;

/** One escaped character of a `str` repr, `quote` being the delimiter in use. */
function escapeChar(ch: string, quote: string): string {
  if (ch === "\\") return "\\\\";
  if (ch === "'" || ch === '"') return ch === quote ? `\\${quote}` : ch;
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (ch === "\t") return "\\t";
  const code = ch.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdfff
    ? `\\u${code.toString(16).padStart(4, "0")}`
    : `\\x${code.toString(16).padStart(2, "0")}`;
}

/**
 * The part of a string a bounded render spells: the whole when it has at
 * most `limit` code units, else its first `limit` (or, `fromEnd`, its last).
 * Every code unit costs at least one byte rendered, so a cut part of
 * `limit = remaining + 1` units is guaranteed past the cap — the render is
 * known not to fit without spelling the rest. A surrogate pair split at the
 * edge renders as a `\uXXXX` there, which is harmless: the edge lies beyond
 * the cap, past what any caller keeps.
 */
function bounded<T extends { length: number; slice(from: number, to?: number): T }>(
  whole: T,
  limit: number,
  fromEnd: boolean,
): { part: T; cut: boolean } {
  if (whole.length <= limit) return { part: whole, cut: false };
  return { part: fromEnd ? whole.slice(whole.length - limit) : whole.slice(0, limit), cut: true };
}

/**
 * `repr()` of a string: single quotes unless the text holds a `'` and no
 * `"`; the backslash, the quote, `\n`, `\r` and `\t` escaped by name; other
 * C0/C1 controls and DEL as `\xNN`; a lone surrogate as `\uXXXX`; printable
 * non-ASCII kept. Bounded by `limit` code units from the chosen end; a cut
 * render has its quote only on the end it is true to.
 */
function reprString(text: string, limit: number, fromEnd: boolean): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const { part, cut } = bounded(text, limit, fromEnd);
  const body = part.replace(STRING_ESCAPES, (ch) => escapeChar(ch, quote));
  return `${cut && fromEnd ? "" : quote}${body}${cut && !fromEnd ? "" : quote}`;
}

/**
 * What a `bytes` repr escapes, the bytes read as latin1 characters:
 * everything outside printable ASCII — the controls and DEL (`\p{Cc}`), the
 * high half — plus the quotes and the backslash.
 */
const BYTES_ESCAPES = /["'\\\p{Cc}\u{a0}-\u{ff}]/gu;

/**
 * `repr()` of bytes: `b'…'` with printable ASCII kept and everything else
 * as `\xNN`, bounded like `reprString`. The bytes are read as latin1 so each
 * byte is one character and the same escaping scan applies.
 */
function reprBytes(bytes: Uint8Array, limit: number, fromEnd: boolean): string {
  const quote = bytes.includes(0x27) && !bytes.includes(0x22) ? '"' : "'";
  const { part, cut } = bounded(bytes, limit, fromEnd);
  const body = Buffer.from(part)
    .toString("latin1")
    .replace(BYTES_ESCAPES, (ch) => escapeChar(ch, quote));
  return `${cut && fromEnd ? "" : `b${quote}`}${body}${cut && !fromEnd ? "" : quote}`;
}

/**
 * The Python-style renderer, with a byte cap that bounds its work: past the
 * cap nothing more is appended and `overflow` says so, which is how a caller
 * learns "this does not fit" without rendering the rest — a string or bytes
 * is spelled only as far as the cap can be exceeded, never whole. A container
 * seen again while it is still open is a cycle, spelled `[...]` / `{...}` as
 * Python spells it.
 *
 * `fromEnd` mirrors the walk: the same pieces in the reverse order, the last
 * elements first, a string from its tail, so `text` is a true suffix of the
 * full repr under the same cap. The two directions together give a caller
 * both real ends of a value that fits neither way, for the price of two caps.
 */
class Repr {
  private readonly parts: string[] = [];
  private readonly open = new Set<object>();
  private used = 0;
  overflow = false;

  constructor(
    private readonly cap: number,
    private readonly fromEnd = false,
  ) {}

  get text(): string {
    return (this.fromEnd ? [...this.parts].reverse() : this.parts).join("");
  }

  /** Append in walk order: the next piece towards the middle of the value. */
  push(text: string): void {
    if (this.overflow) return;
    this.parts.push(text);
    this.used += byteLength(text);
    if (this.used > this.cap) this.overflow = true;
  }

  value(value: unknown): void {
    if (this.overflow) return;
    const scalar = this.scalar(value);
    if (scalar !== undefined) {
      this.push(scalar);
      return;
    }
    const obj = value as object;
    if (this.open.has(obj)) {
      this.push(Array.isArray(obj) ? "[...]" : "{...}");
      return;
    }
    this.open.add(obj);
    try {
      this.container(obj);
    } finally {
      this.open.delete(obj);
    }
  }

  /** The repr of a non-container, or `undefined` for a container. */
  private scalar(value: unknown): string | undefined {
    if (value === null || value === undefined) return "None";
    // One more code unit than the cap has room for is enough to overflow it.
    const limit = this.cap - this.used + 1;
    switch (typeof value) {
      case "boolean":
        return value ? "True" : "False";
      case "number":
        return reprNumber(value);
      case "bigint":
        return value.toString();
      case "string":
        return reprString(value, limit, this.fromEnd);
      case "function":
        return "<function>";
      case "symbol":
        return "<symbol>";
      default:
        break;
    }
    return value instanceof Uint8Array ? reprBytes(value, limit, this.fromEnd) : undefined;
  }

  /** One element of a list or set, or one `key: value` of a dict. */
  item(item: unknown, isEntry: boolean): void {
    if (isEntry) {
      const [key, value] = item as [unknown, unknown];
      const [first, second] = this.fromEnd ? [value, key] : [key, value];
      this.value(first);
      this.push(": ");
      this.value(second);
    } else {
      this.value(item);
    }
  }

  /** `open`, then the inside, then `close` — from whichever end is being built. */
  private wrap(open: string, close: string, inside: () => void): void {
    this.push(this.fromEnd ? close : open);
    inside();
    this.push(this.fromEnd ? open : close);
  }

  private container(obj: object): void {
    const tag = montyTag(obj);
    if (tag === "Exception") {
      this.wrap(`${pythonTypeName(obj)}(`, ")", () =>
        this.value((obj as { message?: unknown }).message),
      );
    } else if (tag === "Type") {
      const name = (obj as { value?: unknown }).value;
      this.push(`<class '${typeof name === "string" ? name : "?"}'>`);
    } else if (tag !== undefined) {
      this.push(`<${tag}>`);
    } else if (obj instanceof Set && obj.size === 0) {
      this.push("set()");
    } else {
      const c = containerOf(obj) ?? {
        open: "{",
        close: "}",
        items: Object.entries(obj),
        entries: true,
      };
      this.wrap(c.open, c.close, () => this.items(c.items, c.entries));
    }
  }

  private items(items: unknown[], areEntries: boolean): void {
    const n = items.length;
    for (let k = 0; k < n && !this.overflow; k++) {
      if (k > 0) this.push(", ");
      this.item(items[this.fromEnd ? n - 1 - k : k], areEntries);
    }
  }
}

/**
 * Both real ends of one rendering, for the flat cut: the head under `cap`
 * and, only when that did not reach the end, the tail under the same cap.
 * `whole` says the head was the whole thing. The cut keeps a real head and a
 * real tail without the value ever being spelled in full, so the work stays
 * the budget's — twice over — and not the value's.
 */
function reprEnds(render: (r: Repr) => void, cap: number): { text: string; whole: boolean } {
  const head = new Repr(cap);
  render(head);
  if (!head.overflow) return { text: head.text, whole: true };
  const tail = new Repr(cap, true);
  render(tail);
  return { text: head.text + tail.text, whole: false };
}

/** The elidable shape of a value: its items, brackets and the noun the marker counts. */
interface Container {
  open: string;
  close: string;
  noun: "elements" | "entries";
  items: unknown[];
  entries: boolean;
}

function containerOf(value: unknown): Container | undefined {
  if (Array.isArray(value)) {
    return { open: "[", close: "]", noun: "elements", items: value, entries: false };
  }
  if (value instanceof Set) {
    return { open: "{", close: "}", noun: "elements", items: [...value], entries: false };
  }
  if (value instanceof Map) {
    return { open: "{", close: "}", noun: "entries", items: [...value], entries: true };
  }
  return undefined;
}

/** One item rendered under `cap` bytes, or `undefined` when it does not fit. */
function renderItem(container: Container, index: number, cap: number): string | undefined {
  const r = new Repr(cap);
  r.item(container.items[index], container.entries);
  return r.overflow ? undefined : r.text;
}

/**
 * A structural render for the flat cut. `partial` says the text holds a real
 * head and a real tail with nothing between — one element was spelled from
 * both ends only, never whole — so the cut can claim no total for it.
 */
interface Elided {
  text: string;
  partial: boolean;
}

/**
 * Elide the outermost container between its elements: elements taken whole
 * from the front and from the back into a 50/50 split of the payload, and
 * one marker where the rest was. `undefined` when even the marker does not
 * fit, or when the value is not a container.
 *
 * When neither end fits a single element the value is dominated by one huge
 * element: a nested container is elided the same way one level down (to
 * `ELIDE_DEPTH`) — a dict's entry through its value, behind its key — and
 * anything else is rendered from both ends under the budget (`reprEnds`) for
 * the caller's flat cut, so that the cut's tail is the value's real tail and
 * not a cap's, and the work is still the budget's.
 */
function elideContainer(
  value: unknown,
  maxBytes: number,
  recovery: string,
  depth: number,
): Elided | undefined {
  const c = containerOf(value);
  if (!c) return undefined;
  const n = c.items.length;
  const marker = (elided: number) => `[… ${elided} of ${n} ${c.noun} elided. ${recovery} …]`;
  // Reserve the marker at its widest, the brackets, and a separator each side.
  const reserve = byteLength(`${c.open}, ${marker(n)}, ${c.close}`);
  const payload = maxBytes - reserve;
  if (payload <= 0) return undefined;

  const headBudget = Math.floor(payload / 2);
  const tailBudget = payload - headBudget;
  const head: string[] = [];
  let headBytes = 0;
  let i = 0;
  for (; i < n; i++) {
    const s = renderItem(c, i, headBudget - headBytes);
    if (s === undefined) break;
    const cost = byteLength(s) + (head.length > 0 ? 2 : 0);
    if (headBytes + cost > headBudget) break;
    head.push(s);
    headBytes += cost;
  }
  const tail: string[] = [];
  let tailBytes = 0;
  for (let j = n - 1; j >= i; j--) {
    const s = renderItem(c, j, tailBudget - tailBytes);
    if (s === undefined) break;
    const cost = byteLength(s) + (tail.length > 0 ? 2 : 0);
    if (tailBytes + cost > tailBudget) break;
    tail.unshift(s);
    tailBytes += cost;
  }

  if (head.length + tail.length === 0) {
    const first = c.items[0];
    const rest = n > 1 ? `, ${marker(n - 1)}` : "";
    const frame = byteLength(`${c.open}${rest}${c.close}`);
    // The value to descend into, and what stands before it: a dict entry
    // descends through its value behind `key: `, when the key itself fits.
    let prefix = "";
    let target = first;
    if (c.entries) {
      const [key, value] = first as [unknown, unknown];
      const k = new Repr(maxBytes - frame);
      k.value(key);
      prefix = `${k.text}: `;
      target = k.overflow ? undefined : value;
    }
    const inner =
      depth < ELIDE_DEPTH
        ? elideContainer(target, maxBytes - frame - byteLength(prefix), recovery, depth + 1)
        : undefined;
    if (inner !== undefined) {
      return { text: `${c.open}${prefix}${inner.text}${rest}${c.close}`, partial: inner.partial };
    }
    const ends = reprEnds((r) => r.item(first, c.entries), maxBytes - frame);
    return { text: `${c.open}${ends.text}${rest}${c.close}`, partial: !ends.whole };
  }
  const body = [...head, marker(n - head.length - tail.length), ...tail].join(", ");
  return { text: `${c.open}${body}${c.close}`, partial: false };
}

export interface FormatValueOptions {
  /** Hard byte ceiling on the rendered result, marker included. */
  maxBytes: number;
  /** Recovery clause in the marker — how the reader gets at the rest. */
  recovery: string;
}

/**
 * Render a value that crossed the boundary as Python would spell it, within
 * `maxBytes` — see the section comment for the spelling and the losses.
 *
 * A value that fits is returned whole. Over the budget, the outermost
 * container is elided between its elements (`elideContainer`); a scalar, a
 * top-level string, or a container whose ends fit nothing takes the flat
 * 50/50 value cut; a container that cannot even fit the marker is cut
 * head-only at the byte, with no total claimed. Every path ends in
 * `truncateText`, so invariant 1 holds by construction, and the renderer
 * stops at the cap — from either end — so the work is the budget's and not
 * the value's: nothing is ever spelled whole to be cut afterwards, and a
 * flat cut through a value spelled from its two ends claims no total.
 */
export function formatValue(
  value: unknown,
  opts: FormatValueOptions,
): { text: string; truncated: boolean } {
  const maxBytes = Math.max(0, opts.maxBytes);
  const flat = (text: string, headRatio: number, unknownTotal = false) =>
    truncateText(text, { maxBytes, headRatio, recovery: opts.recovery, unknownTotal });
  if (typeof value === "string") return flat(value, VALUE_HEAD_RATIO);

  const whole = new Repr(maxBytes);
  whole.value(value);
  if (!whole.overflow) return { text: whole.text, truncated: false };

  const elided = elideContainer(value, maxBytes, opts.recovery, 0);
  if (elided !== undefined) {
    return { text: flat(elided.text, VALUE_HEAD_RATIO, elided.partial).text, truncated: true };
  }
  if (containerOf(value)) {
    // Too small for the marker: the partial render, head-only, claiming no
    // total — the renderer stopped, so the total is not known.
    return { text: flat(whole.text, HEAD_ONLY_RATIO, true).text, truncated: true };
  }
  // A scalar or a tagged record: no elements to elide between, so the flat
  // cut keeps both of its real ends — spelled from each end under the
  // budget, never whole, and so claiming no total.
  const ends = reprEnds((r) => r.value(value), maxBytes);
  return { text: flat(ends.text, VALUE_HEAD_RATIO, true).text, truncated: true };
}
