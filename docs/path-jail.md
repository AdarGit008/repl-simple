# The cwd path jail

**Status:** Decided · **Issue:** #43 (Bucket 4, step 2) · **Implemented in:** `src/pathjail.ts`

`read`, `grep`, `find` and `ls` are bridged from pi and were declared `mutating: false`, and the
approval gate read `requiresApproval: spec.mutating ? gateMutating : false`. So the gate never
touched them and nothing else did either: the model could read anything the Pi process could read —
`~/.ssh`, `~/.aws`, `~/.config`, sibling checkouts, `/etc/passwd` — with no prompt and no record.
That is the read leg of the read/execute/egress trifecta whose egress leg #42 closed.

A correct jail already existed in this repository. `builtins.resolveInRoot` confined `read_file` and
`list_files`, rejected absolute paths and `..`, and re-checked through `realpath` so symlinks could
not escape. It was simply bypassed by calling the *other* `read`, in the same registry, two lines
away in the same tool list.

---

## Decision: jail, do not gate

| | Gate the reads | Jail the reads |
|---|---|---|
| Fires | dozens of times per task | never, until something leaves the root |
| Cost when wrong | click-through, and a record of "consent" that means nothing | a refusal the model can read and adapt to |
| What it protects | nothing, in practice | everything outside the root |

Roughly 93% of permission prompts are approved, and prompt-flooding is a named technique. A control
that is always clicked through is not a control — and it is worse than nothing, because it produces
an audit trail of consent that was never given in any meaningful sense. The jail decides once,
statically, and never asks.

The jail is also the smaller change: every pi tool accepts pluggable `operations`, and `cwd` was
already being passed.

`gateReads` exists on `BridgeOptions` for callers who want the prompt *on top of* the jail. It is
off by default and it is not the mechanism.

### What it costs

No reading `~/.ssh`, `~/.config`, `/etc`, or the checkout next door. Some of those are things a
model doing ordinary work would legitimately want. The escape hatch is one `bash` call, which is
approval-gated and therefore an actual decision by an actual person. That trade is the point: the
boundary is not "you may not", it is "not without asking".

`edit` and `write` are **not** jailed. They are gated, which is the stronger control, and widening
the jail to cover them is its own change with its own failure modes.

## How it works

Three checks, in order, in `createPathJail`:

1. **Reject absolute paths** — unless `allowAbsolute`, which the bridge sets because pi's tools
   document their `path` as "relative or absolute". An absolute path is still checked against the
   root like any other.
2. **Prefix check on the resolved path** — cheap, catches `..` without touching the filesystem, and
   compares against `root + sep` so that `/tmp/xyz-evil` is not treated as inside `/tmp/xyz`.
3. **`realpath` check** — the only one that catches a symlink. `escape-link` is inside the root by
   every string measure; only resolving it says otherwise. For a path that does not exist yet, the
   nearest existing ancestor is resolved instead, so a symlinked *parent* cannot be a way out.

### Why the check is on the argument, and why the result replaces it

The jail resolves the `path` argument and hands pi the canonical result. This ordering is the whole
design, not a convenience.

Pi's own path handling expands `~`, converts `file://` URLs, strips a leading `@`, and normalises
unicode spaces before resolving against `cwd`. A check that resolves the raw argument its own way is
therefore checking a *different path* than the one that gets opened — and every difference is a
potential bypass. Hand pi an absolute, already-canonical path and its resolver has nothing left to
do, which makes this check the only one that decides.

### Where `operations` come in, and where they do not

`operations` are the second layer, for paths pi derives itself rather than taking from the model:
grep's context-line reads, ls's per-entry `stat`. An `ls` of the root no longer lists an entry whose
target is outside it, rather than rendering a path that cannot be followed.

Two tools deliberately have none:

- **`read`** would need `detectImageMimeType`, and pi does not export its sniffer. Supplying
  operations without it means every image is decoded as UTF-8 into the model's context. `read` opens
  exactly the path it is given, which the argument jail has already canonicalised.
- **`find`** only consults its operations when they supply `glob`, which replaces the `fd`
  subprocess entirely — losing .gitignore handling and the result caps with it. `fd`, like `rg`,
  does not follow symlinks out of the tree it is pointed at.

A caller's own `operations` still compose: the jail wraps them, and they see canonical, in-root
paths or nothing at all.

## One implementation

There is exactly one path jail, in `src/pathjail.ts`, and `test/bridge.test.ts` asserts it by
construction: only that file may define one, only that file may call `realpath`, and both readers
must import it. Two jails that agree today are two jails that can disagree tomorrow, and the one
nobody exercises is the one that will be wrong. That is not hypothetical here — it is the exact
shape of the bug this document exists because of.

## Tests

`test/pathjail.test.ts` covers the jail itself: traversal, absolute paths, symlinks out, the
prefix-sibling case, paths that do not exist, and the ancestor check for missing paths.

`test/bridge.test.ts` covers the four bridged tools together — every attack against every tool,
ordinary in-root reads including through an in-root symlink, and the read half of the exfiltration
chain whose egress half `test/builtins.test.ts` covers for #42. Either half alone breaks the chain;
both are tested so neither can silently regress into a working path.
