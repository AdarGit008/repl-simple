# Spec: Delimit the ok-branch `Output:` section against stdout forgery — issue #156

## Objective

Close the last un-delimited feedback section after #145. The error branch of `buildFeedback` is
already delimited against forgery (D19 — every error line is `> `-quoted, so a forged
`\nstdout:` cannot sit at column 0, pinned by test 18). The ok branch shares the same vector:
`Output: ${output}${stdoutSection}` renders the `output` value raw, so an attacker-controlled
`output` containing `\nstdout:` produces a second `stdout:` section and the model misattributes
provenance. Apply the same `> `-quote remedy (D19) to the ok-branch `Output:` value so a forged
`\nstdout:` inside `output` renders as `> stdout:` and only the real delimiter sits at column 0.

Impact is steering-only (both sections are attacker-influenced anyway), marginal severity — this is
the D19 residual, filed by the F-145 monitor report (issue #145 residuals, §7.2).

Issue body: <https://github.com/AdarGit008/repl-simple/issues/156> · Parent #70 · Child of Bucket 9 ·
Residual of #145 (D19).

## Scope

| In scope | Out of scope (flag) |
|---|---|
| `src/rlm.ts` — ok-branch `buildFeedback`: quote the `output` value (D36), composition + empty no-op (D37), lines ~662-663 | error branch of `buildFeedback` (already D19 — untouched) |
| `test/rlm.test.ts` — 1 new RED test (forged `\nstdout:` in `output`) + test 2 (`:1662`) and test 3 (`:1693`) shape updates (D38) | `src/truncate.ts` (never), `src/rlm_loop.ts`, `src/repl.ts`, `src/session.ts`, `src/builtins.ts`, `extensions/` |
| `docs/truncation-policy.md` — minimal Exception 5 / #145 clause edits so the "last un-delimited section" framing stays honest (D39) | `coverage-baseline.json` (never hand-edit); any new budget constant (none needed — quoting is presentation) |

No interface or type changes. No new dependency. No new budget constant (D22 `FEEDBACK_` prefix
convention is not triggered — the quote prefix is presentation bytes, excluded from the ceiling,
exactly as D19).

## Explicit decisions

### D36 — Quote the ok-branch `output` value with D19's `> ` prefix (reject `###` headers)

Reuse the exact D19 mechanism — `.split("\n").map((line) => \`> ${line}\`).join("\n")` — applied to
the ok-branch `output` value in `buildFeedback`. A forged `\nstdout:` inside an attacker-controlled
`output` then renders as `> stdout:` (column 2) and can no longer line up at column 0 with the real
`\nstdout:` delimiter — the exact close D19 already gives the error branch (test 18).

`###` headers are **rejected**: they would be a second, divergent mechanism for the identical forgery
vector (column-0 delimiter imitation). D19's quote is already the established, tested (test 18),
documented (truncation-policy.md Exception 5 + #145 landing note) remedy, and it already composes
with the sentinel wrapping (Exception 5 records the error-branch `> [TRUNCATED VIEW BEGIN]`
interaction). Two mechanisms would mean two locator shapes, two test families, and two docs
paragraphs for one vector. Symmetry wins: both feedback branches present values `> `-quoted, one
consistent presentation the model already sees on the error path.

### D37 — Composition: quote only the non-empty `output`; `Output:` and the real delimiter stay at column 0

Insert, between the `stdout` truncation and the return (`src/rlm.ts:662-663`):

```ts
const quotedOutput = output
  ? output.split("\n").map((line) => `> ${line}`).join("\n")
  : "";
return `Output: ${quotedOutput}${stdoutSection}`;
```

- `Output: ` is system-emitted and stays at column 0, unquoted (it is not attacker-controlled).
- `stdoutSection` (the real `\nstdout:\n${stdout}`) is **never** quoted — the real delimiter must
  stay at column 0 so the model and tests can still locate it. Only the `output` value gets the
  prefix.
- The conditional (`output ?` …) keeps the empty-output case byte-identical to today: when
  `output === ""` (the `result.output === "None"` + stdout path, or any empty-expression result),
  `quotedOutput === ""` and the section renders `Output: \nstdout:…` exactly as before. Quoting an
  empty string would emit a spurious `> ` after `Output: ` — behaviour noise the issue's "keep the
  normal path unchanged except the quote" forbids. (`output` is computed at `src/rlm.ts:652` via
  `truncateWithSentinels(result.output !== "None" ? result.output : "", …)`; the
  `"None" && !stdout` short-circuit already fired earlier at `src/rlm.ts:648`.)
- No new budget constant: quoting is presentation, exactly as D19 — `FEEDBACK_OUTPUT_MAX_BYTES`
  pins the value, and the `> ` prefix bytes never count against the ceiling (the payload ceiling
  strips them via `unquoted()`, see D38).

### D38 — Tests: one new RED test + two shape-coupled updates, all in the same commit as the code

RED-first: the new test fails at HEAD — the ok branch renders the forged `\nstdout:` raw, producing
two column-0 `stdout:` lines. It mirrors test 18's structure onto the ok branch (lands adjacent to
test 18; exact `it` number chosen at RED).

