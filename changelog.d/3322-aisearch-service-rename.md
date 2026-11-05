### Changed

- The Cloudflare AI Search REST service class is renamed `ETradeAISearchService` → `AiSearchInstanceService` (issue 3322): the platform is multi-broker and broker-neutral, and the service — a generic instance client whose only configuration read is `AI_SEARCH_ENDPOINT`, with no broker credentials, endpoints, or semantics — no longer carries a broker's brand in the agent cards, registry, routes, or docs. Pure rename, zero behaviour change; the old name survives one step as a deprecated compatibility alias in the same module (identity-pinned), to be removed in a later slice.
