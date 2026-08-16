# Spec: Restore the unconditional `context` input — issue #72

> 9.2 — "The advertised configuration is a no-op"
> Parent: #70 (Bucket 9 — RLM: fix, then converge) · Labels: `bug`, `bucket-9`

## Objective

`runRlm` (`src/rlm.ts`) injects sandbox inputs **only when the caller passes `options.inputs`**.
The shipped preamble (`repl/repl_server.py`) references the bare name `context` in its helper
bodies, so the documented production configuration — `runRlm(question, { preamble })` with no
`inputs` — fails Monty's type check with a ~4 KB, 12-error `unresolved-reference` diagnostic on
**every** iteration. It is deterministic, so all ten iterations fail identically and the whole
blob is re-sent as feedback each time (compounding #74's message growth). The reference
implementation (`rlm_loop.ts`, `RLMLoop.run`) always injected `context: context ?? ""`; the
`runRlm` port lost that.

A second, related gap: a caller passing `inputs: { context, other_data }` gets an initial prompt
that never mentions `other_data` — the data is present in the sandbox and invisible in the
instructions, so the model cannot know it exists.

The fix: **always declare `context`** (defaulting to `""`), regardless of whether the caller
passes `inputs`, and **announce every input key** in the initial prompt. Scope: `src/rlm.ts` +
`test/rlm.test.ts` only.

**User:** any caller of the documented RLM configuration. **Success:** the advertised
configuration runs end to end; every input is declared and named for the model; a
caller-supplied `context` overrides the default. This must precede #78: `rlm_loop.ts` is the
only remaining working reference for the correct behaviour, and it is deleted there.

### Success criteria (the issue's five tests)

1. `runRlm` with the shipped `repl_server.py` preamble and **no** `inputs` succeeds — the exact
   advertised configuration. The headline test; fails today.
2. `context` is declared and readable in the sandbox when no `inputs` are passed (value `""`).
3. A caller-supplied `context` reaches the sandbox and overrides the default. Kills M4
   ("never forward `inputs` to sandbox", `docs/REVIEW.md:549`).
4. Every key in `inputs` is named in the initial prompt — asserted on prompt content, not on
   message count.
5. A non-`context` input is both declared (readable in the sandbox) and announced.

## Explicit decisions (recorded, not reflexive)

- **One merge site, `context` always last.** In `runRlm`, build
  `inputs = { ...runOptions.inputs, ...options.inputs }`, then set `inputs.context =
  inputs.context ?? ""`. `options.inputs` keeps today's precedence over `runOptions.inputs`;
  `context` defaults to `""` when absent from both. **Recorded deviation from the reference:**
  `RLMLoop.run` overrode `runOpts.inputs.context` with the `run(task, context)` argument
  (default `""`); the new code lets `runOptions.inputs.context` survive when `options.inputs`
  has no `context`. The superset is harmless and "context is just an input that defaults to
  `""`" is the simpler contract — `options.inputs` remains the canonical RLM-level source.
- **The default `context` is announced too.** The merged map always contains `context`, so the
  prompt always carries its header — the preamble ships `context_preview()`/`context_lines()`/
  `context_length()`/`context_summary()`, and the model should know the variable exists even
  when empty. Empty values render header-only (no empty code fence).
- **`context` keeps its legacy header**, `# Context (available as \`context\` variable)`, and
  the existing 5000-char head/tail preview. Other keys get
  `# Input (available as \`name\` variable)` with the same preview treatment. The preview
  policy itself is unchanged — message growth is #74's problem; this issue adds per-key
  *naming*, not content duplication.
- **Nothing else changes.** The declaration path already exists (`buildTypeCheckStubs` takes
  input names; `feedStart` takes `inputs`) — the defect is purely what `runRlm` passes.
  `sandbox.ts`, `rlm_loop.ts`, and `types.ts` stay untouched; `rlm_loop.ts` is #78's reference.
- **`REPL_SERVER` lands in `test/rlm.test.ts` and is used.** Loaded via `readFileSync` exactly
  as `test/repl_server.test.ts` does; tests 1–3 run it through real Monty workers, as the
  file's existing tests already do. Closes the #23 handover row.
- **M4 is killed by construction.** The new no-preamble tests read inputs in the sandbox, which
  is precisely the mutation site M4 cuts; the aggregate floor still gates at `npm run mutation`.

## Tech Stack

TypeScript (ESM, Node ≥ 22.19), `node:test` runner via `tsx`, Monty 0.0.21 sandbox, biome 2.5.8,
tsc strict (`noUnusedLocals`, `noUnusedParameters`).

## Commands

```
Test (full):      npm test
Test (focused):   npx tsx --test test/rlm.test.ts
Typecheck:        npm run check        # tsc --noEmit
Build:            npm run build        # tsc -p tsconfig.build.json
Lint:             npm run lint         # biome check --error-on-warnings
Coverage floors:  npm run coverage
Mutation floor:   npm run mutation     # stryker, contained in a memory-capped systemd scope
```

## Project Structure

```
src/rlm.ts          runRlm — input merge (context always declared) + buildInitialPrompt
                    (announces every input key)
test/rlm.test.ts    REPL_SERVER load (new, used) + the five regression tests + a
                    preview-truncation pin
src/types.ts        (unchanged — RlmOptions.inputs already exists)
src/sandbox.ts      (unchanged — already forwards runOpts.inputs to the type checker and feed)
```

## Code Style

Repo conventions: biome formatting, double quotes, strict types, JSDoc on exported API and on
non-obvious decisions, `// ── section ──` separators as in `src/rlm.ts`. The merge is four
lines, not an abstraction:

```ts
const inputs: Record<string, string> = {
  ...(sandboxRunOpts.inputs ?? {}),
  ...(options.inputs ?? {}),
};
sandboxRunOpts.inputs = { ...inputs, context: inputs.context ?? "" };
```

## Testing Strategy

`node:test` + `assert/strict`, same file and helpers (`mockLlmCodeGen`) as the existing RLM
tests. The five new tests are **medium** (real Monty workers, deterministic canned LLM):
sandbox-visible behaviour is asserted through run results, prompt behaviour through
`llm.calls()[0]` message content. RED first: each new test must fail against HEAD for the right
reason (typing error for 1/2/3/5, missing key for 4) before its fix lands. No new dependencies;
no mocking of `runInSandbox` — the whole point is that inputs survive into a real worker.

## Boundaries

- **Always:** repo commands (`npm test`, `check`, `lint`, `build`) before commits; one logical
  change per commit; spec updated when a recorded decision changes.
- **Never:** new dependencies; touching `rlm_loop.ts` (owned by #78) or `sandbox.ts` plumbing;
  README claims without tests (no README change is needed here).
- **Ask first:** none applicable — autonomous run; all assumptions recorded below.

## Success Criteria

- The five tests exist, each was red against HEAD for the documented reason, and all are green.
- M4 no longer survives (killed by the no-preamble input tests).
- `REPL_SERVER` in `test/rlm.test.ts` is loaded **and used**, closing the #23 handover row.
- The advertised configuration is demonstrated working end to end.
- Full gates green: `npm test`, `npm run check`, `npm run lint`, `npm run build`,
  `npm run coverage`, `npm run mutation`.

## Assumptions (recorded; no human asked)

1. Input precedence: `options.inputs` wins over `runOptions.inputs` (unchanged from today);
   `context` defaults to `""` only when absent from both.
2. The default `""` context is announced in the prompt (header-only) — intentional, per the
   preamble's `context_*` helpers.
3. Empty values of any input render header-only, never an empty code fence.
4. Merge to `main` is deferred: this session pushes branch `issue-72-context-input` and opens
   a PR; another session owns `main` for #57 and merging would collide with it.
5. `npm run mutation` is runnable here (it uses a systemd scope; if containment fails, plain
   `stryker run` is the fallback — recorded in the ship report either way).

## Open Questions

None. Scope boundaries with #74 (message growth) and #78 (convergence) recorded above.
