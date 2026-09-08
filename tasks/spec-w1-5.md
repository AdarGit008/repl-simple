# Spec: W1-5 — RLM boundary hygiene, stub honesty, and the shared redaction helper

Issues: #168, #191, #192 (security); src/redact.ts (shared helper); the filed synthesised-reply cap;
#67, #169, #170, #173 (RLM hygiene). Epics #70 and #31 are *not* closed here — closing-comment
drafts live in the ship report.

Branch `chunk/w1-5-rlm-hygiene-redaction`, base `main` = `3770e46`. Decision IDs D97–D110.

## Objective

Every RLM boundary that a sandbox program or a provider can push on is bounded, honest and
consistently redacted:

1. A single sandbox execution can no longer flood the host with `llm_query` / `rlm_query` calls
   (#168): 16 combined per iteration, refused with a marker, enforced with or without a budget,
   before any nested host work.
2. A redaction cut never discloses the size of what it withheld (#191), the threat model for
   provider errors is written down where `LlmClient` is declared (#192), and there is exactly one
   shared redaction object — head-only truncation composed with secret-pattern masking
   (`src/redact.ts`) — for this chunk's provider-error path and for wave 2's trace/dump exports.
3. The last uncapped `RlmResult.answer` path (the synthesised reply) is capped.
4. No tool is silently unchecked (#67): degraded stubs are counted, reported through an accessor,
   listed in the RLM system prompt, and asserted zero over the shipped registry; `-> void` no
   longer renders.
5. Stub validation is memoised across `runRlm` calls and nesting levels (#169), the child inherits
   the parent's full `options.inputs` (#170), and the question is a sandbox input the model can
   slice (#173).

## Current state (measured at HEAD `3770e46`, 2026-09-08)

- `src/rlm.ts:1161-1199` `onLLMQuery`, `:1200-1274` `onRLMQuery`: no invocation count. The only
  refusals are the optional `SpendBudget` (`:1174-1177`, `:1232-1235`) and the 300 s wall clock. A
  nested `rlm_query` runs `runRlm` → `buildSystemPrompt` (`:1287`, via `:1253`) before the child's
  first `tryCharge` (`:1342`). Markers today: `LLM_QUERY_REFUSED` / `RLM_QUERY_REFUSED` (`:609-612`).
- `src/rlm.ts:215-221` `redactProviderError`: `truncateText` head-only at 1 KiB with no
  `unknownTotal`, so a 64 KiB rejection renders `[… 63.0KB of 64.0KB elided. …]`
  (`src/truncate.ts:319-321`).
- `src/rlm.ts:21-37` `LlmClient` JSDoc: says "injected by the caller", nothing about trust.
  `docs/truncation-policy.md:453-467` records #167/#184/#189/#190 and the head-only rule, nothing
  about marker magnitude on a redaction cut or which clients are in scope.
- No value-redaction utility exists: `src/bashenv.ts` filters environment variables by *name*;
  `#192` shows the head-only window passes a short or leading secret verbatim.
- `src/rlm.ts:1526-1539`: `answer: synthesized` is returned untruncated. `RlmResult.answer` via
  SUBMIT is capped by the sandbox's `OUTPUT_MAX_BYTES` (16 KiB) and the salvage paths read
  sandbox-capped `output` / `stdout`; the synthesis reply is the only uncapped answer source.
- `src/registry.ts:116-125` `validateStubs` returns the joined stub text with `name: Any = None`
  for a stub that does not parse (path 1); nothing counts or reports it. `src/rlm_tools.ts:84`
  `returns: "void"` renders `def SUBMIT(answer: str) -> void:` (`src/registry.ts:91`); 0.0.21
  tolerates the unresolved name (path 3). `TY_GAP_CANDIDATES` (`src/registry.ts:277-284`) has one
  comment for the list, not a reason per entry (path 2). `buildSystemPrompt` (`src/rlm.ts:571-589`)
  names every tool and nothing about degradation.
- `src/registry.ts:22` `typeStubCache` is per instance; `src/rlm.ts:1158` builds a fresh
  `ToolRegistry` per `runRlm` call (and per nesting level), so the instance cache never hits across
  calls. The probe memos (`:219-237`) are the module-level pattern to mirror.
- `src/rlm.ts:1253-1269`: the child gets `runOptions: options.runOptions` (so `runOptions.inputs`
  flows) and `inputs: { context: merged }` — the parent's `options.inputs` other than `context`
  are not forwarded.
- `src/rlm.ts:298-299` `QUESTION_RECOVERY` is deliberately weak (policy Q3) because the question
  is not a sandbox variable. Reserved-name collision precedent: `:1101-1108`. `runInputs` merge:
  `:1130-1148`. Pinned template literals: `# Question\n` (tests 9/19/21 and the nested-loop
  discriminators), the `\n\nWrite Python code to answer the question.` trailer (14/19),
  `QUESTION_TRUNCATED = "The question was truncated."` (#171 tool-path tests).
- Constraints outside this chunk: `src/types.ts:16` closes `HostTool.returns` to `"str" | "void"`;
  `test/rlm_tools.test.ts:120` pins `SUBMIT.returns === "void"`; `test/readme.test.ts` compares RLM
  tool *names* only (descriptions are free). `src/index.ts` is not owned, so new exports are reachable
  from their modules, not the barrel, until wave 2.

## Decisions

| ID | Decision |
|---|---|
| D97 | **#168 cap (decision 4).** `RLM_TOOL_CALL_CAP = 16` combined `llm_query` + `rlm_query` invocations per loop iteration, those two tools only. The counter lives in `runRlm`'s closure scope, is reset to 0 immediately before every `runInSandbox`, and is incremented at the top of both `onLLMQuery` and `onRLMQuery` before any other work — before the #171 bound, before the spend charge, before the depth check, and therefore before a nested `runRlm` touches `options.registry.list()` or `buildSystemPrompt`. Over the cap the tool returns `LLM_QUERY_CAPPED` = `[llm_query refused: per-iteration cap of 16 llm_query/rlm_query calls reached]` (resp. `RLM_QUERY_CAPPED` with `rlm_query`), never throws, and is independent of `options.budget`. The constant is declared in `src/rlm_tools.ts` (imported by `rlm.ts`, no cycle) so the tool descriptions and the loop cite one number. A nested loop has its own counter (its own closures): the parent counts the spawn, the child counts its own tools. |
| D98 | **#191 (decision 7).** `redactProviderError` passes `unknownTotal: true`, so a redaction marker states where it cut — `[… truncated at 1.0KB. The full provider error is not surfaced. …]` — and never the size of the withheld text. Scoped to redaction cuts; model-facing value cuts keep their true totals (invariant 5 is an affordance there). Recorded in `docs/truncation-policy.md`. |
| D99 | **#192 (decision 7).** The 1 KiB head-only bound is accepted. `LlmClient` implementations are trusted host code: the threat model covers a provider *response* (request-context tails, retry hints, request IDs), not a hostile client. Written as a sentence on the `LlmClient` JSDoc in `src/rlm.ts` (the interface lives there, not in `src/types.ts`) and as a paragraph in the policy. D100's masking is defence in depth on top of the accepted bound, not a tightening that the bound relies on. |
| D100 | **`src/redact.ts` (decision 6).** `redact(text, { maxBytes, recovery })` = `maskSecrets(text)` then `truncateText` head-only (`HEAD_ONLY_RATIO`) with `unknownTotal: true`. Mask *before* the cut so a secret straddling the boundary never leaves a fragment. Four pattern families, replacement `[REDACTED]`: (1) known token prefixes — `sk-` (incl. `sk-ant-`), `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, `glpat-`, `xox[abprs]-`, `AKIA`, `AIza` — followed by ≥16 token chars, prefix kept (`sk-[REDACTED]`); (2) `Authorization:` header values (scheme kept) and bare `Bearer <token>`; (3) PEM private-key blocks, terminated or cut off (`[REDACTED PRIVATE KEY]`); (4) `NAME=value` / `NAME: value` where NAME ends in `_KEY`/`-KEY`/`.KEY`, is `APIKEY`, or ends in `TOKEN`/`SECRET`/`PASSWORD`/`PASSWD` (case-insensitive, `\b`-anchored so `max_tokens=` and `passwords=` never match; bare `key=` is excluded because it is Python's sort kwarg). Every regex is linear on long runs (bounded lazy prefixes, `\b` anchors). Idempotent: `maskSecrets(maskSecrets(x)) === maskSecrets(x)`. `redactProviderError` in `rlm.ts` becomes a call to `redact()` so the shared object has a live consumer and #191/#192 and the masking rule cannot drift apart. |
| D101 | **Synthesised-answer cap.** `SYNTHESIS_ANSWER_MAX_BYTES = ASSISTANT_REPLY_MAX_BYTES` (256 KiB), 50/50 value cut via plain `truncateText` (an API return, like `RlmResult.error` — a sentinel wrap would leak into the caller's result), recovery `SYNTHESIS_ANSWER_RECOVERY = "The synthesised answer was truncated; the rest is not surfaced."` (no route exists — policy Q3). Under budget the answer is byte-identical. `tasks/monitor-report.md:176`'s claim that the synthesis reply "flows through the D18 cap" was wrong: D18 caps the *conversation copy* of iteration replies, and the synthesis reply is not an iteration. |
| D102 | **#67 accessor shape (decision 10).** `ToolRegistry.degradedStubs(): Promise<StubDegradationReport>` with `{ tools: DegradedStub[]; checkerGaps: string[] }`. `DegradedStub = { name; kind: "unparseable" \| "unknown-type"; detail }`. `tools` carries paths 1 and 3 (ours, per-tool); `checkerGaps` carries path 2 (the interpreter's, per-process, deliberate). `validateStubs` keeps returning a string; path 1 is derived from the rendered text (a degraded tool renders the exact line `name: Any = None`, which no healthy stub can). `renderTypeStubs()` is unchanged. |
| D103 | **#67 path 3.** `KNOWN_TYPE_NAMES` = the names the renderer can emit plus the Python builtins the checker resolves (`str int float bool bytes None list dict set tuple object Any`). The renderer maps the HostTool spelling `"void"` to Python `None` (`-> None`): `void` is TypeScript vocabulary, `None` is its Python spelling, and `HostTool.returns` is a closed union in unowned `src/types.ts` pinned by unowned `test/rlm_tools.test.ts:120`, so the fix cannot be a different literal at `src/rlm_tools.ts:84`. The check runs over the *rendered* names so any future `returns`/`type` value outside the map is reported as `unknown-type` instead of being silently unchecked. `src/rlm_tools.ts:84` gets the explanatory comment. |
| D104 | **#67 path 2.** `TY_GAP_REASONS: Record<string, string>` documents every `TY_GAP_CANDIDATES` entry; both are exported; a test asserts every candidate has a reason and that the live gap list is a subset of the candidates. Checker gaps are not tools and are excluded from the zero-degraded assertion. |
| D105 | **#67 surfacing.** `buildSystemPrompt` appends an `## Unchecked Tools` section — one line per degraded tool with its detail — only when `degradedStubs().tools` is non-empty; the shipped prompt is byte-identical. The `repl`-side notice is deferred as a todo test (decision 10). |
| D106 | **#169 memo.** Module-level content-addressed memo keyed by the joined stub text, storing the in-flight promise (concurrent first callers share one validation); a rejected validation deletes its entry (never cached); bounded at `STUB_MEMO_MAX_ENTRIES = 64` entries, cleared wholesale on overflow. `stubValidationInvocations()` and `resetStubValidationMemo()` mirror `probeInvocations()` / `resetProbeMemos()`. The per-instance promise cache stays (its in-flight-`add()` semantics are pinned). |
| D107 | **#170 (decision 7).** The child receives `inputs: { ...options.inputs, context: merged }` — the parent's full `options.inputs`, with the merged context overriding. `runOptions.inputs` already flows through `runOptions`; the parent's `question` is never forwarded (D108). |
| D108 | **#173.** `question` is a reserved sandbox input declared from the `runRlm` argument (child loops see their own query). A caller-supplied `question` in either input source throws `runRlm: input 'question' is reserved …` before any LLM query (the `:1101-1108` collision pattern). It is never rendered as an input block — the `# Question` section carries it — and the initial-prompt trailer becomes `Write Python code to answer the question. The full question is available as the \`question\` variable. Call SUBMIT(answer) when done.` (the pinned `\n\nWrite Python code to answer the question.` prefix survives). `QUESTION_RECOVERY` is strengthened to `The question was truncated. The full question is available as the \`question\` Python variable — slice it in Python to see more.`; the two tool paths (`llm_query` prompt, downgrade query) keep the old wording under `TOOL_PROMPT_RECOVERY` because there is no sandbox there (policy Q3). |
| D109 | **Delivery order.** Security first: #168, #191, #192, `redact.ts`; then the synthesis cap, #67, #169, #170, #173. RED and GREEN in separate commits per item; every new test fails against main's `src/`. New registry exports are reached through a namespace import in `test/registry.test.ts` so that, against main, only the new tests fail rather than the file failing to load. |
| D110 | **Coverage.** `npm run coverage:update` runs exactly once, after every test is in, wrapped in `scripts/contained.mjs`; every changed floor is justified line by line in the PR body. Floors to meet: `src/rlm.ts` 99.14, `src/rlm_tools.ts` 99.07, `src/registry.ts` 96.02, `src/redact.ts` 100. |

## Tests — RED → GREEN

`test/rlm.test.ts`
- #168: 17 `llm_query` in one iteration → calls 1-16 answered, the 17th returns the exact marker,
  no budget; the same with a generous budget; 8 `llm_query` + 9 downgraded `rlm_query` → the 17th
  refused with the `rlm_query` marker; a spy on the caller registry's `list()` proves 20 spawning
  `rlm_query` calls start 16 children and no more (refusal precedes the child's registry merge and
  its `buildSystemPrompt`); 16 + 16 across two iterations → no marker (the cap resets); a depth-3
  tree with no budget makes exactly the expected number of provider calls; a forged marker printed
  by sandbox code is quoted data in the feedback and does not disturb the count.
- #191: the D53 error, the two tool paths and the nested re-interpolation carry
  `truncated at 1.0KB` and no `elided` / `64.0KB`.
- #192: the `LlmClient` doc block in `src/rlm.ts` names trusted host code; the policy carries the
  #191 and #192 paragraphs.
- Synthesis cap: a 1 MiB synthesised reply → `answer` ≤ 256 KiB with the marker,
  `answerSource: "synthesised"`; a short reply is byte-identical.
- #67: a `class`-param tool is listed under `## Unchecked Tools`; a clean registry has no such
  section; todo: the `repl`-side notice.
- #169: two `runRlm` calls over the same caller registry validate once.
- #170: the child reads the parent's non-context input; the `:2249` precedence pin is unchanged.
- #173: `question[:5]` in Python; a nested child's `question` is its query; a caller `question`
  input (either source) throws before any query; the prompt renders the question once, with no
  `# Input` block for it; the strengthened marker names the variable; the tool-path marker does not.

`test/registry.test.ts`
- #67: `degradedStubs()` reports the unparseable tool; a `void` tool renders `-> None` and is not
  degraded; a cast-in unknown type name is reported `unknown-type`; the shipped registry
  (builtins + RLM tools + tool store) has zero degraded tools and the same assertion fires when a
  broken stub is injected; every `TY_GAP_CANDIDATES` entry has a reason and the live gaps are a
  subset.
- #169: identical stub sets across two registries validate once; different sets twice; a
  validation that rejects (single-worker pool held, 1 s checkout) is re-run on the next call and
  the retry's result is correct; the reset hook re-validates.

`test/redact.test.ts`
- One test per pattern family; a no-false-positive corpus (Python code with `key=lambda`,
  `max_tokens=4096`, JSON, tracebacks, URLs, SHAs, timestamps, a public certificate block);
  idempotence over every fixture; composition: ceiling holds marker included, the marker is
  `truncated at`, a secret straddling the cut leaves no fragment, short input is byte-identical.

## Boundaries

Modify: `src/rlm.ts`, `src/rlm_tools.ts`, `src/registry.ts`, `test/rlm.test.ts`,
`test/registry.test.ts`, `docs/truncation-policy.md`, `coverage-baseline.json`.
Create: `src/redact.ts`, `test/redact.test.ts`, `docs/redaction.md`, this file, the ship report.
Not touched: `src/types.ts`, `src/index.ts`, `test/rlm_tools.test.ts`, `repl/`, `README.md`,
`tasks/monitor-report.md`, `SPEC.md`, `tasks/plan.md`, `tasks/todo.md`.
