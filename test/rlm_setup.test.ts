import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RLM_BLOCK_END,
  RLM_BLOCK_START,
  applyRlmExportBlock,
  applyRlmSetupEnv,
  detectShellProfile,
  renderRlmExportBlock,
} from "../src/rlm_setup.js";

describe("detectShellProfile", () => {
  it("maps zsh, bash, fish, and unknown shells", () => {
    assert.equal(detectShellProfile("/bin/zsh", "/home/u"), "/home/u/.zshrc");
    assert.equal(detectShellProfile("/bin/bash", "/home/u"), "/home/u/.bashrc");
    assert.equal(
      detectShellProfile("/usr/bin/fish", "/home/u"),
      "/home/u/.config/fish/config.fish",
    );
    assert.equal(detectShellProfile(undefined, "/home/u"), "/home/u/.profile");
    assert.equal(detectShellProfile("/bin/sh", "/home/u"), "/home/u/.profile");
  });
});

describe("renderRlmExportBlock", () => {
  it("renders export lines and omits empty fields", () => {
    const block = renderRlmExportBlock(
      { model: "deepseek-v4-pro", provider: "deepseek" },
      "/home/u/.zshrc",
    );
    assert.deepEqual(block.split("\n"), [
      RLM_BLOCK_START,
      'export REPL_RLM_DEFAULT_MODEL="deepseek-v4-pro"',
      'export REPL_RLM_DEFAULT_PROVIDER="deepseek"',
      RLM_BLOCK_END,
    ]);
  });

  it("renders the fallback line only when set", () => {
    const block = renderRlmExportBlock(
      { model: "m1", fallbackModels: "groq/a,openrouter/b" },
      "/home/u/.bashrc",
    );
    assert.ok(block.includes('export REPL_RLM_FALLBACK_MODELS="groq/a,openrouter/b"'));
    assert.ok(!block.includes("REPL_RLM_DEFAULT_PROVIDER"));
  });

  it("uses fish set -gx syntax", () => {
    const block = renderRlmExportBlock(
      { model: "m1", provider: "p1" },
      "/home/u/.config/fish/config.fish",
    );
    assert.ok(block.includes('set -gx REPL_RLM_DEFAULT_MODEL "m1"'));
    assert.ok(block.includes('set -gx REPL_RLM_DEFAULT_PROVIDER "p1"'));
  });

  it("escapes quotes and backslashes in values", () => {
    const block = renderRlmExportBlock({ model: 'a"b\\c' }, "/home/u/.bashrc");
    assert.ok(block.includes('export REPL_RLM_DEFAULT_MODEL="a\\"b\\\\c"'));
  });
});

describe("applyRlmExportBlock", () => {
  const block = "BLOCK";

  it("appends to empty content", () => {
    assert.equal(applyRlmExportBlock("", block), `${block}\n`);
  });

  it("appends to non-empty content with a separating newline", () => {
    assert.equal(applyRlmExportBlock("line1\n", block), `line1\n${block}\n`);
    assert.equal(applyRlmExportBlock("line1", block), `line1\n${block}\n`);
  });

  it("replaces an existing managed block", () => {
    const before = `keep\n${RLM_BLOCK_START}\nold\n${RLM_BLOCK_END}\nafter\n`;
    const expected = `keep\n${block}\nafter\n`;
    assert.equal(applyRlmExportBlock(before, block), expected);
  });

  it("replaces an unterminated start marker", () => {
    const before = `keep\n${RLM_BLOCK_START}\nold line without end`;
    assert.equal(applyRlmExportBlock(before, block), `keep\n${block}\n`);
  });
});

describe("applyRlmSetupEnv", () => {
  const KEYS = [
    "REPL_RLM_DEFAULT_MODEL",
    "REPL_RLM_DEFAULT_PROVIDER",
    "REPL_RLM_FALLBACK_MODELS",
  ] as const;

  it("sets and clears the rlm env vars", () => {
    const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
    try {
      applyRlmSetupEnv({ model: "m", provider: "p", fallbackModels: "a/b" });
      assert.equal(process.env.REPL_RLM_DEFAULT_MODEL, "m");
      assert.equal(process.env.REPL_RLM_DEFAULT_PROVIDER, "p");
      assert.equal(process.env.REPL_RLM_FALLBACK_MODELS, "a/b");

      applyRlmSetupEnv({ model: "m2" });
      assert.equal(process.env.REPL_RLM_DEFAULT_MODEL, "m2");
      assert.equal(process.env.REPL_RLM_DEFAULT_PROVIDER, undefined);
      assert.equal(process.env.REPL_RLM_FALLBACK_MODELS, undefined);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
