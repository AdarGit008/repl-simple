# Spec — W1-4 Preamble change detection after trust (#198, #52)

Branch: `chunk/w1-4-preamble-change-detection` · Base: `main` (`3770e46`) · Decision range: D89–D96 ·
Maintainer decision applied: **decisions.md #5, variant (c) withhold-until-accepted** (overrides the
brief's recommended notice-only variant).

## Objective

A trusted project silently runs a `.pi/code-tools/*.py` that was **added or rewritten after** the
trust decision — the `git pull` vector (#198, residual R1 of #197). Close it without relaxing the
default-off gate and without per-session approval fatigue: persist, **outside the repository**, the
sha256 of every saved-tool file the user's trust decision covered, and on every trusted session
build withhold whatever differs until the current set is explicitly accepted.

## Current state, measured at `3770e46` (2026-09-08)

| What | Where | Finding |
|---|---|---|
| Per-file identity | `src/toolstore.ts:65-68` | `PreambleFileIdentity` is `size + mtimeMs`; no hash. |
| Identity recorded | `src/toolstore.ts:1103-1142` | Bytes are read through an `O_NOFOLLOW \| O_NONBLOCK` fd and fstat'd; `loadedIdentity.set(name, {size, mtimeMs})` at `:1142`. |
| Identity consumed | `src/toolstore.ts:631-654`, `:804-811` | Only `list_saved_tools` / `read_tool` in-session "changed since loaded" annotations. |
| Session build | `src/repl.ts:455-533` | `createSession(trusted)` loads the preamble with no memory of any earlier session or process. |
| New sessions minted | `src/repl.ts:411-422` (eviction), `:435-453` (trust flip), `:281-287` (`reset`) | Each is a fresh `loadSavedTools` — a changed file loads silently. |
| Runner lifetime | `extensions/repl-extension.ts:184-186` | One `ReplRunner` per process; an in-process baseline cannot see a change made between pi runs. |
| Notices | `src/repl.ts:461-463`, `:536-611` | `notices[]` joined at creation, delivered once by `withNotice` (`:632-637`). |
| Tests | `test/repl.test.ts:985-1070` | Assert on the side effect (`pwned.txt`), the pattern to mirror. |
| Store dirs | none | No user-state-dir convention in `src/`; `XDG_STATE_HOME` appears only in `src/bashenv.ts:81` (passthrough list). |
| `test/extension.test.ts:1275-1330` | not owned | Builds a trusted runner over a temp cwd with `hostile.py` through the real extension — will hit the **default** store. |

## Decisions

**D89 — Manifest location.** Precedence: `ReplRunnerOptions.preambleStoreDir` > `REPL_PREAMBLE_STORE_DIR`
> `$XDG_STATE_HOME/repl-simple` (absolute, non-empty) > `~/.local/state/repl-simple` — the same
"explicit option > env > default" rule as `maxSessions`. File: `<store>/preambles/<sha256(realpath(cwd))>.json`,
directory `0700`, file `0600`, written to a temp name and renamed. A store that is inside the project
— textually, or after `realpath` once it exists (a symlinked store dir) — is **unavailable**: a
manifest that travels with the clone is a manifest the attacker rewrites. Nothing under `cwd` is ever
created or read for this feature. An untrusted session never touches the store.

**D90 — Accepted set = sha256 of loaded bytes.** `PreambleFileIdentity` gains a required `sha256`,
computed over the raw buffer read through the existing `O_NOFOLLOW` fd (the fstat'd bytes, not the
path). `loadSavedTools` takes an optional `accepted: ReadonlyMap<name, sha256>`; when present, a file
that would load but whose hash is absent (`added`) or differs (`changed`) is reported in `unaccepted`
and **not concatenated**. The partition happens *after* the shadow scan and the size/file caps and the
withheld file still counts toward both caps, so accepting never changes which files fit. A refused
preamble (#54) skips the manifest entirely: nothing loads, nothing is accepted, nothing is written.

**D91 — First-ever load is an implicit accept, recorded immediately.** `read` → absent means the
trust dialog covered what is on disk now: load everything, then write the manifest — **including an
empty one**, so a project trusted before it had any saved tools still catches the first one that
appears. If the write fails the load is redone with an empty accepted set (everything withheld):
an acceptance that cannot be recorded would make every later load "first-ever", which is the
fail-open the decision rules out.

**D92 — Unavailable store fails closed.** Unreadable, malformed (wrong `version`, non-hex hash),
inside the project, or unwritable: everything that would have loaded is withheld and one
`[preamble unverified]` notice names the files and the reason. The notice is delivered only when
something was actually withheld — a project with nothing to load stays silent. Never a throw out of
session creation.

**D93 — Removed is notice-only; agent churn is silent.** Accepted names present in no loader bucket
(loaded, unaccepted, skipped, unreadable) are reported as removed in the `[preamble changed]` notice;
the manifest is not rewritten (the accept command reconciles it, and a file that reappears with its
accepted bytes loads without ceremony). `save_tool` records the sha256 of the bytes it wrote and
`delete_tool` drops the entry, both only when a manifest exists — so the agent's own writes never
withhold, and a manifest update failure is appended to the tool's reply, never thrown.

**D94 — `ReplRunner.acceptPreamble()`.** Outcomes: `untrusted` (files are never read — the trust
gate), `refused` (a shadowing preamble cannot be accepted), `store-unavailable` (reason), `accepted`
(names + manifest path). It re-hashes with the same loader and the same host-tool names a session
build uses. Live sessions keep the preamble they were built with — the same contract as `delete_tool`
— and the notice says to run `repl` with a new `sessionId`. The pi command that calls it is wave 2
(`/repl-accept-preamble`, named in `docs/project-trust.md`); in wave 1 the in-band path is
`save_tool`, whose approval dialog is the consent: re-saving a file records its hash.

**D95 — Tools annotate.** `PreambleStatus.unaccepted?: ReadonlyMap<name, "added" | "changed">`
(optional, like `identity`, for hand-built views). `list_saved_tools` renders
`[not loaded: not accepted — added|changed since the saved tools were last accepted]` after the
live-trust check (an inert untrust flip keeps a fully-withheld session, and the list must still say
"project not trusted"). `read_tool` **does** read an unaccepted file in a trusted project — trust is
the read gate, acceptance is the execution gate, and the model needs the code to review it — with a
`# NOTE` header. `read_tool`'s "changed since loaded" note now compares the sha256 it already has
the bytes for (exact); the list keeps size+mtime (cheap, documented as a detector).

**D96 — Test hygiene.** `test/repl.test.ts` sets `REPL_PREAMBLE_STORE_DIR` to a fresh temp dir at
module load and restores the variable and removes the dir in a root-level `after` (#178 discipline).
New helpers are reached through a namespace import so the file still *loads* against main's `src/`
and only the new tests fail. `test/extension.test.ts` is not owned this wave and will write one
manifest per run into the developer's default store (harmless; reported in the ship report for its
owner to add the same env line).

## Tests — RED → GREEN plan

RED commit: every test below fails against main's `src/`.

`test/repl.test.ts` — `describe("ReplRunner — a changed preamble is withheld until accepted (#198)")`
and siblings:
1. add `evil.py` after accept → new sessionId: not executed, `[preamble changed]` names `evil (added)`.
2. rewrite `adder.py` → new session: old definition not run, notice names `adder (changed)`.
3. remove an accepted file → notice names it as removed; nothing withheld.
4. unchanged reload → silent, and the manifest exists under the store, not under cwd.
5. eviction (`maxSessions: 1`), `reset`, trust-flip rebuild each surface the change.
6. a **fresh** `ReplRunner` over the same cwd and store withholds (the git-pull vector).
7. store unwritable (a file where the dir should be) → notice, no throw, everything withheld.
8. same-size same-mtime rewrite (`utimesSync`) → withheld.
9. accepted file swapped for a symlink → never executed; `acceptPreamble` does not accept it.
10. store dir inside cwd (option, env, symlink) → unavailable notice, nothing written in cwd.
11. `save_tool` / `delete_tool` keep the manifest current; the next session is silent.
12. `acceptPreamble()` four outcomes; `list_saved_tools` / `read_tool` annotate.
13. option beats env beats default (default resolved through `resolvePreambleStoreDir`).

`test/toolstore.test.ts`: `sha256` in `loadedIdentity`; `accepted` partition (added/changed/caps);
manifest store read/write/update/malformed/inside-cwd; `resolvePreambleStoreDir` precedence;
`save_tool`/`delete_tool` manifest updates and their failure notes; `read_tool` hash note.

## Boundaries

- Files touched: `src/repl.ts`, `src/toolstore.ts`, `test/repl.test.ts`, `test/toolstore.test.ts`,
  `docs/project-trust.md`, plus this spec and the ship report. No new `src/` module; no
  `coverage-baseline.json` change; `README.md` (W2-1) and `src/index.ts` re-exports are reported, not
  edited.
- Residuals become `todo` tests (decisions.md #9), never issues.

## Fix round 1 (2026-09-08, after the independent verification of `c545263`)

CI was red on both macOS legs and the verifier's probes P1 and P10 broke. Four decisions are
amended in place — no new D-ids, the range is D89–D96.

**D89 amended — canonical paths, on every operation.** The store already canonicalised through the
path jail; the two macOS failures were tests comparing the raw `/var/…` temp spelling against the
canonical `/private/var/…` path the store hands out. `PreambleManifestStore.storeDir()` now exposes
the canonical store directory — the one every manifest path is under — and both tests compare
`realpathSync` of both sides (conventions.md "CI on all legs"). Two things the round's instruction
("realpath at `ReplRunner` construction") could not be taken literally on: `test/bridge.test.ts:323`
pins that only `src/pathjail.ts` may say `realpath`, so canonicalisation stays behind the async jail
and cannot run in a synchronous constructor; and it is deliberately **not memoised** — a canonical
path cached at construction would let `mkdir -p` follow a store directory swapped for a symlink into
the project between two sessions of one process, which the per-operation walk refuses. Every
operation therefore resolves afresh; every path returned is canonical.

**D91 amended — an unlistable directory is not a first load.** `savedToolNames` swallowed every
`readdir` error as "no tools", so a `.pi/code-tools` at mode `000` made the loader return an empty
load: `acceptPreamble` wrote `{}` over the acceptance record and reported success; a first-ever
session build wrote an empty manifest; a later build called every accepted file removed. The loader
now reports a directory that exists but cannot be listed (`EACCES`, `EIO`) as
`SavedToolsPreamble.unlistable` (the errno message; every other field empty; `ENOENT` / `ENOTDIR`
stay "no tools"). `ReplRunner.loadVerifiedPreamble` short-circuits on it before any manifest write
or reconciliation with a `[preamble unreadable] .pi/code-tools could not be listed (…)` notice;
`savedToolNames` keeps its names-or-nothing contract for the untrusted path.

**D93 amended — agent churn is silent in a trusted project only.** `save_tool` and `delete_tool`
update the manifest only while `isTrusted()` says the project is trusted. Acceptance authority is
the trust decision plus explicit accepts; an untrusted session's approval-gated write still happens
but is not an accept, and the reply says so ("… once this project is trusted and its saved tools
are accepted — a save made while untrusted is not an accept"). With that, "an untrusted project
never touches the store at all" (docs) is true for the session build, both tools and
`acceptPreamble`, and a test pins it (no store write at all while untrusted, a fresh store included).

**D94 amended — a fifth outcome.** `AcceptPreambleOutcome` gains `{ status: "unreadable"; reason }`:
the directory could not be listed, nothing was accepted, the manifest is untouched.

**Docs.** Two first-ever-load windows and one UX consequence named under "What this does not
cover": a deleted manifest or an upgrade over a project trusted before this build is a first load
and accepts what is on disk then; a project that contains the default store (`cwd = $HOME`) has the
store refused and every saved tool withheld until `REPL_PREAMBLE_STORE_DIR` names a directory
outside.

**Tests — RED → GREEN, measured against the branch's pre-fix `src/` (`c545263`).** Seven new tests,
all red before the fix (repl 123 tests / 119 pass / **4 fail**; toolstore 154 / 149 / **3 fail** /
2 todo), all green after:

| Test | Where | Red because |
|---|---|---|
| a symlinked store dir is its target: canonical paths, one manifest | `test/toolstore.test.ts:2671` | `storeDir` is not a function |
| a directory it cannot list is unlistable — nothing loaded, nothing known | `:2422` | `unlistable` undefined |
| an untrusted session leaves the manifest alone — save_tool and delete_tool alike | `:2832` | manifest rewritten with `planted` |
| hands out canonical paths, and both spellings share the manifest | `test/repl.test.ts:2880` | `storeDir` is not a function |
| a tool saved while untrusted is withheld once the project is trusted | `:2925` | manifest rewritten; `planted` loaded silently after trust |
| acceptPreamble refuses, and a session build withholds with a notice, over EACCES | `:2994` | `accepted: []`, manifest overwritten with `{}` |
| a first-ever load over an unlistable directory records nothing | `:3040` | empty manifest written, no notice |

The `chmod 000` tests skip under root (`process.getuid?.() === 0`) and on Windows, mirroring
`test/toolstore.test.ts:2279`. The existing ordering guard "the live trust decision outranks the
annotation" (`test/toolstore.test.ts:3014`) was green on main by construction (main already answers
"project not trusted"); it now flips trust mid-test and asserts the `not accepted — added` annotation
and the `read_tool` NOTE, which main cannot produce — it discriminates, and the comment says which
half is the guard. Two existing tests changed assertion only (realpath both sides):
`test/repl.test.ts:2466` and `test/toolstore.test.ts:2511`.
