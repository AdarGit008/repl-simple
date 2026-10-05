#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createReplMcpServer } from "./mcp_server.js";

// ── The `repl-simple-mcp` bin ────────────────────────────────────
//
// The process edge of src/mcp_server.ts, and nothing else: configuration
// from the environment, the server on stdio, and a shutdown that releases
// the sandbox workers. stdout belongs to the transport — every byte on it is
// a JSON-RPC frame — so this file never writes there, and neither does
// anything it loads.
//
// The server exits when its client does: stdin closing is the transport's
// `onclose`, and SIGINT / SIGTERM arrive the same way. `close()` abandons
// every pending approval (nothing pending ever executes), resets the
// sessions and closes the worker pool before the process ends.

const replServer = createReplMcpServer(configFromEnv());

let closing = false;
function shutdown(code: number): void {
  if (closing) return;
  closing = true;
  void replServer.close().finally(() => process.exit(code));
}

replServer.server.server.onclose = () => shutdown(0);
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await replServer.server.connect(new StdioServerTransport());
