import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLlmClient } from "../src/rlm_client.js";
import type { RlmContext, RlmModel, RlmModelRegistry, RlmScopedModel } from "../src/rlm_client.js";

// Type-level pins: the real pi types satisfy the structural mirrors, so a
// caller hands its real objects over unchanged (no cast, no new dependency).
// `@earendil-works/pi-ai` is not directly resolvable here, so the `Model`
// type is read off the exported `ScopedModel`.
import type { ModelRegistry, ScopedModel } from "@earendil-works/pi-coding-agent";

const _realModelAssignable: RlmModel = null as unknown as ScopedModel["model"];
const _realScopedModelAssignable: RlmScopedModel = null as unknown as ScopedModel;
const _realModelRegistryAssignable: RlmModelRegistry = null as unknown as ModelRegistry;
void _realModelAssignable;
void _realScopedModelAssignable;
void _realModelRegistryAssignable;

// ── Fakes ────────────────────────────────────────────────────────

interface RecordedCall {
  model: RlmModel;
  context: RlmContext;
  options?: { signal?: AbortSignal };
}

function makeRegistry(replyText: string) {
  const calls: RecordedCall[] = [];
  const registry: RlmModelRegistry = {
    complete(model, context, options) {
      calls.push({ model, context, options });
      return Promise.resolve({
        content: [{ type: "text", text: replyText }],
      });
    },
  };
  return { calls, registry };
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

describe("createLlmClient", () => {
  it("default tier calls modelRegistry.complete and extracts the text", async () => {
    const { calls, registry } = makeRegistry("hello from the model");
    const client = createLlmClient({
      model: { id: "default-model" },
      modelRegistry: registry,
    });

    const text = await client.query("sys", [{ role: "user", content: "hi" }]);

    assert.equal(text, "hello from the model");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model.id, "default-model");
    assert.equal(calls[0].context.systemPrompt, "sys");
    assert.equal(calls[0].context.messages.length, 1);
    assert.equal(calls[0].context.messages[0].role, "user");
    assert.equal(calls[0].context.messages[0].content, "hi");
    assert.equal(typeof calls[0].context.messages[0].timestamp, "number");
  });

  it("wraps assistant string content in a text block so it round-trips", async () => {
    const { calls, registry } = makeRegistry("ok");
    const client = createLlmClient({ model: { id: "m" }, modelRegistry: registry });

    await client.query("sys", [
      { role: "user", content: "question" },
      { role: "assistant", content: "```python\nprint(1)\n```" },
      { role: "user", content: "feedback" },
    ]);

    const messages = calls[0].context.messages;
    // user content stays a string
    assert.equal(messages[0].content, "question");
    assert.equal(messages[2].content, "feedback");
    // assistant content becomes a TextContent[] array (pi-ai AssistantMessage
    // shape) — a plain string here makes every provider return an empty reply.
    assert.deepEqual(messages[1].content, [{ type: "text", text: "```python\nprint(1)\n```" }]);
  });

  it("throws a clear error when ctx.model is undefined", async () => {
    const { calls, registry } = makeRegistry("unused");
    const client = createLlmClient({ model: undefined, modelRegistry: registry });

    await assert.rejects(client.query("sys", [{ role: "user", content: "hi" }]), /no model/i);
    assert.equal(calls.length, 0);
  });

  it("env tier rejects an http:// base URL", async () => {
    const { calls, registry } = makeRegistry("unused");
    const client = createLlmClient({ model: undefined, modelRegistry: registry });

    await withEnv({ REPL_RLM_BASE_URL: "http://insecure.example.com" }, async () => {
      await assert.rejects(client.query("sys", [{ role: "user", content: "hi" }]), /https/);
    });
    assert.equal(calls.length, 0);
  });

  it("env tier sends the Authorization header and extracts OpenAI text", async () => {
    const { registry } = makeRegistry("unused");
    const client = createLlmClient({ model: undefined, modelRegistry: registry });

    let fetchUrl = "";
    let authHeader: string | undefined;
    let bodyModel = "";
    let bodyMessages: unknown[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      fetchUrl = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      authHeader = headers?.authorization;
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: unknown[];
      };
      bodyModel = body.model;
      bodyMessages = body.messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: "openai text" } }] }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      await withEnv(
        {
          REPL_RLM_BASE_URL: "https://api.example.com",
          REPL_RLM_API_KEY: "secret-key",
        },
        async () => {
          const text = await client.query("sys", [{ role: "user", content: "hi" }]);
          assert.equal(text, "openai text");
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchUrl, "https://api.example.com/chat/completions");
    assert.equal(authHeader, "Bearer secret-key");
    assert.equal(bodyModel, "rlm");
    assert.deepEqual(bodyMessages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("injected tier routes through modelRegistry.complete (not a raw fetch)", async () => {
    const { calls, registry } = makeRegistry("injected reply");
    const client = createLlmClient(
      {
        model: { id: "fallback" },
        modelRegistry: registry,
        scopedModels: [{ model: { id: "scoped-model" } }],
      },
      { model: "scoped-model" },
    );

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const text = await client.query("sys", [{ role: "user", content: "hi" }]);
      assert.equal(text, "injected reply");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].model.id, "scoped-model");
    assert.equal(fetchCalled, false);
  });

  it("injected tier rejects when the configured model does not resolve", async () => {
    const { calls, registry } = makeRegistry("unused");
    const client = createLlmClient(
      {
        model: { id: "fallback" },
        modelRegistry: registry,
        scopedModels: [{ model: { id: "other" } }],
      },
      { model: "missing-model" },
    );

    await assert.rejects(
      client.query("sys", [{ role: "user", content: "hi" }]),
      /RLM model not found/,
    );
    assert.equal(calls.length, 0);
  });

  it("injected tier routes through modelRegistry.find when provider is set", async () => {
    const calls: RecordedCall[] = [];
    const findArgs: Array<[string, string]> = [];
    const registry: RlmModelRegistry = {
      find(provider, modelId) {
        findArgs.push([provider, modelId]);
        return { id: "via-find" };
      },
      complete(model, context, options) {
        calls.push({ model, context, options });
        return Promise.resolve({
          content: [{ type: "text", text: "found reply" }],
        });
      },
    };

    const client = createLlmClient(
      { model: { id: "fallback" }, modelRegistry: registry },
      { provider: "acme", model: "m1" },
    );

    const text = await client.query("sys", [{ role: "user", content: "hi" }]);

    assert.equal(text, "found reply");
    assert.deepEqual(findArgs, [["acme", "m1"]]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model.id, "via-find");
  });

  it("injected tier skips scoped models whose provider does not match config.provider", async () => {
    const calls: RecordedCall[] = [];
    const registry: RlmModelRegistry = {
      find() {
        return undefined;
      },
      complete(model, context, options) {
        calls.push({ model, context, options });
        return Promise.resolve({
          content: [{ type: "text", text: "narrowed reply" }],
        });
      },
    };

    const client = createLlmClient(
      {
        model: { id: "fallback" },
        modelRegistry: registry,
        scopedModels: [
          { model: { id: "shared-model", provider: "other" } },
          { model: { id: "shared-model", provider: "acme" } },
        ],
      },
      { provider: "acme", model: "shared-model" },
    );

    const text = await client.query("sys", [{ role: "user", content: "hi" }]);

    assert.equal(text, "narrowed reply");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model.id, "shared-model");
    assert.equal(calls[0].model.provider, "acme");
  });

  it("env tier rejects a non-ok response with the status", async () => {
    const { registry } = makeRegistry("unused");
    const client = createLlmClient({ model: undefined, modelRegistry: registry });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    try {
      await withEnv({ REPL_RLM_BASE_URL: "https://api.example.com" }, async () => {
        await assert.rejects(
          client.query("sys", [{ role: "user", content: "hi" }]),
          /RLM endpoint returned 500/,
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("env tier rejects when choices[0].message.content is not a string", async () => {
    const { registry } = makeRegistry("unused");
    const client = createLlmClient({ model: undefined, modelRegistry: registry });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: 42 } }] }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      await withEnv({ REPL_RLM_BASE_URL: "https://api.example.com" }, async () => {
        await assert.rejects(client.query("sys", [{ role: "user", content: "hi" }]), /no text/);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("env tier normalizes a trailing slash out of the base URL", async () => {
    const { registry } = makeRegistry("unused");
    const client = createLlmClient({ model: undefined, modelRegistry: registry });

    let fetchUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      fetchUrl = String(input);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      await withEnv({ REPL_RLM_BASE_URL: "https://api.example.com/" }, async () => {
        const text = await client.query("sys", [{ role: "user", content: "hi" }]);
        assert.equal(text, "ok");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchUrl, "https://api.example.com/chat/completions");
  });

  it("injected tier passes an empty model id to find and names the provider in the not-found error", async () => {
    const calls: RecordedCall[] = [];
    const findArgs: Array<[string, string]> = [];
    const registry: RlmModelRegistry = {
      find(provider, modelId) {
        findArgs.push([provider, modelId]);
        return undefined;
      },
      complete(model, context, options) {
        calls.push({ model, context, options });
        return Promise.resolve({ content: [{ type: "text", text: "unused" }] });
      },
    };

    const client = createLlmClient(
      { model: { id: "fallback" }, modelRegistry: registry },
      { provider: "acme" },
    );

    await assert.rejects(
      client.query("sys", [{ role: "user", content: "hi" }]),
      /RLM model not found for provider "acme"/,
    );
    assert.deepEqual(findArgs, [["acme", ""]]);
    assert.equal(calls.length, 0);
  });

  it("injected tier skips scoped entries that carry no model", async () => {
    const { calls, registry } = makeRegistry("picked reply");
    const client = createLlmClient(
      {
        model: { id: "fallback" },
        modelRegistry: registry,
        scopedModels: [{ model: undefined }, { model: { id: "real-model" } }],
      },
      { model: "real-model" },
    );

    const text = await client.query("sys", [{ role: "user", content: "hi" }]);

    assert.equal(text, "picked reply");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model.id, "real-model");
  });

  it("injected tier treats omitted scopedModels as empty", async () => {
    const { calls, registry } = makeRegistry("unused");
    const client = createLlmClient(
      { model: { id: "fallback" }, modelRegistry: registry },
      { model: "missing-model" },
    );

    await assert.rejects(
      client.query("sys", [{ role: "user", content: "hi" }]),
      /RLM model not found/,
    );
    assert.equal(calls.length, 0);
  });

  it("extracts an empty string when a text part has no text", async () => {
    const calls: RecordedCall[] = [];
    const registry: RlmModelRegistry = {
      complete(model, context, options) {
        calls.push({ model, context, options });
        return Promise.resolve({ content: [{ type: "text" }] });
      },
    };

    const client = createLlmClient({ model: { id: "default-model" }, modelRegistry: registry });

    const text = await client.query("sys", [{ role: "user", content: "hi" }]);

    assert.equal(text, "");
    assert.equal(calls.length, 1);
  });
});
