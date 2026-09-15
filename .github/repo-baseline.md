# Repo baseline for agent skills and tools

The shared checklist this repo is aligned against. It was derived from a survey of popular agent skill and tool repos (verified 2026-09-15). **M** = near-universal among top repos or required by a spec; **S** = best practice. Each row cites one verbatim quote and its source.

Alignment status for this repo lives in the pull request that introduced this file and in follow-up PRs; this file holds only the standard.

## Front page

| ID | Tier | Criterion | How to check |
|---|---|---|---|
| S01 | M | GitHub description and topics are set | `gh repo view --json description,repositoryTopics` |
| S02 | S | README first screen says what it is, why it matters and who it is for | Read README lines 1-30 |
| S03 | S | README shows a demo, screenshot or sample output | Look for an image or an example call with its output |

## Install and first run

| ID | Tier | Criterion | How to check |
|---|---|---|---|
| S04 | M | A documented one-command install works (package runner or marketplace, not a clone) | Follow the install section literally in a clean environment |
| S05 | M | Prerequisites are listed before the install steps | Runtime versions, services, accounts named above step 1 |
| S06 | S | A new user reaches a first success from the docs alone | A verify-it-works step or first example |
| S07 | S | Release tag, docs and installed copy match | Latest tag has the commands the docs describe |
| S08 | M | Listed on a registry or marketplace | PyPI / npm / plugin marketplace / `npx skills add` |

## Agent-facing surface

| ID | Tier | Criterion | How to check |
|---|---|---|---|
| S09 | M | SKILL.md frontmatter parses; description says what the skill does and when to use it | Parse with a YAML parser; look for a when-to-use clause |
| S10 | S | SKILL.md is lean (under 500 lines) with detail in `references/` | `wc -l SKILL.md` |
| S11 | S | The skill folder is self-contained and says how to get its binary | Copy the folder alone; can an agent install the CLI from it? |
| S12 | S | Works in more than one harness | Claude Code, pi, Codex, Cursor, `.agents/skills` |
| S13 | S | Output an agent can parse, with defined exit states | Documented exit codes or structured output |

## Repo layout

| ID | Tier | Criterion | How to check |
|---|---|---|---|
| S14 | S | The product is visible at root; no plans, logs or research data | Root listing |
| S15 | S | One canonical home | No stale mirror or twin repo without a pointer |

## Trust

| ID | Tier | Criterion | How to check |
|---|---|---|---|
| S16 | S | Side effects, data egress and cost are declared | One README block: what it writes, what leaves the machine, how to turn it off |
| S17 | M | LICENSE is recognized by GitHub | `gh api repos/O/R --jq .license.spdx_id` |
| S18 | S | CHANGELOG and written release notes | CHANGELOG.md at root; release notes that are not raw PR titles |
| S19 | S | SECURITY.md at root | File exists at root or .github/ |
| S20 | S | CI is green and shown on the front page | Latest main run succeeded; README badge |
| S21 | S | Docs are generated from code or tested against it | A docgen check or docs test in CI |
| S22 | S | Evals of skill behaviour or result quality | Trigger evals (`claude plugin eval`) or quality benchmarks |

## Evidence for each tier

**S01** (M): All 25 sampled repos set a GitHub description; 20 of 25 also set topics. modelcontextprotocol/servers is a no-topics counter-example.

> "{"description":"The Memory Layer for AI Agents - Drop-in memory infrastructure for AI agents and apps. Context that persists. Built for production."}"  
> — <https://api.github.com/repos/mem0ai/mem0>

**S02** (S): A first screen that answers what, why and for whom is best practice; playwright-mcp and context7 do it, while cognee buries its description.

> "A Model Context Protocol (MCP) server that provides browser automation capabilities using [Playwright](https://playwright.dev). This server enables LLMs to interact with web pages"  
> — <https://github.com/microsoft/playwright-mcp/blob/e73d72e01f162054a3d0a6b0fe8d4affffb095ee/README.md#L3>

**S03** (S): Demo media showing a result is best practice: headroom's token-compression GIF, cognee's demo GIF, claude-obsidian's loop diagram.

> "<img src="HeadroomDemo-Fast.gif" alt="Headroom compressing a 10,144 token log dump to 1,260 tokens while preserving the FATAL line""  
> — <https://github.com/headroomlabs-ai/headroom/blob/dc28413fd9ab538970cc3497d37dda2d1ec8f7a4/README.md#L41>

**S04** (M): A documented one-command install via a package runner is table stakes (playwright-mcp, codex-mcp-server, context7); pal-mcp-server's recommended git clone is the counter-example.

> "claude mcp add playwright npx @playwright/mcp@latest"  
> — <https://github.com/microsoft/playwright-mcp/blob/e73d72e01f162054a3d0a6b0fe8d4affffb095ee/README.md#L101>

**S05** (M): Prerequisites before install steps are table stakes: playwright-mcp Requirements precede Getting started; pal and context7 state runtime needs before the command.

