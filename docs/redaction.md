# Redaction

`src/redact.ts` is the one place text is redacted before it leaves a boundary. This document is
normative for what it does; `test/redact.test.ts` is what asserts it. It sits beside
`docs/truncation-policy.md`, which governs the *cut*; this document governs what is masked before
the cut and why the two are composed in one object. Decision D100 (session 2026-09-08, decision 6).

## The rule in one sentence

**Mask known-shape secrets, then cut head-only with a marker that carries no magnitude.**

```ts
import { redact } from "./redact.js";

const { text, truncated, masked } = redact(providerError, {
  maxBytes: 1024,
  recovery: "The full provider error is not surfaced.",
});
```

- `maskSecrets(text)` replaces every recognised secret with `[REDACTED]` (a PEM block with
  `[REDACTED PRIVATE KEY]`) and reports how many it replaced.
- `truncateText` then cuts at `HEAD_ONLY_RATIO` with `unknownTotal: true`, so the marker reads
  `[… truncated at 1.0KB. <recovery> …]` — where it cut, never how much it withheld (#191).
- Under the budget and with nothing to mask, the text is byte-identical.

### Why mask first

A token that straddles the cut boundary would, under cut-then-mask, keep its first few characters in
the head — too short for any rule to recognise, and a real prefix of the real credential. Masking the
whole input first means the cut can only ever split a `[REDACTED]` token. It also means `masked`
counts secrets in the dropped tail; that is deliberate — the count is a fact about the input, and a
caller logging it should not be told "0" because the secret happened to be past the cut.

### Why head-only, and why no magnitude

Both are inherited from the truncation policy's redaction rule: 50/50 head+tail is a *value* shape
and keeps the tail, which is exactly where provider request-context, retry hints and request IDs
live; and on a redaction cut the true total is a fact about the withheld text, not an affordance.

## The four pattern families

Every rule is case-sensitive unless noted, anchored on a word boundary or a literal, and linear on
long inputs (the "bounded work" tests run each over 1 MiB of adversarial shapes). No rule reads
across a line: whitespace inside a rule is a space or a tab, never a newline, so a header dump is
masked one header at a time and prose on the next line is prose.

| # | Shape | Example → result | Notes |
|---|---|---|---|
| 1 | Known token prefixes: `sk-` (incl. `sk-ant-`), `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_`, `glpat-`, `xox[abprs]-`, `AKIA`, `AIza`, followed by ≥ 16 token characters | `sk-abc…xyz` → `sk-[REDACTED]` | Prefix kept so the reader learns the credential's kind. Shorter than 16 → data (`sk-1`). |
| 2a | `Authorization:` (or `Proxy-Authorization:`) header value, plain or JSON-quoted | `Authorization: Bearer eyJ…` → `Authorization: Bearer [REDACTED]`; `Authorization: abc123…` → `Authorization: [REDACTED]`; `Authorization: Bot abc…` → `Authorization: [REDACTED]` | A known scheme is kept: `Basic`, `Bearer`, `Digest`, `Token`, `Negotiate`, `NTLM`, `HOBA`, `Mutual`, `AWS4-HMAC-SHA256` (any case). An unknown first token followed by a second on the same line — a scheme this rule does not know, or a credential followed by a word — is masked *with* that second token: the two are indistinguishable, and keeping the first would leak a `Bot`/`SSWS`/`OAuth` credential. A lone value is masked whole. The value ends at end of line, whitespace, a quote, `;` or `,`, so `Authorization: Bearer a; Authorization: Bearer b` masks both and keeps the `;`. A known scheme with nothing after it is data. |
| 2b | Bare `Bearer <token>` (≥ 8 token chars) on one line | `curl -H 'bearer abc…'` → `Bearer [REDACTED]` | Case-insensitive. "the bearer of" is data (too short); "the Bearer\nauthentication scheme" is data (next line). |
| 3 | PEM private-key block, `BEGIN … PRIVATE KEY` to `END …`, or from `BEGIN` to end of text when the `END` line is gone (the head-only case) | whole block → `[REDACTED PRIVATE KEY]` | `CERTIFICATE` and `PUBLIC KEY` blocks are not secrets and are untouched. |
| 4 | `NAME=value` / `NAME: value` (quotes and spaces tolerated) where NAME ends in `_KEY`/`-KEY`/`.KEY`, is `APIKEY`, or ends in `TOKEN`/`SECRET`/`PASSWORD`/`PASSWD` | `API_KEY=abc` → `API_KEY=[REDACTED]`; `"api_key": "x"` → `"api_key": "[REDACTED]"` | Case-insensitive. The value stops at whitespace, a quote, `;`, `,` or `&`. |

Rules compose: `GITHUB_TOKEN=ghp_…` is masked by family 1 and then family 4, ending as
`GITHUB_TOKEN=[REDACTED]`.

### What family 4 deliberately does not match

- **Bare `key=`.** It is Python's sort kwarg (`sorted(rows, key=lambda …)`) and `dict(key=value)`;
  masking it would corrupt every code dump #63 exports. Compound names (`api_key`, `x-api-key`,
  `secret.key`) and `apikey` are matched; `monkey=`, `turkey=` are not (no separator before `key`).
- **Plurals and derivations.** `\b` after the keyword keeps `max_tokens=`, `passwords=`,
  `tokenizer=`, `password_hash=` as data.
- **`PRIMARY KEY`** (SQL) — a space is not a separator.

## Idempotence

`maskSecrets(maskSecrets(x).text)` equals `maskSecrets(x)` in **text and count** — a second pass
masks nothing — and the same holds for `redact`. The prefix, Bearer and PEM rules cannot match inside
a replacement token; the two value-taking rules (header, assignment) refuse a value that is already
`[REDACTED]`. A second cut of an already-cut text is under budget. Pinned over every positive fixture
and the whole corpus.

## Known limits (the accepted bound, recorded — not hidden)

**False negatives.** A secret with none of the four shapes is data to this module: a bare
high-entropy string, a provider-specific prefix not in family 1, a credential whose name is not one
of the four words (`AUTH=`, `CREDENTIAL=`), a value containing spaces (`password="my pass"` masks
`my`). The masking is defence in depth on top of the head-only cut, not a proof; #192 accepts that
the cut alone passes a short or leading secret, and `LlmClient` implementations are declared trusted
host code precisely so the bound is about provider *responses*, not hostile clients.

**False positives.** A word after `password:` in prose (`password: required` masks `required`), a
key-file path (`server.key=/etc/ssl/server.key` masks the path), a URL query named `token`, the word
after a schemeless `Authorization:` value on the same line (`Authorization: abc123 for user 7` masks
`for` with the credential — see 2a). The cost is one masked word; the alternative is a leaked
credential, and every entry in the corpus is a realistic non-secret this rule set leaves alone.

**Not a substitute for keeping secrets out.** `RlmOptions.inputs` are announced to the model in the
prompt and readable from sandbox code; nothing here masks them, and nothing should — the contract is
"never pass secrets or data the model must not see". `src/bashenv.ts` is a different layer: it
withholds environment variables from `bash` by *name* before the command runs. Redaction here is for
text that already exists and is about to cross a boundary.

## Consumers

| Site | Budget | Since |
|---|---|---|
| `redactProviderError` — the D53 catch, `llm_query` and downgraded `rlm_query` tool paths (`src/rlm.ts`) | 1 KiB | this chunk (#191, #192) |
| Trace export (#46) and session-dump export/display mode (#63) | per their specs | wave 2 |

New redaction sites call `redact()`; calling `truncateText` directly for a redaction re-opens the
drift #189 closed.
