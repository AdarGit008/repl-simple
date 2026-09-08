# Redaction

`src/redact.ts` is the one place text is redacted before it leaves a boundary. This document is
normative for what it does; `test/redact.test.ts` is what asserts it. It sits beside
`docs/truncation-policy.md`, which governs the *cut*; this document governs what is masked before
the cut and why the two are composed in one object. Decision D100 (session 2026-09-08, decision 6);
the header, Bearer and assignment refinements below are D137.

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
long inputs: the "bounded work" tests run each over 1 MiB of adversarial shapes, and a density test
holds the PEM scan linear — two texts of exactly 1 MiB, one holding a single `BEGIN` line and one
holding 1024 `BEGIN` lines with no `END`, the many-line text costing under 3× the one-line text
(best of 5 interleaved runs, 4 passes each) — the shape that was ×4 per doubling before the body
scan was tempered to stop at the next `BEGIN`. The slowest measured constant is the assignment rule
on an alternating word/non-word run (`a-a-a-…`): ~0.4 s per MiB, linear; every other shape is under
30 ms per MiB. No rule reads across a line: whitespace inside a rule is a space or a tab, never a
newline, so a header dump is masked one header at a time and prose on the next line is prose.

| # | Shape | Example → result | Notes |
|---|---|---|---|
| 1 | Known token prefixes: `sk-` (incl. `sk-ant-`), `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_`, `glpat-`, `xox[abprs]-`, `AKIA`, `AIza`, followed by ≥ 16 token characters | `sk-abc…xyz` → `sk-[REDACTED]` | Prefix kept so the reader learns the credential's kind. Shorter than 16 → data (`sk-1`). |
| 2a | `Authorization:` (or `Proxy-Authorization:`) header value, plain or JSON-quoted | `Authorization: Bearer eyJ…` → `Authorization: Bearer [REDACTED]`; `Authorization: Bearer "eyJ…"` → `Authorization: Bearer "[REDACTED]"`; `Authorization: abc123…` → `Authorization: [REDACTED]`; `Authorization: Bot abc…` → `Authorization: [REDACTED]` | A known scheme is kept: `Basic`, `Bearer`, `Digest`, `Token`, `Negotiate`, `NTLM`, `HOBA`, `Mutual`, `AWS4-HMAC-SHA256` (any case); a credential quoted after the scheme keeps its quotes. An unknown first token followed by a second on the same line — a scheme this rule does not know, or a credential followed by a word — is masked *with* that second token: the two are indistinguishable, and keeping the first would leak a `Bot`/`SSWS`/`OAuth` credential. A lone value is masked whole. The value ends at end of line, whitespace, a quote, `;` or `,`, so `Authorization: Bearer a; Authorization: Bearer b` masks both and keeps the `;`. A known scheme with nothing after it is data. |
| 2a, Digest | `Authorization: Digest <parameters>` | `Authorization: Digest username="u", realm="r", nonce="dcd9…", uri="/x", response="6629…"` → `… nonce="[REDACTED]", uri="/x", response="[REDACTED]"` | A parameter list, not a token: the values of `response`, `nonce` and `cnonce` — the replayable parts — are masked (quoted, bare, or JSON-escaped), each counted once; `username`, `realm`, `uri`, `qop`, `nc`, `opaque` and `algorithm` survive as the context that says which request failed. A header with none of the three is untouched. The list is read to the end of the line, at most 4 KiB past `Digest`. A `Digest` followed by a bare token instead of parameters takes the generic row above. `WWW-Authenticate: Digest …` is a challenge, not a credential, and is data. |
| 2b | Bare `Bearer <token>` on one line, where the token looks like a credential: ≥ 8 token characters, **and** either ≥ 16 of them or a digit / `_` / `-` somewhere, **and** not a run of lowercase letters | `curl -H 'bearer 0123…'` → `bearer [REDACTED]`; `the Bearer authentication scheme is used` → unchanged | The word matches in any case; the lowercase-word test is case-sensitive. "the bearer of" is data (too short); "the Bearer authentication scheme" is data (a word); "the Bearer\nauthentication scheme" is data (next line). Inside a header the same token masks regardless — the header's name is the evidence there. |
| 3 | PEM private-key block, `BEGIN … PRIVATE KEY` to `END …`, or from `BEGIN` to end of text when the `END` line is gone (the head-only case) | whole block → `[REDACTED PRIVATE KEY]` | `CERTIFICATE` and `PUBLIC KEY` blocks are not secrets and are untouched. The body scan stops at the next `-----BEGIN `: a `BEGIN` with no `END` before the next `BEGIN` is not a block, and the open-block rule then masks from the first such `BEGIN` to the end. |
| 4 | `NAME=value` / `NAME: value` (quotes, `export`, spaces around the separator tolerated) where NAME is `KEY`, `TOKEN`, `SECRET`, `PASSWORD`/`PASSWD` or a name ending in one of them (`API_KEY`, `x-api-key`, `server.key`, `APIKEY`, `ACCESS_TOKEN`, `client_secret`, `DB_PASSWORD`) | `KEY=abc` → `KEY=[REDACTED]`; `export API_KEY='x'` → `export API_KEY='[REDACTED]'`; `"api_key": "x"` → `"api_key": "[REDACTED]"`; `f(KEY=abc)` → `f(KEY=[REDACTED])` | Decision 6's list, literally, any case. Bare `key` takes `=` only (below). The value stops at whitespace, a quote, `;`, `,` or `&`, and never *ends* in `)`, `]` or `}` — a code dump keeps its shape — while a bracket inside the value is part of it (`PASSWORD=ab)cd` masks whole). |