> "### Requirements
- Node.js 18 or newer"  
> — <https://github.com/microsoft/playwright-mcp/blob/e73d72e01f162054a3d0a6b0fe8d4affffb095ee/README.md#L19-L20>

**S06** (S): An explicit verify-it-works step is best practice: mcpvault tests with MCP Inspector before client config; codex-mcp-server ends Quick Start with example prompts.

> "2. **Test the server:**"  
> — <https://github.com/bitbonsai/mcpvault/blob/c5abeda9bed11864079f70ae7f33d134e294aad2/README.md#L38>

**S07** (S): Release tag, manifest version and installed copy stay in sync; Claude Code docs say bump version every release or users keep the cached copy.

> "Bump the field on every release, or omit it to fall back to the resolved version."  
> — <https://code.claude.com/docs/en/plugin-marketplaces>

**S08** (M): Top skill repos document one-command registry/marketplace installs (`npx skills add` and/or `/plugin marketplace add`).

> "npx skills add google/skills"  
> — <https://github.com/google/skills/blob/5a14f112793c118ba576559a2b46f7efa78290f5/README.md#L11>

**S09** (M): Spec requires frontmatter name and description; description must say what the skill does and when to use it.

> "| `name`          | Yes      | Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen."  
> — <https://agentskills.io/specification>

**S10** (S): Spec recommends SKILL.md under 500 lines with detail in separate files; google/skills puts detail in references/.

> "Keep your main `SKILL.md` under 500 lines. Move detailed reference material to separate files."  
> — <https://agentskills.io/specification>

**S11** (S): Skills use relative paths within the skill and state how to get their binary (dev-browser npm install; gws requires.bins).

> "When referencing other files in your skill, use relative paths from the skill root:"  
> — <https://agentskills.io/specification>

**S12** (S): Top skill repos target multiple harnesses via the skills CLI, gh skill --agent, or per-harness manifests.

> "installs into 70+ agents (Claude Code, Cursor, Codex, Copilot, Cline, and more):"  
> — <https://github.com/addyosmani/agent-skills/blob/be4e44a9fbc5e8df0beaefadbb28bd22ee61cc39/README.md#L46>

**S13** (S): Parseable output with defined exit states is best practice: googleworkspace/cli documents exit codes 0-5 and all-JSON output; repomix documents a non-zero exit on token budget.

> "`gws` uses structured exit codes so scripts can branch on the failure type without parsing error output."  
> — <https://github.com/googleworkspace/cli/blob/a3768d0e82ad83cca2da97724e46bea4ff0e6dbd/README.md#L395>

**S14** (S): A lean, product-only root is best practice (simonw/llm, 15 entries); cognee (pr_body.md, logs/) and basic-memory (plans in docs/) are counter-examples.

> "15"  
> — <https://api.github.com/repos/simonw/llm/contents?ref=1df47ddcac20d58726a993949da8ef84f4081085>

**S15** (S): One canonical home is best practice: servers points to the MCP Registry, and mcp-run-python names its successor; e2b-dev/mcp-server is archived with no successor link.

> "If you are looking for a list of MCP servers, you can browse published servers on [the MCP Registry](https://registry.modelcontextprotocol.io/)."  
> — <https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/README.md#L6>

**S16** (S): Declaring side effects and data egress is best practice (codebase-memory-mcp, headroom, graphiti telemetry opt-out); explicit cost declarations are rarely found.

> "This tool reads your codebase and writes to your agent configuration files."  
> — <https://github.com/DeusData/codebase-memory-mcp/blob/2058d49a04b785315c9f5bb56b6e2365822b576b/README.md#L23>

**S17** (M): A GitHub-recognized LICENSE is table stakes: 22 of 25 sampled repos have an SPDX id; codex-mcp-server has none; servers and pal show NOASSERTION.

> "Apache-2.0"  
> — <https://api.github.com/repos/microsoft/playwright-mcp>

**S18** (S): Written release notes are near-universal; a root CHANGELOG file is best practice (7 of 25). github-mcp-server relies on release notes only.

> "## What's Changed"  
> — <https://api.github.com/repos/github/github-mcp-server/releases/tags/v1.12.1>

**S19** (S): Root SECURITY.md is best practice, not universal: 17 of 25 sampled repos have one (playwright-mcp yes, simonw/llm no).

> "["SECURITY.md"]"  
> — <https://api.github.com/repos/microsoft/playwright-mcp/contents?ref=e73d72e01f162054a3d0a6b0fe8d4affffb095ee>

**S20** (S): A CI badge on the front page is best practice (8 of 25). graphiti's tests badge is green; simonw/llm shows a Tests badge while main is failing.

> "[![Unit Tests](https://github.com/getzep/Graphiti/actions/workflows/unit_tests.yml/badge.svg)]"  
> — <https://github.com/getzep/graphiti/blob/c035afb7990b6077331a81e98b04efcfd9bf8184/README.md#L15>

