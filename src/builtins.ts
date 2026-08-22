import { lookup } from "node:dns/promises";
import { open, readdir, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { createPathJail } from "./pathjail.js";
import { requireString } from "./registry.js";
import {
  Truncator,
  decodeWhole,
  VALUE_HEAD_RATIO,
  HEAD_ONLY_RATIO,
  FILE_RECOVERY,
  HTTP_RECOVERY,
} from "./truncate.js";
import { HostToolError } from "./types.js";
import type { HostTool } from "./types.js";

// ── Options ──────────────────────────────────────────────────────

export interface BuiltinToolsOptions {
  /** Workspace root; file tools cannot escape it. */
  root: string;
  /** Include the read_file tool. Disable when a workspace mount replaces it. Default true. */
  readFile?: boolean;
  /** Include the list_files tool. Disable when pi's bridged `ls` replaces it. Default true. */
  listFiles?: boolean;
  /** Cap on returned file bytes; longer files are truncated. Default 256 KiB. */
  maxFileBytes?: number;
  /** Cap on returned HTTP body bytes. Default 256 KiB. */
  maxHttpBytes?: number;
  /**
   * Hosts `http_get` may reach. When non-empty, every other host is refused and
   * no approval is asked for; when empty, every fetch requires approval.
   * Defaults to `REPL_HTTP_ALLOWLIST` (comma-separated). See
   * `docs/http-egress.md`.
   *
   * An entry is a hostname (`api.example.com`) or a `*.`-prefixed suffix
   * (`*.example.com`, which also matches `example.com`). Matching is on the
   * hostname only, case-insensitively; ports are not part of it.
   */
  httpAllowlist?: string[];
  /**
   * Wall-clock seconds for one `http_get`, redirect chain and body read
   * included. Default 30, or `REPL_HTTP_TIMEOUT_SECS`.
   */
  httpTimeoutSecs?: number;
  /** Injectable fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable hostname resolver (tests). Default: `dns.lookup(…, {all: true})`.
   * Returns every address the name resolves to; all of them are validated.
   */
  lookupImpl?: (hostname: string) => Promise<string[]>;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * These tools return a value *into the sandbox*, not into the model's context:
 * the model may read a file and process it in Python without ever displaying
 * it. So this is a data-safety ceiling, deliberately far above the 48 KiB
 * `stdout` + `output` budget that governs what actually reaches the model —
 * truncating here corrupts data, truncating there only shortens a view.
 */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Seconds one `http_get` gets, redirect chain and body read included. */
const DEFAULT_HTTP_TIMEOUT_SECS = 30;

/**
 * Redirect hops followed before giving up.
 *
 * We follow them by hand (`redirect: "manual"`) because `redirect: "follow"`
 * validates nothing after the first URL: a public-looking host that answers
 * `302 → http://127.0.0.1:<port>/` returned the internal body (measured, H36).
 * Every hop goes back through the same check as the original URL.
 */
const MAX_REDIRECT_HOPS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ── HTTP egress policy ───────────────────────────────────────────

/**
 * Hostnames that have ever resolved to a private or reserved address,
 * remembered for the life of the process.
 *
 * A rebinding resolver answers differently per lookup: "public" to the
 * validation lookup, "private" to the connection. Once a name has been seen
 * pointing at a blocked address it is never trusted again, regardless of what
 * a later lookup says. Keyed by case-normalized hostname.
 */
const everPrivate = new Set<string>();

/** Test-only: clear the ever-private memory so tests stay isolated. */
export function __resetEverPrivateForTests(): void {
  everPrivate.clear();
}

/**
 * Is this a literal address `http_get` must refuse?
 *
 * The list is the set an SSRF reaches for: loopback, the RFC1918 and CGNAT
 * ranges, link-local — which is where `169.254.169.254` lives — plus the
 * unspecified, multicast and reserved blocks. IPv6 is checked in the same
 * terms, and the several ways IPv6 can carry an IPv4 address (`::ffff:`,
 * NAT64, 6to4) are unwrapped and checked as IPv4, since otherwise
 * `::ffff:127.0.0.1` is a spelling of loopback that walks past a v4-only list.
 *
 * Exported because the ranges are data: a table this long is worth asserting
 * directly rather than only through the handful of them a fetch test reaches.
 */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isBlockedIpv4(address);
  if (kind === 6) {
    const groups = ipv6Groups(address);
    return groups === null ? true : isBlockedIpv6(groups);
  }
  // Not an address at all. Refusing is the safe answer: every caller here has
  // already resolved a name, so an unparseable result is a bug, not a host.
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && (b === 0 || b === 2)) return true; // 192.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // multicast, reserved, 255.255.255.255
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or `null` if it will not
 * parse. Only called on strings `isIP` already accepted, so this is a widening
 * of a known-good address rather than validation.
 */
function ipv6Groups(address: string): number[] | null {
  // Zone id (`fe80::1%eth0`) names an interface, not an address.
  let text = address.toLowerCase().replace(/%.*$/, "");

  // A trailing dotted quad (`::ffff:127.0.0.1`) is the same address as its hex
  // spelling; fold it so one parser handles both forms.
  const quad = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (quad) {
    const octets = quad[1].split(".").map(Number);
    if (octets.some((n) => n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, quad.index)}:${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((hex) => Number.parseInt(hex, 16));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const groups =
    halves.length === 2
      ? [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
      : head;

  if (groups.length !== 8) return null;
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embedded = (hi: number, lo: number) =>
    isBlockedIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  const zeroThrough = (n: number) => groups.slice(0, n).every((g) => g === 0);

  if (zeroThrough(7) && g7 <= 1) return true; // :: and ::1
  if (zeroThrough(5) && g5 === 0xffff) return embedded(g6, g7); // ::ffff:0:0/96
  if (zeroThrough(6)) return embedded(g6, g7); // deprecated ::a.b.c.d
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return embedded(g6, g7); // 64:ff9b::/96 NAT64
  }
  if (g0 === 0x2002) return embedded(g1, g2); // 2002::/16 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Resolve a hostname to every address it answers with.
 *
 * **The rebinding window is open, and is accepted risk.** This resolves the
 * name, validates the addresses, and then hands `fetch` the *name* — so a
 * resolver that answers differently for the connection than it did for the
 * check reaches a destination that was never validated. Closing it means
 * connecting to the address we pinned, which for `fetch` means supplying a
 * custom `lookup` through an `undici` dispatcher: a new production dependency,
 * for an attack that needs control of an authoritative resolver *and* an
 * allowlisted-or-approved name pointing at it. The cheap half of the defence —
 * refusing the private ranges outright — is what is implemented here. Revisit
 * if `undici` ever arrives for another reason.
 */
async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** Split and clean a comma-separated allowlist; empty entries drop out. */
function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function isAllowedHost(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) =>
    entry.startsWith("*.")
      ? host === entry.slice(2) || host.endsWith(entry.slice(1))
      : host === entry,
  );
}

/**
 * Positive-number env reader. Mirrors `sandbox.ts`'s private `envInt` rather
 * than sharing it, so that `builtins.ts` — which has no other reason to know
 * about the sandbox — does not import the Monty-bearing module for five lines.
 */
function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ── Private helpers ──────────────────────────────────────────────

/**
 * Read a file into the shared truncator, head + tail.
 *
 * `stat` gives the true size, so the marker can state what was dropped without
 * reading the middle: two seeks are enough. Both reads are decoded with
 * `decodeWhole`, because a byte offset chosen by arithmetic lands wherever it
 * lands — cutting a character there is what produced U+FFFD before (M5).
 */
async function readUtf8FileLimited(path: string, maxBytes: number): Promise<string> {
  const size = (await stat(path)).size;
  const handle = await open(path, "r");
  try {
    if (size <= maxBytes) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    }

    const out = new Truncator({
      maxBytes,
      headRatio: VALUE_HEAD_RATIO,
      recovery: FILE_RECOVERY,
      totalBytes: size,
    });
    const segment = Math.max(1, Math.ceil(maxBytes * VALUE_HEAD_RATIO)) + 8;

    const headBuf = Buffer.alloc(segment);
    const head = await handle.read(headBuf, 0, segment, 0);
    out.push(decodeWhole(headBuf.subarray(0, head.bytesRead)));

    const tailFrom = Math.max(head.bytesRead, size - segment);
    const tailBuf = Buffer.alloc(size - tailFrom);
    const tail = await handle.read(tailBuf, 0, tailBuf.length, tailFrom);
    out.push(decodeWhole(tailBuf.subarray(0, tail.bytesRead)));

    return out.render();
  } finally {
    await handle.close();
  }
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  // Head-only, and the total is left unknown: the read stops just past the
  // budget rather than draining an arbitrarily large body to measure it.
  // Keeping a tail would mean downloading all of it, and inventing a total
  // would break the "counters are true" invariant.
  const out = new Truncator({
    maxBytes,
    headRatio: HEAD_ONLY_RATIO,
    recovery: HTTP_RECOVERY,
    unknownTotal: true,
  });
  // One byte past the ceiling, so an over-long body actually overflows the
  // truncator rather than landing exactly on its budget and looking whole.
  const scanLimit = maxBytes + 1;

  const reader = response.body?.getReader();
  if (!reader) {
    out.push(await response.text());
    return out.render();
  }

  const chunks: Uint8Array[] = [];
  let collected = 0;
  let stopped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value ?? new Uint8Array();
      const remaining = scanLimit - collected;
      if (chunk.byteLength >= remaining) {
        chunks.push(chunk.subarray(0, remaining));
        stopped = true;
        break;
      }
      chunks.push(chunk);
      collected += chunk.byteLength;
    }
  } finally {
    if (stopped) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  out.push(decodeWhole(Buffer.concat(chunks)));
  return out.render();
}

