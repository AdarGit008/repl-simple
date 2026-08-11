# Plan: Issue #9 — `src/repl.ts` Standalone repl tool

## What

A Pi extension tool `repl(code, sessionId?)` that executes Python in a sandboxed Monty interpreter with persistent sessions. Direct REPL — NOT an RLM loop. No `llm_query`, `rlm_query`, or `SUBMIT` host tools.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/repl.ts` | **NEW** | ReplRunner class — session management, tool composition, execution |
| `extensions/repl-extension.ts` | **NEW** | Pi extension entry point — registers the `repl` tool |
| `test/repl.test.ts` | **NEW** | Tests |
| `src/index.ts` | **MODIFY** | Add repl exports |
| `tsconfig.json` | **MODIFY** | Ensure `extensions/` is included (or add tsconfig to extensions/) |

## Architecture

```
extensions/repl-extension.ts
  └─ defineTool("repl", ...)
       └─ ReplRunner.run(code, sessionId, ctx)
            ├─ Session pool (Map<sessionId, Session>)
            ├─ Tool composition:
            │   ├─ createPiBridgeTools(cwd, { gateMutating: true })
            │   ├─ createBuiltinTools({ root: cwd })
            │   └─ loadSavedTools({ root: cwd }) → preamble
            └─ session.run(code, runOpts)
                 └─ runInSandbox(allCode, sandboxOpts, runOpts)
```

## Design Decisions

### 1. ReplRunner class (`src/repl.ts`)

```typescript
class ReplRunner {
  private sessions: Map<string, Session>;
  private baseRegistry: ToolRegistry;
  private cwd: string;

  constructor(cwd: string);
  
  async run(
    code: string,
    sessionId: string = "default",
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
  ): Promise<string>;
  
  async resume(
    sessionId: string,
    onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
  ): Promise<string>;
  
  reset(sessionId: string): void;
  abandon(sessionId: string): boolean;
}
```

- Session pool keyed by `sessionId`, lazy-created on first use
- Base registry = bridge + builtins (no RLM tools)
- Toolstore tools loaded as preamble via `loadSavedTools()`
- `run()` calls `session.run()`; returns formatted output string
- Exported from `src/index.ts`

### 2. Session creation (per sessionId)

```typescript
private async createSession(): Promise<Session> {
  const bridgeTools = createPiBridgeTools(this.cwd, { gateMutating: true });
  const builtinTools = createBuiltinTools({ root: this.cwd });
  const registry = new ToolRegistry([...bridgeTools, ...builtinTools]);
  const sandboxOpts: SandboxOptions = { registry };
  const preamble = await loadSavedTools({ root: this.cwd });
  return new Session(sandboxOpts, preamble || undefined);
}
```

### 3. Run flow

```
repl(code, sessionId?)
  → get or create Session for sessionId
  → session.run(code, { onApproval })
  → format result as string:
      ok:       stdout + output
      error:    error message + stdout
      suspended: "Tool '{tool}' requires approval. Use repl_resume to approve/deny."
```

### 4. Approval handling

The `onApproval` callback is wired through to `Session.run()`'s `runOpts.onApproval`. In the extension's `execute()`, it captures `ctx` and uses `ctx.ui.confirm()`:

```typescript
const onApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
  const approved = await ctx.ui.confirm(
    "Approve tool call?",
    `Allow ${req.description}?`
  );
  return approved;
};
```

For replay (session persistence): Session already auto-approves cached gated calls via its internal caching layer — no special handling needed at the repl level.

### 5. Extension tool definition (`extensions/repl-extension.ts`)

```typescript
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";  // or wherever TypeBox comes from

export default function(pi) {
  const runner = new ReplRunner(pi.cwd);

  pi.registerTool(defineTool({
    name: "repl",
    label: "Python REPL",
    description: `Execute Python code in a sandboxed environment...`,
    parameters: Type.Object({
      code: Type.String({ description: "Python code to execute" }),
      sessionId: Type.Optional(Type.String({ 
        description: "Session identifier. Reuse to persist variables across calls." 
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const onApproval = async (req) => {
        if (!ctx.hasUI) return false;
        return await ctx.ui.confirm("Approve tool call?", `Allow ${req.description}?`);
      };
      return {
        content: [{
          type: "text",
          text: await runner.run(params.code, params.sessionId, onApproval)
        }]
      };
    }
  }));

  // Also register repl_resume and repl_reset as convenience tools
  pi.registerTool(defineTool({
    name: "repl_resume",
    label: "Resume REPL",
    description: "Resume a suspended REPL session (approve or deny a pending tool call).",
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ description: "Session to resume" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const onApproval = async (req) => {
        if (!ctx.hasUI) return false;
        return await ctx.ui.confirm("Approve tool call?", `Allow ${req.description}?`);
      };
      return {
        content: [{
          type: "text",
          text: await runner.resume(params.sessionId ?? "default", onApproval)
        }]
      };
    }
  }));
}
```

Wait — TypeBox import. Let me check what's available. Pi uses `@earendil-works/pi-agent-core` which re-exports TypeBox. Actually, looking at the type definitions, `defineTool` takes `TParams extends TSchema`. Let me check what schema library is available.

Actually, from the types, it references `typebox` at the bottom: `import type { Static, TSchema } from "typebox"`. So TypeBox is the schema library.

Let me simplify: use `Type.Object`, `Type.String`, `Type.Optional` from `@sinclair/typebox`.

But wait — I need to verify TypeBox is available as a dependency or bundled. Let me check.

Actually, the pi-coding-agent has typebox as a dependency. Let me check in node_modules.

I'll verify this during implementation. For the plan, I'll note the TypeBox dependency.

### 6. Output format

```
[stdout]
<any printed output>

[result]
<return value>

---
Or for errors:
[error: runtime]
Traceback...

[stdout]
<any output before error>
```

### 7. Resume flow

When `run()` returns `suspended`, the extension stores the sessionId. The LLM can then call `repl_resume(sessionId)` which calls `session.resume()` with the approval decision obtained via `ctx.ui.confirm()`.

## Test Plan

### `test/repl.test.ts`

1. **Basic execution** — `runner.run("print('hello')")` → stdout contains "hello"
2. **Return value** — `runner.run("42")` → result contains "42"
3. **Session persistence** — Two runs on same sessionId: first defines variable, second uses it
4. **Session isolation** — Different sessionIds are independent
5. **Bridge tools** — Code calls `read(path)`, `ls(path)` — verify they work
6. **Builtin tools** — Code calls `read_file(path)`, `list_files(path)`, `http_get(url)`
7. **Toolstore preamble** — Saved tools are available as functions
8. **Error handling** — Syntax error, runtime error produce formatted error output
9. **Suspension/resume** — Gated tool triggers suspension; resume with approval
10. **Abandon** — `runner.abandon()` discards suspension
11. **Reset** — `runner.reset()` clears session state

### Test setup

- Create temp directory for cwd
- Stub `onApproval` callback (not real Pi UI)
- Use test fixtures for files, etc.

## Dependencies

- `@sinclair/typebox` — for tool parameter schemas (bundled via pi-coding-agent)
- All existing repl-simple modules (no new internal deps)

## Definition of Done

- [ ] `src/repl.ts` — ReplRunner class with run/resume/reset/abandon
- [ ] `extensions/repl-extension.ts` — registers repl, repl_resume tools
- [ ] `src/index.ts` — exports ReplRunner
- [ ] `test/repl.test.ts` — all test cases passing
- [ ] `npm test` passes (all existing + new tests)
- [ ] `npm run check` passes (type checking)
