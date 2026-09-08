# Approval grants

**Status:** Decided · **Issues:** #44 (Bucket 4, step 3), #35 (dialog cap) · **Implemented in:**
`src/session.ts`, `extensions/repl-extension.ts`

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
itself. Transcript replay survived the 0.0.21 migration and stays (decision 12, 2026-09-08;
`docs/session-replay.md` records its semantics), so this branch stays with it; the grant model
below never depended on it and would be untouched by its removal.

**An entry restored from a dump is not a replay for this branch.** `Session.load()` marks every
entry it restores (in memory only). The cursor still serves a non-gated one, but `willReplayKey` is
false for a restored entry, so a gated call reached in replay asks the user; approved, it runs for
real and its real result replaces the file's, and only then does it replay silently. The rule it
protects is #63's: *a persisted session must never be able to grant an approval that a human did
not grant* — measured before the fix, a dump whose cache named a `bash` call ran without a dialog.

### Branch 2, and why the default makes it dead code

`DEFAULT_GRANT_USES` is **1**. One use is spent by the call being approved, so the default records
no grant at all and the next identical call asks again. In the shipped configuration branch 2 never
fires.

It is built, and enforced, and tested anyway, for two reasons. #44 requires the count to be a real
ceiling rather than a promise. And a dialog that says "allow the next N" is the one thing that would
make branch 2 honest — a grant that authorises more than one execution is defensible exactly when the
prompt granting it said so, and not before.

#51 replaced `ctx.ui.confirm` with a `ctx.ui.select`, which is where such an answer would go, and did
not add one. Its options are approve, deny, decide later and — since #35 — deny remaining. "Decide
later" spends nothing: it records no grant, because deferring a question is not answering it. "Deny
remaining" records nothing either: it is a denial that also latches the rest of the call shut, so it
can only reduce what runs. Until an option says otherwise, `DEFAULT_GRANT_USES` stays at 1 and
branch 2 stays dead.

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
change removed. The dump's schema is validated on load and carries no approval state of any kind —
not grants, not the run's mounts or limits, and not the file's word on cached gated calls (see
above); `docs/session-replay.md` has the full list.

---

## Approval mode: strict and yolo

Strict — one approval, one execution — is a real cost. Roughly 93% of permission prompts get
approved, and a gate that fires on every iteration of a loop is a gate that gets clicked through;
the dialog cap below (#35) bounds the dialog-spam half of that problem.

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

## Dialog cap and "deny remaining" (#35)

The grant model above decides what one approval *buys*. It says nothing about how many times a
single call may *ask*, and one call once asked twenty times: the sandbox consults the callback once
per gated call with no memory of having done so, and a Python `try/except PermissionError` loop
reaches the gate again after every denial. That is a fatigue primitive — vary the command until the
user clicks yes once.

Both bounds live in `extensions/repl-extension.ts`, in the gate `makeOnApproval` mints for one
`repl` / `repl_resume` call, so both are per call by construction and `src/` is untouched:

- **A cap.** `MAX_DIALOGS_PER_CALL` is **8**. Only dialogs actually opened count: a headless run,
  yolo mode and an already-aborted turn answer before the counter, and a replayed call (branch 1
  above) never reaches the callback. Past the cap every further gated call in that tool call is
  denied without a dialog — the sandbox sees a plain denial, Python a `PermissionError` — and the
  result ends with an `[approval cap]` paragraph naming the count, so the model asks the user rather
  than reading unexplained errors and retrying. `repl_resume` mints a new gate and starts a fresh
  count; the dialog title says where it sits (`dialog 3 of 8`).
- **A fourth answer.** *Deny remaining* denies the call on screen exactly as *deny* does, and
  latches the gate so nothing after it asks; the result ends with an `[approvals denied]` paragraph.
  It is per call for the same reason the cap is, and it records no grant: it is the way out of a
  queue, not a preference.
- **The cancel path** is #33's signal, which #49 already hands to the dialog: an abort settles the
  open dialog as a denial, and the sandbox returns `aborted` before the next gated call reaches the
  gate.

Neither bound can manufacture consent — each only ever reduces what gets approved — which is why
they were safe to land as defence in depth while the grant model was being fixed. What must not be
added on top of them is what #35's ordering note warns about: an "approve all", an "always allow
this tool", a remembered preference. `DEFAULT_GRANT_USES` is still 1.

---

## What this does not fix

- **#44's grant model is per-args.** `bash("date +%s%N")` and `bash("date  +%s%N")` are different
  keys. That is the intended behaviour of a normalised key, not a hole — the second one asks.
- **#110** — M22's untracked sibling, the mutant that drops `onApproval` from `session.resume()`,
  was closed on 2026-08-17 (PR #147): `test/repl.test.ts` drives `Repl.resume()` with an approval,
  a pre-aborted signal and a denial ("suspend → resume(approve) runs the pending call" and its
  two siblings), and `docs/mutation-testing.md` records the kill. Nothing here is still open.
