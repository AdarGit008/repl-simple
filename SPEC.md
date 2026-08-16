# Spec: Register the toolstore tools — issue #57

> 6.5 — "Register the toolstore tools so the model can inspect what runs"
> Parent: #52 (Bucket 6 — preamble supply chain) · Labels: `bug`, `bucket-6`

## Objective

The **read** side of the toolstore ships (`repl.ts` loads `.pi/code-tools/*.py` and executes it as a
preamble on every run) and the **write** side is withheld: `createToolStoreTools` is never
registered, so `read_tool`, `list_saved_tools`, `save_tool` and `delete_tool` are all `NameError`
inside `repl`. Code executes on the model's behalf before its own code on every call — and the model
cannot list it, read it, or delete it.

The fix: register the four toolstore tools in `ReplRunner.createSession`, and make
`list_saved_tools` / `read_tool` report **what is actually loaded in this session** — not merely what
is on disk — so the withheld case (#53), the refused case (#54) and the skipped/unreadable cases
(#55) are visible to the model that has to reason about them.

**User:** a pi user who runs `repl` in a project that has (or gains) saved tools. **Success:** a
misbehaving preamble can be discovered and removed entirely from inside `repl`, without editing
files by hand; and no tool claims a file is running when the session is not running it.

### Success criteria (testable)

1. `list_saved_tools`, `read_tool` and `delete_tool` all resolve and work inside `repl`
   (trusted project, tools on disk).
2. What `list_saved_tools` reports matches what **actually executed**: the withheld case (#53),
   the refused case (#54) and the skipped-entry case (#55) are all annotated, not silently listed
   as loaded.
3. `delete_tool` removes a tool, and it no longer executes in a **new** session (the current
   session keeps the copy it loaded, and is told so).
4. `save_tool` is gated inside `repl` — the #56 regression guard — and its write-time shadowing
   check now sees the **live registry's** names (the wiring #56's SPEC.md listed as its residual
   risk: the detector was inert in production until this issue passes `hostToolNames`).
5. The README's tool list matches the tools that actually resolve inside `repl`, and
   `docs/project-trust.md` no longer claims `save_tool` is ungated.

## Explicit decisions (recorded, not reflexive)

- **The tools are registered in every session, trusted or untrusted.** The issue says "alongside
  the bridge and builtin tools", which are unconditional. In an untrusted session the preamble is
  withheld as before, but `list_saved_tools()` now *works and says so*, `delete_tool()` works (it is
  the recovery path), and `read_tool()` **refuses** — an untrusted project's files are never even
  read (#53), and a registered `read_tool` that read them would silently repeal that.
- **`list_saved_tools` reports loaded state, not just disk state.** It lists the union of names on
  disk and names actually loaded, sorted, one per line. Loaded names are plain; every other name
  carries a `[not loaded: <reason>]` suffix. The reasons: `project not trusted`,
  `preamble limit reached`, `preamble refused — shadows a host tool`,
  `preamble refused — nothing loaded` (benign siblings when #54 refused the whole batch),
  `unreadable file`, and `saved after this session started`. A loaded tool whose file was deleted
  mid-session reads `[loaded in this session — file deleted; gone from new sessions]`.
- **`read_tool` annotates or refuses, never lies.** Withheld (untrusted) → `PermissionError`
  refusal, no read. Refused/skipped/unreadable → source is returned with a leading
  `# NOTE: not loaded in this session …` comment block. Loaded or plain → source as today.
  Missing → `FileNotFoundError` as today. **New:** `read_tool` `lstat`s first and refuses anything
  that is not a regular file — a FIFO named `x.py` would hang the tool call, and the loader (#55)
  already refuses non-regular files on the same grounds.
- **`save_tool` / `delete_tool` do not mutate the running session's preamble.** The preamble is
  baked into the session at creation. The messages say so: `save_tool` reports the tool "loads in
  new sessions", `delete_tool` reports the current session "keeps any copy it loaded". No mutable
  per-session bookkeeping in the tools — the honest message is cheaper and cannot drift.
- **`hostToolNames` for both gates = live registry names + `TOOLSTORE_TOOL_NAMES`.** The load-time
  check (#54) must refuse a preamble that binds `save_tool` itself before those tools are
  registered, and the write-time check (#56) must see the same list. `TOOLSTORE_TOOL_NAMES` is a
  new exported constant in `toolstore.ts`; a unit test pins it to the names
  `createToolStoreTools` actually returns, so the two cannot drift.
- **Standalone callers are unchanged.** `preambleStatus` on `ToolStoreOptions` is optional; without
  it, the four tools behave exactly as they do today (list = disk names, read = raw source,
  save/delete messages are the only change, and those were already asserted with `includes`).

## Tech Stack

TypeScript (ESM, Node ≥ 22.19), `node:test` runner via `tsx`, Monty 0.0.21 sandbox, biome 2.5.8,
tsc strict (`noUnusedLocals`, `noUnusedParameters`).

## Commands

```
Test (full):      npm test
Test (focused):   npx tsx --test test/toolstore.test.ts
Test (focused):   npx tsx --test test/repl.test.ts
Typecheck:        npm run check        # tsc --noEmit
Build:            npm run build        # tsc -p tsconfig.build.json
Lint:             npm run lint         # biome check --error-on-warnings
```

## Project Structure

```
src/toolstore.ts    createToolStoreTools — preambleStatus option, honest list/read, TOOLSTORE_TOOL_NAMES
src/repl.ts         ReplRunner.createSession — register the tools, wire hostToolNames, build status,
                    update the untrusted/refusal notices
src/index.ts        export TOOLSTORE_TOOL_NAMES, type PreambleStatus
test/toolstore.test.ts  unit tests: status-driven list/read behavior, non-regular-file refusal, name const
test/repl.test.ts   integration tests: tools resolve, list matches what executed, delete→new session,
                    save_tool gated with live shadowing check
README.md           toolstore section — the tools resolve now; list/read honesty
docs/project-trust.md  "What this does not cover" — both bullets are stale after this change
```

## Code Style

Match existing conventions: JSDoc on every exported symbol, section-divider comment bars
(`// ── Name ───`), `HostToolError("PythonType", msg)` for Python-facing failures, biome double
quotes, 2-space indent, 100-col line width. Status annotations are built as plain strings, never
thrown. Example (existing):

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

`node:test` + `node:assert/strict`. TDD: write failing tests first, per task.

- **Unit** (`test/toolstore.test.ts`): `preambleStatus`-driven `list_saved_tools` annotations (each
  category), `read_tool` refusal/notes, non-regular-file refusal, `TOOLSTORE_TOOL_NAMES` invariant.
  Existing tests must pass untouched — the status option is additive.
- **Integration** (`test/repl.test.ts`, through `ReplRunner` → real sandbox): all four tools
  resolve in a trusted session; `list_saved_tools()` output inside `repl` matches what executed
  for the withheld (#53), refused (#54) and unreadable (#55) cases; `delete_tool` end-to-end
  (list → read → delete → new session does not run it); `save_tool` suspended on deny with no file
  written, and refused at write time when the code shadows a **live** host tool.
- **Regression:** full suite `npm test`, `npm run check`, `npm run lint` after each task.

## Boundaries

- **Always:** TDD (RED→GREEN), run focused tests + `npm run check` per increment, commit per
  increment, full suite + lint before the final commit. Fail closed.
- **Ask first:** nothing in this issue requires it.
- **Never (out of scope):** register toolstore tools into the RLM loop; change the load/limits
  machinery in `loadSavedTools`; change the grant model or approval machinery; change the
  extension's tool declarations; remove or weaken the #53 "never even read" rule.

## Assumptions (recorded; no human asked)

1. The issue's test 2 names the withheld (#53) and skipped-entry (#55) cases; the refused case
   (#54) and the limits case get the same treatment since they are the same class of lie.
2. Annotation format is the `[not loaded: …]` suffix scheme above. A plain, unannotated line means
   "loaded". This keeps the common trusted-and-healthy case identical to today's output.
3. "Saved after this session started" is derived statically (on disk now, in no category at
   creation), not tracked mutably. A tool saved mid-session in an untrusted project shows
   `[not loaded: project not trusted]` via the `trusted` flag in `PreambleStatus`, not the
   fallback bucket.
4. `read_tool` refusal for untrusted projects uses `PermissionError` — it matches how the sandbox
   surfaces a denied gated call, and it is what Python raises for exactly this situation.
5. `PreambleStatus.refused` is a set of names; `read_tool`'s note does not repeat the shadowed
   symbols (the session-creation notice already names them; duplicating the list in the type
   would buy little).
6. `refused` all-or-nothing invariant (loader returns `loaded: []` whenever `refused` is non-empty)
   is relied on for the "nothing loaded" bucket; a unit test pins it.

## Open Questions

None blocking. #52 closes when this lands. The trace-visibility half (#46) and the RLM half stay
open and out of scope.

## Residual risks (recorded for the ship report)

- **`read_tool` becomes reachable code.** Before this change its FIFO-hang hazard was latent (the
  tool was a `NameError` inside `repl`). The `lstat` refusal closes the hang; the symlink refusal
  closes a path-jail bypass (a symlink whose target leaves the root would otherwise be readable
  through a tool nobody gated).
- **The current session's preamble is immutable.** `delete_tool` cannot stop a hostile preamble
  already executing in the live session; the honest message and "start a new session" guidance are
  the defence, and the session-cache semantics of #53 make new sessions cheap.

---

## Post-review fixes (Phase 5 findings — recorded, not reflexive)

Three independent reviewers (code-reviewer, security-auditor, test-engineer) converged on the
following; each is fixed in a follow-up increment with tests:

1. **Stale trust snapshot on inert trust flips (Critical).** `trustChangeDiscards` keeps the session
   when the flip changes nothing, but the tools' `preambleStatus.trusted` stayed frozen → fail-open
   reads in a now-untrusted project, fail-closed lies after untrust→trust. Fix: the tools consult a
   **live** trust callback (`ToolStoreOptions.isTrusted`), the snapshot stays load-status-only.
2. **Attacker-controlled filenames rendered unescaped** in list lines and the withheld/limit
   notices — a crafted name forges a "not loaded" annotation for a file that is running. Fix:
   `escapeNoticeName` moves to `toolstore.ts`, widens to C1/bidi, and applies to every disk-derived
   name; non-identifier names are rendered quoted so a name can never read as an annotation.
3. **`read_tool` TOCTOU**: lstat-then-readFile lets a swap to a FIFO (hang) or symlink (root escape)
   through. Fix: single fd-based open with `O_NOFOLLOW | O_NONBLOCK`, `fstat` on the fd, trust
   refusal **before** the open. The loader's read gets the same fd treatment.
4. **Content staleness**: a loaded file overwritten after session start was read/listed as if the
   new bytes were running. Fix: the loader records size+mtime per loaded file; `read_tool` and
   `list_saved_tools` annotate `file changed since; the session runs the earlier copy`.
5. **toolsDir symlink escape**: `.pi/code-tools` itself a symlink let the ungated `delete_tool`
   remove files outside the root. Fix: every tool call resolves the real tools dir and refuses
   when it escapes the real root (pathjail technique, toolstore wording).
6. **Shadowing detector blind spots** (walrus, `exec`/`eval`, `globals()`/`vars()`, `__dict__`,
   top-level `setattr`, `import *`) shared by both gates — the JSDoc's "load-time is the
   authoritative control" was wrong (same function). Fix: walrus targets recorded; top-level
   metaprogramming refuses **all** reserved names; consumer wording "defines" → "binds".
7. **Lint gate failure on the committed tree** (biome format) — fixed, and lint exit code is
   verified after every increment from now on.
8. **Notice wording**: "start a new session" was ambiguous (`repl_reset` does not reload). Now
   "run `repl` with a new `sessionId`"; save/delete messages say "sessions created after this one".

### Residual risks after the fixes (recorded for the ship report)

- **savedToolNames/loadSavedTools still follow a symlinked toolsDir.** The four *tools* now refuse
  an escaping directory; the loader and the name-listing path (pre-existing, and execution there is
  trusted-only) do not. A hostile repo can still have its names listed through a symlink in an
  untrusted session. Filed as a follow-up, out of #57's tool-registration scope.
- **The containment check and the operation behind it race** (check → swap dir → act). Same class
  as the fd-open race now closed for reads; a local attacker with write access to the project tree
  could exploit the window. Narrow, documented, not closed here.
- **`validateToolName` accepts Windows device names** (`con`, `nul`, …) — pre-existing, Nit-level.
- **Two commits share a message** (the tsc-fix and the test commit) — cosmetic, history kept.
- **Detector remains a scan, not a parser** — indented metaprogramming and `sys.modules[__name__]`
  aliases are documented false negatives; both gates share them.
