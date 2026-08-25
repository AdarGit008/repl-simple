# Ship Report — Bucket 10: Packaging and consumability (#79–#82)

Branch: `issue-bucket-10-packaging` · Base: `main` (`858d8df`) · Commits: `7cdcb86`–`946a0d8` · Decision: **GO**

## What was built

Made `repl-simple` installable and consumable, closing epic #79 and its three sub-issues:

1. **#80 — usable `dist/`.** `tsconfig.build.json` now sets `rootDir: "src"` and emits `src/` only, so
   `dist/` is flat (`dist/index.js`, `dist/index.d.ts`; no `dist/src/`, no `dist/test/`).
   `getReplPreamble()` now guards its `readFileSync` and fails with a path-naming error (ENOENT `cause`
   preserved) instead of a bare trace. `prepublishOnly` runs the build.
2. **#81 — publishable manifest.** Added `main`/`types`/`exports`/`files`/`license`; removed
   `private: true`; deleted `plan-issue-9.md`. `files: ["dist", "src", "repl", "extensions", "NOTICE"]`
   — `src/` ships deliberately (D3) because `extensions/repl-extension.ts` imports `../src/*.js` under
   pi's jiti loader. `npm pack` is now 60 entries: `dist/`, `src/`, `repl/`, `extensions/`, `NOTICE`,
   `LICENSE`, `README.md`, `package.json` — no `test/`, `docs/`, `tasks/`, or plans.
3. **#82 — truthful README + attribution.** README corrected (build config, sandbox capabilities and
   limits — 12 importable modules, class-inheritance limitation). Added `NOTICE` crediting the two MIT
   upstreams (`ivanvza/pi-reepl`, `josephkern/pi-code-tool`) and the RLM whitepaper
   (Zhang, Kraska, Khattab 2025, arXiv:2512.24601); `LICENSE` points at it.

Tests: 14 new packaging/readme tests — build-output shape, tarball contents, offline scratch consumer
(imports `ReplRunner` + calls `getReplPreamble()` from the packed artifact), export reachability,
manifest-field pins, README import-block execution, tool-list↔code parity, LICENSE/NOTICE shipping.

## Verification evidence

- **Phase 4 (test-engineer), round 1:** GO. 1120 pass / 0 fail; `check`/`build`/`lint`/`coverage` all
  green. Found 8 coverage gaps (manifest surface untested; README still claimed `test/` is emitted;
  tool-list test covered 3 of 4 tables; shared-`dist/` test race; + 4 low). No blocker.
- **Phase 4 (test-engineer), round 2 (post-fix):** **GO**. 1125 pass / 0 fail; the two packaging/readme
  files pass individually, together, and on a repeat run (race closed via a per-test `mkdtemp` fixture).
- **Phase 5 (code-reviewer):** **APPROVE**. 0 Critical, 0 Required. Optional: `prepublishOnly` doesn't
  fire on `npm pack` (clone-and-pack ships no `dist/`); `exports` lacks `./package.json` subpath;
  attribution lines to be verbatim-confirmed before publish; `readPreamble` exported-but-unreachable;
  README presence unpinned in pack.
- **Phase 6 (security-auditor):** **GO**. 0 Critical / 0 High / 0 Medium / 2 Low / 5 Info. Independently
  confirmed the 60-entry tarball leaks nothing; no install hooks; `npm audit --omit=dev` → 0
  vulnerabilities; single exact-pinned runtime dep.

## Residual risks (recorded, not hidden — non-blocking)

- **R1 (Low, security-auditor + code-reviewer):** `prepublishOnly` fires only on `npm publish`, not
  `npm pack`. `git clone && npm pack` ships no `dist/`. Also, `npm publish` from a dirty tree builds
  `dist/` from uncommitted on-disk code. Mitigations recorded: publish from a clean CI checkout; prefer
  `prepack` (fires on both) + keep `prepublishOnly` as the gate. **Fix before any `npm publish`.**
- **R2 (Low, code-reviewer):** `exports` map has no `"./package.json"` subpath — version-introspection
  imports now throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. Add `"./package.json": "./package.json"` if needed.
- **R3 (Low, legal — pre-publish condition):** `NOTICE` copyright lines and whitepaper ID were not
  verbatim-diffed against the upstream `LICENSE` files (no vendored copy). **Diff before publish**
  (MIT compliance). Test pins presence, not verbatim accuracy.
- **R4 (Info):** `readPreamble` collapses EACCES/EISDIR into "missing" (cause preserved); exported but
  unreachable through the exports map (smaller public surface — net positive).
- **R5 (Info):** if the GitHub repo is made public, `docs/`/`tasks/`/`archive/`/`SPEC.md` remain in git
  (correctly excluded from the tarball) and reference internal issue/ship commentary; secret scan found
  zero secrets. Decide repo visibility explicitly at publish time.

## Post-ship CI fixes (found by running the PR through GitHub CI)

Two CI-only correctness bugs, both missed by VERIFY/REVIEW/SHIP because those ran locally where
`dist/` existed and the full `node_modules` (incl. devDeps) was present:

- **Self-reference shadowing (fixed `fe83417`).** Adding `exports` activated Node package
  self-reference (`name: "repl-simple"` + `exports`), so the scratch consumer (placed inside the
  repo tree) resolved `import "repl-simple"` to the repo's own `dist/index.js`, never the packed
  tarball. Passed locally only because the in-tree `dist/` existed. Fix: consumer moved to `tmpdir`
  (outside the package tree) + `node_modules` mirrored for offline resolution; tests now assert
  `import.meta.resolve("repl-simple")` targets the packed artifact.
- **Undeclared runtime peer (fixed `e0cfd6c`).** `dist/bridge.js` eagerly value-imports
  `@earendil-works/pi-coding-agent` (`createBashTool`, …), but it was `devDependencies`-only, so a
  real `npm install repl-simple` consumer would hit `ERR_MODULE_NOT_FOUND` on import. Fix: declared
  as a `peerDependencies` host-provided peer (matches `josephkern/pi-code-tool` convention), kept in
  `devDependencies`. `@pydantic/monty` remains the only regular runtime dep.

## Rollback plan

| Commit | Reverts |
|---|---|
| `e0cfd6c` | peerDependencies declaration (manifest + test + README note) |
| `fe83417` | scratch-consumer self-reference fix (test fixture + 2 tests) |
| `2ca0c70` | ship report (docs only) |
| `946a0d8` | VERIFY coverage-gap fixes (tests + README config-truth only) |
| `c0cb720` | README truth + NOTICE/LICENSE attribution |
| `589e1ac` | manifest + `files`; restores `private: true` and `plan-issue-9.md` |
| `4b2bb01` | flat `dist/` build + guarded preamble |
| `7cdcb86` | SPEC + plan + todo (planning artifacts) |

- Revert full flight: `git revert 946a0d8 c0cb720 589e1ac 4b2bb01 7cdcb86` (newest-first) → returns to
  `858d8df`. Or, if unmerged, simply delete the branch.
- Revert manifest only: `git revert 589e1ac` (drops `main`/`types`/`exports`/`files`; restores
  `private: true`; restores `plan-issue-9.md`). The flat `dist/` build stays.

## Go / No-Go

**GO.** All three report sources green (test-engineer GO ×2, code-reviewer APPROVE, security-auditor
GO). No Critical/High/Medium finding anywhere. Five gates green (test / check / build / lint /
coverage). The only blocking items are **pre-publish** conditions (R1–R3), which do not apply to this
run — no publish is performed (AS4). Merge the branch; queue R1–R3 before the first real `npm publish`.
