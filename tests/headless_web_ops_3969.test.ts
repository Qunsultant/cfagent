/**
 * Issue #3969 (Route A, follow-on of #3934) — headless web tools on
 * the A2A operations surface.
 *
 * PR #3942 composed `web_fetch` / `web_search` onto PortThink's
 * execution-tool surface (getExecutionTools), whose only production
 * caller is the chat-turn hook (beforeTurn). BrowserAgent and
 * SandboxAgent host no turn and no caller composes a toolset for
 * them, so the manifest's "composed on this class's execution
 * surface" claim had no production realization (evidence on #3934,
 * comment 6763896225). These classes ARE invoked through their A2A
 * dispatch — a fixed operation set executed by calling the class's
 * own methods directly. This suite pins the realization on THAT
 * surface: the operations browser.web_fetch / browser.web_search /
 * sandbox.web_fetch / sandbox.web_search, dispatched through each
 * class's handleA2A (the dispatch entry the A2A edge calls), with
 * the class's real bound executor, the same services
 * (src/services/webFetch.ts, src/services/webSearch.ts) and the
 * same capability gate (isPortCapabilityEnabled) as the turn path.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BrowserAgent } from "../src/agents/browserAgent";
import { SandboxAgent } from "../src/agents/sandbox-agent";
import { BROWSER_A2A_OPERATIONS } from "../src/agents/browserA2aDispatch";
import { SANDBOX_A2A_OPERATIONS } from "../src/agents/sandboxA2aDispatch";
import { getAgentCard } from "../src/a2a/agent-cards";
import type { Env } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = () =>
  ({ id: { toString: () => "web-ops-3969" }, storage: {}, waitUntil: vi.fn() }) as any;

const browser = (env: Record<string, unknown> = {}) =>
  new BrowserAgent(ctx(), env as unknown as Env);

const sandbox = (env: Record<string, unknown> = {}) =>
  new SandboxAgent(ctx(), env as unknown as Env);

/** Global-fetch stub that records every URL it is asked for. */
function stubFetchRecording(responder: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? input);
    calls.push(url);
    return responder(url);
  });
  return calls;
}

const pageResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

// The DuckDuckGo HTML endpoint's real shape (the #3935 fixture):
// wrapped hrefs, entity-encoded titles, snippet anchors.
const DDG_FIXTURE = `<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2Fa&amp;rut=abc">Alpha &amp; <b>Omega</b></a>
  </h2>
  <a class="result__snippet" href="https://alpha.example/a">First <b>snippet</b> here.</a>
</div>
</body></html>`;

const CLASSES = [
  { name: "BrowserAgent", prefix: "browser", make: browser },
  { name: "SandboxAgent", prefix: "sandbox", make: sandbox },
] as const;

