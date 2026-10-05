import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_MODEL_VAR,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_MODEL,
  createAnthropicLlmClient,
  resolveAnthropicModel,
  type AnthropicMessagesClient,
} from "../src/anthropic_client.js";

// ── Fakes ────────────────────────────────────────────────────────
//
// The adapter is driven through an injected client that records the request
// and answers with a canned `Message`. No key is read, nothing leaves the
// process: the Anthropic SDK is a type here, never a network call.

interface RecordedCreate {
  params: Anthropic.MessageCreateParamsNonStreaming;
  options?: { signal?: AbortSignal | null };
}

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "canned", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      iterations: null,
    },
    ...overrides,
  } as Anthropic.Message;
}

function fakeClient(reply: Anthropic.Message | Error) {
  const calls: RecordedCreate[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      create(params, options) {
        calls.push({ params, options });
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
    },
  };
  return { calls, client };
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("resolveAnthropicModel", () => {
  it("defaults to the current Opus id when the variable is unset or blank", () => {
    assert.equal(resolveAnthropicModel({}), DEFAULT_ANTHROPIC_MODEL);
    assert.equal(resolveAnthropicModel({ [ANTHROPIC_MODEL_VAR]: "  " }), DEFAULT_ANTHROPIC_MODEL);
    assert.equal(DEFAULT_ANTHROPIC_MODEL, "claude-opus-5-5");
  });

  it("reads the model id from the environment, trimmed", () => {
    assert.equal(
      resolveAnthropicModel({ [ANTHROPIC_MODEL_VAR]: " claude-sonnet-5-5 " }),
      "claude-sonnet-5-5",
    );
  });

  it("reads process.env by default", async () => {
    await withEnv({ [ANTHROPIC_MODEL_VAR]: "claude-haiku-4-5" }, () => {
      assert.equal(resolveAnthropicModel(), "claude-haiku-4-5");
    });
  });
});

describe("createAnthropicLlmClient", () => {
  it("sends the system prompt and the messages verbatim and returns the text", async () => {
    const { calls, client } = fakeClient(
      message({
        content: [
          { type: "text", text: "```python\n", citations: null },
          { type: "text", text: 'SUBMIT("ok")\n```', citations: null },
        ],
      }),
    );
    const llm = createAnthropicLlmClient({ client, model: "claude-opus-5-5" });

    const text = await llm.query("be terse", [
      { role: "user", content: "question" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "feedback" },
    ]);

    assert.equal(text, '```python\nSUBMIT("ok")\n```');
    assert.equal(calls.length, 1);
    const { params } = calls[0];
    assert.equal(params.model, "claude-opus-5-5");
    assert.equal(params.system, "be terse");
    assert.equal(params.max_tokens, DEFAULT_ANTHROPIC_MAX_TOKENS);
    assert.deepEqual(params.messages, [
      { role: "user", content: "question" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "feedback" },
    ]);
    assert.equal(
      "stream" in params && params.stream,
      false,
      "the adapter is non-streaming — it needs the whole reply to extract code",
    );
  });

  it("forwards the abort signal to the SDK request options", async () => {
    const { calls, client } = fakeClient(message());
    const llm = createAnthropicLlmClient({ client });
    const controller = new AbortController();

    await llm.query("sys", [{ role: "user", content: "q" }], controller.signal);

    assert.equal(calls[0].options?.signal, controller.signal);
  });

  it("ignores non-text blocks and joins the text blocks in order", async () => {
    const { client } = fakeClient(
      message({
        content: [
          { type: "thinking", thinking: "", signature: "" },
          { type: "text", text: "a", citations: null },
          { type: "text", text: "b", citations: null },
        ] as Anthropic.ContentBlock[],
      }),
    );
    const llm = createAnthropicLlmClient({ client });
    assert.equal(await llm.query("sys", [{ role: "user", content: "q" }]), "ab");
  });

  it("resolves the model from the environment when none is injected", async () => {
    const { calls, client } = fakeClient(message());
    await withEnv({ [ANTHROPIC_MODEL_VAR]: "claude-sonnet-5-5" }, async () => {
      const llm = createAnthropicLlmClient({ client });
      await llm.query("sys", [{ role: "user", content: "q" }]);
    });
    assert.equal(calls[0].params.model, "claude-sonnet-5-5");
  });

  it("honours an explicit maxTokens", async () => {
    const { calls, client } = fakeClient(message());
    const llm = createAnthropicLlmClient({ client, maxTokens: 512 });
    await llm.query("sys", [{ role: "user", content: "q" }]);
    assert.equal(calls[0].params.max_tokens, 512);
  });

  it("rejects a refusal instead of returning an empty reply", async () => {
    const { client } = fakeClient(
      message({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      } as Partial<Anthropic.Message>),
    );
    const llm = createAnthropicLlmClient({ client });
    await assert.rejects(llm.query("sys", [{ role: "user", content: "q" }]), /refus.*cyber/i);
  });

  it("rejects a reply cut at max_tokens, naming the cause, rather than handing back a fragment", async () => {
    const { client } = fakeClient(
      message({
        content: [{ type: "text", text: "```python\nprint(", citations: null }],
        stop_reason: "max_tokens",
      }),
    );
    const llm = createAnthropicLlmClient({ client, maxTokens: 10 });
    await assert.rejects(llm.query("sys", [{ role: "user", content: "q" }]), /max_tokens/);
  });

  it("propagates SDK errors unchanged, so runRlm's provider-error redaction sees the original", async () => {
    const boom = new Error("401 invalid x-api-key");
    const { client } = fakeClient(boom);
    const llm = createAnthropicLlmClient({ client });
    await assert.rejects(
      llm.query("sys", [{ role: "user", content: "q" }]),
      (err: unknown) => err === boom,
    );
  });

  it("constructs the SDK client lazily, so a missing key fails the query, not the server", async () => {
    // No injected client and no key: the factory must not throw — a server
    // without a key still serves `repl`. The failure surfaces when `rlm`
    // actually queries. We only assert the construction half here; the SDK's
    // own credential resolution is not under test.
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_PROFILE: undefined,
      },
      () => {
        assert.doesNotThrow(() => createAnthropicLlmClient());
      },
    );
  });
});
