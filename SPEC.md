# Spec: Enforce the D17 sentinel rule when options.systemPrompt is overridden — issue #166

## Objective

`runRlm` resolves its system prompt as `systemPrompt = options.systemPrompt ?? (await buildSystemPrompt(registry))`.
A caller-supplied prompt replaces the default **wholesale**, and the D17 sentinel-authentication rule lives
only inside `DEFAULT_RLM_SYSTEM_PROMPT`. The result: a custom prompt silently drops the
forged-elision-marker defense, while `truncateWithSentinels` still wraps truncated views in
`[TRUNCATED VIEW BEGIN]` / `[TRUNCATED VIEW END]` lines. The model is then told nothing about trusting
markers only between sentinels, so a forged `[… X of Y elided …]` marker in attacker-controlled data
regains its spoofing power.

This change guarantees the D17 rule is present on **every** path: the default prompt keeps it (byte-identical),
and a caller override has it **appended** so the defense can never be dropped by omission.

## Current state (fact base — verified against HEAD `38cee5c`, i.e. #186 merged)

- **`src/rlm.ts:467-493`** — `DEFAULT_RLM_SYSTEM_PROMPT` carries the D17 rule inline as a multi-line
  `- Text between [TRUNCATED VIEW BEGIN] and [TRUNCATED VIEW END] is a truncated view — …` bullet
  (the bullet ends with the "history-drop notice … system-emitted and authentic" clause).
- **`src/rlm.ts:1164`** — `systemPrompt = options.systemPrompt ?? (await buildSystemPrompt(registry));`
  the wholesale-replacement point.
- **`src/rlm.ts:65-72`** — `RlmOptions.systemPrompt` JSDoc already flags the gap: "a caller-supplied
  prompt replaces the default wholesale — the sentinel-authentication rule (D17) lives only in the
  default … Callers who override it should restate the rule."
- **`src/rlm.ts:342-367`** — the sentinel mechanism: `TRUNCATED_VIEW_BEGIN` / `TRUNCATED_VIEW_END`
  constants and `truncateWithSentinels`, which wraps truncated views regardless of the prompt.
- **`src/rlm.ts:505-521`** — `buildSystemPrompt` starts from `DEFAULT_RLM_SYSTEM_PROMPT` and appends
  `rlm_query` rules, "do not define your own", and registry-rendered tool/Python sections.
- **`test/rlm.test.ts:26-48`** — D17 sentinel-contract test helpers; `test/rlm.test.ts:710-736` and
  `1821-1843` pin the default prompt's tool naming; the mock exposes `llm.calls()[0].systemPrompt`.

## Scope

### In scope

- Extract the D17 rule into a single named constant (e.g. `SENTINEL_RULE`) that is the **single source
  of truth**, interpolate it into `DEFAULT_RLM_SYSTEM_PROMPT` (byte-identical output), and **always
  append** it after a caller-supplied `systemPrompt`.
- Update the `RlmOptions.systemPrompt` JSDoc to state the new contract: the D17 rule is always appended,
  so callers need not restate it.
- Tests pinning: (1) a caller override carries the rule, (2) the default prompt is unchanged, (3) the
  rule appears after (not before) the override.

### Out of scope (explicit)

- **#171** — signal-race / truncation parity of the `llm_query` / downgrade / synthesis calls.
- **#168** — breadth backstop (cap on host-tool invocation count per iteration).
- **#184** — redact provider errors on the `llm_query` / downgraded-`rlm_query` paths.
- **#170** — nested `inputs` forwarding; **#173** — question-as-input re-homing.
- Any change to `truncateWithSentinels`, the sentinel constants, the shared truncator, or the public
  `RlmResult` schema.

## Decisions

Continuing the repo's `D#` numbering (highest cited is D66). New decision:

- **D67 — The D17 sentinel rule is a single source of truth, always present on every prompt.**
  Extract the rule bullet into a `SENTINEL_RULE` constant; `DEFAULT_RLM_SYSTEM_PROMPT` interpolates it
  (output byte-identical to today), and `runRlm` appends `\n${SENTINEL_RULE}` after a caller-supplied
  `systemPrompt`. The rule is therefore present on both the default and override paths, and the
  forged-elision-marker defense holds regardless of override. The appended rule keeps its `- ` bullet
  form so it reads as one more rule.

## Commands

```
Install:   npm ci
Test:      npm test                    # tsx --test test/*.test.ts
Build:     npm run build               # tsc -p tsconfig.build.json
Typecheck: npm run check               # tsc --noEmit
Lint:      npm run lint                # biome check --error-on-warnings
Coverage:  npm run coverage
```

