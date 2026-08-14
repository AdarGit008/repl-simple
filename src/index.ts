// ── Types ────────────────────────────────────────────────────────
export type {
  HostToolParam,
  HostTool,
  ApprovalRequest,
  ApprovalDecision,
  RunLimits,
  RunOptions,
  ToolCallTrace,
  RunErrorKind,
  RunOk,
  RunError,
  RunSuspended,
  RunResult,
  LlmClient,
  RlmOptions,
  RlmResult,
  RlmIteration,
} from "./types.js";
export { HostToolError } from "./types.js";

// ── Registry ────────────────────────────────────────────────────
export {
  ToolRegistry,
  arg,
  requireString,
  CANDIDATE_MODULES,
  probeImportableModules,
  probeTypeCheckerGaps,
  renderPythonToolRules,
} from "./registry.js";

// ── Builtins ────────────────────────────────────────────────────
export { createBuiltinTools, type BuiltinToolsOptions } from "./builtins.js";

// ── Bridge ──────────────────────────────────────────────────────
export { createPiBridgeTools, type BridgeOptions } from "./bridge.js";

// ── Sandbox ─────────────────────────────────────────────────────
export {
  runInSandbox,
  resumeSuspended,
  resolveToolArgs,
  SandboxMemoryError,
  memoryGuardConfig,
  limitsConfig,
  type SandboxOptions,
} from "./sandbox.js";

// ── Worker pool ─────────────────────────────────────────────────
// Python runs in pooled worker subprocesses, so a host that wants to release
// them needs these. Resizing the pool means `closeSandboxPool()` and then
// letting the next run rebuild it: the size is fixed when the pool is created.
export {
  getSandboxPool,
  closeSandboxPool,
  poolConfig,
  SandboxUnavailableError,
} from "./pool.js";

// ── Session ─────────────────────────────────────────────────────
export { Session } from "./session.js";

// ── RLM Tools ───────────────────────────────────────────────────
export { createRLMTools, type RLMToolOptions } from "./rlm_tools.js";
export { SubmitSignal } from "./submit_signal.js";

// ── RLM Loop ────────────────────────────────────────────────────
export {
  RLMLoop,
  getReplPreamble,
  type RLMLoopOptions,
  type RLMLoopResult,
  type RlmMessage,
} from "./rlm_loop.js";

// ── Tool Store ──────────────────────────────────────────────────
export {
  createToolStoreTools,
  loadSavedTools,
  type ToolStoreOptions,
} from "./toolstore.js";

// ── RLM (standalone runRlm) ─────────────────────────────────────
export {
  runRlm,
  extractPythonCode,
  DEFAULT_RLM_SYSTEM_PROMPT,
} from "./rlm.js";

// ── Repl ────────────────────────────────────────────────────────
export { ReplRunner } from "./repl.js";

// ── Truncation ──────────────────────────────────────────────────
// The single implementation behind every model-facing byte cap.
// Policy: docs/truncation-policy.md.
export {
  Truncator,
  truncateText,
  formatSize,
  decodeWhole,
  STDOUT_MAX_BYTES,
  OUTPUT_MAX_BYTES,
  STDOUT_MAX_LINES,
  STDOUT_HEAD_RATIO,
  VALUE_HEAD_RATIO,
  HEAD_ONLY_RATIO,
  type TruncatorOptions,
} from "./truncate.js";
