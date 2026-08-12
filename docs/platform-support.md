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
| `0.0.18` (current) | `darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, `win32-x64-msvc`, `wasm32-wasi` |
| `0.0.21` (latest) | `darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, `win32-x64-msvc` |

The failure mode is the expensive one: **`npm install` succeeds and the module fails at load.** All
platform binaries are `optionalDependencies`, so npm silently skips every one that does not match the
host and exits 0.

The WASI package is not an escape hatch. `@pydantic/monty-wasm32-wasi` is declared `"cpu": ["wasm32"]`,
so npm skips it on an x64 or arm64 host — the napi loader's WASI fallback has nothing to fall back to.
And `0.0.21` dropped the WASI package entirely.

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