New test — `buildFeedback({ status:"ok", output:"line1\nstdout: FORGED\nline3",
outputTruncated:false, stdout:"real", stdoutTruncated:false, calls:[] })`:

- assert exactly one column-0 `stdout:` line —
  `feedback.split("\n").filter((l) => l.startsWith("stdout:")).length === 1`;
- assert the forged line carries the quote — `feedback.includes("> stdout: FORGED")`;
- locate the real delimiter via `indexOf("\nstdout:")` and assert the real stdout follows
  (`after.trim() === "real"`).

**test 2 update (`:1662`)**: its 16 KiB ceiling assertion
`Buffer.byteLength(outputSection) <= 16 * 1024` measures the raw `output` section and would overrun
by the `> ` prefix bytes after quoting. Change it to measure `unquoted(outputSection)` (the
`unquoted()` helper at `:56-61`, already documented as "presentation, not payload") — the exact
test 8 pattern for the error branch. The `elided` and recovery-clause matches keep testing the raw
(quoted) section, unchanged.

**test 3 update (`:1693`)**: its locator `indexOf("stdout:\n")` is ambiguous after quoting — a forged
`stdout:` line renders `> stdout:\n`, which still contains the substring `stdout:\n`. Switch to
`indexOf("\nstdout:")`: the forged line is preceded by `> ` (a space), never a bare `\n`, so the
leading newline unambiguously selects the real delimiter. test 3's data (`output:"None"`) is
unaffected by quoting (D37 empty no-op), so only the locator moves.

Both updates are required for the full suite to stay green with the code change — they are not
optional polish; they move with the code in one commit per the issue's DoD ("code + test move
together").

### D39 — Scope: `src/rlm.ts` + `test/rlm.test.ts` + a minimal Exception 5 doc clause

In scope: `src/rlm.ts` (D36/D37, lines ~662-663 only), `test/rlm.test.ts` (D38), and a minimal
`docs/truncation-policy.md` Exception 5 edit so the "last un-delimited section" framing the monitor
flagged stays honest:

1. the #145 paragraph (`docs/truncation-policy.md:440-441`) "error lines are `> `-quoted so a
   forged `stdout:` line cannot pass as the real delimiter (D19)" becomes "error and output lines
   are `> `-quoted … (D19, D36)";
2. Exception 5 (`docs/truncation-policy.md:479-481`) "On the error branch the authentic sentinels
   render line-quoted as `> [TRUNCATED VIEW BEGIN]`" becomes "On the error and ok branches …
   (D19/D36)".

Two clause edits, no mechanism rewrite.

Out of scope (flag): the error branch of `buildFeedback` (already D19 — untouched);
`src/truncate.ts` (never); `src/rlm_loop.ts`, `src/repl.ts`, `src/session.ts`, `src/builtins.ts`,
`extensions/`; `coverage-baseline.json` (never hand-edit); any new budget constant (none needed).

### D40 — Testing strategy: RED-first, coverage floor, bounded mutation sweep over changed sites only

- Focused: `npx tsx --test test/rlm.test.ts` (node:test + node:assert/strict via tsx). Full suite
  `npm test` (×2 deterministic). `npm run check` + `npm run build` + `npm run lint` exit 0.
