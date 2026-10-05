import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./rlm.js";

// ── An `LlmClient` on the Anthropic SDK ──────────────────────────
//
// `runRlm` takes an `LlmClient` and nothing else about the model; inside pi
// that client is `createLlmClient` over pi's model registry (src/rlm_client.ts).
// Outside pi — the MCP server, or any embedder without a registry — there is
// no registry to route through, so this is the other implementation: one
// non-streaming `messages.create` per query, text blocks joined.
//
// The key is the SDK's business. `new Anthropic()` resolves credentials from
// the process environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an
// `ant auth login` profile); nothing here reads, stores or prints it. The
// sandbox never sees it either: the bridged `bash` filters its environment
// through `BASH_ENV_ALLOWLIST` (src/bashenv.ts), which withholds it by name.

/** The model the `rlm` loop queries when `REPL_RLM_ANTHROPIC_MODEL` is unset. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Environment variable naming the Anthropic model id the `rlm` loop queries. */
export const ANTHROPIC_MODEL_VAR = "REPL_RLM_ANTHROPIC_MODEL";

/**
 * `max_tokens` per query. One RLM iteration is a code block plus a sentence
 * or two, so this is headroom, not a target; the response is non-streaming,
 * and this is what keeps a slow reply inside the SDK's HTTP timeout.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000;

/**
 * The slice of the Anthropic SDK client this adapter calls — a structural
 * type, so a test hands in a recorder and no key is ever needed. The real
 * `Anthropic` instance satisfies it unchanged.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal | null },
    ): Promise<Anthropic.Message>;
  };
}

export interface AnthropicLlmClientOptions {
  /** The SDK client. Default: `new Anthropic()`, constructed on the first query. */
  client?: AnthropicMessagesClient;
  /** Model id. Default: `resolveAnthropicModel()`. */
  model?: string;
  /** `max_tokens` per query. Default: {@link DEFAULT_ANTHROPIC_MAX_TOKENS}. */
  maxTokens?: number;
}

/** The model id from `REPL_RLM_ANTHROPIC_MODEL`, or the default when unset or blank. */
export function resolveAnthropicModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[ANTHROPIC_MODEL_VAR]?.trim();
  return raw ? raw : DEFAULT_ANTHROPIC_MODEL;
}

/** The text blocks of a reply, in order; every other block kind is dropped. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Build an `LlmClient` that sends each query to the Anthropic Messages API.
 *
 * The SDK client is constructed **lazily**, on the first query: a process
 * with no credentials can still build this client — and so can the MCP
 * server that owns it, which serves `repl` without one — and the failure
 * arrives where it belongs, as the `rlm` call's `status: "error"`.
 *
 * Two stop reasons are errors rather than text: `refusal`, because an empty
 * reply would read to the loop as a model that said nothing, and
 * `max_tokens`, because a code block cut mid-line would be executed as
 * written. Every other error is the SDK's, rethrown unchanged — `runRlm`
 * redacts provider errors itself (`RlmResult.error`), and a wrapper here
 * would only hide the type it keys on.
 */
export function createAnthropicLlmClient(options: AnthropicLlmClientOptions = {}): LlmClient {
  const model = options.model ?? resolveAnthropicModel();
  const maxTokens = options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  let client = options.client;
  return {
    async query(systemPrompt, messages, signal) {
      client ??= new Anthropic();
      const reply = await client.messages.create(
        { model, max_tokens: maxTokens, system: systemPrompt, messages },
        { signal },
      );
      if (reply.stop_reason === "refusal") {
        const category = reply.stop_details?.category ?? "unspecified";
        throw new Error(`Anthropic refused the request (stop_reason: refusal, category: ${category})`);
      }
      if (reply.stop_reason === "max_tokens") {
        throw new Error(
          `Anthropic reply was cut at max_tokens (${maxTokens}); the loop will not run a truncated code block`,
        );
      }
      return textOf(reply);
    },
  };
}
