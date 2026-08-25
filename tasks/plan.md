# Implementation Plan: Bucket 10 — Packaging and consumability

Source of truth: `SPEC.md`. Stacked on branch `issue-bucket-10-packaging`.
One task = one coder dispatch = one orchestrator commit. Order is fixed: Task 1 → Task 2 → Task 3.

## Overview

Make `repl-simple` installable. Three dependent fixes, bottom-up: (1) the build must emit a flat,
usable `dist/`; (2) the manifest must declare that `dist/` and stop shipping tests/docs; (3) the
README and LICENSE must describe and credit what now actually works. Each task lands its own tests
RED→GREEN; no task depends on a later one.

## Architecture Decisions

- **D1 — `rootDir: "src"`, emit `src/` only.** `tsconfig.build.json` gets `rootDir: "src"` and drops
  `test/**/*.ts` from `include`, so `dist/` mirrors `src/` (`dist/index.js`, no `dist/src/`, no
  `dist/test/`). Follows the #21 split: `tsconfig.json` keeps checking `test/` + `extensions/`.
- **D2 — Preamble ships at package root.** `getReplPreamble()` keeps resolving
  `join(__dirname, "..", "repl", "repl_server.py")`; after D1 that is `<pkg>/repl/repl_server.py`,
  shipped via `files`. No redundant `dist/repl/` copy.
- **D3 — `files: ["dist", "src", "repl", "extensions"]`.** `src/` is required because
  `extensions/repl-extension.ts` imports `../src/*.js` and pi loads it via jiti. (Recorded deviation
  from #81's literal list — see SPEC AS3.)
- **D4 — Guarded preamble read.** A missing `repl_server.py` throws an error naming the path and the
  likely cause, never a bare ENOENT.
- **D5 — Manifest.** `main: "dist/index.js"`, `types: "dist/index.d.ts"`, `exports` map,
  `license: "MIT"`, drop `private: true`, add `prepublishOnly: "npm run build"`.
- **D6 — Attribution resolved by investigation.** Credit upstream (`pi-reepl`/`pi-code-tool`,
  `ivanvza`) + RLM whitepaper in `LICENSE`/`NOTICE`, or record the claim as unfounded with evidence.

## Task List

### Phase 1: Usable build output (#80)

- [ ] **Task 1** — Make `npm run build` emit a flat `dist/`; guard the preamble read.
  - `rootDir: "src"`; drop `test/` from the build `include`; `getReplPreamble()` guarded; wire
    `prepublishOnly`. Tests: `dist/index.js` (not `dist/src/index.js`); no test files in `dist/`;
    `getReplPreamble()` works against the built artifact; missing file → clear error naming the path.
  - Files: `tsconfig.build.json`, `src/preamble.ts`, `package.json`, `test/packaging.test.ts` (new),
    `test/preamble.test.ts` (extend). Depends on: None.

### Checkpoint: after Task 1
- [ ] `npm run build` emits `dist/index.js` + `dist/index.d.ts` with no `dist/src/` or `dist/test/`;
      preamble resolves in-tree and from the build; gates green.

### Phase 2: Publishable manifest (#81)

- [ ] **Task 2** — Add `main`/`types`/`exports`/`files`/`license`; drop `private`; delete
  `plan-issue-9.md`.
  - Tests: `npm pack` ships `dist/`/`src/`/`repl/`/`extensions/`/`LICENSE` and no `test/`, `docs/`,
    `plan-issue-9.md`; scratch consumer imports `ReplRunner` + calls `getReplPreamble()` (offline);
    every `src/index.ts` export reachable from the packed artifact; `engines` matches `.nvmrc`.
  - Files: `package.json`, delete `plan-issue-9.md`, `test/packaging.test.ts` (extend). Depends on: 1.

### Checkpoint: after Task 2
- [ ] Scratch consumer `import { ReplRunner } from "repl-simple"` + `getReplPreamble()` succeed
      against the packed tarball, offline; tarball is clean; gates green.

### Phase 3: README truth + attribution (#82)

- [ ] **Task 3** — Make the README truthful; resolve attribution.
  - Fix the README rows (tool list, sandbox limits, import example now real, `pi.extensions`
    auto-load wording); document the sandbox's real capabilities/limits; add upstream attribution to
    `LICENSE`/`NOTICE` and credit the RLM whitepaper (or record the claim as unfounded with evidence).
  - Tests: every README code sample executes; README tool list matches registered tools; `npm pack`
    includes `LICENSE`/`NOTICE`.
  - Files: `README.md`, `LICENSE` (+ `NOTICE` if added), `test/readme.test.ts` (new). Depends on: 2.

### Checkpoint: complete
- [ ] All three tasks landed; full suite + coverage floors green; ready for VERIFY / REVIEW / SHIP.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Scratch-consumer test hits the registry | High (breaks offline CI) | Reuse repo `node_modules`/npm cache; never fetch (SPEC AS6) |
| `files` without `src/` breaks the jiti extension path | High | D3 ships `src/`; extension-loader test stays green |
| `rootDir: "src"` breaks an extension/test import | Med | Only the *build* config narrows; `tsconfig.json` still checks everything |
| `npm pack` includes stray files via auto-include | Low | README/LICENSE auto-include is desired; assert the *absence* of test/docs/plans |
| Attribution claim is unfounded | Low | D6: record as unfounded with evidence rather than invent credit |
| `prepublishOnly` slows/breaks other flows | Low | It only fires on `npm publish`/`npm pack` (prepack), not `npm test`/`build` |

## Open Questions

None — recorded as SPEC assumptions AS0–AS7.
