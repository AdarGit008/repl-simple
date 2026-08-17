# F-77 Task List

- [x] Task 1: `lineOffset` in `RunOptions` + syntax-error correction in `sandbox.ts`
  - Acceptance: `RunOptions.lineOffset?: number` exists (default absent); a syntax error in
    user code appended after an N-line prefix is reported at the user's line number (N subtracted);
    rendered diagnostic contains no excerpt lines from the prefix (lines ≤ offset stripped).
  - Verify: `npm test` (focused sandbox tests green, full suite green), `npm run check`
  - Files: `src/types.ts`, `src/sandbox.ts`, `test/sandbox.test.ts`

- [x] Task 2: Runtime-error correction via `traceback()` frames in `sandbox.ts`
  - Acceptance: runtime error frames have `lineOffset` subtracted from `line`/`endLine`; frames
    with `line <= lineOffset` (prefix frames) are dropped, `sourceLine` previews included; the
    fed-back diagnostic contains no preamble source; existing `Error: <type>: msg` heading shape
    preserved; message fallback when frames unavailable.
  - Verify: `npm test` (focused sandbox tests green, full suite green), `npm run check`
  - Files: `src/sandbox.ts`, `test/sandbox.test.ts`

- [x] Task 3: RLM passes `lineOffset` (actual preamble line count) — issue tests 1+2
  - Acceptance: `runInSandbox` call in `rlm.ts` passes `lineOffset` computed from the preamble
    string actually used (never hardcoded); syntax error on the model's line 1 is reported as
    line 1; fed-back diagnostic contains no known preamble token; #144's 16 KiB error cap still
    applies to corrected text.
  - Verify: `npm test` (focused rlm tests green, full suite green), `npm run check`
  - Files: `src/rlm.ts`, `test/rlm.test.ts`

- [x] Task 4: `Session.run` passes `lineOffset` (preamble + prior snippets) — issue test 3
  - Acceptance: under `Session`, a diagnostic on line K of the latest snippet is reported as
    line K (offset = preamble + stacked prior snippets); no earlier-snippet or preamble source in
    the fed-back diagnostic; REPL-path tests stay green.
  - Verify: `npm test` (focused session tests green, full suite green), `npm run check`
  - Files: `src/session.ts`, `test/session.test.ts`

- [x] Task 5: Rewrite RLM prompt + feedback wording to state the fresh-sandbox contract — issue test 4
  - Acceptance: the RLM system prompt (and any feedback wording) states that each iteration runs
    in a fresh sandbox with no state carried over; continuity-implying wording ("session",
    "ongoing", "persist") is gone from RLM-facing text; D3 section-header literals preserved and
    the coupled existing tests stay green; test asserts the prompt says so.
  - Verify: `npm test` (focused rlm tests green, full suite green), `npm run check`
  - Files: `src/rlm.ts`, `test/rlm.test.ts`
