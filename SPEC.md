# Spec: Serialize session creation and bound the session pool — issue #59

Issue: https://github.com/AdarGit008/repl-simple/issues/59 (Bucket 7, step 1 — parent #58, blocked-by #18, closed).

## Objective

Two defects in `ReplRunner` (`src/repl.ts`), both reproduced at HEAD:

1. **The creation race.** `getOrCreateSession` does `get` → `await createSession()` (disk I/O:
   `loadSavedTools` / `savedToolNames`) → `set`. Two concurrent `run`s on one `sessionId` each
   build a session; the second `set` wins and the first — with everything in it — is silently
   dropped. Both calls report success, so the model reasons from state that does not exist:
   `Promise.all([run("x = 1","s"), run("y = 2","s")])` → both report `[result]\nNone`, then
   `print(x)` → `TypeError: Name 'x' used when not defined`.
2. **The unbounded pool.** `sessions` is a `Map` keyed by a model-supplied string, with no cap and
   no eviction. Each live session retains every snippet it ever ran plus its full `callCache`.
   `reset()` clears the `Session`'s fields but leaves the entry in the map.

Success is the issue's Definition of Done, restated as testable criteria in **Success Criteria**
below. The sharpest sub-problem is the suspension one: eviction must never silently discard a call
the user was asked to approve.

## Scope

`src/repl.ts` (the pool) + `test/repl.test.ts` (six issue tests + two updated tests) + `README.md`
(policy documentation). No changes to `session.ts`, the sandbox, or the extension's tool
descriptions. No new dependencies.

## Explicit decisions

### D1 — Single-flight creation via an `inflight` map

`private inflight = new Map<string, Promise<LiveSession>>()`. `getOrCreateSession` stores the
creation promise **before** awaiting anything, so a concurrent caller joins the same creation
instead of starting a second. On success the promise inserts the session into `sessions` and removes
itself from `inflight`; on rejection it removes itself and rethrows — a single failed creation can
never poison the id (the same contract `src/pool.ts` already pins for the worker pool:
`getSandboxPool`).

### D2 — Trust-change rebuilds share the flight

`trustChangeDiscards` deletes a session whose trust decision changed; the rebuild then routes
through the same `inflight` path, so two concurrent rebuilders of one id create **one** session.

### D3 — Stale-reference revalidation

`getOrCreateSession` awaits `trustChangeDiscards`, during which the entry may be rebuilt or evicted
by another caller. After the await it returns `existing` only if `sessions.get(sessionId) ===
existing`; otherwise it loops (re-get or join the inflight creation). No session object that the
map no longer holds is ever handed out.

### D4 — LRU by Map insertion order

`Map` iteration order is insertion order. "Use" = `delete` + `set` (touch) on **every** retrieval
of a live session — `run`, `resume`, and `abandon` all touch. `reset` does not touch: it removes.

### D5 — The cap

`DEFAULT_MAX_SESSIONS = 32` per `ReplRunner` (per cwd — each runner owns its own pool).
Precedence: explicit `ReplRunnerOptions.maxSessions` > `REPL_MAX_SESSIONS` env (positive integer,
read at construction) > default. Non-positive values fall back to the default, matching the
`envInt` pattern in `src/pool.ts`. Rationale for 32: the preamble's `DEFAULT_PREAMBLE_LIMITS.maxFiles`
precedent, and a session is strictly heavier than a preamble file.

### D6 — Eviction policy (the recorded suspension decision)

On insert past the cap: evict the **least-recently-used session that is not suspended**, skipping
suspended ones and never evicting the id just inserted. If **every** other session is suspended,
exceed the cap temporarily rather than discard a pending approval. **Decision: refuse to evict a
suspended session** (never report-and-drop — a dropped suspension loses a call the user was asked
to approve, and the model is never told). The over-cap state is self-limiting: every suspension
demands user attention, and an abandoned/resumed/overwritten session loses its protection on the
next insert.

### D7 — `reset()` evicts

`reset(id)` calls `session.reset()` (to obtain the revoked-grant report), then deletes the map
entry. Deliberate, model-visible consequence: `repl_resume` after `repl_reset` now answers
`No session 'X' exists. Run some code first.` instead of `…has nothing waiting for approval.` The
extension's `repl_reset` wording is unchanged (it describes the reset, not the entry's afterlife).
The two existing tests that pinned the old contract are updated, not deleted.

### D8 — Reset racing an in-flight creation

