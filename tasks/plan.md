# Implementation Plan: Gate `save_tool` (issue #56)

## Overview

Gate the toolstore's write primitive so persisting auto-executing code cannot happen silently.
Three code changes, all small and additive: (1) a way to add consequence text to an approval
dialog, (2) a shared "does this Python bind a reserved name?" detector, (3) applying both — plus
the `requiresApproval` flag — to `save_tool`, and recording the `delete_tool` decision.

## Architecture Decisions

- **`approvalNote?: string` on `HostTool`** — a static sentence appended to the dialog description
  by `buildApprovalRequest`. Static because the consequence is constant; a function form is YAGNI.
- **`findShadowingBindings(source, reserved): string[]`** — line-anchored regexes over the five
  binding forms from #54 (`def`, `class`, assignment, `import … as`, `from … import [f as]`).
  Conservative/fail-closed; lives in `toolstore.ts` so #54 can reuse it. Exported via `index.ts`.
- **`ToolStoreOptions.hostToolNames?: readonly string[]`** — the reserved names. Caller-supplied,
  so the list derives from the live registry (#57) rather than a hardcoded set that drifts.
- **`delete_tool` stays ungated** — recorded decision (see SPEC.md), DoD-compliant.

## Task List

### Phase 1: Plumbing
- [ ] Task 1: `approvalNote` on `HostTool` + appended in `buildApprovalRequest` (types.ts, sandbox.ts).

### Phase 2: Detector
- [ ] Task 2: `findShadowingBindings` in toolstore.ts + export (independent of Task 1).

### Phase 3: Gating
- [ ] Task 3: gate `save_tool` (requiresApproval, approvalNote, write-time shadowing refusal),
  `hostToolNames` option, record `delete_tool` decision (toolstore.ts) + integration tests.

### Phase 4: Verify
- [ ] Task 4: full suite + `npm run check` + `npm run lint` + commit.

### Checkpoint: complete
- [ ] All five issue tests + detector unit tests pass
- [ ] `npm test`, `npm run check`, `npm run lint` green
- [ ] Change committed

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Regex detector misses a binding form | High (silent shadow) | Cover all five forms with tests; fail-closed posture; #54 load-time check is the backstop |
| Regex detector over-refuses (false positive) | Low (UX) | Documented; pathological only; load-time check (#54) can refine |
| `requiresApproval` regresses replay/grant flow | Med | No change to grant/replay code; existing approval tests must stay green |
| Drift between reserved list and registry | Med | Names supplied by caller from `registry.list()`; not hardcoded |

## Open Questions

None blocking. #54 (load-time refusal) and #57 (registration) remain out of scope.
