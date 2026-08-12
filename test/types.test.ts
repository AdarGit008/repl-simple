import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HostToolError,
  type HostTool,
  type HostToolParam,
  type RunLimits,
  type RunOptions,
  type ApprovalRequest,
  type ApprovalDecision,
  type RunOk,
  type RunError,
  type RunSuspended,
  type RunResult,
  type RunErrorKind,
  type ToolCallTrace,
} from "../src/types.js";

// ── HostToolError (runtime-testable) ───────────────────────────

describe("HostToolError", () => {
  it("extends Error", () => {
    const err = new HostToolError("ValueError", "test message");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof HostToolError);
  });

  it("sets this.name to 'HostToolError'", () => {
    const err = new HostToolError("TypeError", "test");
    assert.equal(err.name, "HostToolError");
  });

  it("preserves pythonType from constructor arg", () => {
    assert.equal(new HostToolError("PermissionError", "msg").pythonType, "PermissionError");
    assert.equal(new HostToolError("RuntimeError", "msg").pythonType, "RuntimeError");
  });

  it("preserves message from constructor arg", () => {
    assert.equal(
      new HostToolError("RuntimeError", "something went wrong").message,
      "something went wrong",
    );
  });
});

// ── Interface shape checks (compile-time) ───────────────────────

describe("Interface shapes (compile-time)", () => {
  it("HostTool object literal matches interface", () => {
    const tool: HostTool = {
      name: "read_file",
      description: "Read a file from the workspace",
      params: [],
      returns: "str",
      execute: () => "content",
    };
    assert.equal(tool.name, "read_file");
    assert.equal(tool.returns, "str");
  });

  it("HostTool with requiresApproval", () => {
    const tool: HostTool = {
      name: "bash",
      description: "Run a shell command",
      params: [],
      returns: "str",
      execute: () => "ok",
      requiresApproval: true,
    };
    assert.equal(tool.requiresApproval, true);
  });

  it("HostToolParam object literal", () => {
    const param: HostToolParam = {
      name: "path",
      type: "str",
      description: "File path",
    };
    assert.equal(param.name, "path");
  });

  it("HostToolParam with optional", () => {
    const param: HostToolParam = {
      name: "limit",
      type: "int",
      description: "Max results",
      optional: true,
    };
    assert.equal(param.optional, true);
  });

  it("RunLimits object literal", () => {
    const limits: RunLimits = {
      maxDurationSecs: 30,
    };
    assert.equal(limits.maxDurationSecs, 30);
  });

  it("RunLimits with maxMemory", () => {
    const limits: RunLimits = {
      maxDurationSecs: 30,
      maxMemory: 128,
    };
    assert.equal(limits.maxMemory, 128);
  });

  it("RunOptions object literal", () => {
    const opts: RunOptions = {};
    assert.equal(typeof opts, "object");
  });

  it("RunOptions with all fields", () => {
    const opts: RunOptions = {
      inputs: { context: "hello" },
      mount: { "/tmp": "/mnt" },
      signal: new AbortController().signal,
      onPrint: (_text) => {},
      onApproval: (_req) => true,
      maxStdoutBytes: 50000,
      scriptName: "<repl>",
      limits: { maxDurationSecs: 30 },
    };
    assert.equal(opts.maxStdoutBytes, 50000);
    assert.equal(opts.scriptName, "<repl>");
    assert.equal(opts.limits?.maxDurationSecs, 30);
  });

  it("ApprovalRequest object literal", () => {
    const req: ApprovalRequest = {
      tool: "bash",
      args: ["ls", "-la"],
      kwargs: { cwd: "/tmp" },
      description: "List files in /tmp",
    };
    assert.equal(req.tool, "bash");
    assert.deepEqual(req.args, ["ls", "-la"]);
  });

  it("ApprovalDecision accepts true, false, 'suspend'", () => {
    const a: ApprovalDecision = true;
    const b: ApprovalDecision = false;
    const c: ApprovalDecision = "suspend";
    assert.equal(a, true);
    assert.equal(b, false);
    assert.equal(c, "suspend");
  });

  it("ToolCallTrace object literal", () => {
    const trace: ToolCallTrace = {
      tool: "read_file",
      args: ["/tmp/test.txt"],
      kwargs: {},
      durationMs: 5,
      ok: true,
    };
    assert.equal(trace.tool, "read_file");
    assert.equal(trace.durationMs, 5);
    assert.equal(trace.ok, true);
  });

  it("ToolCallTrace with error and approved", () => {
    const trace: ToolCallTrace = {
      tool: "bash",
      args: ["rm -rf /"],
      kwargs: {},
      durationMs: 1,
      ok: false,
      error: "Permission denied",
      approved: false,
    };
    assert.equal(trace.ok, false);
    assert.equal(trace.error, "Permission denied");
    assert.equal(trace.approved, false);
  });
});

