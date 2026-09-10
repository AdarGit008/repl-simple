import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MontyClassProxy } from "@pydantic/monty/node";
// The #69 repr is read off the namespace rather than named-imported so that
// this file still *loads* against a `src/truncate.ts` without it: a missing
// named export is a link error that fails every test here, not the ones about
// the repr.
import * as truncate from "../src/truncate.js";
import {
  Truncator,
  truncateText,
  formatSize,
  decodeWhole,
  STDOUT_HEAD_RATIO,
  VALUE_HEAD_RATIO,
  HEAD_ONLY_RATIO,
  STDOUT_RECOVERY,
} from "../src/truncate.js";

// ── Helpers ─────────────────────────────────────────────────────

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Characters of each UTF-8 width, so boundary bugs cannot hide in ASCII. */
const WIDTHS: Array<{ label: string; char: string; width: number }> = [
  { label: "1-byte (ASCII)", char: "A", width: 1 },
  { label: "2-byte (é)", char: "é", width: 2 },
  { label: "3-byte (日)", char: "日", width: 3 },
  { label: "4-byte (😀)", char: "😀", width: 4 },
];

function stdoutOpts(maxBytes: number) {
  return {
    maxBytes,
    headRatio: STDOUT_HEAD_RATIO,
    recovery: STDOUT_RECOVERY,
    maxLines: 1000,
  };
}

function valueOpts(maxBytes: number) {
  return { maxBytes, headRatio: VALUE_HEAD_RATIO, recovery: "Slice it." };
}

/** True when the string round-trips through UTF-8 unchanged. */
function isWholeUtf8(s: string): boolean {
  return Buffer.from(s, "utf8").toString("utf8") === s;
}

// ── formatSize ──────────────────────────────────────────────────

describe("formatSize — matches pi's format", () => {
  it("bytes below 1 KiB", () => {
    assert.equal(formatSize(0), "0B");
    assert.equal(formatSize(42), "42B");
    assert.equal(formatSize(1023), "1023B");
  });

  it("kilobytes to one decimal", () => {
    assert.equal(formatSize(1024), "1.0KB");
    assert.equal(formatSize(1536), "1.5KB");
  });

  it("megabytes to one decimal", () => {
    assert.equal(formatSize(1024 * 1024), "1.0MB");
    assert.equal(formatSize(Math.round(1.9 * 1024 * 1024)), "1.9MB");
  });
});

// ── Invariant 1: the budget is a ceiling ────────────────────────

describe("invariant 1 — the budget is a ceiling, marker included", () => {
  it("a 1024-byte cap yields at most 1024 bytes (M3/M4)", () => {
    // Before: 1024 of payload plus a 22-byte marker appended outside it.
    const { text, truncated } = truncateText("A".repeat(200_000), stdoutOpts(1024));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 1024, `got ${bytes(text)} bytes for a 1024 cap`);
  });

  it("holds for every character width and a range of budgets", () => {
    for (const { label, char } of WIDTHS) {
      const input = char.repeat(20_000);
      for (const budget of [1, 7, 10, 63, 100, 512, 1024, 4096, 32 * 1024]) {
        const { text } = truncateText(input, stdoutOpts(budget));
        assert.ok(
          bytes(text) <= budget,
          `${label}: ${bytes(text)} bytes returned for a ${budget}-byte budget`,
        );
      }
    }
  });

  it("holds when the content arrives as many small chunks", () => {
    const t = new Truncator(stdoutOpts(2048));
    for (let i = 0; i < 5000; i++) t.push(`line ${i} 日本語\n`);
    assert.ok(bytes(t.render()) <= 2048);
    assert.equal(t.truncated, true);
  });

  it("holds when one chunk alone dwarfs the budget", () => {
    const t = new Truncator(stdoutOpts(2048));
    t.push("😀".repeat(100_000));
    assert.ok(bytes(t.render()) <= 2048);
  });
});

// ── Invariant 2: never split a character ────────────────────────

describe("invariant 2 — never split a character", () => {
  it("a 10-byte cap on 'é'*50 stays within budget and emits no U+FFFD", () => {
    // M1: returned 42 bytes / 32 chars against a 10-byte cap, because a byte
    // budget was handed to String.slice, a character index.
    // M5: the builtins copy honoured the budget and cut mid-character instead.
    const { text } = truncateText("é".repeat(50), stdoutOpts(10));
    assert.ok(bytes(text) <= 10, `got ${bytes(text)} bytes for a 10-byte cap`);
    assert.ok(!text.includes("�"), "truncation introduced U+FFFD");
  });

  it("never introduces U+FFFD at any width or budget", () => {
    for (const { label, char } of WIDTHS) {
      const input = char.repeat(20_000);
      for (const budget of [1, 3, 5, 9, 17, 64, 257, 1031, 4096]) {
        const { text } = truncateText(input, stdoutOpts(budget));
        assert.ok(
          !text.includes("�"),
          `${label} at budget ${budget}: truncation introduced U+FFFD`,
        );
        assert.ok(isWholeUtf8(text), `${label} at budget ${budget}: invalid UTF-8`);
      }
    }
  });

  it("passes through a U+FFFD that was in the input", () => {
    const input = `head�marker${"A".repeat(5000)}`;
    const { text } = truncateText(input, stdoutOpts(2048));
    assert.ok(text.includes("�"), "an input U+FFFD must survive");
  });
});

// ── Shape ───────────────────────────────────────────────────────

