import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HostToolError, type HostTool } from "../src/types.js";
import {
  createBuiltinTools,
  __resetEverPrivateForTests,
  EVER_PRIVATE_MAX_ENTRIES,
} from "../src/builtins.js";

// ── The two #199 residuals, as todo tests ───────────────────────
//
// #199 landed its interim hardening (ever-private memory + two-lookups-agree,
// `9e126af`) and the L1/L2 follow-ups (`a5abac8`). Two residuals survive both,
// recorded in `docs/http-egress.md` and `tasks/ship-report-199-l1l2.md`. Per
// the session rule (never file an issue for a residual), each is a `todo` test
// that asserts the missing property: it runs on every suite run, reports TODO
// today, and turns green the day the property arrives — at which point the
// `todo` flag comes off and the test is the regression pin.
//
// Both reuse the resolver-mock pattern of `test/builtins.test.ts`: `http_get`
// resolves before it fetches, so every test injects `lookupImpl` and never
// touches the network.

/** Find a tool by name in a HostTool[] array. */
function findTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

async function assertRefused(result: unknown, pattern: RegExp): Promise<void> {
  try {
    await result;
    assert.fail("expected the request to be refused");
  } catch (e) {
    assert.ok(e instanceof HostToolError, `expected HostToolError, got ${e}`);
    assert.equal((e as HostToolError).pythonType, "PermissionError");
    assert.match((e as Error).message, pattern);
  }
}

describe("http_get — #199 residuals", () => {
  afterEach(() => {
    __resetEverPrivateForTests();
  });

  it("connects to the validated address, not the hostname (connect-time rebinding window)", {
    todo:
      "`fetchGuarded` hands `fetch` `url.href` — the name — so the connection resolves a third " +
      "time, outside both validation lookups (src/builtins.ts, `fetchImpl(url.href, …)`; the " +
      "window is documented on `defaultLookup`). Intended approach: a custom undici dispatcher " +
      "whose `lookup` answers from the validated address set, passed as `init.dispatcher`, once " +
      "undici is a dependency for another reason (docs/http-egress.md revisit trigger).",
  }, async () => {
    // A rebinding resolver that answers public to BOTH validation lookups and
    // private only to the connection is invisible to the address check. The
    // property that closes the window is that the connection never resolves
    // the name itself: `fetch` is handed either a validated literal address
    // or a dispatcher that answers the name from the validated set.
    const validated = ["93.184.216.34"];
    const handed: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      handed.push({ url: String(input), init });
      return new Response("body", { status: 200 });
    };
    const httpGet = findTool(
      createBuiltinTools({ root: "/tmp", fetchImpl, lookupImpl: async () => validated }),
      "http_get",
    );

    assert.equal(await httpGet.execute({ url: "http://rebind.example.com/" }), "body");
    assert.equal(handed.length, 1);

    const target = new URL(handed[0].url);
    const dispatcher = (handed[0].init as { dispatcher?: unknown } | undefined)?.dispatcher;
    assert.ok(
      validated.includes(target.hostname) || dispatcher !== undefined,
      `fetch was handed '${target.hostname}' with no address-pinning dispatcher — the ` +
        "connection resolves the name again, outside validation",
    );
  });

  it("remembers a hostname first refused at saturation (R1: refuse AND record)", {
    todo:
      "`rememberEverPrivate` returns false at `EVER_PRIVATE_MAX_ENTRIES` without recording, so a " +
      "hostname first seen at saturation is refused only after a fresh lookup on every call — " +
      "the cross-attempt memory degrades exactly when an attacker has filled it (R1 in " +
      "tasks/ship-report-199-l1l2.md). Intended approach: refuse AND record (a saturated set " +
      "still admits the entry that triggered the refusal), or a bounded LRU keyed by " +
      "`everPrivateKey`.",
  }, async () => {
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches++;
      return new Response("body", { status: 200 });
    };
    let overflowLookups = 0;
    const httpGet = findTool(
      createBuiltinTools({
        root: "/tmp",
        fetchImpl,
        lookupImpl: async (h: string) => {
          if (h === "overflow.example.com") overflowLookups++;
          return ["127.0.0.1"];
        },
      }),
      "http_get",
    );

    // Fill the memory to the cap through the real recording path.
    for (let i = 0; i < EVER_PRIVATE_MAX_ENTRIES; i++) {
      await assertRefused(
        httpGet.execute({ url: `http://host${i}.example.com/` }),
        /private or reserved/,
      );
    }

    // The first post-saturation hostname is refused — fail-closed, as L1 requires.
    await assertRefused(
      httpGet.execute({ url: "http://overflow.example.com/" }),
      /ever-private memory saturated/,
    );
    assert.equal(overflowLookups, 1);

    // The property: it is now remembered. The second call is refused from
    // memory, before the resolver is consulted again.
    await assertRefused(
      httpGet.execute({ url: "http://overflow.example.com/" }),
      /previously resolved|ever-private memory saturated/,
    );
    assert.equal(
      overflowLookups,
      1,
      "a hostname refused at saturation must be refused from memory next time, not re-resolved",
    );
    assert.equal(fetches, 0);
  });
});
