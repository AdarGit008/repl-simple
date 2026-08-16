# Spec: One unreadable entry must not break `repl` — issue #55

> 6.3 — "One unreadable entry breaks every repl call, unrecoverably"
> Parent: #52 (Bucket 6 — preamble supply chain) · Labels: `bug`, `bucket-6`

## Objective

`loadSavedTools` guards the directory **listing** but not the per-entry **reads**
(`src/toolstore.ts`, the loop's bare `readFile`). A **directory** named `dir.py` under
`.pi/code-tools` passes the `.py` name filter, throws `EISDIR` out of `loadSavedTools`, out of
`ReplRunner.createSession`, and out of **every** `repl` call — and `repl_reset` cannot fix it:
the throw happens during session creation, so the session is never created and never cached,
and the next call re-runs `createSession` and throws again. The tool is dead for that project
until a human deletes the file by hand, and nothing tells them (or the model) what happened.
A broken symlink, a FIFO, a permissions error, or a file deleted between `readdir` and
`readFile` does the same.

The fix: **one bad entry skips that entry, not the batch** — the session is created, the good
tools load, and the model is told exactly which file was not loaded, so the failure is loud,
specific, and recoverable without restarting Pi.

**User:** a pi user who runs `repl` in a trusted project whose `.pi/code-tools` contains an
unreadable or non-regular `.py` entry. **Success:** `repl` works; the other saved tools are
defined and callable; the model is told which file was not loaded and why it is not defined;
removing the bad entry makes the next **new** session load normally with no restart.

### Success criteria (the issue's six tests)

1. A directory named `dir.py` does not break `repl` — the call succeeds and the entry is skipped.
2. Other entries still load when one is bad. Skipping must not become "load nothing".
3. The skip is reported to the model.
4. Recovery works: remove the bad entry, and the next call loads normally with no restart.
5. A non-regular file — symlink to nowhere, FIFO — is skipped, not fatal.
6. The size and count caps are enforced, and the truncation is reported rather than silent.

### Explicit decisions (recorded, not reflexive)

- **Skip + report, never throw.** A bad entry produces an `unreadable` entry on the loader
  result and the load continues. Nothing in the load path throws on an entry that cannot be
  read — that is the whole bug. (The only remaining throws in `loadSavedTools` are programmer
  errors, and there are none: `savedToolNames` catches its own `readdir`.)
- **A new field, not a reuse of `skipped`.** `SavedToolsPreamble.unreadable: UnreadableTool[]`
  carries `{ file, reason }` per entry. `skipped` keeps its exact meaning — "the caps dropped
  it" — because the limit notice's wording ("preamble size limit was reached") would be a lie
  for a directory, and #57 will reuse both fields for read-side honesty. Additive, exactly as
  `refused` was in #54; the two existing full-object `deepEqual` assertions gain `unreadable: []`.
- **Only regular files load — decided by `lstat`, not by exception.** Anything whose `lstat`
  reports non-regular (directory, FIFO, socket, symlink — to nowhere **or** to anywhere) is
  skipped with reason `"not a regular file"`. A preamble is auto-executed code with full
  host-tool access, and a symlink inside `.pi/code-tools` can point **outside the project
  root**; following one would be an escape the path jail exists to prevent. Working symlinks
  do not load either — one rule, no special cases, and `save_tool` only ever writes regular
  files anyway. This is the "skip anything that is not a regular file" the issue demands,
  decided up front rather than discovered as `EISDIR`.
- **The read itself is wrapped.** `lstat` and `readFile` each get their own try/catch: a file
  deleted or swapped between `readdir` and `readFile` (TOCTOU), or unreadable by permission,
  becomes `{ file, reason: <error message> }`. The reason is kept on the struct for humans and
  tests; the model-facing notice names files only (same as #54 assumption 4).
- **Unreadable entries consume nothing and are never scanned.** They do not count against
  `maxFiles`, do not add bytes, and are never passed to `findShadowingBindings` — code that
  cannot load cannot shadow. Files **beyond** `maxFiles` are neither stat'd nor read (the #54
  invariant "no I/O beyond the caps" now covers `lstat` too) — they stay `skipped`.
- **Unreadable entries do not trigger whole-preamble refusal.** Only shadowing (#54) refuses
  everything. A directory named `dir.py` is not an attack, it is an accident; the benign
  siblings keep running. But when a refusal *does* happen, the refusal result still carries
  the `unreadable` entries discovered in the same pass — "nothing loaded" is the whole truth
  either way.
- **`savedToolNames` stays name-only.** Its contract is "names without reading" (#53); the
  stat filter lives in the loader. Cosmetic consequence: an untrusted project's withheld
  notice may list a non-regular name — the statement "it was not loaded" is true for it too.
- **The notice joins the `[preamble …]` family.** `[preamble unreadable]` — one-shot through
  `LiveSession.notice`, filenames control-character-escaped via the existing
  `escapeNoticeName` (#54), wording truthful for both reasons: the files were not read and are
  not defined, calling one raises `NameError`, fix or remove them under `.pi/code-tools`, then
  **start a new session** — the honest instruction, since a live session's preamble is fixed
  at creation (the #54 audit finding applies here too).
- **Recovery means the next new session.** Sessions are cached per `sessionId` by design, so
  "the next call loads normally" can only be true of a session that re-runs the loader — a new
  `sessionId`, or a trust-change rebuild. The test pins both directions: the session that
  skipped the entry keeps working with the tools it did load, and a fresh session after the
  fix loads cleanly with no notice.
- **`read_tool` / `list_saved_tools` honesty stays #57's job.** #55 makes the **loader**
  resilient; #57 remains the owner of reporting what actually executed to the model through
  the registered tools. Recorded so the scope boundary is explicit.

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
src/toolstore.ts    loadSavedTools — lstat gate, per-entry read guard, UnreadableTool,
                    unreadable field on SavedToolsPreamble
src/repl.ts         createSession — unreadableNotice wired alongside limitNotice/refusalNotice
src/index.ts        export UnreadableTool type
test/toolstore.test.ts  loader-level tests (issue tests 1, 2, 5, 6 at loader level; recovery)
test/repl.test.ts       runner-level tests (issue tests 1, 3, 4 end to end)
```

## Code Style

Match existing conventions: JSDoc on every exported symbol, section-divider comment bars
(`// ── Name ───`), biome double quotes, 2-space indent, 100-col line width. `HostToolError`
is **not** used here — a skipped entry is a withheld result, not a Python-facing failure.
Notices follow the existing `[preamble …]` family, one-shot through `LiveSession.notice`.
Example (existing):

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
`test/toolstore.test.ts` drive `loadSavedTools` with real files in a temp dir — real
directories, real `symlinkSync`, real `mkfifoSync`, real `chmodSync 0o000` — never mocks of
the filesystem. Runner-level tests in `test/repl.test.ts` use `saveToolFile` and a real
`ReplRunner` with `isProjectTrusted: () => true`, asserting on **observable behavior** —
`[result]\n2` still comes back and the good tool still resolves — not merely on a message.

Platform guards, following the existing repo pattern
(`test/extension-loader.test.ts` skips the symlink test on win32):
- `symlinkSync` tests skip on `win32` (symlinks need privileges there).
- `mkfifoSync` tests skip on `win32` (no FIFOs).
- The `chmod 0o000` read-failure test skips when `process.getuid?.() === 0` (root ignores
  permissions; CI and dev run unprivileged).
CI runs ubuntu + macOS (Node 22/24), where all three are live.

## Boundaries

- **Always:** TDD (RED→GREEN), run `npm test` and `npm run check` after each increment, commit
  per increment, fail closed — an unreadable entry must never abort a session.
- **Never (out of scope):** register the toolstore tools into `ReplRunner` (#57); refuse the
  whole preamble for an unreadable entry (only #54 shadowing refuses); follow a symlink; a
  throw at session creation for any entry the loader can name; read or stat files beyond
  `maxFiles`; change `savedToolNames`'s name-only contract; change the Monty sandbox (#40);
  a hardcoded list of "bad" filenames.

## Success Criteria

All six issue tests pass end-to-end, plus: full suite green, `npm run check` clean,
`npm run lint` clean, `npm run build` clean, every increment committed, tree clean.

## Assumptions (recorded; no human asked)

1. **"Skip and report" means a new `unreadable` field, not `skipped` reuse** — decided above;
   `skipped`'s limit-only meaning is asserted in existing tests and its notice wording.
2. **Symlinks never load, even working ones** — the lstat gate refuses the link itself. The
   issue names only "symlink to nowhere", but a working symlink in auto-executed position can
   point outside the project root; the one-rule version is both simpler and safer. If a
   legitimate workflow relies on symlinked tools, that is a future issue with a future test.
3. **The notice names files, not reasons** — the actionable content is which file to fix or
   remove; the reason stays on the result struct for humans and tests.
4. **Unreadable entries don't consume `maxFiles` slots** — a cap is about how much code runs,
   and skipped code doesn't run.
5. **The refusal result carries `unreadable` too** — discovered in the same pass, reported in
   the same result; the notices compose (refusal + unreadable) via the existing
   `notices.join("\n\n")`.
6. **Issue test 6 (caps + truncation reporting) is already satisfied** by the shipped #53
   limit work (`skipped` + `[preamble truncated]` + header line, all pinned by tests). This
   change keeps those tests green and adds the two cap-interaction pins (no stat beyond
   `maxFiles`; unreadable entries don't consume slots) so the new loop cannot regress them.
7. **Pre-existing limit-header interpolation of `skipped` names is untouched** — a control
   character in a capped file's name could break out of the preamble's `#` header comment
   (pre-dates this issue; the model-facing notice path is escaped). Recorded as a residual
   risk rather than silently widened; the unreadable names go through the **escaped** notice
   path only and are not interpolated into the preamble.

## Open Questions

None blocking. #57 (toolstore registration) and #40 (namespace) remain open and out of scope.

## Review remediation (post-build, reviewer-driven)

Five-axis review (correctness, readability, architecture, security, performance) of the
branch's four commits, plus an independent file-by-file pass. Findings:

- **No required or blocking findings.** The loader loop has no unguarded I/O left: `lstat`,
  the regular-file gate, and the read are each failure-contained, and the only other throw
  sources (`savedToolNames`'s `readdir`) were already guarded.
- **Verified:** the notice names are control-character-escaped (`escapeNoticeName`, reused
  from #54); the reason strings (raw errno messages) never reach the model-facing notice;
  the `trustChangedMessage` function is byte-identical to the pre-branch version (an edit
  mishap during Task 2 was repaired before commit, diff-verified); the FIFO test's
  `mkfifoSync` was replaced with `execFileSync("mkfifo", …)` because Node ships no `mkfifo`.
- **LOW (residual, accepted):** a TOCTOU swap between `lstat` and `readFile` — an attacker
  with **write access to a trusted project's `.pi/code-tools`** could swap a checked entry
  for a symlink (read follows it) or a FIFO (read blocks). That capability already implies
  the stronger primitive (write a hostile regular file, which the trust model explicitly
  allows), so it adds no marginal risk; recorded rather than engineered around.
- **Nit (recorded, unchanged):** `savedToolNames` is name-only, so a non-regular `.py`
  entry still appears in the untrusted path's withheld list. The claim ("not loaded") is
  true for it too; #57 may tighten this when it makes `list_saved_tools` honest.

## Residual risks (recorded for the ship report)

- **An unreadable entry is skipped forever, silently after the first call.** The notice is
  one-shot (the family pattern); a later call in the same session gets no reminder that
  `dir.py` is missing. That is the intended trade — a repeating banner trains the model to
  skip the line — and #57's read-side honesty is the durable answer.
- **`savedToolNames` still lists non-regular names.** The untrusted withheld notice and
  `trustChangeDiscards` count a `dir.py` as a tool name. Harmless (the claim "not loaded" is
  true), recorded above.
- **Limit-header interpolation of `skipped` names is unescaped** (pre-existing, assumption 7).
- **Recovery needs a new session** — by design (sessions cache their preamble); the notice
  says exactly that, pinned by a test.
