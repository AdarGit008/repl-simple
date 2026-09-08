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

import { HEAD_ONLY_RATIO, truncateText } from "./truncate.js";

// ── Replacement tokens ──────────────────────────────────────────

/** What a masked value becomes. Contains no character any rule matches, so masking is idempotent. */
export const REDACTED = "[REDACTED]";

/** What a PEM private-key block becomes, envelope included. */
export const REDACTED_PRIVATE_KEY = "[REDACTED PRIVATE KEY]";

// ── Rules ───────────────────────────────────────────────────────
//
// Every pattern is linear on long inputs: name prefixes are bounded and lazy,
// alternations are anchored on a word boundary or a literal, and no rule
// begins with an unbounded greedy class. The "bounded work" tests pin that.

/**
 * Family 1 — known token prefixes. The prefix is kept (`sk-[REDACTED]`) so
 * the reader still learns what kind of credential was there; the body needs
 * at least 16 token characters, which no real credential of these shapes is
 * shorter than and which keeps `sk-1`-style lookalikes as data.
 */
const TOKEN_PREFIX =
  /\b(sk-(?:ant-)?|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{16,}/g;

/**
 * Family 2a — an `Authorization` header value, plain or JSON-quoted. The
 * scheme survives (`Bearer`, `Basic`) because it identifies the failure
 * without identifying the request; the credential after it does not.
 */
const AUTHORIZATION_HEADER =
  /(\bAuthorization["']?\s*:\s*["']?)(?:([A-Za-z][A-Za-z0-9-]*)\s+)?([^\s"']+)/gi;

/** Family 2b — a bare `Bearer <token>` outside a header line. The word keeps its spelling. */
const BEARER_VALUE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Family 3a — a PEM private-key block, envelope included. Certificates and public keys are not secrets. */
const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Family 3b — a block whose END line was cut off (the head-only case): everything from BEGIN on. */
const PEM_PRIVATE_KEY_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;

/**
 * Family 4 — `NAME=value` / `NAME: value` where NAME says "secret": a name
 * ending in `_KEY` / `-KEY` / `.KEY`, the bare `APIKEY`, or a name ending in
 * `TOKEN` / `SECRET` / `PASSWORD` / `PASSWD`. Bare `key=` is deliberately
 * excluded — it is Python's sort kwarg and would corrupt any code dump — and
 * `\b` after the keyword keeps `max_tokens=`, `passwords=` and `tokenizer=`
 * as data. The value stops at whitespace, a quote, `;`, `,` or `&`, so the
 * terminator and whatever follows survive.
 */
const SECRET_ASSIGNMENT =
  /\b((?:[A-Za-z0-9_.-]{0,63}?[_.-]KEY|APIKEY|[A-Za-z0-9_.-]{0,64}?(?:TOKEN|SECRET|PASSWORD|PASSWD))\b["']?\s*[=:]\s*["']?)([^\s"';,&]+)/gi;

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
 * header rule runs before the bare-`Bearer` rule so a header keeps its scheme,
 * and the token-prefix rule runs before the assignment rule so
 * `GITHUB_TOKEN=ghp_…` collapses to `GITHUB_TOKEN=[REDACTED]` rather than
 * `GITHUB_TOKEN=ghp_[REDACTED]`. Idempotent: no replacement token contains a
 * character any rule can match.
 */
export function maskSecrets(text: string): MaskResult {
  let masked = 0;
  const count = <T extends string>(replacement: T): T => {
    masked++;
    return replacement;
  };
  const out = text
    .replace(TOKEN_PREFIX, (_m, prefix: string) => count(`${prefix}${REDACTED}`))
    .replace(AUTHORIZATION_HEADER, (_m, lead: string, scheme: string | undefined) =>
      count(`${lead}${scheme ? `${scheme} ` : ""}${REDACTED}`),
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
