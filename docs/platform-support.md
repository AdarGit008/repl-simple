# Platform support

## Node

`engines` requires Node **>= 22.19.0**, inherited from `@earendil-works/pi-coding-agent@0.84.1`.
`.nvmrc` pins 22.19.0 — the floor, so local development exercises the oldest supported runtime.

CI runs Node 22 and 24 on `ubuntu-latest` and `macos-latest`. The matrix is not ceremony:
`@pydantic/monty` ships a separate prebuilt native binary per platform, so a green run on one leg is
no evidence about the others.

## `@pydantic/monty` does not work on Alpine / musl

**There is no musl build of `@pydantic/monty` at any published version** (checked through `0.0.21`).
The published platform packages are:

| Version | Platform packages |
|---|---|
| `0.0.18` (previous) | `darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, `win32-x64-msvc`, `wasm32-wasi` |
| `0.0.21` (current) | `darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, `win32-x64-msvc` |

`platformTriple()` hard-codes `linux-${arch}-gnu`, so there is not even a triple for npm to miss.

The failure mode is the expensive one: **`npm install` succeeds and the module fails at load.** All
platform binaries are `optionalDependencies`, so npm silently skips every one that does not match the
host and exits 0.

The WASI package is not an escape hatch. `@pydantic/monty-wasm32-wasi` is declared `"cpu": ["wasm32"]`,
so npm skips it on an x64 or arm64 host — the napi loader's WASI fallback has nothing to fall back to.
And `0.0.21` dropped the WASI package entirely.

### The `0.0.21` wasm entry is a trap, not a replacement

`0.0.21` bundles a wasm runtime reachable at `@pydantic/monty/wasm`, and it is the more dangerous
shape of the same gap, because **it runs**.

It does not work out of the box: it imports `@bjorn3/browser_wasi_shim`, which `0.0.21` declares only
in `devDependencies`, so the import fails with `ERR_MODULE_NOT_FOUND` until you install that package
yourself. Do that and `feedRun('2 + 3')` returns `5`, which looks like an Alpine story.

It is not one. On Node the wasm entry selects an **in-process** factory — there is no worker
subprocess at all. Measured on it: `session.workerPid` is `undefined`; `while True: pass` under a 1 s
budget fires **0** host timer ticks against 9 on the native path; and with no `maxDurationSecs` set,
the same loop wedges the host permanently and needs a SIGKILL. That is precisely the `0.0.18` failure
mode this project migrated away from, so the wasm entry would forfeit crash isolation, event-loop
survival and the host backstop in one step, while appearing to work.

Every result here is glibc x64 on Node 24; no container runtime was used, so actual Alpine behaviour
is inferred rather than measured. `src/` therefore imports `@pydantic/monty/node` explicitly rather
than the package root, so this path cannot be selected by accident.

Reproduced on `node:22-alpine`:

```console
$ npm install @pydantic/monty@0.0.18
added 1 package, and audited 2 packages in 2s
found 0 vulnerabilities                          # exit 0 — nothing to see

$ node -e 'import("@pydantic/monty")'
Cannot find native binding. npm has a bug related to optional dependencies
(https://github.com/npm/cli/issues/4828). Please try `npm i` again after
removing both package-lock.json and node_modules directory.
```

The error text sends you after a phantom npm bug. Removing `node_modules` and reinstalling will not
help, because the binary you need was never published.

**Use a glibc base image** — `node:22`, `node:22-slim`, `node:22-bookworm`, or Debian/Ubuntu with a
system Node. There is no workaround on Alpine short of building Monty from source.