`reset` sees no entry and reports `{ existed: false, revoked: [] }`; the in-flight creation lands
afterward. No cancellation token — out of scope, and coherent from the model's seat (the reset
happened before the session existed). `executionMode: "sequential"` (#49) already makes
intra-message races impossible; cross-turn ordering is the only kind left.

### D9 — Diagnostics

New public method `ReplRunner.liveSessionCount(): number` — the number of entries in `sessions`
(in-flight creations that have not landed are not counted). The issue's DoD says "assert the map
size, not just behaviour", and a map size that cannot be observed cannot be asserted. Documented
as a host/test diagnostic, not a model-facing API.

### D10 — Test seams

Test 2 demands a `createSession` call counter. TypeScript `private` methods are ordinary prototype
methods at runtime, so the tests patch `createSession` with an own-property wrapper that counts
and delegates — **no production test hooks**. Tests 1, 4, 5, 6 are pure behaviour tests through the
real `ReplRunner`.

## Assumptions (recorded — fire-and-forget run, no human asked)

1. Default cap 32 (D5) — no issue guidance; sized against the preamble precedent.
2. Env var name `REPL_MAX_SESSIONS` (D5).
3. "Touch" covers `run`/`resume`/`abandon`; `reset` removes (D4).
4. The suspension decision is **refuse to evict**, not "report it" (D6) — silent loss is the one
   outcome the issue forbids.
5. The cap is per `ReplRunner` instance (per cwd), not process-wide — `getRunner` caches one runner
   per extension instance, and a process-wide pool would be a different object (#60's territory).

## Tech stack

TypeScript 5.9 (strict), `node:test` + `node:assert/strict` via `tsx --test`, Biome 2.5.8 for lint
and format, Stryker 9.6.1 (mutation, incremental), `tsc -p tsconfig.build.json` for the build.
Node >= 22.19.0. No new dependencies.

## Commands

```
Test (focused):  npx tsx --test test/repl.test.ts
Test (full):     npm test
Type-check:      npm run check
Build:           npm run build
Lint:            npm run lint
Coverage gate:   npm run coverage
Mutation:        npm run mutation        (quality gate; incremental)
```

## Project structure

```
src/repl.ts              → the change: inflight map, LRU pool, eviction, reset-evict, diagnostic
test/repl.test.ts        → six issue tests (new describe block) + two updated contract tests
README.md                → "Approvals"/tool docs section: documented cap + eviction policy (DoD)
SPEC.md, tasks/plan.md,
tasks/todo.md            → this spec, the plan, the task checklist
```

## Code style

Follow the file's existing voice: sentence-style model messages, JSDoc on every decision, issue
references in comments, no `any`. The core of the new code:

```ts
/** The pool. Insertion order is recency: oldest = eviction candidate. */
private sessions = new Map<string, LiveSession>();
/** Creations in flight, stored before awaiting so concurrent callers join one. */
private inflight = new Map<string, Promise<LiveSession>>();

private getOrCreateSession(sessionId: string): Promise<LiveSession> {
  for (;;) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touch(sessionId, existing);
      if (!(await this.trustChangeDiscards(sessionId, existing))) {
        if (this.sessions.get(sessionId) === existing) return existing; // D3
        continue; // evicted or rebuilt while the trust check ran
      }
    }
    return this.joinOrStartCreation(sessionId, existing !== undefined);
  }
}
```

## Testing strategy

`node:test`, behaviour-first, through the real `ReplRunner` against real Monty — the suite's
existing style. The six issue tests, numbered as in the issue:

1. **The reproduction**: a *trusted* project (preamble files widen the creation window so the
   race is reliably red), `Promise.all` of `x = 1` and `y = 2` on one id, then assert both `x` and
   `y` resolve — asserted on **state**, never on the reported statuses (both already claim success).
2. **One creation**: own-property counter wrapper around `createSession` (D10); concurrent runs →
   counter is 1.
3. **No poisoned id**: wrapper rejects once; the run fails; the wrapper is restored; the next run
   on the same id succeeds and its state persists.
4. **LRU eviction**: `maxSessions: 2`; create `a`, `b` (touch `a`), create `c` → `b` evicted;
   assert `liveSessionCount() === 2` (the map size, per DoD) and that `b`'s state is gone
   (re-running on `b` gives a fresh session).
5. **`reset` removes the entry**: after `reset`, `liveSessionCount()` drops and `resume` answers
   "No session 'X' exists".
6. **Suspended sessions are never evicted**: `maxSessions: 1`; session `a` suspends; creating `b`
   exceeds the cap (count 2, `a`'s approval still pending and still resumable); abandoning `a`
   removes its protection and creating `c` evicts it (count back at 1).

Two existing tests updated to the D7 contract: "reset clears a suspension too…" now asserts the
no-session sentence after reset; "clears session state on reset" passes unchanged (a recreated
session has no variables either way).

RED → GREEN per task; regression = full `npm test` after every task; `npm run check` + `npm run
build` + `npm run lint` before every commit.

## Boundaries

- **Always:** tests before the fix, full suite before each commit, biome lint, issue-referenced
  commit messages, mark the task in `tasks/todo.md` as it completes.
- **Ask first (record instead — fire-and-forget):** nothing in this change is high-risk or
  irreversible; any surprise is recorded in the ship report rather than pausing.
- **Never:** delete a failing test without replacing it, hand-edit `coverage-baseline.json`, skip
  the mutation guard, change the extension's tool descriptions or `session.ts` (out of scope).

## Success criteria

1. All six issue tests exist and pass; tests 1–5 are red before their fix, green after.
2. The issue's reproduction passes end to end.
3. Concurrent creation calls `createSession` exactly once (counter asserted).
4. A failed creation does not poison the id — the next call retries and succeeds.
5. The LRU cap evicts; eviction is asserted on the map size via `liveSessionCount()`.
6. `reset()` removes the entry rather than leaving a hollow one.
7. A pending suspension survives every eviction attempt; the refusal decision is recorded in code
   comments **and** in the README (DoD: "recorded, not implicit").
8. The cap and eviction policy are documented in the README; `maxSessions` is a documented
   `ReplRunnerOptions` field.
9. `npm test`, `npm run check`, `npm run build`, `npm run lint`, `npm run coverage` all exit 0;
   mutation score does not regress.

## Open questions

None blocking. The five assumptions above are the recorded answers to everything the issue left
open (cap size, env name, touch semantics, suspension policy shape, pooling scope).
