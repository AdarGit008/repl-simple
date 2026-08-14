# The environment `bash` runs with

**Status:** Decided · **Issue:** #45 (Bucket 4, step 4) · **Implemented in:** `src/bashenv.ts`

`bash` used to inherit the pi process's environment whole. Pi builds a child's environment from
`getShellEnv()`, which is `{...process.env}` with pi's bin directory prepended to `PATH`, and the pi
process routinely holds `ANTHROPIC_API_KEY` — so **one approved `bash("env")` returned the host's
credentials into model context**, and from there into the transcript, the session file, and every
downstream consumer of either.

Measured on the author's own machine, that was **112 variables**, including `ANTHROPIC_API_KEY`,
`APIFY_API_TOKEN`, `AUDIT_HMAC_PEPPER`, `API_KEY_PEPPER` and a variable holding a sudo password.

---

## Why approval does not cover this

Approval is consent, and consent works only if the user understands what they are consenting to.
"Run a shell command" does not read as "disclose my keys", and `env` is not the case that matters:
the common case is a legitimate `npm test` in a shell where a secret happens to be exported, where
the disclosure is incidental and invisible to everyone involved. Nobody decided anything.

It also composes badly with the rest of this bucket. The credential reaches the model, and the model
has `http_get` — gated since #42, but a gate is a prompt, and a prompt is not a proof.

---

## The decision: an allowlist

**A denylist of secret-shaped names was rejected.** `*_KEY`, `*_TOKEN` and `*_SECRET` catch the
obvious cases and miss `SSH_AUTH_SOCK`, `npm_config_//registry.npmjs.org/:_authToken`,
`AUDIT_HMAC_PEPPER`, and anything the user named themselves. The two policies fail in opposite
directions, and only one of the failures is visible: a missing variable breaks a command, loudly and
fixably, while a leaked variable is silent and permanent.

### What is allowed

| Group | Names |
|---|---|
| Process and shell | `PATH` `HOME` `PWD` `OLDPWD` `SHELL` `SHLVL` `USER` `LOGNAME` `TMPDIR` `TERM` `TZ` |
| Locale | `LANG` `LANGUAGE`, and everything under the `LC_` prefix |
| Toolchain | `NODE_ENV` `NODE_PATH` `NODE_OPTIONS` `NVM_DIR` `NVM_BIN` `JAVA_HOME` `GOPATH` `GOROOT` `GOCACHE` `CARGO_HOME` `RUSTUP_HOME` `VIRTUAL_ENV` `PYENV_ROOT` `PYTHONPATH` `CONDA_PREFIX` |
| XDG paths | `XDG_CACHE_HOME` `XDG_CONFIG_HOME` `XDG_DATA_HOME` `XDG_STATE_HOME` |
| Windows | `SYSTEMROOT` `SYSTEMDRIVE` `WINDIR` `COMSPEC` `PATHEXT` `TEMP` `TMP` `USERPROFILE` `APPDATA` `LOCALAPPDATA` `PROGRAMFILES` `PROGRAMDATA` |

Every entry is a path, a locale, or a toolchain flag; none is a credential in any environment we
could find, which is the only test an entry has to pass. The list is deliberately generous with
non-secrets, because a filter that breaks `npm test` is a filter that gets turned off — and the
allowlist costs nothing for the variables it keeps.

`LC_` is the only prefix. It is a closed, standardised set of locale categories with no
credential-shaped member. `npm_config_` is the counter-example that keeps the rule honest: it looks
like a configuration namespace and is where npm stores registry auth tokens.

Matching is **case-insensitive**. Names are conventionally upper-case, Windows treats them
case-insensitively, and no allowlisted name has a plausible secret-shaped lowercase twin.

### Deliberate exclusions, and what they cost

| Excluded | Cost |
|---|---|
| `SSH_AUTH_SOCK` | `git push` over SSH fails inside `bash`. Agent forwarding **is** a credential — reachable by anything the shell runs. |
| `npm_config_*` | A private-registry install fails. The namespace holds `_authToken`. |
| `GIT_ASKPASS`, `GH_TOKEN`, `AWS_*`, `GOOGLE_*` | Authenticated CLI calls fail. That is the point. |
| `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` | An exotic build breaks. These are loader-injection vectors, and the escape hatch is one variable away. |
| `PI_*` | See below. |

