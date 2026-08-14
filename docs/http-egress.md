# HTTP egress policy for `http_get`

**Status:** Decided · **Issue:** #42 (Bucket 4, step 1) · **Implemented in:** `src/builtins.ts`

`http_get` is the sandbox's only way to reach the network — Monty itself has none — so it is the leg
of the read/execute/egress trifecta that decides whether a compromised script can *send* what it
read. It shipped ungated: no approval, no destination policy, and `redirect: "follow"`, which
[`docs/REVIEW.md` B3, H36] measured as a **zero-prompt exfiltration path** and a working SSRF
primitive (a public-looking host answering `302 → http://127.0.0.1:<port>/` returned the internal
body).

---

## The decision in one table

| | Without an allowlist | With an allowlist |
|---|---|---|
| **Prompt** | every fetch | never |
| **Destination** | anything public | allowlisted hosts, and public |
| **`requiresApproval`** | `true` | `false` |
| **Configured by** | the default | `httpAllowlist`, or `REPL_HTTP_ALLOWLIST` |

Both columns break the exfiltration chain, and every other defence below applies to both.

### Why not a blanket per-fetch prompt in all cases

A prompt on every fetch is the obvious answer and the one that decays fastest. `http_get` is a
high-frequency tool in exactly the workloads that want it — scrape a page, poll an endpoint, walk an
API — and a prompt that fires on each call gets click-through-approved as reflexively as any other
high-frequency dialog. What survives the twentieth prompt is not a decision.

An allowlist moves the decision to where the caller actually has one: the set of destinations is
usually known when the runner is configured, and it can be stated once, reviewed, and diffed. So a
caller who knows their destinations declares them and is never asked again; a caller who does not is
asked every time, which is the honest cost of not knowing.

### Why the allowlist is not a soft preference

With an allowlist configured, an off-list host is **refused**, not prompted. Prompting for the
off-list case would re-create the click-through path through the back door and make the allowlist a
suggestion. The allowlist is the caller saying "these are all the destinations", and that sentence is
only worth anything if it excludes.

---

## Defence in depth: what is refused regardless

Approval and allowlisting are about *who decided*. They say nothing about *where the packet lands*,
and a user who approves one fetch has not thereby approved a fetch to the cloud metadata endpoint. So
the address policy runs on every request, in both modes:

- **The hostname is resolved and the resolved addresses are checked** — every address it answers
  with, not just the first. Names are checked as addresses because a name is not a destination.
- **Refused ranges:** loopback (`127/8`, `::1`), the unspecified address, link-local (`169.254/16` —
  which is where `169.254.169.254` lives — and `fe80::/10`), RFC1918 (`10/8`, `172.16/12`,
  `192.168/16`), CGNAT (`100.64/10`), unique-local (`fc00::/7`), multicast and the reserved blocks.
  IPv6 spellings of an IPv4 address (`::ffff:`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are unwrapped
  and checked as IPv4, so `::ffff:127.0.0.1` is not a way around a v4-only list.
- **Redirects are followed by hand** (`redirect: "manual"`), up to 5 hops, and **every hop goes
  through the whole check again** — scheme, allowlist, addresses. First-URL validation is what H36
  defeated.
- **One deadline for the whole call** (`AbortSignal.timeout`, 30 s by default), covering the redirect
  chain and the body read, not each hop separately.
- **The 256 KiB streaming cap is unchanged.** It was already correct — it cancels the reader rather
  than draining the body — and this issue deliberately did not touch it.

---

## Accepted risk: the DNS rebinding window

**The window is open.** `http_get` resolves the name, validates the addresses, and then hands `fetch`
the *name* — so a resolver that answers one address for the check and another for the connection
reaches a destination that was never validated.

Closing it means connecting to the address that was validated, which for `fetch` means supplying a
custom `lookup` through an `undici` dispatcher. `undici` is not a dependency of this package (Node's
`fetch` uses its own bundled copy, which is not importable), so closing this costs a new production
dependency.

That is not worth it here, yet. The attack needs control of an authoritative resolver **and** a name
that is either allowlisted or approved by the user — by which point the attacker already has a
sanctioned destination and does not need to rebind to reach it. The cheap half of the defence,
refusing the private ranges outright, is implemented and is what stops the untargeted case.

**Revisit if** `undici` arrives as a dependency for another reason, or if `http_get` ever gains a
mode where hostnames come from somewhere less trusted than the caller's own allowlist.

---

## Configuration

| Option | Environment | Default |
|---|---|---|
| `httpAllowlist: string[]` | `REPL_HTTP_ALLOWLIST` (comma-separated) | empty — every fetch prompts |
| `httpTimeoutSecs: number` | `REPL_HTTP_TIMEOUT_SECS` | 30 |
| `maxHttpBytes: number` | — | 256 KiB |

An allowlist entry is a hostname (`api.example.com`) or a `*.`-prefixed suffix (`*.example.com`,
which matches `example.com` as well as any subdomain). Matching is on the hostname only and is
case-insensitive; **ports are not part of it**, since the port cannot make a public host private —
the address check is what decides that.

An explicit `httpAllowlist: []` means "no allowlist" and takes precedence over the environment, so a
caller can force the prompting mode without unsetting a variable they do not control.

The `ReplRunner` path (`repl.ts`) passes no `httpAllowlist`, so the shipped `repl` tool prompts on
every fetch unless `REPL_HTTP_ALLOWLIST` is set in its environment.

---

## What was not done

- **Egress for the bridged `bash` tool.** `bash` can `curl`. It is gated by approval (#44 scopes that
  grant), and nothing here changes it.
- **A per-run fetch budget.** Approve N times and you get N fetches; there is no cap on N within a
  run. That is #35's shape of problem, not this one's.
- **POST, headers, or a body.** `http_get` remains GET-only. Widening the verb widens the exfiltration
  channel from a query string to a request body, and should be a decision of its own.
