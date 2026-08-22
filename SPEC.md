# Spec: One provider-error rule site, and the cause behind it — issues #189, #190

## Objective

#167 bounded the D53 top-level catch (`RlmResult.error`) and #184 bounded the two tool paths
(`onLLMQuery`, the `depth >= maxDepth` downgrade branch of `onRLMQuery`) that call the provider
directly. #184 introduced `redactProviderError` as the shared helper and routed the two tool paths
through it — but left the D53 catch spelling the identical `truncateText(...)` call out inline. One
rule, two spellings: a later change to the cap, the ratio, the recovery clause or the marker would
have to be made twice, and a miss would be silent.

Separately, both tool paths re-throw the redacted message as a bare `new Error(...)`. The original
rejection — its subclass, any provider `status`/`code`, its stack — is discarded at the throw, so a
host debugging a provider outage in-process sees only the first 1 KiB of text and nothing behind it.

Success looks like: exactly one expression in `src/rlm.ts` names `RLM_ERROR_MAX_BYTES`,
`HEAD_ONLY_RATIO` and `RLM_ERROR_RECOVERY` together; all three provider-error surfaces call it; the
message that crosses the sandbox boundary is byte-identical to what it was before; and the original
rejection is reachable as `cause` on the in-process throw without appearing on any surfaced string.

Issues: https://github.com/AdarGit008/repl-simple/issues/189,
https://github.com/AdarGit008/repl-simple/issues/190.
Source: #184 ship report, post-ship follow-ups 2 and 3 (both **Info**); the `{ cause }` item was
also raised as a Suggestion in #184's five-axis code review.
Siblings filed from the same ship report and deliberately **not** in scope: #191 (elision marker
discloses the redacted message's byte size — a decision, not a defect) and #192 (the 1 KiB
head-only window — an accepted, documented bound).

## Assumptions (recorded — autonomous run)

- **A1 — Behaviour-preserving.** #189 is a consolidation, not a policy change. The cap stays
  1 KiB, the shape stays head-only, the recovery clause stays `RLM_ERROR_RECOVERY`. Any observable
  difference in the redacted output is a defect in this flight, not an improvement.
- **A2 — `cause` is in-process only.** `src/sandbox.ts:1115-1117` builds the Python `RuntimeError`
  from `err.message` and the `HostToolError` python-type discriminator, and reads nothing else off
  the thrown object. Verified by reading, and pinned by test (D4). If a future change serialises
  whole error objects across that boundary, `{ cause }` must be dropped, not the pin.
- **A3 — No new exports.** Neither helper becomes part of the module surface. #85 is open precisely
  about API that exists only because something needed to reach it.

## Decisions

- **D1 — The D53 catch calls `redactProviderError(err)`.** The inline `truncateText(...)` block at
  the `RlmResult.error` assignment site is deleted. Same three constants, same call, one site.
- **D2 — A second helper, `sandboxProviderError(err): Error`, owns the re-throw shape.** The two
  tool paths become one-line `throw sandboxProviderError(err);`. Splitting redaction (a string
  rule) from the throw shape (an `Error` construction) keeps the D53 catch — which needs the string
  and must not throw — on the same rule without inheriting a shape it cannot use.
- **D3 — `cause` carries the original rejection verbatim.** `new Error(redactProviderError(err),
  { cause: err })`. Not truncated, not redacted: it never reaches a surface, and redacting it would
  defeat the only reason to carry it.
- **D4 — The pin is an equality pin at `calls[].error`.** The tool-call trace field carries
  `err.message` verbatim out of `src/sandbox.ts`, so it is the closest observable point to the
  throw. `result.error` is the same text after Python has wrapped it in a `RuntimeError:` prefix —
  an equality pin there would compare the wrapping, not the redaction. Each tool path's trace
  `error` must equal, byte for byte, what the D53 catch produces for the same rejection.
- **D5 — The short-message case is the sharpest `cause` pin.** Under the 1 KiB budget the redaction
  is a no-op, so `trace.error === "boom"` fails the moment any cause text leaks into the message.
- **D6 — The policy document records the consolidation, not a new surface.** No new row: the two
  existing provider-error rows gain `#189` alongside their original issue, and a narrative
  paragraph states the one-rule-site invariant and the `cause` boundary argument.

## Non-goals

- The cap value, the head-only ratio, the recovery clause, and the elision marker's contents.
- #191 and #192, which are decisions about that policy rather than about where it lives.
- `raceAgainstSignal` and the interpolation bounds on these same call sites — that is #171, which
  stacks on top of this branch.
