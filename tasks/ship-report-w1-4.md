# Ship Report — W1-4 Preamble change detection after trust (#198, #52)

Branch: `chunk/w1-4-preamble-change-detection` · Base: `main` (`3770e46`) · Commits: `31a6aca`
(spec) · `962e8e1`, `cec2f9a` (RED) · `6fba133`, `09d289b` (GREEN) · `c545263` (report) · **fix
round 1:** `b40ebe4` (RED) · `05ae0c5` (GREEN) · docs commit (this file, the spec amendment,
`docs/project-trust.md`) · Decisions: decisions.md #5 variant (c), D89–D96 with round-1 amendments
to D89 / D91 / D93 / D94 (`tasks/spec-w1-4.md`) · Decision: **GO**

## What was built

A trusted project's saved tools are now checked, on **every** session build, against a sha256
manifest of the set the user's trust decision covered — kept **outside** the project — and anything
that differs is **withheld until accepted** (decisions.md #5, variant c; the brief's notice-only
variant was overridden by the maintainer).

1. **`src/toolstore.ts` — the hash and the partition.** `PreambleFileIdentity` gains a required
   `sha256`, computed over the raw buffer read through the existing `O_NOFOLLOW | O_NONBLOCK` fd.
   `loadSavedTools` takes `accepted?: ReadonlyMap<name, sha256>` and, when given one, reports files
   it does not cover in `unaccepted: { name, reason: "added" | "changed" }[]` **without concatenating
   them**. The partition runs after the shadow scan and both caps, and a withheld file keeps its
   place in the 32-file / 64 KiB budget, so accepting never changes which siblings fit (D90). A
   refused preamble (#54) reports `unaccepted: []` — nothing loads either way. **Round 1:** a tools
   directory that exists but cannot be listed (`EACCES`, `EIO`) comes back with `unlistable` set (the
   errno message) and every other field empty — "unknown", never "empty" (D91 amended);
   `savedToolNames` keeps its names-or-nothing contract for the untrusted path.
2. **`src/toolstore.ts` — the manifest store.** `resolvePreambleStoreDir` (option >
   `REPL_PREAMBLE_STORE_DIR` > `$XDG_STATE_HOME/repl-simple` > `~/.local/state/repl-simple`) and
   `createPreambleManifestStore(storeDir, cwd)` with `storeDir / manifestPath / read / write /
   update`. Manifest: `<store>/preambles/<sha256 of the project's canonical path>.json`, dir `0700`,
   file `0600`, temp-name + rename. Malformed (bad JSON, wrong `version`, non-hex hash, non-object)
   is `unavailable`, never overwritten by an update. A store inside the project — textually, through
   a symlink, or behind a dangling link that `mkdir -p` would follow — is refused before anything is
   created (D89). Symlinks are followed **only through the path jail** (`test/bridge.test.ts:323`
   pins that no other `src/` file may say `realpath`): the store finds its nearest existing ancestor
   with `stat`, canonicalises it through a jail rooted there, and appends the rest. **Round 1:**
   every path the store hands out is canonical and `storeDir()` exposes the canonical directory;
   resolution stays per operation, not memoised, so a store swapped for a symlink into the project
   between two sessions is still refused (D89 amended).
3. **`src/toolstore.ts` — the tools.** `save_tool` records the sha256 of the exact bytes it wrote and
   `delete_tool` drops the entry, only when a manifest exists **and only while `isTrusted()` says the
   project is trusted** (round 1, D93 amended: acceptance authority is the trust decision plus
   explicit accepts; an untrusted session's approval-gated write still happens but is not an accept,
   and the reply says "… once this project is trusted and its saved tools are accepted — a save made
   while untrusted is not an accept"). A failed update is appended to the reply. `list_saved_tools`
   renders `[not loaded: not accepted — added|changed since the saved tools were last accepted]`
   after the live-trust check; `read_tool` reads an unaccepted file with a `# NOTE` (trust is the
   read gate, acceptance the execution gate) and its "changed since loaded" note compares the hash
   it already has the bytes for (D95).
4. **`src/repl.ts` — the policy.** `ReplRunnerOptions.preambleStoreDir`; `loadVerifiedPreamble`
   does one load for the three manifest states — **absent** = first-ever load after trust, implicit
   accept, manifest written (empty set included; a failed write reloads with an empty accepted set,
   so everything is withheld — D91); **ok** = added/changed withheld with a one-shot
   `[preamble changed]` naming each as `added` or `changed`, removed names notice-only;
   **unavailable** = fail closed, `[preamble unverified]` naming what was withheld and where the store
   is configured (D92). **Round 1:** an unlistable directory short-circuits all three before any
   manifest write or reconciliation, with `[preamble unreadable] .pi/code-tools could not be listed
   (…)`. `ReplRunner.acceptPreamble()` → `accepted | untrusted | refused | store-unavailable |
   unreadable` (D94, amended with the fifth outcome: nothing accepted, manifest untouched); live
   sessions keep the preamble they were built with. An untrusted session never touches the store —
   not the build, not the tools, not `acceptPreamble` — and a test pins it.
5. **`docs/project-trust.md`** — section "When the files change after trust", the table rows
   (including the unlistable one), the embedder option and the canonical-path rule, the future
   `/repl-accept-preamble` command, and — round 1 — the untrusted-tools rule and two more bounds
   under "What this does not cover": a missing manifest is a first load (deleted manifest, or an
   upgrade over a project trusted before this build); a project that contains the default store
   (`cwd = $HOME`) has it refused and every saved tool withheld until `REPL_PREAMBLE_STORE_DIR` names
   a directory outside.

No new `src/` module (coverage-baseline.json untouched, W1-5's). No new dependency.

## Verification evidence (final, measured at the round-1 GREEN commit `05ae0c5`)

- **RED, wave 1** (`962e8e1` + `cec2f9a`, HEAD's tests against main's `src/`, the verifier's
  re-measurement): `test/toolstore.test.ts` 151 tests / 129 pass / **20 fail** / 2 todo;
  `test/repl.test.ts` 119 / 103 / **16 fail**. The 36 failures are 34 new tests plus 2 pre-existing
  loader tests whose `deepEqual` expectations gained `unaccepted: []`. One new test,
  "the live trust decision outranks the annotation", was green on main by construction (main already
  answers "project not trusted" and ignores the map) — round 1 strengthened it, see below.
- **RED, round 1** (`b40ebe4`, run against the branch's pre-fix `src/` at `c545263`):
  `test/repl.test.ts` 123 / 119 / **4 fail**; `test/toolstore.test.ts` 154 / 149 / **3 fail** / 2
  todo — the seven new tests, each for the defect it pins (table in `tasks/spec-w1-4.md`, "Fix
  round 1"). Every pre-existing test passed.
- **GREEN** (`05ae0c5`): single files — repl **123 / 123**; toolstore **154 / 152 / 0 fail / 2
  todo**; bridge 37 / 37 (the `realpath`-token pin). **Full suite** (`REQUIRE_BRIDGE_TOOLS=1 npm run
  test:contained`): **1170 tests, 1168 pass, 0 fail, 2 todo**, exit 0. `npm run check` clean;
  `npm run lint` clean (54 files).
- **Coverage** (`npm run coverage`): `src/repl.ts` **100.00** (floor 100.00); `src/toolstore.ts`
  **99.17** (floor 98.90); "All per-file floors met"; all files 98.59 (reported, not a gate).
- **CI**: the round-1 push is verified only when `gh pr checks 210 --watch` reports every leg —
  Linux and macOS, node 22 and 24, lint, coverage — SUCCESS (conventions.md "CI on all legs"); the
  PR body carries the final line.

### Round 1 — what the verifier found, and what happened to each

| Finding | Disposition | Evidence |
|---|---|---|
| macOS legs red: `/var` vs `/private/var` on two path comparisons | **Fixed.** The store already canonicalised (through the jail); the tests compared the raw spelling. Both now realpath both sides; `storeDir()` exposes the canonical dir; a Linux symlinked-store test reproduces the shape on every leg | `test/repl.test.ts:2466`, `:2880`; `test/toolstore.test.ts:2511`, `:2671` |
| P1: an untrusted session's `save_tool` updated the manifest (fail-open) | **Fixed.** Both tools update only while `isTrusted()`; the untrusted reply says the save is not an accept; docs claim "never touches the store" now true and pinned (no store write at all while untrusted, fresh store included) | `test/toolstore.test.ts:2832`; `test/repl.test.ts:2925` |
| P10: `acceptPreamble` over `.pi/code-tools` at mode 000 wrote an empty manifest | **Fixed.** Loader reports `unlistable`; `acceptPreamble` → `unreadable`, manifest byte-identical; a session build withholds with `[preamble unreadable] … could not be listed`, no "removed", no empty first manifest | `test/toolstore.test.ts:2422`; `test/repl.test.ts:2994`, `:3040` |
| "the live trust decision outranks the annotation" green on main | **Strengthened.** Flips trust mid-test and asserts the `not accepted — added` annotation and the `read_tool` NOTE, which main cannot produce; the comment names which half is the ordering guard | `test/toolstore.test.ts:3014` |
| Two first-ever-load windows and the `cwd = $HOME` consequence undocumented | **Documented** under "What this does not cover" | `docs/project-trust.md` |
| Ship report / PR body numbers drifted | **Re-measured**; this section and the PR body carry the final figures only | above |
| `test/extension.test.ts` writes manifests into the developer's default store | **Not this chunk's file** — see "Needed outside this chunk"; wave 2 (W2-1) must point those tests at a temp store dir | — |
| Stale in-session annotations after re-saving a withheld file (cosmetic) | Not changed this round; the `save_tool` reply is accurate and the next session loads it silently. Would need `preambleStatus.unaccepted` to be mutable or the tools to re-read the manifest; a candidate for the wave-2 command chunk | — |
| Escaping `.pi/code-tools` symlink reported as "no longer in .pi/code-tools" | Not changed this round; pre-existing loader semantic (containment refusal → empty load), nothing executes | — |

Nothing was refuted: every finding reproduced as described.

### Adversarial probes, how a reviewer reproduces each

| Probe | Test | What it asserts on |
|---|---|---|
| add `evil.py` after accept, new sessionId | `test/repl.test.ts:2379` | `pwned.txt` absent, no approval prompt, `[preamble changed] … evil (added)`, accepted tool still runs, notice one-shot |
| rewrite an accepted file | `:2416` | rewritten body never runs, `adder (changed)`, `NameError` |
| remove an accepted file | `:2438` | `[preamble changed] … no longer …`, nothing withheld, manifest entry kept |
| unchanged reload | `:2466` | silent; manifest under the store (realpath both sides) with a 64-hex hash; **nothing** created under cwd or `.pi/` |
| fresh `ReplRunner` over a previously accepted cwd (git-pull vector) | `:2498` | second runner, same store: withheld + notice, accepted tool loads |
| eviction / `repl_reset` / trust-flip rebuilds | `:2522` ff. | each rebuild withholds and notices; `[trust changed]` precedes `[preamble changed]` |
| same-size same-mtime rewrite | `:2594` ff. | `utimesSync` pins one mtime on both versions, asserts equal size and mtimeMs, still withheld |
| accepted entry becomes a symlink | `:2625` ff. | not executed, `[preamble unreadable]`, no double "removed", `acceptPreamble` accepts nothing |
| store unwritable (a file where the dir should be) | `:2661` ff. | `[preamble unverified]`, names the tool and `REPL_PREAMBLE_STORE_DIR`, no throw, cwd untouched |
| store inside cwd — option, env, symlink from outside | `:2681` ff. | unverified + "inside the project", withheld, `.pi/`, cwd and the symlink target all untouched |
| option > env | `:2724` ff. | manifest lands under the option dir, not the env dir; env used when no option |
| `save_tool` / `delete_tool` keep the manifest (trusted) | `:2751` ff. | next sessions silent; manifest keys follow the writes |
| tools annotate; `acceptPreamble`; live session unchanged | `:2786` ff. | list/read annotations, outcomes, a refused preamble over an existing manifest is refusal-only and leaves the manifest alone |
| **symlinked store dir** (macOS shape on Linux) | `:2880` | canonical `storeDir()` / manifest path, one manifest for both spellings, git-pull vector through the other spelling |
| **untrusted `save_tool` / `delete_tool`** | `:2925` | fresh store stays empty; existing manifest byte-identical; after trust: `planted (added)` withheld, `adder` reported removed, no side effect, no prompt |
| **`.pi/code-tools` mode 000** | `:2994`, `:3040` | `acceptPreamble` → `unreadable`, manifest byte-identical; session build `[preamble unreadable] … could not be listed`, nothing loads, no "removed"; readable again → silent (record survived); first-ever load writes no manifest |
| loader partition, caps, refused, **unlistable** | `test/toolstore.test.ts:2313–2484` | sha256 recorded; added/changed split; withheld counts toward both caps; `unlistable` with everything else empty, `savedToolNames` still `[]` |
| store: precedence, round trip (realpath both sides), malformed, inside/symlink/dangling, real-path key, **symlinked store**, no temp file, EACCES | `:2485` ff. | statuses, modes `0600`/`0700`, canonical paths, nothing created in the project |
| tools ↔ manifest (trusted, absent, unwritable, **untrusted**), hash note, unaccepted annotations, live trust outranks (**flip**) | `:2770` ff. | replies and annotations |

`test/repl.test.ts` runs against a temp `REPL_PREAMBLE_STORE_DIR` set at module load and restored in
a root-level `after` (D96). The `chmod 000` tests skip under root and on Windows.

## Residuals as todo tests

- `test/toolstore.test.ts` "concurrent updates do not lose each other's entries" — **concurrent
  `update()` calls lose an entry** (read-modify-write, no lock; each write is whole via rename, the
  later wins). Intended: O_EXCL lock file with a bounded wait, or compare-and-swap on `acceptedAt`.
  Fails safe: the loser is withheld on the next build.
- `test/toolstore.test.ts` "list_saved_tools sees a same-size, same-mtime rewrite" —
  **`list_saved_tools` misses a same-stat rewrite** (size + mtime detector, documented); `read_tool`
  hashes because it has the bytes. Intended: hash on list only for entries whose size + mtime match,
  bounded by the preamble byte cap.

Documented bounds, not tests (docs/project-trust.md "What this does not cover"): a removed file is
reported, not enforced; the unavailable-store window; a missing manifest is a first load; a project
that contains the store is refused with all its tools; the accept command is not in this wave.

## Needed outside this chunk (not touched — file ownership)

- **`test/extension.test.ts` — wave 2, W2-1 must do this.** Every trusted context it builds goes
  through the real extension and therefore writes an (empty) manifest to the developer's **default**
  store (`~/.local/state/repl-simple/preambles/`; the verifier measured 14 files over one
  `test:contained` plus one `coverage` run, all keyed to `/tmp/repl-ext-*` temp dirs). Harmless in
  CI (writable `$HOME`), clutter locally; an unwritable `$HOME` fails its "runs the same tools once
  the project is trusted" test closed. Fix is the same three lines `test/repl.test.ts:41–52` use:
  set `REPL_PREAMBLE_STORE_DIR` to a `mkdtempSync` dir at module load, restore the variable and
  remove the dir in a root-level `after`. Not done here: the file belongs to another chunk this wave.
- **`README.md:117–127`** (W2-1): after "revoking trust stops the code running rather than waiting
  for the next session." add: *"Once trusted, the set of saved tools is remembered — a sha256
  manifest under `$XDG_STATE_HOME/repl-simple` (or `REPL_PREAMBLE_STORE_DIR`), never inside the
  project — and a file added or rewritten afterwards is withheld with a `[preamble changed]` notice
  until the set is accepted again; the agent's own `save_tool` / `delete_tool` keep it current in a
  trusted project."*
- **`src/index.ts`** (W2): re-export `AcceptPreambleOutcome`, `PreambleManifestStore`,
  `PreambleManifestRead`, `UnacceptedReason`, `UnacceptedTool`, `createPreambleManifestStore`,
  `resolvePreambleStoreDir`, `PREAMBLE_STORE_DIR_VAR`. `ReplRunner.acceptPreamble` and
  `preambleStoreDir` are already reachable through the exported `ReplRunner`.
- **`extensions/repl-extension.ts`** (W2): `pi.registerCommand("repl-accept-preamble", …)` calling
  `runner.acceptPreamble()` and printing all five outcomes (`unreadable` included); then name the
  command in `changedNotice()` (`src/repl.ts`), which today points the model at `save_tool` re-save
  and the host API only. The same chunk is the natural home for refreshing `preambleStatus.unaccepted`
  after an in-session re-save (the cosmetic stale-annotation finding).

## Rollback plan

| Commit | Reverts |
|---|---|
| docs commit (round 1) | this report, the spec amendment, `docs/project-trust.md` round-1 wording |
| `05ae0c5` | round-1 fixes: `storeDir()`, trusted-only manifest updates, `unlistable` / `unreadable` (revert only together with `b40ebe4` or the suite goes red; note the two macOS test fixes live in `b40ebe4`) |
| `b40ebe4` | round-1 RED tests and the two realpath-both-sides assertion fixes |
| `c545263` | the wave-1 ship report |
| `09d289b` | jail-based canonicalisation (revert only together with `6fba133` — alone it re-breaks `test/bridge.test.ts`) |
| `6fba133` | the feature: loader hash/partition, manifest store, tool updates, runner policy, docs |
| `cec2f9a`, `962e8e1` | the RED tests (revert together with the GREEN commits or the suite goes red) |
| `31a6aca` | the spec |

Newest first returns to `3770e46`.

## Closing-comment drafts (for the orchestrator, after merge)

**#198** — Closed by variant (c) of the maintainer's decision. A trusted project's saved tools are
hashed (sha256 over the bytes read through the `O_NOFOLLOW` fd) into a per-project manifest kept
outside the repository (`resolvePreambleStoreDir`: option > `REPL_PREAMBLE_STORE_DIR` >
`$XDG_STATE_HOME/repl-simple` > `~/.local/state/repl-simple`; a store inside the project is refused).
Every session build compares: added or changed files are withheld — not concatenated, never
executed — and named in a one-shot `[preamble changed]` notice; removed files are notice-only; the
first load after trust is the implicit accept; `save_tool`/`delete_tool` keep the manifest current
in a trusted project (an untrusted session's writes are not accepts); `ReplRunner.acceptPreamble()`
re-accepts; an unavailable store fails closed; an unlistable tools directory records nothing.
Acceptance test from the issue: `test/repl.test.ts:2379` (seed, load, add `evil.py`, load again →
notice fires and the file is not run — asserted on the side-effect file). The git-pull vector
specifically: `:2498` (a fresh runner over a previously accepted cwd). Hash, not stat: `:2594`.
Untrusted writes: `:2925`. Docs: `docs/project-trust.md` "When the files change after trust".

**#52** — All five exit criteria hold with tests, and the residual that kept the epic open (#198) is
closed by this PR:
- fresh hostile clone does not execute without a trust decision — `test/repl.test.ts:1007`
  (`#53`), and now a *trusted* project's later-added file is withheld too — `:2379`, `:2498`;
- a preamble cannot silently replace a host tool — `test/repl.test.ts:723` (`#54`);
- an unreadable entry does not break the session and is recoverable — `:895` (`#55`), and an
  unlistable directory never rewrites the accepted set — `:2994`;
- what executes is inspectable and deletable — `:1232`, `:1350` (`#57`), and withheld files are
  annotated — `:2786`;
- no ungated tool writes code that later auto-executes — `:1389` (`#56`); the one gated writer's
  approval is the acceptance record in a trusted project only — `:2751`, `:2925`.

## Go / No-Go

**GO.** All four gates green locally at `05ae0c5` (check / lint / test:contained **1170-1168-0-2** /
coverage, floors met with `src/repl.ts` at 100.00 and `src/toolstore.ts` at 99.17). RED→GREEN in
separate commits for both waves: wave 1 — 34 new tests red on main (+2 extended expectations);
round 1 — 7 new tests red on the branch's pre-fix `src/`, 1 existing test strengthened to
discriminate against main. Two residuals recorded as todo tests. Four out-of-scope follow-ups named
above with exact locations, the `test/extension.test.ts` store hygiene flagged for W2-1; none blocks
the merge. CI on all legs is the last gate; the PR body carries its result.
