import type { HostTool } from "./types.js";
import { SubmitSignal } from "./submit_signal.js";

// ── Options ──────────────────────────────────────────────────────

export interface RLMToolOptions {
  /** Called by llm_query — receives prompt, returns LLM response. */
  onLLMQuery: (prompt: string) => Promise<string>;
  /** Called by rlm_query — receives query + optional context, returns final answer. */
  onRLMQuery: (query: string, context?: string) => Promise<string>;
}

// ── llm_query ────────────────────────────────────────────────────

function createLLMQueryTool(onLLMQuery: RLMToolOptions["onLLMQuery"]): HostTool {
  return {
    name: "llm_query",
    description:
      "Ask the sub-LLM a question. Blocks until the LLM responds. " +
      "Use for: semantic reasoning, summarization, open-ended analysis. " +
      "Avoid for: counting, filtering, regex — do those in Python directly.",
    params: [
      {
        name: "prompt",
        type: "str",
        description: "The question or prompt to send to the LLM.",
      },
    ],
    returns: "str",
    async execute(args) {
      const prompt = args.prompt as string;
      return await onLLMQuery(prompt);
    },
  };
}

// ── rlm_query ────────────────────────────────────────────────────

function createRLMQueryTool(onRLMQuery: RLMToolOptions["onRLMQuery"]): HostTool {
  return {
    name: "rlm_query",
    description:
      "Spawn a nested RLM loop to investigate a sub-question. " +
      "The nested loop gets its own sandbox and fresh LLM sessions. " +
      "Use for: deep multi-step sub-investigations that need code execution.",
    params: [
      {
        name: "query",
        type: "str",
        description: "The sub-question to investigate.",
      },
      {
        name: "context",
        type: "str",
        description: "Optional context/data for the nested investigation.",
        optional: true,
      },
    ],
    returns: "str",
    async execute(args) {
      const query = args.query as string;
      const context = args.context as string | undefined;
      return await onRLMQuery(query, context);
    },
  };
}

// ── SUBMIT ───────────────────────────────────────────────────────

function createSubmitTool(): HostTool {
  return {
    name: "SUBMIT",
    description:
      "Signal completion and return the final answer to the RLM loop. " +
      "MUST be called exactly once at the end of a successful investigation. " +
      "After SUBMIT, no further code executes in this run.",
    params: [
      {
        name: "answer",
        type: "str",
        description: "The final answer to return.",
      },
    ],
    returns: "void",
    execute(_args) {
      const answer = _args.answer as string;
      throw new SubmitSignal(answer);
    },
  };
}

// ── Main API ─────────────────────────────────────────────────────

/**
 * Create the three RLM host tools: llm_query, rlm_query, SUBMIT.
 *
 * These tools enable the Repeated LLM → Monty loop pattern:
 * - `llm_query` — ask the LLM a question
 * - `rlm_query` — spawn a nested RLM sub-investigation
 * - `SUBMIT` — terminate execution with a final answer
 */
export function createRLMTools(options: RLMToolOptions): HostTool[] {
  return [
    createLLMQueryTool(options.onLLMQuery),
    createRLMQueryTool(options.onRLMQuery),
    createSubmitTool(),
  ];
}
