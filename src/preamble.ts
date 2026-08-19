import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Path to the bundled repl_server.py preamble, resolved relative to this module. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPL_PREAMBLE_PATH = join(__dirname, "..", "repl", "repl_server.py");

/**
 * Read the bundled repl_server.py preamble.
 *
 * Convenience loader — equivalent to:
 *   readFileSync("repl/repl_server.py", "utf-8")
 * but resolved relative to the package so it works regardless of cwd.
 */
export function getReplPreamble(): string {
  return readFileSync(REPL_PREAMBLE_PATH, "utf-8");
}
