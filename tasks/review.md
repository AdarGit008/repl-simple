# Review — issue #75: abort returns what it completed

Five-axis review of the working-tree diff (`SPEC.md` D30–D35 source of truth) by the code-reviewer
persona (fresh context). Reviewed code only: `src/rlm.ts`, `src/sandbox.ts`, `src/types.ts`,
`test/rlm.test.ts`.

## Verdict: REQUEST CHANGES → one Important finding (misattributed mutation comment) fixed; code approved

### Critical Issues
None.

### Important Issues (fixed)
- **Misattributed "kills M2" comment (test/rlm.test.ts:638-639, and SPEC.md:169).** Test A aborts via
  `onIteration`, so the **post-run** check returns `aborted`; A does **not** kill M2 (loop-top
  `if(false)`) — with M2 applied, A still passes. The sole M2 killer is **F** (already-aborted signal →
  asserts `0` queries / `0` budget charged, which break if the loop-top check is neutered); the
  post-run check is uniquely pinned by **E**. Fixed: test A's comment now states the correct
  attribution (A = aggregate contract; F = loop-top/M2; E = post-run), and SPEC.md's mutation line now
  names F/E/D/G correctly. A future maintainer deleting F must know it is the loop-top check's only
  guard.

### Suggestions (recorded, one applied)
- **Same-tick abort/error race** (src/rlm.ts catch): a genuine LLM error rejecting in the same tick as
  an abort is folded into `"aborted"` by design. Applied a one-line comment so a future reader does not
  "fix" it with a fragile `isAbortError` predicate (which the SPEC already rejected — see D35).
- Loose cast `(r as { errorKind?: string })` in test E (rlm.test.ts:804) — matches the file's existing
  pattern, no `any`; left as-is.
- Test E's `calls.length === 1` rides the 250 ms grace race — documented in SPEC Assumption 5,
  deterministic in-run; flagged for attention only if flakiness ever appears.

### What's Done Well
- `aborted()` closure (rlm.ts:860-866) centralizes the three return sites; reads `iterations`/`budget`
  at call time (no stale capture) and reuses `extractBestAnswer` + `budgetReport` unchanged.
- D35's "`signal.aborted` is the whole story" is robust — no fragile error-string/`instanceof`
  predicate; `else throw err` correctly re-throws non-abort rejections (pinned by G).
- Sandbox `finally` (sandbox.ts:1244-1250) mirrors `withHostDeadline`; guard matches the add-site;
  no abort-path change (the `{once}` listener auto-removes on fire; `finally` is a no-op there) and it
  clears a secondary never-firing-listener leak for already-aborted signals.
- F and G are non-tautological and well-targeted (F uniquely pins "no charge/no query on pre-abort";
  G uniquely pins the re-throw, killing the catch `if(true)` mutant).
- No internal `RlmResult.status` consumer switches exhaustively, so `"aborted"` needs no new case.

### Verification Story
- Suite 1045/1045 ×2 deterministic; `tsc --noEmit`/build/lint clean; coverage floors met (rlm.ts
  98.52, sandbox.ts 97.66 — both above floor).
- Bounded mutation sweep (`--mutate` changed sites): **22/22 changed-site mutants detected** (21
  Killed + 1 Timeout), M2 dead; `rlm.ts` file score 58.66 → 64.53. The 61 remaining rlm.ts survivors
  are all pre-existing `boundConversation` mutants (lines 766-777), unrelated to #75.
- No new security surface: the `finally` is race-free (`abort()` dispatch is synchronous, so no
  listener fires post-removal); passing the caller's signal into a caller-injected client leaks nothing.
