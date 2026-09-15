# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Skill:** `skills/repl-simple/SKILL.md` quotes its YAML `description`, so the frontmatter parses
  and pi loads the skill. At v0.1.0 it fails with "Nested mappings are not allowed in compact
  mappings". ([#224])
- **`rlm`:** multi-turn loops no longer return an empty answer. Earlier assistant replies are sent
  back as text blocks, so a task that needs more than one iteration converges. ([#225])
- **`rlm`:** the loop's Python rules tell the model that `open()`, `os.listdir()` and `pathlib`
  cannot read project files, so it uses the read tools instead. ([#225])

### Added

- **`rlm` tool and `/rlm` command:** the run trace is kept on the result's `details`. It holds the
  question, then each iteration's code, stdout, output or error and model reply, then the budget,
  with each field redacted and cut at 1024 bytes. ([#227])
- **`rlm` tool:** an empty or whitespace question is refused, as `/rlm` already did. ([#227])

### Changed

- **`rlm`:** a failed result with an empty answer says "(no answer reached)" instead of reporting a
  blank partial answer. ([#227])
- **Docs:**
  - The skill states that the sandbox has no filesystem of its own. ([#226])
  - The README covers install through `pi install`, prerequisites, a quickstart, a security model
    and every environment variable.
  - Development notes moved to CONTRIBUTING.md. SECURITY.md and this changelog were added.
  - LICENSE is now the plain MIT text; attribution stays in NOTICE.
  - Planning and process reports moved to a separate repository.

## [0.1.0] - 2026-09-14

The first release: a pi package that adds a sandboxed Python REPL and the RLM investigation loop.

### Added

- **REPL tools:** `repl`, `repl_resume`, `repl_reset` and `repl_abandon`.
  - Persistent Python sessions on `@pydantic/monty` 0.0.23, in a pool of crash-isolated worker
    subprocesses.
  - Default limits on compute time, memory, host crossings and wall clock.
  - A session pool capped at 32 with LRU eviction.
- **Host tools inside Python:**
  - pi's `read`, `grep`, `find` and `ls`, jailed to the project root.
  - `bash`, `edit` and `write`, gated by approval.
  - `read_file`, `list_files` and `http_get`.
  - The saved-tool store: `save_tool`, `delete_tool`, `list_saved_tools` and `read_tool`.
- **Approvals:**
  - One approval covers one execution.
  - Four answers: approve, deny, decide later and deny remaining.
  - At most 8 dialogs per call, and an unanswered dialog denies itself after 5 minutes.
  - `/repl-approvals strict|yolo` switches the mode.
- **`bash` environment:** an allowlist, extended with `REPL_BASH_ENV_ALLOW`.
- **`http_get` egress:**
  - A fetch needs approval unless its host is on `REPL_HTTP_ALLOWLIST`.
  - Private, loopback and link-local addresses are refused on every redirect hop.
  - DNS-rebinding hardening.
- **Saved tools:** `.pi/code-tools` loads only in a pi-trusted project and only after approval,
  tracked in a sha256 manifest. `/repl-accept-preamble` accepts the current set.
- **Tool trace:** each result's `details` lists the calls, with redacted arguments.
- **RLM loop:** `runRlm`, exposed as the `rlm` tool and the `/rlm` and `/rlm-abort` commands.
  - The sandbox is read-only.
  - Spend is bounded by a shared budget (`REPL_RLM_BUDGET`, default 500 000 estimated tokens).
  - Each result reports where its answer came from (`answerSource`) and is marked untrusted.
- **Skill:** the `repl-simple` skill ships from the package through `pi.skills`.
- **Library API:** `ReplRunner`, `runRlm`, `runInSandbox` and the rest of `src/index.ts`, built to
  `dist/`.

### Known issues

- The `skills/repl-simple/SKILL.md` frontmatter does not parse, so pi does not load the skill.
  Fixed on `main` ([#224]).

[Unreleased]: https://github.com/AdarGit008/repl-simple/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AdarGit008/repl-simple/releases/tag/v0.1.0
[#224]: https://github.com/AdarGit008/repl-simple/pull/224
[#225]: https://github.com/AdarGit008/repl-simple/pull/225
[#226]: https://github.com/AdarGit008/repl-simple/pull/226
[#227]: https://github.com/AdarGit008/repl-simple/pull/227
