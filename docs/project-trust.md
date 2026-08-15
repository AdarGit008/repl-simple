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
| Trusted | Loaded, up to the limits below | Only if a limit dropped something |
| Untrusted | **Not read at all** | `[preamble withheld]`, naming every tool |

In an untrusted project the files are never opened. `ReplRunner` reads the *directory listing* —
names only — because the names are what the notice needs, and listing a directory is not executing
what is in it.

**The session still works.** Withholding the preamble costs the saved helpers, nothing else.

### The model is told, once

Silence would trade one bug for another. The tools are still on disk and `list_saved_tools` still
lists them, so a model that is not told calls one and gets a bare `NameError` it cannot explain. The
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

## For embedders

`ReplRunner` takes the decision as a function, not a boolean, so it can be re-read rather than
snapshotted:

```typescript
new ReplRunner(cwd, { isProjectTrusted: () => ctx.isProjectTrusted() });
```

**It defaults to untrusted.** A caller with no trust decision to offer has not made one, and the cost
of guessing wrong in the other direction is arbitrary code execution.

`loadSavedTools` returns code that will run with full host-tool access; call it only for a project
whose code the user has agreed to run. `savedToolNames` is the half that is safe either way.

## What this does not cover

- **`save_tool` itself is still ungated** — an agent can write a file that a later trusted session
  executes. That is [#56].
- **`list_saved_tools` reports names in an untrusted project without saying they will not load.** The
  toolstore tools have no view of the trust decision; the run-level notice is what closes the gap.
- **`.pi/` is now in this repository's `.gitignore`** so these files do not travel from here. That
  protects other people from us; project trust is what protects us from them.

[#53]: https://github.com/AdarGit008/repl-simple/issues/53
[#56]: https://github.com/AdarGit008/repl-simple/issues/56
