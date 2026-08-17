# Review: Cap `result.error` and the `question` in the RLM feedback loop (#144)

**Verdict: approve.** No blockers or majors. The change matches SPEC decisions D7–D9,
reuses `truncateText` (single-truncator invariant held — test 6 untouched and passing), and the
verification matrix is green (950/950 ×2, tsc/lint/build clean, src/rlm.ts 97.40% vs 95.94% floor,
mutation 89.6% detected with no regression signal). All findings below are minor/nit and none must
block ship.

Scope reviewed: `src/rlm.ts`, `test/rlm.test.ts`, `docs/truncation-policy.md`
(diff `34da5c5..HEAD`, commits 01e5c6a → 527244e).

---

## Correctness

The implementation is correct against the spec. The error cap sits on the `status === "error"`
branch only (`src/rlm.ts:343-347`), so ok/suspended paths never pay it and `RunError.error` is a
required `string` (`src/types.ts:163-165`) — no undefined path introduced. The question cap wraps
the interpolation in `buildInitialPrompt` (`src/rlm.ts:300-304`), which is the sole producer of
`messages[0].content`, so the capped question lives in every query and `boundConversation`'s
never-drop-`messages[0]` guarantee now holds at bounded size (≤64 KiB question + ≤32 KiB input
preview + headers ≈ 97 KiB, far under 256 KiB). The error path's per-iteration bound is restored
(≤16 KiB error + ≤32 KiB stdout + advice ≪ 256 KiB). Both under-budget paths are true marker-free
no-ops — `truncateText` returns the buffer unchanged until it spills, so the normal error/question
render byte-identical to the pre-change shape.

- **minor — `test/rlm.test.ts:1095-1126, 1318-1351` — tests pin the ceiling, not the shape or the
  exact budget.** Both tests assert ≤ cap bytes + `/elided/` marker + recovery clause, which is the
  normative contract (truncate.ts invariant 1). But a stricter budget (e.g. 8 KiB for the error) or
  a head-only cut would still pass: the 50/50 head+tail shape and the 16/64 KiB magnitudes are not
  independently pinned. This matches the suite's existing style (tests 1–7 are ceiling-and-marker
  tests too) and the spec's own testing strategy, so it is a test-strength note, not a gap to close
  now.
- **minor — no boundary tests for either cap.** Exactly-at-budget (16 KiB error / 64 KiB question)
  and just-over-budget cases are unexercised; the spill threshold in `Truncator.push` is only hit
  by the 6×/2× oversize inputs. Same deferral as F-74's review made for the conversation bound.
- **nit — `test/rlm.test.ts:1128-1144` — the error no-op asserts the prefix `"Error: boom\n"` but
  not the full pre-change shape.** The `doesNotMatch(/elided/)` closes most of the gap; asserting
  the exact `"Error: boom\nstdout: "` string would make the byte-identical claim literal. Cosmetic.
- **nit — `test/rlm.test.ts:1338` — test 9's section end depends on the `\n\n# Context` header.**
  Deterministic today because `runRlm` always injects `context: ""` (`src/rlm.ts:569-570`), but the
  test would silently slice past the section if the header wording or the empty-input rendering
  changed. A length-based end (or asserting the section ends with the marker's tail) would be less
  brittle. Cosmetic.

## Readability

- **minor — `src/rlm.ts:28` — `ERROR_MAX_BYTES` breaks the `FEEDBACK_` prefix convention.**
  `FEEDBACK_STDOUT_MAX_BYTES`/`FEEDBACK_OUTPUT_MAX_BYTES` carry the prefix because the sandbox caps
  the same fields and the re-cap here must not be confused with them. `error` is feedback-only (the
  sandbox does not cap it), so the plain name is defensible — but `FEEDBACK_ERROR_MAX_BYTES` would
  keep the budget block self-describing. Naming only.
- **nit — `src/rlm.ts:300` — `const { text: q }` is a single-letter binding.** The suite's other
  destructures use full names (`stdout`, `error`, `output`, `inputSection`). The spec's own code
  sketch prescribed `q`, so this is faithful — but `question` reads better against the file's voice.
- **nit — `docs/truncation-policy.md:390` — "The four `#29`/`#34` rows…" now directly follows the
  two #144 rows.** The sentence is correctly scoped (it names the four original rows), but its
  adjacency to the new rows makes it read as if #74/#144 were excluded from invariant 4; the #74 and
  #144 narratives re-state single-implementation a few lines down, so nothing is actually wrong.
- **nit — `src/rlm.ts:349` — `let feedback` stays `let` on the error branch.** Pre-existing style
  (the reassignment predates this flight); a const with per-kind `+=` would remove the mutation, but
  that is cleanup, not a #144 finding.

## Architecture

No concerns. The change is exactly the #74 pattern repeated: budgets are module-private constants in
`src/rlm.ts` (`ERROR_MAX_BYTES` grouped with the feedback budgets, `QUESTION_MAX_BYTES` with the
initial-prompt cap), no new `RlmOptions`/`types.ts` surface, no `src/truncate.ts` edit, and both caps
route through the one imported `truncateText` (test 6's source ban on `Buffer`/`byteLength` in
`src/rlm.ts` holds — verified by grep). The single-truncator invariant (D9) is genuinely preserved,
not simulated.

## Security

No findings. Both capped strings are model-visible prompt content — the question is direct user
input and the error can embed sandbox-surfaced data — and `truncateText` limits size, not content:
under-budget text still reaches the model verbatim, so the prompt-injection surface is unchanged in
kind and only bounded in worst-case volume. That is the correct trade: the sandbox remains the
enforcement boundary (model code never escapes it), the recovery markers are fixed static strings
with no user interpolation, and no new parsing surface, dependency, secret, or log sink is
introduced.

## Performance

No findings. Each new cap is one `truncateText` call — a single `push` and one byte-count pass in
the under-budget case (the overwhelmingly common path), Buffer copies only on overflow, once per
run for the question and once per error iteration for the error. Negligible against an LLM round
trip. The pre-existing O(n²) `boundConversation` re-encode noted in F-74's review is untouched by
this change.

---

## Must change before ship

None.

## Can be deferred (recommended follow-ups, route to #145)

1. Add boundary tests for exactly-at- and just-over-budget on all five `truncateText` call sites in
   `src/rlm.ts` (error 16 KiB, question 64 KiB, stdout/output, input preview), pinning the
   spill threshold and the 50/50 head+tail shape directly.
2. Rename `ERROR_MAX_BYTES` → `FEEDBACK_ERROR_MAX_BYTES` (and revisit the `FEEDBACK_` prefix
   convention across the block) when the feedback section is next touched.
3. Address F-74's carried-over follow-ups: reword Exception 3's `TextEncoder` framing, tighten
   test 5's pair-parity assertion, track a running byte total in `boundConversation`, derive the
   marker's "256KB" label from the constant.
4. Doc polish: move or reword `docs/truncation-policy.md:390` so the single-implementation sentence
   covers the whole table rather than appearing to exclude the rows directly above it.

## Merge notes

`origin/main` advanced five commits during the flight; the overlap is editorial-only planning-doc
content (SPEC.md, tasks/plan.md, tasks/todo.md rewritten for #144 by this branch and independently
advanced upstream). No code conflict and no code divergence: the union of `src/rlm.ts`,
`test/rlm.test.ts`, and `docs/truncation-policy.md` in this branch is the spec-of-record
implementation. Merge with `-X ours` for the planning docs if the upstream rewrites collide, or
verify the upstream SPEC.md/plan.md do not carry stale #74-only assumptions before choosing either
side. Diff scope `34da5c5..HEAD` is exactly the six expected files.
