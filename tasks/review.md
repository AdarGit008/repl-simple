# Review — issue #33: Plumb signal and limits through the extension and ReplRunner

code-reviewer persona (fresh context). Source of truth: `SPEC.md` D1–D7. Diff reviewed:
`git diff a934fbd..HEAD` (T1–T5 + VERIFY fix).

## Verdict

**Approve** — no Critical or Important issues; three Suggestions.

## Overview

The flight implements D1–D7 faithfully: `limits` is forwarded verbatim through
`ReplRunner.run`/`resume`, the model boundary clamps two knobs via a pure helper, the
abort-semantics contract is documented and pinned, and all four issue tests pass (plus the full
1041-test suite). Clean, well-commented, genuinely discriminating tests.

## Critical Issues

None.

## Important Issues

None.

## Suggestions

- `extensions/repl-extension.ts:354` — `repl_resume` forwards no `limits`. A resumed run re-applies
  sandbox defaults (30 s / 512 MiB) instead of the clamped limits granted to the original `repl`
  call. Scoped out by SPEC (open-question 1 / D3) — not a defect, but a behavioural asymmetry worth
  a follow-up.
- `extensions/repl-extension.ts:101-102,119` — fractional `maxMemory` can yield sub-byte /
  non-integer byte counts (e.g. `0.1` MiB → `104857.6` bytes) reaching Monty verbatim. Self-harm
  only, never a cap/security issue; flooring to integer bytes would remove the edge.
- `test/extension.test.ts` `runWithLimits` helper — prototype monkey-patches
  `ReplRunner.prototype.run`; safe under sequential node:test, would race if parallelised. A
  one-line comment noting the assumption would do.

## What's Done Well

- Clamp lives at exactly the right boundary (extension clamps; `ReplRunner` forwards verbatim).
- D4 JSDoc is accurate to `Session.run`'s `status === "ok"`-only push.
- The four D7 tests genuinely fail on regression (reference-identity RunOptions guard; side-effect
  counter; positive-control rollback assertion).
- Byte conversion (`1_048_576`) and caps (300 s / 1024 MiB) match the sandbox defaults exactly;
  upper-bound-only clamp.
- `_signal` reconciliation handled with a rationale comment, not a rename (correct under
  `noUnusedParameters`).

## Verification Story

- Tests: 1041 pass / 0 fail. Focused `test/repl.test.ts test/extension.test.ts` → 142 pass.
- `npm run check` + `npm run build` clean; `npx biome check src extensions test` clean (the
  `.pi-subagents/*.json` lint noise is untracked and out of scope).
