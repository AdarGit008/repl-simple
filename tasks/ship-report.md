# F-77 SHIP Report — merge of review / verify / spec sources + final evidence

## Gates table

| Gate | Expected | Measured (ship audit) | Verdict |
|---|---|---|---|
| `npm test` | 986/986 | **986 pass / 0 fail / 0 skipped** | ✅ PASS |
| `npm run check` (tsc) | clean | clean | ✅ PASS |
| `npm run coverage` | all floors hold | all floors met (rlm 97.44, sandbox 97.65, session 98.70, rlm_loop 98.36, types 100) | ✅ PASS |
| `npm run lint` (biome) | clean | clean, 49 files | ✅ PASS |
| Commits `791096a..HEAD` | one logical change each | 11 commits (9.7a-9.7i + 2 docs), repo style, no stray files | ✅ PASS |
| Dependencies | none added | package.json / package-lock.json diffs empty | ✅ PASS |
| Secrets in diff | none | scan clean | ✅ PASS |
| Prompt addition | static, no interpolation | verified literal template, no `${}` in added block | ✅ PASS |
| Task list | all checked | all 10 tasks `[x]` | ✅ PASS |

## Source-of-truth merge

- **tasks/review.md** (Phase 5 code review): REQUEST CHANGES — Required finding (README claimed offset-corrected diagnostics while `RLMLoop` still leaked) fixed by Task 10a; Optional regex hardening fixed by Task 10b. Nits and FYIs recorded as residual.
- **tasks/verify-77.md** (Phase 4, 3 rounds): Round 1 NO-GO (typing diagnostics still shifted — SPEC premise false) fixed by Task 7; MEDIUM gaps fixed by Task 8 (which exposed and fixed a real pre-existing `Session.resume()` bug); Round 3 gates re-run by coder.
- **SPEC.md D1-D4**: all honored. D1 mechanics incl. typing-path correction and #144 cap preserved; D2 truth-telling contract adopted; D3 literals intact; D4 json route declined-with-record.

## Security verdict

**SAFE — strictly less model-visible source exposure, no new attack surface.**
- Transform is line-wise string surgery over Monty-rendered diagnostic text; rows at/≤ offset dropped, never emitted with non-positive numbers; the 16 KiB #144 cap still applies on corrected text.
- Prompt addition is static text; no user data interpolated → no prompt-injection surface.
- No auth / secrets / payments / destructive ops / deploys in the diff; no new dependencies.
- Hidden text never gates approval decisions (approvals key on tool name/args).
- **High-risk stop condition (auth/secrets/destructive/payments/deploys): CONFIRMED NOT APPLICABLE.**

## Decision

**🟢 GO — merge to main** (pending user confirmation at the Phase 6 human gate).

## Rollback plan

**Rollback unit = branch `issue/77-line-offset-continuity`** (nothing on main yet):
1. Preferred (pre-merge): don't merge — nothing to undo.
2. If merged without squash: revert in reverse order — `c9e0b1f` (9.7i) → `b1558af` (docs) → `0681c38` (9.7h) → `4ee8388` (9.7g) → `9e39c96` (9.7f) → `12f0b67` (9.7e) → `204224f` (9.7d) → `357319d` (9.7c) → `87aae68` (9.7b) → `2b15370` (9.7a) → `5757ce1` (docs). Each commit is one logical change. If squash-merged, revert that single commit.
3. Behavioral kill-switch built in: `lineOffset?` is additive and defaults to absent — after revert no caller passes it, sandbox renders as-is, existing callers get exact current behavior. No migrations/schema/env/config touched.

## Residual risks (recorded, not shipped)

1. `correctRuntimeError` re-implements Monty's traceback renderer — re-measure on the next monty bump.
2. `Session.prefixLineCount()` O(n²) over a session's lifetime (negligible today).
3. Multi-block typing diagnostic under offset unpinned (transform handles it by construction).
4. Runtime `endLine` correction unrendered (cosmetic).
5. Nit: `correctSyntaxErrorText` → `correctDiagnosticText` (it serves typing too).
