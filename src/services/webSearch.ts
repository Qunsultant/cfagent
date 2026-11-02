/**
 * Web search provider seam — issue #2731 (tracker #2708 item A2).
 *
 * The mesh registry's web-search family was recorded `absent` by
 * S14 (#2417): no web_search tool existed. This module is the
 * deterministic service behind the `web_search` MCP command
 * (src/mcps/openaimp/webSearchCommands.ts). It follows the lane's
 * named-provider doctrine (#1888): every backend is a NAMED
 * provider behind this seam — no anonymous substitution, no
 * search-result-page scraping, and no local corpus is ever
 * substituted for web results.
 *
 * Provider reality, probed live on 2026-11-01 (recorded on #2731):
 * no general web-search index is reachable from a Cloudflare
 * Worker without an API key. The DuckDuckGo Instant Answer API —
 * the only keyless named candidate — returned its canned test
 * stub / empty payloads for ordinary queries; it is an
 * instant-answer service, not a web-results index, and is NOT a
 * provider here. The first provider behind the seam is the Brave
 * Search API, whose key (the BRAVE_SEARCH_API_KEY secret) this
 * deployment does not have. Until the owner sets it, resolution
 * fails loud with `web_search_provider_not_configured` — the
 * command never fabricates results and never returns a silent
 * empty success. A configured provider's honestly-empty result
 * set is a real `count: 0` answer, distinct from unavailability.
 */

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  /** The named provider that produced these results. */
  provider: string;
  query: string;
  count: number;
  results: WebSearchResultItem[];
}

export type WebSearchErrorCode =
  | "web_search_provider_not_configured"
  | "web_search_provider_unknown"
  | "web_search_provider_error";

/**
 * The named failure surface of this seam. `code` is stable and
 * machine-checkable; the message is the business error a caller
 * may show (provider + what is missing / what failed), with no
 * internals beyond that.
 */
export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly provider?: string;

  constructor(code: WebSearchErrorCode, message: string, provider?: string) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.provider = provider;
  }
}

/** The env slice this seam reads (structurally satisfied by Env). */
export interface WebSearchEnv {
  WEB_SEARCH_PROVIDER?: string;
  BRAVE_SEARCH_API_KEY?: string;
}

export interface WebSearchProvider {
  /** Stable provider id (the WEB_SEARCH_PROVIDER value). */
  readonly id: string;
  readonly displayName: string;
  isConfigured(env: WebSearchEnv): boolean;
  /** Names the missing configuration, for the not-configured error. */
  missingConfig(env: WebSearchEnv): string;
  search(
    env: WebSearchEnv,
    query: string,
    count: number,
    fetchFn: typeof fetch,
  ): Promise<WebSearchResultItem[]>;
}

// ---------------------------------------------------------------------------
// Bounds (recorded policy, not per-call model judgment)
// ---------------------------------------------------------------------------

export const WEB_SEARCH_DEFAULT_COUNT = 5;
export const WEB_SEARCH_MAX_COUNT = 10;
export const WEB_SEARCH_TIMEOUT_MS = 8_000;

export function clampWebSearchCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return WEB_SEARCH_DEFAULT_COUNT;
  return Math.min(WEB_SEARCH_MAX_COUNT, Math.max(1, Math.floor(count)));
}

// ---------------------------------------------------------------------------
// Brave Search API — the first named provider
// ---------------------------------------------------------------------------