describe("headless web tools on the A2A operations surface (#3969)", () => {
  for (const { name, prefix, make } of CLASSES) {
    it(`${name}: ${prefix}.web_fetch returns the fetched page through handleA2A`, async () => {
      const calls = stubFetchRecording(() => pageResponse("stubbed page text"));
      const outcome = await make().handleA2A(
        { operation: `${prefix}.web_fetch`, url: "https://example.com/x" },
        "test",
      );
      expect(outcome.data.ok).toBe(true);
      expect(outcome.data.operation).toBe(`${prefix}.web_fetch`);
      const result = outcome.data.result as { status: number; text: string };
      expect(result.status).toBe(200);
      expect(result.text).toContain("stubbed page text");
      expect(outcome.text).toContain(`${prefix}.web_fetch completed`);
      expect(calls).toEqual(["https://example.com/x"]);
    });

    it(`${name}: ${prefix}.web_search serves through the provider chain and names the provider`, async () => {
      stubFetchRecording(
        () =>
          new Response(DDG_FIXTURE, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      );
      const outcome = await make().handleA2A(
        { operation: `${prefix}.web_search`, query: "alpha", count: 5 },
        "test",
      );
      expect(outcome.data.ok).toBe(true);
      const result = outcome.data.result as {
        provider: string;
        count: number;
        results: Array<{ title: string; url: string }>;
      };
      expect(result.provider).toBe("duckduckgo");
      expect(result.count).toBe(1);
      expect(result.results[0].url).toBe("https://alpha.example/a");
      // The outcome text names the provider that served (the brief's
      // human-readable summary requirement).
      expect(outcome.text).toContain(`${prefix}.web_search completed`);
      expect(outcome.text).toContain("duckduckgo");
    });

    it(`${name}: ${prefix}.web_search with an empty provider chain surfaces web_search_provider_not_configured`, async () => {
      const calls = stubFetchRecording(() => pageResponse("never fetched"));
      const outcome = await make({ WEB_SEARCH_PROVIDERS: "" }).handleA2A(
        { operation: `${prefix}.web_search`, query: "alpha" },
        "test",
      );
      expect(outcome.data.ok).toBe(false);
      expect(JSON.stringify(outcome.data)).toContain("web_search_provider_not_configured");
      expect(calls).toEqual([]);
    });

    it(`${name}: capability disabled by config refuses ${prefix}.web_fetch BY NAME, before any service call`, async () => {
      const calls = stubFetchRecording(() => pageResponse("never fetched"));
      const outcome = await make({ AGENT_CAPABILITIES_DISABLED: "*:webFetch" }).handleA2A(
        { operation: `${prefix}.web_fetch`, url: "https://example.com/x" },
        "test",
      );
      expect(outcome.data.ok).toBe(false);
      expect(outcome.data.code).toBe("capability_disabled");
      expect(outcome.data.error).toContain("webFetch");
      expect(outcome.data.error).toContain(name);
      expect(calls).toEqual([]);
    });

    it(`${name}: capability disabled by config refuses ${prefix}.web_search BY NAME, before any service call`, async () => {
      const calls = stubFetchRecording(() => pageResponse("never fetched"));
      const outcome = await make({ AGENT_CAPABILITIES_DISABLED: "*:webSearch" }).handleA2A(
        { operation: `${prefix}.web_search`, query: "alpha" },
        "test",
      );
      expect(outcome.data.ok).toBe(false);
      expect(outcome.data.code).toBe("capability_disabled");
      expect(outcome.data.error).toContain("webSearch");
      expect(calls).toEqual([]);
    });

    it(`${name}: the web gates are independent — disabling webFetch leaves web_search serving`, async () => {
      stubFetchRecording(
        () =>
          new Response(DDG_FIXTURE, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      );
      const outcome = await make({ AGENT_CAPABILITIES_DISABLED: "*:webFetch" }).handleA2A(
        { operation: `${prefix}.web_search`, query: "alpha" },
        "test",
      );
      expect(outcome.data.ok).toBe(true);
    });

    it(`${name}: web operations validate their arguments in the dispatch idiom`, async () => {
      stubFetchRecording(() => pageResponse("never fetched"));
      const noUrl = await make().handleA2A({ operation: `${prefix}.web_fetch` }, "test");
      expect(noUrl.data.code).toBe("invalid_input");
      const noQuery = await make().handleA2A({ operation: `${prefix}.web_search` }, "test");
      expect(noQuery.data.code).toBe("invalid_input");
      const badCount = await make().handleA2A(
        { operation: `${prefix}.web_search`, query: "alpha", count: -1 },
        "test",
      );
      expect(badCount.data.code).toBe("invalid_input");
    });
  }

  it("the dispatch operation sets and the cards both carry the web operations", () => {
    expect(BROWSER_A2A_OPERATIONS).toContain("browser.web_fetch");
    expect(BROWSER_A2A_OPERATIONS).toContain("browser.web_search");
    expect(SANDBOX_A2A_OPERATIONS).toContain("sandbox.web_fetch");
    expect(SANDBOX_A2A_OPERATIONS).toContain("sandbox.web_search");
    expect([...getAgentCard("browser")!.operations].sort()).toEqual(
      [...BROWSER_A2A_OPERATIONS].sort(),
    );
    expect([...getAgentCard("sandbox")!.operations].sort()).toEqual(
      [...SANDBOX_A2A_OPERATIONS].sort(),
    );
  });

  it("web_fetch also routes through the JSON-RPC envelope form", async () => {
    stubFetchRecording(() => pageResponse("envelope body"));
    const outcome = await browser().handleA2A(
      {
        params: {
          message: {
            parts: [
              {
                kind: "data",
                data: { operation: "browser.web_fetch", url: "https://example.com/env" },
              },
            ],
          },
        },
      },
      "test",
    );
    expect(outcome.data.ok).toBe(true);
    expect((outcome.data.result as { text: string }).text).toContain("envelope body");
  });
});