describe("shape — head + tail with an elided middle", () => {
  it("keeps both ends of a value", () => {
    const input = `START${"x".repeat(50_000)}END`;
    const { text } = truncateText(input, valueOpts(4096));
    assert.ok(text.startsWith("START"), "head lost");
    assert.ok(text.endsWith("END"), "tail lost");
  });

  it("keeps both ends of a stream, and the marker sits at the cut", () => {
    const t = new Truncator(stdoutOpts(4096));
    t.push("FIRST_LINE\n");
    for (let i = 0; i < 20_000; i++) t.push(`filler ${i}\n`);
    t.push("LAST_LINE\n");
    const out = t.render();
    assert.ok(out.includes("FIRST_LINE"), "head lost");
    assert.ok(out.includes("LAST_LINE"), "tail lost");
    // Not appended at the end — an appended marker would imply the tail went.
    const marker = out.indexOf("[…");
    assert.ok(marker > 0, "marker missing");
    assert.ok(out.indexOf("LAST_LINE") > marker, "the marker must sit between head and tail");
  });

  it("weights stdout 25/75 and a value 50/50", () => {
    const input = "A".repeat(100_000);
    const stream = truncateText(input, stdoutOpts(8192)).text;
    const value = truncateText(input, valueOpts(8192)).text;
    const headOf = (s: string) => s.slice(0, s.indexOf("[…")).length;
    // Ratios are approximate — the marker and line snapping both move the cut.
    assert.ok(headOf(stream) < headOf(value), "stdout must keep less head than a value");
    assert.ok(headOf(stream) > 0 && headOf(value) > 0);
  });

  it("head-only mode keeps nothing from the tail", () => {
    const input = `START${"x".repeat(50_000)}END`;
    const { text } = truncateText(input, {
      maxBytes: 4096,
      headRatio: HEAD_ONLY_RATIO,
      recovery: "More.",
    });
    assert.ok(text.startsWith("START"));
    assert.ok(!text.endsWith("END"), "head-only must not keep a tail");
    assert.ok(text.trimEnd().endsWith("…]"), "the marker must close the output");
  });

  it("returns the input untouched when it fits", () => {
    const input = "small enough\n";
    const { text, truncated } = truncateText(input, stdoutOpts(1024));
    assert.equal(text, input);
    assert.equal(truncated, false);
  });

  it("streaming and one-shot agree for the same content", () => {
    const chunks = Array.from({ length: 4000 }, (_, i) => `row ${i}\n`);
    const streamed = new Truncator(stdoutOpts(4096));
    for (const c of chunks) streamed.push(c);
    const oneShot = truncateText(chunks.join(""), stdoutOpts(4096));
    assert.equal(streamed.render(), oneShot.text);
  });
});

// ── Marker content ──────────────────────────────────────────────