// ── RunResult discriminated union ────────────────────────────────

describe("RunResult discriminated union", () => {
  it("ok variant", () => {
    const result: RunOk = {
      status: "ok",
      output: "42",
      stdout: "hello\n",
      stdoutTruncated: false,
      calls: [],
    };
    assert.equal(result.status, "ok");
    assert.equal(result.output, "42");
  });

  it("error variant", () => {
    const result: RunError = {
      status: "error",
      error: "NameError: name 'x' is not defined",
      errorKind: "runtime",
      stdout: "",
      stdoutTruncated: false,
      calls: [],
    };
    assert.equal(result.status, "error");
    assert.equal(result.errorKind, "runtime");
  });

  it("suspended variant", () => {
    const req: ApprovalRequest = {
      tool: "write",
      args: ["/tmp/out.txt", "data"],
      kwargs: {},
      description: "Write /tmp/out.txt",
    };
    const result: RunSuspended = {
      status: "suspended",
      suspendedCall: req,
      snapshot: Buffer.from("mock-snapshot"),
      stdout: "Writing...\n",
      stdoutTruncated: false,
      calls: [],
    };
    assert.equal(result.status, "suspended");
    assert.equal(result.suspendedCall.tool, "write");
    assert.ok(result.snapshot instanceof Buffer);
  });

  it("discriminated narrowing — status: 'ok'", () => {
    const result: RunResult = {
      status: "ok",
      output: "hello",
      stdout: "",
      stdoutTruncated: false,
      calls: [],
    };
    if (result.status === "ok") {
      // Narrowed: output is accessible
      assert.equal(result.output, "hello");
    }
  });

  it("discriminated narrowing — status: 'error'", () => {
    const result: RunResult = {
      status: "error",
      error: "bad code",
      errorKind: "syntax",
      stdout: "",
      stdoutTruncated: false,
      calls: [],
    };
    if (result.status === "error") {
      assert.equal(result.errorKind, "syntax");
      assert.equal(result.error, "bad code");
    }
  });

  it("discriminated narrowing — status: 'suspended'", () => {
    const result: RunResult = {
      status: "suspended",
      suspendedCall: {
        tool: "edit",
        args: ["file.txt", "old", "new"],
        kwargs: {},
        description: "Edit file.txt",
      },
      snapshot: Buffer.from("mock"),
      stdout: "",
      stdoutTruncated: false,
      calls: [],
    };
    if (result.status === "suspended") {
      assert.equal(result.suspendedCall.tool, "edit");
      assert.ok(result.snapshot instanceof Buffer);
    }
  });
});

// ── RunErrorKind ─────────────────────────────────────────────

describe("RunErrorKind", () => {
  it("all values are assignable", () => {
    const kinds: RunErrorKind[] = ["syntax", "typing", "runtime", "aborted"];
    assert.equal(kinds.length, 4);
    assert.equal(kinds[0], "syntax");
    assert.equal(kinds[3], "aborted");
  });
});
