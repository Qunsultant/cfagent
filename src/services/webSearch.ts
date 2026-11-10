/**
 * Web search provider seam — issue #2731 (tracker #2708 item A2),
 * extended to a provider chain by #3935.
 *
 * The mesh registry's web-search family was recorded `absent` by
 * S14 (#2417): no web_search tool existed. This module is the
 * deterministic service behind the `web_search` MCP command
 * (src/mcps/openaimp/webSearchCommands.ts). It follows the lane's
 * named-provider doctrine (#1888): every backend is a NAMED
 * provider behind this seam — no anonymous substitution and no
 * local corpus is ever substituted for web results.
 *
 * #3935 (owner decision 2026-11-10) ended the single-keyed-provider
 * posture. The seam carries a CHAIN of named providers, tried in
 * the order the deployment configures, with the free/keyless ones
 * first by default:
 *
 *   searxng      — JSON API at <SEARXNG_BASE_URL>/search; opted in
 *                  by configuring the base URL, skipped when unset.
 *   duckduckgo   — the keyless HTML results endpoint; no key, no
 *                  configuration, so web_search works out of the
 *                  box. A block, a rate limit, or an unparseable
 *                  page is a PROVIDER FAILURE, never fabricated
 *                  results and never a silent empty success.
 *   brave        — the Brave Search API, used when the
 *                  BRAVE_SEARCH_API_KEY secret is set.
 *
 * WEB_SEARCH_PROVIDERS (comma list) sets the order and the subset;
 * the legacy single WEB_SEARCH_PROVIDER is still honoured when the
 * list is absent. A provider failure (network, HTTP, block,
 * unparseable) falls through to the next provider, and the outcome
 * names the provider that served. An empty chain fails with
 * `web_search_provider_not_configured`; a chain whose every
 * provider failed fails with `web_search_all_providers_failed`,
 * carrying each attempt's reason. An honestly-empty result set from
 * a provider that answered is still a real `count: 0` answer.
 *
 * Note the deliberate difference from #2731: the DuckDuckGo INSTANT
 * ANSWER API remains rejected (it is an answer service, not a
 * results index — that finding stands). #3935 names the HTML
 * RESULTS endpoint instead, which is why the keyless provider is a
 * different surface, not a reversal of the probe.
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
  | "web_search_provider_error"
  | "web_search_all_providers_failed";

/**
 * One failed attempt inside the chain, as carried by the
 * all-providers-failed error: which provider, its named code, and
 * the reason it gave. Machine-checkable, never a paraphrase.
 */
export interface WebSearchAttempt {
  provider: string;
  code: WebSearchErrorCode;
  reason: string;
}

/**
 * The named failure surface of this seam. `code` is stable and
 * machine-checkable; the message is the business error a caller
 * may show (provider + what is missing / what failed), with no
 * internals beyond that.
 */
export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly provider?: string;
  /** Present on `web_search_all_providers_failed`: every attempt's reason. */
  readonly attempts?: readonly WebSearchAttempt[];

  constructor(
    code: WebSearchErrorCode,
    message: string,
    provider?: string,
    attempts?: readonly WebSearchAttempt[],
  ) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.provider = provider;
    if (attempts) this.attempts = attempts;
  }
}

/** The env slice this seam reads (structurally satisfied by Env). */
export interface WebSearchEnv {
  /** Ordered, comma-separated provider ids; default searxng,duckduckgo,brave. */
  WEB_SEARCH_PROVIDERS?: string;
  /** Legacy single-provider selection, honoured when the list is absent. */
  WEB_SEARCH_PROVIDER?: string;
  /** SearXNG instance base URL; unset = the provider is skipped. */
  SEARXNG_BASE_URL?: string;
  /** Brave Search API key; unset = the provider is skipped. */
  BRAVE_SEARCH_API_KEY?: string;
}

