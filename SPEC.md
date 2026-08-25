# Spec: Bucket 10 — Packaging and consumability (issues #79, #80, #81, #82)

## Objective

Make `repl-simple` installable and consumable. Today **nobody can install it**: `npm pack`
ships 36 entries (all source + all tests + planning/review docs) and **no `dist/`**; `package.json`
is `private: true` with `main`/`types`/`exports`/`files`/`license` all absent; `npx tsc` emits
`dist/src/` and `dist/test/` instead of a flat `dist/`; `repl/*.py` is never copied; and the README
documents an `import … from "repl-simple"` that cannot resolve. The legal attribution for prior
work is also missing.

This is the "consumable" bucket (epic #79). Success means: a scratch consumer can
`import { ReplRunner } from "repl-simple"` and call `getReplPreamble()` against the **built
artifact**; `npm pack` ships `dist/` and ships **no** tests, plans, or review docs; every README
code sample runs; and the upstream work this project derives from is credited.

## Tech Stack

- TypeScript (Node >= 22.19.0), NodeNext modules, strict mode.
- Test runner: `node:test` via `tsx --test`.
- Packaging: `npm pack` / `npm install <tgz>` (no publish in this run).
- No new dependencies. (Adding one is a flag — see Boundaries.)

## Current state (measured at HEAD `858d8df`)

- `package.json`: `name: "repl-simple"`, `version: "0.1.0"`, `private: true`, `type: "module"`,
  `description`, `keywords: ["pi-package"]`, `scripts` (test/check/build/lint/coverage/mutation),
  **`engines.node: ">=22.19.0"`** (already matches `.nvmrc`), **`pi.extensions` already points at the
  file** `"./extensions/repl-extension.ts"` (A39 done), `dependencies: { "@pydantic/monty": "0.0.21" }`.
  Missing: `main`, `types`, `exports`, `files`, `license`.
- `tsconfig.json` (the *check* config, per #21): `include: ["src", "test", "extensions"]`,
  `noEmit: true`, `outDir: "dist"`, `declaration: true`. Covers everything the compiler should see.
- `tsconfig.build.json` (the *emit* config): `extends ./tsconfig.json`, `noEmit: false`,
  `include: ["src/**/*.ts", "test/**/*.ts"]` — **no `rootDir`, includes `test/`**. Emits
  `dist/src/` + `dist/test/` (the #80 defect). `extensions/` is deliberately checked but not
  emitted (pi loads the `.ts` via jiti).
- `src/preamble.ts` `getReplPreamble()`: `join(__dirname, "..", "repl", "repl_server.py")` via an
  **unguarded** `readFileSync`. In the source tree this resolves `<repo>/repl/repl_server.py`; in the
  current broken build (`dist/src/preamble.js`) it resolves `dist/repl/repl_server.py` → **ENOENT**.
- `repl/repl_server.py` exists (single file). `extensions/repl-extension.ts` imports
  `../src/repl.js`, `../src/sandbox.js`, `../src/types.js` (plus `typebox` and
  `@earendil-works/pi-coding-agent`) — so the **extension's jiti import graph requires `src/` to ship**.
- Root: `plan-issue-9.md` (delete, per #81), `LICENSE` (MIT, single author "AdarGit008"),
  `README.md` (26 KB), `docs/` (REVIEW.md etc. — must stay out of the tarball).

## Commands

```
Install:  npm ci
Test:     npm test                        # tsx --test test/*.test.ts
Focused:  npx tsx --test test/packaging.test.ts
Type:     npm run check                   # tsc --noEmit            (tsconfig.json)
Build:    npm run build                   # tsc -p tsconfig.build.json  (+ preamble verification)
Pack:     npm pack --dry-run
Lint:     npm run lint                    # biome check --error-on-warnings
Coverage: npm run coverage                # per-file floors
```

## Project Structure

```
package.json            → manifest: main/types/exports/files/license, prepublishOnly, private removed
tsconfig.json           → check config (src + test + extensions) — unchanged semantics
tsconfig.build.json     → emit config: rootDir "src", include src only
src/                    → library source (ships via files, for the extension's jiti graph)
src/preamble.ts         → guarded getReplPreamble()
repl/repl_server.py     → preamble asset (ships at package root)
extensions/             → pi extension (ships; imports ../src/*.js)
test/packaging.test.ts  → build-output, tarball-content, scratch-consumer import, export-reachability
test/readme.test.ts     → README code-sample execution + tool-list match (or equivalent)
README.md               → made truthful
LICENSE (+ NOTICE?)     → upstream attribution + RLM whitepaper credit
```

## Design Decisions

- **D1 — `rootDir: "src"`, build includes `src` only.** `tsconfig.build.json` sets
  `rootDir: "src"` and drops `test/**/*.ts` from `include`, so `dist/` mirrors `src/`:
  `dist/index.js`, `dist/index.d.ts`, `dist/preamble.js`, … (no `dist/src/`, no `dist/test/`).
  This follows the #21 split exactly: `tsconfig.json` keeps checking `test/` and `extensions/`;
  only the emit narrows.
- **D2 — Preamble ships at package root; no `dist/repl` copy.** Keep
  `getReplPreamble()` resolving `join(__dirname, "..", "repl", "repl_server.py")`. With D1,
  `__dirname` is `<pkg>/dist/`, so this resolves `<pkg>/repl/repl_server.py` — identical to the
  source-tree resolution. `files` ships `repl/`, so the asset is present at the exact path the
  function resolves. (#80's "copy `repl/*.py` into the output tree" is satisfied by shipping `repl/`
  in the package; a redundant `dist/repl/` copy is deliberately rejected as a second source of truth.)
- **D3 — `files: ["dist", "src", "repl", "extensions"]`.** Ships the compiled library (`dist`),
  the source (`src`, required because `extensions/repl-extension.ts` imports `../src/*.js` and pi
  loads it via jiti), the preamble asset (`repl`), and the extension (`extensions`). This is a
  recorded deviation from #81's literal `["dist", "repl", "extensions"]`: without `src` the
  pi-extension path breaks. Tests, docs, plans are excluded by the `files` allowlist.
- **D4 — Guarded preamble read.** `getReplPreamble()` wraps `readFileSync` so a missing file throws
  an error naming the expected path and the likely cause (package mis-assembled), never a bare ENOENT.
- **D5 — Manifest.** Add `main: "dist/index.js"`, `types: "dist/index.d.ts"`, and an `exports` map
  (`"."` → import/types) so the public surface is explicit. Add `license: "MIT"`. Remove
  `private: true`. Add `prepublishOnly: "npm run build"` so a publish cannot ship a stale/absent
  `dist/`. `engines` and `pi.extensions` are already correct — do not regress them.
- **D6 — Attribution resolved by investigation, not guesswork.** The review asserts this project
  derives from prior work (`pi-reepl` / `pi-code-tool`, author `ivanvza`) and that the RLM design
  follows a whitepaper. The coder investigates, then either (a) adds the upstream attribution to
  `LICENSE`/`NOTICE` and credits the RLM whitepaper, or (b) records the claim as unfounded with
  evidence. Either way the question ends with a definite, sourced answer.

## Code Style

Follow existing conventions: small pure helpers, explicit types, JSDoc on exported symbols. No new
abstractions unless they earn their complexity. Config files stay JSON. Example guard shape:

```typescript
export function getReplPreamble(): string {
  try {
    return readFileSync(REPL_PREAMBLE_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `repl_server.py preamble missing at "${REPL_PREAMBLE_PATH}". ` +
        `The package was built without its Python preamble (repl/) — reinstall or rebuild.`,
      { cause: err },
    );
  }
}
```

## Testing Strategy

Unit/integration tests in `test/`, `node:test` via `tsx --test`. No real network in the packaging
test (offline: reuse the repo's installed `node_modules` for dependency resolution — never fetch).

- **Build output** — after `npm run build`: `dist/index.js` exists (not `dist/src/index.js`);
  `dist/` contains **no** `test/` and no `.test.` files.
- **Preamble** — `getReplPreamble()` returns the preamble against the **built** artifact (not just
  in-tree); a missing file produces a clear error naming the path, not an ENOENT trace.
- **Tarball contents** — `npm pack --dry-run` (or pack + list) contains `dist/`, `repl/`,
  `src/`, `extensions/`, `LICENSE`; contains **no** `test/`, `plan-issue-9.md`, or `docs/`.
- **Scratch consumer** — pack the tarball, install/extract into a temp dir, then
  `import { ReplRunner } from "repl-simple"` and call `getReplPreamble()` successfully (transcript
  captured in the report). Offline.
- **Export reachability** — every symbol `src/index.ts` exports is reachable from the packed
  artifact (loop over the export list so a new export cannot silently become unreachable).
- **README** — every code sample in `README.md` executes (extract the `import … from "repl-simple"`
  block and the documented API calls; run them). The README's tool list matches the tools that
  actually register (assert against the same source the smoke/extension-loader test uses).
- **Attribution** — `npm pack` includes `LICENSE` and any `NOTICE`.

RED → GREEN: each new test must fail at HEAD and pass after the fix. All runs offline.

## Boundaries

- **Always:** RED→GREEN per task; run `npm test`, `npm run check`, `npm run build`, `npm run lint`,
  and `npm run coverage` after each change; keep `.nvmrc`↔`engines` in agreement; keep the
  extension-loader test green (the jiti path must not break); `files` must never ship tests/docs/plans.
- **Ask first:** adding dependencies; changing CI config; publishing to npm. (In this autonomous run,
  a genuinely-required new dependency is a NO-GO flag for Phase 6, not something to silently add.)
- **Never:** commit secrets; publish the package; regress `pi.extensions` (must stay a file path);
  remove failing tests to make the suite pass; weaken `engines` below `.nvmrc`.

## Success Criteria

1. A scratch consumer can `import { ReplRunner } from "repl-simple"` against the **packed artifact**
   and call `getReplPreamble()` successfully (offline, transcript captured).
2. `npm pack` ships `dist/` (plus `src/`, `repl/`, `extensions/`, `LICENSE`) and ships **no** `test/`,
   `plan-issue-9.md`, or `docs/`.
3. `npm run build` produces a flat `dist/` (`dist/index.js`, `dist/index.d.ts`; no `dist/src/`, no
   `dist/test/`).
4. Every code sample in the README runs; the README's tool list matches the registered tools; the
   sandbox's real capabilities/limits are documented.
5. The attribution question is resolved with a definite, sourced answer (credit added, or the
   derivation claim investigated and recorded as unfounded).
6. `prepublishOnly` runs the build; `plan-issue-9.md` is deleted.
7. Full suite green: `npm test`, `npm run check`, `npm run build`, `npm run lint`, `npm run coverage`.

## Assumptions (recorded — autonomous run)

- **AS0** — Base is up-to-date `main` (`858d8df`); work happens on a fresh branch.
- **AS1** — `engines` and `pi.extensions` are already correct in `package.json`; they are not part of
  this flight's diff beyond being preserved.
- **AS2** — The #21 config split is settled (check = `tsconfig.json`, emit = `tsconfig.build.json`);
  D1 follows it and does not reopen the one-config-vs-two debate.
- **AS3** — `files` includes `src/` (deviation from #81's literal list) because the pi-extension path
  imports `../src/*.js`; shipping without `src/` would break `pi package add` extension loading.
- **AS4** — No actual `npm publish` in this run; `private: true` is removed and `prepublishOnly`
  wired, but the publish itself is out of scope.
- **AS5** — The README "every sample runs" obligation is bounded to the documented API/import samples
  (the `import … from "repl-simple"` block and the named API calls), not prose-only shell one-liners
  that document optional dev tooling.
- **AS6** — The packaging test is offline: dependency resolution reuses the repo's installed
  `node_modules` (or npm cache); it never fetches from the registry.
- **AS7** — No new dependency. The scratch-consumer test may reuse `npm`/`tar` tooling already present;
  it must not add a runtime dependency.
