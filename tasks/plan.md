# Plan — issue #76: RLM answer provenance — salvage, synthesis, and the `(no answer)` magic string

Branch `issue/76-salvage-provenance` · Flight pattern: DEFINE (SPEC D41–D47, done) → BUILD (T1–T2,
RED-first) → VERIFY (test-engineer) → REVIEW (code-reviewer) → SHIP (security-auditor). Single writer,
one coder per task, one commit per task.

## Architecture decisions

- **D41** — `RlmResult` gains a required `answerSource: "submitted" | "salvaged" | "synthesised"`.
  Name fixed now so #78 consumes it verbatim (its Do item 6).
- **D42** — Remove the `"(no answer)"` magic string; `extractBestAnswer` returns `""` when nothing is
  salvageable. `answer` stays a required `string`.
- **D43** — Fix `extractBestAnswer`'s comment to match code (no error consultation added).
- **D44** — Guarded final synthesis pass at the `max_iterations` cap: one extra `llmClient.query`
  over the transcript; success → `"synthesised"`, throw/abort → fall back to salvage `"salvaged"`.
- **D45** — Synthesis is a single un-charged best-effort call (not charged to budget).
- **D46** — All four `runRlm` return sites set `answerSource` (submitted / salvaged ×3 / synthesised).
- **D47** — RED-first; `src/rlm.ts` coverage floor 97.69; bounded mutation sweep over changed sites.

## Task list

### Phase 1 — BUILD

- [ ] **T1 — Provenance field + magic string removal + salvage path**

  **Description:** Add the `answerSource` field to `RlmResult`, remove the `"(no answer)"` magic
  string, fix `extractBestAnswer`'s comment, and set `answerSource` on all four return sites (site 4
  starts as `"salvaged"` — synthesis arrives in T2).

  **Acceptance criteria:**
  - [ ] `RlmResult.answerSource` is declared (required, 3-value union) in `src/types.ts`.
  - [ ] No `"(no answer)"` literal remains in `src/`; `extractBestAnswer` returns `""` when nothing
        is salvageable.
  - [ ] `extractBestAnswer`'s comment matches its code (D43).
  - [ ] Return sites 1–4 all set `answerSource` (submitted / salvaged / salvaged / salvaged).
  - [ ] Issue tests 1 and 2 written RED first, then GREEN: cap-with-debug-print → `salvaged`;
        literal `"(no answer)"` submit distinguishable from a failed run.

  **Verification:**
  - [ ] `npx tsx --test test/rlm.test.ts` green (no synthesis tests yet — they land in T2).
  - [ ] `npm test` green; `npm run check` clean; `npm run build` clean; `npm run lint` clean.

  **Dependencies:** None (SPEC D41–D47 done).

  **Files:** `src/types.ts`, `src/rlm.ts`, `test/rlm.test.ts`.

  **Scope:** M (3 files).

- [ ] **T2 — Guarded final synthesis pass at the cap**

  **Description:** Add `FINAL_SYNTHESIS_PROMPT` and the guarded synthesis call at the
  `max_iterations` return site (D44): one `llmClient.query` over the transcript; success →
  `answerSource: "synthesised"`, failure/abort → fall back to `extractBestAnswer` with
  `answerSource: "salvaged"` (never throw).

  **Acceptance criteria:**
  - [ ] `FINAL_SYNTHESIS_PROMPT` constant exists in `src/rlm.ts`.
  - [ ] Site 4 attempts synthesis before salvaging; success marks `"synthesised"`, failure falls
        back to `"salvaged"` without throwing.
  - [ ] Issue tests 3, 4, 5 written RED first, then GREEN: synthesis marks `"synthesised"`; failing
        synthesis falls back; property test asserts a valid `answerSource` on every exit path.

  **Verification:**
  - [ ] `npx tsx --test test/rlm.test.ts` green (all five issue tests).
  - [ ] `npm test` green; `npm run check` clean; `npm run build` clean; `npm run lint` clean.

  **Dependencies:** T1.

  **Files:** `src/rlm.ts`, `test/rlm.test.ts`.

  **Scope:** M (2 files).

### Checkpoint: after T2

- [ ] All five issue tests pass; full suite green; check/build/lint clean.

### Phase 2 — VERIFY / REVIEW / SHIP

- **VERIFY** — test-engineer persona runs the full suite and analyzes `src/rlm.ts` coverage against
  the 97.69 floor; reports gaps. If gaps/failures, a fresh coder fixes, then re-verify.
- **REVIEW** — code-reviewer persona: five-axis review with file:line findings.
- **SHIP** — security-auditor persona merges the review + coverage reports into a go/no-go decision
  with a rollback plan.

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Synthesis reply uncapped / malformed | Med | Treat like any assistant reply; single bounded call (Assumption 6) |
| `answer: ""` changes consumer-visible output | Low | Property test pins it; flagged to issue-monitor for #78 + docs |
| Mockable throwing `LlmClient` | Med | Existing test mock extended; technique recorded if it cannot throw |
| Scope creep into #78 (RlmResult completion, `status:"error"`, M1) | Med | Explicit out-of-scope in SPEC; reviewer checks for it |
| Direct-answer path mislabelled | Low | D46: it stays `"submitted"` (flows through SUBMIT/ok) |

## Open questions

None requiring human input — all resolved as recorded assumptions (SPEC "Assumptions" 1–6).
