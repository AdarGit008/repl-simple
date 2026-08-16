# Spec: Refuse preamble definitions that shadow a host-tool name — issue #54

> 6.2 — "Refuse preamble definitions that shadow a host-tool name"
> Parent: #52 (Bucket 6 — preamble supply chain) · Labels: `security`, `bucket-6`

## Objective

A preamble definition **silently replaces** a host tool: a file containing
`def read_file(path): return "SHADOWED"` replaces the jailed builtin for the whole session,
permanently and silently — host tools resolve only for names Python has not already bound
(`sandbox.ts:205-227`), and the preamble runs first. #53 stops an *untrusted* project's preamble
from running at all, but a **trusted** project can still shadow `read_file`, `bash` or `http_get`
by accident or by intent, and every bucket-4 security control is bypassed for that session.
Trust is not a licence to impersonate the host.

The fix: before injecting a preamble, scan it for definitions that bind a **registered host-tool
name**, and **refuse** — naming the offending file and symbol, so a developer who did it
accidentally can fix it in seconds.

**User:** a pi user who runs `repl` in a trusted project whose `.pi/code-tools` contains a
shadowing file. **Success:** no part of such a preamble is injected; the real host tool keeps
resolving; the model is told exactly which file and symbol to fix.

### Success criteria (the issue's five tests)

1. A preamble defining `read_file` is refused, and the refusal names the file and the symbol.
2. Each binding form is caught: `def`, plain assignment, `class`, `import as`, `from … import … as`.
3. A preamble defining a name that is **not** a host tool loads normally. A check that rejects
   legitimate tools would be turned off.
4. When a preamble is refused, **no part of it is injected** — asserted on the session's actual
   definitions, not merely on an error string.
5. The check runs against the **registered** tool names for that session, not a hardcoded list,
   so it cannot drift as the registry changes.

### Explicit decisions (recorded, not reflexive)

- **Refusal = withhold the whole preamble + a loud one-shot notice. Not a throw at session
  creation.** A throw would brick every `repl` call for the project — the exact "unrecoverable"
  failure mode #55 is filed for — and would leave no session to assert test 4 against. The
  withhold-plus-notice design matches the shipped #53 pattern (untrusted path), keeps `repl`
  usable, and satisfies "refuse the whole preamble rather than the offending file" with nothing
  injected. The notice names every offending file and its shadowed symbols, states that **no**
  saved tools were loaded, and says what must be fixed.
