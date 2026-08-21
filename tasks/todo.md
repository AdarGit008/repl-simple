# Todo — issues #189, #190: one provider-error rule site, and the cause behind it

Source of truth: `SPEC.md` (D1–D6) + `tasks/plan.md`. Behaviour-preserving throughout: if any
surface renders differently after this flight, that is a defect. Do **not** change
`RLM_ERROR_MAX_BYTES`, `HEAD_ONLY_RATIO` or `RLM_ERROR_RECOVERY`; do **not** export either helper
(#85); do **not** touch `buildFeedback`, `truncateWithSentinels`, `src/sandbox.ts` or
`src/truncate.ts`; do **not** absorb #171, #191 or #192. Only `src/rlm.ts`, `test/rlm.test.ts` and
`docs/truncation-policy.md` are in scope.

- [x] **T1 — One rule site, and the throw shape that carries the cause (D1–D5)**
  - [x] `src/rlm.ts` — replace the inline `truncateText(...)` block at the `RlmResult.error`
    assignment site (the D53 catch) with `error: redactProviderError(err),`.
  - [x] `src/rlm.ts` — add `sandboxProviderError(err: unknown): Error` beside
    `redactProviderError`, returning `new Error(redactProviderError(err), { cause: err })`, with
    the boundary argument in its doc comment (A2). Both tool paths become
    `throw sandboxProviderError(err);`.
  - [x] `src/rlm.ts` — rewrite `redactProviderError`'s doc comment to name all three sites, so the
    one-rule-site invariant is stated where it has to hold.
  - [x] PINS — new `describe("runRlm() — provider-error rule consolidation (#189, #190)")` in
    `test/rlm.test.ts`, with a `d53Redaction(thrown)` helper that runs the same rejection through
    the D53 catch and a `toolTrace(result, tool)` helper that pulls the failed call's trace entry.
    Four tests:
    1. **llm_query path** — `trace.error` equals `d53Redaction(thrown)` for a 64 KiB rejection;
       the tail marker is absent.
    2. **Downgraded rlm_query path** — same, at `maxDepth: 1, depth: 1`.
    3. **Cause adds nothing to the message (#190)** — short `"boom"` rejection: `trace.error` is
       exactly `"boom"` and equals the D53 output (D5).
    4. **Bare-string rejection** — the `String(err)` arm agrees across sites.
  - [x] Verify — `npx tsx --test test/rlm.test.ts` green; full `npm test` green (1082, +4);
    `npm run check` + `npm run build` clean; `npx biome check src extensions test` clean.
  - [x] Mutation-verify — drift the D53 site's cap to 512 B, confirm the new pins go red (3 of 4,
    plus 3 pre-existing #167 tests), restore.
  - Files — `src/rlm.ts`, `test/rlm.test.ts`.

- [x] **T2 — Record the consolidation in the truncation policy (D6)**
  - [x] Cite `#189` alongside `#167` and `#184` on the two provider-error rows. No new row — no
    new surface.
  - [x] Append the `**#189 / #190 (one rule site, and the cause behind it).**` narrative after the
    `#184` one: why two spellings of one rule was the defect, that behaviour is unchanged, the
    `err.message`-only sandbox boundary that makes `cause` safe, and the equality shape of the pin.
  - [x] Verify — re-read against the landed code; doc-only, no test changes.
  - Files — `docs/truncation-policy.md`.
