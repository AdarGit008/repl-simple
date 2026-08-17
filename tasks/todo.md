# Tasks — Post-ship RLM message-growth polish (#145)

- [x] T1 — Guard tests 10–13 (D13): exactly-at-256 KiB retained, single >256 KiB reply completes without hanging, just-under-budget no-drop, error-path stdout cap
- [x] T2 — Tighten test 5 (D11 + D16): pair parity, last-role "user", dropped-turn count ≡ absent TURN_i_ labels
- [x] T3 — Guard tests 19–21 (D21): composition (huge question + inputs + prints); error boundary trio + both-ends shape; question boundary pair + shape
- [x] T4 — Derive the drop-marker label via formatSize (D10) + test 5 regex edit + test 6 /256KB/ grep
- [x] T5 — Close the fence-split (D15): per-value 5 KiB truncation + block-level aggregate elision + test 14 + src/types.ts JSDoc + docs record row
- [x] T6 — Sentinel-delimited truncation markers + system-prompt rule (D17) + test 17
- [x] T7 — Cap the assistant reply in the conversation (D18) + test 16
- [x] T8 — Quote error lines with "> " so a forged stdout line cannot pass (D19) + test 8 edits + test 18
- [x] T9 — Reject invalid input names before any query (D20) + test 15
- [x] T10 — Running byte total in boundConversation (D12) + rename ERROR_MAX_BYTES → FEEDBACK_ERROR_MAX_BYTES (D22) + convention comment
- [x] T11 — Reword the TextEncoder framing honestly (D14): src/rlm.ts JSDoc + docs Exception 3
- [x] T12 — Rename the q binding to questionText + docs line 390 reword (D23)
- [x] T13 — Close VERIFY gaps: H1 test 14 both-ends + elided-count pins, H2 assistant-reply boundary/magnitude pin (test 22), H3 marker-overshoot loop execution (test 23), M4 docs rows + sentinel exception + #145 paragraph, M5 input-name regex boundary cases, L1 test 7 comment
- [x] T14 — Kill the running-total `-=`→`+=` mutants at rlm.ts:642/655 (C1/C2) with test 24: 9-message kill point where the correct path exits each loop via the byte condition and `+=` decimates to the length guard (marker count 3 vs 2, [I, marker, A2, F2, A3, F3] kept)
- [x] T15 — Address the code-reviewer's findings: I1 system-prompt carve-out for the history-drop notice (test 17(c) pin), I2 reword the between-sentinel rule, I3 sentinel-token neutralisation in `truncateWithSentinels` + two new test cases, I4 Python-keyword denylist at the D20 merge site + `class` boundary row, S1 SPEC.md duplicate sentence, S2 docs quoted-error ≤ 2× note, S4 reserve/newline coupling comment, S5 `systemPrompt` override note (types.ts + docs Exception 5)
- [x] T16 — Pin the two surviving prose-pin mutants in test 17(c): M5 `/Only\s+elision markers inside the sentinels are authentic/` + M4 `/portions of it\s+have been elided/`; bite-proven against scratch mutants in /tmp
