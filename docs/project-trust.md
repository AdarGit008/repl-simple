# Project trust and the saved-tool preamble

`.pi/code-tools/*.py` is Python the agent wrote for itself with `save_tool`. Every `repl` call
concatenates those files and executes them **before the user's code**, in the same interpreter, with
the same host tools, and with no approval dialog of their own.

That is what the feature is for, and it is also the problem. `.pi/` is a directory in the project,
so it is committed and it travels with a clone. Before [#53] the sequence was:

1. Clone a repository that has a `.pi/code-tools/x.py`.
2. Ask pi anything that reaches the `repl` tool — including a question about the repository itself.
3. The file executes. No prompt, no notice, nothing in the transcript.

The preamble is now gated on **pi's project-trust decision**, the same one that gates `.pi` resources
and project skills.

## Why trust and not a per-file hash

`docs/actionable-items.md` A37 proposed prompting once per file **content hash**, the way direnv
prompts for a changed `.envrc`. That was rejected for a reason specific to this design: these files
are written **by the agent, during a session**, whenever it decides a helper is worth keeping. The
hashes churn. A hash-keyed prompt would produce a stream of approvals for code the user never wrote
and cannot review at the speed it arrives — approval fatigue, and worse than nothing, because it
manufactures a record of consent that means nothing.

direnv's model works because `.envrc` is human-authored and near-static. This is not that.

One decision per project, made when the project is opened, is a decision a human can actually make.
It is the VS Code Workspace Trust model, chosen there for the same reason, and pi already has it:
`ctx.isProjectTrusted()` is on every tool call.

## What the gate does

| Project | Preamble | The model is told |
|---|---|---|
| Trusted, files as accepted | Loaded, up to the limits below | Only if a limit dropped something |
| Trusted, files **added or changed** since the accept | The accepted files load; the rest are **withheld** (see [below](#when-the-files-change-after-trust)) | `[preamble changed]`, naming each withheld file as `added` or `changed`; `list_saved_tools` annotates them, `read_tool` shows them with a note |
| Untrusted | **Not read at all** | `[preamble withheld]`, naming every tool; `list_saved_tools` annotates each as not loaded, `read_tool` refuses to read |

In an untrusted project the files are never opened. `ReplRunner` reads the *directory listing* —
names only — because the names are what the notice needs, and listing a directory is not executing
what is in it.

**The session still works.** Withholding the preamble costs the saved helpers, nothing else.

### The model is told, once

Silence would trade one bug for another. The tools are still on disk — `list_saved_tools` lists
them with a `[not loaded: project not trusted]` annotation, and `read_tool` refuses to read them —
so a model that calls one gets a `NameError` it can explain only if the notice names them. The
notice names the missing tools and says what calling one will do.

It is delivered on the result of the run that created the session, and not repeated. A line printed
on every result is a line that gets skipped.

## Limits, which are not part of the gate

`DEFAULT_PREAMBLE_LIMITS` caps the preamble at **32 files and 64 KiB**, and applies in a trusted
project exactly as in an untrusted one. It is a **resource control, not a security control**: a
trusted project is not thereby entitled to put a megabyte of Python in front of every single run.
The preamble is re-executed on each `run()`, so its cost is paid per call by Monty's parser and type
checker, on the user's latency.

Files load in name order and are skipped **whole** — never truncated. Half a Python file is a
`SyntaxError`, and a `SyntaxError` in the preamble takes every tool before it down as well. What was
dropped is named in the preamble header, for a human reading the transcript, and on the result, for
the model.

## When trust changes mid-session

The decision can change while pi is running. `ReplRunner` re-reads it on every `run` and `resume`,
and a session whose decision no longer matches is **discarded and rebuilt**: variables, imports and
the cached tool calls go with it.

That is stronger than it first looks, and it is deliberate. The preamble is not something a session
loads once — `Session.run` prepends it to the transcript on **every** run. A session created while
trusted would go on executing that code for as long as it lived, so a gate that only applied at
creation would apply only to sessions that do not exist yet.

Two details soften the edge:

- **A change that changes nothing costs nothing.** Trusting a project with no saved tools, or
  withdrawing trust from a session that never had a preamble, is recorded and nothing is rebuilt.
  There is no security in wiping a session over a preamble that is empty either way.
- **A pending approval is dropped, not answered.** If the decision changes while a call is suspended,
  `repl_resume` reports that the session was rebuilt and that the call never executed, rather than
  running it under a decision that no longer applies.

Both cases say so on the result, in a `[trust changed]` line before the output the model asked for.

## When the files change after trust

Trust is one decision, made when the project is opened — and it covered the saved tools that were
there at the time. Nothing used to re-check that set. A `.pi/code-tools/*.py` added or rewritten
afterwards — pulled in by a compromised upstream, a malicious maintainer, a careless merge — loaded
on the next session build with no prompt and no notice ([#198]). The per-file hash prompt was
rejected above for a reason that still holds, so the fix is not a prompt. It is a memory.

**The accepted set.** The first time a trusted project's saved tools load, `ReplRunner` records the
sha256 of every file that loaded — hashed over the bytes it actually read, through the same
`O_NOFOLLOW` descriptor — in a manifest kept **outside the project**. That first load is the
implicit accept: the trust dialog covered the files present then. The manifest is written even
when the set is empty, so a project trusted before it had any saved tools still catches the first
one that appears.

**Every later session build compares.** Eviction, `repl_reset`, a trust flip, or a fresh pi run over
the same directory — each is a new `loadSavedTools`, and each is checked against the manifest:

| On disk vs. accepted | What happens | The model is told |
|---|---|---|
| Same bytes | Loads, silently | Nothing |
| A file the manifest does not know | **Withheld** — not concatenated, never executed | `[preamble changed] … name (added)` |
| A file whose hash differs | **Withheld** | `[preamble changed] … name (changed)` |
| An accepted file that is gone | Nothing to withhold | `[preamble changed] … no longer in .pi/code-tools` |
| `.pi/code-tools` exists but cannot be listed (`EACCES`) | Nothing loads, and the manifest is **untouched** — not written on a first load, not reconciled on a later one | `[preamble unreadable] … could not be listed` |

The last row is the difference between "empty" and "unknown". A directory the loader cannot list is
not an empty set: recording one would erase the acceptance record over a transient permission error,
and comparing against one would call every accepted file removed. `ReplRunner.acceptPreamble()`
answers `unreadable` for the same reason, and accepts nothing.

The check is a hash, not a stat: a same-size rewrite with a restored mtime is still a rewrite. The
withheld files keep their place in the 32-file / 64 KiB budget, so accepting one never unloads a
sibling that fit only because it was withheld. A withheld file still counts as trusted for reading:
`read_tool` shows it, with a `# NOTE` — the model is being asked to review it, and cannot review
what it cannot read. It is the *execution* that waits.

**Accepting the current set.** Three spellings, all deliberate:

- `ReplRunner.acceptPreamble()` re-hashes everything that loads and rewrites the manifest — the
  host's explicit accept. The pi command that calls it, `/repl-accept-preamble`, lands in the next
  wave; until then embedders call it directly.
- `save_tool` records the hash of what it wrote, and `delete_tool` drops the entry — **in a trusted
  project**. The agent writes these files, so its own writes never withhold — and `save_tool`'s
  approval dialog is the consent. Re-saving a withheld file from inside `repl` is therefore a valid
  way to accept it. In an untrusted project both tools leave the manifest alone: the write is still
  approval-gated and still happens, but acceptance authority is the trust decision plus explicit
  accepts, and a session that never held trust must not decide what a trusted one runs. A file
  saved while untrusted is withheld — with the notice — once the project is trusted, until the set
  is accepted; the tool's reply says so.
- A removed file is a notice, not a withhold, and the manifest keeps its entry: if the file comes
  back with the bytes that were accepted, it loads without ceremony. The notice repeats on each new
  session until the set is accepted again.

Live sessions are not rebuilt by an accept. They keep the preamble they were built with — exactly as
they keep a deleted tool — and the notice says to run `repl` with a new `sessionId`.

**Where the manifest lives, and why it fails closed.** `.pi/` is what the attacker writes; a manifest
there would be a manifest the attacker rewrites. So the store is, in order of precedence:

1. `ReplRunnerOptions.preambleStoreDir`
2. `REPL_PREAMBLE_STORE_DIR`
3. `$XDG_STATE_HOME/repl-simple`
4. `~/.local/state/repl-simple`

with one file per project, `preambles/<sha256 of the project's real path>.json`, mode `0600` in a
`0700` directory, written whole through a rename. Every path the store hands out is canonical —
symlinks followed, so a store named `/var/…` on macOS lives at `/private/var/…` and says so — and the
inside-the-project verdict is made on the canonical paths of both sides, afresh on every operation.
A store that resolves inside the project — literally, or through a symlink — is refused. A store
that cannot be read, cannot be written, or holds something that is not a manifest is
**unavailable**, and an unavailable store withholds everything that would have loaded and says so
in a `[preamble unverified]` line. Never open: an acceptance that cannot be recorded would make the
next load a "first load", and first loads accept. An untrusted project never touches the store at
all — not the session build, which does not read it, not `save_tool` / `delete_tool`, which do not
update it, not `acceptPreamble()`, which answers `untrusted` before looking.

## For embedders

`ReplRunner` takes the decision as a function, not a boolean, so it can be re-read rather than
snapshotted:

```typescript
new ReplRunner(cwd, {
  isProjectTrusted: () => ctx.isProjectTrusted(),
  preambleStoreDir: "/var/lib/my-host/repl-simple", // optional; see the precedence above
});
```

**It defaults to untrusted.** A caller with no trust decision to offer has not made one, and the cost
of guessing wrong in the other direction is arbitrary code execution.

`loadSavedTools` returns code that will run with full host-tool access; call it only for a project
whose code the user has agreed to run. `savedToolNames` is the half that is safe either way. Hand
`loadSavedTools` an `accepted` map and it withholds what the map does not cover, reporting it in
`unaccepted`; a directory it cannot list comes back with `unlistable` set and every other field
empty — treat that as "unknown", never as "nothing". `createPreambleManifestStore` and
`resolvePreambleStoreDir` are the pieces `ReplRunner` builds that map from, for a host that keeps
its own. The store's `storeDir()` and `manifestPath()` are canonical paths; compare against those,
never against the spelling the store was given.

## What this does not cover

- **A deletion does not stop the running session.** `delete_tool` removes the file, and new sessions
  stop running it; the current session keeps the copy it loaded, and the tool says so. Removing
  code from a transcript that already prepends it would need session surgery no tool should attempt.
- **`read_tool` refuses whole untrusted projects**, even for a tool the model saved itself
  mid-session: it cannot tell a friendly save from a hostile one apart, and "never even read" is the
  point of the gate. Trusting the project is the answer.
- **`.pi/` is now in this repository's `.gitignore`** so these files do not travel from here. That
  protects other people from us; project trust is what protects us from them.
- **The accepted set is not a second trust dialog.** It withholds what changed and names it; it
  does not re-confirm anything. Accepting is an explicit call (or a `save_tool` under its own
  dialog), and the pi command for it is not in this wave.
- **A removed file is reported, not enforced.** Its manifest entry stays until the set is accepted
  again, so a file that reappears with its accepted bytes loads quietly — by design, and worth
  knowing.
- **The manifest has no lock.** Two pi instances on one project, or two sessions saving at once,
  read-modify-write the same file; each write is whole (a rename), and the later one wins. The
  loser's entry is withheld on the next build, which is the safe direction.
- **An unavailable store is a window, not a wall.** While the store cannot be used everything is
  withheld — but a project trusted *during* that window has no manifest, so the first load after
  the store recovers accepts whatever is on disk then.
- **A missing manifest is a first load, and first loads accept.** Two ways to arrive there without
  the store ever failing: the manifest is deleted (a user cleaning `~/.local/state`), or this build
  is the first one with a manifest at all and the project was trusted before it existed. Either way
  the next trusted load accepts whatever is on disk *then* — a file pulled in the meantime included.
  The trust decision, not the manifest, is what covered those files; if that is not the state you
  want, review `.pi/code-tools` before the first `repl` call, or revoke trust and re-grant it.
- **A project that contains the store is refused — and so is every saved tool in it.** The default
  store is under `~/.local/state`, so running pi with `cwd = $HOME` (or any ancestor of the state
  dir) puts the store inside the project. That is refused, and every tool in `~/.pi/code-tools` is
  withheld with `[preamble unverified] … inside the project` until `REPL_PREAMBLE_STORE_DIR` (or the
  embedder's `preambleStoreDir`) names a directory outside the project. Fail-closed by design; the
  notice names the variable.
- **`list_saved_tools` still compares size and mtime** for its in-session "changed since" note; only
  `read_tool` — which has the bytes anyway — compares the hash. The accepted-set check at session
  build always hashes.

[#53]: https://github.com/AdarGit008/repl-simple/issues/53
[#56]: https://github.com/AdarGit008/repl-simple/issues/56
[#198]: https://github.com/AdarGit008/repl-simple/issues/198