- **The scan lives in `loadSavedTools`** (toolstore.ts), which reads each file and can therefore
  attribute a shadow to its file. The detector is the existing `findShadowingBindings` (#56) —
  one detector, two gates (write-time #56, load-time #54). The reserved names arrive through the
  existing `ToolStoreOptions.hostToolNames` (#56 added it for the write gate; this issue widens
  its contract to both gates and updates its JSDoc).
- **Whole-preamble refusal.** If *any* file shadows, `preamble === ""`, `loaded === []`, limits
  are not evaluated, and `refused` names the offenders. Partial injection produces a session
  nobody can predict from the source; the issue forbids it.
- **All offenders are collected in one pass.** Reading stops for nothing: the notice lists every
  shadowing file at once, so the developer fixes once rather than rinse-and-repeat.
- **Refusal applies only where a preamble would be injected** — the trusted path. The untrusted
  path (#53) never loads anything, so there is nothing to scan.
- **The reserved list is the live registry.** `ReplRunner.createSession` passes
  `registry.list().map(t => t.name)` (bridge + builtins today; toolstore tools join it when #57
  registers them, and then shadow them too). No hardcoded list to drift (test 5).
- **The namespace question is recorded on #40.** The durable answer — registering host tools in a
  namespace Python cannot rebind — is sandbox-level and migration-dependent; per the issue, a
  comment is added to #40 so the question survives the migration spike.

## Tech Stack

TypeScript (ESM, Node ≥ 22.19), `node:test` runner via `tsx`, Monty 0.0.21 sandbox, biome 2.5.8,
tsc strict (`noUnusedLocals`, `noUnusedParameters`).

## Commands

```
Test (full):      npm test
Test (focused):   npx tsx --test test/toolstore.test.ts
                  npx tsx --test test/repl.test.ts
Typecheck:        npm run check        # tsc --noEmit
Build:            npm run build        # tsc -p tsconfig.build.json
Lint:             npm run lint         # biome check --error-on-warnings
```

## Project Structure

```
src/types.ts        (unchanged)
src/toolstore.ts    loadSavedTools — scan each file, RefusedTool, refused field, whole-refusal
src/repl.ts         createSession — pass registry.list() names; refusal notice
src/index.ts        export RefusedTool type
test/toolstore.test.ts  loader-level refusal tests (issue tests 1-3, 5 at loader level)
test/repl.test.ts       runner-level tests (issue tests 1, 4, 5 end to end)
```

## Code Style

Match existing conventions: JSDoc on every exported symbol, section-divider comment bars
(`// ── Name ───`), biome double quotes, 2-space indent, 100-col line width. `HostToolError` is
**not** used here — refusal is a withheld result, not a Python-facing failure. Notices follow the
existing `[preamble …]` family (`untrustedNotice`, `limitNotice`), one-shot through
`LiveSession.notice`. Example (existing):

```ts
function limitNotice(skipped: string[]): string {
  return (
    `[preamble truncated] ${skipped.length} saved tool(s) were not loaded because the ` +
    `preamble size limit was reached: ${skipped.join(", ")}. ` +
    `They are not defined in this session — calling one raises NameError. ` +
    `Delete tools you no longer need with delete_tool.`
  );
}
```

## Testing Strategy

`node:test` + `node:assert/strict`, TDD (RED → GREEN). Loader-level tests in
`test/toolstore.test.ts` drive `loadSavedTools` with real files in a temp dir (the
`writeSavedTool` helper). Runner-level tests in `test/repl.test.ts` use the `saveToolFile` helper
and a real `ReplRunner` with `isProjectTrusted: () => true`, asserting on **observable behavior**
— the real host tool still resolves — not merely on a message, mirroring the #53 hostile-preamble
pattern. Existing tests that `deepEqual` the full `SavedToolsPreamble` object are updated for the
new `refused` field (additive change).

## Boundaries

- **Always:** TDD (RED→GREEN), run `npm test` and `npm run check` after each increment, commit
  per increment, fail closed — a refusal must inject nothing.
- **Never (out of scope):** register the toolstore tools into `ReplRunner` (#57); fix unreadable
  entries in the load loop (#55); change the Monty sandbox or its namespace (#40); a hardcoded
  reserved-name list; a throw at session creation (see decisions); hard throw semantics anywhere
  in the load path.

## Success Criteria

All five issue tests pass end-to-end, plus: full suite green, `npm run check` clean,
`npm run lint` clean, namespace question recorded on #40, change committed.

## Assumptions (recorded; no human asked)

1. **Withhold + notice, not throw** — decided above under "Explicit decisions"; assumed to be the
   intended reading of "refuse" given test 4 asserts a *session* without the definitions.
2. **`hostToolNames` reuse.** One option, two gates. Callers who never set it get no load-time
   check either (same contract as #56's write gate); `ReplRunner` always sets it from the live
   registry, so the shipped path is always checked.
3. **Limits are not evaluated when the preamble is refused.** A refused preamble loads nothing,
   so `skipped` is `[]` alongside `refused`; the two fields never mix.
4. **The notice names offenders only.** The model can enumerate the directory with the bridged
   `ls`/`read`; the actionable content is the offending file + symbol.
5. **`read_file` is a registered builtin today** (bridge: `read, grep, find, ls, bash, edit,
   write`; builtins: `read_file, list_files, http_get`) — the reproduction in the issue body is
   therefore live against the current registry.
6. **Detector false negatives inherit from #56** (exec, setattr, walrus, bare `import`). This is
   accepted: the load-time scan is a UX/security guard, not a parser, and the namespace fix (#40)
   is the structural answer.

## Open Questions

None blocking. #55 (unreadable entries) and #57 (registration) remain open and out of scope here.

## Residual risks (recorded for the ship report)

- **The detector is best-effort.** The binding scan (#56) has false negatives; code that binds a
  host name through `exec`, `globals()`, `setattr`, walrus or a bare `import` slips past the
  write-time *and* load-time checks. The structural fix — a namespace Python cannot rebind — is
  recorded on #40 and remains the authoritative answer.
- **Recovery is host-side until #57.** The refusal notice tells the model what to fix, but
  `delete_tool` is not registered inside `repl` yet, so the offending file must be removed or
  rewritten from the host side. The notice is worded accordingly (no lie about `delete_tool`).
- **A refusal costs the innocent tools too.** Whole-preamble refusal means benign siblings of the
  offending file do not load either. That is the issue's explicit demand ("refuse the whole
  preamble"), and the notice says so.
