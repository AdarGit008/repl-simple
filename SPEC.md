# Spec: L1+L2 ever-private hardening — issue #199 residuals

## Objective

Harden the `everPrivate` process-lifetime memory added by issue #199 (DNS-rebinding interim
hardening in `src/builtins.ts` `assertReachable`). Two residuals were recorded in
`tasks/ship-report-199.md` and are now the scope of this flight:

- **L1 — bound the memory.** `everPrivate` is currently unbounded and irreversible. A `*` wildcard
  allowlist over an attacker-controlled domain can grow it monotonically for the life of the
  process. Fix: a hard cap, with **fail-closed refusal at saturation**.
- **L2 — normalize the key.** The ever-private key is not trailing-dot-normalized, so
  `example.com` and `example.com.` are distinct entries and one spelling can evade the memory of the
  other. Fix: strip a single trailing dot on the key *and* on the resolution input, and fold in the
  existing case-normalization so every spelling maps to one key.

This is defense-in-depth only. The primary SSRF defences (per-hop re-validation, 30 s timeout,
256 KiB cap, approval default, blocklist) are unchanged, and neither layer may weaken them.

Success = the `everPrivate` set is bounded and fails closed at saturation, and every spelling of a
hostname (case + trailing dot) maps to a single memory entry, all covered by RED→GREEN tests with
no real DNS.

## Tech Stack

- TypeScript (Node >= 22.19.0), NodeNext modules, strict mode.
- Test runner: `node:test` via `tsx --test`.
- No new dependencies.

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
src/builtins.ts          → everPrivate set, __resetEverPrivateForTests, assertReachable,
                           lookupImpl/defaultLookup, isBlockedAddress, fetchImpl
test/builtins.test.ts    → unit tests for the ever-private memory and address policy
docs/http-egress.md      → egress policy decision record (must stay truthful)
```

## Code Style

Follow the existing `src/builtins.ts` conventions: small pure helpers, explicit types, JSDoc on
exported symbols, injectable seams for tests (`lookupImpl`), `AbortSignal`-based timeouts. No new
abstractions unless they earn their complexity. Example shape:

```typescript
/** Ceiling on ever-private entries; saturation fails closed. */
export const EVER_PRIVATE_MAX_ENTRIES = 1024;

/** Normalized ever-private key: lowercase, single trailing dot stripped. */
function everPrivateKey(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Record a hostname as ever-private. Returns false at saturation (caller fails
 * closed); the set never exceeds {@link EVER_PRIVATE_MAX_ENTRIES}.
 */
function rememberEverPrivate(hostname: string): boolean {
  const key = everPrivateKey(hostname);
  if (everPrivate.has(key)) return true;
  if (everPrivate.size >= EVER_PRIVATE_MAX_ENTRIES) return false;
  everPrivate.add(key);
  return true;
}
```

`assertReachable` then (a) checks membership via `everPrivateKey(hostname)`, (b) records via
`rememberEverPrivate` after each lookup that observed a blocked address, and (c) refuses with a
distinct error when `rememberEverPrivate` returns `false`. The resolution input passed to
`lookupImpl` is the normalized hostname (single trailing dot stripped).

## Testing Strategy

- Unit tests in `test/builtins.test.ts`, using the existing `lookupImpl` injection and
  `__resetEverPrivateForTests`. No real DNS, ever.
- RED first: each new test must fail at HEAD, then pass after the fix.
- **L2 (normalization)** — record a hostname under one spelling (`Example.COM.` → private) and
  assert a later call under any other spelling (`example.com`, `EXAMPLE.COM.`, `example.com.`) is
  refused *before lookup* (memory hit). Also assert a stable public hostname with a trailing dot
  still resolves and fetches (no false positive).
- **L1 (bound)** — drive the real recording path to saturation (injected private lookups for
  distinct hostnames, looping `EVER_PRIVATE_MAX_ENTRIES` times — read the constant, never a magic
  number). Assert: the set never exceeds the cap; the next distinct private-resolving hostname
  fails closed with a distinct "saturated" error and is **not** fetched. Assert a hostname already
  in the set is still refused at saturation (membership is unaffected).
- Keep the two #199 gaps from `tasks/verify-report-199.md` that touch this code: a second lookup
  returning a **mixed** set (one public + one private) is refused and the private address is
  remembered; and the case-normalization of the key is exercised.

## Boundaries

- **Always:** RED→GREEN per task; run `npm test`, `npm run check`, `npm run build`, `npm run lint`
  after each change; fail closed (never weaken the blocklist, per-hop re-validation, timeout,
  approval default, or 256 KiB cap); keep `docs/http-egress.md` truthful (only touch it if a claim
  becomes stale).
- **Ask first:** adding dependencies; changing CI config.
- **Never:** commit secrets; weaken the SSRF blocklist; remove failing tests to make the suite pass.

## Success Criteria

1. The `everPrivate` set never exceeds `EVER_PRIVATE_MAX_ENTRIES`; recording at saturation fails
   closed with a distinct error and the request is refused, never fetched.
2. `example.com`, `example.com.`, and any case variant resolve to a **single** ever-private entry:
   recorded under one spelling, refused under all spellings, before lookup.
3. A stable public hostname — including one spelled with a trailing dot — still resolves and
   fetches (no false positive).
4. Existing blocklist / per-hop / timeout / approval / cap / two-lookups-agree behaviour is
   unchanged in outcome.
5. `__resetEverPrivateForTests` still exists, still clears the set, and is used by the new tests for
   isolation.
6. Full suite green: `npm test`, `npm run check`, `npm run build`, `npm run lint`, coverage floors.

## Assumptions (recorded — autonomous run)

- **AS0 (setup)** — The base branch is `issue-199-dns-rebinding` (the code this flight hardens lives
  there; `main` does not yet contain #199). Branching from an "up-to-date main" is interpreted as
  "up-to-date with its remote"; the L1/L2 follow-up must stack on the #199 branch.
- **AS1** — Cap is a named module constant `EVER_PRIVATE_MAX_ENTRIES = 1024`, exported for tests;
  not env-configurable (kept minimal; env override can come later if needed).
- **AS2** — L2 normalization is lowercase + strip a single trailing dot, applied both to the key and
  to the hostname passed to `lookupImpl`. Only one trailing dot is stripped (an empty/non-hostname
  result is not a valid host and is out of scope).
- **AS3** — Fail-closed at saturation means: refuse the current request with a distinct error and do
  **not** fetch. It never means silently proceeding or silently dropping the record.
- **AS4** — No new dependency; no change to `docs/http-egress.md` is required because the mechanism
  it describes is unchanged (the cap and normalization are implementation details of that mechanism).
- **AS5** — Saturation bounds the memory but degrades a defense-in-depth cross-attempt control:
  after saturation, a hostname first appearing post-saturation is refused when private in the
  current attempt but is not remembered for a later attempt. An attacker who controls an
  allowlisted wildcard domain and fills the cap (~1024 attacker-visible refused fetches) could
  rebind a fresh hostname across attempts. Bounded, requires detectable refusals to set up, and
  grants nothing beyond the already-documented connect-time residual (`fetch` still connects to the
  hostname, not the validated IPs). Refusal (not eviction) is the accepted fail-closed choice;
  recorded as the shipping residual.
- **AS6** — No real DNS in tests; all scenarios are simulated through `lookupImpl`.

## Open Questions

None for this run — all ambiguities are recorded as AS0–AS6.
