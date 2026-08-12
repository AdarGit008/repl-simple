import {
  Monty,
  MontySnapshot,
  MontyNameLookup,
  MontyComplete,
  MontyRuntimeError,
  MontySyntaxError,
  MontyTypingError,
  MountDir,
  type ResourceLimits,
} from "@pydantic/monty";
import { type ToolRegistry, probeTypeCheckerGaps } from "./registry.js";
import {
  Truncator,
  STDOUT_MAX_BYTES,
  STDOUT_MAX_LINES,
  STDOUT_HEAD_RATIO,
  STDOUT_RECOVERY,
} from "./truncate.js";
import { HostToolError } from "./types.js";
import { SubmitSignal } from "./submit_signal.js";
import type {
  HostTool,
  RunResult,
  RunSuspended,
  ToolCallTrace,
  ApprovalRequest,
  ApprovalDecision,
  RunOptions,
  RunLimits,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MAX_STDOUT = STDOUT_MAX_BYTES;

/**
 * Sentinel function used at NameLookup to satisfy Monty's type checker.
 * The real tool dispatch happens at Snapshot time when we have
 * functionName + args + kwargs.
 */
const SENTINEL = () => "";

// ── Dispatch loop accumulators ───────────────────────────────────

/**
 * Mutable state carried across iterations of the dispatch loop.
 *
 * Owned by the entry point that builds it and mutated in place — by the loop,
 * and concurrently by the print callback and abort listener Monty invokes while
 * the loop awaits a resume. Nothing may hold a copy of any field (#27).
 *
 * `stdout` is a projection of the `Truncator`, not a field: the accumulator
 * keeps a bounded head and tail plus true counters, and renders the elided form
 * only when a result is built.
 */
class DispatchAccumulators {
  readonly calls: ToolCallTrace[];
  aborted = false;
  private readonly out: Truncator;

  constructor(maxStdout: number, prior?: RunSuspended) {
    this.out = new Truncator({
      maxBytes: maxStdout,
      headRatio: STDOUT_HEAD_RATIO,
      maxLines: STDOUT_MAX_LINES,
      recovery: STDOUT_RECOVERY,
      truncatedBefore: prior?.stdoutTruncated,
    });
    this.calls = prior ? [...prior.calls] : [];
    // Stdout carried across a suspend/resume boundary is re-accumulated from
    // its rendered form: `RunSuspended` transports the string, not the head,
    // tail and counters behind it. Cross-call stdout semantics are #61's.
    if (prior?.stdout) this.out.push(prior.stdout);
  }

  print(text: string): void {
    this.out.push(text);
  }

  get stdout(): string {
    return this.out.render();
  }

  get stdoutTruncated(): boolean {
    return this.out.truncated;
  }
}

/**
 * The one print callback. Both entry points hand this to Monty — as
 * `startOpts.printCallback` and as `MontySnapshot.load()`'s — and it is the
 * only thing that writes stdout.
 */
function makePrintCallback(
  acc: DispatchAccumulators,
  runOpts: RunOptions | undefined,
): (stream: string, text: string) => void {
  return (_stream: string, text: string) => {
    // Unconditional, and before the accumulator: the human's live stream is not
    // the model's context window and must not share its budget. Gating this on
    // truncation silenced the terminal mid-run (M9).
    runOpts?.onPrint?.(text);
    acc.print(text);
  };
}

// ── Options ──────────────────────────────────────────────────────

/** Options for creating a sandbox runner. */
export interface SandboxOptions {
  /** Tool registry with host tools available to Python code. */
  registry: ToolRegistry;
}

// ── Private helpers ──────────────────────────────────────────────

/**
 * Build the type-check prefix: tool stubs + gap declarations.
 * Gaps are runtime names Monty's type checker rejects (e.g. `open`,
 * `PermissionError`) — we declare them as `name: Any = None`.
 */
function buildTypeCheckPrefix(registry: ToolRegistry, inputNames: string[]): string {
  const stubs = registry.renderTypeStubs();
  const gaps = probeTypeCheckerGaps();
  const parts: string[] = [];
  // "from typing import Any" must come first for gap/stub/input declarations
  const needsAny =
    gaps.length > 0 || inputNames.length > 0 || (stubs.length > 0 && stubs.includes("Any"));
  if (needsAny) {
    parts.push("from typing import Any");
  }
  if (stubs) parts.push(stubs);
  if (inputNames.length > 0) {
    parts.push(...inputNames.map((name) => `${name}: Any = None`));
  }
  if (gaps.length > 0) {
    parts.push(...gaps.map((name) => `${name}: Any = None`));
  }
  return parts.join("\n");
}

/** Format a Monty value for output. Python `None` → `"None"`. */
function formatOutput(value: unknown): string {
  if (value === null || value === undefined) return "None";
  return String(value);
}

/**
 * Build an ApprovalRequest from a tool and the raw Monty args/kwargs.
 * Constructs a human-readable description from the tool's metadata.
 */
function buildApprovalRequest(
  tool: HostTool,
  args: unknown[],
  kwargs: Record<string, unknown>,
): ApprovalRequest {
  const paramParts = tool.params.map((p, i) => {
    const val = i < args.length ? args[i] : kwargs[p.name];
    return `${p.name}=${JSON.stringify(val)}`;
  });
  return {
    tool: tool.name,
    args,
    kwargs,
    description: `${tool.name}(${paramParts.join(", ")})`,
  };
}

/** Resolve tool args from Monty positional+keyword into a flat Record. */
export function resolveToolArgs(
  tool: HostTool,
  args: unknown[],
  kwargs: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (let i = 0; i < tool.params.length; i++) {
    const param = tool.params[i];
    // Python-style: positional takes priority, keyword duplicate is an error
    const hasPositional = i < args.length;
    const hasKeyword = param.name in kwargs;
    if (hasPositional && hasKeyword) {
      throw new HostToolError(
        "TypeError",
        `${tool.name}() got multiple values for argument '${param.name}'`,
      );
    }
    if (hasPositional) {
      resolved[param.name] = args[i];
    } else if (hasKeyword) {
      resolved[param.name] = kwargs[param.name];
    }
    // If neither, param is left undefined (caller handles optional/defaults)
  }
  return resolved;
}

/** Convert our RunLimits to Monty's ResourceLimits. */
function toResourceLimits(limits?: RunLimits): ResourceLimits | undefined {
  if (!limits) return undefined;
  return {
    maxDurationSecs: limits.maxDurationSecs,
    maxMemory: limits.maxMemory,
  };
}

/** Build MountDir[] from the mount map in RunOptions. */
function buildMounts(mount?: Record<string, string>): MountDir[] | undefined {
  if (!mount) return undefined;
  const dirs: MountDir[] = [];
  for (const [virtualPath, hostPath] of Object.entries(mount)) {
    dirs.push(new MountDir(virtualPath, hostPath, { mode: "overlay" }));
  }
  return dirs.length > 0 ? dirs : undefined;
}

// ── Shared dispatch loop ─────────────────────────────────────────

/**
 * Core start/resume loop shared by `runInSandbox()` and
 * `resumeSuspended()`.
 *
 * Dispatches Monty pauses (Complete → NameLookup → Snapshot)
 * in a `while(true)` loop until execution completes, errors,
 * or suspends awaiting tool approval.
 *
 * `acc` is owned by the caller and mutated in place — by this loop, and
 * concurrently by the caller's `printCallback` and abort listener, which
 * Monty invokes while the loop is awaiting a resume.
 */
async function runDispatchLoop(
  current: MontySnapshot | MontyNameLookup | MontyComplete,
  registry: ToolRegistry,
  runOpts: RunOptions | undefined,
  acc: DispatchAccumulators,
): Promise<RunResult> {
  while (true) {
    // Abort check between iterations
    if (acc.aborted) {
      return {
        status: "error",
        error: "execution aborted",
        errorKind: "aborted",
        stdout: acc.stdout,
        stdoutTruncated: acc.stdoutTruncated,
        calls: acc.calls,
      };
    }

    if (current instanceof MontyComplete) {
      return {
        status: "ok",
        output: formatOutput(current.output),
        stdout: acc.stdout,
        stdoutTruncated: acc.stdoutTruncated,
        calls: acc.calls,
      };
    }

    if (current instanceof MontyNameLookup) {
      const name = current.variableName;
      const tool = registry.get(name);
      try {
        if (tool) {
          current = current.resume({ value: SENTINEL });
        } else {
          current = current.resume();
        }
      } catch (err) {
        if (err instanceof MontyRuntimeError) {
          return {
            status: "error",
            error: err.message,
            errorKind: "runtime",
            stdout: acc.stdout,
            stdoutTruncated: acc.stdoutTruncated,
            calls: acc.calls,
          };
        }
        throw err;
      }
      continue;
    }

    // MontySnapshot — external function call
    const snapshot = current;
    const funcName = snapshot.functionName;
    const tool = registry.get(funcName);

    if (!tool) {
      try {
        current = snapshot.resume({
          exception: {
            type: "NameError",
            message: `name '${funcName}' is not defined`,
          },
        });
      } catch (err) {
        if (err instanceof MontyRuntimeError) {
          return {
            status: "error",
            error: err.message,
            errorKind: "runtime",
            stdout: acc.stdout,
            stdoutTruncated: acc.stdoutTruncated,
            calls: acc.calls,
          };
        }
        throw err;
      }
      continue;
    }

    // Resolve args from positional+keyword to flat Record
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveToolArgs(
        tool,
        snapshot.args as unknown[],
        snapshot.kwargs as Record<string, unknown>,
      );
    } catch (err) {
      acc.calls.push({
        tool: tool.name,
        args: snapshot.args as unknown[],
        kwargs: snapshot.kwargs as Record<string, unknown>,
        durationMs: 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        current = snapshot.resume({
          exception: {
            type: err instanceof HostToolError ? err.pythonType : "TypeError",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (resumeErr) {
        if (resumeErr instanceof MontyRuntimeError) {
          return {
            status: "error",
            error: resumeErr.message,
            errorKind: "runtime",
            stdout: acc.stdout,
            stdoutTruncated: acc.stdoutTruncated,
            calls: acc.calls,
          };
        }
        throw resumeErr;
      }
      continue;
    }

    // Approval gate
    let approved: boolean | undefined;
    if (tool.requiresApproval) {
      const req = buildApprovalRequest(
        tool,
        snapshot.args as unknown[],
        snapshot.kwargs as Record<string, unknown>,
      );
      const decision = runOpts?.onApproval ? await runOpts.onApproval(req) : false;

      if (decision === "suspend") {
        return {
          status: "suspended",
          suspendedCall: req,
          snapshot: snapshot.dump(),
          stdout: acc.stdout,
          stdoutTruncated: acc.stdoutTruncated,
          calls: acc.calls,
        };
      }

      if (!decision) {
        // Denied (or no callback) → PermissionError in Python
        acc.calls.push({
          tool: tool.name,
          args: snapshot.args as unknown[],
          kwargs: snapshot.kwargs as Record<string, unknown>,
          durationMs: 0,
          ok: false,
          approved: false,
          error: `tool '${tool.name}' requires approval`,
        });
        try {
          current = snapshot.resume({
            exception: {
              type: "PermissionError",
              message: `tool '${tool.name}' requires approval`,
            },
          });
        } catch (err) {
          if (err instanceof MontyRuntimeError) {
            return {
              status: "error",
              error: err.message,
              errorKind: "runtime",
              stdout: acc.stdout,
              stdoutTruncated: acc.stdoutTruncated,
              calls: acc.calls,
            };
          }
          throw err;
        }
        continue;
      }

      approved = true;
    }

    // Execute the tool
    const t0 = performance.now();
    try {
      const returnValue = await tool.execute(resolvedArgs);
      const durationMs = performance.now() - t0;
      acc.calls.push({
        tool: tool.name,
        args: snapshot.args as unknown[],
        kwargs: snapshot.kwargs as Record<string, unknown>,
        durationMs,
        ok: true,
        approved,
      });
      current = snapshot.resume({ returnValue });
    } catch (err) {
      const durationMs = performance.now() - t0;
      // SubmitSignal — clean termination
      if (err instanceof SubmitSignal) {
        acc.calls.push({
          tool: tool.name,
          args: snapshot.args as unknown[],
          kwargs: snapshot.kwargs as Record<string, unknown>,
          durationMs,
          ok: true,
          approved,
        });
        return {
          status: "ok",
          output: err.answer,
          stdout: acc.stdout,
          stdoutTruncated: acc.stdoutTruncated,
          calls: acc.calls,
        };
      }
      if (err instanceof HostToolError) {
        acc.calls.push({
          tool: tool.name,
          args: snapshot.args as unknown[],
          kwargs: snapshot.kwargs as Record<string, unknown>,
          durationMs,
          ok: false,
          error: err.message,
          approved,
        });
        try {
          current = snapshot.resume({
            exception: { type: err.pythonType, message: err.message },
          });
        } catch (resumeErr) {
          if (resumeErr instanceof MontyRuntimeError) {
            return {
              status: "error",
              error: resumeErr.message,
              errorKind: "runtime",
              stdout: acc.stdout,
              stdoutTruncated: acc.stdoutTruncated,
              calls: acc.calls,
            };
          }
          throw resumeErr;
        }
      } else {
        // Non-HostToolError → RuntimeError in Python
        const message = err instanceof Error ? err.message : String(err);
        acc.calls.push({
          tool: tool.name,
          args: snapshot.args as unknown[],
          kwargs: snapshot.kwargs as Record<string, unknown>,
          durationMs,
          ok: false,
          error: message,
          approved,
        });
        try {
          current = snapshot.resume({
            exception: { type: "RuntimeError", message },
          });
        } catch (resumeErr) {
          if (resumeErr instanceof MontyRuntimeError) {
            return {
              status: "error",
              error: resumeErr.message,
              errorKind: "runtime",
              stdout: acc.stdout,
              stdoutTruncated: acc.stdoutTruncated,
              calls: acc.calls,
            };
          }
          throw resumeErr;
        }
      }
    }
    // Loop back for next pause point
  }
}

// ── Main API ─────────────────────────────────────────────────────

/**
 * Execute Python code in a sandboxed Monty interpreter.
 *
 * Returns a discriminated `RunResult`:
 * - `{ status: "ok" }` — code ran to completion
 * - `{ status: "error" }` — syntax/typing/runtime/aborted error
 * - `{ status: "suspended" }` — awaiting approval on a gated tool call
 */
export async function runInSandbox(
  code: string,
  options: SandboxOptions,
  runOpts?: RunOptions,
): Promise<RunResult> {
  const registry = options.registry;
  const maxStdout = runOpts?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const scriptName = runOpts?.scriptName ?? "<repl>";

  // Accumulators. Built here, before `printCallback` and `onAbort`, because
  // both mutate `acc` and both are handed to Monty before the dispatch loop
  // is entered. Nothing below may read a local copy of this state.
  const acc = new DispatchAccumulators(maxStdout);

  const onAbort = () => {
    acc.aborted = true;
  };
  if (runOpts?.signal) {
    runOpts.signal.addEventListener("abort", onAbort, { once: true });
    if (runOpts.signal.aborted) acc.aborted = true;
  }

  const printCallback = makePrintCallback(acc, runOpts);

  // ── 1. Build type-check prefix ──────────────────────────────
  const inputNames = Object.keys(runOpts?.inputs ?? {});
  const typeCheckPrefix = buildTypeCheckPrefix(registry, inputNames);

  // ── 2. Construct Monty instance (without typeCheck to preserve
  //        syntax vs typing error distinction) ────────────────
  let monty: Monty;
  try {
    monty = new Monty(code, {
      scriptName,
      inputs: Object.keys(runOpts?.inputs ?? {}),
    });
  } catch (err) {
    if (err instanceof MontySyntaxError) {
      return {
        status: "error",
        error: err.message,
        errorKind: "syntax",
        stdout: acc.stdout,
        stdoutTruncated: acc.stdoutTruncated,
        calls: acc.calls,
      };
    }
    throw err;
  }

  // ── 2b. Type check separately (after syntax parse succeeds) ─
  try {
    monty.typeCheck(typeCheckPrefix || undefined);
  } catch (err) {
    if (err instanceof MontyTypingError) {
      return {
        status: "error",
        error: err.message,
        errorKind: "typing",
        stdout: acc.stdout,
        stdoutTruncated: acc.stdoutTruncated,
        calls: acc.calls,
      };
    }
    throw err;
  }

  // ── 3. Build start options ──────────────────────────────────
  const limits = toResourceLimits(runOpts?.limits);
  const mount = buildMounts(runOpts?.mount);
  const declaredInputs = monty.inputs;
  const startOpts: Record<string, unknown> = {
    limits,
    printCallback,
    mount,
  };
  if (declaredInputs.length > 0 && runOpts?.inputs) {
    startOpts.inputs = runOpts.inputs;
  }

  // ── 4. Start and dispatch ───────────────────────────────────
  let current: MontySnapshot | MontyNameLookup | MontyComplete;
  try {
    current = monty.start(startOpts as Parameters<typeof monty.start>[0]);
  } catch (err) {
    if (err instanceof MontyRuntimeError) {
      return {
        status: "error",
        error: err.message,
        errorKind: "runtime",
        stdout: acc.stdout,
        stdoutTruncated: acc.stdoutTruncated,
        calls: acc.calls,
      };
    }
    throw err;
  }

  return await runDispatchLoop(current, registry, runOpts, acc);
}

// ── Resume suspended execution ──────────────────────────────────

/**
 * Resume a sandbox execution that was suspended for tool approval.
 *
 * Loads the serialized `MontySnapshot` from `suspended.snapshot`,
 * applies the approval `decision`, and continues the start/resume loop.
 *
 * Returns the same discriminated `RunResult` as `runInSandbox()`.
 */
export async function resumeSuspended(
  suspended: RunSuspended,
  decision: ApprovalDecision,
  options: SandboxOptions,
  runOpts?: RunOptions,
): Promise<RunResult> {
  const registry = options.registry;
  const maxStdout = runOpts?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;

  // Accumulators — carry over from suspended state. Built here, before
  // `printCallback` and `onAbort`, because both mutate `acc` and both are
  // handed to Monty before the dispatch loop is entered. The prologue below
  // pushes through `acc.calls` for the same reason.
  const acc = new DispatchAccumulators(maxStdout, suspended);

  const onAbort = () => {
    acc.aborted = true;
  };
  if (runOpts?.signal) {
    runOpts.signal.addEventListener("abort", onAbort, { once: true });
    if (runOpts.signal.aborted) acc.aborted = true;
  }

  const printCallback = makePrintCallback(acc, runOpts);

  // Load the snapshot with printCallback attached
  const snapshot: MontySnapshot = MontySnapshot.load(suspended.snapshot, {
    printCallback,
  });
  const tool = registry.get(suspended.suspendedCall.tool);

  let current: MontySnapshot | MontyNameLookup | MontyComplete;

  // Replay the approval decision
  if (decision === true && tool) {
    const t0 = performance.now();
    try {
      const resolvedArgs = resolveToolArgs(
        tool,
        suspended.suspendedCall.args,
        suspended.suspendedCall.kwargs,
      );
      const returnValue = await tool.execute(resolvedArgs);
      acc.calls.push({
        tool: tool.name,
        args: suspended.suspendedCall.args,
        kwargs: suspended.suspendedCall.kwargs,
        durationMs: performance.now() - t0,
        ok: true,
        approved: true,
      });
      current = snapshot.resume({ returnValue });
    } catch (err) {
      const durationMs = performance.now() - t0;
      if (err instanceof SubmitSignal) {
        acc.calls.push({
          tool: tool.name,
          args: suspended.suspendedCall.args,
          kwargs: suspended.suspendedCall.kwargs,
          durationMs,
          ok: true,
          approved: true,
        });
        return {
          status: "ok",
          output: err.answer,
          stdout: acc.stdout,
          stdoutTruncated: acc.stdoutTruncated,
          calls: acc.calls,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      const pythonType = err instanceof HostToolError ? err.pythonType : "RuntimeError";
      acc.calls.push({
        tool: tool.name,
        args: suspended.suspendedCall.args,
        kwargs: suspended.suspendedCall.kwargs,
        durationMs,
        ok: false,
        error: message,
        approved: true,
      });
      current = snapshot.resume({
        exception: { type: pythonType, message },
      });
    }
  } else if (decision === false || !tool) {
    const excType = !tool ? "NameError" : "PermissionError";
    const excMsg = !tool
      ? `name '${suspended.suspendedCall.tool}' is not defined`
      : `tool '${tool.name}' requires approval`;
    acc.calls.push({
      tool: suspended.suspendedCall.tool,
      args: suspended.suspendedCall.args,
      kwargs: suspended.suspendedCall.kwargs,
      durationMs: 0,
      ok: false,
      approved: false,
      error: excMsg,
    });
    current = snapshot.resume({
      exception: { type: excType, message: excMsg },
    });
  } else {
    return {
      status: "suspended",
      suspendedCall: suspended.suspendedCall,
      snapshot: suspended.snapshot,
      stdout: acc.stdout,
      stdoutTruncated: acc.stdoutTruncated,
      calls: acc.calls,
    };
  }

  // Continue via shared dispatch loop
  return await runDispatchLoop(current, registry, runOpts, acc);
}
