# Plan: Issue #8 — RLM Host Tools (`llm_query`, `rlm_query`, `SUBMIT`)

**Branch:** `issue/8-rlm-tools`

## Overview

Implement the three RLM host tools documented in `repl/repl_server.py`:
1. **`llm_query(prompt)`** — Ask the sub-LLM a question, returns response
2. **`rlm_query(query, context?)`** — Spawn nested RLM loop, returns final answer
3. **`SUBMIT(answer)`** — Signal completion with final answer

Plus a `SubmitSignal` class for clean execution termination.

---

## 1. `src/submit_signal.ts` — SubmitSignal

### API

```ts
/**
 * Thrown by SUBMIT.execute() after recording the call trace.
 * Caught by the sandbox loop to terminate execution cleanly
 * and return { status: "ok", output: answer }.
 */
export class SubmitSignal extends Error {
  readonly answer: string;

  constructor(answer: string) {
    super(`SUBMIT: ${answer}`);
    this.name = "SubmitSignal";
    this.answer = answer;
  }
}
```

- Extends `Error` (not `HostToolError`) — it's a control-flow signal, not a Python exception
- Carries the answer string so the sandbox can extract it

---

## 2. `src/rlm_tools.ts` — createRLMTools

### API

```ts
export interface RLMToolOptions {
  /** Called by llm_query — receives prompt, returns LLM response. */
  onLLMQuery: (prompt: string) => Promise<string>;
  /** Called by rlm_query — receives query + optional context, returns final answer. */
  onRLMQuery: (query: string, context?: string) => Promise<string>;
}

export function createRLMTools(options: RLMToolOptions): HostTool[];
```

### Tool: `llm_query`

| Field | Value |
|-------|-------|
| name | `llm_query` |
| params | `prompt: str` |
| returns | `str` |
| requiresApproval | `false` |

**execute:** Calls `options.onLLMQuery(prompt)`, returns the result.

### Tool: `rlm_query`

| Field | Value |
|-------|-------|
| name | `rlm_query` |
| params | `query: str`, `context: str (optional)` |
| returns | `str` |
| requiresApproval | `false` |

**execute:** Calls `options.onRLMQuery(query, context)`, returns the result.

### Tool: `SUBMIT`

| Field | Value |
|-------|-------|
| name | `SUBMIT` |
| params | `answer: str` |
| returns | `void` |
| requiresApproval | `false` |

**execute:** Throws `SubmitSignal(answer)`. The sandbox catches this and terminates execution with the answer as output.

---

## 3. `src/sandbox.ts` — Catch SubmitSignal

In the main execute loop (both `runInSandbox` and `resumeSuspended`), after the `tool.execute()` call, add a catch for `SubmitSignal`:

```ts
try {
  const returnValue = await tool.execute(resolvedArgs);
  // ... existing logic
} catch (err) {
  if (err instanceof SubmitSignal) {
    calls.push({
      tool: tool.name,
      args: ...,
      durationMs: ...,
      ok: true,
    });
    return {
      status: "ok",
      output: err.answer,
      stdout,
      stdoutTruncated,
      calls,
    };
  }
  // ... existing HostToolError / generic error handling
}
```

The catch must come **before** `HostToolError` — `SubmitSignal` is checked first.

Also apply the same treatment in `resumeSuspended`'s initial tool execution block (the replayed approval decision).

---

## 4. `src/index.ts` — Barrel export

```ts
export { createRLMTools, type RLMToolOptions } from "./rlm_tools.js";
export { SubmitSignal } from "./submit_signal.js";
```

Re-export everything else too for a single entry point.

---

## 5. Test Plan (TDD)

### `test/rlm_tools.test.ts`

#### 5.1 Tool creation
- `createRLMTools()` returns 3 tools
- Tool names: `llm_query`, `rlm_query`, `SUBMIT`
- All tools have `requiresApproval: false`
- `llm_query` params: `prompt: str` (required)
- `rlm_query` params: `query: str` (required), `context: str` (optional)
- `SUBMIT` params: `answer: str` (required)
- `SUBMIT` returns: `"void"`

#### 5.2 llm_query execution
- Calls `onLLMQuery` with the prompt string
- Returns the callback's return value
- Errors from callback propagate as-is (wrapped as RuntimeError by sandbox)

#### 5.3 rlm_query execution
- Calls `onRLMQuery` with query and context
- context defaults to `undefined` when not passed
- Returns the callback's return value

#### 5.4 SUBMIT execution
- Throws `SubmitSignal` with the answer
- `SubmitSignal` is an instance of `Error`
- `SubmitSignal.answer` matches the argument

#### 5.5 Integration: SUBMIT terminates sandbox execution
- Run code that calls `SUBMIT("done")` — result is `{ status: "ok", output: "done" }`
- The SUBMIT call appears in `calls` with `ok: true`
- Code after SUBMIT does not execute

### `test/sandbox.test.ts` (additions)

- SUBMIT mid-execution returns ok with answer
- SUBMIT in resumeSuspended path works
- Multiple SUBMIT calls: first one wins (second never executes)

---

## 6. Definition of Done

- [ ] `src/submit_signal.ts` — `SubmitSignal` class
- [ ] `src/rlm_tools.ts` — `createRLMTools()` with 3 tools
- [ ] `src/sandbox.ts` — catch `SubmitSignal` in `runInSandbox` loop
- [ ] `src/sandbox.ts` — catch `SubmitSignal` in `resumeSuspended` loop (initial tool exec + main loop)
- [ ] `src/index.ts` — barrel exports
- [ ] `test/rlm_tools.test.ts` — ≥12 tests
- [ ] `test/sandbox.test.ts` — SUBMIT integration tests added
- [ ] All existing 206 tests pass (no regressions)
- [ ] `tsc --noEmit` clean
