# Ship Report — L1+L2 ever-private hardening (issue #199 residuals)

Branch: `issue-199-l1-l2-everprivate-hardening` · Base: `origin/main` (`9e126af`) · Code commits: `1d19371`–`952053e` · Decision: **GO**

## What was built

Hardening of the #199 `everPrivate` process-lifetime memory in `src/builtins.ts` `assertReachable`:

1. **L2 — key normalization.** A single `everPrivateKey(hostname)` helper (lowercase + strip one
   trailing dot) is the only key former, used by both the membership check and recording; the
   hostname handed to the resolver is normalized the same way. Every spelling (`example.com`,
   `example.com.`, any case) now maps to one entry.
2. **L1 — bound the memory.** `EVER_PRIVATE_MAX_ENTRIES = 1024` (named, exported). `rememberEverPrivate`
   fails closed at saturation: the request is refused with a distinct "ever-private memory saturated"
   error and is never fetched. Membership of an already-recorded hostname still works at saturation.

No primary SSRF defence changed: blocklist, two-lookups-agree, per-hop re-validation, 30 s timeout,
approval default, and 256 KiB cap are unchanged in outcome. No new dependency.

## Verification evidence

- **Phase 4 (test-engineer):** round 1 FAIL — `src/builtins.ts` dropped to 98.76% vs the 99.45% floor
  (untested second-lookup saturation throw). Coder added three tests (second-lookup saturation,
  mixed second lookup, reset-empties-set); round 2 **PASS** — 1108 pass / 0 fail; `check`/`build`/`lint`
  clean; `npm run coverage` "All per-file floors met" (`src/builtins.ts` 99.53% vs 99.45%).
- **Phase 5 (code-reviewer):** **APPROVE**. 0 Critical, 0 Important. Five non-blocking suggestions
  (duplicated saturated-error block; single-vs-multiple trailing dot; test-only export surface;
  pre-existing allowlist trailing-dot asymmetry; optional docs note).
- **Phase 6 (security-auditor):** **GO**. 0 Critical / 0 High / 0 Medium / 1 Low / 3 Info. Confirmed
  no primary defence weakened; saturation path genuinely fail-closed; no new disclosure surface.

## Residual risks (recorded, not hidden — non-blocking)

- **R1 (Low, from security-auditor):** at saturation, a hostname first appearing post-saturation is
  refused but **not** remembered, degrading the ever-private cross-attempt control. Requires control
  of an allowlisted wildcard domain plus ~1024 attacker-visible refused fetches to set up, and grants
  nothing beyond the already-documented connect-time residual (validation resolves the name but
  `fetch` still connects to the hostname, not the validated IPs). Refusal (not eviction) is the
  accepted fail-closed choice. Corrected in `SPEC.md` AS5. Real close = the `undici` custom-dispatcher
  `lookup` (still deferred per its revisit trigger).
- **R2 (Info):** validation resolves the normalized hostname while `fetch` connects to the original
  `url.href` (trailing dot may remain). Not exploitable — `example.com.` and `example.com` are the
  same DNS query on the wire; the blocklist runs on resolved addresses regardless of spelling.
- **I1 (Info):** two test-only exports (`__resetEverPrivateForTests`, `__everPrivateSizeForTests`)
  ship in the production module surface. Not wired to any tool/boundary; no exploitability.

## Rollback plan

| Commit | Reverts |
|---|---|
| `952053e` | coverage-gap tests (test-only; reverting re-opens the floor breach — revert only together with the L1/L2 code below) |
| `549b59f` | L1 cap + fail-closed saturation |
| `48185fe` | L2 key normalization |
| `1d19371` | SPEC + plan + todo (planning artifacts) |

- Revert L1 only: `git revert 549b59f 952053e` (drops the cap and its tests; L2 normalization stays).
- Revert L2 only: `git revert 48185fe` (normalization only; L1 cap remains on the normalized key).
- Revert full flight: `git revert 952053e 549b59f 48185fe 1d19371` (newest-first) → returns to `9e126af`.

## Go / No-Go

**GO.** Defense-in-depth hardening of the #199 memory; no Critical/High/Medium findings across all
three report sources; all five gates green (test / check / build / lint / coverage); no weakening of
any primary SSRF defence; no new dependency. The single Low finding is bounded, requires detectable
attacker effort to set up, and is recorded as a residual in `SPEC.md` AS5.
