# Plan: Issue #4 — `src/bridge.ts` + `resumeSuspended()`

**Branch:** `issue/4-bridge`

## Overview

1. **`src/bridge.ts`** — Wraps Pi's 7 native tools as `HostTool[]` for the sandbox
2. **`resumeSuspended()`** — Resume paused sandbox executions (deferred from Issue #5)
3. **Cleanup** — Remove unused `lineOffset` from `RunOptions`

---

## 1. `src/bridge.ts` — Pi Tool Bridge

### API

```ts
export interface BridgeOptions {
  /** Gate mutating tools behind approval. Default: true */
  gateMutating?: boolean;
  /** Custom read tool options (passed to createReadTool) */
  read?: ReadToolOptions;
  /** Custom bash tool options */
  bash?: BashToolOptions;
  // ... per-tool options as needed
}

export function createPiBridgeTools(
  cwd: string,
  options?: BridgeOptions,
): HostTool[];
```

### Source

Pi tool factories from `@earendil-works/pi-coding-agent`:
- `createReadTool`, `createGrepTool`, `createFindTool`, `createLsTool`
- `createBashTool`, `createEditTool`, `createWriteTool`

### Tool Mapping

Each Pi `AgentTool<Schema>` → `HostTool`:

| Pi Tool | HostTool params | requiresApproval |
|---------|----------------|------------------|
| read | path (str), offset? (int), limit? (int) | false |
| grep | pattern (str), path? (str), glob? (str), ignoreCase? (bool), literal? (bool), context? (int), limit? (int) | false |
| find | pattern (str), path? (str), limit? (int) | false |
| ls | path? (str), limit? (int) | false |
| bash | command (str), timeout? (int) | gateMutating |
| edit | path (str), edits (str — JSON array) | gateMutating |
| write | path (str), content (str) | gateMutating |

**`edits` param:** Pi's edit tool takes `Array<{oldText: string, newText: string}>`, but HostToolParam only supports str/bool/int/float. We declare it as `str` type and the bridge code receives it as-is (Monty passes JS objects through). The description tells the LLM to pass a JSON string.

### Wrapper Pattern

```ts
function wrapTool(
  agentTool: AgentTool<any>,
  params: HostToolParam[],
  returns: "str",
  requiresApproval: boolean,
): HostTool {
  return {
    name: agentTool.name,
    description: agentTool.description,
    params,
    returns,
    requiresApproval,
    execute: async (args) => {
      const result = await agentTool.execute(
        crypto.randomUUID(), // toolCallId
        args as any,         // params pass through
      );
      // Extract text from content[]
      return result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
    },
  };
}
```

### Key Details

- **toolCallId:** UUID per call (for Pi's logging/tracing)
- **Result extraction:** `AgentToolResult.content` is `(TextContent | ImageContent)[]` — we join all text blocks
- **Errors:** Pi tools throw on failure — caught by sandbox's execute loop, surface as HostToolError → Python exception
- **Signal:** Not passed through (sandbox aborts between loop iterations)

---

## 2. `resumeSuspended()` — Resume from approval pause

### Problem

When `onApproval` returns `"suspend"`, the sandbox halts and returns `RunSuspended`. The caller needs to re-feed the approval decision to continue execution.

### API

```ts
export async function resumeSuspended(
  suspended: RunSuspended,
  decision: ApprovalDecision,
  options: SandboxOptions,
  runOpts?: RunOptions,
): Promise<RunResult>;
```

### Implementation

1. `RunSuspended` gets a new `snapshot: Buffer` field (MontySnapshot.dump())
2. In `runInSandbox()`, when suspending, call `snapshot.dump()` and include in result
3. `resumeSuspended()`:
   - Load snapshot: `MontySnapshot.load(suspended.snapshot)`
   - Re-create the approval request from `suspended.suspendedCall`
   - Apply the decision:
     - `true` → execute tool, resume with returnValue → continue loop
     - `false` → resume with PermissionError → continue loop
     - `"suspend"` → return suspended again (nested suspension)
   - Continue the start/resume loop from the loaded snapshot

### Flow

```
resumeSuspended(suspended, decision)
  → snapshot = MontySnapshot.load(suspended.snapshot)
  → tool = registry.get(suspended.suspendedCall.tool)
  → if decision === true:
      execute tool, snapshot.resume({ returnValue })
  → if decision === false:
      snapshot.resume({ exception: PermissionError })
  → continue loop (same as runInSandbox's main loop)
```

### Types change

```ts
// src/types.ts — add snapshot field
export interface RunSuspended {
  status: "suspended";
  suspendedCall: ApprovalRequest;
  snapshot: Buffer;       // NEW
  stdout: string;
  stdoutTruncated: boolean;
  calls: ToolCallTrace[];
}
```

---

## 3. Cleanup: Remove `lineOffset`

Remove `lineOffset?: number` from `RunOptions` in `src/types.ts`. Unused; was a pi-reepl carryover.

---

## 4. Test Plan (TDD)

### `test/bridge.test.ts`

#### 4.1 Tool creation
- `createPiBridgeTools()` returns 7 tools
- All tools have correct names
- Read-only tools have `requiresApproval: false`
- Mutating tools have `requiresApproval: true` (default)
- `gateMutating: false` → all tools have `requiresApproval: false`

#### 4.2 Tool execution (integration)
- read tool: reads a known file, returns content
- ls tool: lists known directory
- grep tool: searches with pattern
- find tool: finds files by glob
- bash tool: runs simple command
- write tool: writes file, read back to verify
- edit tool: edits a file, verify diff

#### 4.3 Error handling
- read nonexistent file → throws (surfaces as Python exception in sandbox)
- bash invalid command → throws

### `test/sandbox.test.ts` (additions)

#### 4.4 resumeSuspended
- Suspend then resume with approve → completes successfully
- Suspend then resume with deny → PermissionError
- Suspend then resume with suspend → RunSuspended again
- Resume captures ToolCallTrace correctly

### `test/types.test.ts` (additions)
- `RunSuspended` has `snapshot` field typed as Buffer
- `RunOptions` does NOT have `lineOffset`

---

## 5. Definition of Done

- [ ] `src/bridge.ts` — `createPiBridgeTools()` with 7 Pi tools
- [ ] `src/types.ts` — add `snapshot: Buffer` to `RunSuspended`
- [ ] `src/types.ts` — remove `lineOffset`
- [ ] `src/sandbox.ts` — `runInSandbox()` dumps snapshot on suspend
- [ ] `src/sandbox.ts` — `resumeSuspended()` export
- [ ] `test/bridge.test.ts` — ≥10 tests
- [ ] `test/sandbox.test.ts` — resumeSuspended tests added
- [ ] `test/types.test.ts` — updated for snapshot + lineOffset removal
- [ ] All existing tests pass (no regressions)
- [ ] `tsc --noEmit` clean
