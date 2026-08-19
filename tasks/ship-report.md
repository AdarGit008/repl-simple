# Ship Report — issue #78: Converge on runRlm and delete rlm_loop.ts

## Decision: **GO** ✅

Not high-risk/irreversible (library refactor; no auth, secrets, migrations, payments, deploys; the
RLM path is not wired into the shipped extension). Security: **0 Critical / 0 High / 1 Medium /
2 Low / 2 Info**. The single Medium is a documented D52 design decision, bounded by hardened
recursion depth and the not-yet-shipped surface — acceptable to ship **provided it is filed as a
follow-up** (below).

## What was built

| Decision | Item | Landed |
|---|---|---|
| D48/D56 | `runRlm` canonical; `rlm_loop.ts` + its test deleted | T8 |
| D49 | RLM types moved into `rlm.ts`; layering inversion removed; barrel re-export | T1 |
| D51 | `runRlm` self-registers `llm_query`/`rlm_query`/`SUBMIT`; collision guard; validation | T3 |
| D52 | nesting, `maxDepth` downgrade, parent-context inheritance | T4 |
| D50 | registry-built system prompt (F-77 + D17 verbatim, names every tool) | T5 |
| D53/D54 | `status:"error"` + `error` field (result, not exception) | T6 |
| D58 | `maxIterations`→10 (M1), `scriptName`→"rlm.py" (M21) pinned by tests | T7 |
| D55 | `getReplPreamble` → `src/preamble.ts` | T2 |

## Gates

- `npm test` — **1026/1026 pass** · `npm run check` + `npm run build` clean · changed files
  Biome-clean.
- `npm run coverage` — **all per-file floors met** (`rlm.ts` 99.31 ≥ 99.14; `preamble.ts` floor
  100 met; `rlm_loop.ts` floor removed).
- Repo-wide `npm run lint` reports 87–89 pre-existing errors in untracked `.pi-subagents/` — not
  from this flight (CI on committed code is clean).

## Review & audit

- Five-axis code review: **Approve**, no Critical; one Important fixed in-flight (`ce7e8e9`).
- Security audit: **GO** — 0 Critical / 0 High / 1 Medium / 2 Low / 2 Info.

## Rollback

- **Pre-merge (now):** branch is unmerged; rollback = do not merge, or
  `git branch -D issue/78-converge-runrlm`. `main` is still `920ff62`.
- **Post-merge:** `git revert --no-commit d62903e..ce7e8e9` then commit (linear 11-commit range);
  or `git revert -m 1 <merge>` if squashed. Verify `npm test` back to pre-#78 baseline; `rlm_loop.ts`,
  `test/rlm_loop.test.ts`, and the `types.ts` RLM block are recoverable from `920ff62`.

## Residual risks & post-ship follow-ups

1. **[Medium/security] Bound spend of `llm_query`/`rlm_query`/nested `runRlm`** — `budget` bounds
   only the top-level loop; nested loops pass `budget: undefined` (D52). File under #70/#31.
2. **[Low] `options.systemPrompt` override drops the D17 sentinel rule** — enforce or require restate.
3. **[Low] Redact `RlmResult.error`** before return + re-interpolation into nested feedback.
4. **[Info] Per-iteration host-tool call cap** (`llm_query`/`rlm_query` breadth backstop).
5. **[Perf] Memoize `renderTypeStubs()`/`probeImportableModules()`** across nesting levels (A28).
6. **[Doc] `runOptions.inputs` vs top-level `options.inputs`** forwarding asymmetry (D52).
7. **[Hardening] Bound + signal-race the `onLLMQuery`/downgrade interpolations.**
8. **[Nit] `extractBestAnswer(...) ?? ""` dead fallback; property-test label.**
9. **Deferred (SPEC):** `RlmStep`/`RlmProgressEvent` trajectory (A24); question-as-input re-homing
   (#145); residual `repl`/`rlm` naming (N14/A29); stale mutation baseline (pre-0.0.21); coverage
   floors re-baselined upward (99.14 `rlm.ts` now tight against the one-line tolerance).

## Close-out actions

- Merge `issue/78-converge-runrlm` into `main` (closes #78, and with it Bucket 9).
- File the follow-ups above; update #78's body (stale size table, DoD item 5, Do items 6/9) per the
  issue-monitor final report.
