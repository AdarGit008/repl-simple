import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BASH_ENV_ALLOW_VAR,
  BASH_ENV_FILTERED_MARKER,
  createBashEnvHook,
  describeWithheld,
  filterBashEnv,
  resolveBashEnvAllow,
} from "../src/bashenv.js";

/** A host environment shaped like a real one: work vars, and credentials. */
const HOST_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/tester",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  ANTHROPIC_API_KEY: "sk-ant-secret-value",
  AWS_SESSION_TOKEN: "aws-secret-value",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  MY_COMPANY_PASSPHRASE: "user-defined-secret-value",
  PI_SESSION_FILE: "/home/tester/.pi/session.jsonl",
} as const;

function withEnvVar<T>(name: string, value: string | undefined, fn: () => T): T {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

// ── The allowlist ───────────────────────────────────────────────

describe("filterBashEnv", () => {
  it("withholds credentials and keeps what a build needs", () => {
    const { env, withheld } = filterBashEnv(HOST_ENV);

    // A filter that breaks `npm test` gets turned off, so this half is the
    // half that protects the fix.
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.equal(env.HOME, "/home/tester");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.LC_ALL, "en_US.UTF-8", "LC_ is allowed by prefix");

    for (const name of [
      "ANTHROPIC_API_KEY",
      "AWS_SESSION_TOKEN",
      "SSH_AUTH_SOCK",
      "PI_SESSION_FILE",
    ]) {
      assert.equal(env[name], undefined, `${name} must not reach the child`);
      assert.ok(withheld.includes(name), `${name} must be reported withheld`);
    }

    // The one a denylist of *_KEY / *_TOKEN / *_SECRET would have missed.
    assert.equal(env.MY_COMPANY_PASSPHRASE, undefined);
    assert.ok(withheld.includes("MY_COMPANY_PASSPHRASE"));

    assert.deepEqual(withheld, [...withheld].sort(), "sorted, so the note is stable");
  });

  it("marks the environment as filtered", () => {
    // Otherwise an allowlisted environment is indistinguishable from a host
    // that happened to have nothing set, and `env` misleads about itself.
    assert.equal(filterBashEnv(HOST_ENV).env[BASH_ENV_FILTERED_MARKER], "1");
    assert.equal(filterBashEnv({ PATH: "/bin" }).env[BASH_ENV_FILTERED_MARKER], "1");
  });

  it("matches names case-insensitively", () => {
    const { env, withheld } = filterBashEnv({ Path: "/bin", path: "/bin" });
    assert.equal(env.Path, "/bin");
    assert.equal(env.path, "/bin");
    assert.deepEqual(withheld, []);
  });

  it("lets a caller name an extra variable", () => {
    const { env, withheld } = filterBashEnv(HOST_ENV, ["my_company_passphrase"]);
    assert.equal(env.MY_COMPANY_PASSPHRASE, "user-defined-secret-value");
    assert.ok(!withheld.includes("MY_COMPANY_PASSPHRASE"));
    assert.ok(withheld.includes("ANTHROPIC_API_KEY"), "the rest of the policy still applies");
  });

  it("`*` is the explicit opt-out, and nothing else is", () => {
    const off = filterBashEnv(HOST_ENV, ["*"]);
    assert.equal(off.env.ANTHROPIC_API_KEY, "sk-ant-secret-value");
    assert.deepEqual(off.withheld, []);
    assert.equal(
      off.env[BASH_ENV_FILTERED_MARKER],
      undefined,
      "no marker, because no filtering happened",
    );

    // Not a wildcard language: `*_KEY` is a name, and no variable has it.
    const still = filterBashEnv(HOST_ENV, ["*_KEY"]);
    assert.equal(still.env.ANTHROPIC_API_KEY, undefined);
  });

  it("drops a name whose value is undefined rather than carrying it", () => {
    const { env, withheld } = filterBashEnv({ PATH: "/bin", HOME: undefined });
    assert.ok(!("HOME" in env));
    assert.deepEqual(withheld, [], "absent is not withheld");
  });
});

// ── Configuration ────────────────────────────────────────────────