describe("marker — magnitude, line range, recovery route", () => {
  it("states what went against the true total", () => {
    const input = "A".repeat(2 * 1024 * 1024);
    const { text } = truncateText(input, stdoutOpts(4096));
    assert.match(text, /\[… [\d.]+MB of 2\.0MB elided/);
  });

  it("counts bytes that were never retained (invariant 5)", () => {
    // The counters must keep counting after the buffer stops keeping.
    const t = new Truncator(stdoutOpts(1024));
    for (let i = 0; i < 100_000; i++) t.push("0123456789");
    assert.equal(t.totalBytes, 1_000_000);
    assert.match(t.render(), / of 976\.6KB elided/);
  });

  it("carries a line range for a stream", () => {
    const t = new Truncator(stdoutOpts(4096));
    for (let i = 0; i < 5000; i++) t.push(`line ${i}\n`);
    assert.equal(t.totalLines, 5000);
    assert.match(t.render(), /\(lines \d+-\d+ of 5000\)/);
  });

  it("omits the line range for a value", () => {
    const { text } = truncateText("A".repeat(50_000), valueOpts(2048));
    assert.ok(!text.includes("lines "), "a single value has no line range");
  });

  it("names a recovery route", () => {
    const { text } = truncateText("A".repeat(50_000), stdoutOpts(2048));
    assert.ok(text.includes(STDOUT_RECOVERY), "the marker must name a way to the rest");
  });

  it("states where it cut when the total is genuinely unknown", () => {
    // The caller stopped reading early, so inventing a total would break
    // invariant 5.
    const t = new Truncator({
      maxBytes: 1024,
      headRatio: HEAD_ONLY_RATIO,
      recovery: "Request a narrower range.",
      unknownTotal: true,
    });
    t.push("A".repeat(50_000));
    assert.match(t.render(), /truncated at 1\.0KB/);
    assert.ok(!t.render().includes("elided"));
  });
});

// ── Line budget ─────────────────────────────────────────────────

describe("line budget", () => {
  it("truncates on lines even when the byte budget is not reached", () => {
    const t = new Truncator({ ...stdoutOpts(1024 * 1024), maxLines: 10 });
    for (let i = 0; i < 500; i++) t.push(`${i}\n`);
    assert.equal(t.truncated, true);
    const kept = t
      .render()
      .split("\n")
      .filter((l) => l && !l.startsWith("[…"));
    assert.ok(kept.length <= 12, `kept ${kept.length} lines against a 10-line budget`);
  });

  it("leaves a short stream alone", () => {
    const t = new Truncator({ ...stdoutOpts(1024 * 1024), maxLines: 1000 });
    for (let i = 0; i < 10; i++) t.push(`${i}\n`);
    assert.equal(t.truncated, false);
  });
});

// ── The budget-smaller-than-the-marker edge ─────────────────────

describe("a budget too small to hold the marker", () => {
  // Decided explicitly: emit nothing. A partial marker is misinformation, and
  // the budget is a hard ceiling, so an empty field plus `truncated: true` is
  // the only unambiguous answer.
  it("returns an empty string, and still reports truncation", () => {
    const { text, truncated } = truncateText("A".repeat(1000), stdoutOpts(8));
    assert.equal(text, "");
    assert.equal(truncated, true);
  });

  it("never emits a partial marker", () => {
    for (const budget of [1, 2, 5, 10, 20, 40, 80]) {
      const { text } = truncateText("A".repeat(1000), stdoutOpts(budget));
      assert.ok(
        text === "" || text.includes("…]"),
        `budget ${budget} produced a partial marker: ${JSON.stringify(text)}`,
      );
      assert.ok(bytes(text) <= budget);
    }
  });
});

// ── decodeWhole ─────────────────────────────────────────────────

describe("decodeWhole — decode a byte range without inventing characters", () => {
  it("drops a partial character at the start", () => {
    const buf = Buffer.from("日本語", "utf8");
    const out = decodeWhole(buf.subarray(1));
    assert.equal(out, "本語");
    assert.ok(!out.includes("�"));
  });

  it("drops a partial character at the end", () => {
    const buf = Buffer.from("日本語", "utf8");
    const out = decodeWhole(buf.subarray(0, 7));
    assert.equal(out, "日本");
    assert.ok(!out.includes("�"));
  });

  it("drops partial characters at both ends at once", () => {
    const buf = Buffer.from("😀😀😀", "utf8");
    const out = decodeWhole(buf.subarray(2, 10));
    assert.equal(out, "😀");
    assert.ok(!out.includes("�"));
  });

  it("leaves a whole range alone", () => {
    assert.equal(decodeWhole(Buffer.from("héllo 日", "utf8")), "héllo 日");
  });

  it("returns empty rather than a replacement character", () => {
    const buf = Buffer.from("😀", "utf8");
    assert.equal(decodeWhole(buf.subarray(1, 3)), "");
  });
});

// ── Carry-over ──────────────────────────────────────────────────

describe("truncatedBefore — the flag survives a resume", () => {
  it("stays truncated even when the carried text fits", () => {
    const t = new Truncator({ ...stdoutOpts(1024), truncatedBefore: true });
    t.push("short\n");
    assert.equal(t.truncated, true);
    assert.equal(t.render(), "short\n");
  });

  it("is not set by default", () => {
    const t = new Truncator(stdoutOpts(1024));
    t.push("short\n");
    assert.equal(t.truncated, false);
  });
});

// ── The boundary (bucket 2, exit criterion 4) ───────────────────
//
// `overBudget` is `totalBytes > maxBytes || totalLines > maxLines`. A `>=`
// mutant on either comparison survived (#24 M11/M12) because no test sat on
// the line: every input was far past the budget or comfortably inside it.
// Each case here lands exactly on the cap, then steps one past it.

describe("the boundary — exactly at the budget is within it (bucket 2, exit criterion 4)", () => {
  it("a stream of exactly maxBytes is returned whole, at every character width", () => {
    for (const { label, char, width } of WIDTHS) {
      const input = char.repeat(8);
      const budget = 8 * width;
      assert.equal(bytes(input), budget, `${label}: fixture is not exactly at the cap`);

      const t = new Truncator(stdoutOpts(budget));
      t.push(input);
      assert.equal(t.truncated, false, `${label}: exactly at the cap reported as truncated`);
      assert.equal(t.render(), input, `${label}: exactly at the cap was cut`);
      assert.equal(t.totalBytes, budget);
    }
  });

  it("one byte past maxBytes is truncated", () => {
    const t = new Truncator(stdoutOpts(64));
    t.push("A".repeat(65));
    assert.equal(t.truncated, true);
  });

  it("many chunks summing to exactly maxBytes are not truncated; the next byte is", () => {
    const t = new Truncator(stdoutOpts(100));
    for (let i = 0; i < 10; i++) t.push("0123456789");
    assert.equal(t.totalBytes, 100);
    assert.equal(t.truncated, false);
    assert.equal(t.render(), "0123456789".repeat(10));

    t.push("!");
    assert.equal(t.truncated, true);
  });

  it("truncateText agrees: exactly at the cap returns the input verbatim", () => {
    const input = "A".repeat(1024);
    const { text, truncated } = truncateText(input, stdoutOpts(1024));
    assert.equal(text, input);
    assert.equal(truncated, false);
  });

  it("exactly maxLines lines is not truncated; one more is", () => {
    const t = new Truncator({ ...stdoutOpts(1024 * 1024), maxLines: 10 });
    for (let i = 0; i < 10; i++) t.push(`${i}\n`);
    assert.equal(t.totalLines, 10);
    assert.equal(t.truncated, false);

    t.push("10\n");
    assert.equal(t.totalLines, 11);
    assert.equal(t.truncated, true);
  });

  it("an unterminated final line counts, and still sits within the budget at the boundary", () => {
    const t = new Truncator({ ...stdoutOpts(1024 * 1024), maxLines: 10 });
    for (let i = 0; i < 9; i++) t.push(`${i}\n`);
    t.push("last");
    assert.equal(t.totalLines, 10);
    assert.equal(t.truncated, false);
  });
});

// ── formatValue — the value repr (#69 finding 1, D140) ─────────────
//
// `output` used to be `String(value)`: `[object Map]` for a dict, `1,2,3` for a
// list, `true` for `True`. The repr below renders what crossed the boundary
// the way Python would spell it, and — because it is built here, under the
// one truncator — knows its byte budget and elides between the elements of
// the outermost value instead of cutting the flattened string.

type FormatValue = (
  value: unknown,
  opts: { maxBytes: number; recovery: string },
) => { text: string; truncated: boolean };
const formatValue: FormatValue = (value, opts) =>
  (truncate as unknown as { formatValue: FormatValue }).formatValue(value, opts);
const pythonTypeName = (value: unknown): string =>
  (truncate as unknown as { pythonTypeName: (v: unknown) => string }).pythonTypeName(value);

/** Render with a budget no test value reaches, so only the spelling is under test. */
const repr = (value: unknown): string => formatValue(value, valueOpts(1 << 20)).text;

/** A Monty tagged record, as `Exception('x')` and `type(1)` arrive (measured on 0.0.21). */
const tagged = (tag: string, fields: Record<string, unknown>) => ({
  __monty_type__: tag,
  ...fields,
});

describe("formatValue — scalars spelled as Python spells them", () => {
  it("None, True, False", () => {
    assert.equal(repr(null), "None");
    assert.equal(repr(undefined), "None");
    assert.equal(repr(true), "True");
    assert.equal(repr(false), "False");
  });

  it("integers: a safe integral number or a bigint, as digits", () => {
    assert.equal(repr(1), "1");
    assert.equal(repr(-3), "-3");
    assert.equal(repr(0), "0");
    assert.equal(repr(1e16), "10000000000000000");
    assert.equal(repr(9007199254740993n), "9007199254740993");
    assert.equal(repr(-(2n ** 63n)), "-9223372036854775808");
  });

  it("floats in the shortest form; inf, -inf and nan by name", () => {
    assert.equal(repr(2.5), "2.5");
    assert.equal(repr(0.1 + 0.2), "0.30000000000000004");
    assert.equal(repr(1e21), "1e+21");
    assert.equal(repr(Number.POSITIVE_INFINITY), "inf");
    assert.equal(repr(Number.NEGATIVE_INFINITY), "-inf");
    assert.equal(repr(Number.NaN), "nan");
  });

  it("documented losses: 1.0 and -0.0 arrive as integers and render as such", () => {
    // Monty hands an integral float over as a plain number: `1.0` → 1, `-0.0` → 0.
    assert.equal(repr(1), "1");
    assert.equal(repr(-0), "0");
  });

  it("a top-level string renders verbatim, as print would", () => {
    assert.equal(repr("hi"), "hi");
    assert.equal(repr("it's"), "it's");
    assert.equal(repr("a\nb"), "a\nb");
    assert.equal(repr(""), "");
  });
});

describe("formatValue — strings inside a container use Python's quoting", () => {
  it("single quotes by default", () => {
    assert.equal(repr(["a"]), "['a']");
    assert.equal(repr(['a"b']), `['a"b']`);
  });

  it("double quotes when the text holds a single quote and no double quote", () => {
    assert.equal(repr(["it's"]), `["it's"]`);
    assert.equal(repr([`'"`]), `['\\'"']`);
  });

  it("escapes the backslash, the quote, newline, return and tab", () => {
    assert.equal(repr(["a\nb\tc\\d\r"]), "['a\\nb\\tc\\\\d\\r']");
  });

  it("other controls as \\xNN; printable non-ASCII kept; a lone surrogate as \\uXXXX", () => {
    assert.equal(repr(["\x00\x1f\x7f\x85"]), "['\\x00\\x1f\\x7f\\x85']");
    assert.equal(repr(["日本 😀"]), "['日本 😀']");
    assert.equal(repr(["\ud800"]), "['\\ud800']");
  });
});

describe("formatValue — bytes, containers, tagged records, the rest", () => {
  it("bytes as b'…' with Python's escapes and quote choice", () => {
    assert.equal(repr(Buffer.from([97, 0, 255, 39, 34, 92, 10])), "b'a\\x00\\xff\\'\"\\\\\\n'");
    assert.equal(repr(Buffer.from("it's")), `b"it's"`);
    assert.equal(repr(new Uint8Array([])), "b''");
  });

  it("list, dict, set — and the empty forms are distinguishable", () => {
    assert.equal(repr([]), "[]");
    assert.equal(repr([1, "a", null, true]), "[1, 'a', None, True]");
    assert.equal(repr(new Map()), "{}");
    assert.equal(repr(new Map([["a", 1]])), "{'a': 1}");
    assert.equal(
      repr(
        new Map<unknown, unknown>([
          [1, "x"],
          [[1, 2], "y"],
        ]),
      ),
      "{1: 'x', [1, 2]: 'y'}",
    );
    assert.equal(repr(new Set()), "set()");
    assert.equal(repr(new Set([1, 2, 3])), "{1, 2, 3}");
  });

  it("nested {'a': (1, 2.0), 'b': [None, True]} renders as the documented shape", () => {
    // The tuple and the float are the boundary's losses: `(1, 2.0)` arrives
    // as `[1, 2]`, so the dict renders with a list and an integer.
    const value = new Map<string, unknown>([
      ["a", [1, 2]],
      ["b", [null, true]],
    ]);
    assert.equal(repr(value), "{'a': [1, 2], 'b': [None, True]}");
  });

  it("Monty's tagged records: an exception and a type", () => {
    assert.equal(
      repr(tagged("Exception", { excType: "ValueError", message: "bad" })),
      "ValueError('bad')",
    );
    assert.equal(repr(tagged("Type", { value: "int" })), "<class 'int'>");
    assert.equal(repr(tagged("FileHandle", {})), "<FileHandle>");
    // A record missing its field is rendered without inventing one.
    assert.equal(repr(tagged("Exception", { message: "m" })), "Exception('m')");
    assert.equal(repr(tagged("Type", {})), "<class '?'>");
    assert.equal(
      repr([
        tagged("Exception", { excType: "Exception", message: "x" }),
        tagged("Type", { value: "str" }),
      ]),
      "[Exception('x'), <class 'str'>]",
    );
  });

  it("a class instance (0.0.23's MontyClassProxy) as `<Name object>`, a dataclass as `Name(field=…)`", () => {
    // 0.0.21 handed an instance over as Monty's own repr string
    // (`<C object at 0x2>`, `P(x=1)`, measured). 0.0.23 hands over a
    // `MontyClassProxy` — class name, a uuid, attributes, the class record — and
    // the dict fallback below spelled all of it, uuids included (measured:
    // `{'name': 'C', 'isDataclass': False, 'id': 'b226…', …}`).
    const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const plain = new MontyClassProxy({ name: "C", isDataclass: false }, id, [["x", 1]]);
    const point = new MontyClassProxy({ name: "P", isDataclass: true }, id, [
      ["x", 1],
      ["y", "a"],
    ]);
    const empty = new MontyClassProxy({ name: "E", isDataclass: true }, id, []);
    const nested = new MontyClassProxy({ name: "N", isDataclass: true }, id, [
      ["p", point],
      ["items", [1, "b"]],
      ["m", new Map([["k", plain]])],
    ]);

    assert.equal(repr(plain), "<C object>");
    assert.equal(repr(point), "P(x=1, y='a')");
    assert.equal(repr(empty), "E()");
    assert.equal(repr([plain, point]), "[<C object>, P(x=1, y='a')]");
    assert.equal(repr(nested), "N(p=P(x=1, y='a'), items=[1, 'b'], m={'k': <C object>})");
    for (const value of [plain, point, nested]) {
      assert.doesNotMatch(repr(value), new RegExp(id), "the proxy's uuid reached the output");
    }
  });

  it("a dataclass too large for the budget keeps both real ends", () => {
    const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const big = new MontyClassProxy({ name: "Big", isDataclass: true }, id, [
      ["head", "h"],
      ["body", "x".repeat(5000)],
      ["tail", "t"],
    ]);
    const { text, truncated } = formatValue(big, valueOpts(200));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 200, `${bytes(text)} bytes`);
    assert.ok(text.startsWith("Big(head='h', body='xxx"), text);
    assert.ok(text.endsWith("xxx', tail='t')"), text);
  });

  it("an untagged plain object renders like a dict; a function or symbol by kind", () => {
    assert.equal(repr({ k: 1, s: "v" }), "{'k': 1, 's': 'v'}");
    assert.equal(
      repr(() => 1),
      "<function>",
    );
    assert.equal(repr(Symbol("s")), "<symbol>");
    assert.equal(repr(Object.create(null)), "{}");
  });

  it("a cycle renders as Python does, and a shared reference is not a cycle", () => {
    const list: unknown[] = [];
    list.push(list);
    assert.equal(repr(list), "[[...]]");
    const dict = new Map<string, unknown>();
    dict.set("s", dict);
    assert.equal(repr(dict), "{'s': {...}}");
    const set = new Set<unknown>();
    set.add(set);
    assert.equal(repr(set), "{{...}}");
    const shared = [1];
    assert.equal(repr([shared, shared]), "[[1], [1]]");
  });

  it("never throws, whatever the shape", () => {
    for (const value of [Object.create(null), new Date(0), /re/, new (class X {})(), 10n, -1e-7]) {
      assert.doesNotThrow(() => repr(value));
      assert.equal(typeof repr(value), "string");
    }
  });
});

