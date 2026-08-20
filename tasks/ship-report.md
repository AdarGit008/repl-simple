# Ship Report — issue #166 (enforce the D17 sentinel rule when options.systemPrompt is overridden)

## Decision: **GO** ✅

No Critical / High / Medium findings from any of the three report sources. The change is a correct,
well-tested security hardening: the D17 sentinel-authentication rule is now a single source of truth
(`SENTINEL_RULE`) and is guaranteed present on every **non-empty** `systemPrompt` — interpolated into
the default (byte-identical) and appended after any caller override. A caller can no longer silently
drop the forged-elision-marker defense by overriding the prompt. The two Low findings are pre-existing
or explicit-opt-in design characteristics, not regressions.

## Fan-out verdicts (all three sources covered — ship fan-out skip rule does not apply)

| Source | Verdict | Findings |
|--------|---------|----------|
| test-engineer (VERIFY) | **GO** | 1074 pass / 0 fail; `tsc` + biome clean; coverage floors met (`src/rlm.ts` 99.36% vs 99.14% floor, global 97.93% vs 97.84% baseline, no drop). Both D67 success criteria pinned; empty-string edge covered by the D65 floor test (still green). No blocking gap. |
| code-reviewer (REVIEW) | **APPROVE** | 0 Critical; 1 Important (JSDoc "always" overstated the empty-string carve-out) → fixed in `bbb4afa`; 3 Suggestions (wording assertion, symmetric end-count, guard callout) → all applied in `bbb4afa`. |
| security-auditor (SHIP) | **GO** | 0 Critical / 0 High / 0 Medium / 2 Low (pre-existing/accepted): (1) sentinel trust is instruction-enforced, a soft boundary — append-after gives the defense the final word; (2) empty-string override yields no sentinel guidance (explicit opt-in, D65-pinned). No new attack surface / secrets / supply chain. |

## What was built

One decision (D67) in the RLM system-prompt path:

- **`SENTINEL_RULE`** (`src/rlm.ts`) — the D17 bullet extracted verbatim as the single source of truth.
- **Interpolation** — `DEFAULT_RLM_SYSTEM_PROMPT` interpolates `SENTINEL_RULE` in its original position
  (second-to-last bullet), so the emitted default is byte-identical (pinned by the existing D17/D27
  contract regexes plus the new exactly-once count).
- **Append-after** — `runRlm` resolves `systemPrompt = options.systemPrompt ?? (await buildSystemPrompt(registry))`,
  then `if (options.systemPrompt) systemPrompt = \`${options.systemPrompt}\n${SENTINEL_RULE}\``.
  `undefined` → default (rule once); non-empty override → rule appended last; `""` → verbatim empty
  (preserves the D65 ≥1-token-floor test). The guard tests the *option*, never the resolved default,
  so the default path is never double-appended.
- **JSDoc** — `RlmOptions.systemPrompt` now states the accurate contract (rule appended after any
  non-empty override; empty string preserved verbatim).

Tests added in `test/rlm.test.ts` (`runRlm() — sentinel rule always present (D67)`): override-carries-
the-rule (appended after, with wording assertion) and default-rule-appears-exactly-once (symmetric
BEGIN/END count). Full suite: **1074 pass / 0 fail**.

## Residual risks (recorded, not hidden)

| Residual | Severity | Owner |
|----------|----------|-------|
| Sentinel trust is instruction-enforced (model told to trust only in-sentinel markers) — a data-injected "ignore the sentinels" could still persuade the model | Low | pre-existing D17 design; `truncateWithSentinels` neutralisation is the code-enforced backstop |
| `systemPrompt: ""` yields a prompt with no sentinel guidance | Low | explicit opt-in, D65-pinned (Assumption 7) |
| No test for whitespace-only override (`"  "` truthy → rule appended) | Info | optional future regression guard |
| `rlm_query` nesting forwards `options.systemPrompt`, so nested runs inherit the same guarantee — verified, no gap | — | closed by construction |

## Rollback plan

- **Trigger:** none expected; roll back if post-merge the full suite regresses or a caller reports
  unexpected prompt changes.
- **Steps:** `git revert bbb4afa 50cfb78` (reverts the implementation + polish commits; `b587a81` is
  spec/plan docs and can stay or be reverted separately). This restores the pre-D67 behavior exactly —
  the change is additive string surgery with no schema, data, or dependency footprint.
- **Verification after rollback:** `npm test`, `npm run check`, `npm run lint`.
- **Time to rollback:** < 5 minutes (single branch, no deploy/infra).

## Next step

Branch `issue/166-d17-sentinel` is ready to merge to `main` via PR. No feature flag or staged rollout
applies (library change, no runtime config).
