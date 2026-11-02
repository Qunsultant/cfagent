# 0025. Web search behind a named-provider seam, fail-loud until enabled

- Status: accepted
- Date: 2026-11-01
- Deciders: CAIO-quns (lane build under tracker #2708 item A2; provider enablement stays owner-gated)
- Issue: #2731 (programme #2494; tracker #2708 item A2)
- Implementing PR: (to be filled on merge)

## Context

The mesh registry's web-search family (named by the #2225
reference-set update) was recorded `absent` by S14 (#2417): no
`web_search` tool existed in `src/` or in the MCP catalog, and
tracker #2708 item A2 carried the build as lane-side work never
filed. An agent turn needing a fact from the open web had no
search tool.

The provider question was probed live on 2026-11-01 before the
build (evidence recorded on #2731): no general web-search index
is reachable from a Cloudflare Worker without an API key.

- The DuckDuckGo Instant Answer API — the only keyless named
  candidate — returned its canned test stub / empty payloads for
  ordinary queries ("cloudflare workers", "NVDA stock news").
  A definitional query ("barack obama") returned a heading and
  related topics but no abstract and no web results. It is an
  instant-answer service, not a web-results index.
- Brave Search API, Bing Web Search, Google Programmable
  Search, and Tavily are all named, documented, and
  Worker-reachable — and all require an API key. This deployment
  has none (no secret, no wrangler var).
- Cloudflare AI Search is already wired in this codebase, but it
  searches a configured corpus (the platform's financial-docs
  instance), not the open web.

The lane doctrine from #1888 applies: providers are NAMED; no
anonymous FOSS substitution. The ai-search-service family's
recorded `semantic_cache` substitution (a local corpus answering
in a search tool's name, however well labelled in-band) is a
posture this decision does not repeat for web search.

## Decision

Build `web_search` as a catalog command over a named-provider
seam, and ship it in the honest unconfigured state:

1. `src/services/webSearch.ts` defines the `WebSearchProvider`
   seam (interface + registry), deterministic resolution from
   env (`WEB_SEARCH_PROVIDER`, per-provider key), and a typed
   error taxonomy: `web_search_provider_not_configured`,
   `web_search_provider_unknown`, `web_search_provider_error`.
2. The first provider behind the seam is the Brave Search API
   (`api.search.brave.com`, `X-Subscription-Token` key header),
   chosen as a documented, JSON-native, Worker-reachable named
   provider. Its key is the `BRAVE_SEARCH_API_KEY` secret.
3. `src/mcps/openaimp/webSearchCommands.ts` registers
   `web_search` in the catalog unconditionally (scope
   `mcp:read`), like every catalog tool. Enablement is env
   config at the seam, never a code path.
4. Until a key exists, every call fails loud with
   `web_search_provider_not_configured` — never fabricated
   results, never a silent empty success, never a corpus
   substitute. A configured provider's honestly-empty result set
   remains a real `count: 0`; provider HTTP/network/shape
   failures are `web_search_provider_error`.
5. The registry family moves `absent` → `degraded` (the
   sandbox-tools precedent: surface live, backend absent), and
   its notes record the enablement step. Enablement itself —
   `wrangler secret put BRAVE_SEARCH_API_KEY` — is an owner
   configuration action, not part of the build.

## Consequences

- The catalog grows 83 → 84 tools; every surface the catalog
  serves (chat-turn discovery, /mcp tools/list, the OASF server
  record) names `web_search`, and production callers get a
  truthful not-configured business error instead of invented
  links.
- Adding a second provider later is one adapter + one registry
  entry behind the seam; switching the default is env config.
- The adapter's response shaping is fixture-verified in tests;
  it has never run against the live Brave API (no key exists).
  First live call after enablement is the confirming surface,
  and any shape drift surfaces as the named provider error, not
  as wrong results.

## Alternatives considered

- **DuckDuckGo Instant Answer API as the provider.** Rejected
  on the probe evidence above: not a web-results index; most
  ordinary queries return nothing, which would make the tool's
  common case an empty answer wearing a search tool's name.
- **Scraping a search results page (DDG HTML/Bing/Google).**
  Rejected: anonymous substitution under the #1888 doctrine
  and against the providers' terms for automated access.
- **Cloudflare AI Search as the backend.** Rejected: it
  searches a configured corpus, not the web; labelling its
  results "web search" would misstate what the tool returns.
- **Defer the build until a key exists.** Rejected: the seam,
  the command, the error contract, and the registry truth are
  buildable and pinnable now (tracker #2708's working rule —
  build, don't just assess); only the secret is owner-gated.