describe("resolveBashEnvAllow", () => {
  it("reads the environment variable, trimming and dropping blanks", () => {
    withEnvVar(BASH_ENV_ALLOW_VAR, " FOO , ,BAR ", () => {
      assert.deepEqual(resolveBashEnvAllow(), ["FOO", "BAR"]);
    });
  });

  it("unset means no extras", () => {
    withEnvVar(BASH_ENV_ALLOW_VAR, undefined, () => {
      assert.deepEqual(resolveBashEnvAllow(), []);
    });
  });

  it("an explicit list beats the environment, `[]` included", () => {
    withEnvVar(BASH_ENV_ALLOW_VAR, "FOO", () => {
      assert.deepEqual(resolveBashEnvAllow(["BAR"]), ["BAR"]);
      assert.deepEqual(resolveBashEnvAllow([]), [], "pin the policy shut without the variable");
    });
  });
});

// ── The hook ─────────────────────────────────────────────────────

describe("createBashEnvHook", () => {
  it("runs the caller's hook first and filters after", () => {
    const hook = createBashEnvHook([], (ctx) => ({
      ...ctx,
      command: `echo prefixed\n${ctx.command}`,
      env: { ...ctx.env, INJECTED_TOKEN: "leaked", NODE_ENV: "test" },
    }));

    const out = hook({ command: "true", cwd: "/tmp", env: { ...HOST_ENV } });

    assert.match(out.command, /^echo prefixed\n/, "the caller's hook still runs");
    assert.equal(out.env.NODE_ENV, "test", "and can still add an allowed variable");
    assert.equal(out.env.INJECTED_TOKEN, undefined, "but cannot reintroduce a withheld one");
    assert.equal(out.env.ANTHROPIC_API_KEY, undefined);
  });

  it("passes cwd through untouched", () => {
    const out = createBashEnvHook([])({ command: "true", cwd: "/some/dir", env: {} });
    assert.equal(out.cwd, "/some/dir");
    assert.equal(out.command, "true");
  });
});

// ── Visibility ───────────────────────────────────────────────────

describe("describeWithheld", () => {
  it("nothing withheld → no note", () => {
    assert.equal(describeWithheld([]), undefined);
  });

  it("counts, and points at the remedy, even with no context", () => {
    const note = describeWithheld(["ANTHROPIC_API_KEY", "SSH_AUTH_SOCK"]);
    assert.ok(note);
    assert.match(note, /2 host variables withheld/);
    assert.ok(!note.includes("ANTHROPIC_API_KEY"), "an unreferenced name is not disclosed");
    assert.match(note, new RegExp(BASH_ENV_ALLOW_VAR), "a note without the remedy is just noise");
  });

  it("names only what the failure itself referenced", () => {
    // The useful half: `unbound variable` is answered by naming that variable.
    // The discreet half: the other 113 names on a real host stay unspoken,
    // and the model is told nothing it did not already have.
    const note = describeWithheld(
      ["ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "ADARAMIR_SUDO_PASS"],
      'set -u; echo "$ANTHROPIC_API_KEY"\nbash: ANTHROPIC_API_KEY: unbound variable',
    );
    assert.ok(note);
    assert.match(note, /the failure names ANTHROPIC_API_KEY\./);
    assert.ok(!note.includes("SUDO_PASS"));
  });

  it("matches whole names, not substrings", () => {
    const note = describeWithheld(["API_KEY"], "MY_API_KEY_2 is unset");
    assert.ok(note);
    assert.ok(!note.includes("the failure names"), "MY_API_KEY_2 is a different variable");
  });

  it("counts the tail instead of printing 200 names", () => {
    const many = Array.from({ length: 25 }, (_, i) => `VAR_${String(i).padStart(2, "0")}`);
    const note = describeWithheld(many, many.join(" "));
    assert.ok(note);
    assert.match(note, /VAR_09, and 15 more/);
    assert.ok(!note.includes("VAR_10"));
  });

  it("singular when one variable was withheld", () => {
    assert.match(String(describeWithheld(["SSH_AUTH_SOCK"])), /1 host variable withheld/);
  });
});
