# Implementation Plan: Enforce the D17 sentinel rule when options.systemPrompt is overridden — issue #166

## Overview

One behavior change in the RLM system-prompt path. The D17 sentinel-authentication rule currently
lives only inside `DEFAULT_RLM_SYSTEM_PROMPT`, so a caller-supplied `systemPrompt` replaces it
wholesale and silently drops the forged-elision-marker defense while `truncateWithSentinels` still
wraps. Fix: make the rule a single source of truth (`SENTINEL_RULE`), interpolate it into the default
prompt byte-identically, and always append it after a caller override.

Source of truth: `SPEC.md` (D67) + issue #166.

## Architecture Decisions

- **Extract, don't duplicate.** A module-internal `SENTINEL_RULE` constant holds the D17 bullet
  verbatim (from the `- Text between [TRUNCATED VIEW BEGIN] …` line through the "history-drop notice …
  system-emitted and authentic" clause). `DEFAULT_RLM_SYSTEM_PROMPT` interpolates it in its current
  position (second-to-last bullet, before "- Be thorough.") so the emitted default is byte-identical
  to today — existing prompt-pinning tests keep passing.
- **Always append after a caller override.** `runRlm` resolves the prompt as
  `options.systemPrompt ? \`${options.systemPrompt}\n${SENTINEL_RULE}\` : (await buildSystemPrompt(registry))`.
  The rule keeps its `- ` bullet form, so it reads as one more rule regardless of whether the caller's
  prompt is a bullet list or prose. No de-duplication (harmless if a caller already restates it).
- **`buildSystemPrompt` is untouched** beyond the interpolation living in the default constant — the
  default path needs no extra append because the rule is already inside the default.

## Task List

### Phase 1: Core (D67 — single source of truth + always append)

- [ ] **Task 1** — Extract `SENTINEL_RULE`, interpolate into the default (byte-identical), append it to
      a caller override, update the JSDoc, and pin with RED → GREEN tests.

### Checkpoint: Complete
- [ ] All SPEC success criteria met (D67).
- [ ] `npm test`, `npm run check`, `npm run lint` all green.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Template-literal interpolation changes the default prompt's bytes (whitespace/newline drift). | High | Regression test asserts the default-path prompt's D17 section is byte-identical; run `npm test` and diff the emitted default against the pre-change literal. |
| Appended rule breaks prose (non-bullet) overrides' readability. | Low | Rule is self-contained and prefixed `- `; acceptable (SPEC Assumption 2). |
| Duplicate rule if a caller already restates it. | Low | Harmless idempotent guidance; no de-dup (SPEC Assumption 3). |

## Open Questions

None.
