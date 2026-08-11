# repl-simple

Pi extension — sandboxed Python execution via [Monty](https://github.com/pydantic/monty) (Python-in-WebAssembly interpreter).

## Tools

### REPL (direct)

| Tool | Description |
|------|-------------|
| `repl(code, sessionId?)` | Execute Python in a named session. Variables persist across calls. |
| `repl_resume(sessionId?)` | Resume after a gated tool requires approval. |
| `repl_reset(sessionId?)` | Clear all state in a session. |
| `repl_abandon(sessionId?)` | Discard a pending tool approval. |

### RLM Loop (auto-investigation)

`RLMLoop` runs a code-gen → execute loop: LLM writes Python, sandbox runs it, results fed back until `SUBMIT(answer)`.

| Tool | Description |
|------|-------------|
| `llm_query(prompt)` | Ask the LLM a question from sandbox code. |
| `rlm_query(query, context?)` | Spawn a nested RLM investigation. |
| `SUBMIT(answer)` | Signal completion with final answer. |

### Available Python-side tools

**Pi bridge:** `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`

**Builtins:** `read_file`, `list_files`, `http_get`

**Tool store:** `save_tool`, `delete_tool`, `list_saved_tools`, `read_tool`

## API

```typescript
import {
  // REPL
  ReplRunner,
  // RLM Loop
  RLMLoop,
  getReplPreamble,
  // Sandbox
  runInSandbox,
  resumeSuspended,
  // Session
  Session,
  // Tool composition
  ToolRegistry,
  createPiBridgeTools,
  createBuiltinTools,
  createRLMTools,
  createToolStoreTools,
  loadSavedTools,
  // Types
  HostToolError,
  SubmitSignal,
} from "repl-simple";
```

## Install

```json
{
  "dependencies": {
    "repl-simple": "*"
  }
}
```

The `pi.extensions` field in `package.json` auto-loads `extensions/repl-extension.ts` to register `repl` tools.

## Dev

```bash
npm test        # tsx --test test/*.test.ts
npm run check   # tsc --noEmit
npm run build   # tsc
```
