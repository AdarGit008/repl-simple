import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSecrets, redact, REDACTED, REDACTED_PRIVATE_KEY } from "../src/redact.js";

// ── Helpers ─────────────────────────────────────────────────────

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** One masking case: the input, what must survive, what must not. */
interface MaskCase {
  name: string;
  input: string;
  /** Substrings that must be gone after masking. */
  gone: string[];
  /** Substrings that must survive masking (context the reader still needs). */
  kept: string[];
  /** Exact expected output, when the shape is worth pinning whole. */
  exact?: string;
}

function assertMasked(c: MaskCase): void {
  const out = maskSecrets(c.input);
  assert.ok(out.masked >= 1, `${c.name}: nothing was masked:\n${out.text}`);
  for (const secret of c.gone) {
    assert.ok(!out.text.includes(secret), `${c.name}: secret survived: ${secret}\n${out.text}`);
  }
  for (const context of c.kept) {
    assert.ok(out.text.includes(context), `${c.name}: context lost: ${context}\n${out.text}`);
  }
  if (c.exact !== undefined) assert.equal(out.text, c.exact, c.name);
}

// ── Pattern family 1: known token prefixes ──────────────────────

describe("maskSecrets — known token prefixes (family 1)", () => {
  const KEY = "abcdefghijklmnopqrstuvwxyz0123456789";
  const CASES: MaskCase[] = [
    {
      name: "OpenAI-style sk-",
      input: `error: invalid key sk-${KEY} rejected`,
      gone: [KEY],
      kept: ["error: invalid key sk-", " rejected"],
      exact: `error: invalid key sk-${REDACTED} rejected`,
    },
    {
      name: "Anthropic-style sk-ant-",
      input: `x-api-key sk-ant-api03-${KEY}-${KEY}AA`,
      gone: [KEY],
      kept: ["sk-ant-"],
      exact: `x-api-key sk-ant-${REDACTED}`,
    },
    { name: "GitHub ghp_", input: `ghp_${KEY}`, gone: [KEY], kept: ["ghp_"] },
    { name: "GitHub gho_", input: `token gho_${KEY}`, gone: [KEY], kept: ["gho_"] },
    { name: "GitHub ghu_", input: `ghu_${KEY}`, gone: [KEY], kept: ["ghu_"] },
    { name: "GitHub ghs_", input: `ghs_${KEY}`, gone: [KEY], kept: ["ghs_"] },
    { name: "GitHub ghr_", input: `ghr_${KEY}`, gone: [KEY], kept: ["ghr_"] },
    {
      name: "GitHub fine-grained github_pat_",
      input: `github_pat_${KEY}_${KEY}`,
      gone: [KEY],
      kept: ["github_pat_"],
    },
    { name: "GitLab glpat-", input: `glpat-${KEY}`, gone: [KEY], kept: ["glpat-"] },
    {
      name: "Slack xoxb-",
      // Joined at runtime: the literal form trips GitHub push protection (fixture, not a token).
      input: ["xoxb", "1234567890", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-"),
      gone: ["AbCdEfGhIjKlMnOpQrStUvWx", "1234567890123"],
      kept: ["xoxb-"],
      exact: `xoxb-${REDACTED}`,
    },
    { name: "Slack xoxp-", input: `xoxp-${KEY}`, gone: [KEY], kept: ["xoxp-"] },
    { name: "Slack xoxa-", input: `xoxa-${KEY}`, gone: [KEY], kept: ["xoxa-"] },
    { name: "Slack xoxr-", input: `xoxr-${KEY}`, gone: [KEY], kept: ["xoxr-"] },
    { name: "Slack xoxs-", input: `xoxs-${KEY}`, gone: [KEY], kept: ["xoxs-"] },
    {
      name: "AWS access key id AKIA",
      input: "aws_access_key_id AKIAIOSFODNN7EXAMPLE end",
      gone: ["IOSFODNN7EXAMPLE"],
      kept: ["AKIA", " end"],
      exact: `aws_access_key_id AKIA${REDACTED} end`,
    },
    {
      name: "Google API key AIza",
      input: "AIzaSyA-abcdefghijklmnopqrstuvwxyz0123456",
      gone: ["SyA-abcdefghijklmnopqrstuvwxyz0123456"],
      kept: ["AIza"],
    },
  ];

  for (const c of CASES) {
    it(`masks ${c.name}, keeping the prefix`, () => assertMasked(c));
  }

  it("masks every occurrence, not only the first", () => {
    const out = maskSecrets(`one sk-${KEY} two sk-${KEY}`);
    assert.equal(out.masked, 2);
    assert.equal(out.text, `one sk-${REDACTED} two sk-${REDACTED}`);
  });

  it("needs 16 token characters after the prefix — a short lookalike is data", () => {
    const out = maskSecrets("sk-short and ghp_abc and AKIA1234 and xoxb-12");
    assert.equal(out.masked, 0);
    assert.equal(out.text, "sk-short and ghp_abc and AKIA1234 and xoxb-12");
  });
});

// ── Pattern family 2: Authorization headers and Bearer values ────

describe("maskSecrets — Authorization / Bearer (family 2)", () => {
  const CASES: MaskCase[] = [
    {
      name: "Bearer header keeps the scheme",
      input: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc",
      gone: ["eyJhbGciOiJIUzI1NiJ9"],
      kept: ["Authorization: Bearer "],
      exact: `Authorization: Bearer ${REDACTED}`,
    },
    {
      name: "Basic header keeps the scheme",
      input: "authorization: Basic dXNlcjpwYXNzd29yZA==",
      gone: ["dXNlcjpwYXNzd29yZA=="],
      kept: ["authorization: Basic "],
      exact: `authorization: Basic ${REDACTED}`,
    },
    {
      name: "schemeless header",
      input: "Authorization: dXNlcjpwYXNzd29yZA==\nX-Request-Id: 42",
      gone: ["dXNlcjpwYXNzd29yZA=="],
      kept: ["X-Request-Id: 42"],
      exact: `Authorization: ${REDACTED}\nX-Request-Id: 42`,
    },
    {
      name: "JSON-quoted header",
      input: '{"Authorization": "Bearer abc.def.ghi", "Accept": "*/*"}',
      gone: ["abc.def.ghi"],
      kept: ['"Accept": "*/*"', '"Authorization": "Bearer '],
      exact: `{"Authorization": "Bearer ${REDACTED}", "Accept": "*/*"}`,
    },
    {
      name: "bare Bearer in a log line",
      input: "curl -H 'bearer 0123456789abcdef' failed",
      gone: ["0123456789abcdef"],
      kept: ["curl -H 'bearer ", "' failed"],
    },
    {
      name: "the value ends at the line, later headers survive",
      input: "Authorization: Bearer tokentokentoken\nContent-Type: application/json",
      gone: ["tokentokentoken"],
      kept: ["Content-Type: application/json"],
    },
  ];

  for (const c of CASES) {
    it(`masks ${c.name}`, () => assertMasked(c));
  }

  it("a Bearer value shorter than 8 characters is data, not a token", () => {
    const out = maskSecrets("the bearer of this note");
    assert.equal(out.masked, 0);
    assert.equal(out.text, "the bearer of this note");
  });
});

// ── Pattern family 3: PEM private-key blocks ────────────────────

describe("maskSecrets — PEM private keys (family 3)", () => {
  const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVpQ7mF3nX9k2\n";
  const CASES: MaskCase[] = [
    {
      name: "an RSA block",
      input: `before\n-----BEGIN RSA PRIVATE KEY-----\n${BODY}-----END RSA PRIVATE KEY-----\nafter`,
      gone: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "BEGIN RSA"],
      kept: ["before\n", "\nafter"],
      exact: `before\n${REDACTED_PRIVATE_KEY}\nafter`,
    },
    {
      name: "an OPENSSH block",
      input: `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY}-----END OPENSSH PRIVATE KEY-----`,
      gone: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"],
      kept: [],
      exact: REDACTED_PRIVATE_KEY,
    },
    {
      name: "an ENCRYPTED PKCS#8 block",
      input: `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${BODY}-----END ENCRYPTED PRIVATE KEY-----`,
      gone: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"],
      kept: [],
      exact: REDACTED_PRIVATE_KEY,
    },
    {
      name: "a plain PRIVATE KEY block",
      input: `-----BEGIN PRIVATE KEY-----\n${BODY}-----END PRIVATE KEY-----`,
      gone: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"],
      kept: [],
      exact: REDACTED_PRIVATE_KEY,
    },
    {
      name: "a block cut off before its END line (the head-only case)",
      input: `log line\n-----BEGIN EC PRIVATE KEY-----\n${BODY}MHcCAQEEI`,
      gone: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "MHcCAQEEI"],
      kept: ["log line\n"],
      exact: `log line\n${REDACTED_PRIVATE_KEY}`,
    },
  ];

  for (const c of CASES) {
    it(`masks ${c.name}`, () => assertMasked(c));
  }

  it("masks two blocks independently", () => {
    const block = `-----BEGIN PRIVATE KEY-----\n${BODY}-----END PRIVATE KEY-----`;
    const out = maskSecrets(`${block}\nmiddle\n${block}`);
    assert.equal(out.masked, 2);
    assert.equal(out.text, `${REDACTED_PRIVATE_KEY}\nmiddle\n${REDACTED_PRIVATE_KEY}`);
  });

  it("leaves a public CERTIFICATE block alone", () => {
    const cert = `-----BEGIN CERTIFICATE-----\n${BODY}-----END CERTIFICATE-----`;
    const out = maskSecrets(cert);
    assert.equal(out.masked, 0);
    assert.equal(out.text, cert);
  });
});

