# Tasks — Bound message growth in the RLM feedback loop (#74)

- [ ] T1 — Cap `buildFeedback` `stdout`/`output` via `truncateText` (D1) + tests 2, 3, 6 — pending
- [ ] T2 — Bound `messages` to 256 KiB, drop oldest whole turns, emit marker (D2–D3) + tests 1, 4, 5 — pending
- [ ] T3 — Cap the initial-prompt input section to 32 KiB (D6) + test 7 — pending
- [ ] T4 — Record feedback/conversation budgets + history-bounding strategy in `docs/truncation-policy.md` — pending
