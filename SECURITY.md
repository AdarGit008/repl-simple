# Security policy

## Supported versions

Fixes land on `main`, and only `main` is supported. Install from it as the
[README](README.md#install) describes. `v0.1.0`, the only tag so far, ships a skill whose
frontmatter does not parse.

## Reporting a vulnerability

Do not put vulnerability details in a public issue or pull request.

GitHub's private vulnerability reporting is not enabled on this repository yet. Until it is:

1. Open an issue titled **"Security contact request"** with no technical details.
2. The maintainer opens a draft GitHub security advisory, adds you to it, and you share the details
   there.

## What is in scope

The boundaries the package promises are listed in the README's
[Security model](README.md#security-model). A report is in scope when one of them fails:

- **Sandbox:** Python running in the Monty worker spawns a process, opens a socket, or reads a host
  file other than through the host tools.
- **Path jail:** `read`, `grep`, `find`, `ls`, `read_file` or `list_files` reaches a path outside
  the project root. See [docs/path-jail.md](docs/path-jail.md).
- **Approvals:** in strict mode, `bash`, `edit`, `write`, `save_tool` or an `http_get` with no
  `REPL_HTTP_ALLOWLIST` runs without an approval, one approval covers more than one execution, or a
  gated call runs in a session with no UI. See [docs/approval-grants.md](docs/approval-grants.md).
- **Network egress:** `http_get` reaches a host outside `REPL_HTTP_ALLOWLIST` while it is set, or a
  private, loopback or link-local address. See [docs/http-egress.md](docs/http-egress.md).
- **`bash` environment:** a withheld variable reaches a `bash` command. See
  [docs/bash-env.md](docs/bash-env.md).
- **Saved tools:** a `.pi/code-tools` file runs in an untrusted project, or before it is approved.
  See [docs/project-trust.md](docs/project-trust.md).
- **`rlm`:** the loop runs `bash`, `edit`, `write` or `http_get`.
- **Redaction:** a secret reaches the pi session file through a tool trace. See
  [docs/redaction.md](docs/redaction.md).

## What is out of scope

- What an approved call does, and anything that runs while `/repl-approvals yolo` is on.
- pi itself, including its built-in tools and project trust. Report those to
  [pi](https://github.com/earendil-works/pi).
- Bugs in `@pydantic/monty` itself. Report them to [pydantic/monty](https://github.com/pydantic/monty),
  and tell us as well if one breaks a boundary above.
- Whether an `rlm` answer is correct (every answer is labelled untrusted), and what the model you
  route `rlm` to does with the data it receives.
- Alpine/musl and other platforms without a `@pydantic/monty` binary.
