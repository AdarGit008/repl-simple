// Shared types for repl-simple Pi extension

/** Parameter definition for a HostTool */
export interface HostToolParam {
  name: string;
  type: "str" | "bool" | "int" | "float";
  description: string;
  optional?: boolean;
}

/** A host-side tool available to sandboxed Python code */
export interface HostTool {
  name: string;
  description: string;
  params: HostToolParam[];
  returns: "str" | "void";
  execute(args: Record<string, unknown>): string | Promise<string>;
  requiresApproval?: boolean;
}

/** Approval request from a gated tool call */
export interface ApprovalRequest {
  tool: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  description: string;
}

/** Approval decision: true = approved, false = denied, 'suspend' = pause for later resume */
export type ApprovalDecision = boolean | "suspend";

/** Resource limits for a sandbox run */
export interface RunLimits {
  maxDurationSecs: number;
  maxMemory?: number;
}

/** Runtime options for a sandbox execution */
export interface RunOptions {
  inputs?: Record<string, string>;
  mount?: Record<string, string>;
  signal?: AbortSignal;
  onPrint?: (text: string) => void;
  onApproval?: (
    request: ApprovalRequest,
  ) => ApprovalDecision | Promise<ApprovalDecision>;
  maxStdoutBytes?: number;
  scriptName?: string;
  limits?: RunLimits;
}

/** Trace of a single host-tool call during execution */
export interface ToolCallTrace {
  tool: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: string;
  approved?: boolean;
}

/** Kinds of run errors */
export type RunErrorKind = "syntax" | "typing" | "runtime" | "aborted";

/** Successful run result */
export interface RunOk {
  status: "ok";
  output: string;
  stdout: string;
  stdoutTruncated: boolean;
  calls: ToolCallTrace[];
}

/** Errored run result */
export interface RunError {
  status: "error";
  error: string;
  errorKind: RunErrorKind;
  stdout: string;
  stdoutTruncated: boolean;
  calls: ToolCallTrace[];
}

/** Suspended run result (waiting for approval) */
export interface RunSuspended {
  status: "suspended";
  suspendedCall: ApprovalRequest;
  /** Serialized MontySnapshot — pass to resumeSuspended() to continue. */
  snapshot: Buffer;
  stdout: string;
  stdoutTruncated: boolean;
  calls: ToolCallTrace[];
}

/** Discriminated union of run outcomes */
export type RunResult = RunOk | RunError | RunSuspended;

/**
 * Error thrown by a host tool that should surface as a Python exception
 * in the sandbox.
 *
 * The `pythonType` property maps to the Python exception class name
 * (e.g. "TypeError", "PermissionError", "RuntimeError", "_SubmitSignal").
 */
export class HostToolError extends Error {
  pythonType: string;

  constructor(pythonType: string, message: string) {
    super(message);
    this.name = "HostToolError";
    this.pythonType = pythonType;
  }
}
