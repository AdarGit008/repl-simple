# Todo — L1+L2 ever-private hardening (issue #199 residuals)

Source of truth: `SPEC.md` + `tasks/plan.md`. One item = one coder dispatch = one orchestrator commit.
Order is fixed: Task 1 → Task 2.

- [ ] **Task 1 — Normalize the ever-private key (L2)**
  - [ ] RED — `test/builtins.test.ts`: record a hostname under one spelling (`Example.COM.` resolving
        private) → a later call under another spelling (`example.com`, `EXAMPLE.COM.`, `example.com.`)
        is refused via memory before lookup. Fails at HEAD.
  - [ ] GREEN — single `everPrivateKey(hostname)` helper (lowercase + strip one trailing dot) used by
        both the membership check and recording; the hostname passed to `lookupImpl` is normalized.
  - [ ] No false positive: a stable public hostname spelled with a trailing dot still resolves and
        fetches.
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/builtins.ts`, `test/builtins.test.ts`.

- [ ] **Task 2 — Cap the ever-private set, fail closed at saturation (L1)**
  - [ ] RED — fill the set to `EVER_PRIVATE_MAX_ENTRIES` via injected private lookups (read the
        constant, no magic number); assert the set never exceeds the cap and the next distinct
        private-resolving hostname fails closed with a distinct "saturated" error and is not fetched.
        Fails at HEAD.
  - [ ] GREEN — `rememberEverPrivate(hostname)` returns false at saturation; `assertReachable`
        refuses with a distinct error and never fetches. Membership of an already-recorded hostname
        still works at saturation.
  - [ ] Keep `__resetEverPrivateForTests` clearing the set; use it for isolation.
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/builtins.ts`, `test/builtins.test.ts`.
  - Depends on: Task 1.
