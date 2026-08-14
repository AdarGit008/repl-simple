# Approval grants

**Status:** Decided · **Issue:** #44 (Bucket 4, step 3) · **Implemented in:** `src/session.ts`,
`extensions/repl-extension.ts`

One approval used to buy unlimited silent re-execution. Measured through the shipped tool:

```
approve  bash("date +%s%N")  once
then     [bash("date +%s%N") for i in range(3)]
      →  0 prompts, 3 distinct nanosecond timestamps

approve  write('f.txt','v1')  once
      →  7 real writes, 1 prompt
```

The key was never the problem — `cacheKey(tool, resolvedArgs)` binds to the tool *and* its
normalised arguments, not to a loose string. Lifetime and count were. `session.ts` built a
position-independent `Set` of every key the session had ever executed and auto-approved any match
for the rest of the session, before the user's callback was consulted at all. A grant, once given,
never expired and had no ceiling.

---

## What a gated call now has to pass

Three ways through, in this order (`Session.makeApprovalGate`):

| | Branch | Executes anything? |
|---|---|---|
| 1 | **Replay** — the caching registry is about to serve this exact call from the cache, in cursor order | No |
| 2 | **A live grant** — approved earlier in *this same call*, with uses left | Yes |
| 3 | **The user** — the callback decides; no callback means denied | Yes, if approved |

The fourth way is gone: matching any key executed at any point in the session's life.

### Branch 1 is not a grant

Replay re-executes the whole transcript to rebuild Python state. Host-tool calls from earlier
snippets are answered from the ordered cache rather than run again — but the approval gate fires
*before* `tool.execute`, so without this branch every prior gated call would re-prompt on every
subsequent `repl` call. Approving a call that will not run is not consent to anything; it is the
absence of a question.

It is deliberately **positional**. `willReplayKey` asks whether this key is the *next* entry the
cursor will serve, not whether it appears anywhere in the cache. That distinction is the whole fix:
"the same call being replayed" versus "something like this ran once".

The cursor is visible only inside `createCachingRegistry`, which is the replay implementation
itself. When #40 removes transcript replay, that function and this branch go with it and the grant
model below is untouched.

### Branch 2, and why the default makes it dead code

`DEFAULT_GRANT_USES` is **1**. One use is spent by the call being approved, so the default records
no grant at all and the next identical call asks again. In the shipped configuration branch 2 never
fires.

It is built, and enforced, and tested anyway, for two reasons. #44 requires the count to be a real
ceiling rather than a promise. And bucket 5 (#51) replaces `ctx.ui.confirm` with a dialog that can
offer "allow the next N" — a grant that authorises more than one execution is defensible exactly
when the prompt granting it said so, and not before.

`grantUses` is per-`Session`, and values below 1 are refused rather than clamped: 0 and 0.5 are both
someone believing something false about the model, and a security ceiling should not be silently
rounded into a different one.

---

## Lifetime: one call

A grant lives for one logical `repl` call:

- `run()` clears grants on entry — nothing carries in.
- `run()` and `resume()` clear them on exit, unless the result is a **suspension**.
- `abandon()` and `reset()` clear them.
- `dump()` does **not** serialize them.

A suspension is the same call, paused: `run()` gates a call, the decision is deferred, `repl_resume`
answers it, and execution continues. Grants have to span that boundary or an approval given at the
resume dialog would not cover the call it was shown for. That pause is also the only window in which
a grant can be outstanding while nothing is running, which is what `repl_reset` reports:

```
Session 'default' reset. Approval mode: strict. No approval grants were outstanding.
```

`GrantSummary` carries the tool name and the remaining count, and deliberately not the arguments —
the key holds a full `bash` command line, the string in this system most likely to contain a
credential someone pasted.

Grants are in-process. `Session.dump()`/`load()` are never called on the shipped path, and even if
they were, a grant that survives into another process is precisely the unbounded lifetime this
change removed.

---

## Approval mode: strict and yolo

Strict — one approval, one execution — is a real cost. Roughly 93% of permission prompts get
approved, and a gate that fires on every iteration of a loop is a gate that gets clicked through;
#35 tracks the dialog-spam half of that problem.

The honest alternative to a strict gate is not a lenient gate. It is admitting that some users, in
some sessions, do not want to be asked — and making that a decision they state, rather than one
inferred from a tired click:

```
/repl-approvals          # report the current mode
/repl-approvals yolo     # bash, edit and write run without asking
/repl-approvals strict   # back to one approval per execution
```

Properties that make the toggle safe to have:

- **Per-process, never persisted.** A restart is back to `strict`. The blast radius is the session
  the choice was made in.
- **Never applies headless.** `hasUI === false` denies before the mode is consulted. A non-
  interactive run has nobody who could have set the mode and nobody watching what it approves.
- **Loud on the way in.** Turning the gate off warns; turning it back on does not.
- **Visible after the fact.** `repl_reset` names the mode.

`yolo` turns off *asking*, and only that. It approves what would have been prompted — including an
`http_get` to a host outside `REPL_HTTP_ALLOWLIST` — but the refusals that never asked in the first
place are unchanged: the cwd path jail (#43) still refuses a read outside the root, and #42's SSRF
defences still refuse private, loopback and link-local destinations on every redirect hop. Those are
not questions a prompt can meaningfully put to a user, so no mode can answer them.

---

## What this does not fix

- **#35** — the dialog can still fire many times in one run, with no cap and no "deny the rest".
  Strict mode makes that *more* likely, not less; the two issues are complements.
- **#44's grant model is per-args.** `bash("date +%s%N")` and `bash("date  +%s%N")` are different
  keys. That is the intended behaviour of a normalised key, not a hole — the second one asks.
- **#110** — `Repl.resume()` still has no test proving `onApproval` reaches the session, which is
  M22's untracked sibling. It fails closed, so it breaks resume rather than opening a bypass.