// ── Pattern family 4: NAME=value / NAME: value ──────────────────

describe("maskSecrets — KEY / TOKEN / SECRET / PASSWORD assignments (family 4)", () => {
  const CASES: MaskCase[] = [
    {
      name: "API_KEY=",
      input: "API_KEY=abc123def456 loaded",
      gone: ["abc123def456"],
      kept: ["API_KEY=", " loaded"],
      exact: `API_KEY=${REDACTED} loaded`,
    },
    {
      name: "x-api-key: header",
      input: "x-api-key: 0123456789abcdef\nhost: example.com",
      gone: ["0123456789abcdef"],
      kept: ["x-api-key: ", "host: example.com"],
      exact: `x-api-key: ${REDACTED}\nhost: example.com`,
    },
    {
      name: "JSON-quoted api_key",
      input: '{"api_key": "hunter2hunter2", "model": "x"}',
      gone: ["hunter2hunter2"],
      kept: ['"model": "x"'],
      exact: `{"api_key": "${REDACTED}", "model": "x"}`,
    },
    {
      name: "apikey without a separator (URL query)",
      input: "https://api.example.com/v1?apikey=zzzzzzzz&format=json",
      gone: ["zzzzzzzz"],
      kept: ["?apikey=", "&format=json"],
      exact: `https://api.example.com/v1?apikey=${REDACTED}&format=json`,
    },
    {
      name: "GITHUB_TOKEN= (the prefix rule and this one compose)",
      input: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      gone: ["abcdefghijklmnopqrstuvwxyz0123", "ghp_"],
      kept: ["GITHUB_TOKEN="],
      exact: `GITHUB_TOKEN=${REDACTED}`,
    },
    {
      name: "access_token=",
      input: "access_token=ya29.a0AfH6SMB end",
      gone: ["ya29.a0AfH6SMB"],
      kept: ["access_token=", " end"],
    },
    {
      name: "client_secret:",
      input: "client_secret: s3cr3t-value",
      gone: ["s3cr3t-value"],
      kept: ["client_secret: "],
    },
    {
      name: "bare SECRET=",
      input: "SECRET=topsecret",
      gone: ["topsecret"],
      kept: ["SECRET="],
      exact: `SECRET=${REDACTED}`,
    },
    {
      name: "password: (any case)",
      input: "Password: hunter2",
      gone: ["hunter2"],
      kept: ["Password: "],
      exact: `Password: ${REDACTED}`,
    },
    {
      name: "PASSWD=",
      input: "PASSWD=hunter2",
      gone: ["hunter2"],
      kept: ["PASSWD="],
    },
    {
      name: "db_password with spaces around =",
      input: "db_password = hunter2",
      gone: ["hunter2"],
      kept: ["db_password = "],
    },
    {
      name: "token=value; keeps the terminator",
      input: "token=abc123; next",
      gone: ["abc123"],
      kept: ["token=", "; next"],
      exact: `token=${REDACTED}; next`,
    },
    {
      name: "shell-quoted value",
      input: "export API_KEY='abc123'",
      gone: ["abc123"],
      kept: ["export API_KEY='"],
      exact: `export API_KEY='${REDACTED}'`,
    },
    {
      name: "dotted config name",
      input: "server.key=/etc/ssl/private/server.key",
      gone: ["/etc/ssl/private/server.key"],
      kept: ["server.key="],
    },
  ];

  for (const c of CASES) {
    it(`masks ${c.name}`, () => assertMasked(c));
  }
});

