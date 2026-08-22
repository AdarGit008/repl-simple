# Todo — DNS-rebinding interim hardening (issue #199)

Source of truth: `SPEC.md` + `tasks/plan.md`. One item = one coder dispatch = one orchestrator commit.
Order is fixed: Task 1 → Task 2 → Task 3.

- [ ] **Task 1 — Ever-private process-lifetime memory**
  - [ ] RED — `test/builtins.test.ts`: a hostname that resolves to a private address is refused; a
        later call where the same hostname resolves public is still refused (memory). Fails at HEAD.
  - [ ] GREEN — module-scoped `Set<string>` (case-normalized hostname); `assertReachable` refuses
        members before lookup and records a hostname when any resolved address `isBlockedAddress`.
  - [ ] Export a test-only reset helper; use it in tests for isolation.
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/builtins.ts`, `test/builtins.test.ts`.

- [ ] **Task 2 — Two-lookups-agree detection**
  - [ ] RED — injected `lookupImpl` returning different address sets across two calls → refused;
        identical (incl. reordered) sets → succeeds. Fails at HEAD.
  - [ ] GREEN — `assertReachable` resolves a second time; order-insensitive set compare; mismatch →
        fail closed with a distinct "rebinding detected" error.
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/builtins.ts`, `test/builtins.test.ts`.
  - Depends on: Task 1.

- [ ] **Task 3 — Update `docs/http-egress.md`**
  - [ ] Rewrite the "accepted risk" rebinding window text: interim hardening landed (ever-private +
        two-lookups-agree), remaining residual is the undici custom-dispatcher connection pinning.
  - [ ] No stale claims; `npm run lint` clean.
  - Files — `docs/http-egress.md`.
  - Depends on: Task 2.
