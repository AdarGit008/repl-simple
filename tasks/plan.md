# Implementation Plan: DNS-rebinding interim hardening — issue #199

Source of truth: `SPEC.md`. Stacked on branch `issue-199-dns-rebinding`.
One task = one coder dispatch = one orchestrator commit. Order is fixed: Task 1 → Task 2 → Task 3.

## Overview

`http_get` validates every resolved address against the SSRF blocklist, then hands `fetch` the
hostname — so the connect-time lookup can reach an address the validation never saw (check/use
TOCTOU). This flight implements the **no-new-dependency interim hardening** from issue #199: an
ever-private process-lifetime memory plus a two-lookups-agree check, both failing closed inside
`assertReachable` (`src/builtins.ts`). The `undici` custom-dispatcher fix stays deferred.

## Architecture Decisions

- **D1 — Interim, no new dependency.** `undici` is not added; the ever-private + two-lookups-agree
  heuristics are implemented in `src/builtins.ts` on top of the existing `lookupImpl` seam.
- **D2 — Fail closed inside `assertReachable`.** All detection lives in the one place that already
  resolves and validates; `fetch` is only reached after detection passes. Existing blocklist,
  per-hop re-validation, timeout, approval default, and 256 KiB cap are untouched.
- **D3 — Ever-private memory (Task 1).** Module-scoped `Set<string>`, keyed by case-normalized
  hostname, process-lifetime. Refuse before resolving if present; record when any resolved address
  `isBlockedAddress`. Test-only reset export for isolation.
- **D4 — Two-lookups-agree (Task 2).** Resolve a second time via the same `lookupImpl`; compare
  address sets order-insensitively; refuse on mismatch. Reordered-but-identical sets do not trigger.
- **D5 — Distinct, fail-closed errors.** "previously resolved to a private address" vs "rebinding
  detected (address set changed between lookups)" — both refuse, never degrade to a prompt or pass.
- **D6 — Doc stays truthful (Task 3).** `docs/http-egress.md`'s "accepted risk" rebinding note is
  updated to state the interim hardening and the remaining undici-only residual.

## Task List

### Phase 1: Ever-private memory

- [ ] **Task 1** — Ever-private process-lifetime memory
  - Acceptance: `assertReachable` refuses a hostname already in the memory before any lookup; records
    a hostname when any of its resolved addresses is blocked; refuses it on every later call even when
    it later resolves public. Test-only reset export present and used by tests.
  - Verify: `npm test`, `npm run check`, `npm run build`, `npm run lint`; RED test (private-then-public
    hostname still refused via memory) fails at HEAD, green after.
  - Files: `src/builtins.ts`, `test/builtins.test.ts`.

### Checkpoint: after Task 1
- [ ] Ever-private memory refuses a repeat offender; full suite green; `check`/`build`/`lint` clean.

### Phase 2: Two-lookups-agree

- [ ] **Task 2** — Two-lookups-agree detection
  - Acceptance: `assertReachable` resolves twice and refuses when the two address sets differ
    (order-insensitive); proceeds when they match (incl. reordered = same set). No real DNS in tests.
  - Verify: `npm test`, `npm run check`, `npm run build`, `npm run lint`; RED test (injected
    `lookupImpl` returns different sets → refused) fails at HEAD, green after.
  - Files: `src/builtins.ts`, `test/builtins.test.ts`.
  - Depends on: Task 1.

### Checkpoint: after Task 2
- [ ] Rebinding (set mismatch) and ever-private (repeat offender) both fail closed; stable public
      hostname still succeeds; suite + gates green.

### Phase 3: Documentation

- [ ] **Task 3** — Update `docs/http-egress.md`
  - Acceptance: the "accepted risk" / rebinding-window text now states the interim hardening and the
    remaining (undici-only) residual; no stale claims remain.
  - Verify: `npm run lint`; manual read of the diff.
  - Files: `docs/http-egress.md`.
  - Depends on: Task 2.

### Checkpoint: complete
- [ ] All three tasks landed; suite + coverage floors green; ready for VERIFY / REVIEW / SHIP.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Two-lookups false-positive on anycast/geo-DNS | Med | Order-insensitive set compare; recorded as accepted residual (AS4) |
| Ever-private memory leaks across tests | Med | Test-only reset export (AS3/D3) |
| Second lookup doubles DNS latency per fetch | Low | Accepted; two lookups, not N |
| Detection placed outside the canonical path | Med | D2: everything lives in `assertReachable` |
| Doc drifts from code | Low | Task 3 keeps `docs/http-egress.md` truthful (D6) |

## Open Questions

None — recorded as SPEC assumptions AS1–AS6.