// ── createBuiltinTools ───────────────────────────────────────────

/**
 * Starter host tools: read_file / list_files (rooted, escape-proof) and
 * http_get (host-side fetch — the sandbox itself has no network access).
 */
export function createBuiltinTools(options: BuiltinToolsOptions): HostTool[] {
  const root = resolve(options.root);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const maxHttpBytes = options.maxHttpBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowlist = (options.httpAllowlist ?? parseAllowlist(process.env.REPL_HTTP_ALLOWLIST)).map(
    (entry) => entry.trim().toLowerCase(),
  );
  const httpTimeoutMs =
    (options.httpTimeoutSecs ?? envSeconds("REPL_HTTP_TIMEOUT_SECS", DEFAULT_HTTP_TIMEOUT_SECS)) *
    1000;
  const lookupImpl = options.lookupImpl ?? defaultLookup;

  // Resolves a sandbox-relative path and rejects anything outside the root,
  // including symlink escapes. Shared with the bridged read tools (#43) —
  // see src/pathjail.ts for why there is exactly one of these.
  const jail = createPathJail(root);
  const resolveInRoot = (relPath: string): Promise<string> => jail.resolve(relPath);

  const readFileTool: HostTool = {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    params: [
      {
        name: "path",
        type: "str",
        description: "Path relative to the workspace root.",
      },
    ],
    returns: "str",
    async execute(args) {
      const path = requireString(args.path, "path");
      const real = await resolveInRoot(path);
      try {
        return await readUtf8FileLimited(real, maxFileBytes);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EISDIR") {
          throw new HostToolError("IsADirectoryError", `is a directory: '${path}'`);
        }
        throw new HostToolError("OSError", err.message);
      }
    },
  };

  const listFilesTool: HostTool = {
    name: "list_files",
    description: 'List directory entries in the workspace. Directories end with "/".',
    params: [
      {
        name: "path",
        type: "str",
        description: "Directory path relative to the workspace root.",
        optional: true,
      },
    ],
    returns: "str",
    async execute(args) {
      const raw = args.path ?? ".";
      const path = requireString(raw, "path");
      const real = await resolveInRoot(path);
      try {
        const entries = await readdir(real, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOTDIR") {
          throw new HostToolError("NotADirectoryError", `not a directory: '${path}'`);
        }
        throw new HostToolError("OSError", err.message);
      }
    },
  };

  /**
   * Every address this hostname stands for, without asking the network when it
   * is already an address. `URL.hostname` brackets IPv6 literals.
   */
  async function resolveAddresses(hostname: string): Promise<string[]> {
    const bare =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (isIP(bare)) return [bare];
    let addresses: string[];
    try {
      addresses = await lookupImpl(bare);
    } catch (e) {
      throw new HostToolError("OSError", `cannot resolve '${bare}': ${(e as Error).message}`);
    }
    if (addresses.length === 0) {
      throw new HostToolError("OSError", `cannot resolve '${bare}': no addresses`);
    }
    return addresses;
  }

  /** Scheme, allowlist and address checks. Run against every hop, not just the first. */
  async function assertReachable(url: URL): Promise<void> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new HostToolError("ValueError", `only http(s) URLs are allowed: '${url.href}'`);
    }
    if (allowlist.length > 0 && !isAllowedHost(url.hostname, allowlist)) {
      throw new HostToolError(
        "PermissionError",
        `host '${url.hostname}' is not on the http_get allowlist`,
      );
    }
    // A name that has ever pointed at a blocked address is never trusted again:
    // a rebinding resolver answers differently per lookup, so the next answer
    // being public proves nothing. Refused before any new lookup happens.
    const hostname = url.hostname.toLowerCase();
    if (everPrivate.has(hostname)) {
      throw new HostToolError(
        "PermissionError",
        `'${url.hostname}' previously resolved to a private or reserved address`,
      );
    }
    for (const address of await resolveAddresses(url.hostname)) {
      if (isBlockedAddress(address)) {
        everPrivate.add(hostname);
        throw new HostToolError(
          "PermissionError",
          `'${url.hostname}' resolves to ${address}, a private or reserved address`,
        );
      }
    }
  }

  /**
   * Follow the redirect chain by hand, validating each hop, under one deadline
   * for the whole call.
   *
   * The signal is shared across hops rather than renewed per hop so that a
   * chain of individually-quick redirects cannot outlast the budget, and it
   * covers the body read too — `fetch` ties the response stream to it.
   *
   * It does not cover name resolution: `dns.lookup` takes no signal, so a
   * resolver that hangs is bounded by the OS resolver's own timeout and not by
   * this one. Every hop's DNS is therefore outside the budget it is charged to.
   */
  async function fetchGuarded(initial: string): Promise<Response> {
    const signal = AbortSignal.timeout(httpTimeoutMs);
    let url: URL;
    try {
      url = new URL(initial);
    } catch {
      throw new HostToolError("ValueError", `not a valid URL: '${initial}'`);
    }

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      await assertReachable(url);
      let response: Response;
      try {
        response = await fetchImpl(url.href, { redirect: "manual", signal });
      } catch (e) {
        const err = e as Error;
        if (err.name === "TimeoutError" || err.name === "AbortError" || signal.aborted) {
          throw new HostToolError("TimeoutError", `request to '${url.href}' timed out`);
        }
        throw new HostToolError("OSError", `request failed: ${err.message}`);
      }

      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get("location")
        : null;
      // A 3xx with no Location is not a redirect anyone can follow; hand it
      // back and let the `ok` check report it as the error status it is.
      if (location === null) return response;

      // Nothing here will read this body, and an unread stream holds the
      // connection open until GC.
      await response.body?.cancel().catch(() => {});
      try {
        url = new URL(location, url);
      } catch {
        throw new HostToolError("OSError", `redirect to an unusable location: '${location}'`);
      }
    }
    throw new HostToolError(
      "OSError",
      `too many redirects (over ${MAX_REDIRECT_HOPS}) for ${initial}`,
    );
  }

  const httpGetTool: HostTool = {
    name: "http_get",
    description:
      "HTTP GET a URL and return the response body as text. Private, loopback and " +
      "link-local destinations are refused, on every redirect hop.",
    params: [
      {
        name: "url",
        type: "str",
        description: "An http:// or https:// URL.",
      },
    ],
    returns: "str",
    // Egress is the one leg of the exfiltration trifecta the agent does not
    // need in order to work, so it is never both silent and unrestricted: with
    // an allowlist the destinations are the caller's decision and no prompt is
    // asked, without one every fetch is. See docs/http-egress.md.
    requiresApproval: allowlist.length === 0,
    async execute(args) {
      const url = requireString(args.url, "url");
      if (!/^https?:\/\//i.test(url)) {
        throw new HostToolError("ValueError", `only http(s) URLs are allowed: '${url}'`);
      }
      const response = await fetchGuarded(url);
      if (!response.ok) {
        throw new HostToolError("OSError", `HTTP ${response.status} for ${url}`);
      }
      try {
        return await readResponseTextLimited(response, maxHttpBytes);
      } catch (e) {
        // The deadline covers the body too, so it can fire here — after the
        // headers arrived and before the stream ended.
        const err = e as Error;
        const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
        throw new HostToolError(
          timedOut ? "TimeoutError" : "OSError",
          timedOut ? `reading '${url}' timed out` : `reading '${url}' failed: ${err.message}`,
        );
      }
    },
  };

  // Append order: http_get first, then unshift the ones we want in front.
  // The sandbox sees tools in registry order; list_files and read_file are
  // used far more often, so they go first.
  const tools = [httpGetTool];
  if (options.listFiles ?? true) tools.unshift(listFilesTool);
  if (options.readFile ?? true) tools.unshift(readFileTool);
  return tools;
}
