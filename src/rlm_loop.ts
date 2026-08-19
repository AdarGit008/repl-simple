import { ToolRegistry, probeImportableModules, renderPythonToolRules } from "./registry.js";
import { createRLMTools } from "./rlm_tools.js";
import { runInSandbox, type SandboxOptions } from "./sandbox.js";
import type { HostTool, RunOk, RunError, RunResult, RunOptions, ToolCallTrace } from "./types.js";

// ── Types ────────────────────────────────────────────────────────

export interface RlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RLMLoopOptions {
  /** Tool registry. RLM tools (llm_query, rlm_query, SUBMIT) are
   *  auto-created and merged. Must already contain bridge + builtins
   *  you want available. Must NOT contain tools named llm_query,
   *  rlm_query, or SUBMIT — the loop owns those names. */
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

  /** Optional Python preamble prepended to generated code before
   *  sandbox execution. Use for helpers like repl_server.py that
   *  provide context_preview(), context_lines(), etc.
   *  Prepended with a newline separator. */
  preamble?: string;
}

export interface RLMLoopResult {
  status: "ok" | "error" | "max_iterations";
  answer?: string;
  error?: string;
  iterations: number;
  messages: RlmMessage[];
  traces: ToolCallTrace[][];
}

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_DEPTH = 1;

const RLM_TOOL_NAMES = ["llm_query", "rlm_query", "SUBMIT"] as const;

// ── RLMLoop ──────────────────────────────────────────────────────

export class RLMLoop {
  private options: RLMLoopOptions;

  constructor(options: RLMLoopOptions) {
    // Validate name collisions
    for (const name of RLM_TOOL_NAMES) {
      if (options.registry.has(name)) {
        throw new Error(
          `RLMLoop: tool '${name}' conflicts with user registry. ` +
            `Remove it — the loop provides its own RLM tools.`,
        );
      }
    }
    // Validate limits
    if (options.maxIterations !== undefined && options.maxIterations < 1) {
      throw new Error("RLMLoop: maxIterations must be >= 1");
    }
    if (options.maxDepth !== undefined && options.maxDepth < 0) {
      throw new Error("RLMLoop: maxDepth must be >= 0");
    }
    this.options = options;
  }

  // ── run ────────────────────────────────────────────────────

  async run(task: string, context?: string): Promise<RLMLoopResult> {
    const maxIterations = this.options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const allTraces: ToolCallTrace[][] = [];

    // 1. Build system prompt
    const registry = this.buildRlmRegistry();
    const systemPrompt = await this.buildSystemPrompt(registry);

    // 2. Inject context as sandbox input variable
    const sandboxInputs: Record<string, string> = {
      ...(this.options.runOpts?.inputs ?? {}),
      context: context ?? "",
    };

    // 3. Build initial conversation
    const messages: RlmMessage[] = [{ role: "system", content: systemPrompt }];

    // Build the initial user message
    let userContent = task;
    if (context !== undefined) {
      userContent = `## Task\n${task}\n\n## Context\n${context}`;
    }
    messages.push({ role: "user", content: userContent });

    // 4. Iteration loop
    for (let i = 0; i < maxIterations; i++) {
      // a. Ask LLM for code
      let code: string;
      try {
        code = await this.options.generateCode(messages);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "error",
          error: `generateCode failed: ${msg}`,
          iterations: i,
          messages,
          traces: allTraces,
        };
      }

      // b. Append assistant message
      messages.push({ role: "assistant", content: code });

      // c. Execute code in sandbox
      //
      // `runInSandbox` returns a RunError for anything the user's code did
      // wrong, so a throw here is the host itself failing — a memory guard
      // refusing to start (SandboxMemoryError), or a defect. Either way the
      // accumulated messages and traces are the expensive part of this run and
      // are worth strictly more than the exception: without this the loop
      // strands them, which is the same defect #36 fixed one layer down.
      let result: RunResult;
      try {
        result = await this.executeCode(code, registry, sandboxInputs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "error",
          error: `sandbox execution failed: ${msg}`,
          iterations: i + 1,
          messages,
          traces: allTraces,
        };
      }
      allTraces.push(result.calls);

      // d. Check for SUBMIT
      if (result.status === "ok" && hasSubmitCall(result)) {
        return {
          status: "ok",
          answer: result.output,
          iterations: i + 1,
          messages,
          traces: allTraces,
        };
      }

      // e. Append feedback to messages
      if (result.status === "ok") {
        messages.push({
          role: "user",
          content: formatOkResult(result),
        });
      } else if (result.status === "error") {
        messages.push({
          role: "user",
          content: formatErrorResult(result),
        });
      } else {
        // suspended — unexpected in RLM loop context
        return {
          status: "error",
          error: `Unexpected suspension on tool '${result.suspendedCall.tool}'. The RLM loop does not support interactive approval.`,
          iterations: i + 1,
          messages,
          traces: allTraces,
        };
      }
    }

