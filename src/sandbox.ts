import { readFileSync } from "node:fs";
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
  truncateText,
  STDOUT_MAX_BYTES,
  STDOUT_MAX_LINES,
  STDOUT_HEAD_RATIO,
  STDOUT_RECOVERY,
  OUTPUT_MAX_BYTES,
  VALUE_HEAD_RATIO,
  VALUE_RECOVERY,
} from "./truncate.js";
import { HostToolError } from "./types.js";
import { SubmitSignal } from "./submit_signal.js";
import type {
  HostTool,
  RunResult,
  RunError,
  RunSuspended,
  ToolCallTrace,
  ApprovalRequest,
  ApprovalDecision,
  RunOptions,
  RunLimits,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MAX_STDOUT = STDOUT_MAX_BYTES;
const DEFAULT_MAX_OUTPUT = OUTPUT_MAX_BYTES;

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
 * Classify an error thrown by *resuming Python* into a `RunError`.
 *
 * Every `resume()` in this file can raise `MontyRuntimeError`: the resumed code
 * may raise, and — once #32 lands default limits — may breach `maxDurationSecs`
 * or `maxMemory` on any instruction it executes after the resume. That is a run
 * outcome, not a host fault, so it becomes a `RunError`. Anything else is a bug
 * in this file and rethrows unchanged.
 *
 * It exists as a function so the guard is one shape at every call site. The
 * defect behind #36 was not a wrong classification — it was a `resume()` that
 * sat inside a `try` written for something else and so reached a handler with
 * no branch for this case at all.
 */
function classifyResumeError(err: unknown, acc: DispatchAccumulators): RunError {
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

// ── Memory guards ────────────────────────────────────────────────

/**
 * Refuse to start new sandbox work when memory is already gone.
 *
 * Every `runInSandbox` call leaks ~41 MB of native memory, because
 * `probeTypeCheckerGaps()` constructs `new Monty(name, { typeCheck: true })`
 * per candidate and that constructor never gives the memory back (#68). The
 * leak is native, so it is invisible to V8: `heapUsed` stays flat, no GC
 * pressure builds, no heap-limit abort fires. The process simply grows until
 * the kernel kills something.
 *
 * On 2026-08-13 that was a worker holding 13.4 GB, and because tmux panes run
 * under `DefaultOOMPolicy=stop`, systemd responded by tearing down the whole
 * pane — editor session included, SIGTERM, no message printed. The failure is
 * silent at every layer, which is what makes it worth failing loudly here.
 *
 * Two independent limits, because there are two independent ways to get there:
 *   - CEILING catches one process running away on its own.
 *   - FLOOR catches many well-behaved processes adding up — two suites in
 *     parallel, Stryker's workers, a second agent. No process is at fault, so
 *     a per-process limit cannot see it.
 *
 * These are backstops, not a fix. Remove them when #68 removes the leak.
 */
export class SandboxMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxMemoryError";
  }
}

/** Per-process RSS ceiling, MB. 0 disables. Above the 3.9 GB a single heavy test file reaches. */
const DEFAULT_MEMORY_CEILING_MB = 5120;
/** System available-memory floor, MB. 0 disables. */
const DEFAULT_MEMORY_FLOOR_MB = 3072;

