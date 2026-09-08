# Ship Report — W1-4 Preamble change detection after trust (#198, #52)

Branch: `chunk/w1-4-preamble-change-detection` · Base: `main` (`3770e46`) · Commits: `31a6aca`
(spec) · `962e8e1`, `cec2f9a` (RED) · `6fba133`, `09d289b` (GREEN) · Decisions: decisions.md #5
variant (c), D89–D96 (`tasks/spec-w1-4.md`) · Decision: **GO**

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
   refused preamble (#54) reports `unaccepted: []` — nothing loads either way.
2. **`src/toolstore.ts` — the manifest store.** `resolvePreambleStoreDir` (option >
   `REPL_PREAMBLE_STORE_DIR` > `$XDG_STATE_HOME/repl-simple` > `~/.local/state/repl-simple`) and
   `createPreambleManifestStore(storeDir, cwd)` with `manifestPath / read / write / update`.
   Manifest: `<store>/preambles/<sha256 of the project's canonical path>.json`, dir `0700`, file
   `0600`, temp-name + rename. Malformed (bad JSON, wrong `version`, non-hex hash, non-object) is
   `unavailable`, never overwritten by an update. A store inside the project — textually, through a
   symlink, or behind a dangling link that `mkdir -p` would follow — is refused before anything is
   created (D89). Symlinks are followed **only through the path jail** (`test/bridge.test.ts` pins
   that no other `src/` file may say `realpath`): the store finds its nearest existing ancestor with
   `stat`, canonicalises it through a jail rooted there, and appends the rest.
3. **`src/toolstore.ts` — the tools.** `save_tool` records the sha256 of the exact bytes it wrote and
   `delete_tool` drops the entry, only when a manifest exists; a failed update is appended to the
   reply (D93). `list_saved_tools` renders `[not loaded: not accepted — added|changed since the
   saved tools were last accepted]` after the live-trust check; `read_tool` reads an unaccepted file
   with a `# NOTE` (trust is the read gate, acceptance the execution gate) and its "changed since
   loaded" note now compares the hash it already has the bytes for (D95).
4. **`src/repl.ts` — the policy.** `ReplRunnerOptions.preambleStoreDir`; `loadVerifiedPreamble`
   handles the three manifest states — **absent** = first-ever load after trust, implicit accept,
   manifest written (empty set included; a failed write reloads with an empty accepted set, so
   everything is withheld — D91); **ok** = added/changed withheld with a one-shot
   `[preamble changed]` naming each as `added` or `changed`, removed names notice-only; **unavailable**
   = fail closed, `[preamble unverified]` naming what was withheld and where the store is configured
   (D92). `ReplRunner.acceptPreamble()` → `accepted | untrusted | refused | store-unavailable`
   (D94); live sessions keep the preamble they were built with. An untrusted session never touches
   the store.
5. **`docs/project-trust.md`** — new section "When the files change after trust", the table row,
   the embedder option, the future `/repl-accept-preamble` command, and five new bounds under "What
   this does not cover".

No new `src/` module (coverage-baseline.json untouched, W1-5's). No new dependency.

## Verification evidence

- **RED** (`962e8e1`, run against main's `src/`): `test/toolstore.test.ts` 150 tests / 129 pass /
  **19 fail** / 2 todo; `test/repl.test.ts` 119 tests / 103 pass / **16 fail**. Every pre-existing
  test passed; both files loaded (new helpers are reached through a namespace import, so a missing
  export is a per-test `TypeError`, not a link failure). `cec2f9a` adds two more cases that fail on
  main for the same reason (`acceptPreamble` / `createPreambleManifestStore` undefined).
- **GREEN** (`6fba133` + `09d289b`): single files — toolstore 151 / 149 pass / 0 fail / 2 todo;
  repl 119 / 119; bridge 37 / 37. **Full suite** (`npm run test:contained`): **1163 tests, 1161
  pass, 0 fail, 2 todo**. `npm run check` clean; `npm run lint` clean (54 files).
- **Coverage** (`npm run coverage`): `src/repl.ts` **100.00** (floor 100.00); `src/toolstore.ts`
  **99.13** (floor 98.90); all per-file floors met; global 98.62 (reported). From the two owned test
  files alone `src/repl.ts` is 926/926 and `src/toolstore.ts` 1594/1610 — the 16 uncovered lines all
  pre-date this chunk (`toolstore.ts:259, 593–594, 747–754, 1091, 1167, 1221–1223`).
- One full-suite failure was hit and fixed before push: `test/bridge.test.ts:323` "is one
  implementation, shared by both readers" (`src/toolstore.ts` said `realpath`). `09d289b` routes
  canonicalisation through the jail; every store case in `test/toolstore.test.ts` keeps its verdict.

### Adversarial probes, how a reviewer reproduces each

| Probe | Test | What it asserts on |
|---|---|---|
| add `evil.py` after accept, new sessionId | `test/repl.test.ts:2377` | `pwned.txt` absent, no approval prompt, `[preamble changed] … evil (added)`, accepted tool still runs, notice one-shot |
| rewrite an accepted file | `:2414` | rewritten body never runs, `adder (changed)`, `NameError` |
| remove an accepted file | `:2436` | `[preamble changed] … no longer …`, nothing withheld, manifest entry kept |
| unchanged reload | `:2464` | silent; manifest under the store with a 64-hex hash; **nothing** created under cwd or `.pi/` |
| fresh `ReplRunner` over a previously accepted cwd (git-pull vector) | `:2488` | second runner, same store: withheld + notice, accepted tool loads |
| eviction / `repl_reset` / trust-flip rebuilds | `:2513`, `:2535`, `:2556` | each rebuild withholds and notices; `[trust changed]` precedes `[preamble changed]` |
| same-size same-mtime rewrite | `:2584` | `utimesSync` pins one mtime on both versions, asserts equal size and mtimeMs, still withheld |
| accepted entry becomes a symlink | `:2615` | not executed, `[preamble unreadable]`, no double "removed", `acceptPreamble` accepts nothing |
| store unwritable (a file where the dir should be) | `:2651` | `[preamble unverified]`, names the tool and `REPL_PREAMBLE_STORE_DIR`, no throw, cwd untouched |
| store inside cwd — option, env, symlink from outside | `:2671` | unverified + "inside the project", withheld, `.pi/`, cwd and the symlink target all untouched |
| option > env | `:2714` | manifest lands under the option dir, not the env dir; env used when no option |
| `save_tool` / `delete_tool` keep the manifest | `:2741` | next sessions silent; manifest keys follow the writes |
| tools annotate; `acceptPreamble`; live session unchanged | `:2776`, `:2825` | list/read annotations, four outcomes, a refused preamble over an existing manifest is refusal-only and leaves the manifest alone |
| loader partition, caps, refused | `test/toolstore.test.ts:2313–2443` | sha256 recorded; added/changed split; withheld counts toward both caps |
| store: precedence, round trip, malformed, inside/symlink/dangling, real-path key, no temp file, EACCES | `:2450`, `:2471`, `:2516`, `:2554`, `:2603`, `:2629`, `:2914` | statuses, modes `0600`/`0700`, nothing created in the project |
| tools ↔ manifest, hash note, unaccepted annotations, live trust outranks | `:2697`, `:2728`, `:2754`, `:2785`, `:2854`, `:2891` | replies and annotations |

`test/repl.test.ts` runs against a temp `REPL_PREAMBLE_STORE_DIR` set at module load and restored in
a root-level `after` (D96).

## Residuals as todo tests

- `test/toolstore.test.ts:2658` — **concurrent `update()` calls lose an entry** (read-modify-write,
  no lock; each write is whole via rename, the later wins). Intended: O_EXCL lock file with a bounded
  wait, or compare-and-swap on `acceptedAt`. Fails safe: the loser is withheld on the next build.
- `test/toolstore.test.ts:2820` — **`list_saved_tools` misses a same-stat rewrite** (size + mtime
  detector, documented); `read_tool` hashes because it has the bytes. Intended: hash on list only for
  entries whose size + mtime match, bounded by the preamble byte cap.

Documented bounds, not tests (docs/project-trust.md "What this does not cover"): a removed file is
reported, not enforced; the unavailable-store window (a project trusted *while* the store is down has
no manifest, so the first load after recovery accepts what is there then); the accept command is not
in this wave.

## Needed outside this chunk (not touched — file ownership)

- **`README.md:117–127`** (W2-1): after "revoking trust stops the code running rather than waiting
  for the next session." add: *"Once trusted, the set of saved tools is remembered — a sha256
  manifest under `$XDG_STATE_HOME/repl-simple` (or `REPL_PREAMBLE_STORE_DIR`), never inside the
  project — and a file added or rewritten afterwards is withheld with a `[preamble changed]` notice
  until the set is accepted again; the agent's own `save_tool` / `delete_tool` keep it current."*
- **`test/extension.test.ts`** (W1-3's file this wave): every trusted context it builds goes through
  the real extension and therefore writes an (empty) manifest to the developer's **default** store —
  measured: 21 files of ~116 bytes per full-suite run under `~/.local/state/repl-simple/preambles/`,
  all keyed to `/tmp/repl-ext-*` temp dirs. Harmless in CI (writable `$HOME`), clutter locally; an
  unwritable `$HOME` would fail its "runs the same tools once the project is trusted" test closed.
  Fix is the same three lines `test/repl.test.ts:34–44` use (`REPL_PREAMBLE_STORE_DIR` to a temp dir,
  restored in `after`). I removed the 21 stale manifests my three suite runs left on this host.
- **`src/index.ts`** (W2): re-export `AcceptPreambleOutcome`, `PreambleManifestStore`,
  `PreambleManifestRead`, `UnacceptedReason`, `UnacceptedTool`, `createPreambleManifestStore`,
  `resolvePreambleStoreDir`, `PREAMBLE_STORE_DIR_VAR`. `ReplRunner.acceptPreamble` and
  `preambleStoreDir` are already reachable through the exported `ReplRunner`.
- **`extensions/repl-extension.ts`** (W2): `pi.registerCommand("repl-accept-preamble", …)` calling
  `runner.acceptPreamble()` and printing the outcome; then name the command in `changedNotice()`
  (`src/repl.ts`), which today points the model at `save_tool` re-save and the host API only.

## Rollback plan

| Commit | Reverts |
|---|---|
| `09d289b` | jail-based canonicalisation (revert only together with `6fba133` — alone it re-breaks `test/bridge.test.ts`) |
| `6fba133` | the feature: loader hash/partition, manifest store, tool updates, runner policy, docs |
| `cec2f9a`, `962e8e1` | the RED tests (revert together with the GREEN commits or the suite goes red) |
| `31a6aca` | the spec |

`git revert 09d289b 6fba133 cec2f9a 962e8e1 31a6aca` (newest first) returns to `3770e46`.

## Closing-comment drafts (for the orchestrator, after merge)

**#198** — Closed by variant (c) of the maintainer's decision. A trusted project's saved tools are
hashed (sha256 over the bytes read through the `O_NOFOLLOW` fd) into a per-project manifest kept
outside the repository (`resolvePreambleStoreDir`: option > `REPL_PREAMBLE_STORE_DIR` >
`$XDG_STATE_HOME/repl-simple` > `~/.local/state/repl-simple`; a store inside the project is refused).
Every session build compares: added or changed files are withheld — not concatenated, never
executed — and named in a one-shot `[preamble changed]` notice; removed files are notice-only; the
first load after trust is the implicit accept; `save_tool`/`delete_tool` keep the manifest current;
`ReplRunner.acceptPreamble()` re-accepts; an unavailable store fails closed. Acceptance test from the
issue: `test/repl.test.ts:2377` (seed, load, add `evil.py`, load again → notice fires and the file is
not run — asserted on the side-effect file). The git-pull vector specifically: `:2488` (a fresh
runner over a previously accepted cwd). Hash, not stat: `:2584`. Docs: `docs/project-trust.md`
"When the files change after trust".

**#52** — All five exit criteria hold with tests, and the residual that kept the epic open (#198) is
closed by this PR:
- fresh hostile clone does not execute without a trust decision — `test/repl.test.ts:985`
  (`#53`), and now a *trusted* project's later-added file is withheld too — `:2377`, `:2488`;
- a preamble cannot silently replace a host tool — `test/repl.test.ts:701` (`#54`);
- an unreadable entry does not break the session and is recoverable — `:873` (`#55`);
- what executes is inspectable and deletable — `:1210`, `:1328` (`#57`), and withheld files are
  annotated — `:2776`;
- no ungated tool writes code that later auto-executes — `:1367` (`#56`); and the one gated writer's
  approval is now also the acceptance record — `:2741`.

## Go / No-Go

**GO.** All four gates green (check / lint / test:contained 1163-1161-0-2 / coverage, floors met with
`src/repl.ts` at 100.00 and `src/toolstore.ts` at 99.13). RED→GREEN in separate commits, 37 new tests
failing on main. Two residuals recorded as todo tests. Three out-of-scope follow-ups named above with
exact locations; none blocks the merge.
