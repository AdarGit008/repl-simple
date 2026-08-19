# Todo — issue #76: RLM answer provenance

- [x] **T1 — Provenance field + magic string removal + salvage path** (add `answerSource` to
  `RlmResult`, remove `"(no answer)"`, fix comment, set source on all 4 return sites; tests 1–2)
- [x] **T2 — Guarded final synthesis pass at the cap** (add `FINAL_SYNTHESIS_PROMPT` + guarded
  `llmClient.query` at the `max_iterations` site; tests 3–5)

## Checkpoint (after T2)

- [ ] All five issue tests pass; full suite green; `check`/`build`/`lint` clean

## DoD (from #76)

- [ ] All five tests exist and pass
- [ ] No magic string remains
- [ ] Every answer carries provenance
- [ ] The comment at `:104` and the code agree