/** Read at call time, not module load, so a caller can change it between runs. */
function envMb(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Available system memory in bytes, or null where that cannot be known.
 * `os.freemem()` is not a substitute: on Linux it reports MemFree, which
 * excludes reclaimable page cache and so reads as alarmingly low on a healthy
 * box. Only MemAvailable answers "could an allocation succeed". Absent on
 * macOS, where the check is skipped rather than guessed — CI runs there.
 */
function availableMemoryBytes(): number | null {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** Throws rather than returning a RunError: this is the host in trouble, not the user's code. */
function assertMemoryHeadroom(): void {
  const ceilingMb = envMb("REPL_MEMORY_CEILING_MB", DEFAULT_MEMORY_CEILING_MB);
  if (ceilingMb > 0) {
    const rssMb = Math.round(process.memoryUsage.rss() / 1_048_576);
    if (rssMb >= ceilingMb) {
      throw new SandboxMemoryError(
        `sandbox refused: this process holds ${rssMb} MB, at or above the ${ceilingMb} MB ceiling. ` +
          "Every sandbox run leaks ~41 MB (#68); a process this large is about to be OOM-killed. " +
          "Restart the process, or raise REPL_MEMORY_CEILING_MB if you know what you are doing.",
      );
    }
  }

  const floorMb = envMb("REPL_MEMORY_FLOOR_MB", DEFAULT_MEMORY_FLOOR_MB);
  if (floorMb > 0) {
    const available = availableMemoryBytes();
    if (available !== null) {
      const availableMb = Math.round(available / 1_048_576);
      if (availableMb <= floorMb) {
        throw new SandboxMemoryError(
          `sandbox refused: only ${availableMb} MB available on this host, at or below the ` +
            `${floorMb} MB floor. Something is exhausting memory — often a second test suite or ` +
            "a Stryker run. Wait for it, or raise REPL_MEMORY_FLOOR_MB.",
        );
      }
    }
  }
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
 * Cap `output` at its byte budget.
 *
 * Applied wherever a `RunOk` is built, not at the point the tool result is
 * rendered, so that every consumer is covered by one cap: the `repl` tool
 * result, and the RLM loop, whose prompts otherwise grow by a full copy of any
 * snippet ending in a bare expression (A23).
 *
 * Uniform across the SUBMIT paths too. A field with two truncation policies
 * depending on which return site produced it is exactly the drift
 * docs/truncation-policy.md exists to prevent.
 */
function capOutput(
  text: string,
  runOpts: RunOptions | undefined,
): { output: string; outputTruncated: boolean } {
  const { text: output, truncated } = truncateText(text, {
    maxBytes: runOpts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
    headRatio: VALUE_HEAD_RATIO,
    recovery: VALUE_RECOVERY,
  });
  return { output, outputTruncated: truncated };
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
        ...capOutput(formatOutput(current.output), runOpts),
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
        return classifyResumeError(err, acc);
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
        return classifyResumeError(err, acc);
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
        return classifyResumeError(resumeErr, acc);
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
          return classifyResumeError(err, acc);
        }
        continue;
      }

      approved = true;
    }

    // Execute the tool.
    //
    // This `try` covers `tool.execute` and nothing else. `snapshot.resume` used
    // to sit inside it, which made a `MontyRuntimeError` from *Python resuming*
    // — a duration, memory or recursion breach — arrive at a handler written
    // for tool faults: it pushed a second trace entry for a call already
    // recorded `ok: true`, then resumed the same snapshot a second time, and
    // the resulting `GenericFailure` escaped `runInSandbox` uncaught (#36).
    const t0 = performance.now();
    let returnValue: unknown;
    try {
      returnValue = await tool.execute(resolvedArgs);
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
          ...capOutput(err.answer, runOpts),
          stdout: acc.stdout,
          stdoutTruncated: acc.stdoutTruncated,
          calls: acc.calls,
        };
      }
      // A `HostToolError` carries the Python type to re-raise; anything else
      // reaches Python as a RuntimeError.
      const message = err instanceof Error ? err.message : String(err);
      const pythonType = err instanceof HostToolError ? err.pythonType : "RuntimeError";
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
        current = snapshot.resume({ exception: { type: pythonType, message } });
      } catch (resumeErr) {
        return classifyResumeError(resumeErr, acc);
      }
      continue;
    }

    // The tool returned. Trace it once, here — the resume below is outside the
    // `try` above precisely so it cannot reach a handler that would record this
    // same call a second time.
    acc.calls.push({
      tool: tool.name,
      args: snapshot.args as unknown[],
      kwargs: snapshot.kwargs as Record<string, unknown>,
      durationMs: performance.now() - t0,
      ok: true,
      approved,
    });
    try {
      current = snapshot.resume({ returnValue });
    } catch (err) {
      return classifyResumeError(err, acc);
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
  assertMemoryHeadroom();
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
  assertMemoryHeadroom();
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

  // Abort before the prologue, not after it. `runDispatchLoop` checks
  // `acc.aborted` at the top of every iteration, but the approval replay below
  // runs *before* that loop is entered, so its check reports an abort the side
  // effect has already outrun. The calls that reach this path are by definition
  // the gated ones — `bash`, `write`, `edit` — so "too late" means the shell
  // command ran or the file was written (#28). Returning here also spares the
  // deny branch a pointless Python resume. Nothing has been traced yet, and
  // nothing should be: the trace must not claim a call that never ran.
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

  const printCallback = makePrintCallback(acc, runOpts);

  // Load the snapshot with printCallback attached
  const snapshot: MontySnapshot = MontySnapshot.load(suspended.snapshot, {
    printCallback,
  });
  const tool = registry.get(suspended.suspendedCall.tool);

  // Replay the approval decision.
  //
  // Each branch decides *what* to resume Python with and traces the call; the
  // single guarded `snapshot.resume` below then performs it. Keeping the resume
  // out of the branches is the point: this prologue carried the same defect as
  // the dispatch loop — the resume sat inside the `try` guarding `tool.execute`,
  // so a resource-limit breach on resume was handled as a tool fault and its
  // `GenericFailure` escaped `resumeSuspended` uncaught (#36).
  let resumeWith: { returnValue: unknown } | { exception: { type: string; message: string } };

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
      resumeWith = { returnValue };
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
          ...capOutput(err.answer, runOpts),
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
      resumeWith = { exception: { type: pythonType, message } };
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
    resumeWith = { exception: { type: excType, message: excMsg } };
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

  let current: MontySnapshot | MontyNameLookup | MontyComplete;
  try {
    current = snapshot.resume(resumeWith);
  } catch (err) {
    return classifyResumeError(err, acc);
  }

  // Continue via shared dispatch loop
  return await runDispatchLoop(current, registry, runOpts, acc);
}
