import { HEAD_ONLY_RATIO, truncateText } from "./truncate.js";

// The import sits above the module comment on purpose: with a `/** */` block
// ahead of the first import, V8 reports every line of the block as uncovered
// (measured — 26 lines, 83 % on a file every test executes whole).

/**
 * The one redaction.
 *
 * Two things a redaction site needs, composed in one place so they cannot
 * drift apart across sites (D100, decision 6):
 *
 * 1. **Secret masking** — known-shape secrets are replaced by a fixed token
 *    before anything else happens.
 * 2. **A head-only cut with a magnitude-free marker** — the shared truncator
 *    at `HEAD_ONLY_RATIO` with `unknownTotal`, so the marker states where it
 *    cut and nothing about what it withheld (#191).
 *
 * Masking runs *before* the cut. The other order leaves fragments: a token
 * straddling the cut boundary would keep its first few characters in the
 * head — too short for any rule to recognise, long enough to be a prefix of
 * the real thing.
 *
 * What this is not: a proof that no secret gets through. The rules cover
 * shapes with a recognisable prefix, header, envelope or name; a bare
 * high-entropy string that is none of those is data to this module. That is
 * the accepted bound recorded on `LlmClient` (#192) and in
 * `docs/redaction.md`, which is the normative description of the rules below.
 *
 * Consumers: the RLM provider-error path (`redactProviderError` in
 * `src/rlm.ts`) today; the trace and session-dump exports of #46 / #63 next.
 */

// ── Replacement tokens ──────────────────────────────────────────

/** What a masked value becomes. Every value-taking rule refuses it, so masking is idempotent — text and count. */
export const REDACTED = "[REDACTED]";

/** What a PEM private-key block becomes, envelope included. */
export const REDACTED_PRIVATE_KEY = "[REDACTED PRIVATE KEY]";

// ── Rules ───────────────────────────────────────────────────────
//
// Every pattern is linear on long inputs: name prefixes are bounded and lazy,
// alternations are anchored on a word boundary or a literal, no rule begins
// with an unbounded greedy class, and the PEM body scan is tempered so a
// BEGIN looks no further than the next BEGIN. Whitespace inside a rule is
// `[ \t]`, never `\s`: no rule reads across a line, so a header dump is
// masked one header at a time and prose on the next line is prose. The
// "bounded work" tests pin the budgets; the growth test pins the linearity.

/** The `[REDACTED]` token, escaped for a rule to refuse: an already-masked value is not a value. */
const REDACTED_LITERAL = String.raw`\[REDACTED\]`;

/**
 * Family 1 — known token prefixes. The prefix is kept (`sk-[REDACTED]`) so
 * the reader still learns what kind of credential was there; the body needs
 * at least 16 token characters, which no real credential of these shapes is
 * shorter than and which keeps `sk-1`-style lookalikes as data.
 */
