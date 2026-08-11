# Plan: Issue #9 — RLM Loop Orchestrator

**Branch:** `issue/9-rlm-loop`

## Overview

Implement the RLM (Repeated LLM → Monty) loop orchestrator — the keystone
that ties the sandbox, tools, and LLM together into a working
code-generation-and-execution loop.

All infrastructure exists (sandbox, tools, session, bridge, builtins,
RLM tools, SubmitSignal). The loop itself is the missing piece.

---

## 1. Architecture

```
                 ┌──────────────────────────┐
                 │       RLMLoop            │
                 │                          │
  task + context │  1. Build system prompt  │
  ──────────────►│  2. LLM → Python code    │──── generateCode()
                 │  3. runInSandbox(code)   │
                 │     ├─ llm_query(p) ─────│──── llmQuery()
                 │     ├─ rlm_query(q,c) ───│──── spawn nested RLMLoop
                 │     └─ SUBMIT(ans) ──────│──── extract answer
                 │  4. Loop or return       │
                 │                          │
                 └──────────────────────────┘
```

The RLMLoop receives a task + optional context, then enters a loop:
1. Send conversation to LLM → get Python code
2. Execute code in sandbox with RLM + bridge + builtin tools
3. If SUBMIT → return answer
4. If error/no-SUBMIT → append result to conversation, go to 1

---

## 2. `src/rlm_loop.ts` — RLMLoop class

### 2.1 Types

```ts
export interface RlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RLMLoopOptions {
  /** Tool registry. RLM tools (llm_query, rlm_query, SUBMIT) are
   *  auto-created and merged. Should already contain bridge + builtins. */
  registry: ToolRegistry;

  /** Called by llm_query from sandbox code — single question → answer. */
  llmQuery: (prompt: string) => Promise<string>;

  /** Called each iteration to generate Python code from conversation. */
  generateCode: (messages: RlmMessage[]) => Promise<string>;

  /** Max code-gen → execute iterations. Default 10. */
  maxIterations?: number;

  /** Nesting depth limit for rlm_query recursion. Default 1.
   *  At maxDepth, rlm_query downgrades to llm_query. */
  maxDepth?: number;

  /** Current nesting depth (0 = root). Default 0. */
  depth?: number;

  /** Sandbox run options passed to runInSandbox. */
  runOpts?: RunOptions;
}

export interface RLMLoopResult {
  status: "ok" | "error" | "max_iterations";
  answer?: string;
  error?: string;
  iterations: number;
  messages: RlmMessage[];
  traces: ToolCallTrace[][];
}
```

### 2.2 Class structure

```ts
export class RLMLoop {
  private options: RLMLoopOptions;

  constructor(options: RLMLoopOptions) {
    // Validate maxIterations >= 1, maxDepth >= 0
    this.options = options;
  }

  async run(task: string, context?: string): Promise<RLMLoopResult> {
    // Build system prompt, initialize conversation, enter loop
  }

  private buildSystemPrompt(): string { ... }
  private buildRlmRegistry(): ToolRegistry { ... }
  private async executeCode(
    code: string,
    registry: ToolRegistry,
  ): Promise<RunResult> { ... }
}
```

### 2.3 `run(task, context?)` algorithm

```
1. Validate options
2. Build system prompt (tools, rules, SUBMIT requirement)
3. Build tool registry (merge user's registry + RLM tools wired to
   this.onLLMQuery and this.onRLMQuery)
4. Initialize conversation:
   messages = [{ role: "system", content: systemPrompt }]
   if context: append { role: "user", content: taskWithContext }
   else: append { role: "user", content: task }
5. For iteration in 1..maxIterations:
   a. Ask LLM for code: code = await generateCode(messages)
   b. Append { role: "assistant", content: code } to messages
   c. Execute code in sandbox: result = await executeCode(code, registry)
   d. Record result.traces
   e. SUBMIT check: does result.calls contain an entry where tool === "SUBMIT"?
      → If YES: return { status: "ok", answer: result.output, ... }
      (SubmitSignal causes sandbox to return status:"ok" with the answer
       in .output. We distinguish from normal completion by inspecting
       result.calls — only SUBMIT-terminated runs have a SUBMIT trace.)
   f. If result.status === "ok" (no SUBMIT):
        Append { role: "user", content: formatOkResult(result) } to messages
        continue loop
   g. If result.status === "error":
        Append { role: "user", content: formatError(result) } to messages
        continue loop
   h. If result.status === "suspended":
        return { status: "error", error: "unexpected suspension", ... }
6. Return { status: "max_iterations", ... }
```