describe("pythonTypeName — the name a TypeError names", () => {
  it("maps every boundary shape to its Python type", () => {
    const table: Array<[unknown, string]> = [
      [null, "NoneType"],
      [undefined, "NoneType"],
      [true, "bool"],
      [1, "int"],
      [10n, "int"],
      [1.5, "float"],
      [Number.NaN, "float"],
      [Number.POSITIVE_INFINITY, "float"],
      ["s", "str"],
      [Buffer.from("b"), "bytes"],
      [[1], "list"],
      [new Map(), "dict"],
      [new Set(), "set"],
      [tagged("Exception", { excType: "ValueError", message: "" }), "ValueError"],
      [tagged("Type", { value: "int" }), "type"],
      [tagged("FileHandle", {}), "FileHandle"],
      [() => 1, "function"],
      [Symbol("s"), "symbol"],
      [{ k: 1 }, "object"],
    ];
    for (const [value, name] of table) {
      assert.equal(pythonTypeName(value), name, `for ${String(name)}`);
    }
  });

  it("names a class instance by its class, as `must be str, not Point` would", () => {
    const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
    assert.equal(
      pythonTypeName(new MontyClassProxy({ name: "Point", isDataclass: true }, id, [])),
      "Point",
    );
    assert.equal(
      pythonTypeName(new MontyClassProxy({ name: "C", isDataclass: false }, id, [])),
      "C",
    );
  });
});

