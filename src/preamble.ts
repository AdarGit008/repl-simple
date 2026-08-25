import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Path to the bundled repl_server.py preamble, resolved relative to this module. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPL_PREAMBLE_PATH = join(__dirname, "..", "repl", "repl_server.py");

/**
 * Read a preamble file, translating a missing file into an error that names the
 * path and the likely cause instead of a bare ENOENT.
 */
export function readPreamble(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `repl_server.py preamble missing at "${path}". ` +
        `The package was built without its Python preamble (repl/) — reinstall or rebuild.`,
      { cause: err },
    );
  }
}

/**
 * Read the bundled repl_server.py preamble.
 *
 * Convenience loader — equivalent to:
 *   readFileSync("repl/repl_server.py", "utf-8")
 * but resolved relative to the package so it works regardless of cwd.
 */
export function getReplPreamble(): string {
  return readPreamble(REPL_PREAMBLE_PATH);
}
