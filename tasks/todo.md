# Tasks — Cap `result.error` and the `question` in the RLM feedback loop (#144)

- [ ] T1 — Cap `result.error` to 16 KiB via `truncateText` (D7) + test 8
- [ ] T2 — Cap the `question` to 64 KiB via `truncateText` (D8) + test 9
- [ ] T3 — Update `docs/truncation-policy.md` for the D7/D8 caps