// ── instancesAsRepr — how a tool call's arguments are normalised (0.0.23) ──

describe("instancesAsRepr — instances become their repr, every other shape is kept", () => {
  const instancesAsRepr = (value: unknown): unknown =>
    (truncate as unknown as { instancesAsRepr: (v: unknown) => unknown }).instancesAsRepr(value);
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";

  it("replaces an instance at any depth and keeps each container's kind", () => {
    const c = new MontyClassProxy({ name: "C", isDataclass: false }, id, [["secret", "s"]]);
    const p = new MontyClassProxy({ name: "P", isDataclass: true }, id, [
      ["x", 1],
      ["inner", c],
    ]);
    assert.equal(instancesAsRepr(c), "<C object>");
    assert.equal(instancesAsRepr(p), "P(x=1, inner=<C object>)");

    const kwargs = Object.assign(Object.create(null), {
      a: c,
      b: [p, new Set([c])],
      m: new Map([[c, p]]),
    });
    const out = instancesAsRepr(kwargs) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(out), null, "a null-prototype record must stay one");
    assert.equal(out.a, "<C object>");
    assert.deepEqual(out.b, ["P(x=1, inner=<C object>)", new Set(["<C object>"])]);
    assert.deepEqual(out.m, new Map([["<C object>", "P(x=1, inner=<C object>)"]]));
  });

  it("leaves every value that is not an instance as it was", () => {
    const buf = Buffer.from("b");
    assert.equal(instancesAsRepr(buf), buf);
    const date = new Date(0);
    assert.equal(instancesAsRepr(date), date);
    for (const value of [null, undefined, 1, 10n, "s", true]) {
      assert.equal(instancesAsRepr(value), value);
    }
    const exc = tagged("Exception", { excType: "ValueError", message: "m" });
    assert.deepEqual(instancesAsRepr(exc), exc);
    assert.deepEqual(instancesAsRepr([1, ["a", new Map([["k", 2]])]]), [
      1,
      ["a", new Map([["k", 2]])],
    ]);
  });

  it("is uncapped: two instances differing only past any output budget stay distinct", () => {
    const big = (tail: string) =>
      new MontyClassProxy({ name: "B", isDataclass: true }, id, [
        ["s", `${"x".repeat(100_000)}${tail}`],
      ]);
    const a = instancesAsRepr(big("a")) as string;
    assert.notEqual(a, instancesAsRepr(big("b")), "a cache key would collide");
    assert.ok(a.endsWith("a')"), a.slice(-20));
  });
});

// ── formatValue — the budget (Q4 of the policy, D140) ────────────

