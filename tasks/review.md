# Review: Bound message growth in the RLM feedback loop (#74)

**Verdict: approve.** No blockers or majors. The change matches SPEC decisions D1–D6,
reuses `truncateText` (no third implementation), and the full verification matrix is green.
All findings below are minor/nit and none must block ship.

Scope reviewed: `src/rlm.ts`, `test/rlm.test.ts`, `docs/truncation-policy.md`
(diff `origin/main...HEAD`, commits 904275f → bb03e5b).

---

## Correctness

The implementation is correct against the spec. The drop loop keeps `messages[0]`, drops the
oldest middle pairs via `splice(1, 2)`, strips and re-inserts a single cumulative marker, and
uses strict `>` so an exactly-at-budget conversation is retained (correct for a ceiling).

- **minor — `src/rlm.ts:313` — `result.error` is interpolated raw on the error path.**
  `Error: ${result.error}\nstdout: ${stdout}` leaves `error` uncapped. This is the documented
  non-goal (SPEC Assumption 7) and D2 is the backstop, but a single huge traceback can push the
  conversation over 256 KiB for the next query; it ages out one iteration later because the next
  bound can finally drop that pair. Documented residual, not a regression.
- **minor — `src/rlm.ts:442-447` — the marker itself can overshoot the budget.**
  When only one pair remains (`messages.length < 5`, so no further drop is possible) but
  `totalBytes() + contentBytes(marker) > MAX_CONVERSATION_BYTES`, the loop exits and still inserts
  the marker, so the "≤ 256 KiB" invariant is exceeded by the marker's own bytes. This is the
  Assumption 4 / docs Exception 4 edge; Exception 4 only names the over-budget LLM reply, not the
  marker, so the doc slightly understates it.
- **minor — `test/rlm.test.ts:1200-1207` — test 5's pair-atomicity check would not catch a
  trailing dangling assistant.** The role check walks `i = 2..n-1` expecting `assistant`/`user`
  alternation; a dangling assistant at the end still matches that expectation (an extra assistant
  at an even offset is indistinguishable from a complete pair). Asserting
  `(last.messages.length - 2) % 2 === 0` or `last.messages.at(-1).role === "user"` would close
  the gap. The current code cannot produce a dangling assistant, so this is a test-strength gap,
  not a product bug.
- **nit — `src/rlm.ts:418-423` — marker identification relies on "index 1 + user role".**
  Exactly one marker is stripped and re-inserted each call. If a second stray user message ever
  occupied index 1, `splice(1, 2)` would drop marker+assistant and leave a feedback dangling. The
  invariant holds today and is documented in the comment; identifying the marker by content or a
  dedicated shape would be more robust.
- **nit — `test/rlm.test.ts:1133-1149` — test 1 does not independently pin D2.** Four iterations of
  capped feedback ≈ 128 KiB, under the 256 KiB budget even with the conversation bound removed, so
  this test really validates D1's feedback caps (the historical 1.57 MB reproduction cannot recur).
  D2 itself is pinned by test 4. Acceptable, but worth knowing the test's leverage is D1.
- **nit — no test pins the exactly-at-boundary or single-oversized-message edges.** The strict `>`
  boundary and the "keep the over-budget reply transiently" path are implemented and documented
  (Assumption 4) but not exercised. Deferrable tests.

## Readability

- **minor — `src/rlm.ts:57-62` + `docs/truncation-policy.md:416-418` — the
  "no byte-level measurement" framing is misleading.** `TextEncoder.encode().length` *is* UTF-8
  byte measurement; it is byte-for-byte equivalent to `Buffer.byteLength` (verified, including lone
  surrogates). Docs Exception 3 is a rationalization for a spec deviation (D2 wrote
  `Buffer.byteLength`) driven by test 6's token grep. The count is correct; only the justification
  should be reworded so it doesn't imply `rlm.ts` owns no byte measurement.
- **nit — `src/rlm.ts:396` — `historyDropMarker` hardcodes "256KB".** If
  `MAX_CONVERSATION_BYTES` changes, the marker text and the test assertion
  (`/conversation bounded at 256KB/`) silently drift. Derive the label from the constant or from
  `formatSize`.

## Architecture

No concerns. The change is well-scoped: `truncateText` is genuinely reused (single import of the
same module `sandbox.ts` uses — no third truncation implementation), budgets are module constants
(no new public `RlmOptions` surface, `src/types.ts` untouched), and `boundConversation` is cohesive.
The `contentBytes` helper and module-level `TextEncoder` are appropriately shared.

- **nit — `test/rlm.test.ts:1116-1117` — test 6's "no hand-rolled truncation" check is
  token-based.** Grepping out `Buffer`/`byteLength` would be evaded by a hand-rolled truncator built
  on `TextEncoder` + manual slicing (exactly what the code had to do to pass the grep). The positive
  assertions — `rlm.ts` imports `truncateText` from `./truncate.js` and references it — are the real
  guarantee and are meaningful.

## Security

No findings. Markers interpolate only a numeric count into fixed-vocabulary text; no user content
flows into a marker or any new parsing surface. Truncated `stdout`/`output` are inputs already
model-visible, and truncation only reduces what reaches the model. No new dependencies, no secrets
in code/logs, no new injection surface.

## Performance

- **minor — `src/rlm.ts:426-444` — the drop loop is O(n²) in the worst case.**
  `totalBytes()` re-encodes every message (`contentBytes` → a fresh `Uint8Array` per message) on
  every `while` iteration, and each iteration drops one pair, so a single oversized message arriving
  after many tiny messages costs O(n²) encodes. For the default `maxIterations` this is negligible
  (n ≤ ~21), and even a pathological large-`maxIterations` case is sub-second, so it is not a
  blocker — but a running byte total (add on push, subtract the dropped pair's bytes) would remove
  the re-encode and the allocation churn. Determinism is unaffected (no timing/randomness in the
  bound loop).

---

## Must change before ship

None.

## Can be deferred (recommended follow-ups)

1. Reword `src/rlm.ts:57-62` and `docs/truncation-policy.md` Exception 3 so the
   `TextEncoder`/`Buffer.byteLength` deviation is stated honestly (it is still byte measurement,
   just a different symbol).
2. Tighten test 5 with an explicit even-parity / last-role assertion.
3. Track a running byte total in `boundConversation` instead of re-encoding per loop iteration.
4. Add boundary tests for exactly-at-256 KiB and a single over-budget message.
5. Derive the marker's "256KB" label from the constant.
