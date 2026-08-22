# Implementation Plan: issues #189, #190 — one provider-error rule site, and the cause behind it

## Overview

Two small, behaviour-preserving changes in `src/rlm.ts`, both closing #184 ship-report follow-ups:

1. **#189** — the D53 top-level catch stops spelling the provider-error truncation out inline and
   calls `redactProviderError(err)`, the helper #184 already introduced for the two tool paths.
   After this, exactly one expression in the module names `RLM_ERROR_MAX_BYTES` /
   `HEAD_ONLY_RATIO` / `RLM_ERROR_RECOVERY` together.
2. **#190** — the two tool paths re-throw through a new `sandboxProviderError(err): Error`, which
   builds `new Error(redactProviderError(err), { cause: err })`. The message crossing the sandbox
   boundary is unchanged; the original rejection becomes reachable in-process.

Neither changes what any surface renders. The tests are therefore **drift pins**, not RED-first
failures — see "On RED-first" below.

## Architecture Decisions (SPEC D1–D6, not restated)

- **D1/D2** — `redactProviderError` is the string rule; `sandboxProviderError` is the throw shape.
- **D3** — `cause` is carried verbatim; it reaches no surface (A2).
- **D4/D5** — equality pins at `calls[].error` against the D53 catch's output, long and short.
- **D6** — the truncation policy records a consolidation, not a new surface.

## On RED-first

The repo's default is RED-first, and it does not fit a consolidation: before the change both sites
compute the identical string, so no test can distinguish them. What the tests must catch is the
**next** change — a cap or ratio applied at one site and not the other. That is exactly what the
equality pins do, and it was verified by mutation rather than asserted: dropping the D53 site's cap
to 512 B while the tool paths stayed at 1 KiB turned three of the four new tests red (plus three
pre-existing #167 tests). Recorded in the ship report.

## Task List

### Phase 1: the consolidation and the throw shape
- [ ] **Task 1 (T1)** — D53 catch → `redactProviderError`; add `sandboxProviderError`; both tool
      paths throw it (`src/rlm.ts`). Four equality/drift pins in `test/rlm.test.ts`.

### Checkpoint 1
- [ ] Focused `npx tsx --test test/rlm.test.ts` green; full `npm test` green; `npm run check` +
      `npm run build` clean; scoped lint (`npx biome check src extensions test`) clean.
- [ ] Mutation-verify the drift pin: drift the D53 site's cap, confirm the new tests go red,
      restore.

### Phase 2: the record
- [ ] **Task 2 (T2)** — `docs/truncation-policy.md`: cite #189 on the two existing provider-error
      rows, add the `#189 / #190` narrative after the `#184` one.

### Checkpoint 2
- [ ] Re-read the edited policy sections against the landed code. Doc-only; no test changes.

## Files

- `src/rlm.ts` — the two helpers and the three call sites.
- `test/rlm.test.ts` — one new `describe` block, four tests.
- `docs/truncation-policy.md` — two row citations, one narrative paragraph.

## Out of scope

`#191` (marker size disclosure) and `#192` (the 1 KiB window) — both filed, both decisions rather
than defects. `#171` stacks on this branch and is not part of this PR.