export interface WebSearchProvider {
  /** Stable provider id (the WEB_SEARCH_PROVIDERS value). */
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

/** One honest identity for every provider request (#3935). */
export const WEB_SEARCH_USER_AGENT =
  "cfagent-web-search/1.0 (+https://github.com/Qunsultant/cfagent)";

export function clampWebSearchCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return WEB_SEARCH_DEFAULT_COUNT;
  return Math.min(WEB_SEARCH_MAX_COUNT, Math.max(1, Math.floor(count)));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerFailure(provider: WebSearchProvider, detail: string): WebSearchError {
  return new WebSearchError(
    "web_search_provider_error",
    `web_search provider "${provider.id}" ${detail}`,
    provider.id,
  );
}

/** Decode the entities a results page puts in its own text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** Visible text of an HTML fragment: tags stripped, entities decoded. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// SearXNG — JSON API, opted in by SEARXNG_BASE_URL
// ---------------------------------------------------------------------------

export const SEARXNG_SEARCH_PATH = "/search";

export class SearxngWebSearchProvider implements WebSearchProvider {
  readonly id = "searxng";
  readonly displayName = "SearXNG";

  isConfigured(env: WebSearchEnv): boolean {
    return nonEmpty(env.SEARXNG_BASE_URL).length > 0;
  }

  missingConfig(): string {
    return "the SEARXNG_BASE_URL env var is not set";
  }

  async search(
    env: WebSearchEnv,
    query: string,
    count: number,
    fetchFn: typeof fetch,
  ): Promise<WebSearchResultItem[]> {
    const base = nonEmpty(env.SEARXNG_BASE_URL);
    if (!base) throw notConfiguredError([this], env);

    let endpoint: URL;
    try {
      endpoint = new URL(`${base.replace(/\/+$/, "")}${SEARXNG_SEARCH_PATH}`);
    } catch {
      throw providerFailure(this, `SEARXNG_BASE_URL is not a valid URL: ${base}`);
    }
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");

    let response: Response;
    try {
      response = await fetchFn(endpoint.toString(), {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": WEB_SEARCH_USER_AGENT },
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerFailure(
        this,
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) throw providerFailure(this, `returned HTTP ${response.status}`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw providerFailure(this, "returned a non-JSON response");
    }
    const raw = (payload as { results?: unknown } | null)?.results;
    if (!Array.isArray(raw)) {
      throw providerFailure(this, "returned an unexpected response shape (results missing)");
    }

    // Shape defensively: an entry without a title or a URL is
    // dropped, never repaired with invented values.
    const results: WebSearchResultItem[] = [];
    for (const item of raw.slice(0, count)) {
      const entry = item as { title?: unknown; url?: unknown; content?: unknown; snippet?: unknown } | null;
      const title = typeof entry?.title === "string" ? entry.title.trim() : "";
      const url = typeof entry?.url === "string" ? entry.url.trim() : "";
      if (!title || !url) continue;
      const snippet =
        typeof entry?.content === "string"
          ? entry.content
          : typeof entry?.snippet === "string"
            ? entry.snippet
            : "";
      results.push({ title, url, snippet });
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// DuckDuckGo — the keyless HTML results endpoint
// ---------------------------------------------------------------------------

export const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * Page markers that mean the endpoint served an interstitial
 * instead of results (bot check / rate limit). Their presence is a
 * provider failure — the honest answer is "this provider did not
 * answer", never "no results exist".
 */
const DUCKDUCKGO_BLOCK_MARKERS = [
  "anomaly-modal",
  "unusual traffic",
  "are you a robot",
  "captcha",
  "if this persists, please",
];

/** The endpoint's own "nothing matched" signal — an honest count: 0. */
const DUCKDUCKGO_NO_RESULTS_MARKERS = ["No results.", "no-results"];

const ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const CLASS_ATTR = /class\s*=\s*"([^"]*)"/i;
const HREF_ATTR = /href\s*=\s*"([^"]*)"/i;

/**
 * Unwrap a result href. The HTML endpoint links through its own
 * redirector (`//duckduckgo.com/l/?uddg=<encoded target>`); the
 * consumer must see the target URL, not the redirect.
 */
export function unwrapDuckDuckGoUrl(href: string): string {
  const raw = href.trim();
  if (!raw) return "";
  const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(absolute, DUCKDUCKGO_HTML_ENDPOINT);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const host = parsed.hostname.toLowerCase();
  if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
    if (!parsed.pathname.startsWith("/l/")) return "";
    const target = parsed.searchParams.get("uddg");
    if (!target) return "";
    try {
      return decodeURIComponent(target);
    } catch {
      return "";
    }
  }
  return parsed.toString();
}

