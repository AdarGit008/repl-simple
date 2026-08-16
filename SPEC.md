# Spec: Gate `save_tool` — issue #56

> 6.4 — "Gate save_tool: an ungated write primitive whose content auto-executes"
> Parent: #52 (Bucket 6 — preamble supply chain) · Labels: `blocker`, `security`, `bucket-6`

## Objective

`src/toolstore.ts` ships four tools (`save_tool`, `delete_tool`, `list_saved_tools`, `read_tool`)
and sets `requiresApproval` on **none** of them. `save_tool` writes
`<cwd>/.pi/code-tools/<name>.py`, whose content `loadSavedTools` later injects as a preamble
executed **before user code on every run, with full host-tool access**. Writing a file via
`write` is gated (`bridge.ts` `mutating: true`); writing a file that will *later execute as the
agent* is not.

The fix: gate `save_tool`, make the approval dialog name the automatic-execution consequence,
refuse at write time any tool whose code would shadow a host-tool name, and make an explicit,
recorded decision about `delete_tool`.

**User:** a pi user who runs `repl` in a project (the model may call `save_tool`). **Success:**
a `save_tool` call that would persist auto-executing code can no longer happen silently.

### Success criteria (testable)

1. `save_tool.requiresApproval === true`; `delete_tool` has the decision recorded below.
2. Denying `save_tool` (or running it with no `onApproval`) writes **no file** — asserted on the
   filesystem, not the returned message.
3. The approval dialog description for `save_tool` names the automatic-execution consequence
   ("runs automatically at the start of every future session").
4. A `save_tool` whose code binds a host-tool name is refused at write time (no file written).
5. No tool in `toolstore.ts` that writes or deletes is ungated, *except* `delete_tool` under the
   recorded decision (DoD permits this with a reason).

### Explicit decisions (recorded, not reflexive)

- **`delete_tool` stays ungated.** Reasoning: deletion is destructive but its blast radius is a
  single `.py` file under `.pi/code-tools`; it cannot execute code, write files, or reach the
  network. It is the primary recovery path for a bad tool (a shadowing or hostile tool must be
  removable with minimum friction). Gating it adds a dialog to exactly the action the user most
  needs to complete, for a bounded, low-stakes, re-save-able effect. `delete_tool` also validates
  its name (`validateToolName`) and deletes one named file — it cannot wipe arbitrary paths.
- **Shadowing check is write-time only here; load-time is #54.** This issue implements a shared
  detector and applies it in `save_tool`. #54 will reuse it for the load-time preamble check.
- **Reserved names are caller-supplied, not hardcoded.** `createToolStoreTools` gains an optional
  `hostToolNames` option; the caller (future #57 `ReplRunner`) passes the live registry's names.
  A hardcoded list would drift as the registry changes (#54 test 5).

## Tech Stack

TypeScript (ESM, Node ≥ 22.19), `node:test` runner via `tsx`, Monty 0.0.21 sandbox, biome 2.5.8,
tsc strict (`noUnusedLocals`, `noUnusedParameters`).

## Commands

```
Test (full):      npm test
Test (focused):   npx tsx --test test/toolstore.test.ts
Typecheck:        npm run check        # tsc --noEmit
Build:            npm run build        # tsc -p tsconfig.build.json
Lint:             npm run lint         # biome check --error-on-warnings
```

## Project Structure

```
src/types.ts        HostTool type — add approvalNote (and reuse requiresApproval)
src/toolstore.ts    createToolStoreTools — gate save_tool, shadowing detector, delete_tool note
src/sandbox.ts      buildApprovalRequest — append approvalNote to the dialog description
src/index.ts        export findShadowingBindings
test/toolstore.test.ts  new tests (5 required + detector units)
```

## Code Style

Match existing conventions: JSDoc on every exported symbol, section-divider comment bars
(`// ── Name ───`), `HostToolError("PythonType", msg)` for Python-facing failures, biome double
quotes, 2-space indent, 100-col line width. Example (existing):

```ts
function validateToolName(name: unknown): string {
  const s = requireString(name, "name");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    throw new HostToolError("ValueError", `invalid tool name '${s}': must be a valid Python identifier`);
  }
  return s;
}
```

## Testing Strategy

`node:test` + `node:assert/strict`, in `test/toolstore.test.ts`. TDD: write failing tests first.
Unit tests for the binding detector; integration tests through `runInSandbox` for the approval
gate (denial → no file on disk; no-callback → denied; description text; shadowing refusal).

## Boundaries

- **Always:** TDD (RED→GREEN), run `npm test` and `npm run check` after each increment, commit
  per increment, fail closed.
- **Never (out of scope):** register the toolstore tools into `ReplRunner` (#57); implement the
  load-time shadowing refusal (#54); change the grant model or approval-mode machinery.

## Success Criteria

As in "Success criteria" above — all five items, plus: full suite green, `npm run check` clean,
`npm run lint` clean, change committed.

## Assumptions (recorded; no human asked)

1. The issue body's "Blocked by #18 / Must land BEFORE #56" is garbled numbering; the intended
   ordering is: **gate (#56) before registering (#57)**. We gate here and do not register.
2. `delete_tool` is left ungated per the decision above (DoD explicitly permits this with a
   recorded reason).
3. Shadowing detection is regex-based and conservative (fail-closed): it may over-refuse on
   pathological inputs (a host-tool name defined inside a triple-quoted string) but must not miss
   a real binding. Limitations documented on the helper.
4. `approvalNote` is a static string on `HostTool` (the consequence is constant for `save_tool`);
   a dynamic form is deferred until a tool needs it (YAGNI).
5. The reserved-name list is supplied via `ToolStoreOptions.hostToolNames`; default empty means
   "no shadowing check" for standalone callers, which is safe because load-time (#54) is the
   backstop.

## Open Questions

None blocking. #54 (load-time refusal) and #57 (registration) remain open and out of scope here.
