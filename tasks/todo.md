# Tasks — Post-ship RLM message-growth polish (#145)

- [x] T1 — Guard tests 10–13 (D13): exactly-at-256 KiB retained, single >256 KiB reply completes without hanging, just-under-budget no-drop, error-path stdout cap
- [x] T2 — Tighten test 5 (D11 + D16): pair parity, last-role "user", dropped-turn count ≡ absent TURN_i_ labels
- [ ] T3 — Guard tests 19–21 (D21): composition (huge question + inputs + prints); error boundary trio + both-ends shape; question boundary pair + shape
- [ ] T4 — Derive the drop-marker label via formatSize (D10) + test 5 regex edit + test 6 /256KB/ grep
- [ ] T5 — Close the fence-split (D15): per-value 5 KiB truncation + block-level aggregate elision + test 14 + src/types.ts JSDoc + docs record row
- [ ] T6 — Sentinel-delimited truncation markers + system-prompt rule (D17) + test 17
- [ ] T7 — Cap the assistant reply in the conversation (D18) + test 16
- [ ] T8 — Quote error lines with "> " so a forged stdout line cannot pass (D19) + test 8 edits + test 18
- [ ] T9 — Reject invalid input names before any query (D20) + test 15
- [ ] T10 — Running byte total in boundConversation (D12) + rename ERROR_MAX_BYTES → FEEDBACK_ERROR_MAX_BYTES (D22) + convention comment
- [ ] T11 — Reword the TextEncoder framing honestly (D14): src/rlm.ts JSDoc + docs Exception 3
- [ ] T12 — Rename the q binding to questionText + docs line 390 reword (D23)