    // 4. Max iterations exceeded
    return {
      status: "max_iterations",
      iterations: maxIterations,
      messages,
      traces: allTraces,
    };
  }

  // ── Private helpers ────────────────────────────────────────

  /** Build a registry with RLM tools merged in, guarding against collisions. */
  private buildRlmRegistry(): ToolRegistry {
    const rlmTools = this.buildRlmTools();
    const allTools = [...this.options.registry.list(), ...rlmTools];
    return new ToolRegistry(allTools);
  }

  /** Create RLM tools wired to this loop's callbacks. */
  private buildRlmTools(): HostTool[] {
    return createRLMTools({
      onLLMQuery: async (prompt) => {
        return await this.options.llmQuery(prompt);
      },
      onRLMQuery: async (query, context) => {
        const depth = this.options.depth ?? 0;
        const maxDepth = this.options.maxDepth ?? DEFAULT_MAX_DEPTH;

        // Downgrade to llmQuery at max depth
        if (depth >= maxDepth) {
          return await this.options.llmQuery(
            `[rlm_query downgraded at max depth ${maxDepth}]\n` +
              `Query: ${query}\n` +
              `Context: ${context ?? "(none)"}`,
          );
        }

        // Spawn nested RLMLoop
        const nested = new RLMLoop({
          registry: this.options.registry,
          llmQuery: this.options.llmQuery,
          generateCode: this.options.generateCode,
          maxIterations: this.options.maxIterations,
          maxDepth: this.options.maxDepth,
          depth: depth + 1,
          runOpts: this.options.runOpts,
          preamble: this.options.preamble,
        });

        const result = await nested.run(query, context);
        if (result.status === "ok") {
          return result.answer!;
        }
        return `[rlm_query error: ${result.status}] ${result.error ?? ""}`;
      },
    });
  }

  /** Execute code in the sandbox. Prepends preamble if configured. */
  private async executeCode(
    code: string,
    registry: ToolRegistry,
    inputs?: Record<string, string>,
  ): Promise<RunResult> {
    const preamble = this.options.preamble;
    const fullCode = preamble ? `${preamble}\n${code}` : code;
    const sandboxOpts: SandboxOptions = { registry };
    let runOpts: RunOptions | undefined = inputs
      ? { ...this.options.runOpts, inputs }
      : this.options.runOpts;
    if (preamble) {
      // The preamble is the prefix the sandbox numbers its diagnostics from,
      // so the loop owns the offset: computed from the preamble string
      // actually used, never a hardcoded constant (#77, D1).
      runOpts = { ...runOpts, lineOffset: preamble.split("\n").length };
    }
    return await runInSandbox(fullCode, sandboxOpts, runOpts);
  }

  /** Build the system prompt with tool stubs and rules. */
  private async buildSystemPrompt(registry: ToolRegistry): Promise<string> {
    const stubs = await registry.renderTypeStubs();
    const importableModules = await probeImportableModules();
    const rules = renderPythonToolRules(importableModules);
    const preamble = this.options.preamble;

    const parts: string[] = [
      "You are a Python code generator for a sandboxed investigation environment.",
      "",
      "Your task: write Python code to investigate the user's question.",
      "Use the tools below to gather information, then call SUBMIT(answer)",
      "when you have the final answer.",
    ];

    // Mention preamble helpers if configured
    if (preamble) {
      parts.push(
        "",
        "## Preamble Helpers",
        "Your code is prepended with a preamble that may define helper",
        "functions and variables. Any functions or variables defined",
        "in the preamble are available in your code — call them directly.",
      );
    }

    parts.push(
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
    );

    return parts.join("\n");
  }
}

// ── Helpers (not exported) ──────────────────────────────────────

/** Check if a RunOk result was terminated by SUBMIT. */
function hasSubmitCall(result: RunOk): boolean {
  return result.calls.some((call) => call.tool === "SUBMIT");
}

/** Format an ok (non-SUBMIT) result as feedback for the LLM. */
function formatOkResult(result: RunOk): string {
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(`[stdout]\n${result.stdout}`);
  }
  parts.push(`[return value]\n${result.output}`);
  parts.push(
    "\n[NOTE: Your code ran to completion but did not call SUBMIT(). " +
      "Call SUBMIT(answer) when you have the final answer.]",
  );
  return parts.join("\n");
}

/** Format an error result as feedback for the LLM. */
function formatErrorResult(result: RunError): string {
  const parts: string[] = [];
  parts.push(`[error: ${result.errorKind}]`);
  parts.push(result.error);
  if (result.stdout) {
    parts.push(`[stdout]\n${result.stdout}`);
  }
  parts.push("\n[NOTE: Fix the error above and call SUBMIT(answer) when done.]");
  return parts.join("\n");
}
