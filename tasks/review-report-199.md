# Review Report — issue #199 (DNS-rebinding interim hardening)

Branch: `issue-199-dns-rebinding` · Phase 5 code review (five-axis) · Verdict: **APPROVE**

## Critical Issues
None.

## Important Issues
None blocking.

## Suggestions (non-blocking)

- `src/builtins.ts:93` — `everPrivate` is unbounded and irreversible, process-lifetime; a `*` wildcard
  allowlist can drive unbounded unique-subdomain growth. Fix: cap / LRU-evict; note restart clears it.
  (By-design per SPEC AS3; Low.)
- `src/builtins.ts:466` — ever-private key is not trailing-dot-normalized; `example.com` vs
  `example.com.` are distinct keys. Fix: strip a single trailing `"."`.
- `src/builtins.ts:219` — `sameAddressSet` normalizes only trim+lowercase; IPv4-mapped spelling vs
  dotted-quad compares unequal → fail-closed false positive (no false negative). Non-issue with real
  `dns.lookup`.
- `docs/http-egress.md` / `tasks/plan.md` — "doubles DNS latency" understates per-hop cost (up to 12
  validation lookups across a 5-hop chain + connect lookups). Wording should say "per hop".
- `test/builtins.test.ts` — shared module state only reset by the two new describes; hoist a shared
  `beforeEach`/`afterEach` `__resetEverPrivateForTests()`.
- `src/builtins.ts:214` — `normalizeAddress` assumes a string (raw TypeError on a buggy `lookupImpl`
  escapes the `HostToolError` convention). Minor.

## What's Done Well

- The previously-found second-lookup recording gap is genuinely closed and killed-if-reverted.
- Fail-closed on every branch; no path degrades to a pass.
- Order-insensitive comparison correct and tested (dedup via Set, size check, reorder test).
- Distinct, truthful error messages; stale `defaultLookup` JSDoc corrected.
- Docs truthful ("narrowed, not closed"; undici residual; anycast/geo-DNS false-positive cost).

## Verification Story

- Tests: 7 new tests, each a genuine RED test against HEAD. `npm test` → 1102 pass / 0 fail.
- Build: check / build / lint all clean.
- Security: fail-closed throughout; no new dependencies; no secrets; connect-time residual correctly
  scoped as undici-only and documented.