Rules compose: `GITHUB_TOKEN=ghp_…` is masked by family 1 and then family 4, ending as
`GITHUB_TOKEN=[REDACTED]`.

### What family 4 deliberately does not match

- **Bare `key:`.** A field name — JSON `{"key": "id"}`, YAML `key: value` — far more often than a
  credential, and the decision's literal is `KEY=value`, so the bare word takes `=` only. Compound
  names (`api_key:`, `x-api-key:`) take both separators.
- **Words that merely contain the keyword.** A word boundary on both sides: `monkey=`, `turkey=`,
  `keyboard=`, `keyword=`, `key_id=`, `secret_id=` are data.
- **Plurals and derivations.** `\b` after the keyword keeps `max_tokens=`, `passwords=`,
  `tokenizer=`, `password_hash=` as data.
- **`PRIMARY KEY`** (SQL) — a space is not a separator.

And what it matches on purpose, at a price: Python's bare `key=` kwarg. `sorted(rows, key=lambda r:
r[1])` becomes `sorted(rows, key=[REDACTED] r: r[1])` and `sorted(rows, key=str.lower)` becomes
`sorted(rows, key=[REDACTED])` — decision 6 lists `KEY=value` literally, and a credential named
`KEY` outranks a kwarg's readability in a redacted dump; the closing paren survives so the code
keeps its shape. The exact outputs are pinned in the documented-costs table of `test/redact.test.ts`.

## Idempotence

`maskSecrets(maskSecrets(x).text)` equals `maskSecrets(x)` in **text and count** — a second pass
masks nothing — and the same holds for `redact`. The prefix, Bearer and PEM rules cannot match inside
a replacement token; the three value-taking rules (header, Digest parameter, assignment) refuse a
value that is already `[REDACTED]`. A second cut of an already-cut text is under budget. Pinned over
every positive fixture and the whole corpus.

## Known limits (the accepted bound, recorded — not hidden)

**False negatives.** A secret with none of the four shapes is data to this module: a bare
high-entropy string, a provider-specific prefix not in family 1, a credential whose name is not one
of the four words (`AUTH=`, `CREDENTIAL=`), a value containing spaces (`password="my pass"` masks
`my`), an all-lowercase-letter bearer token outside a header (`bearer abcdefghijklmnop` — no issued
token has that shape; inside a header it masks), a Digest parameter more than 4 KiB past the scheme
word. The masking is defence in depth on top of the head-only cut, not a proof; #192 accepts that
the cut alone passes a short or leading secret, and `LlmClient` implementations are declared trusted
host code precisely so the bound is about provider *responses*, not hostile clients.

**False positives.** A word after `password:` in prose (`password: required` masks `required`), a
key-file path (`server.key=/etc/ssl/server.key` masks the path), a URL query named `token`, Python's
bare `key=` kwarg (above), a mixed-case or 16-plus-letter word after a bare `Bearer`
(`Bearer AuthenticationScheme` masks the word), the word after a schemeless `Authorization:` value
on the same line (`Authorization: abc123 for user 7` masks `for` with the credential — see 2a). The
cost is one masked word; the alternative is a leaked credential, and every entry in the corpus is a
realistic non-secret this rule set leaves alone.

**Not a substitute for keeping secrets out.** `RlmOptions.inputs` are announced to the model in the
prompt and readable from sandbox code; nothing here masks them, and nothing should — the contract is
"never pass secrets or data the model must not see". `src/bashenv.ts` is a different layer: it
withholds environment variables from `bash` by *name* before the command runs. Redaction here is for
text that already exists and is about to cross a boundary.

## Consumers

| Site | Budget | Since |
|---|---|---|
| `redactProviderError` — the D53 catch, `llm_query` and downgraded `rlm_query` tool paths (`src/rlm.ts`) | 1 KiB | W1-5 (#191, #192) |
| Trace export (#46) and session-dump export/display mode (#63) | per their specs | wave 2 |

New redaction sites call `redact()`; calling `truncateText` directly for a redaction re-opens the
drift #189 closed.
