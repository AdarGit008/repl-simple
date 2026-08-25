# Todo — Bucket 10: Packaging and consumability (issues #79–#82)

Source of truth: `SPEC.md` + `tasks/plan.md`. One item = one coder dispatch = one orchestrator commit.
Order is fixed: Task 1 → Task 2 → Task 3.

- [x] **Task 1 — Make the build emit a usable dist/ (#80)**
  - [x] RED — `test/packaging.test.ts`: `npm run build` produces `dist/index.js` (not
        `dist/src/index.js`); `dist/` contains no test files; `getReplPreamble()` works against the
        built artifact; a missing preamble file yields a clear error naming the path, not an ENOENT.
        Fails at HEAD.
  - [x] GREEN — `tsconfig.build.json`: `rootDir: "src"`, `include` drops `test/`. `src/preamble.ts`:
        guarded `readFileSync` with a path-naming error. `package.json`: `prepublishOnly` runs the build.
  - [x] `npm test` + `check` + `build` + `lint` clean.
  - [x] Files — `tsconfig.build.json`, `src/preamble.ts`, `package.json`, `test/packaging.test.ts` (new),
    `test/preamble.test.ts` (extend).
  - Depends on: None.

- [x] **Task 2 — Publishable manifest; stop shipping tests and docs (#81)**
  - [x] RED — `test/packaging.test.ts`: `npm pack` ships `dist/`/`src/`/`repl/`/`extensions/`/`LICENSE`
        and no `test/`/`docs/`/`plan-issue-9.md`; scratch consumer `import { ReplRunner } from
        "repl-simple"` + `getReplPreamble()` succeed (offline); every `src/index.ts` export is reachable
        from the packed artifact; `engines` matches `.nvmrc`. Fails at HEAD.
  - [x] GREEN — `package.json`: `main`/`types`/`exports`/`files`/`license` added; `private` removed.
        Delete `plan-issue-9.md`.
  - [x] `npm test` + `check` + `build` + `lint` clean.
  - Files — `package.json`, delete `plan-issue-9.md`, `test/packaging.test.ts` (extend).
  - Depends on: Task 1.

- [x] **Task 3 — Make the README true; add the missing attribution (#82)**
  - [x] RED — `test/readme.test.ts`: every README code sample executes; the README tool list matches
        the tools that actually register; `npm pack` includes `LICENSE` and any `NOTICE`. Fails at HEAD.
  - [x] GREEN — `README.md` corrected (tool list, sandbox limits, import example, `pi.extensions`
        wording); upstream attribution added to `LICENSE`/`NOTICE` + RLM whitepaper credited, or the
        derivation claim recorded as unfounded with evidence.
  - [x] `npm test` + `check` + `build` + `lint` clean.
  - [x] Files — `README.md`, `LICENSE` (+ `NOTICE` if added), `test/readme.test.ts` (new).
  - Depends on: Task 2.
