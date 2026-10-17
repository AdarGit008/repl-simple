// Pure helpers for the `/rlm-setup` command: resolve the shell profile that
// holds the RLM exports, render the managed export block, and rewrite a
// profile's content idempotently. Free of I/O so the file and env mutation
// stay in the extension and the logic is unit-testable.

/** The env-config knobs the rlm client reads (see `src/rlm_client.ts`). */
export interface RlmSetupConfig {
  model?: string;
  provider?: string;
  /** Comma-separated `provider/model-id` fallbacks; empty/undefined = no fallback line. */
  fallbackModels?: string;
}

export const RLM_BLOCK_START = "# >>> repl-simple rlm (managed) >>>";
export const RLM_BLOCK_END = "# <<< repl-simple rlm (managed) <<<";

const RLM_ENV_VARS = {
  model: "REPL_RLM_DEFAULT_MODEL",
  provider: "REPL_RLM_DEFAULT_PROVIDER",
  fallbackModels: "REPL_RLM_FALLBACK_MODELS",
} as const;

/** The shell profile that should hold the exports for the given shell. */
export function detectShellProfile(shellEnv: string | undefined, homeDir: string): string {
  const base = shellEnv ? (shellEnv.split("/").pop() ?? "") : "";
  if (base === "fish") return `${homeDir}/.config/fish/config.fish`;
  if (base === "zsh") return `${homeDir}/.zshrc`;
  if (base === "bash") return `${homeDir}/.bashrc`;
  return `${homeDir}/.profile`;
}

function isFishProfile(profilePath: string): boolean {
  return profilePath.endsWith("/config.fish");
}

/** Quote a value for a double-quoted shell assignment. */
function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render the managed export block. Fish profiles use `set -gx`; everything
 * else uses `export`. Empty fields are omitted, so disabling fallback removes
 * the line rather than exporting an empty string.
 */
export function renderRlmExportBlock(config: RlmSetupConfig, profilePath: string): string {
  const fish = isFishProfile(profilePath);
  const lines: string[] = [RLM_BLOCK_START];
  const assign = (name: string, value: string): string =>
    fish ? `set -gx ${name} ${shellQuote(value)}` : `export ${name}=${shellQuote(value)}`;

  if (config.model) lines.push(assign(RLM_ENV_VARS.model, config.model));
  if (config.provider) lines.push(assign(RLM_ENV_VARS.provider, config.provider));
  if (config.fallbackModels) lines.push(assign(RLM_ENV_VARS.fallbackModels, config.fallbackModels));
  lines.push(RLM_BLOCK_END);
  return lines.join("\n");
}

/**
 * Rewrite `current` with `block` in place of any existing managed block, or
 * append it when none is present. An unterminated start marker is treated as
 * an empty block and replaced.
 */
export function applyRlmExportBlock(current: string, block: string): string {
  const start = current.indexOf(RLM_BLOCK_START);
  if (start === -1) {
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    return `${current}${separator}${block}\n`;
  }
  const end = current.indexOf(RLM_BLOCK_END, start);
  if (end === -1) {
    return `${current.slice(0, start)}${block}\n`;
  }
  const endLine = current.indexOf("\n", end);
  const tail = endLine === -1 ? "" : current.slice(endLine + 1);
  return `${current.slice(0, start)}${block}\n${tail}`;
}

/** Set (or clear) the rlm env vars in the current process. */
export function applyRlmSetupEnv(config: RlmSetupConfig): void {
  const entries: Array<[string, string | undefined]> = [
    [RLM_ENV_VARS.model, config.model],
    [RLM_ENV_VARS.provider, config.provider],
    [RLM_ENV_VARS.fallbackModels, config.fallbackModels],
  ];
  for (const [key, value] of entries) {
    const trimmed = value?.trim();
    if (trimmed) process.env[key] = trimmed;
    else delete process.env[key];
  }
}