/**
 * Parse the HTML results page. Titles come from the result anchors
 * (`class="result__a"`), snippets from the snippet anchors
 * (`class="result__snippet"`), paired in document order. An entry
 * without a resolvable URL or a title is dropped.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResultItem[] {
  const titles: Array<{ title: string; url: string }> = [];
  const snippets: string[] = [];
  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const attrs = match[1];
    const className = CLASS_ATTR.exec(attrs)?.[1] ?? "";
    if (className.includes("result__a")) {
      const url = unwrapDuckDuckGoUrl(HREF_ATTR.exec(attrs)?.[1] ?? "");
      const title = textOf(match[2]);
      if (url && title) titles.push({ title, url });
    } else if (className.includes("result__snippet")) {
      snippets.push(textOf(match[2]));
    }
  }
  return titles.map((entry, index) => ({
    title: entry.title,
    url: entry.url,
    snippet: snippets[index] ?? "",
  }));
}

export class DuckDuckGoWebSearchProvider implements WebSearchProvider {
  readonly id = "duckduckgo";
  readonly displayName = "DuckDuckGo (HTML results)";

  /** Keyless by construction: this provider is always configured. */
  isConfigured(): boolean {
    return true;
  }

  missingConfig(): string {
    return "nothing — this provider needs no key and no configuration";
  }

  async search(
    _env: WebSearchEnv,
    query: string,
    count: number,
    fetchFn: typeof fetch,
  ): Promise<WebSearchResultItem[]> {
    const endpoint = new URL(DUCKDUCKGO_HTML_ENDPOINT);
    endpoint.searchParams.set("q", query);

    let response: Response;
    try {
      response = await fetchFn(endpoint.toString(), {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": WEB_SEARCH_USER_AGENT,
        },
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerFailure(
        this,
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) throw providerFailure(this, `returned HTTP ${response.status}`);

    const body = await response.text();
    const blocked = DUCKDUCKGO_BLOCK_MARKERS.find((marker) =>
      body.toLowerCase().includes(marker.toLowerCase()),
    );
    if (blocked) {
      throw providerFailure(
        this,
        `served a bot-check page instead of results (marked "${blocked}") — blocked or rate-limited`,
      );
    }

    const results = parseDuckDuckGoHtml(body);
    if (results.length === 0) {
      const noResults = DUCKDUCKGO_NO_RESULTS_MARKERS.some((marker) =>
        body.toLowerCase().includes(marker.toLowerCase()),
      );
      // No results marker → the query honestly matched nothing.
      // Anything else → the page did not parse, which is a failure.
      if (!noResults) {
        throw providerFailure(
          this,
          "returned a page with no parseable results and no no-results marker",
        );
      }
    }
    return results.slice(0, count);
  }
}

// ---------------------------------------------------------------------------
// Brave Search API — used when the key is set
// ---------------------------------------------------------------------------

export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export class BraveWebSearchProvider implements WebSearchProvider {
  readonly id = "brave";
  readonly displayName = "Brave Search API";

  isConfigured(env: WebSearchEnv): boolean {
    return nonEmpty(env.BRAVE_SEARCH_API_KEY).length > 0;
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
    const apiKey = nonEmpty(env.BRAVE_SEARCH_API_KEY);
    if (!apiKey) throw notConfiguredError([this], env);

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

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = [
  new SearxngWebSearchProvider(),
  new DuckDuckGoWebSearchProvider(),
  new BraveWebSearchProvider(),
];

/** Free/keyless first: the order when nothing is configured. */
export const DEFAULT_WEB_SEARCH_CHAIN: readonly string[] = ["searxng", "duckduckgo", "brave"];

function splitProviderList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function notConfiguredError(
  chain: readonly WebSearchProvider[],
  env: WebSearchEnv,
): WebSearchError {
  const known = WEB_SEARCH_PROVIDERS.map((provider) => provider.id).join(", ");
  if (chain.length === 0) {
    return new WebSearchError(
      "web_search_provider_not_configured",
      `web_search is not configured: WEB_SEARCH_PROVIDERS is empty, so the provider chain has no entries. ` +
        `Set it to an ordered subset of ${known} (default: ${DEFAULT_WEB_SEARCH_CHAIN.join(",")}), or configure ` +
        `SEARXNG_BASE_URL / BRAVE_SEARCH_API_KEY. Until then web_search fails with this error rather than returning fabricated results.`,
    );
  }
  const missing = chain
    .map((provider) => `"${provider.id}" (${provider.missingConfig(env)})`)
    .join(", ");
  return new WebSearchError(
    "web_search_provider_not_configured",
    `web_search is not configured: the configured chain has no usable provider — ${missing}. ` +
      `Free/keyless providers need no key: leave WEB_SEARCH_PROVIDERS unset (default ${DEFAULT_WEB_SEARCH_CHAIN.join(",")}) ` +
      `so the keyless DuckDuckGo provider serves, or set SEARXNG_BASE_URL / BRAVE_SEARCH_API_KEY. ` +
      `Until then web_search fails with this error rather than returning fabricated results.`,
    chain[0]?.id,
  );
}

/**
 * Deterministic chain resolution:
 *   - WEB_SEARCH_PROVIDERS set → that ordered subset (an unknown id
 *     is a loud `web_search_provider_unknown`).
 *   - Else WEB_SEARCH_PROVIDER set (legacy) → that single provider.
 *   - Else the default chain, free/keyless first.
 * Providers that are not configured are SKIPPED (SearXNG without a
 * base URL, Brave without a key); no configured provider left is the
 * named not-configured error.
 */
export function resolveWebSearchChain(env: WebSearchEnv): WebSearchProvider[] {
  const rawList = env.WEB_SEARCH_PROVIDERS;
  const legacy = nonEmpty(env.WEB_SEARCH_PROVIDER).toLowerCase();
  const ids =
    typeof rawList === "string"
      ? splitProviderList(rawList)
      : legacy
        ? [legacy]
        : [...DEFAULT_WEB_SEARCH_CHAIN];

  const chain: WebSearchProvider[] = [];
  for (const id of ids) {
    const provider = WEB_SEARCH_PROVIDERS.find((candidate) => candidate.id === id);
    if (!provider) {
      throw new WebSearchError(
        "web_search_provider_unknown",
        `web_search provider "${id}" is not a known provider (known: ${WEB_SEARCH_PROVIDERS.map((p) => p.id).join(", ")}). ` +
          `Set WEB_SEARCH_PROVIDERS to known providers or unset it.`,
        id,
      );
    }
    chain.push(provider);
  }

  const configured = chain.filter((provider) => provider.isConfigured(env));
  if (configured.length === 0) throw notConfiguredError(chain, env);
  return configured;
}

/** The first provider the chain would use (the chain's head). */
export function resolveWebSearchProvider(env: WebSearchEnv): WebSearchProvider {
  return resolveWebSearchChain(env)[0];
}

/**
 * Try the chain in order. A provider failure (network, HTTP, block,
 * unparseable) falls through to the next; the first honest answer
 * wins, and the outcome names the provider that served it. Every
 * attempt's reason rides the aggregate error when all of them fail.
 */
export async function executeWebSearch(
  env: WebSearchEnv,
  query: string,
  count?: number,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<WebSearchOutcome> {
  const chain = resolveWebSearchChain(env);
  const bounded = clampWebSearchCount(count);
  const attempts: WebSearchAttempt[] = [];

  for (const provider of chain) {
    try {
      const results = await provider.search(env, query, bounded, fetchFn);
      const sliced = results.slice(0, bounded);
      return { provider: provider.id, query, count: sliced.length, results: sliced };
    } catch (err) {
      const error = err instanceof WebSearchError ? err : undefined;
      attempts.push({
        provider: provider.id,
        code: error?.code ?? "web_search_provider_error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new WebSearchError(
    "web_search_all_providers_failed",
    `web_search failed: all ${attempts.length} configured provider(s) failed — ` +
      attempts.map((attempt) => `"${attempt.provider}": ${attempt.reason}`).join("; "),
    attempts[0]?.provider,
    attempts,
  );
}