describe("formatValue — elides between the elements of the outermost value", () => {
  const budget = truncate.OUTPUT_MAX_BYTES;
  const marker = /\[… (\d+) of (\d+) (elements|entries) elided\. Slice it\. …\]/;

  it("a 1 MB list keeps both ends, one marker between them, under OUTPUT_MAX_BYTES", () => {
    const list = Array.from({ length: 200_000 }, (_, i) => i);
    const { text, truncated } = formatValue(list, valueOpts(budget));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= budget, `got ${bytes(text)} bytes for a ${budget} budget`);
    assert.ok(text.startsWith("[0, 1, 2, 3, "), `head lost: ${text.slice(0, 40)}`);
    assert.ok(text.endsWith(", 199998, 199999]"), `tail lost: ${text.slice(-40)}`);
    const m = marker.exec(text);
    assert.ok(m, "no element marker");
    assert.equal(m[2], "200000", "the total is the true element count");
    assert.equal(m[3], "elements");
    assert.ok(Number(m[1]) < 200_000);
    // Elements are whole on both sides of the marker: an integer, then the
    // separator, then the marker; the marker, the separator, then an integer.
    assert.match(text, /\d, \[… /, "the head ends mid-element");
    assert.match(text, / …\], \d/, "the tail starts mid-element");
    // One marker, at the cut — never a second flat marker on top.
    assert.equal(text.match(/\[… /g)?.length, 1);
  });

  it("a dict elides entries; a set elides elements", () => {
    const dict = new Map(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i]));
    const d = formatValue(dict, valueOpts(2048));
    assert.ok(bytes(d.text) <= 2048);
    assert.ok(d.text.startsWith("{'k0': 0, 'k1': 1, "));
    assert.ok(d.text.endsWith(", 'k49999': 49999}"));
    assert.match(d.text, /\[… \d+ of 50000 entries elided\. Slice it\. …\]/);

    const set = new Set(Array.from({ length: 50_000 }, (_, i) => i));
    const s = formatValue(set, valueOpts(2048));
    assert.ok(bytes(s.text) <= 2048);
    assert.ok(s.text.startsWith("{0, 1, 2, "));
    assert.ok(s.text.endsWith(", 49999}"));
    assert.match(s.text, /\[… \d+ of 50000 elements elided\. Slice it\. …\]/);
  });

  it("a long string takes the flat 50/50 value cut — there are no elements to elide", () => {
    const { text, truncated } = formatValue(`START${"x".repeat(50_000)}END`, valueOpts(1024));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 1024);
    assert.ok(text.startsWith("START"));
    assert.ok(text.endsWith("END"));
    assert.match(text, /\[… [\d.]+KB of [\d.]+KB elided\. Slice it\. …\]/);
    assert.ok(!text.includes("elements"));
  });

  it("a nested value is shown whole or skipped: a huge first element is elided, the tail kept", () => {
    const { text } = formatValue(["x".repeat(20_000), 1, 2], valueOpts(1024));
    assert.ok(bytes(text) <= 1024);
    assert.equal(text, "[[… 1 of 3 elements elided. Slice it. …], 1, 2]");
  });

  it("a value whose ends fit nothing falls to the flat cut rather than an empty list", () => {
    const { text, truncated } = formatValue(["x".repeat(20_000)], valueOpts(1024));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 1024);
    assert.ok(text.startsWith("['xxx"), text.slice(0, 20));
    assert.ok(text.endsWith("xxx']"), text.slice(-20));
    assert.ok(!text.includes("0 of 1"), "an all-elided list says nothing");
  });

  it("the marker names the recovery route it was given", () => {
    const { text } = formatValue(
      Array.from({ length: 10_000 }, (_, i) => i),
      {
        maxBytes: 512,
        recovery: "Assign it.",
      },
    );
    assert.ok(text.includes("elided. Assign it. …]"), text);
  });

  it("a container whose only element is a huge container is elided one level down", () => {
    const inner = Array.from({ length: 100_000 }, (_, i) => i);
    const { text, truncated } = formatValue([inner], valueOpts(1024));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 1024);
    assert.match(
      text,
      /^\[\[0, 1, 2, .*\[… \d+ of 100000 elements elided\. Slice it\. …\], .*, 99999\]\]$/,
    );
    // With siblings after it, they are counted in a marker of their own.
    const withSiblings = formatValue([inner, 1, 2], valueOpts(1024)).text;
    assert.ok(withSiblings.endsWith(", 1, 2]"), withSiblings.slice(-40));
    assert.match(withSiblings, /^\[\[… 1 of 3 elements elided/);
  });

  it("the descent stops at a depth, then the remaining value is rendered whole and flat-cut", () => {
    let value: unknown = "x".repeat(20_000);
    for (let i = 0; i < 8; i++) value = [value];
    const { text, truncated } = formatValue(value, valueOpts(1024));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 1024);
    // Eight levels in, eight levels out: the descent adds brackets as it goes
    // and the whole render of what is left supplies the rest — both real ends.
    assert.ok(text.startsWith("[[[[[[[['xxx"), text.slice(0, 20));
    assert.ok(text.endsWith("xxx']]]]]]]]"), text.slice(-20));
  });

  it("a dict whose only entry is huge renders it whole for the flat cut; a small sibling is kept instead", () => {
    const only = new Map<string, unknown>([["big", "x".repeat(20_000)]]);
    const alone = formatValue(only, valueOpts(1024)).text;
    assert.ok(bytes(alone) <= 1024);
    assert.ok(alone.startsWith("{'big': 'xxx"), alone.slice(0, 20));
    assert.ok(alone.endsWith("xxx'}"), alone.slice(-20));

    const withSmall = new Map<string, unknown>([
      ["big", "x".repeat(20_000)],
      ["small", 1],
    ]);
    assert.equal(
      formatValue(withSmall, valueOpts(1024)).text,
      "{[… 1 of 2 entries elided. Slice it. …], 'small': 1}",
    );
  });

  it("a budget too small for the marker cuts the partial render head-only, claiming no total", () => {
    const { text, truncated } = formatValue(
      Array.from({ length: 300 }, (_, i) => i),
      valueOpts(48),
    );
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 48);
    assert.ok(text.startsWith("[0, 1, "), text);
    assert.match(text, /\[… truncated at 48B\. Slice it\. …\]$/);
  });
});

