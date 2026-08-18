# Review — issue #156: delimit the ok-branch `Output:` section against stdout forgery

Five-axis review of the working-tree diff (base `97cc786`, branch `issue-156-output-delimit`) by the
code-reviewer persona (fresh context). Source of truth: `SPEC.md` D36–D40 + Assumptions, `tasks/plan.md`,
issue #156 body. Reviewed code: `src/rlm.ts`, `test/rlm.test.ts`, `docs/truncation-policy.md`.

## Verdict: REQUEST CHANGES — one Important finding (test 3 locator measures a delimiter byte and pins a zero-headroom boundary; SPEC rationale is inaccurate). The `src/rlm.ts` change itself is correct and approved as-is.

## Overview

The flight closes the last un-delimited feedback section by mirroring D19's `> `-quote onto the
ok-branch `Output:` value. The code change is a faithful three-line mirror of `quotedError`
(`src/rlm.ts:670-676`): `Output:` and the real `\nstdout:` delimiter stay at column 0, only the
attacker-controlled `output` is prefixed, and the `output ? … : ""` ternary keeps empty output
byte-identical (pinned by the new test 26). Tests, typecheck and lint are all green (1047/1047,
`tsc --noEmit`, biome). The one substantive issue is in the test 3 locator update, which is
unnecessary for its stated reason and introduces a 1-byte delimiter artifact into the 32 KiB
ceiling measurement with zero headroom.

## Critical Issues

None.

## Important Issues

- **test/rlm.test.ts:1706 (and 1710-1713) — test 3's new locator `"\nstdout:"` includes the
  delimiter's trailing newline in the measured section, pinning the 32 KiB assertion at exactly
  32768 with zero headroom; the SPEC/plan rationale for the change is inaccurate.**
  Verified: with `output:"None"` (empty → no quoting), the old locator `"stdout:\n"` still resolves
  to the real delimiter (index 9) and measures the stdout content = 32767 bytes; the new locator
  resolves at index 8 and measures `"\n" + stdout` = 32768 bytes — a +1 delimiter byte, exactly at
  the `<= 32*1024` ceiling (zero slack). The SPEC D38 claim that the old locator is "ambiguous after
  quoting — a forged `stdout:` line renders `> stdout:\n`" does not apply to test 3's data: `output`
  is `"None"`, so `quotedOutput` is `""` and no line is quoted, so the old locator is not ambiguous
  for this test. The update is a defensible *robustness* improvement (anchoring on the leading
  newline), but as written it (a) measures a delimiter byte as if it were stdout content and (b)
  leaves the ceiling assertion with no tolerance — any future 1-byte change in the truncator's
  marker/recovery arithmetic would flip it to a spurious failure unrelated to the actual invariant.
  **Fix (one line):** use the full delimiter `const marker = "\nstdout:\n";` (anchors on the leading
  newline for the anti-forgery symmetry AND excludes the delimiter entirely, restoring the 32767-byte
  measurement), or revert to the old `"stdout:\n"` which is already unambiguous for empty output.
  Update the D38 rationale to match: test 3's data is empty-output, so the locator change is
  defensive, not a quote-compensation.

## Suggestions

- **docs/truncation-policy.md:442-443 — the `≤ 2×` growth-bound sentence is now stale for the ok
  branch.** After the D39 edit the paragraph says "error and output lines are `> `-quoted (D19, D36)"
  but the growth-bound sentence still reads "the quoted error section renders ≤ 2× its value budget".
  Consider "the quoted error and output sections render ≤ 2× their value budgets …" so the
  pathological-newline bound is stated for both quoted branches.
- **src/rlm.ts:594-596 and 670-675 — the `.split("\n").map((line) => \`> ${line}\`).join("\n")`
  expression is now duplicated verbatim.** Extracting a shared `quoteLines(text)` helper would keep
  the two branches from drifting (a one-line divergence would reopen the vector asymmetrically). The
  flight deliberately left the error branch untouched (D39 scope), so this is a non-blocking
  follow-up, not a defect.

## What's Done Well

- **The new test pins the actual close, not a string shape.** Test 25 (`test/rlm.test.ts:2130-2165`)
  is a faithful mirror of test 18: it asserts exactly one column-0 `stdout:` line (the forged line
  must render `> stdout: FORGED`), which is precisely the delimiter-imitation property being closed —
  not merely that a substring appears.
- **Coverage gap closed honestly.** The SPEC's own D40 notes the ternary condition is not
  mutation-provable (Stryker doesn't mutate ternary predicates) and that test 3 never exercised the
  empty else-branch; the flight added test 26 (`test/rlm.test.ts:2166-2181`) to pin the empty no-op
  exactly (`"Output: \nstdout:\nreal"`), rather than papering over the gap.
- **Minimal, disciplined scope.** The `src/rlm.ts` change is a three-line mirror of `quotedError`
  with a comment that explains *why* (column position is the close; quoting is presentation, so the
  prefix never counts against the budget). Error branch, `src/truncate.ts`, the never-list, and
  `coverage-baseline.json` are untouched; no `Buffer`/`byteLength` was introduced into `rlm.ts`
  (respecting the source ban); no new budget constant (correctly — quoting is presentation, as D19).
- **test 2's update is both correct and necessary.** Verified: the raw quoted section measures 16393
  bytes (would overrun the 16384 ceiling) while `unquoted(outputSection)` measures 16383 — the
  `unquoted()` round-trip is the exact test 8 pattern, and the elided/recovery matches correctly keep
  testing the raw (quoted) shape.

## Verification Story

- **Tests reviewed:** yes. Read test 25/26 (new), test 2/3 (updated), test 18 (the D19 mirror), and
  the `unquoted()` helper (`test/rlm.test.ts:56-61`). Confirmed via a throwaway script that: (a) test
  25 fails at the pre-fix shape (raw render → two column-0 `stdout:` lines, no `> stdout: FORGED`);
  (b) test 2's old raw measurement (16393) overruns while `unquoted()` (16383) does not; (c) test 3's
  new locator measures 32768 vs the old 32767 (+1 delimiter byte).
- **Build verified:** `npm run check` (`tsc --noEmit`) exits 0; `npm run lint` (biome) exits 0;
  `npm test` 1047/1047 pass (focused `test/rlm.test.ts` 136/136). `npm run build` not run (it emits
  into the working tree; the noEmit typecheck covers the compile gate).
- **Security checked:** yes. The ok-branch close is complete — the only column-0 lines after the
  change are the literal `Output: ` and the real `\nstdout:` delimiter; every `\n`-introduced output
  line carries the `> ` prefix, so a forged `\nstdout:` (or `> stdout:` inside content, which renders
  `> > stdout:`) cannot reach column 0. The suspended and no-output branches are static strings (no
  attacker text). Honest residual, out of scope and pre-existing: the **stdout value itself** is
  still rendered raw in both branches (`\nstdout:\n${stdout}` / `\nstdout: ${stdout}`), so
  attacker-influenced stdout could forge a *nested* `\nstdout:` at column 0 — marginal (steering-only,
  self-referential) and not part of this issue's vector. Edge cases reviewed and acceptable: output
  ending in `\n` (or newline-only) renders a dangling `> ` line — symmetric with the pre-existing D19
  error-branch behavior, not a regression; CRLF retains `\r` at line ends with no column-0 forgery;
  `output === "None"` is handled by the pre-existing `"None"` short-circuit, unchanged by this flight.