**S21** (S): Docs generated from code are best practice: playwright-mcp (update-readme.js), simonw/llm (cog from docs), jupyter-mcp-server (tool reference from a live server snapshot).

> "<!--- Tools generated by update-readme.js -->"  
> — <https://github.com/microsoft/playwright-mcp/blob/e73d72e01f162054a3d0a6b0fe8d4affffb095ee/README.md#L874>

**S22** (S): Behaviour/quality evals: addyosmani gates CI on trigger evals; Claude Code plugin eval compares against a no-plugin baseline.

> "run: node scripts/run-evals.js --min-rank1 95"  
> — <https://github.com/addyosmani/agent-skills/blob/be4e44a9fbc5e8df0beaefadbb28bd22ee61cc39/.github/workflows/test-plugin-install.yml#L35>

## Practices for wrapping a tool as a skill

**P1.** Publish the tool to a registry; keep the skill a thin adapter.

> "Project-scoped installs write under the current directory, for example `.claude/skills/graphify/SKILL.md` or `.agents/skills/graphify/SKILL.md`"  
> — <https://github.com/Graphify-Labs/graphify/blob/fe66389083369c3159aa391117185c8f58b4d07c/README.md#L189-L190>

> "cliHelp: "gws drive --help""  
> — <https://github.com/googleworkspace/cli/blob/a3768d0e82ad83cca2da97724e46bea4ff0e6dbd/skills/gws-drive/SKILL.md#L11>

**P2.** Give the tool a command that installs its own skill.

> "dev-browser install-skill --claude  # ~/.claude/skills/dev-browser/SKILL.md"  
> — <https://github.com/SawyerHood/dev-browser/blob/a25e7672e199153b2f5b52a841a62436a28d925f/README.md#L67>

**P3.** Name the binary the skill depends on (`metadata.requires.bins`).

> "requires: bins: - gws"  
> — <https://github.com/googleworkspace/cli/blob/a3768d0e82ad83cca2da97724e46bea4ff0e6dbd/skills/gws-drive/SKILL.md#L8-L10>

**P4.** Write the description as a trigger: what, then when (≤1024 chars).

> "Max 1024 characters. Non-empty. Describes what the skill does and when to use it."  
> — <https://agentskills.io/specification>

> "the combined `description` and `when_to_use` text is truncated at 1,536 characters in the skill listing to reduce context usage."  
> — <https://code.claude.com/docs/en/skills>

> "Don't use for standard infrastructure monitoring unrelated to AI agents,"  
> — <https://github.com/google/skills/blob/5a14f112793c118ba576559a2b46f7efa78290f5/skills/cloud/agent-platform-alert-configuration/SKILL.md#L10>

**P5.** Keep SKILL.md under 500 lines and within the spec's fields.

> "Keep your main `SKILL.md` under 500 lines. Move detailed reference material to separate files."  
> — <https://agentskills.io/specification>

> "claude.ai skill uploads, the Skills API, and packaging with `package_skill.py`"  
> — <https://code.claude.com/docs/en/skills>

**P6.** Generate skill and tool docs from code.

> "<!--- Tools generated by update-readme.js -->"  
> — <https://github.com/microsoft/playwright-mcp/blob/e73d72e01f162054a3d0a6b0fe8d4affffb095ee/README.md#L874>

> "# README.md is generated from docs/index.md using sphinx_markdown_builder"  
> — <https://github.com/simonw/llm/blob/1df47ddcac20d58726a993949da8ef84f4081085/README.md#L2>

**P7.** Reach more harnesses through `.agents/skills` or a Claude plugin.

> "For repositories, Codex scans .agents/skills in every directory from your current working directory up to the repository root."  
> — <https://learn.chatgpt.com/docs/build-skills>

> "# Submit your Claude Code plugin to OpenAI"  
> — <https://developers.openai.com/plugins/guides/submit-claude-plugin>

**P8.** For coding agents, prefer a CLI plus a skill over MCP.

> "If you are using a **coding agent**, you might benefit from using the [CLI+SKILLS](https://github.com/microsoft/playwright-cli) instead."  
> — <https://github.com/microsoft/playwright-mcp/blob/e73d72e01f162054a3d0a6b0fe8d4affffb095ee/README.md#L7>

**P9.** Declare side effects and data egress in one block.

> "> **Security & Trust** — This tool reads your codebase and writes to your agent configuration files. That is what it is designed to do."  
> — <https://github.com/DeusData/codebase-memory-mcp/blob/2058d49a04b785315c9f5bb56b6e2365822b576b/README.md#L23>

**P10.** Validate manifests in CI and measure skill behaviour.

> "run: npx --yes skills@1.5.20 add . --list"  
> — <https://github.com/blader/humanizer/blob/9862685f575c65a8247f90369951df1b3416e3d6/.github/workflows/validate.yml#L25>

> "skills-ref validate ./my-skill"  
> — <https://agentskills.io/specification>

> "Claude Code v2.1.269 or later."  
> — <https://code.claude.com/docs/en/plugin-evals>