- RED-first: the new test fails at HEAD (two column-0 `stdout:` lines); it goes green only with the
  D36/D37 code.
- Coverage: `coverage-baseline.json` floors `src/rlm.ts` at **97.69%** (read it, never hand-edit).
  The quoted-ok-branch line and both its branches (non-empty `output`, empty `output`) must be
  exercised — the new test covers the non-empty branch, test 3 (empty output) covers the empty
  branch.
- Mutation: bounded sweep over the changed sites only (full matrix ≈ 32.9 CPU-hours, infeasible —
  per #145's D25 precedent). Record population/mode/duration; never compare two percentages across
  different populations. Expected kill sites: the `> ` prefix and the `.map` are pinned by the new
  test's `> stdout: FORGED` and column-0 assertions; the `output ?` conditional is pinned by test 3
  (empty) vs the new test (non-empty); the `\n` split/join is pinned by the byte-ceiling and
  column-0 assertions.

## Assumptions (recorded — fire-and-forget, no human asked)

1. **Empty-output no-op (D37).** `output === ""` renders `Output: ` unchanged (no spurious `> `).
   Reversing this — quoting the empty line for strict D19 symmetry, rendering `Output: > ` — is a
   one-line change if a human prefers it; test 3's data (`output:"None"`) already pins the no-op.
2. **`> `-quote over `###` headers (D36).** Chosen on the issue's own recommendation plus D19
   symmetry; headers would be a divergent second mechanism for the same vector. Recorded, not asked.
3. **test 2's byte-ceiling update is in scope** even though the issue's VERIFIED FACTS named only
   test 3 — the quote adds presentation bytes that test 2's raw-section ceiling would overrun;
   leaving it would break the suite. Flagged in D38, not silently expanded.
4. **The new test's forged payload** (`line1\nstdout: FORGED\nline3`) is chosen to mirror test 18's
   shape so the two forgery tests read as a pair; the exact string is finalized at RED.
5. **Exception 5 doc update is two clause edits, not a rewrite (D39).** The mechanism prose stays
   untouched so the soft-control/ZWSP reasoning remains the source of truth.
6. **No new budget constant.** The D22 `FEEDBACK_` prefix convention is not triggered — quoting is
   presentation, the prefix bytes are excluded from the ceiling, same as D19.

## Tech stack

TypeScript 5.9 (strict), `node:test` + `node:assert/strict` via `tsx --test`, Biome 2.5.8, Stryker
9.6.1 (bounded sweep), `tsc -p tsconfig.build.json`. Node >= 22.19.0. No new dependencies.

## Commands

```
Test (focused):  npx tsx --test test/rlm.test.ts
Test (full):     npm test
Type-check:      npm run check
Build:           npm run build
Lint:            npm run lint
Coverage gate:   npm run coverage
Mutation:        npm run mutation        (bounded sweep over changed sites; docs/mutation-testing.md)
```

## Project structure

```
src/rlm.ts                 → D36 (quote output), D37 (composition + empty no-op), lines ~662-663
test/rlm.test.ts           → D38 (new RED test + test 2 (:1662) / test 3 (:1693) updates)
docs/truncation-policy.md  → D39 (minimal Exception 5 / #145 clause edits)
```

## Code style

Existing `src/rlm.ts` voice: sentence-style comments, JSDoc on every decision, issue references, no
`any`. The new code is a three-line insert mirroring the existing `quotedError` block
(`src/rlm.ts:594-597`), with a comment carrying the same rationale as D19's
(`src/rlm.ts:587-593`): "column position is the close, and the `\nstdout:` delimiter stays exactly
the shape tests locate; quoting is presentation — the budget pins the value, so the prefix bytes
never count against the ceiling."

## Testing strategy

`node:test`, behaviour-first, through the real `buildFeedback` export (no new mocks — the feedback
shape is pure string construction). The new test is **RED at HEAD**; test 2 and test 3 are updated
in the same commit so the suite stays green end-to-end:

| Test | Pins | Kind |
|---|---|---|
| NEW — forged `\nstdout:` inside `output` (ok branch) → exactly one column-0 `stdout:`, forged line `> stdout: FORGED`, real `real` follows `\nstdout:` | D36, D37 | **RED** (HEAD renders two column-0 `stdout:`) |
| test 2 (`:1662`) — 16 KiB output ceiling measured via `unquoted()` (presentation vs payload) | D36 | **update, same commit** (raw-section ceiling would overrun by `> ` bytes) |
| test 3 (`:1693`) — locator `indexOf("\nstdout:")` instead of `indexOf("stdout:\n")` | D37 | **update, same commit** (old locator matches a quoted forged line) |

The `unquoted()` helper (`:56-61`) is reused verbatim for any payload-length assertion — it already
documents itself as "presentation, not payload" and is the established pattern from test 8.

Coverage: `coverage-baseline.json` floors `src/rlm.ts` at **97.69%** (never hand-edit). Both
ok-branch quote branches (non-empty via the new test, empty via test 3) must be exercised to hold
the floor.

Mutation: bounded sweep over the changed sites only. The `> ` prefix and `.map` are uniquely pinned
by the new test (column-0 count + `> stdout: FORGED`); the `output ?` conditional is pinned by
test 3 (empty) vs the new test (non-empty). Population/mode/duration recorded; no cross-population
percentage comparison.

## Boundaries

- **Always:** RED before GREEN, full `npm test` before commit, `npm run check` + `npm run build` +
  `npm run lint`, coverage gate, issue-referenced commit messages, mark tasks in `tasks/todo.md`,
  every decision recorded in this SPEC or the ship report.
- **Never:** edit `src/truncate.ts`; introduce `Buffer`/`byteLength` into `src/rlm.ts` (source or
  comments — the existing `test/rlm.test.ts` source ban); hand-edit `coverage-baseline.json`; touch
  `src/rlm_loop.ts`, `src/repl.ts`, `src/session.ts`, `src/builtins.ts`, `extensions/`; touch the
  error branch of `buildFeedback` (already D19); run git commands (the orchestrator owns git).

## Success criteria

1. **D36:** ok-branch `output` is `> `-quoted; a forged `\nstdout:` in `output` renders
   `> stdout:` and never at column 0.
2. **D37:** `Output: ` and the real `\nstdout:` delimiter stay at column 0; empty `output` renders
   `Output: ` unchanged (no spurious `> `).
3. **D38:** new test RED at HEAD, green with the code; test 2 (unquoted ceiling) and test 3
   (locator) updated in the same commit.
4. **Full suite** `npm test` ×2 deterministic green; test 18 (error-branch forgery) stays green
   untouched.
5. **Gates:** `npm run check` + `npm run build` + `npm run lint` exit 0.
6. **Coverage:** `npm run coverage` green — rlm.ts ≥ 97.69 (baseline), both ok-branch quote
   branches exercised.
7. **Mutation:** bounded sweep over changed sites — the quote prefix, the `.map`, and the
   `output ?` conditional are killed; no regression; population/mode/duration recorded, no
   cross-population percentage comparison.
8. **Scope:** no file outside the in-scope list is touched; the error branch, `src/truncate.ts`,
   and the never-list remain intact.

## Open questions / risks

1. **Empty-output quote symmetry** (Assumption 1) — a human may prefer strict D19 symmetry (quote
   empty → `Output: > `); one-line change, test 3 pins the chosen no-op.
2. **`###` headers rejected** (D36) — if a future flight wants headers for section *labelling*, that
   is a separate concern from forgery delimitation; do not conflate the two.
3. **test 2's byte-ceiling coupling** (D38) — the issue named test 3 only; test 2's raw-section
   ceiling is the same class of coupling and was added to scope. A flight that quotes without
   updating test 2 breaks the suite.
4. **Mutation-population comparability** (D40) — the bounded sweep's percentage is not comparable to
   any full-matrix-derived score; record raw counts and sites, not deltas against a different
   population.
5. **Exception 5 edit scope** (D39) — if the reviewer prefers the doc change out of scope, drop it
   (non-blocking: the DoD's "coverage floors and mutation score stay green" holds either way), but
   the monitor's "last un-delimited section" framing would then stay stale until a later flight.