export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export class BraveWebSearchProvider implements WebSearchProvider {
  readonly id = "brave";
  readonly displayName = "Brave Search API";

  isConfigured(env: WebSearchEnv): boolean {
    return typeof env.BRAVE_SEARCH_API_KEY === "string" && env.BRAVE_SEARCH_API_KEY.trim().length > 0;
  }

  missingConfig(): string {
    return "the BRAVE_SEARCH_API_KEY secret is not set";
  }

  async search(
    env: WebSearchEnv,
    query: string,
    count: number,
    fetchFn: typeof fetch,
  ): Promise<WebSearchResultItem[]> {
    const apiKey = (env.BRAVE_SEARCH_API_KEY ?? "").trim();
    if (!apiKey) throw notConfiguredError(this, env);

    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new WebSearchError(
        "web_search_provider_error",
        `web_search provider "brave" request failed: ${err instanceof Error ? err.message : String(err)}`,
        this.id,
      );
    }
    if (!response.ok) {
      throw new WebSearchError(
        "web_search_provider_error",
        `web_search provider "brave" returned HTTP ${response.status}`,
        this.id,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WebSearchError(
        "web_search_provider_error",
        `web_search provider "brave" returned a non-JSON response`,
        this.id,
      );
    }
    const raw = (payload as { web?: { results?: unknown } } | null)?.web?.results;
    if (!Array.isArray(raw)) {
      throw new WebSearchError(
        "web_search_provider_error",
        `web_search provider "brave" returned an unexpected response shape (web.results missing)`,
        this.id,
      );
    }

    // Shape defensively: an entry without a title or a URL is
    // dropped, never repaired with invented values.
    const results: WebSearchResultItem[] = [];
    for (const item of raw) {
      const entry = item as { title?: unknown; url?: unknown; description?: unknown } | null;
      const title = typeof entry?.title === "string" ? entry.title.trim() : "";
      const resultUrl = typeof entry?.url === "string" ? entry.url.trim() : "";
      if (!title || !resultUrl) continue;
      results.push({
        title,
        url: resultUrl,
        snippet: typeof entry?.description === "string" ? entry.description : "",
      });
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Resolution + execution
// ---------------------------------------------------------------------------

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = [new BraveWebSearchProvider()];

function notConfiguredError(provider: WebSearchProvider, env: WebSearchEnv): WebSearchError {
  return new WebSearchError(
    "web_search_provider_not_configured",
    `web_search is not configured: provider "${provider.id}" (${provider.displayName}) is selected but ${provider.missingConfig(env)}. ` +
      `Enable it by setting the BRAVE_SEARCH_API_KEY secret (wrangler secret put BRAVE_SEARCH_API_KEY); no code change is needed. ` +
      `Until then web_search fails with this error rather than returning fabricated results.`,
    provider.id,
  );
}

/**
 * Deterministic provider selection:
 *   - WEB_SEARCH_PROVIDER set → that provider, or a loud failure
 *     (unknown id, or the named provider's config missing).
 *   - Unset → the first configured provider in registry order;
 *     none configured → the not-configured error for the default.
 */
export function resolveWebSearchProvider(env: WebSearchEnv): WebSearchProvider {
  const requested = (env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (requested) {
    const provider = WEB_SEARCH_PROVIDERS.find((p) => p.id === requested);
    if (!provider) {
      throw new WebSearchError(
        "web_search_provider_unknown",
        `web_search provider "${requested}" is not a known provider (known: ${WEB_SEARCH_PROVIDERS.map((p) => p.id).join(", ")}). ` +
          `Set WEB_SEARCH_PROVIDER to a known provider or unset it.`,
        requested,
      );
    }
    if (!provider.isConfigured(env)) throw notConfiguredError(provider, env);
    return provider;
  }
  for (const provider of WEB_SEARCH_PROVIDERS) {
    if (provider.isConfigured(env)) return provider;
  }
  throw notConfiguredError(WEB_SEARCH_PROVIDERS[0], env);
}

export async function executeWebSearch(
  env: WebSearchEnv,
  query: string,
  count?: number,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<WebSearchOutcome> {
  const provider = resolveWebSearchProvider(env);
  const bounded = clampWebSearchCount(count);
  const results = await provider.search(env, query, bounded, fetchFn);
  const sliced = results.slice(0, bounded);
  return { provider: provider.id, query, count: sliced.length, results: sliced };
}
