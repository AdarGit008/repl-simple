# Tasks — Gate `save_tool` (#56)

- [x] Task 1: `approvalNote` on `HostTool` + appended in `buildApprovalRequest`
  - Acceptance: `HostTool.approvalNote?: string`; dialog description ends with ` — <note>` when set; unset tools unchanged.
  - Verify: `npx tsx --test test/sandbox.test.ts` + new test passes; `npm run check`.
  - Files: `src/types.ts`, `src/sandbox.ts`, `test/sandbox.test.ts`

- [x] Task 2: `findShadowingBindings` in `toolstore.ts` + export
  - Acceptance: detects `def`/`async def`, `class`, assignment, `import … as`, `from … import [f as]`; returns reserved names bound (deduped, first-appearance order); non-matching code returns `[]`.
  - Verify: detector unit tests in `test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `src/index.ts`, `test/toolstore.test.ts`

- [x] Task 3: gate `save_tool`, `hostToolNames` option, `delete_tool` decision, integration tests
  - Acceptance: `save_tool.requiresApproval === true`; approval description names the consequence; denial (and no-callback) writes no file; shadowing code refused at write time; `delete_tool` ungated with recorded reason.
  - Verify: `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [x] Task 4: full suite + check + lint + commit
  - Acceptance: `npm test` green; `npm run check` clean; `npm run lint` clean; one commit.
  - Verify: `npm test && npm run check && npm run lint`.
  - Files: none (verification only)