describe("formatValue — the boundary: exactly at the budget fits whole, one byte over elides", () => {
  const shapes: Array<[string, unknown]> = [
    ["list", Array.from({ length: 300 }, (_, i) => i)],
    ["dict", new Map(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))],
    ["set", new Set(Array.from({ length: 300 }, (_, i) => i))],
    ["nested", Array.from({ length: 50 }, (_, i) => new Map([[`k${i}`, [i, `v${i}`]]]))],
    ["string", "é".repeat(400)],
    ["unicode list", Array.from({ length: 100 }, (_, i) => `日${i}😀`)],
    ["one huge element", ["é".repeat(20_000)]],
    ["one huge entry", new Map([["k", Buffer.alloc(20_000, 0xe9)]])],
  ];

  it("fits whole at its own size; is cut and within budget at one less", () => {
    for (const [label, value] of shapes) {
      const full = formatValue(value, valueOpts(1 << 20));
      assert.equal(full.truncated, false, `${label}: the reference render was cut`);
      const n = bytes(full.text);

      const at = formatValue(value, valueOpts(n));
      assert.equal(at.truncated, false, `${label}: exactly at the cap reported as truncated`);
      assert.equal(at.text, full.text, `${label}: exactly at the cap was cut`);

      const under = formatValue(value, valueOpts(n - 1));
      assert.equal(under.truncated, true, `${label}: one byte over was not cut`);
      assert.ok(bytes(under.text) <= n - 1, `${label}: ${bytes(under.text)} bytes for ${n - 1}`);
      assert.notEqual(under.text, full.text);
    }
  });

  it("the ceiling holds for every shape at every budget, no split character, no partial marker", () => {
    for (const [label, value] of shapes) {
      for (const budget of [0, 1, 7, 8, 16, 33, 64, 100, 257, 1024, 4096, 16 * 1024]) {
        const { text } = formatValue(value, valueOpts(budget));
        assert.ok(bytes(text) <= budget, `${label} at ${budget}: ${bytes(text)} bytes`);
        assert.ok(
          isWholeUtf8(text) && !text.includes("�"),
          `${label} at ${budget}: split character`,
        );
        assert.ok(
          !text.includes("[… ") || text.includes(" …]"),
          `${label} at ${budget}: partial marker in ${JSON.stringify(text)}`,
        );
      }
    }
  });

  it("a budget of zero renders nothing and says so", () => {
    const { text, truncated } = formatValue([1, 2, 3], valueOpts(0));
    assert.equal(text, "");
    assert.equal(truncated, true);
  });

  it("a scalar that fits is never marked truncated; one that does not is", () => {
    assert.deepEqual(formatValue(42, valueOpts(2)), { text: "42", truncated: false });
    assert.equal(formatValue(12345, valueOpts(4)).truncated, true);
  });
});

describe("formatValue — the work is bounded by the budget, not by the value", () => {
  it("a 10^6-element set renders within budget in well under a second", () => {
    const set = new Set(Array.from({ length: 1_000_000 }, (_, i) => i));
    const t0 = performance.now();
    const { text, truncated } = formatValue(set, valueOpts(truncate.OUTPUT_MAX_BYTES));
    const took = performance.now() - t0;
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= truncate.OUTPUT_MAX_BYTES);
    assert.ok(text.startsWith("{0, 1, 2, "));
    assert.ok(text.endsWith(", 999999}"));
    assert.ok(took < 2000, `took ${took.toFixed(0)} ms`);
  });

  it("a deeply nested value that fits renders whole", () => {
    let value: unknown = 1;
    for (let i = 0; i < 200; i++) value = [value];
    const { text, truncated } = formatValue(value, valueOpts(4096));
    assert.equal(truncated, false);
    assert.equal(text, `${"[".repeat(200)}1${"]".repeat(200)}`);
  });

  // A container dominated by one huge scalar used to be spelled in full — up
  // to four times — before the flat cut kept 16 KiB of it: 3.5 s for a 10 MB
  // string in a list, 42 s for 100 MB (fix round 1). The bound below is loose
  // for a loaded CI host and still an order of magnitude under the old cost.
  const WORK_BOUND_MS = 500;
  const timed = (value: unknown, budget = truncate.OUTPUT_MAX_BYTES) => {
    const t0 = performance.now();
    const result = formatValue(value, valueOpts(budget));
    return { ...result, took: performance.now() - t0 };
  };

  it("a 10 MB string in a list keeps both real ends within budget, in bounded time", () => {
    const { text, truncated, took } = timed(["x".repeat(10_000_000)]);
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= truncate.OUTPUT_MAX_BYTES);
    assert.ok(text.startsWith("['xxx"), text.slice(0, 20));
    assert.ok(text.endsWith("xxx']"), text.slice(-20));
    assert.ok(took < WORK_BOUND_MS, `took ${took.toFixed(0)} ms`);
  });

  it("a 10 MB string as a dict's only value, the same", () => {
    const { text, took } = timed(new Map([["k", "x".repeat(10_000_000)]]));
    assert.ok(bytes(text) <= truncate.OUTPUT_MAX_BYTES);
    assert.ok(text.startsWith("{'k': 'xxx"), text.slice(0, 20));
    assert.ok(text.endsWith("xxx'}"), text.slice(-20));
    assert.ok(took < WORK_BOUND_MS, `took ${took.toFixed(0)} ms`);
  });

  it("10 MB of bytes in a list, the same", () => {
    const { text, took } = timed([Buffer.alloc(10_000_000, 0x61)]);
    assert.ok(bytes(text) <= truncate.OUTPUT_MAX_BYTES);
    assert.ok(text.startsWith("[b'aaa"), text.slice(0, 20));
    assert.ok(text.endsWith("aaa']"), text.slice(-20));
    assert.ok(took < WORK_BOUND_MS, `took ${took.toFixed(0)} ms`);
  });

  it("an exception carrying a 10 MB message — the top-level scalar path — the same", () => {
    const exc = tagged("Exception", { excType: "ValueError", message: "x".repeat(10_000_000) });
    const { text, took } = timed(exc);
    assert.ok(bytes(text) <= truncate.OUTPUT_MAX_BYTES);
    assert.ok(text.startsWith("ValueError('xxx"), text.slice(0, 20));
    assert.ok(text.endsWith("xxx')"), text.slice(-20));
    assert.ok(took < WORK_BOUND_MS, `took ${took.toFixed(0)} ms`);
  });
});

