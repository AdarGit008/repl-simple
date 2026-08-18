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
  DiscardedSuspension,
  RunResult,
  LlmClient,
  RlmOptions,
  RlmResult,
  RlmIteration,
  RlmBudgetReport,
} from "./types.js";
export { HostToolError } from "./types.js";

// ── Spend budget ────────────────────────────────────────────────
// The shared, observable spend budget (D2/D3). `estimateTokens` is the single
// swap point if a real tokenizer ever lands; `SpendBudget` is the mutable pool
// siblings share.
export { SpendBudget, estimateTokens } from "./budget.js";

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

// ── Path jail ───────────────────────────────────────────────────
// The one containment check the file-reading tools share. Exported so a host
// adding its own read tool confines it the same way rather than writing a
// second version — which is exactly how the bridged tools came to be
// unconfined (#43).
export { createPathJail, type PathJail, type PathJailOptions } from "./pathjail.js";

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
export {
  Session,
  DEFAULT_GRANT_USES,
  type GrantSummary,
  type SessionOptions,
} from "./session.js";

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
  savedToolNames,
  findShadowingBindings,
  DEFAULT_PREAMBLE_LIMITS,
  TOOLSTORE_TOOL_NAMES,
  escapeNoticeName,
  type PreambleLimits,
  type PreambleStatus,
  type PreambleFileIdentity,
  type RefusedTool,
  type UnreadableTool,
  type SavedToolsPreamble,
  type ToolStoreOptions,
} from "./toolstore.js";

// ── RLM (standalone runRlm) ─────────────────────────────────────
export {
  runRlm,
  extractPythonCode,
  extractDirectAnswer,
  type CodeExtraction,
  DEFAULT_RLM_SYSTEM_PROMPT,
} from "./rlm.js";

// ── Repl ────────────────────────────────────────────────────────
// The two outcome types are the return types of `abandon` and `reset`; a
// caller that switches on them needs their names.
export {
  ReplRunner,
  type AbandonOutcome,
  type ReplRunnerOptions,
  type ResetOutcome,
} from "./repl.js";

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