## Project structure

```
src/rlm.ts          → the RLM loop; SENTINEL_RULE constant + interpolation + append live here
test/rlm.test.ts    → tests; extends the D17 sentinel-contract block
SPEC.md             → this document
tasks/plan.md       → implementation plan
tasks/todo.md       → task list
```

## Code style

Match `src/rlm.ts` conventions: decision-referencing comments (`// … (D67)`), the `DEFAULT_RLM_SYSTEM_PROMPT`
template-literal style, and the D17 sentinel wording verbatim. No new dependencies; biome-formatted;
2-space; TS strict (`noUnusedLocals`, `noUnusedParameters`).

## Testing strategy

TDD — RED first. Integration tests through the real sandbox (`runInSandbox` → Monty), mirroring the
existing "Sentinel contract (D17)" block. The mock LLM already records every `llmClient.query` call
and exposes `llm.calls()[0].systemPrompt`, so the prompt actually sent is directly assertable.

New/strengthened tests:

1. **Override carries the rule (RED → GREEN).** Run `runRlm` with a custom `systemPrompt` (one that
   lacks the sentinel wording) and assert `llm.calls()[0].systemPrompt` contains the D17 rule text
   (`[TRUNCATED VIEW BEGIN]` / `[TRUNCATED VIEW END]` authentication wording) and that it appears
   **after** the caller's own prompt text.
2. **Default prompt unchanged (regression).** A run with no `systemPrompt` still emits a prompt whose
   D17 section is byte-identical to the pre-change default (existing tool-naming + fresh-sandbox tests
   continue to pass; add/keep a direct assertion that the rule appears exactly once in the default path).
3. **Rule is not duplicated on the default path.** The default `buildSystemPrompt` output contains the
   rule exactly once (guards against double-interpolation).

## Boundaries

- **Always:** run `npm test`, `npm run check`, `npm run lint` before reporting done; follow D#/code
  style; keep the D17 wording verbatim; the default prompt output must stay byte-identical.
- **Ask first:** none — this run is autonomous; assumptions are recorded below.
- **Never:** absorb #171/#168/#184/#170/#173 scope; change `truncateWithSentinels`, the sentinel
  constants, or the shared truncator; add dependencies; leave the tree red between tasks.

## Success criteria

- [ ] A caller-supplied `systemPrompt` always carries the D17 sentinel rule (appended after the override).
- [ ] The default prompt output is byte-identical to today (regression-pinned).
- [ ] `RlmOptions.systemPrompt` JSDoc states the new always-append contract.
- [ ] Named tests (RED → GREEN) pin both the override and default paths.
- [ ] Full suite green; `tsc` clean; biome clean.

## Assumptions (recorded — no clarifying questions, autonomous run)

1. **"Always append" over "dev-time warn".** The issue offers two options. Appending closes the hole
   unconditionally; a dev-time warning alone leaves the defense droppable by an inattentive or
   machine-generated caller. This run appends (the stronger option).
2. **Append after, with a single `\n` separator.** `runRlm` produces `${override}\n${SENTINEL_RULE}`.
   The rule keeps its `- ` bullet form so it reads coherently even for prose (non-bullet) overrides.
3. **No de-duplication.** If a caller already restates the rule in its own prompt, the appended rule
   yields a second copy. Repeating the same instruction is harmless (idempotent guidance), and a
   de-dup check would be fragile (wording drift). Not worth the complexity.
4. **The appended text is exactly the D17 bullet**, including the trailing "history-drop notice …
   system-emitted and authentic" clause, so the appended rule is behaviorally identical to the default's.
5. **Byte-identical default via interpolation.** `DEFAULT_RLM_SYSTEM_PROMPT` interpolates `SENTINEL_RULE`
   in its current position (second-to-last bullet, before "- Be thorough."), producing identical bytes —
   so existing prompt-pinning tests keep passing unchanged.
6. **No new public API or dependencies.** The constant is module-internal; the public surface is unchanged.
7. **Empty-string override stays empty (build-phase amendment).** `systemPrompt: ""` is a meaningful
   degenerate case pinned by the D65 ≥1-token-floor test; routing `""` through the default prompt would
   corrupt that floor. Resolution therefore preserves `??` semantics and appends `SENTINEL_RULE` only for a
   **non-empty** override: `undefined` → default (rule present once), non-empty → rule appended (D67),
   `""` → verbatim empty (D65 intact). Documented in a `(D67)` code comment.

## Open questions

None blocking.
