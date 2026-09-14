---
name: repl-simple
description: Sandboxed Python REPL (repl-simple extension): persistent sessions via repl, repl_resume, repl_reset, repl_abandon; in-sandbox tools read/grep/find/ls/bash/edit/write, read_file/list_files/http_get, save_tool/delete_tool/list_saved_tools/read_tool; Monty/WASM limits (fixed stdlib, no subprocess/socket/yield/match/inheritance); approvals (/repl-approvals, /repl-accept-preamble, decide-later); saved-tool preamble (.pi/code-tools, project trust); rlm tool + /rlm command (autonomous read-only code-gen → execute loop). Load to run Python or reason about sandbox limits/approvals. Prefer rlm for code-scouting and ambiguous questions; rlm never mutates the repo, output untrusted.
---

# repl-simple

Sandboxed Python execution in pi via [Monty](https://github.com/pydantic/monty) — Python-in-WebAssembly. No host Python, no third-party packages, no subprocess or sockets.

## The four tools

| Tool | Purpose |
|------|---------|
| `repl(code, sessionId?, maxDurationSecs?, maxMemory?)` | Execute Python. Variables/imports persist per `sessionId`. Default session is `"default"`. |
| `repl_resume(sessionId?)` | Resume a session suspended by a "decide later" approval. Asks the dialog again. |
| `repl_reset(sessionId?)` | Clear all state (variables, imports, tool-call cache) and remove the session from the pool. |
| `repl_abandon(sessionId?)` | Discard a pending approval; the suspended code is dropped, the session lives on. |

- `maxDurationSecs`: interpreter compute seconds, default 30, cap 300.
- `maxMemory`: sandbox heap MiB, default 512, cap 1024.
- A `repl` or `repl_resume` call opens at most **8 approval dialogs**; gated calls past that are denied and the result says so.
- Running new `repl` code while a call is suspended discards that call — `repl_resume` first if you still want it.
- Sessions are scoped to one pi conversation: `/new`, `/resume`, `/fork`, or quit disposes every session and drops pending approvals. The same `sessionId` next conversation is a fresh, empty REPL.

## RLM (auto-investigation)

`rlm` is an autonomous code-gen → execute loop: the model writes Python, the sandbox runs it, and the results feed back until `SUBMIT(answer)`. Two handles on the same loop:

- **`rlm` tool** — the agent's handle. Call with `question` (required) plus optional `maxIterations`, `maxDepth`, `budget`, `model`/`provider`.
- **`/rlm <question>`** — the user's handle. Runs the loop detached — the prompt returns immediately and the formatted result is posted into the transcript when it lands. One run at a time; a second `/rlm` while one is running is refused.
- **`/rlm-abort`** — stops the in-flight `/rlm` run.

The loop's sandbox is **read-only**: the mutating bridge tools (`bash`, `edit`, `write`) and `http_get` are denied, so it reads and reasons over the repo but never changes it. Each call is a multi-LLM-call loop with real cost, bounded by `REPL_RLM_BUDGET` (default 500 000 estimated tokens).

The answer is **untrusted** — the inner model's own output, not a verified result. Treat it as a hypothesis to check. Every result carries a `status` (`ok` / `max_iterations` / `budget_exhausted` / `aborted` / `error`) and an `answerSource` (`submitted` / `salvaged` / `synthesised`).

**Use `rlm` for:**
- Big code-scouting tasks — mapping a subsystem, tracing a request or data path end-to-end, locating where a behaviour lives across many files, or any "how does X work here" question that needs several read-and-reason steps.
- Ambiguous or fuzzy questions — where a one-shot answer is likely wrong and an iterative form-a-guess → run → refine loop is the right tool.

**Not for:** quick lookups (use `read`/`grep`), edits (mutations are denied), or anything that must be a verified fact (output is untrusted).

## What Python can do

**Importable modules** — exactly these (verified against Monty 0.0.23):

`os`, `sys`, `json`, `re`, `datetime`, `math`, `typing`, `pathlib`, `asyncio`, `collections`, `itertools`, `functools`, `base64`, `dataclasses`

Anything else (`time`, `random`, `subprocess`, `socket`, `hashlib`, `requests`, `numpy`, …) is refused as an unresolved import **before any code runs**.

**Language limits** (raise `NotImplementedError`):
- `yield` (no generators)
- `match` statements (no pattern matching)
- class inheritance / metaclasses (`class B(A)` fails; a plain `class` with methods works)

**Return values** cross to the host as data, with nesting caps: a list ~48 levels deep or a class instance ~24 deep is fine, one more fails the whole run with `RuntimeError: Max output depth exceeded` (after side effects). Instances cross **without their methods** — `__repr__` is not called, so end a snippet on `repr(obj)` to see a useful value.

## Python-side tools (callable inside `repl` code)

**Pi bridge** (host tools, jailed): `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`
- The read tools (`read`, `grep`, `find`, `ls`) are confined to the project root. Absolute paths outside it, `..` traversal, and symlinks that leave the tree are refused.
- `bash` runs with an **allowlisted environment** (PATH, HOME, locale, toolchain paths — everything else like `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK`, `npm_config_*`, `PI_*` is withheld). `REPL_BASH_ENV_ALLOW` passes named vars; `'*'` disables the filter.
- `bash`, `edit`, `write` are gated (ask approval) in strict mode.

**Builtins**: `read_file`, `list_files`, `http_get`
- `http_get` is the only network path out. With `REPL_HTTP_ALLOWLIST` set, listed hosts fetch without a prompt; otherwise every fetch asks. Private/loopback/link-local destinations are always refused.

**Tool store**: `save_tool`, `delete_tool`, `list_saved_tools`, `read_tool`
- Saved tools are `.py` files under `.pi/code-tools/`, executed **before** your code on every `repl` call (the "preamble").
- They load only in a **trusted** project, and only once **approved** (sha256 manifest under `$XDG_STATE_HOME/repl-simple` or `REPL_PREAMBLE_STORE_DIR`). Preamble is capped at 32 files / 64 KiB.
- `list_saved_tools` annotates names not loaded; `read_tool` refuses to read an untrusted project's files; `save_tool` is approval-gated (what it writes auto-runs in future sessions); `delete_tool` stops new sessions from loading it (current session keeps its copy).

## Approvals

- **Default is strict**: `bash`, `edit`, `write`, and ungated `http_get`/`save_tool` ask before running. An approval covers **one execution**.
- `/repl-approvals yolo` disables the gate for the rest of the pi process; `/repl-approvals strict` (or restart) restores it. `repl_reset` reports the current mode.
- Every dialog offers four answers: **approve**, **deny**, **decide later** (suspends the session → `repl_resume`/`repl_abandon`), **deny remaining** (denies this and all later gated calls in the call). Escape / timeout / abort = deny.
- `/repl-accept-preamble` accepts the whole current `.pi/code-tools` set as-is.

## Practical guidance

- Prefer a **named session** when you'll need the result later; use `"default"` otherwise.
- The sandbox is for **pure computation and reading project files**. Use `bash` (gated) only when a read tool can't reach a real, justified need outside the jail.
- Treat every snippet as self-contained unless you're relying on persisted state — and remember state is per-conversation, not durable.
- Don't retry a gated call that was denied by the cap: the result names what was withheld; ask the user instead.
- When a call suspends, resolve it with `repl_resume` (ask again) or `repl_abandon` (drop it) before running new code, or the pending call is silently discarded.

## Maintainers

The extension lives in the `repl-simple` package (`../../extensions/repl-extension.ts`). Full reference: `../../README.md`, `../../docs/project-trust.md`, `../../docs/approval-grants.md`, `../../docs/path-jail.md`, `../../docs/bash-env.md`, `../../docs/http-egress.md`, `../../docs/truncation-policy.md`.
