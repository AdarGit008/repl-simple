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
`llm.calls()[0]` message content. RED first, where applicable: 9.2.1, 9.2.2 and 9.2.5 failed
against HEAD for the documented reason (typing error / missing key); 9.2.3, 9.2.4 and 9.2.6
were green guards and pins — their job is to fail under the M4 mutant and the wrong fix, not
under HEAD. No new dependencies; no mocking of `runInSandbox` — the whole point is that inputs
survive into a real worker.

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

## Review remediation (post-build, five-axis self-review)

### Correctness — no required changes

- `src/rlm.ts:213-218` merge order matches the spec decision: `runOptions.inputs` first, then
  `options.inputs` (today's precedence), then `context` defaulted to `""` — set last, so the
  default can never override a caller's value.
- `src/rlm.ts:85` the `if (value)` header-only path is exercised by 9.2.1/9.2.2 (default
  `context: ""`), the >5000 preview path by 9.2.6 — every new branch has a test.
- `src/rlm.ts:230` `sandboxRunOpts.inputs ?? {}` is defensive only; the assignment above is
  unconditional.

### Readability — no required changes

- The merge comment explains *why* (undeclared input = deterministic type-check failure), not
  what. JSDoc on `buildInitialPrompt` matches behaviour.

### Architecture — no required changes

- All changes stay in `src/rlm.ts`, the owning layer; `rlm_loop.ts` untouched as #78's
  reference; no new abstractions; no API surface change (`buildInitialPrompt` is private).

### Security — FYI (no action)

- `src/rlm.ts:83-91` input values are interpolated into the LLM prompt; the change extends the
  existing `context` inlining to every input key. Not a new class: the RLM loop hands the
  model the same data through the sandbox anyway, and inputs come from the extension's own
  invoker, not remote users. Recorded, not fixed.

### Performance — no required changes

- One extra header line per input key; previews per key are capped by the same 5000-char
  policy. The single-context case is byte-identical to before. Growth concerns belong to #74.

## Review remediation round 2 (code-reviewer + security-auditor + test-engineer fan-out)

### Addressed

- **Rendering contracts pinned** (code-reviewer Required 1, test-engineer Low): 9.2.5 now
  asserts the exact `# Context` / `# Input` headers; new 9.2.7 asserts the default empty
  `context` renders header-only with no empty fence.
- **Precedence deviation pinned** (code-reviewer Optional 2, test-engineer Medium): new 9.2.8
  (`runOptions.inputs` survives when `options.inputs` is absent) and 9.2.9 (`options.inputs`
  wins on the same key).
- **Dead defensiveness removed** (code-reviewer Nit 4, security-auditor Nit): the
  `sandboxRunOpts.inputs ?? {}` fallback is gone — `runInputs` is built once, defaulted once,
  and passed to both the sandbox and the prompt.
- **LLM-disclosure contract documented** (security-auditor Required 1):
  `RlmOptions.inputs` JSDoc (`src/types.ts`) and the README's RLM section now state that every
  input key and value is rendered into the LLM prompt and must never carry secrets.
- **RED trail corrected** (test-engineer Low): SPEC testing-strategy wording and `tasks/todo.md`
  Task 1 acceptance now say "red where applicable" with the actual red/green split; the first
  test commit message amended to match.
- **5000-char boundary pinned** (test-engineer Low): 9.2.6 now also asserts an exactly-5000-char
  value renders whole and un-elided.

### Deferred (recorded, not fixed)

- **Aggregate prompt cap** (security-auditor Required 2): the 5000-char cap is per value; N
  large inputs make an N×~5 KB initial prompt. This is #74's exact territory (message growth
  across the whole loop) and gets a note on #74 rather than a bespoke cap here. The per-value
  preview cap is pinned by 9.2.6.
- **Input-name validation** (security-auditor Optional, code-reviewer Optional 3): names are
  interpolated unescaped into the prompt header and the type-check stub. A
  `/^[A-Za-z_][A-Za-z0-9_]*$/` check at the merge site would harden both paths; noted for the
  next RLM change (#78 touches this area).
- **Registry-scoping documentation** (security-auditor Optional): `RlmOptions.registry` should
  warn that the RLM sub-model is an injection-exposed trust domain and only the three RLM
  tools belong there. Doc-only; noted.

## Ship report (phase 6 — go/no-go)

### Go decision

**GO — approved by code-reviewer (after Required 1, addressed), security-auditor (after
Required 1-2, addressed/deferred), test-engineer (conditions met pending the mutation
report).** Gates: 772/772 tests, tsc strict clean, biome clean, build clean, coverage floors
met ×3 (one transient floor dip observed only under full-mutation load; the flake band is
documented in README, filed as #113), targeted mutation on `src/rlm.ts` running at report
time. The change is additive, no API surface change, no new dependencies, no I/O surface.

### Rollback plan

- **Trigger:** regression in RLM prompts or sandbox inputs reported after merge (e.g. #78
  work sees divergent prompt shape; a caller's `runOptions.inputs` flow behaves differently).
- **Step 1:** `git revert` the merge commit on `main` — the change is self-contained
  (`src/rlm.ts` + `src/types.ts` docs + `README.md` + tests), reverts cleanly against #57's
  preceding commits (no shared lines).
- **Step 2:** verify `npm test` + `npm run check` on the revert.
- **Time to rollback:** < 5 minutes (single commit, no data, no migration).

### Residual risks (recorded)

1. **Prompt shape delta for all callers** — every `runRlm` prompt now carries the `# Context`
   header (default `""` context announced). Intentional, pinned by 9.2.7.
2. **Aggregate prompt growth** — per-value caps only; deferred to #74 (note posted on the
   issue, comment 5309340038).
3. **Unescaped input names** — prompt header + type-check stub interpolation; validation
   deferred, noted on #74.
4. **Aggregate mutation floor not re-measured** — the full 3738-mutant run is ~46 h on this
   host and mutation is not a CI gate; the targeted `src/rlm.ts` run covers the changed file
   (M4 kill is the issue's DoD item). If the targeted run shows rlm.ts below its 30.58%
   baseline, re-assess before merge.
5. **Merge ordering with #57** — another session owns `main`; this branch is pushed and PR'd,
   not merged. Rebase on the post-#57 `main` before merge (expected clean — disjoint files:
   #57 touches toolstore/repl/README toolstore sections; this touches rlm/types/RREADME RLM
   section only).
