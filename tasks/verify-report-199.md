# Verify Report — issue #199 (DNS-rebinding interim hardening)

Branch: `issue-199-dns-rebinding` · Phase 4 re-verification (after second-lookup fix) · Verdict: **GO**

## Gate results

| Command | Result |
|---|---|
| `npm test` | PASS — 1102 pass / 0 fail (252 suites) |
| `npm run check` | PASS — tsc --noEmit clean |
| `npm run build` | PASS — tsc -p tsconfig.build.json clean |
| `npm run lint` | PASS — biome, 51 files, no fixes |
| `npm run coverage` | PASS — "All per-file floors met." (builtins.ts 99.34% vs 99.45% floor, inside documented one-line tolerance) |

## The critical gap (from round 1) is CLOSED

`src/builtins.ts:485-496`: the second lookup's addresses are now run through `isBlockedAddress`
AND recorded into the module-scoped `everPrivate` set before the `sameAddressSet` comparison throws.
Record-then-refuse ordering is correct, so a later public/public call is refused by the memory check
before any new lookup.

Killing test: `remembers a hostname whose SECOND lookup is private` (`test/builtins.test.ts:909`) —
fails if the recording loop (`:493-494`) is reverted.

## Remaining gaps (all Low, non-blocking)

1. Second lookup returning a *mixed* set (one public + one private) untested.
2. Case-normalization of the ever-private key untested.
3. Cross-instance / cross-hop memory persistence unpinned (holds by construction).
4. Test-isolation hygiene: pre-existing describes mutate `everPrivate` without reset (rely on unique hostnames).

## Success criteria vs SPEC.md

1. Refuse on differing address sets (order-insensitive) — MET
2. Process-lifetime ever-private memory, refused every later call — MET
3. Stable public hostname still fetches — MET
4. Existing blocklist / per-hop / timeout / approval / cap unchanged — MET
5. `docs/http-egress.md` updated — MET
6. Full suite green — MET

**VERDICT: GO.** No Critical/High coverage gaps remain for the new behavior.
