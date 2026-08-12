import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.ok(
      out.indexOf("LAST_LINE") > marker,
      "the marker must sit between head and tail",
    );
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
    const kept = t.render().split("\n").filter((l) => l && !l.startsWith("[…"));
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
