# Spec: DNS-rebinding interim hardening for `http_get` — issue #199

## Objective

Close (interim) the DNS-rebinding TOCTOU in `http_get`: today the hostname is resolved and every
returned address is validated against the blocklist (`assertReachable` in `src/builtins.ts`), but
`fetch` is then handed the **hostname**, so the connect-time lookup can resolve to a different,
unvalidated address. A resolver that answers "public" to the validation lookup and "private" to the
connect lookup reaches a blocked destination.

This is residual **R2** from the STOP-SHIP A33–A37 flight (severity **Low**, defense-in-depth).
Primary SSRF defences (manual per-hop re-validation, 30 s timeout, 256 KiB cap, approval default) are
already strong and **must not be weakened**.

Success = the interim no-new-dependency hardening described in issue #199 is implemented and tested:
a rebinding attempt (or a hostname that has ever resolved to a private address) **fails closed**.

## Tech Stack

- TypeScript (Node >= 22.19.0), NodeNext modules, strict mode.
- Test runner: `node:test` via `tsx --test`.
- No new dependencies. `undici` (the long-term fix) is **not** added here — it stays behind the
  documented revisit trigger.

## Commands

```
Install:  npm ci
Test:     npm test                       # tsx --test test/*.test.ts
Focused:  npx tsx --test test/builtins.test.ts
Type:     npm run check                  # tsc --noEmit
Build:    npm run build                  # tsc -p tsconfig.build.json
Lint:     npm run lint                   # biome check --error-on-warnings
Coverage: npm run coverage               # per-file floors
```

## Project Structure

```
src/builtins.ts          → http_get implementation: assertReachable, defaultLookup/lookupImpl,
                           fetchImpl, isBlockedAddress (v4/v6), readResponseTextLimited
test/builtins.test.ts    → unit tests for builtins incl. http_get + address policy
docs/http-egress.md      → the egress policy decision record (must stay truthful)
```

## Code Style

Follow the existing `src/builtins.ts` conventions: small pure helpers, explicit types, JSDoc on
exported symbols, `AbortSignal`-based timeouts, injectable seams for tests (e.g. the existing
`lookupImpl`). No new abstractions unless they earn their complexity. Example shape:

```typescript
/** Hostnames observed resolving to a blocked address, remembered process-lifetime. */
const everPrivate = new Set<string>();

export function assertReachable(url: URL, opts: EgressOptions): Promise<void> {
  // 1. ever-private memory check
  // 2. resolve (lookupImpl), validate against isBlockedAddress, record ever-private
  // 3. second lookup, order-insensitive set compare (two-lookups-agree)
  // fail closed on any mismatch / blocked address
}
```

## Testing Strategy

- Unit tests in `test/builtins.test.ts`, using the existing `lookupImpl` injection (no real DNS).
- RED first: a test that reproduces the rebinding window must fail at HEAD, then pass after the fix.
- Cover: (a) first-lookup-private → refused and remembered; (b) later-lookup-public-after-private →
  still refused via memory; (c) two-lookups-disagree → refused; (d) two-lookups-agree on a stable
  public set → succeeds (no false positive on identical sets, incl. reordered = same set); (e)
  existing blocklist behaviour unchanged.
- No test may perform real network I/O.

## Boundaries

- **Always:** RED→GREEN per task; run `npm test`, `npm run check`, `npm run build`, `npm run lint`
  after each change; fail closed (never weaken the blocklist, per-hop re-validation, timeout,
  approval default, or 256 KiB cap); keep `docs/http-egress.md` truthful.
- **Ask first:** adding dependencies (e.g. `undici`); changing CI config.
- **Never:** commit secrets; weaken the SSRF blocklist; remove failing tests to make the suite pass.

## Success Criteria

1. `assertReachable` refuses a hostname whose resolved address set differs across two consecutive
   lookups (order-insensitive set comparison).
2. `assertReachable` remembers, process-lifetime, any hostname that has ever resolved to a blocked
   address, and refuses it on every subsequent call.
3. A stable public hostname (identical address set on both lookups) still resolves and fetches.
4. Existing blocklist / per-hop / timeout / approval / cap behaviour is byte-for-byte unchanged in
   outcome.
5. `docs/http-egress.md` updated to state the interim hardening and the remaining (undici-only)
   residual.
6. Full suite green: `npm test`, `npm run check`, `npm run build`, `npm run lint`, coverage floors.

## Assumptions (recorded — autonomous run)

- **AS1** No new dependency; `undici` custom-dispatcher `lookup` stays deferred to its revisit trigger.
- **AS2** Both interim layers are implemented (ever-private + two-lookups-agree), each as its own
  task/commit, because the issue lists them as "and/or" and both are cheap defense-in-depth.
- **AS3** Ever-private memory is process-lifetime, module-scoped in `src/builtins.ts`, keyed by
  case-normalized hostname; a test-only reset helper is exported for test isolation.
- **AS4** Two-lookups-agree compares address **sets** order-insensitively. Genuinely
  non-deterministic public address sets (anycast failover, geo-DNS) may false-positive and are
  accepted as the interim heuristic's known cost — recorded as a residual. Round-robin reordering
  (same set) does not trigger it.
- **AS5** Detection fails closed with a distinct error message distinguishing "rebinding detected"
  from "previously resolved to a private address".
- **AS6** No real DNS in tests; all rebinding scenarios are simulated through `lookupImpl`.

## Open Questions

None for this run — all ambiguities are recorded as AS1–AS6.
