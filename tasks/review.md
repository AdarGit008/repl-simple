# Review — issue #78: Converge on runRlm and delete rlm_loop.ts

code-reviewer persona (fresh context). Source of truth: `SPEC.md` D48–D60, `tasks/plan.md`.
Diff reviewed: `git diff 920ff62..HEAD` (11 commits, T1–T8 + VERIFY + REVIEW).

## Verdict

**Approve** — no Critical issues; one Important hardening gap (fixed in commit `ce7e8e9`), plus
Suggestions.

## Overview

The convergence is clean and to spec: every decision D48–D60 is implemented and test-pinned, the
type-layering inversion is removed, and the public surface is preserved.

## Critical Issues

None.

## Important Issues

- **`src/rlm.ts` option validation — non-finite numerics defeat the bounds.** `maxIterations` /
  `maxDepth` / `depth` were checked with `< 1` / `< 0` only, so `NaN` / `Infinity` passed and made
  the recursion guard (`depth >= maxDepth`) always false → unbounded `rlm_query` recursion (each
  level spawning a sandbox session), and `maxIterations: Infinity` an unbounded loop. **Fixed**
  (`ce7e8e9`): validation now uses `Number.isInteger` + bounds, with 8 new tests (NaN / Infinity /
  fractional for each option).

## Suggestions

- `src/rlm.ts:1067-1082` — nested `runRlm` forwards `runOptions.inputs` + merged `context` but not
  the parent's top-level `options.inputs`; document or confirm the asymmetry (D52 only requires
  `context`).
- `src/rlm.ts:1037-1038,1051-1055` — `onLLMQuery`/downgrade prompts interpolate model-generated
  strings unbounded and are not `raceAgainstSignal`-wrapped (parity with the main loop).
- `src/rlm.ts:477-480,1095` — `renderTypeStubs()` re-spawns a sandbox session per `runRlm` and per
  nesting level; not shared across levels.
- `src/rlm.ts:1183` — `extractBestAnswer(iterations) ?? ""`: the `?? ""` is dead (always a string).
- `test/rlm.test.ts:3738` — property-test title "every exit path" omits the `error` branch (the
  branch is tested elsewhere at :1029).
- `src/rlm.ts:1083` — nested non-`ok` discards the child's salvaged `answer` (spec-correct per D52).

## What's Done Well

- D49 layering is genuinely clean: `types.ts` is a leaf; no circular imports.
- D51 collision guard + self-registration runs synchronously before any await — race-free.
- D50 carries the F-77 + D17 wording verbatim; `options.systemPrompt` override still works.
- D53 abort-vs-error is correct (`signal.aborted` checked before the error return).
- Tests genuinely strong: all 5 status branches + nesting/collision/prompt/lineOffset all asserted.

## Verification Story

- Tests: 1026 pass / 0 fail; check + build clean; coverage gate met (`rlm.ts` 99.31 ≥ 99.14).
- Security: input-name validation intact at the single merge site; no new dependencies.
- `grep RLMLoop src/` returns nothing.