### 2.4 RLM tool callbacks

The loop creates RLM tools dynamically. To avoid name collisions with
user-provided tools, we explicitly guard: if the user's registry already
has an `llm_query`, `rlm_query`, or `SUBMIT` tool, construction throws
a clear error (the user should remove these from their registry — the
loop owns them).

```ts
private buildRlmTools(): HostTool[] {
  // Guard against name collisions
  for (const name of ["llm_query", "rlm_query", "SUBMIT"]) {
    if (this.options.registry.has(name)) {
      throw new Error(
        `RLMLoop: tool '${name}' conflicts with user registry. ` +
        `Remove it — the loop provides its own RLM tools.`
      );
    }
  }
  return createRLMTools({
    onLLMQuery: async (prompt) => {
      return await this.options.llmQuery(prompt);
    },
    onRLMQuery: async (query, context) => {
      const depth = this.options.depth ?? 0;
      if (depth >= (this.options.maxDepth ?? 1)) {
        return await this.options.llmQuery(
          `[rlm_query downgraded at max depth]\nQuery: ${query}\nContext: ${context ?? "(none)"}`
        );
      }
      const nested = new RLMLoop({
        ...this.options,
        depth: depth + 1,
      });
      const result = await nested.run(query, context);
      if (result.status === "ok") {
        return result.answer!;
      }
      return `[rlm_query error: ${result.status}] ${result.error ?? ""}`;
    },
  });
}
```

### 2.5 Code execution

```ts
private async executeCode(
  code: string,
  registry: ToolRegistry,
): Promise<RunResult> {
  const sandboxOpts: SandboxOptions = { registry };
  return await runInSandbox(code, sandboxOpts, this.options.runOpts);
}
```

Uses `runInSandbox` directly (not Session) — each iteration is
stateless. The LLM receives full conversation history, so it can
reference prior results without needing Python variable persistence.

### 2.6 System prompt

```ts
private buildSystemPrompt(registry: ToolRegistry): string {
  const stubs = registry.renderTypeStubs();
  const importableModules = probeImportableModules();
  const rules = renderPythonToolRules(importableModules);
  return [
    "You are a Python code generator for a sandboxed investigation environment.",
    "",
    "Your task: write Python code to investigate the user's question.",
    "Use the tools below to gather information, then call SUBMIT(answer)",
    "when you have the final answer.",
    "",
    "## Available Tools",
    "Call these as plain functions (no await, no import):",
    "",
    stubs || "(standard Python only)",
    "",
    "## Critical Rules",
    "- Call SUBMIT(answer) with your final answer — REQUIRED to finish",
    "- llm_query(prompt) asks the LLM for reasoning/summarization",
    "- rlm_query(query, context?) spawns a nested investigation",
    "- Do NOT define your own llm_query, rlm_query, or SUBMIT functions",
    "",
    "## Python Rules",
    rules,
    "",
    "Respond with ONLY Python code, no markdown fences, no explanation.",
  ].join("\n");
}
```

### 2.7 Result formatting helpers

```ts
function formatOkResult(result: RunOk): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(`[stdout]\n${result.stdout}`);
  parts.push(`[return value]\n${result.output}`);
  return parts.join("\n");
}

function formatError(result: RunError): string {
  return `[error: ${result.errorKind}]\n${result.error}\n[stdout]\n${result.stdout}`;
}
```

---

## 3. `src/index.ts` — Barrel export updates

```ts
export { RLMLoop, type RLMLoopOptions, type RLMLoopResult, type RlmMessage } from "./rlm_loop.js";
```

---

## 4. Test Plan (TDD)

### `test/rlm_loop.test.ts`

#### 4.1 Construction & validation

- `new RLMLoop(opts)` succeeds with valid options
- `new RLMLoop(opts)` throws/rejects on maxIterations: 0
- Default maxIterations is 10
- Default maxDepth is 1
- Default depth is 0

#### 4.2 Simple task → SUBMIT

- Generate code that calls `SUBMIT("answer")`, verify result.status === "ok", answer === "answer"
- The sandbox code is provided by `generateCode` mock

#### 4.3 llm_query integration

- Sandbox code calls `llm_query("what is X?")` — the `llmQuery` callback fires with that prompt
- The callback's return value is available in the sandbox
- `generateCode` mock generates code that uses llm_query result then SUBMITs

#### 4.4 rlm_query integration (non-nested)

