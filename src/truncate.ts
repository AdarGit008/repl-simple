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
 * `repr()` of a string: single quotes unless the text holds a `'` and no
 * `"`; the backslash, the quote, `\n`, `\r` and `\t` escaped by name; other
 * C0/C1 controls and DEL as `\xNN`; a lone surrogate as `\uXXXX`; printable
 * non-ASCII kept, as Python 3 keeps it.
 */
function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

/** `repr()` of bytes: `b'…'` with printable ASCII kept and everything else as `\xNN`. */
function reprBytes(bytes: Uint8Array): string {
  const quote = bytes.includes(0x27) && !bytes.includes(0x22) ? '"' : "'";
  let out = `b${quote}`;
  for (const byte of bytes) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte === quote.charCodeAt(0)) out += `\\${quote}`;
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out + quote;
}

/**
 * The Python-style renderer, with a byte cap that bounds its work: past the
 * cap nothing more is appended and `overflow` says so, which is how a caller
 * learns "this does not fit" without rendering the rest. A container seen
 * again while it is still open is a cycle, spelled `[...]` / `{...}` as
 * Python spells it.
 */
class Repr {
  private readonly parts: string[] = [];
  private readonly open = new Set<object>();
  private used = 0;
  overflow = false;

  constructor(private readonly cap: number) {}

  get text(): string {
    return this.parts.join("");
  }

  push(text: string): void {
    if (this.overflow) return;
    this.parts.push(text);
    this.used += byteLength(text);
    if (this.used > this.cap) this.overflow = true;
  }

  value(value: unknown): void {
    if (this.overflow) return;
    const scalar = Repr.scalar(value);
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
  private static scalar(value: unknown): string | undefined {
    if (value === null || value === undefined) return "None";
    switch (typeof value) {
      case "boolean":
        return value ? "True" : "False";
      case "number":
        return reprNumber(value);
      case "bigint":
        return value.toString();
      case "string":
        return reprString(value);
      case "function":
        return "<function>";
      case "symbol":
        return "<symbol>";
      default:
        break;
    }
    return value instanceof Uint8Array ? reprBytes(value) : undefined;
  }

  /** One element of a list or set, or one `key: value` of a dict. */
  item(item: unknown, isEntry: boolean): void {
    if (isEntry) {
      const [key, value] = item as [unknown, unknown];
      this.value(key);
      this.push(": ");
      this.value(value);
    } else {
      this.value(item);
    }
  }

  private container(obj: object): void {
    if (Array.isArray(obj)) {
      this.push("[");
      this.items(obj, false);
      this.push("]");
    } else if (obj instanceof Set) {
      if (obj.size === 0) {
        this.push("set()");
      } else {
        this.push("{");
        this.items([...obj], false);
        this.push("}");
      }
    } else if (obj instanceof Map) {
      this.push("{");
      this.items([...obj], true);
      this.push("}");
    } else {
      const tag = montyTag(obj);
      if (tag === "Exception") {
        this.push(`${pythonTypeName(obj)}(`);
        this.value((obj as { message?: unknown }).message);
        this.push(")");
      } else if (tag === "Type") {
        const name = (obj as { value?: unknown }).value;
        this.push(`<class '${typeof name === "string" ? name : "?"}'>`);
      } else if (tag !== undefined) {
        this.push(`<${tag}>`);
      } else {
        this.push("{");
        this.items(Object.entries(obj), true);
        this.push("}");
      }
    }
  }

  private items(items: unknown[], areEntries: boolean): void {
    for (let i = 0; i < items.length && !this.overflow; i++) {
      if (i > 0) this.push(", ");
      this.item(items[i], areEntries);
    }
  }
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
 * Elide the outermost container between its elements: elements taken whole
 * from the front and from the back into a 50/50 split of the payload, and
 * one marker where the rest was. `undefined` when even the marker does not
 * fit, or when the value is not a container.
 *
 * When neither end fits a single element the value is dominated by one huge
 * element: a nested container is elided the same way one level down (to
 * `ELIDE_DEPTH`), a scalar is rendered whole for the caller's flat cut, so
 * that the rendered tail is the value's real tail and not a cap's.
 */
function elideContainer(
  value: unknown,
  maxBytes: number,
  recovery: string,
  depth: number,
): string | undefined {
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
    const inner =
      depth < ELIDE_DEPTH && !c.entries
        ? elideContainer(
            first,
            maxBytes - byteLength(`${c.open}${rest}${c.close}`),
            recovery,
            depth + 1,
          )
        : undefined;
    if (inner !== undefined) return `${c.open}${inner}${rest}${c.close}`;
    const whole = new Repr(Number.POSITIVE_INFINITY);
    whole.item(first, c.entries);
    return `${c.open}${whole.text}${rest}${c.close}`;
  }
  return `${c.open}${[...head, marker(n - head.length - tail.length), ...tail].join(", ")}${c.close}`;
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
 * stops at the cap, so the work is the budget's and not the value's.
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
  if (elided !== undefined) return { text: flat(elided, VALUE_HEAD_RATIO).text, truncated: true };
  if (containerOf(value)) {
    // Too small for the marker: the partial render, head-only, claiming no
    // total — the renderer stopped, so the total is not known.
    return { text: flat(whole.text, HEAD_ONLY_RATIO, true).text, truncated: true };
  }
  // A scalar or a tagged record: bounded by its own size, so render it whole
  // and let the flat cut keep both of its real ends.
  const complete = new Repr(Number.POSITIVE_INFINITY);
  complete.value(value);
  return { text: flat(complete.text, VALUE_HEAD_RATIO).text, truncated: true };
}