// ── No-false-positive corpus ────────────────────────────────────
//
// Text that must pass through byte-identical. Each entry is a realistic
// non-secret that sits next to the patterns: Python's `key=` sort kwarg,
// `max_tokens=`, JSON with a "key" field, tracebacks, URLs, SHAs, timestamps,
// SQL, a public certificate. A masking rule that touches any of these is too
// wide — a dump of RLM code (#63) would be corrupted by it.

const CORPUS: Array<{ name: string; text: string }> = [
  { name: "Python sort kwarg", text: "rows = sorted(items, key=lambda r: r[1])" },
  { name: "dict kwarg", text: "d = dict(key=value, other=1)" },
  { name: "max_tokens", text: "request(model='x', max_tokens=4096, temperature=0)" },
  { name: "tokens plural", text: "tokens=['a', 'b']; passwords=[]" },
  { name: "tokenizer", text: "tokenizer=AutoTokenizer.from_pretrained('gpt2')" },
  { name: "JSON key field", text: '{"key": "id", "count": 3, "keys": ["a", "b"]}' },
  { name: "SQL primary key", text: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" },
  { name: "prose about keys", text: "The primary key is the id column; a monkey=1 mapping." },
  { name: "words ending in key", text: "turkey=hot, hockey=cold, donkey=grey" },
  { name: "keyword arguments", text: "keyword=value pairs are passed as **kwargs" },
  {
    name: "traceback",
    text: 'Traceback (most recent call last):\n  File "rlm.py", line 3, in <module>\n    x = 1 / 0\nZeroDivisionError: division by zero',
  },
  { name: "URL", text: "https://example.com/path?x=1&y=2#frag" },
  { name: "git SHA", text: "commit 3770e46a0b1c2d3e4f5061728394a5b6c7d8e9f0" },
  { name: "ISO timestamp", text: "2026-09-08T12:34:56.789Z" },
  { name: "UUID", text: "id=550e8400-e29b-41d4-a716-446655440000" },
  { name: "base64 blob without a name", text: "data: dXNlcjpwYXNzd29yZA== end" },
  { name: "bearer as a word", text: "the bearer of bad news" },
  { name: "short lookalikes", text: "sk-1 ghp_x AKIA xoxb- AIza glpat-" },
  { name: "AKIA inside a word", text: "NAKIAMBA is a surname" },
  { name: "token count", text: "token count: 12 (tokens: 12)" },
  { name: "Authorization as a word", text: "authorization is required for this action" },
  { name: "PEM certificate", text: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
  { name: "public key block", text: "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----" },
  { name: "provider error", text: "429 rate limit exceeded; retry after 20s (request id req_1)" },
  { name: "empty", text: "" },
  { name: "unicode", text: "日本語のテキスト — clés, mot de passe: non" },
];

describe("maskSecrets — no-false-positive corpus", () => {
  for (const { name, text } of CORPUS) {
    it(`leaves ${name} byte-identical`, () => {
      const out = maskSecrets(text);
      assert.equal(out.masked, 0, `masked ${out.masked} in: ${text}`);
      assert.equal(out.text, text);
    });
  }
});

// ── Idempotence ─────────────────────────────────────────────────

describe("maskSecrets / redact — idempotence", () => {
  const POSITIVES = [
    "sk-abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abcdefghijklmnop",
    "Authorization: dXNlcjpwYXNzd29yZA==",
    "bearer abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nMIIB",
    "API_KEY=abc123 TOKEN=def456 password: ghi789",
    'GITHUB_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123"',
  ];

  it("a second masking pass changes nothing", () => {
    for (const text of [...POSITIVES, ...CORPUS.map((c) => c.text)]) {
      const once = maskSecrets(text).text;
      const twice = maskSecrets(once);
      assert.equal(twice.text, once, `not idempotent for: ${text}`);
      assert.equal(twice.masked === 0 || twice.text === once, true);
    }
  });

  it("a second redact pass changes nothing, over and under the budget", () => {
    const opts = { maxBytes: 256, recovery: "Nothing more is surfaced." };
    for (const text of [...POSITIVES, `${"A".repeat(2000)}sk-abcdefghijklmnopqrstuvwxyz`]) {
      const once = redact(text, opts).text;
      assert.equal(redact(once, opts).text, once, `not idempotent for: ${text.slice(0, 60)}`);
    }
  });
});

// ── Composition with truncateText ───────────────────────────────

describe("redact — masking composed with the head-only cut", () => {
  const RECOVERY = "The full provider error is not surfaced.";
  const opts = { maxBytes: 1024, recovery: RECOVERY };

  it("passes a short, secret-free text byte-identical", () => {
    const out = redact("boom", opts);
    assert.deepEqual(out, { text: "boom", truncated: false, masked: 0 });
  });

  it("masks a short secret even though nothing is truncated (the #192 short-error case)", () => {
    const out = redact("401: invalid api_key=sk-abcdefghijklmnopqrstuvwxyz", opts);
    assert.equal(out.truncated, false);
    assert.ok(out.masked >= 1);
    assert.equal(out.text, `401: invalid api_key=${REDACTED}`);
  });

  it("holds the ceiling marker-included, head-only, with the magnitude-free marker", () => {
    const out = redact(`${"A".repeat(64 * 1024)}TAIL`, opts);
    assert.equal(out.truncated, true);
    assert.ok(bytes(out.text) <= 1024, `${bytes(out.text)} bytes over the ceiling`);
    assert.ok(bytes(out.text) > 900, "the head was not kept");
    assert.ok(out.text.startsWith("A".repeat(64)));
    assert.ok(!out.text.includes("TAIL"), "head-only must drop the tail");
    assert.match(
      out.text,
      /\[… truncated at 1\.0KB\. The full provider error is not surfaced\. …\]/,
    );
    assert.doesNotMatch(out.text, /elided|64\.0KB/, "a redaction marker carries no magnitude");
  });

  it("masks before it cuts: a secret straddling the cut leaves no fragment", () => {
    const key = "abcdefghijklmnopqrstuvwxyz0123456789";
    // The token starts a few bytes before the payload budget so a cut-then-mask
    // order would leave `sk-abcdef` in the head, too short for the rule.
    const text = `${"A".repeat(940)} sk-${key} ${"B".repeat(4000)}`;
    const out = redact(text, opts);
    assert.equal(out.truncated, true);
    assert.ok(out.masked >= 1, "the straddling secret must be masked");
    for (let i = 0; i + 6 <= key.length; i++) {
      const fragment = key.slice(i, i + 6);
      assert.ok(!out.text.includes(fragment), `key fragment survived: ${fragment}`);
    }
  });

  it("masks before it cuts: a secret entirely in the dropped tail still counts", () => {
    const text = `${"A".repeat(8 * 1024)} password: hunter2`;
    const out = redact(text, opts);
    assert.equal(out.truncated, true);
    assert.equal(out.masked, 1, "masking runs over the whole input, not the kept head");
    assert.ok(!out.text.includes("hunter2"));
  });

  it("a budget too small for the marker yields an empty, truncated result", () => {
    const out = redact("A".repeat(100), { maxBytes: 8, recovery: RECOVERY });
    assert.equal(out.text, "");
    assert.equal(out.truncated, true);
  });
});

// ── Linear time on adversarial shapes ───────────────────────────

describe("maskSecrets — bounded work on long inputs", () => {
  // A pattern whose name prefix can backtrack over a long run of word
  // characters is quadratic: 1 MiB of "A" would take minutes. Measured budgets
  // are generous (the real cost is milliseconds) so a slow CI box cannot flake
  // this, while a quadratic regression still fails it by orders of magnitude.
  const SHAPES = [
    { name: "one word", text: "A".repeat(1024 * 1024) },
    { name: "many words", text: "A ".repeat(512 * 1024) },
    { name: "many separators", text: "a_b-c.".repeat(200 * 1024) },
    { name: "many BEGIN lines without END", text: "-----BEGIN PRIVATE KEY-----\n".repeat(2000) },
    { name: "many colons", text: "key: value: key: value:\n".repeat(50 * 1024) },
  ];

  for (const { name, text } of SHAPES) {
    it(`finishes ${name} (${bytes(text)} bytes) in bounded time`, () => {
      const started = process.hrtime.bigint();
      maskSecrets(text);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
    });
  }
});