- Sandbox code calls `rlm_query("investigate", "ctx")` — spawns nested RLMLoop
- Nested loop's result is returned to the sandbox

#### 4.5 generateCode throws

- generateCode throws an error → RLMLoop.run() returns { status: "error" }
- The error message is included in result.error

#### 4.6 llmQuery throws

- llmQuery callback throws → sandbox code receives RuntimeError
- generateCode gets the error in conversation, can retry or handle

#### 4.7 Empty task

- task = "" → still works (LLM receives empty user prompt)
- Should not crash or infinite-loop

#### 4.8 rlm_query at max depth

- At depth = maxDepth, rlm_query calls llmQuery instead of spawning
- Verify the downgrade message format

#### 4.9 Multi-iteration loop

- First iteration: code runs, prints output, no SUBMIT → loop continues
- Second iteration: code calls SUBMIT with answer → done
- Verify iteration count === 2
- Verify messages array contains all conversation turns
- Verify traces array has one entry per iteration

#### 4.10 Error recovery

- First iteration: code has syntax error → error fed back to LLM
- Second iteration: LLM generates fixed code → SUBMIT succeeds
- Verify status === "ok"

#### 4.11 Max iterations exceeded

- generateCode always generates code that just prints "still working"
- After maxIterations iterations, returns { status: "max_iterations" }

#### 4.12 Unexpected suspension

- Code triggers an approval gate (tool with requiresApproval: true)
- If no onApproval callback provided, tool is denied
- If onApproval returns "suspend", RLMLoop returns error

#### 4.13 Context passthrough

- task + context are passed to the LLM in the first user message
- Context is also injected as the `context` input variable in the sandbox

#### 4.14 Tool availability

- Sandbox code can use bridge tools (read, grep, etc.) if in registry
- Sandbox code can use builtins (read_file, list_files, http_get) if in registry
- Sandbox code can use llm_query, rlm_query, SUBMIT (always available)

#### 4.15 Nested rlm_query

- Root loop: code calls rlm_query("sub-task", "data")
- Nested loop: generateCode generates code that calls SUBMIT("sub-result")
- Root loop: receives "sub-result" in sandbox, then SUBMITs("final: " + sub_result)
- Verify final answer includes nested result

#### 4.16 runOpts passthrough

- runOpts.inputs are passed to sandbox
- runOpts.maxStdoutBytes works
- runOpts.signal can abort execution
- runOpts.limits restrict execution

#### 4.17 Name collision guard

- Constructing RLMLoop with user registry containing llm_query → throws
- Constructing RLMLoop with user registry containing rlm_query → throws
- Constructing RLMLoop with user registry containing SUBMIT → throws

---

## 5. Implementation Checklist

- [ ] `src/rlm_loop.ts` — RLMLoop class with full run() implementation
- [ ] `src/index.ts` — barrel exports
- [ ] `test/rlm_loop.test.ts` — ≥15 tests covering all sections above
- [ ] All existing 241 tests pass (no regressions)
- [ ] `tsc --noEmit` clean

## 6. Definition of Done

- [ ] RLMLoop.run(task, context?) works end-to-end
- [ ] llm_query callback integrated correctly
- [ ] rlm_query nesting works (including max depth downgrade)
- [ ] SUBMIT extraction works
- [ ] Multi-iteration loop works
- [ ] Error recovery within loop works
- [ ] Max iterations limit enforced
- [ ] System prompt includes tool stubs and rules
- [ ] All tests pass, no type errors

## 7. Follow-up Issues (identified post-implementation)

### Issue #10 — repl_server.py preamble injection

RLMLoop does not inject `repl/repl_server.py` preamble before user code.
This means sandbox code has no access to `context_preview()`, `context_lines()`,
`context_length()`, `context_summary()` helpers unless the user manually
prepends the preamble.

**Fix:** Add optional `preamble?: string` to `RLMLoopOptions`. When set,
prepend it to generated code before sandbox execution.

### Issue #11 — Fix repl_server.test.ts SUBMIT stubs

`test/repl_server.test.ts` uses stub tools where SUBMIT throws
`HostToolError("SystemExit")` — the tests expect `status: "error"` for SUBMIT.
The real implementation uses `SubmitSignal` → `status: "ok"`. These tests
would fail if run against real RLM tools instead of stubs.

**Fix:** Update tests to use the actual `createRLMTools()` or update stubs
to match SubmitSignal behavior. The real implementation (SubmitSignal caught
in sandbox, returns ok) is the correct behavior — tests should align.
