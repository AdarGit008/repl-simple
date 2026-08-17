# F-77 Review — code-reviewer report (`791096a..HEAD`, 10 commits, pre-fix)

**Verdict:** REQUEST CHANGES — narrowly. The correction machinery, wiring, tests, and docs culture are excellent; one documentation claim in this very diff is false for the class it's documented under (RLMLoop), and the underlying defect has no tracked follow-up.

## Required

- **`README.md:39-41` + `src/rlm_loop.ts:268`** — The docs commit claims "Diagnostics fed back to the model are offset-corrected" in the section introduced by `RLMLoop`, but `RLMLoop.executeCode` prepends the preamble and never sets `lineOffset`. RLMLoop callers still get shifted line numbers **and preamble source leaked** — the exact #77 defect, unfixed and untracked. Fix one of two ways before merge: (preferred, 3 lines + tests) wire it in `executeCode`, mirroring `src/rlm.ts:566-572`: `runOpts.lineOffset = preamble ? preamble.split("\n").length : 0`, plus a test in `test/rlm_loop.test.ts`; or qualify the README sentence and file the RLMLoop follow-up issue. → **Resolved by Task 10a (preferred fix taken).**

## Optional

- **`src/sandbox.ts:306`** — Location regex `/^(\s*--> .*?)(\d+)(:\d+.*)$/` mis-captures a filename ending in digits immediately before the colon (` --> file0:14:3` captures `0`). Unreachable with today's `scriptName`s; one character hardens it: `^(\s*--> .+:)(\d+)(:\d+.*)$`. → **Resolved by Task 10b with a regression test.**
- **`src/sandbox.ts:336-376`** — `correctRuntimeError` hand-rolls Python traceback rendering; a second implementation of Monty's renderer that can drift on a version bump. The "measured on 0.0.21" comments acknowledge this. No action now; re-measure on the next monty upgrade.
- **`src/session.ts:606-612`** — `prefixLineCount()` re-splits every prior snippet per call — O(n²) cumulative over a session's lifetime. Negligible next to sandbox startup; incrementally maintained counter only if sessions ever get thousands of snippets.

## Nit

- **`src/sandbox.ts:279`** — `correctSyntaxErrorText` is also the typing-diagnostics path; the name undersells it. `correctDiagnosticText` would match its actual role.
- **`src/session.ts:328-332, 424-429`** — `Session` silently overrides a caller-supplied `lineOffset`. Correct behavior (session owns the prepending) and commented; a note on `RunOptions.lineOffset` in `src/types.ts` would prevent caller confusion.

## FYI

- **Behavior change:** Session resume-path runtime errors now include a re-rendered traceback where previously only the bare `<type>: msg` heading was fed back (Session always sets lineOffset now). Existing tests use tolerant match patterns; richer text is an improvement — noting for downstream consumers that parse error text exactly.
- **The ≤-offset drop guard is the right call.** Emitting `:0:` or negative numbers points the model at nonexistent lines; prefix excerpt rows have no user-code mapping. The degenerate case (caller overstating the offset → header-only diagnostic) is pinned by a test and is an acceptable caller-bug failure mode.

## What's Done Well

- Central insight right and tested: a number-only fix is half a fix — tests pin that prefix *source* never reaches the caller (issue tests 2/3 use tokens derived from real strings, surviving preamble edits).
- Offset arithmetic correct in all edge cases checked by hand: preamble ending in `"\n"` (split counts the trailing empty element, matching the joined blank line), empty-string preamble (truthiness checks match between assembly and offset), k-part join sum (each part's split length accounts for the separator). No off-by-one found.
- The resume invariant holds: `run()` discards pending suspension before touching `snippets`, so `prefixLineCount()` at `resume()` equals the value the suspending `run()` used — the exact bug the verifier caught (9.7h) is covered by a test that would fail on its return.
- Honest engineering process: the SPEC/plan commit corrects the disproved "typing is already line-correct" premise; D3 honored (prompt addition inserted at the top only); biome clean; commit messages follow the repo's `9.x — … (#n)` style, one logical change each.
- Security: strictly less exposure. The transform removes preamble/snippet source (previously leaked), adds only synthetic filenames (`<python-input-0>` — no host paths), the prompt addition is static text with no user interpolation (no injection surface). Nothing the transform hides gates an approval decision (those use tool name/args, not diagnostic text).

## Verification Story

- All 25+ new tests read: behavioral integration tests against the real Monty worker, covering absent-offset passthrough, over-large offsets, blank-line gutter shapes, multi-block syntax, multi-frame tracebacks, host-tool resume, both fallbacks. Spot-run: the 32 new lineOffset/fresh-sandbox tests — 32/32 pass.
- biome on all changed files clean; regex edge cases probed directly against real render shapes; cap ordering confirmed (correction → `buildFeedback`'s 16 KiB `truncateText`, re-asserted by the new cap test); `Frame` shape confirmed against `@pydantic/monty@0.0.21`.
