# Implementation Plan: L1+L2 ever-private hardening — issue #199 residuals

Source of truth: `SPEC.md`. Stacked on branch `issue-199-l1-l2-everprivate-hardening`.
One task = one coder dispatch = one orchestrator commit. Order is fixed: Task 1 → Task 2.

## Overview

The #199 `everPrivate` memory in `src/builtins.ts` has two recorded residuals: it is **unbounded**
(L1) and its key is **not trailing-dot-normalized** (L2). This flight adds a hard cap with
fail-closed refusal at saturation (L1) and a single normalized key — lowercase + one trailing dot
stripped — applied to both the memory key and the resolution input (L2). Both are defense-in-depth;
no primary SSRF defence changes, no new dependency.

## Architecture Decisions

- **D1 — Cap as a named module constant.** `EVER_PRIVATE_MAX_ENTRIES = 1024`, exported so tests read
  the real value instead of a magic number. Not env-configurable (AS1).
- **D2 — Normalize once, use everywhere.** A single `everPrivateKey(hostname)` helper (lowercase +
  strip one trailing dot) is the only way the key is formed; `rememberEverPrivate` and the
  membership check both go through it. The hostname handed to `lookupImpl` is also normalized so
  resolution and memory agree on one spelling.
- **D3 — Fail closed at saturation.** `rememberEverPrivate(hostname)` returns `false` when the set
  is at capacity and the key is absent; the caller refuses with a distinct "ever-private memory
  saturated" error and never fetches. Membership of an already-present key still works at
  saturation.
- **D4 — Preserve the seam.** `__resetEverPrivateForTests` keeps its name and semantics (clears the
  set); the new tests use it for isolation. Existing #199 behaviour (two-lookups-agree, blocklist,
  per-hop, timeout, approval, cap) is untouched.

## Task List

### Phase 1: Key normalization (L2)

- [ ] **Task 1** — Normalize the ever-private key (lowercase + single trailing dot), on both the key
  and the resolution input.
  - Acceptance: a hostname recorded under any spelling is refused under every spelling before
    lookup; a stable public hostname (including a trailing-dot spelling) still fetches; the key
    normalization is unit-covered.
  - Verify: RED test (record `Example.COM.` private → later `example.com` refused via memory) fails
    at HEAD, green after. `npm test`, `npm run check`, `npm run build`, `npm run lint`.
  - Files: `src/builtins.ts`, `test/builtins.test.ts`.
  - Depends on: None.

### Checkpoint: after Task 1
- [ ] Every spelling maps to one key; no false positive on a trailing-dot public host; suite + gates green.

### Phase 2: Bound the memory (L1)

- [ ] **Task 2** — Cap the ever-private set; fail closed at saturation.
  - Acceptance: the set never exceeds `EVER_PRIVATE_MAX_ENTRIES`; at saturation a new distinct
    private-resolving hostname is refused with a distinct error and not fetched; an already-recorded
    hostname is still refused at saturation; `__resetEverPrivateForTests` still clears the set.
  - Verify: RED test (fill to cap via injected private lookups, next distinct private hostname fails
    closed) fails at HEAD, green after. `npm test`, `npm run check`, `npm run build`, `npm run lint`.
  - Files: `src/builtins.ts`, `test/builtins.test.ts`.
  - Depends on: Task 1.

### Checkpoint: complete
- [ ] L1 and L2 landed; suite + coverage floors green; ready for VERIFY / REVIEW / SHIP.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Saturation = availability loss (new private hostnames post-saturation not remembered) | Low | Accepted and bounded (AS5); fail-closed refusal, distinct error, cap is a named constant |
| Trailing-dot strip breaks a legitimately distinct hostname | Low | Only one trailing dot stripped; FQDN `example.com.` is DNS-equivalent to `example.com`; covered by a no-false-positive test |
| Cap constant too low/high | Low | 1024 is generous for legitimate use, small enough to bound memory; exported for easy audit |
| Test loops 1024× against the real path are slow | Low | Injected `lookupImpl` (no DNS), in-memory; negligible per iteration |
| Both tasks touch the same functions → messy commits | Low | Separate tasks/commits; Task 2 builds on Task 1's helper |

## Open Questions

None — recorded as SPEC assumptions AS0–AS6.
