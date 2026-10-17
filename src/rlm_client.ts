import type { LlmClient } from "./rlm.js";

// ── Minimal structural mirrors of pi-ai / pi-coding-agent types ──
//
// `@earendil-works/pi-ai` ships nested inside `@earendil-works/pi-coding-agent`
// and is not resolvable from this package, so this module cannot import its
// types directly. These interfaces declare only the members `createLlmClient`
// reads. The real `Model`, `ScopedModel`, `Context`, `AssistantMessage`, and
// `ModelRegistry` types are all structurally assignable to them (pinned by the
// type-level assertions in `test/rlm_client.test.ts`), so a caller passes its
// real pi objects unchanged — no new dependency, no cast.

/** A single content part of an assistant reply (the slice of `TextContent` etc. we read). */
export interface RlmContentPart {
  type: string;
  text?: string;
}

/** The shape of pi-ai's `AssistantMessage` this client reads: its content parts. */
export interface RlmAssistantMessage {
  content: readonly RlmContentPart[];
}

/** The pi-ai `Model` fields used to resolve and dispatch a model. */
export interface RlmModel {
  id: string;
  name?: string;
  provider?: string;
  api?: string;
}

/** A pi-ai `ScopedModel`: a model plus an optional thinking level. */
export interface RlmScopedModel {
  model: RlmModel | undefined;
  thinkingLevel?: unknown;
}

/** A pi-ai message translated from a runRlm `{ role, content }` message. */
export interface RlmMessage {
  role: string;
  content: string | readonly RlmContentPart[];
  timestamp: number;
}

/** A pi-ai `Context`. */
export interface RlmContext {
  systemPrompt?: string;
  messages: readonly RlmMessage[];
}

/** The slice of pi's `ModelRegistry` this client uses. */
export interface RlmModelRegistry {
  complete(
    model: RlmModel,
    context: RlmContext,
    options?: { signal?: AbortSignal },
  ): Promise<RlmAssistantMessage>;
  /** Provider-qualified lookup used by the injected tier when `provider` is set. */
  find?(provider: string, modelId: string): RlmModel | undefined;
}

/**
 * The pi objects a caller already holds and hands to `createLlmClient`.
 * `model` is the default (tier 3) model and may be `undefined` when only the
 * env or injected tiers are meant to be used.
 */
export interface RlmClientContext {
  model: RlmModel | undefined;
  modelRegistry: RlmModelRegistry;
  scopedModels?: readonly RlmScopedModel[];
}

