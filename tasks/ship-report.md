# Ship Report — issue #184: Redact provider errors on the llm_query / downgraded-rlm_query tool paths

## Decision: **GO** ✅

Not high-risk or irreversible (library hardening change — no auth, secrets, migrations, payments,
deploys; the change only *narrows* what surfaces from a failed LLM call). Security audit:
**0 Critical / 0 High / 0 Medium / 1 Low / 4 Info**. The single Low is the accepted, documented
1 KiB head-only residual (a provider secret placed in the leading 1 KiB — or in a sub-1 KiB message
— still surfaces); it is the deliberate bound carried from #167, not a defect. Acceptable to ship.

## What was built

| Decision | Item | Landed |
|---|---|---|
| D1/D2 | Source choke points at `onLLMQuery` and the downgrade branch; plain `truncateText`, no sentinel wrap | T1 |
| D3/D4/D5 | Reuse `RLM_ERROR_MAX_BYTES` (1 KiB) + `HEAD_ONLY_RATIO` (head-only) + `RLM_ERROR_RECOVERY` | T1 |
| D6/D7 | Re-throw `new Error(redactProviderError(err))`; module-private helper beside the constants | T1 |
| — | RED tests: llm_query path, downgrade path, bare-string `String(err)` branch, short-message pin | T1 + VERIFY |
| — | Truncation-policy Implementation-record row + `#184` narrative | T2 |
| — | Phase-4 gap close (positive truncation shape) + Phase-5 pin fix (no-truncation on short error) | VERIFY/REVIEW |

## Gates

- `npm test` — **1072/1072 pass** · `npm run check` + `npm run build` clean ·
  `npx biome check src extensions test` clean. (Repo-wide `npm run lint` has pre-existing
  `.pi-subagents/*` errors, not from this flight.)

## Review & audit

- Five-axis code review: **REQUEST CHANGES → resolved** — one Important finding (short-message pin
  didn't assert no-truncation) fixed in `68e1958`; remaining items are Suggestions (optional
  `{ cause }` on re-throw, DRY the `rlmRegistry()` helper).
- Security audit: **GO** — 0 Critical / 0 High / 0 Medium / 1 Low / 4 Info. Verified the raw
  provider tail no longer reaches `buildFeedback` or `iterations[].result.error`; head-only shape
  correct; re-throw introduces no reclassification or swallowing; no regression to #165/#167; no
  new dependencies.

## Rollback

- **Pre-merge (now):** branch is unmerged; rollback = do not merge, or
  `git branch -D issue/184-redact-provider-errors`. `main` is still `a64b3e7`.
- **Post-merge:** `git revert --no-commit 933339c 68e1958` then commit (5-commit range); or
  `git revert -m 1 <merge>` if squashed. Verify `npm test` back to 1070 pre-flight baseline
  (the four added tests go away with the revert).

## Residual risks & post-ship follow-ups

1. **[Low/security] 1 KiB head-only window** — a short provider error (≤1 KiB) passes verbatim, and
   a provider that *prefixes* request context would have it in the kept head. Documented, accepted
   bound (matches #167). Tighten the cap or strip known request-ID patterns only if the threat
   model demands it.
2. **[Info] D53 top-level catch duplicates the truncation inline** instead of calling
   `redactProviderError` (`src/rlm.ts:1256-1269` vs `:202-210`). Consolidate for a single rule site.
3. **[Info] Original error `cause`/type discarded on re-throw** — optionally
   `new Error(msg, { cause: err })` for debuggability (message unchanged).
4. **[Info] Elision marker discloses the redacted message's byte size** — accept (matches #167) or
   switch this call site to an `unknownTotal` marker if size disclosure matters.

## Close-out actions

- Merge `issue/184-redact-provider-errors` into `main` (closes #184).
- File the follow-ups above; leave #171 (signal-race + sentinel-wrap) and #182 (spend gaps, in
  flight) untouched — they touch the same file and were deliberately out of scope.