Each is a real cost, paid deliberately, and each is one `REPL_BASH_ENV_ALLOW` entry from being paid
back by whoever decides it should be.

### `PI_*` specifically

**Dropped, and pi's injection is turned off as well.** `exposeSessionEnvironment` defaults to `true`
in pi; the bridge passes `false` unless the caller says otherwise, and the allowlist drops `PI_*`
regardless of what the caller says.

The reason is `PI_SESSION_FILE`: it points at the session transcript on disk, which is the one file
the read tools are jailed away from (`docs/path-jail.md`) — handing `bash` a route to it by
environment variable would be an odd way to undo that. `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL` and
`PI_REASONING_LEVEL` are not secrets, and are dropped only because the model has no use for them
that justifies a per-name exception. Turning pi's injection off too means the tool does not advertise
variables the filter then removes.

---

## Making the filter visible

A command that fails because a variable was withheld must be distinguishable from one that fails on
its own merits, or the model retries the same command until it runs out of iterations.

1. **`REPL_BASH_ENV_FILTERED=1`** is set in every filtered environment, so a shell — and `env` — can
   tell an allowlisted environment from a host that happened to have nothing set.
2. **A note is appended to every failed command**, stating that the environment was filtered and how
   many variables that cost.

**Names appear in the note only when the failure already contains them** — matched as whole names
against the command and its output:

```
/bin/bash: line 1: ANTHROPIC_API_KEY: unbound variable

Command exited with code 127

[repl-simple ran this command with an allowlisted environment; 112 host variables withheld — the
failure names ANTHROPIC_API_KEY. Set REPL_BASH_ENV_ALLOW to a comma-separated list of names to pass
one through (docs/bash-env.md).]
```

That rule is doing two jobs. It is the useful one — an `unbound variable` error is answered by naming
that variable — and it is the discreet one: the note tells the model nothing it did not already have,
so the withheld *names* are not a second, smaller disclosure channel. Listing all 112 on every failed
`npm test` would have been noise wrapped around a leak. **Values never appear anywhere.**

---

## Configuration

| Option | Environment | Default |
|---|---|---|
| `bashEnvAllow: string[]` | `REPL_BASH_ENV_ALLOW` (comma-separated) | empty — the standing allowlist only |

Entries are variable names, matched case-insensitively. There are no patterns: `*_KEY` is read as a
name, and no variable has it. The single exception is the entry **`*`**, which inherits the host
environment untouched — the deliberate opt-out, which has to be typed out to happen, in the same
spirit as the approval gate's `yolo` mode (`docs/approval-grants.md`). Nothing else disables the
filter.

An explicit `bashEnvAllow: []` means "no extras" and beats the environment variable, so a caller can
pin the policy shut without controlling a variable they do not set.

## Where it is enforced

In one place: `createBashEnvHook`, wired into `createBashTool` through pi's `spawnHook` seam, in
`src/bridge.ts`. It is the **last** transform applied, which is what makes it a policy rather than a
default:

- A caller's own `bash.spawnHook` runs first, so it can add what a command needs and cannot
  reintroduce a secret by accident.
- A caller's own `bash.operations` — a custom execution backend, SSH or otherwise — receives the
  filtered environment, because the filter sits above that seam.
- `exposeSessionEnvironment: true` does not bring `PI_*` back.

## What was not done

- **The other mutating tools.** `edit` and `write` do not spawn processes; there is no environment to
  filter.
- **Filtering the host's own environment.** `read_file`, `grep` and friends run in the pi process and
  see `process.env` as they always did. They do not expose it to the model, and nothing here changes
  what they can read.
- **A secret scanner over `bash` output.** A command can still print a secret it fetched from
  somewhere the filter does not reach — a file, a credential helper, a keychain. That is a different
  problem, needing a different instrument, and pretending otherwise would make this one look
  stronger than it is.