// ── formatValue — a value spelled from both ends, never whole (fix round 1) ──
//
// When the elision's ends fit nothing, the one huge element is rendered from
// its head and from its tail under the budget and the flat cut joins them.
// The whole was never spelled, so the cut's marker claims no total — the
// path-5 marker, `[… truncated at 1.0KB. … …]`, rather than an `X of Y` it
// could only know by doing the work the budget forbids.

describe("formatValue — a value spelled from both ends claims no total", () => {
  const noTotal = /\[… truncated at 1\.0KB\. Slice it\. …\]/;

  it("a list whose only element is a huge string: both real ends, no total", () => {
    const { text } = formatValue(["x".repeat(20_000)], valueOpts(1024));
    assert.ok(bytes(text) <= 1024);
    assert.match(text, noTotal);
    assert.ok(!text.includes("KB of "), "a total was claimed for a value never spelled whole");
    assert.ok(text.startsWith("['xxx") && text.endsWith("xxx']"), text);
  });

  it("the tail is the real tail: a string's closing escapes, bytes' closing escapes", () => {
    const str = formatValue([`${"a".repeat(20_000)}\n\t'end`], valueOpts(1024)).text;
    // The text holds a `'` and no `"`, so Python double-quotes it — at both ends.
    assert.ok(str.startsWith('["aaa'), str.slice(0, 12));
    assert.ok(str.endsWith("\\n\\t'end\"]"), str.slice(-16));
    assert.match(str, noTotal);

    const raw = Buffer.concat([Buffer.alloc(20_000, 0x61), Buffer.from([0, 255, 10])]);
    const byt = formatValue([raw], valueOpts(1024)).text;
    assert.ok(byt.startsWith("[b'aaa"), byt.slice(0, 12));
    assert.ok(byt.endsWith("\\x00\\xff\\n']"), byt.slice(-16));
  });

  it("an astral string cut at both ends never shows a split surrogate", () => {
    const { text } = formatValue(["😀".repeat(20_000)], valueOpts(1024));
    assert.ok(bytes(text) <= 1024);
    assert.ok(isWholeUtf8(text) && !text.includes("�"));
    assert.ok(!/\\ud[89a-f]/.test(text), `a lone surrogate at an edge: ${text}`);
    assert.ok(text.startsWith("['😀") && text.endsWith("😀']"), text);
    assert.match(text, noTotal);
  });

  it("a dict's huge entry descends through its value behind the key, elided between elements", () => {
    const inner = Array.from({ length: 100_000 }, (_, i) => i);
    const { text, truncated } = formatValue(new Map([["k", inner]]), valueOpts(1024));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 1024);
    assert.match(
      text,
      /^\{'k': \[0, 1, 2, .*\[… \d+ of 100000 elements elided\. Slice it\. …\], .*, 99999\]\}$/,
    );
    // Beyond the descent's depth the container is still spelled from both
    // ends only — the tail walk mirrors the head's, last elements first.
    let deep: unknown = inner;
    for (let i = 0; i < 5; i++) deep = [deep];
    const d = formatValue(deep, valueOpts(1024)).text;
    assert.ok(d.startsWith("[[[[[[0, 1, 2, "), d.slice(0, 24));
    assert.ok(d.endsWith(", 99998, 99999]]]]]]"), d.slice(-24));
    assert.match(d, noTotal);
  });

  it("a huge key does not descend: the entry is spelled from both ends, its cyclic value included", () => {
    const cyclic: unknown[] = ["x".repeat(20_000)];
    cyclic.push(cyclic);
    const value = new Map<unknown, unknown>([["k".repeat(20_000), cyclic]]);
    const { text } = formatValue(value, valueOpts(1024));
    assert.ok(bytes(text) <= 1024);
    assert.ok(text.startsWith("{'kkk"), text.slice(0, 12));
    assert.ok(text.endsWith("xxx', [...]]}"), text.slice(-20));
    assert.match(text, noTotal);
  });

  it("a top-level exception with a huge message: both real ends, no total", () => {
    const exc = tagged("Exception", { excType: "ValueError", message: "x".repeat(20_000) });
    const { text, truncated } = formatValue(exc, valueOpts(1024));
    assert.equal(truncated, true);
    assert.ok(bytes(text) <= 1024);
    assert.ok(text.startsWith("ValueError('xxx") && text.endsWith("xxx')"), text);
    assert.match(text, noTotal);
  });
});

// ── The policy document says what shipped (D149) ─────────────────

describe("docs/truncation-policy.md — structure-aware output elision is recorded as shipped", () => {
  const policy = readFileSync(new URL("../docs/truncation-policy.md", import.meta.url), "utf8");

  it("the decision table no longer calls output elision blocked", () => {
    assert.match(policy, /\| \*\*Structure-aware\?\*\* \| no \| yes/);
    assert.doesNotMatch(policy, /no — \*\*blocked\*\*, see Q4/);
  });

  it("Q4 records the repr, its budget and the documented losses", () => {
    assert.match(policy, /elements elided/);
    assert.match(policy, /tuple → list/);
    assert.doesNotMatch(policy, /Structure-aware `output` elision — Q4, blocked on #69/);
  });
});