const TOKEN_PREFIX =
  /\b(sk-(?:ant-)?|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{16,}/g;

/**
 * Family 2a — an `Authorization` header value (also `Proxy-Authorization`),
 * plain or JSON-quoted. Three shapes, each read on one line:
 *
 * - `<known scheme> <credential>` — the scheme survives (`Bearer`, `Basic`,
 *   …) because it identifies the failure without identifying the request;
 *   the credential does not. The credential may itself be quoted
 *   (`Bearer "…"`, non-standard but seen): the quote survives with the
 *   scheme and the value inside it goes.
 * - `<token> <token>` with a scheme this rule does not know — `Bot`, `SSWS`,
 *   `OAuth`, or a credential followed by prose: indistinguishable, so the
 *   pair is masked whole. The cost is one word of prose in the rare second
 *   case; the alternative is a scheme word kept and a credential leaked.
 * - `<credential>` alone — line end, quote, `;` or `,` follows — masked whole.
 *
 * `Digest` is the exception: its value is a parameter list in which only
 * some parameters are credentials, so a `Digest` followed by a `name=`
 * parameter is left to the Digest rule below (the first token is the tell)
 * and only a `Digest` followed by a bare token is masked like the others.
 *
 * A value ends at whitespace, a quote, `;` or `,`, so a `;`-joined list keeps
 * its separators and the next header keeps its name. A known scheme with no
 * credential after it on the line is data, and so is `[REDACTED]`.
 */
const AUTH_PLAIN_SCHEMES = "Basic|Bearer|Token|Negotiate|NTLM|HOBA|Mutual|AWS4-HMAC-SHA256";
const AUTH_SCHEMES = `${AUTH_PLAIN_SCHEMES}|Digest`;
const AUTH_VALUE = String.raw`[^\s"';,]+`;
/** A `name=` token — what a Digest parameter list starts with. */
const AUTH_PARAMETER = String.raw`[^\s"';,=]+[ \t]*=`;
const AUTHORIZATION_HEADER = new RegExp(
  String.raw`(\bAuthorization["']?[ \t]*:[ \t]*["']?)` +
    String.raw`(?!(?:(?:${AUTH_SCHEMES})[ \t]+["']?)?${REDACTED_LITERAL})` +
    String.raw`(?:((?:${AUTH_PLAIN_SCHEMES})[ \t]+["']?|Digest[ \t]+["']?(?!${AUTH_PARAMETER}))${AUTH_VALUE}` +
    String.raw`|(?!(?:${AUTH_SCHEMES})(?!${AUTH_VALUE}))${AUTH_VALUE}(?:[ \t]+${AUTH_VALUE})?)`,
  "gi",
);

/**
 * Family 2a, Digest — `Authorization: Digest <parameters>`. The replayable
 * parts are the `response` hash and the two nonces; `username`, `realm`,
 * `uri`, `qop`, `nc`, `opaque` and `algorithm` are the context a reader
 * needs to see which request failed, so they survive. Each masked parameter
 * counts once; a header carrying none of the three is left alone (the old
 * rule masked `username=`, the parameter *name*, and kept the hash).
 *
 * The parameter list is read to the end of the line, at most 4 KiB past
 * `Digest` — ten times a real one — so a line of `;`-joined headers costs
 * one bounded scan per header rather than a rescan to the line's end for
 * each. A quoted value may carry a JSON escape (`\"…\"`); the value class
 * excludes backslashes, which no hex or base64 parameter contains.
 */
const DIGEST_HEADER = new RegExp(
  String.raw`(\bAuthorization["']?[ \t]*:[ \t]*["']?Digest[ \t]+)(?=${AUTH_PARAMETER})([^\n]{0,4096})`,
  "gi",
);
const DIGEST_PARAMETER = new RegExp(
  String.raw`(\b(?:response|nonce|cnonce)[ \t]*=[ \t]*(?:\\?["'])?)(?!${REDACTED_LITERAL})([^\s"';,\\]+)`,
  "gi",
);

/**
 * Family 2b — a bare `Bearer <token>` outside a header line, on one line.
 * The word keeps its spelling. Outside a header there is no name to anchor
 * on, so the token has to carry the evidence: at least 8 token characters,
 * and either 16 or more of them or a digit, underscore or dash somewhere,
 * and not a run of lowercase letters — `the Bearer authentication scheme is
 * used` is prose, `bearer 0123456789abcdef` is a token. Real bearer tokens
 * are base64, hex or JWTs, so the lowercase-word exclusion costs a shape no
 * issued token has (recorded in `docs/redaction.md`). The word is matched in
 * any case without the `i` flag, which would make the lowercase test blind.
 */
const BEARER_TOKEN = "[A-Za-z0-9._~+/=-]";
const BEARER_VALUE = new RegExp(
  String.raw`\b([Bb][Ee][Aa][Rr][Ee][Rr])[ \t]+` +
    `(?![a-z]+(?!${BEARER_TOKEN}))` +
    `(?=${BEARER_TOKEN}{16}|${BEARER_TOKEN}*[0-9_-])` +
    `${BEARER_TOKEN}{8,}`,
  "g",
);

/**
 * Family 3a — a PEM private-key block, envelope included. The body scan is
 * tempered — it stops at the next `-----BEGIN ` — so a BEGIN with no END
 * costs one look as far as the next BEGIN, not a rescan to the end of the
 * text for every BEGIN (that was quadratic: ×4 per doubling, 16000 lines in
 * 854 ms). A BEGIN with no END before the next BEGIN is not a block; family
 * 3b then masks from the first such BEGIN to the end. Certificates and
 * public keys are not secrets.
 */
const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Family 3b — a block whose END line was cut off (the head-only case): everything from BEGIN on. */
const PEM_PRIVATE_KEY_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;

/**
 * Family 4 — `NAME=value` / `NAME: value` where NAME says "secret":
 * decision 6's `KEY|TOKEN|SECRET|PASSWORD=value`, literally. NAME is the
 * bare word (`KEY=`, `TOKEN=`, `SECRET=`, `PASSWORD=`, `PASSWD=`) or a name
 * ending in it (`API_KEY`, `x-api-key`, `server.key`, `APIKEY`,
 * `ACCESS_TOKEN`, `client_secret`, `DB_PASSWORD`). Case-insensitive; an
 * optional quote and spaces around the separator (`export KEY="…"`,
 * `"api_key": "…"`). A word boundary on both sides of the keyword keeps
 * `monkey=`, `keyboard=`, `keyword=`, `key_id=`, `max_tokens=`,
 * `passwords=` and `tokenizer=` as data. Bare `key` takes `=` only: `key:`
 * is a JSON/YAML field name far more often than a credential, and the
 * decision's literal is `KEY=value` (Python's `key=` kwarg therefore masks —
 * the recorded cost). The value stops at whitespace, a quote, `;`, `,` or
 * `&`, so the terminator and whatever follows survive, and it never *ends*
 * in a closing bracket, brace or paren — `f(KEY=abc)` keeps its `)`,
 * `sorted(rows, key=str.lower)` keeps its shape — while a bracket inside a
 * value is part of it and goes with it. The one closing bracket a value may
 * end in is the `]` of a `[REDACTED]` the prefix rule left there
 * (`GITHUB_TOKEN=ghp_[REDACTED]` collapses whole). A value that is already
 * `[REDACTED]` is not a value.
 *
 * The rule's constant is the largest here: a word boundary at every
 * character of an alternating word/non-word run and up to ~130 lazy name
 * expansions per position cost ~0.4 s per MiB of `a-a-a-…` (measured;
 * linear, and every other shape is under 30 ms per MiB).
 */
const SECRET_NAME = "[A-Za-z0-9_.-]";
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b((?:` +
    String.raw`(?:${SECRET_NAME}{0,63}?[_.-]KEY|APIKEY|${SECRET_NAME}{0,64}?(?:TOKEN|SECRET|PASSWORD|PASSWD))\b["']?[ \t]*[=:]` +
    String.raw`|KEY\b["']?[ \t]*=` +
    String.raw`)[ \t]*["']?)(?!${REDACTED_LITERAL})([^\s"';,&]*${REDACTED_LITERAL}|[^\s"';,&]*[^\s"';,&)\]}])`,
  "gi",
);

// ── Masking ─────────────────────────────────────────────────────

export interface MaskResult {
  /** The text with every recognised secret replaced. */
  text: string;
  /** How many matches were replaced across all rules. */
  masked: number;
}

/**
 * Replace every recognised secret in `text` with a redaction token.
 *
 * Rule order matters only where two rules can see the same bytes: the
 * header rules run before the bare-`Bearer` rule so a header keeps its
 * scheme, and the token-prefix rule runs before the assignment rule so
 * `GITHUB_TOKEN=ghp_…` collapses to `GITHUB_TOKEN=[REDACTED]` rather than
 * `GITHUB_TOKEN=ghp_[REDACTED]`. Idempotent in text and count: the prefix,
 * Bearer and PEM rules cannot match inside a replacement token, and the
 * three value-taking rules (header, Digest parameter, assignment) refuse a
 * value that already is one.
 */
export function maskSecrets(text: string): MaskResult {
  let masked = 0;
  const count = <T extends string>(replacement: T): T => {
    masked++;
    return replacement;
  };
  const out = text
    .replace(TOKEN_PREFIX, (_m, prefix: string) => count(`${prefix}${REDACTED}`))
    .replace(
      DIGEST_HEADER,
      (_m, lead: string, parameters: string) =>
        `${lead}${parameters.replace(DIGEST_PARAMETER, (_p, name: string) => count(`${name}${REDACTED}`))}`,
    )
    .replace(AUTHORIZATION_HEADER, (_m, lead: string, scheme: string | undefined) =>
      count(`${lead}${scheme ?? ""}${REDACTED}`),
    )
    .replace(BEARER_VALUE, (_m, word: string) => count(`${word} ${REDACTED}`))
    .replace(PEM_PRIVATE_KEY_BLOCK, () => count(REDACTED_PRIVATE_KEY))
    .replace(PEM_PRIVATE_KEY_OPEN, () => count(REDACTED_PRIVATE_KEY))
    .replace(SECRET_ASSIGNMENT, (_m, lead: string) => count(`${lead}${REDACTED}`));
  return { text: out, masked };
}

// ── Redaction ───────────────────────────────────────────────────

export interface RedactOptions {
  /** Hard byte ceiling on the result, marker included (truncate.ts invariant 1). */
  maxBytes: number;
  /** Recovery clause in the marker. Must not name a route that does not exist (policy Q3). */
  recovery: string;
}

export interface RedactResult {
  /** The masked, head-only-cut text. */
  text: string;
  /** Whether the cut fired. */
  truncated: boolean;
  /** How many secrets were masked — counted over the whole input, not the kept head. */
  masked: number;
}

/**
 * Mask, then cut head-only with a magnitude-free marker.
 *
 * Head-only because the goal is withholding a tail, not displaying a value
 * (policy: "Redaction shape"); `unknownTotal` because a redaction marker
 * must not state how much it withheld (#191). Under the budget and with no
 * secret the text is byte-identical.
 */
export function redact(text: string, opts: RedactOptions): RedactResult {
  const { text: maskedText, masked } = maskSecrets(text);
  const { text: cut, truncated } = truncateText(maskedText, {
    maxBytes: opts.maxBytes,
    headRatio: HEAD_ONLY_RATIO,
    recovery: opts.recovery,
    unknownTotal: true,
  });
  return { text: cut, truncated, masked };
}
