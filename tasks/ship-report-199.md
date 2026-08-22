# Ship Report — issue #199 (DNS-rebinding interim hardening)

Branch: `issue-199-dns-rebinding` · Date: 2026-08-22 · Decision: **GO**

## What was built

Interim (no-new-dependency) hardening of the `http_get` DNS-rebinding TOCTOU in
`src/builtins.ts` `assertReachable`:

1. **Ever-private process-lifetime memory** — a hostname that has ever resolved to a
   private/reserved address (via `isBlockedAddress`) is recorded and refused on every subsequent
   call, before any new lookup.
2. **Two-lookups-agree** — the hostname is resolved twice; an order-insensitive address-set
   mismatch fails closed as "possible DNS rebinding".

Both layers fail closed; the blocklist, per-hop re-validation, 30 s timeout, approval default, and
256 KiB cap are unchanged. `docs/http-egress.md` and the `defaultLookup` JSDoc were updated to state
the residual truthfully ("narrowed, not closed").

## Verification evidence

- **Phase 4 (test-engineer):** `npm test` 1102 pass / 0 fail; `check` / `build` / `lint` / `coverage`
  all clean (builtins.ts 99.34% vs 99.45% floor, inside documented tolerance). Round-1 found a
  Critical gap (second lookup's private address not recorded) — fixed in `7b5eb5b` and re-verified
  GO.
- **Phase 5 (code-reviewer):** **APPROVE**. 0 Critical, 0 Important. Six non-blocking suggestions.
- **Phase 6 (security-auditor):** **GO**. 0 Critical / 0 High / 0 Medium / 2 Low / 2 Info. Confirmed
  no primary SSRF defence weakened; no new dependency; no new disclosure surface.

## Residual risks (recorded, not hidden — non-blocking)

- **L1 (Low):** `everPrivate` Set is unbounded and irreversible, process-lifetime; a `*` wildcard
  allowlist over an attacker-controlled domain can grow it monotonically. Follow-up: hard cap with
  fail-closed refusal at saturation.
- **L2 (Low):** ever-private key is not trailing-dot-normalized; `example.com` vs `example.com.` are
  distinct keys (defense-in-depth hygiene only — the full blocklist + two-lookups still run on the
  re-entered variant). Follow-up: strip a single trailing dot on key + resolution.
- **I1 (Info):** `__resetEverPrivateForTests` ships in the production export surface (clearly named).
- **I2 (Info):** ever-private membership is a weak DNS-query-count oracle (requires control of the
  name's DNS).

The residual that remains by design: `fetch` still receives the hostname, not the validated IPs, so a
resolver answering public to both validation lookups but private only at connect-time is unseen.
Closed only by an `undici` custom-dispatcher `lookup` (deferred per its revisit trigger).

## Rollback plan

| Commit | Reverts |
|---|---|
| `7b5eb5b` | Record-private-on-second-lookup ordering fix |
| `70c9628` | `defaultLookup` JSDoc correction |
| `1863526` | `docs/http-egress.md` truthfulness update |
| `52eae37` | Two-lookups-agree layer |
| `91d2d53` | Ever-private memory layer |
| `0547189` | SPEC.md + tasks/plan.md + tasks/todo.md |

- Revert two-lookups layer only: `git revert 7b5eb5b 52eae37` (+ `70c9628` if its JSDoc references it).
- Revert ever-private layer only: `git revert 91d2d53`.
- Revert full flight: `git revert 1863526 70c9628 7b5eb5b 52eae37 91d2d53 0547189` (newest-first).
  Restores `8476fed`'s code and planning docs.

## Go / No-Go

**GO.** Defense-in-depth hardening, no Critical/High/Medium findings, no weakening of any primary SSRF
defence, no new dependency, no high-risk/irreversible category. The two Low findings are recorded as
follow-up issues and are not release gates.
