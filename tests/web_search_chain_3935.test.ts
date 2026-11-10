/**
 * Issue #3935 — web_search is a provider CHAIN, free/keyless first.
 *
 * #2731 wired exactly one named provider (Brave) and failed loud
 * until its key was set; the key was never set, so web_search
 * resolved `unavailable` everywhere. #3935 keeps the seam and adds
 * SearXNG (JSON, opted in by SEARXNG_BASE_URL) and the keyless
 * DuckDuckGo results endpoint, ordered by WEB_SEARCH_PROVIDERS with
 * the free ones first.
 *
 * The honesty contract still holds, now per attempt: a provider
 * failure falls through, the outcome names the provider that
 * served, an empty result set from a provider that answered is a
 * real count 0, and an exhausted chain is one named error carrying
 * every attempt's reason. No fixture here reaches the network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  WebSearchError,
  DuckDuckGoWebSearchProvider,
  executeWebSearch,
  parseDuckDuckGoHtml,
  resolveWebSearchChain,
  resolveWebSearchProvider,
  unwrapDuckDuckGoUrl,
} from "../src/services/webSearch";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FetchCall {
  url: string;
  init: any;
}

/** A fetch that answers per host, and records every call. */
function routeFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: any, init: any) => {
    const href = String(url);
    calls.push({ url: href, init });
    const host = new URL(href).hostname;
    const route = routes[host];
    if (!route) throw new Error(`unexpected request to ${href}`);
    return route();
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const SEARXNG_FIXTURE = {
  results: [
    { title: "Alpha", url: "https://alpha.example/a", content: "searxng first" },
    { title: "Beta", url: "https://beta.example/b", content: "searxng second" },
  ],
};

// The HTML endpoint's real shape: wrapped hrefs, entity-encoded
// titles, snippets as their own anchors.
const DDG_FIXTURE = `<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2Fa&amp;rut=abc">Alpha &amp; <b>Omega</b></a>
  </h2>
  <a class="result__snippet" href="https://alpha.example/a">First <b>snippet</b> here.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://beta.example/b">Beta</a></h2>
  <a class="result__snippet">Second snippet.</a>
</div>
</body></html>`;

const BRAVE_FIXTURE = {
  web: {
    results: [{ title: "Bravo", url: "https://bravo.example/c", description: "brave result" }],
  },
};

const DDG = "html.duckduckgo.com";
const SEARXNG = "searx.example";
const BRAVE = "api.search.brave.com";

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

describe("provider chain resolution (#3935)", () => {
  it("defaults to the free/keyless chain and serves with NO configuration at all", () => {
    const chain = resolveWebSearchChain({});
    expect(chain.map((p) => p.id)).toEqual(["duckduckgo"]);
    expect(resolveWebSearchProvider({}).id).toBe("duckduckgo");
  });

  it("puts a configured SearXNG ahead of the keyless provider", () => {
    const chain = resolveWebSearchChain({ SEARXNG_BASE_URL: `https://${SEARXNG}` });
    expect(chain.map((p) => p.id)).toEqual(["searxng", "duckduckgo"]);
  });

  it("honours the configured order and subset", () => {
    const chain = resolveWebSearchChain({
      WEB_SEARCH_PROVIDERS: " brave , duckduckgo ",
      BRAVE_SEARCH_API_KEY: "k",
    });
    expect(chain.map((p) => p.id)).toEqual(["brave", "duckduckgo"]);
  });

  it("keeps the legacy single-provider variable working", () => {
    expect(resolveWebSearchChain({ WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "k" }))
      .toEqual([expect.objectContaining({ id: "brave" })]);
  });

  it("an unknown id in the chain fails loud, naming it", () => {
    const err = (() => {
      try {
        resolveWebSearchChain({ WEB_SEARCH_PROVIDERS: "searxng,altavista" });
      } catch (e) {
        return e as WebSearchError;
      }
    })();
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err!.code).toBe("web_search_provider_unknown");
    expect(err!.message).toContain("altavista");
  });

  it("an empty chain is the named not-configured error, and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called with an empty chain");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const err = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "" }, "q", 5).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_provider_not_configured");
    expect(err.message).toContain("WEB_SEARCH_PROVIDERS is empty");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a named-but-unconfigured provider is still not-configured, naming the missing config", async () => {
    const err = await executeWebSearch({ WEB_SEARCH_PROVIDER: "brave" }, "q", 5).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_provider_not_configured");
    expect(err.message).toContain("BRAVE_SEARCH_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// Each provider parses its own surface
// ---------------------------------------------------------------------------

describe("SearXNG provider (#3935)", () => {
  it("calls <base>/search with q + format=json and shapes the JSON results", async () => {
    const { fn, calls } = routeFetch({ [SEARXNG]: () => json(SEARXNG_FIXTURE) });
    const outcome = await executeWebSearch(
      { SEARXNG_BASE_URL: `https://${SEARXNG}/`, WEB_SEARCH_PROVIDERS: "searxng" },
      "cloudflare workers",
      5,
      fn,
    );
    expect(outcome.provider).toBe("searxng");
    expect(outcome.results).toEqual([
      { title: "Alpha", url: "https://alpha.example/a", snippet: "searxng first" },
      { title: "Beta", url: "https://beta.example/b", snippet: "searxng second" },
    ]);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(`https://${SEARXNG}/search`);
    expect(url.searchParams.get("q")).toBe("cloudflare workers");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("clamps count before the provider answers, and drops entries missing title or url", async () => {
    const many = {
      results: [
        ...Array.from({ length: 12 }, (_, i) => ({
          title: `T${i}`,
          url: `https://e.example/${i}`,
          content: `s${i}`,
        })),
        { title: "", url: "https://no-title.example/", content: "dropped" },
        { title: "No URL", content: "dropped" },
      ],
    };
    const { fn } = routeFetch({ [SEARXNG]: () => json(many) });
    const outcome = await executeWebSearch(
      { SEARXNG_BASE_URL: `https://${SEARXNG}`, WEB_SEARCH_PROVIDERS: "searxng" },
      "q",
      50,
      fn,
    );
    expect(outcome.count).toBe(10);
  });

  it("a contract-breaking payload is a provider failure, not empty results", async () => {
    const { fn } = routeFetch({ [SEARXNG]: () => json({ unexpected: true }) });
    const err = await executeWebSearch(
      { SEARXNG_BASE_URL: `https://${SEARXNG}`, WEB_SEARCH_PROVIDERS: "searxng" },
      "q",
      5,
      fn,
    ).catch((e) => e);
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts[0]).toMatchObject({ provider: "searxng", code: "web_search_provider_error" });
  });
});

describe("DuckDuckGo provider (#3935)", () => {
  it("serves keyless results, unwrapping redirects and decoding entities", async () => {
    const { fn, calls } = routeFetch({ [DDG]: () => html(DDG_FIXTURE) });
    const outcome = await executeWebSearch({}, "anything", 5, fn);
    expect(outcome.provider).toBe("duckduckgo");
    expect(outcome.results).toEqual([
      { title: "Alpha & Omega", url: "https://alpha.example/a", snippet: "First snippet here." },
      { title: "Beta", url: "https://beta.example/b", snippet: "Second snippet." },
    ]);
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("anything");
  });

  it("unwraps a redirect href and refuses anything that is not a web URL", () => {
    expect(
      unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx&rut=1"),
    ).toBe("https://example.com/x");
    expect(unwrapDuckDuckGoUrl("https://example.com/direct")).toBe("https://example.com/direct");
    expect(unwrapDuckDuckGoUrl("javascript:alert(1)")).toBe("");
    expect(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?rut=1")).toBe("");
  });

  it("an honest no-results page is count: 0", async () => {
    const { fn } = routeFetch({ [DDG]: () => html("<html><body><p>No results.</p></body></html>") });
    const outcome = await executeWebSearch({}, "obscure", 5, fn);
    expect(outcome.provider).toBe("duckduckgo");
    expect(outcome.count).toBe(0);
    expect(outcome.results).toEqual([]);
  });

  it("a bot-check page is a provider failure, never an empty success", async () => {
    const { fn } = routeFetch({
      [DDG]: () => html('<html><body><div class="anomaly-modal">unusual traffic</div></body></html>'),
    });
    vi.stubGlobal("fetch", fn);
    const err = await executeWebSearch({}, "q", 5).catch((e) => e);
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts[0].reason).toContain("blocked or rate-limited");
  });

  it("a rate-limited status is a provider failure", async () => {
    const { fn } = routeFetch({ [DDG]: () => html("Too many requests", 429) });
    const err = await executeWebSearch({}, "q", 5, fn).catch((e) => e);
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts[0].reason).toContain("429");
  });

  it("a page that matches neither results nor a no-results marker is a failure", async () => {
    const { fn } = routeFetch({ [DDG]: () => html("<html><body><p>hello</p></body></html>") });
    const err = await executeWebSearch({}, "q", 5, fn).catch((e) => e);
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts[0].reason).toContain("no parseable results");
  });

  it("the parser ignores anchors outside the result classes", () => {
    expect(parseDuckDuckGoHtml('<a href="https://x.example/">nav</a>')).toEqual([]);
  });

  it("is always configured — it needs no key and no env", () => {
    expect(new DuckDuckGoWebSearchProvider().isConfigured({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The chain in flight: fall-through, serving provider, aggregate failure
// ---------------------------------------------------------------------------

describe("provider chain execution (#3935)", () => {
  it("falls through a failing provider to the next one, and names the one that served", async () => {
    const { fn } = routeFetch({
      [SEARXNG]: () => html("search is down", 503),
      [DDG]: () => html(DDG_FIXTURE),
    });
    const outcome = await executeWebSearch(
      { SEARXNG_BASE_URL: `https://${SEARXNG}` },
      "q",
      5,
      fn,
    );
    expect(outcome.provider).toBe("duckduckgo");
    expect(outcome.count).toBe(2);
  });

  it("uses Brave when it is the configured head", async () => {
    const { fn, calls } = routeFetch({ [BRAVE]: () => json(BRAVE_FIXTURE) });
    const outcome = await executeWebSearch(
      { WEB_SEARCH_PROVIDERS: "brave,duckduckgo", BRAVE_SEARCH_API_KEY: "test-key" },
      "q",
      5,
      fn,
    );
    expect(outcome.provider).toBe("brave");
    expect(outcome.results).toEqual([
      { title: "Bravo", url: "https://bravo.example/c", snippet: "brave result" },
    ]);
    expect(calls[0].init.headers["X-Subscription-Token"]).toBe("test-key");
  });

  it("an exhausted chain is ONE named error carrying every attempt's reason", async () => {
    const { fn } = routeFetch({
      [SEARXNG]: () => html("boom", 500),
      [BRAVE]: () => json({ error: "rate limited" }, 429),
    });
    const err = await executeWebSearch(
      {
        WEB_SEARCH_PROVIDERS: "searxng,brave",
        SEARXNG_BASE_URL: `https://${SEARXNG}`,
        BRAVE_SEARCH_API_KEY: "k",
      },
      "q",
      5,
      fn,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts).toHaveLength(2);
    expect(err.attempts[0]).toMatchObject({ provider: "searxng" });
    expect(err.attempts[0].reason).toContain("500");
    expect(err.attempts[1]).toMatchObject({ provider: "brave" });
    expect(err.attempts[1].reason).toContain("429");
    expect(err.message).toContain("all 2 configured provider(s) failed");
    expect(err.message).toContain("searxng");
    expect(err.message).toContain("brave");
  });

  it("a network throw falls through rather than escaping the chain", async () => {
    const calls: string[] = [];
    const fn = vi.fn(async (url: any) => {
      const host = new URL(String(url)).hostname;
      calls.push(host);
      if (host === SEARXNG) throw new Error("socket boom");
      return html(DDG_FIXTURE);
    }) as unknown as typeof fetch;
    const outcome = await executeWebSearch({ SEARXNG_BASE_URL: `https://${SEARXNG}` }, "q", 5, fn);
    expect(outcome.provider).toBe("duckduckgo");
    expect(calls).toEqual([SEARXNG, DDG]);
  });

  it("keeps the result contract: provider, query, count, and shaped results", async () => {
    const { fn } = routeFetch({ [DDG]: () => html(DDG_FIXTURE) });
    const outcome = await executeWebSearch({}, "contract check", 1, fn);
    expect(outcome).toEqual({
      provider: "duckduckgo",
      query: "contract check",
      count: 1,
      results: [{ title: "Alpha & Omega", url: "https://alpha.example/a", snippet: "First snippet here." }],
    });
  });
});