/** Injected-tier configuration: which model to route calls to. */
export interface RlmClientConfig {
  model?: string;
  provider?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Extract reply text from an assistant message's text content parts. */
function extractText(message: RlmAssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Translate runRlm messages into a pi-ai `Context`.
 *
 * The prompt field is `systemPrompt` (not `system`); every message carries a
 * `timestamp`.
 *
 * User messages keep their string content — pi-ai's `UserMessage.content` is
 * `string | (TextContent | ImageContent)[]`, so a string is valid. Assistant
 * messages are different: `AssistantMessage.content` is a
 * `(TextContent | ThinkingContent | ToolCall)[]` **array**, never a string. A
 * string assistant message is not silently coerced — every provider measured
 * (deepseek, openai, anthropic) returns an EMPTY response for it in ~1–100ms,
 * which made any RLM task needing more than one iteration (the loop feeds the
 * prior reply back as a string assistant message) spin to `max_iterations`
 * with an empty synthesised answer. Wrap assistant string content in a text
 * block so the conversation round-trips.
 */
function toContext(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): RlmContext {
  const timestamp = Date.now();
  return {
    systemPrompt,
    messages: messages.map((message) => ({
      role: message.role,
      content:
        message.role === "assistant" ? [{ type: "text", text: message.content }] : message.content,
      timestamp,
    })),
  };
}

/**
 * Resolve the injected-tier model from the scoped models and/or the registry.
 * A provider-qualified config first asks the registry; a model id/name then
 * matches across the scoped models (narrowed by provider when supplied).
 */
function resolveInjectedModel(
  ctx: RlmClientContext,
  config: RlmClientConfig,
): RlmModel | undefined {
  if (config.provider) {
    const viaRegistry = ctx.modelRegistry.find?.(config.provider, config.model ?? "");
    if (viaRegistry) return viaRegistry;
  }

  if (config.model) {
    const scoped = (ctx.scopedModels ?? []).find((entry) => {
      const model = entry.model;
      if (!model) return false;
      if (config.provider && model.provider !== config.provider) return false;
      return model.id === config.model || model.name === config.model;
    });
    if (scoped?.model) return scoped.model;
  }

  return undefined;
}

/** Describe a config for the "model not found" error. */
function describeConfig(config: RlmClientConfig): string {
  const parts: string[] = [];
  if (config.provider) parts.push(`provider "${config.provider}"`);
  if (config.model) parts.push(`model "${config.model}"`);
  return parts.length > 0 ? parts.join(", ") : "no provider or model";
}

/**
 * Tier 2: POST to an env-configured OpenAI-compatible endpoint.
 * The API key travels only as an `Authorization: Bearer` header, never in the
 * URL, and `signal` is forwarded to `fetch` so an abort cancels the request.
 */
async function completeViaEnvEndpoint(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  signal: AbortSignal | undefined,
  baseUrl: string,
): Promise<string> {
  if (!baseUrl.startsWith("https://")) {
    throw new Error(`REPL_RLM_BASE_URL must be an https:// URL (got "${baseUrl}")`);
  }

  const apiKey = process.env.REPL_RLM_API_KEY;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env.REPL_RLM_MODEL ?? "rlm",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`RLM endpoint returned ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("RLM endpoint returned no text in choices[0].message.content");
  }
  return text;
}

/** Tier 1/3: call the registry with the translated context and extract text. */
async function completeViaRegistry(
  registry: RlmModelRegistry,
  model: RlmModel,
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  const reply = await registry.complete(model, toContext(systemPrompt, messages), {
    signal,
  });
  return extractText(reply);
}

// ── Env-default tier ────────────────────────────────────────────

const RLM_DEFAULT_MODEL_VAR = "REPL_RLM_DEFAULT_MODEL";
const RLM_DEFAULT_PROVIDER_VAR = "REPL_RLM_DEFAULT_PROVIDER";
const RLM_FALLBACK_MODELS_VAR = "REPL_RLM_FALLBACK_MODELS";

/** A non-empty env value, or `undefined`. */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

/**
 * The env-default config from `REPL_RLM_DEFAULT_MODEL` / `REPL_RLM_DEFAULT_PROVIDER`,
 * mirroring the injected `{ model, provider }` shape. Undefined when neither is
 * set (the tier is off).
 */
function envDefaultConfig(): RlmClientConfig | undefined {
  const model = envValue(RLM_DEFAULT_MODEL_VAR);
  const provider = envValue(RLM_DEFAULT_PROVIDER_VAR);
  if (!model && !provider) return undefined;
  return { model, provider };
}

/**
 * Parse `REPL_RLM_FALLBACK_MODELS`, a comma-separated list of
 * `provider/model-id` entries (split on the first `/`), or bare `model-id`
 * entries. Empty and whitespace entries are dropped.
 */
function parseFallbackConfigs(raw: string | undefined): RlmClientConfig[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const slash = entry.indexOf("/");
      if (slash === -1) return { model: entry };
      return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) };
    });
}

/** True when an error is a provider rate limit (HTTP 429) worth falling back from. */
function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && /429/.test(err.message);
}

/**
 * Call the registry with each model in order, skipping to the next only on a
 * 429 rate-limit error. A non-429 error rethrows immediately (it is not a
 * quota problem another model can fix), and an exhausted list rethrows the
 * last error.
 */
async function completeViaRegistryWithFallback(
  registry: RlmModelRegistry,
  models: RlmModel[],
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  let lastError: unknown;
  for (const model of models) {
    try {
      return await completeViaRegistry(registry, model, systemPrompt, messages, signal);
    } catch (err) {
      lastError = err;
      if (!isRateLimitError(err)) throw err;
    }
  }
  throw lastError;
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Build an `LlmClient` that routes calls to one of four tiers, in priority
 * order:
 *
 * 1. **Injected** — `config.model` / `config.provider` resolve a model through
 *    `ctx.scopedModels` / `ctx.modelRegistry`, dispatched via
 *    `modelRegistry.complete` (which handles per-model auth, OAuth included).
 * 2. **Env** — `process.env.REPL_RLM_BASE_URL` (an `https://` OpenAI-compatible
 *    endpoint) with `REPL_RLM_API_KEY` and `REPL_RLM_MODEL` (default `"rlm"`).
 * 3. **Env-default** — `REPL_RLM_DEFAULT_MODEL` / `REPL_RLM_DEFAULT_PROVIDER`
 *    resolve a model through the same registry, then `REPL_RLM_FALLBACK_MODELS`
 *    (comma list of `provider/model-id`) are tried in order on a 429.
 * 4. **Default** — `ctx.model` via `modelRegistry.complete`.
 */
export function createLlmClient(ctx: RlmClientContext, config: RlmClientConfig = {}): LlmClient {
  return {
    async query(systemPrompt, messages, signal) {
      if (config.model || config.provider) {
        const model = resolveInjectedModel(ctx, config);
        if (!model) {
          throw new Error(`RLM model not found for ${describeConfig(config)}`);
        }
        return completeViaRegistry(ctx.modelRegistry, model, systemPrompt, messages, signal);
      }

      const baseUrl = process.env.REPL_RLM_BASE_URL;
      if (baseUrl) {
        return completeViaEnvEndpoint(systemPrompt, messages, signal, baseUrl);
      }

      const defaultConfig = envDefaultConfig();
      if (defaultConfig) {
        const primary = resolveInjectedModel(ctx, defaultConfig);
        if (!primary) {
          throw new Error(
            `RLM model not found for ${describeConfig(defaultConfig)} ` +
              `(${RLM_DEFAULT_MODEL_VAR}/${RLM_DEFAULT_PROVIDER_VAR})`,
          );
        }
        const fallbacks = parseFallbackConfigs(process.env[RLM_FALLBACK_MODELS_VAR])
          .map((fallback) => resolveInjectedModel(ctx, fallback))
          .filter((model): model is RlmModel => model !== undefined);
        return completeViaRegistryWithFallback(
          ctx.modelRegistry,
          [primary, ...fallbacks],
          systemPrompt,
          messages,
          signal,
        );
      }

      if (!ctx.model) {
        throw new Error(
          "RLM client has no model: set config.model/config.provider, " +
            "REPL_RLM_BASE_URL, REPL_RLM_DEFAULT_MODEL, or ctx.model",
        );
      }
      return completeViaRegistry(ctx.modelRegistry, ctx.model, systemPrompt, messages, signal);
    },
  };
}
