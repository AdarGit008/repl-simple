import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maskSecrets, redact, REDACTED, REDACTED_PRIVATE_KEY } from "../src/redact.js";

// ── Helpers ─────────────────────────────────────────────────────

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * The PEM density test's constants, shared with the docs/redaction.md pin at
 * the end of this file: the document describes this test, in these numbers.
 */
const DENSITY = {
  LINE: "-----BEGIN PRIVATE KEY-----\n",
  SIZE: 1024 * 1024,
  RUNS: 5,
  PASSES: 4,
  COUNTS: [1, 1024],
  BOUND: 3,
} as const;

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

  it("a token glued to a preceding word still masks: the prefix is the evidence, not the boundary (W2-1 finding, D155)", () => {
    // Measured at acadb19: `xxxghp_…` masked nothing, because the rule wanted
    // a word boundary before the prefix. A write body that starts mid-word
    // is the realistic shape.
    for (const [glued, prefix] of [
      [`xxx${"ghp_"}${KEY}`, "ghp_"],
      [`tokengho_${KEY}`, "gho_"],
      [`bodyghs_${KEY}`, "ghs_"],
      [`Xgithub_pat_${KEY}`, "github_pat_"],
      [`aglpat-${KEY}`, "glpat-"],
      [`zxoxb-${KEY}`, "xoxb-"],
      ["fooAKIAIOSFODNN7EXAMPLE", "AKIA"],
      [`barAIzaSyA-${KEY}`, "AIza"],
    ] as const) {
      const out = maskSecrets(glued);
      assert.equal(out.masked, 1, glued);
      assert.equal(out.text, `${glued.slice(0, glued.indexOf(prefix))}${prefix}${REDACTED}`, glued);
    }
  });

  it("`sk-` keeps its word boundary: without it, hyphenated prose is a key (recorded cost)", () => {
    // `task-force-2024-report` is `sk-` followed by 17 token characters.
    // Every other prefix has an underscore or a letter run no English word
    // ends in; `sk` ends `task`, `risk`, `desk`, `disk`, `mask`.
    for (const prose of [
      "task-force-2024-report",
      "risk-assessment-2025-final",
      "desk-lamp-model-XR200-manual",
      `xxxsk-${KEY}`,
    ]) {
      const out = maskSecrets(prose);
      assert.equal(out.masked, 0, prose);
      assert.equal(out.text, prose);
    }
    // A separator is a boundary: the realistic shapes all mask.
    for (const text of [`token=sk-${KEY}`, `"sk-${KEY}"`, `Bearer sk-${KEY}`, `key:sk-${KEY}`]) {
      assert.equal(maskSecrets(text).masked, 1, text);
    }
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
    {
      // The verifier's probe: an alphanumeric schemeless value with the next
      // header on the following line. The credential must go, whole.
      name: "a schemeless alphanumeric value followed by the next header (the header-dump shape)",
      input: "Authorization: abcdef1234567890XYZ\nX-Request-Id: 42",
      gone: ["abcdef1234567890XYZ"],
      kept: ["X-Request-Id: 42"],
      exact: `Authorization: ${REDACTED}\nX-Request-Id: 42`,
    },
    {
      name: "a header dump — every other header survives verbatim",
      input:
        "Host: api.example.com\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig\nX-Request-Id: 42\nContent-Type: application/json",
      gone: ["eyJhbGciOiJIUzI1NiJ9"],
      kept: ["Host: api.example.com\n", "\nX-Request-Id: 42\nContent-Type: application/json"],
      exact: `Host: api.example.com\nAuthorization: Bearer ${REDACTED}\nX-Request-Id: 42\nContent-Type: application/json`,
    },
    {
      name: "a schemeless header dump — every other header survives verbatim",
      input:
        "Host: api.example.com\nAuthorization: abcdef1234567890XYZ\nX-Request-Id: 42\nAccept: */*",
      gone: ["abcdef1234567890XYZ"],
      kept: ["Host: api.example.com\n", "\nX-Request-Id: 42\nAccept: */*"],
      exact: `Host: api.example.com\nAuthorization: ${REDACTED}\nX-Request-Id: 42\nAccept: */*`,
    },
    {
      name: "compact JSON",
      input: '{"Authorization":"Bearer abc.def.ghi","Accept":"*/*"}',
      gone: ["abc.def.ghi"],
      kept: ['"Accept":"*/*"'],
      exact: `{"Authorization":"Bearer ${REDACTED}","Accept":"*/*"}`,
    },
    {
      name: "schemeless JSON",
      input: '{"Authorization":"abcdef1234567890XYZ","Accept":"*/*"}',
      gone: ["abcdef1234567890XYZ"],
      kept: ['"Accept":"*/*"'],
      exact: `{"Authorization":"${REDACTED}","Accept":"*/*"}`,
    },
    {
      name: "a curl -H line",
      input: "curl -H 'Authorization: Bearer abc123def456' https://api.example.com/v1",
      gone: ["abc123def456"],
      kept: ["curl -H 'Authorization: Bearer ", "' https://api.example.com/v1"],
      exact: `curl -H 'Authorization: Bearer ${REDACTED}' https://api.example.com/v1`,
    },
    {
      name: "a curl -H line with the GitHub `token` scheme (the prefix rule and this one compose)",
      input:
        'curl -H "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123" https://api.github.com',
      gone: ["abcdefghijklmnopqrstuvwxyz0123", "ghp_"],
      kept: ['curl -H "Authorization: token ', '" https://api.github.com'],
      exact: `curl -H "Authorization: token ${REDACTED}" https://api.github.com`,
    },
    {
      // A scheme the rule does not know is indistinguishable from a
      // credential followed by a word, so the pair goes together.
      name: "an unknown scheme and its credential go together",
      input: "Authorization: Bot MTIzNDU2Nzg5.abcdef.ghijkl\nX-Request-Id: 42",
      gone: ["MTIzNDU2Nzg5.abcdef.ghijkl", "Bot"],
      kept: ["X-Request-Id: 42"],
      exact: `Authorization: ${REDACTED}\nX-Request-Id: 42`,
    },
    {
      name: "a schemeless credential followed by prose — the next word goes with it (documented cost)",
      input: "Authorization: abcdef1234567890XYZ for user 7",
      gone: ["abcdef1234567890XYZ"],
      kept: [" user 7"],
      exact: `Authorization: ${REDACTED} user 7`,
    },
    {
      // The re-verifier's probe: a known scheme followed by a *quoted*
      // credential masked nothing — the scheme branch wanted a bare value and
      // the lone-value branch refuses a known scheme word. Non-standard, but
      // the header's name is right there in front of it.
      name: "a known scheme followed by a double-quoted credential",
      input: 'Authorization: Bearer "abc123def456"\nAccept: 1',
      gone: ["abc123def456"],
      kept: ['Authorization: Bearer "', "Accept: 1"],
      exact: `Authorization: Bearer "${REDACTED}"\nAccept: 1`,
    },
    {
      name: "a known scheme followed by a single-quoted credential",
      input: "authorization: Basic 'dXNlcjpwYXNzd29yZA=='",
      gone: ["dXNlcjpwYXNzd29yZA=="],
      kept: ["authorization: Basic '"],
      exact: `authorization: Basic '${REDACTED}'`,
    },
    {
      // Digest is a parameter list, not a token: the replayable parts are the
      // response hash and the nonces; username, realm, uri and qop are the
      // context a reader needs to see which request failed.
      name: "Digest parameters — response, nonce and cnonce masked, the rest kept",
      input:
        'Authorization: Digest username="u", realm="r", nonce="dcd98b7102dd2f0e", uri="/v1/x", qop=auth, nc=00000001, cnonce="0a4f113b", response="6629fae49393a05397450978507c4ef1", opaque="5ccc069c"\nX-Request-Id: 42',
      gone: ["dcd98b7102dd2f0e", "0a4f113b", "6629fae49393a05397450978507c4ef1"],
      kept: [
        'Authorization: Digest username="u", realm="r", nonce="',
        'uri="/v1/x", qop=auth, nc=00000001, cnonce="',
        'opaque="5ccc069c"',
        "X-Request-Id: 42",
      ],
      exact: `Authorization: Digest username="u", realm="r", nonce="${REDACTED}", uri="/v1/x", qop=auth, nc=00000001, cnonce="${REDACTED}", response="${REDACTED}", opaque="5ccc069c"\nX-Request-Id: 42`,
    },
    {
      name: "Digest parameters without quotes",
      input: "Authorization: Digest username=u, realm=r, nonce=n0nce, response=abc123, uri=/",
      gone: ["n0nce", "abc123"],
      kept: ["username=u, realm=r, nonce=", ", uri=/"],
      exact: `Authorization: Digest username=u, realm=r, nonce=${REDACTED}, response=${REDACTED}, uri=/`,
    },
    {
      name: "a JSON-quoted Digest header",
      input: '{"Authorization": "Digest username=\\"u\\", response=\\"abc123\\"", "Accept": "*/*"}',
      gone: ["abc123"],
      kept: ['"Accept": "*/*"', 'username=\\"u\\"'],
    },
  ];

  for (const c of CASES) {
    it(`masks ${c.name}`, () => assertMasked(c));
  }

  it("the Digest rule counts each masked parameter and leaves a header with none of them alone", () => {
    const three = maskSecrets('Authorization: Digest nonce="a1", cnonce="b2", response="c3"');
    assert.equal(three.masked, 3);
    const none = 'Authorization: Digest username="u", realm="r", uri="/x", qop=auth';
    const out = maskSecrets(none);
    assert.equal(out.masked, 0, "username/realm/uri/qop are context, not credentials");
    assert.equal(out.text, none, "the old rule masked `username=` here");
  });

  it("a Digest parameter list on a `;`-joined line leaves the next header to its own rule", () => {
    const out = maskSecrets(
      'Authorization: Digest username="u", response="abc123"; Authorization: Bearer bbbbbbbbbbbb',
    );
    assert.equal(out.masked, 2);
    assert.equal(
      out.text,
      `Authorization: Digest username="u", response="${REDACTED}"; Authorization: Bearer ${REDACTED}`,
    );
  });

  it("masks both of two `;`-joined headers and keeps the separator", () => {
    const out = maskSecrets(
      "Authorization: Bearer aaaaaaaaaaaa; Authorization: Bearer bbbbbbbbbbbb",
    );
    assert.equal(out.masked, 2);
    assert.equal(out.text, `Authorization: Bearer ${REDACTED}; Authorization: Bearer ${REDACTED}`);
  });

  it("the value ends at `,` as well", () => {
    const out = maskSecrets(
      "Authorization: Basic dXNlcjpwYXNz, Authorization: Bearer bbbbbbbbbbbb",
    );
    assert.equal(out.masked, 2);
    assert.equal(out.text, `Authorization: Basic ${REDACTED}, Authorization: Bearer ${REDACTED}`);
  });

  it("every known scheme keeps its spelling; an unknown one goes with its credential", () => {
    const KNOWN = [
      "Basic",
      "Bearer",
      "Digest",
      "Token",
      "Negotiate",
      "NTLM",
      "HOBA",
      "Mutual",
      "AWS4-HMAC-SHA256",
      "bearer",
      "BASIC",
    ];
    for (const scheme of KNOWN) {
      const out = maskSecrets(`Authorization: ${scheme} credential0123456789\nX-Request-Id: 42`);
      assert.equal(out.text, `Authorization: ${scheme} ${REDACTED}\nX-Request-Id: 42`, scheme);
      assert.equal(out.masked, 1, scheme);
    }
    for (const scheme of ["Bot", "SSWS", "OAuth", "ApiKey"]) {
      const out = maskSecrets(`Authorization: ${scheme} credential0123456789\nX-Request-Id: 42`);
      assert.equal(out.text, `Authorization: ${REDACTED}\nX-Request-Id: 42`, scheme);
      assert.equal(out.masked, 1, scheme);
    }
  });

  it("a scheme word with no credential is data", () => {
    const text = "Authorization: Bearer\nX-Request-Id: 42";
    const out = maskSecrets(text);
    assert.equal(out.masked, 0);
    assert.equal(out.text, text);
  });

  it("a bare Bearer never reads across a line: prose is left alone", () => {
    const text = "the Bearer\nauthentication scheme is used";
    const out = maskSecrets(text);
    assert.equal(out.masked, 0);
    assert.equal(out.text, text);
  });

  it("a Bearer value shorter than 8 characters is data, not a token", () => {
    const out = maskSecrets("the bearer of this note");
    assert.equal(out.masked, 0);
    assert.equal(out.text, "the bearer of this note");
  });

  it("bare Bearer prose on ONE line is data: the word after it must look like a credential", () => {
    // The re-verifier's probe. Outside a header there is no name to anchor
    // on, so the token itself has to carry the evidence: 16+ characters or a
    // digit / underscore / dash, and not a run of lowercase letters.
    for (const text of [
      "the Bearer authentication scheme is used",
      "Bearer tokens expire after an hour",
      "a Bearer credential is opaque to the client",
      "send it in the Bearer AUTHORIZATION header",
      "Bearer Authentication is defined in RFC 6750",
      "the bearer authenticationscheme word runs on",
    ]) {
      const out = maskSecrets(text);
      assert.equal(out.masked, 0, text);
      assert.equal(out.text, text);
    }
  });

  it("a bare Bearer token that looks like a credential still masks", () => {
    for (const token of [
      "0123456789abcdef",
      "abc-def-ghi",
      "a_b_c_d_e",
      "AbCdEfGhIjKlMnOpQr",
      "eyJhbGci.eyJzdWIi.sig",
      "x9y8z7w6",
    ]) {
      const out = maskSecrets(`curl -H 'bearer ${token}' failed`);
      assert.equal(out.masked, 1, token);
      assert.equal(out.text, `curl -H 'bearer ${REDACTED}' failed`, token);
    }
  });

  it("an all-lowercase-letter word after a bare Bearer is data even at 16+ characters (recorded false negative)", () => {
    // Real bearer tokens are base64, hex or JWTs — digits, dots, uppercase —
    // so the cost of this rule is a shape no issued token has; the gain is
    // every English word after the word "Bearer". Inside a header the same
    // token still masks: the header's name is the evidence there.
    const bare = maskSecrets("bearer abcdefghijklmnop");
    assert.equal(bare.masked, 0);
    assert.equal(
      maskSecrets("Authorization: Bearer abcdefghijklmnop").text,
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it("trailing sentence punctuation is not evidence: a 15-letter word before a period is prose (W2-3 finding, D155)", () => {
    // Measured at acadb19: `.` is a token character, so `implementations.`
    // reached the 16-character test and masked one prose word.
    for (const text of [
      "the Bearer implementations.",
      "the Bearer authentications.",
      "the Bearer implementations...",
      "the Bearer implementations. Then more.",
    ]) {
      const out = maskSecrets(text);
      assert.equal(out.masked, 0, text);
      assert.equal(out.text, text);
    }
    // A real token followed by a full stop keeps the full stop.
    const out = maskSecrets("use bearer 0123456789abcdef.");
    assert.equal(out.masked, 1);
    assert.equal(out.text, `use bearer ${REDACTED}.`);
  });

  it("a Digest response hash is masked however long the uri before it is — the list is read per parameter, not through a window (W2-3 finding, D155)", () => {
    // Measured at acadb19: a 4 200-character `uri=` put `response=` past the
    // rule's 4 KiB window and the hash survived whole.
    const uri = `/${"a".repeat(5000)}`;
    const hash = "6629fae49393a05397450978507c4ef1";
    const out = maskSecrets(`Authorization: Digest username="u", uri="${uri}", response="${hash}"`);
    assert.equal(out.masked, 1);
    assert.ok(!out.text.includes(hash), "the hash survived");
    assert.equal(
      out.text,
      `Authorization: Digest username="u", uri="${uri}", response="${REDACTED}"`,
    );
  });

  it("a Digest parameter is masked by its own name, never by a `name=` inside another parameter's value (W2-3 finding, D155)", () => {
    // Measured at acadb19: `uri="/x?response=1"` lost its `1` and the count
    // read 2 for one credential.
    const out = maskSecrets(
      'Authorization: Digest username="u", uri="/x?response=1", response="abc123"',
    );
    assert.equal(out.masked, 1);
    assert.equal(
      out.text,
      `Authorization: Digest username="u", uri="/x?response=1", response="${REDACTED}"`,
    );
    const inner = 'Authorization: Digest username="nonce=zzz", realm="r", uri="/"';
    const kept = maskSecrets(inner);
    assert.equal(kept.masked, 0, "a value that merely contains `nonce=` is not a nonce");
    assert.equal(kept.text, inner);
  });

  it("a quoted Digest value may hold spaces and commas; the list ends at `;` and at the line; an unclosed quote runs to the line's end", () => {
    // Guards the tokenizer against regressing what the window did by accident.
    const joined = maskSecrets(
      'Authorization: Digest realm="my realm, inc", nonce="n1"; Authorization: Bearer bbbbbbbbbbbb\nX-Request-Id: 42',
    );
    assert.equal(joined.masked, 2);
    assert.equal(
      joined.text,
      `Authorization: Digest realm="my realm, inc", nonce="${REDACTED}"; Authorization: Bearer ${REDACTED}\nX-Request-Id: 42`,
    );
    const open = maskSecrets(
      'Authorization: Digest username="u", response="abc123\nX-Request-Id: 42',
    );
    assert.equal(open.masked, 1);
    assert.equal(
      open.text,
      `Authorization: Digest username="u", response="${REDACTED}\nX-Request-Id: 42`,
    );
    // Bare and quoted parameters mix, and the count is one per credential.
    const mixed = maskSecrets(
      'Authorization: Digest username=u, nonce=n0nce, cnonce="c", qop=auth, response=abc, opaque=o',
    );
    assert.equal(mixed.masked, 3);
    assert.equal(
      mixed.text,
      `Authorization: Digest username=u, nonce=${REDACTED}, cnonce="${REDACTED}", qop=auth, response=${REDACTED}, opaque=o`,
    );
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
    {
      // Decision 6 lists `KEY=value` literally: the bare word masks.
      name: "bare KEY= (decision 6, literal)",
      input: "KEY=abcdef1234567890 done",
      gone: ["abcdef1234567890"],
      kept: ["KEY=", " done"],
      exact: `KEY=${REDACTED} done`,
    },
    {
      // The re-verifier's probe: in a code dump the value ran to the closing
      // paren and took it along. A value never *ends* in a closing bracket.
      name: "a call argument — the closing paren survives",
      input: "f(KEY=abc123)",
      gone: ["abc123"],
      kept: ["f(KEY=", ")"],
      exact: `f(KEY=${REDACTED})`,
    },
    {
      name: "a dict literal — the closing brace survives",
      input: "config = {token: abc123}",
      gone: ["abc123"],
      kept: ["config = {token: ", "}"],
      exact: `config = {token: ${REDACTED}}`,
    },
    {
      name: "a list literal — the closing bracket survives",
      input: "[SECRET=abc123]",
      gone: ["abc123"],
      kept: ["[SECRET=", "]"],
      exact: `[SECRET=${REDACTED}]`,
    },
    {
      name: "several closing brackets survive together",
      input: "g(f(KEY=abc123))",
      gone: ["abc123"],
      kept: ["g(f(KEY=", "))"],
      exact: `g(f(KEY=${REDACTED}))`,
    },
    {
      // Only a *trailing* bracket is a terminator: a bracket inside the value
      // is part of the value, so the secret still goes whole.
      name: "a bracket inside the value masks whole",
      input: "PASSWORD=ab)cd next",
      gone: ["ab)cd", "cd"],
      kept: ["PASSWORD=", " next"],
      exact: `PASSWORD=${REDACTED} next`,
    },
  ];

  for (const c of CASES) {
    it(`masks ${c.name}`, () => assertMasked(c));
  }

  it("masks decision 6's literal list in every spelling — bare and compound names, any case, quotes, `export`", () => {
    const NAMES = [
      "KEY",
      "key",
      "Key",
      "TOKEN",
      "token",
      "SECRET",
      "secret",
      "PASSWORD",
      "password",
      "PASSWD",
      "API_KEY",
      "api_key",
      "x-api-key",
      "ACCESS_TOKEN",
      "CLIENT_SECRET",
      "DB_PASSWORD",
    ];
    const FORMS: Array<(name: string) => [input: string, expected: string]> = [
      (n) => [`${n}=hunter2hunter2`, `${n}=${REDACTED}`],
      (n) => [`export ${n}=hunter2hunter2`, `export ${n}=${REDACTED}`],
      (n) => [`export ${n}="hunter2hunter2"`, `export ${n}="${REDACTED}"`],
      (n) => [`${n}='hunter2hunter2'`, `${n}='${REDACTED}'`],
      (n) => [`${n} = hunter2hunter2`, `${n} = ${REDACTED}`],
      (n) => [`${n}=hunter2hunter2; next`, `${n}=${REDACTED}; next`],
    ];
    for (const name of NAMES) {
      for (const form of FORMS) {
        const [input, expected] = form(name);
        const out = maskSecrets(input);
        assert.equal(out.text, expected, input);
        assert.equal(out.masked, 1, input);
      }
    }
  });

  it("bare `key:` is a field name, not a credential — compound names take both separators", () => {
    for (const text of ["key: id", '{"key": "id", "keys": ["a"]}', "sort by key: name"]) {
      const out = maskSecrets(text);
      assert.equal(out.masked, 0, text);
      assert.equal(out.text, text);
    }
    assert.equal(maskSecrets("api_key: hunter2hunter2").text, `api_key: ${REDACTED}`);
    assert.equal(maskSecrets("x-api-key: hunter2hunter2").text, `x-api-key: ${REDACTED}`);
  });
});

// ── Documented costs ────────────────────────────────────────────
//
// Shapes decision 6 masks on purpose and docs/redaction.md records as the
// price: the exact output is pinned so a change here is a decision, not a
// drift.

describe("maskSecrets — documented costs (decision 6, literally)", () => {
  const COSTS: MaskCase[] = [
    {
      // Python's sort kwarg is a bare `key=`; the decision lists `KEY=value`.
      name: "Python sort kwarg",
      input: "rows = sorted(items, key=lambda r: r[1])",
      gone: ["key=lambda"],
      kept: ["rows = sorted(items, key=", " r: r[1])"],
      exact: `rows = sorted(items, key=${REDACTED} r: r[1])`,
    },
    {
      name: "dict kwarg",
      input: "d = dict(key=value, other=1)",
      gone: ["key=value"],
      kept: ["d = dict(key=", ", other=1)"],
      exact: `d = dict(key=${REDACTED}, other=1)`,
    },
    {
      // The kwarg is the last argument: the value is masked, the code keeps
      // its shape (the re-verifier's probe lost the `)`).
      name: "Python kwarg as the last argument — the closing paren survives",
      input: "sorted(rows, key=str.lower)",
      gone: ["str.lower"],
      kept: ["sorted(rows, key=", ")"],
      exact: `sorted(rows, key=${REDACTED})`,
    },
  ];

  for (const c of COSTS) {
    it(`masks ${c.name} — the recorded cost`, () => assertMasked(c));
  }
});

// ── No-false-positive corpus ────────────────────────────────────
//
// Text that must pass through byte-identical. Each entry is a realistic
// non-secret that sits next to the patterns: `max_tokens=`, `monkey=`,
// `keyboard=`, JSON with a "key" field, tracebacks, URLs, SHAs, timestamps,
// SQL, a public certificate. A masking rule that touches any of these is too
// wide — a dump of RLM code (#63) would be corrupted by it. (Python's bare
// `key=` kwarg is *not* here: decision 6 lists `KEY=value` literally, so it
// masks — see the documented-costs table.)

const CORPUS: Array<{ name: string; text: string }> = [
  { name: "kwargs that are not key=", text: "d = dict(name=value, other=1); sorted(rows, cmp=f)" },
  { name: "max_tokens", text: "request(model='x', max_tokens=4096, temperature=0)" },
  { name: "tokens plural", text: "tokens=['a', 'b']; passwords=[]" },
  { name: "tokenizer", text: "tokenizer=AutoTokenizer.from_pretrained('gpt2')" },
  { name: "JSON key field", text: '{"key": "id", "count": 3, "keys": ["a", "b"]}' },
  { name: "SQL primary key", text: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" },
  { name: "prose about keys", text: "The primary key is the id column; a monkey=1 mapping." },
  { name: "words ending in key", text: "turkey=hot, hockey=cold, donkey=grey" },
  { name: "monkey", text: "monkey=banana" },
  { name: "keyboard", text: "keyboard=on" },
  { name: "keyword arguments", text: "keyword=value pairs are passed as **kwargs" },
  { name: "key_id / secret_id", text: "key_id=7 secret_id=8 token_count=9 password_hash=x" },
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
  {
    name: "401 challenge header",
    text: 'WWW-Authenticate: Bearer realm="api", error="invalid_token"',
  },
  {
    name: "Digest challenge header (a server nonce is not a credential)",
    text: 'WWW-Authenticate: Digest realm="api", nonce="dcd98b7102dd2f0e", qop="auth"',
  },
  {
    name: "Digest header without a response",
    text: 'Authorization: Digest username="u", realm="r", uri="/x"',
  },
  { name: "Bearer prose on one line", text: "the Bearer authentication scheme is used" },
  { name: "Bearer as an adjective", text: "Bearer tokens expire after an hour" },
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
    'Authorization: Bearer "abc123def456"',
    "Authorization: dXNlcjpwYXNzd29yZA==",
    'Authorization: Digest username="u", nonce="n0nce", response="abc123"',
    "bearer abcdefghijklmnop01",
    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nMIIB",
    "API_KEY=abc123 TOKEN=def456 password: ghi789",
    "export KEY=abc123 key='def456'",
    'GITHUB_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123"',
    "f(KEY=abc123) [SECRET=def456]",
  ];

  it("a second masking pass changes nothing and masks nothing", () => {
    for (const text of [...POSITIVES, ...CORPUS.map((c) => c.text)]) {
      const once = maskSecrets(text).text;
      const twice = maskSecrets(once);
      assert.equal(twice.text, once, `not idempotent for: ${text}`);
      // `[REDACTED]` is not a value to any rule: the count is idempotent, not
      // only the text — a caller logging `masked` sees the secrets, not the
      // number of passes.
      assert.equal(twice.masked, 0, `a second pass re-masked ${twice.masked} in: ${once}`);
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

// ── Fuzz: random header, env and prose lines ────────────────────
//
// A seeded generator (a failure reproduces by seed) assembles documents of
// one to three lines drawn from realistic non-secret material — response
// headers, environment dumps, prose about tokens and keys, Python that is
// not a credential — and asserts every one passes byte-identical. A second
// generator plants a credential in a random header dump, in each header
// shape the rule knows, and asserts it never survives whatever surrounds it.

/** Numerical Recipes LCG — enough for a reproducible shuffle, not for anything else. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

const HEADER_LINES = [
  "Host: api.example.com",
  "Content-Type: application/json",
  "Content-Length: 128",
  "Accept: */*",
  "Accept-Encoding: gzip, deflate",
  "User-Agent: curl/8.6.0",
  "X-Request-Id: 42",
  "X-RateLimit-Remaining: 17",
  "Cache-Control: no-cache",
  "Retry-After: 20",
  "Date: Tue, 08 Sep 2026 12:00:00 GMT",
  "Connection: keep-alive",
  'WWW-Authenticate: Digest realm="api", nonce="dcd98b7102dd2f0e", qop="auth"',
];

const ENV_LINES = [
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/home/user",
  "SHELL=/bin/bash",
  "LANG=en_US.UTF-8",
  "TERM=xterm-256color",
  "EDITOR=vim",
  "TZ=UTC",
  "PORT=8080",
  "NODE_ENV=production",
  "LOG_LEVEL=debug",
  "monkey=banana",
  "keyboard=on",
  "turkey=hot",
  "keyword=value",
  "max_tokens=4096",
  "tokens=12",
  "passwords=3",
  "key_id=7",
  "tokenizer=gpt2",
];

const PROSE_LINES = [
  "the bearer of bad news",
  "authorization is required for this action",
  "the token type is Bearer",
  "authentication happens once per request",
  "rotate the secret every 90 days",
  "a password reset link was sent",
  "the primary key is the id column",
  "tokens are counted per request",
  "see docs/redaction.md for the rules",
  "429 rate limit exceeded; retry after 20s (request id req_1)",
  "the Bearer authentication scheme is used",
  "Bearer tokens expire after an hour",
];

const CODE_LINES = [
  "request(model='x', max_tokens=4096, temperature=0)",
  "tokens = ['a', 'b']",
  "print(len(passwords))",
  "d = dict(name=value, other=1)",
  "for k, v in d.items():",
  "x = 1 / 0",
  "import os",
  "commit 3770e46a0b1c2d3e4f5061728394a5b6c7d8e9f0",
];

const NEGATIVE_LINES = [...HEADER_LINES, ...ENV_LINES, ...PROSE_LINES, ...CODE_LINES];

/** How many random documents each fuzz builds. Reported in the PR body. */
const FUZZ_SAMPLES = 200;

describe("maskSecrets — fuzz: random header, env and prose lines", () => {
  it(`leaves ${FUZZ_SAMPLES} random one-to-three-line non-secret documents byte-identical`, () => {
    const rand = lcg(20260908);
    const offenders: string[] = [];
    for (let i = 0; i < FUZZ_SAMPLES; i++) {
      const lines = 1 + Math.floor(rand() * 3);
      const text = Array.from({ length: lines }, () => pick(rand, NEGATIVE_LINES)).join("\n");
      const out = maskSecrets(text);
      if (out.masked !== 0 || out.text !== text) {
        offenders.push(`${JSON.stringify(text)} -> ${JSON.stringify(out.text)}`);
      }
    }
    assert.equal(offenders.length, 0, `false positives:\n${offenders.join("\n")}`);
  });

  it(`never lets the credential of ${FUZZ_SAMPLES} random header dumps survive, whatever surrounds it`, () => {
    const rand = lcg(19700101);
    const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const token = (n: number) =>
      Array.from({ length: n }, () => ALNUM[Math.floor(rand() * ALNUM.length)]).join("");
    for (let i = 0; i < FUZZ_SAMPLES; i++) {
      const credential = token(16 + Math.floor(rand() * 24));
      const form = pick(rand, [
        credential,
        `Bearer ${credential}`,
        `Bearer "${credential}"`,
        `Basic ${credential}==`,
        `Basic '${credential}=='`,
        `Bot ${credential}`,
        `Token ${credential}`,
        `Digest username="u", realm="r", nonce="${credential}", uri="/v1", response="${credential}"`,
      ]);
      const headers = Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
        pick(rand, HEADER_LINES),
      );
      headers.splice(Math.floor(rand() * (headers.length + 1)), 0, `Authorization: ${form}`);
      const text = headers.join("\n");
      const out = maskSecrets(text);
      assert.ok(
        !out.text.includes(credential),
        `credential survived in:\n${text}\n->\n${out.text}`,
      );
      for (const header of headers) {
        if (header.startsWith("Authorization:")) continue;
        assert.ok(out.text.includes(header), `header lost: ${header}\n${text}\n->\n${out.text}`);
      }
    }
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
    { name: "many BEGIN lines without END", text: "-----BEGIN PRIVATE KEY-----\n".repeat(37449) },
    { name: "many colons", text: "key: value: key: value:\n".repeat(50 * 1024) },
    // The assignment rule's worst constant (re-verifier's observation): a
    // word boundary at every character and up to ~130 lazy name expansions
    // per position, ~0.4 s per MiB, linear. Half a MiB keeps the 2 s budget
    // ten times away on this box.
    { name: "alternating word and dash", text: "a-".repeat(256 * 1024) },
    { name: "many Bearer words", text: "Bearer authentication ".repeat(40 * 1024) },
    {
      name: "many Digest parameters",
      text: 'Authorization: Digest nonce="a", response="b"\n'.repeat(20 * 1024),
    },
    // The per-parameter Digest scan (D155): each header reads its own list
    // once and stops at `;`, so a line of joined headers is linear; one
    // header's list is linear in its length however it is shaped.
    {
      name: "many `;`-joined Digest headers on one line",
      text: 'Authorization: Digest username="u", response="b"; '.repeat(20 * 1024),
    },
    {
      name: "one Digest header with a 1 MiB uri",
      text: `Authorization: Digest username="u", uri="/${"a".repeat(1024 * 1024)}", response="b"`,
    },
    {
      name: "one Digest header with 60 000 parameters",
      text: `Authorization: Digest ${Array.from({ length: 60_000 }, (_, i) => `p${i}=v${i}`).join(", ")}, response="b"`,
    },
    {
      name: "one Digest header whose list ends in a run of unparseable tokens",
      text: `Authorization: Digest username="u", response="b" ${"garbage ".repeat(128 * 1024)}`,
    },
  ];

  for (const { name, text } of SHAPES) {
    it(`finishes ${name} (${bytes(text)} bytes) in bounded time`, () => {
      const started = process.hrtime.bigint();
      maskSecrets(text);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
    });
  }

  it("the PEM scan is linear: 1024 BEGIN lines with no END in 1 MiB cost no more than 3× one BEGIN line (best of 5 runs)", () => {
    // A budget alone cannot tell linear from quadratic — it only says "fast
    // enough today". The lazy body scan used to rescan to the end of the text
    // for every BEGIN that had no END, so the cost grew with the number of
    // BEGIN lines (16000 lines = 854 ms; 1 MiB through redact() = 4.4 s).
    // Both texts here are exactly 1 MiB — the same memory footprint and cache
    // behaviour — so the only thing that differs is the number of BEGIN
    // lines: a linear scan costs the same for one as for 1024 (measured
    // ~1×), the quadratic one ~50× more (V8 runs the lazy rescan at literal-
    // search speed, ~0.1 ms per MiB per BEGIN, so a thousand lines are
    // needed for a margin no CI runner can close). A size-doubling form of
    // this test measured 3.10× per doubling under the parallel full-suite
    // load — cache effects at 1 MiB, not the algorithm — which is why the
    // size is held fixed. Runs are interleaved and the best of five is kept,
    // four passes per timing, so a transient stall cannot land on one text
    // alone and the figures are milliseconds rather than timer ticks.
    const { LINE, SIZE, RUNS, PASSES, COUNTS, BOUND } = DENSITY;
    const texts = COUNTS.map((k) => LINE.repeat(k) + "A".repeat(SIZE - k * LINE.length));
    const best = texts.map(() => Number.POSITIVE_INFINITY);
    for (let run = 0; run < RUNS; run++) {
      for (let i = 0; i < texts.length; i++) {
        const started = process.hrtime.bigint();
        for (let pass = 0; pass < PASSES; pass++) maskSecrets(texts[i] as string);
        best[i] = Math.min(best[i] as number, Number(process.hrtime.bigint() - started) / 1e6);
      }
    }
    // A floor on the divisor: a sub-millisecond figure must not make a
    // healthy 1× read as 30×.
    const ratio = (best[1] as number) / Math.max(best[0] as number, 1);
    assert.ok(
      ratio < BOUND,
      `${COUNTS[1]} BEGIN lines cost ${ratio.toFixed(2)}× one (best of ${RUNS}, ${PASSES} passes each: ${best
        .map((t) => t.toFixed(1))
        .join(" / ")} ms)`,
    );
  });
});

// ── The normative document describes only tests that ship ───────
//
// docs/redaction.md is normative and this file is what asserts it. The
// re-verifier found the document describing a size-doubling growth test
// that was replaced by the density test above; the pin below reads the
// document against that test's own constants, so the two cannot drift apart
// again without one of them failing.

describe("docs/redaction.md — the linearity claim describes the shipped test", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const doc = readFileSync(join(here, "..", "docs", "redaction.md"), "utf-8");

  it("does not describe the retired per-doubling test", () => {
    assert.doesNotMatch(doc, /3× per doubling/);
    assert.doesNotMatch(doc, /256 KiB to 1 MiB/);
  });

  it("describes the density test with its constants", () => {
    assert.match(doc, new RegExp(`${DENSITY.COUNTS[1]} \`BEGIN\` lines`));
    assert.match(doc, /exactly 1 MiB/);
    assert.match(doc, new RegExp(`under ${DENSITY.BOUND}×`));
    assert.match(
      doc,
      new RegExp(`best of ${DENSITY.RUNS} interleaved runs, ${DENSITY.PASSES} passes each`),
    );
  });

  it("no longer records the retired 4 KiB Digest window or the sentence-punctuation cost (D155)", () => {
    assert.doesNotMatch(doc, /4 KiB past/);
    assert.doesNotMatch(doc, /at most 4 KiB/);
    assert.match(doc, /one parameter at a time|per parameter/);
    assert.match(doc, /glued/);
  });
});
