# Data provider / storage survey — 2026-10-23 (main @ a199f62d)

Read-only survey for the provider-plugin-platform epic. Full detail in the survey report (chat, 2026-10-23).

## Headlines
- E*TRADE: 57 direct `new ETradeService(` construction sites; no factory in the data path; `TradingPlatformRegistry` exists but the facade bypasses it.
- FOSS: a real plugin-shaped contract exists — `IFossMarketDataProvider` (`src/patterns/interfaces.ts:127`, ids yfinance|alpaca|hybrid) — but composition is hardcoded in `FossResearchService` (fossResearch.ts:2715-2717).
- Yahoo has THREE implementations: screening adapter (`src/trading/yahooDataSource.ts`), `yahooHistory.ts` direct fetch, `YahooFinanceProvider` in fossResearch.ts.
- Options: NO provider concept — `UnifiedOptionsService` constructs E*TRADE per execution (unifiedOptionsService.ts:436-437); discovery same (discoveryService.ts:337-338).
- Three provider vocabularies: `StockScreenProvider = "etrade"|"yahoo"`; FOSS ids; ScreeningProvider ids ("etrade-yahoo-stocks"|"dynamic-options"). ScreeningProvider registry (#1103) wraps SCREENERS, not data providers.
- Storage: runs persist normalized results only (mas_reports body ≤200k chars; mas_opportunity_scans; mas_discovery_runs). RAW provider payloads are stored NOWHERE. `mas_options_chain_cache` exists in DDL but is inert — no writer. IV history stores derived rows only; the chains are discarded.
- R2: `reportBlobStore` dual-path abstraction exists but wrangler.jsonc has NO r2_buckets binding — blobs live in DO storage today. Bucket-name owner decision (#605) still open.
- Credentials: E*TRADE per-user OAuth tokens in SessionStore (`etrade:token:<ENV>:<login>`, midnight-ET expiry) + env cascade (`resolveEnvironmentConfig`); Alpaca = deploy-time env vars only; Yahoo = none. No unified provider config; rate limits are pacing knobs scattered across 4 config files.
- Offerings: premium = x402 pay-per-call only (`TRADING_PAID_SERVICES` price cards in agenticPayments.ts). NO freemium/entitlement model exists (zero code hits).
- Admin: read-only status only (`GET /foss/providers` → hardcoded 3-entry statuses; `ETradeService.getStatus()`). NO provisioning surface exists — provisioning = set env + redeploy, or per-user OAuth.

## Reuse / Consolidate / Build-new
- REUSE: IFossMarketDataProvider + impls; ScreeningProviderRegistry idiom; injected-fetcher seams in screenerPipeline; SessionStore tokens; env-JSON config idiom; getProviderStatuses shape; run stores + runSummaries; reportBlobStore seam; TRADING_PAID_SERVICES + x402 gate.
- CONSOLIDATE: 57 construction sites → one factory/registry resolution; 3 vocabularies → 1; 3 Yahoo impls → 1; hardcoded FOSS composition → registry; provider config scattered in 4+ files → one provider-config store; provider selection (route-implied vs schema) → one mechanism for manual + scheduled + options + discovery.
- BUILD NEW: provisioning/deprovisioning lifecycle; provider-config store; raw-payload capture (activate mas_options_chain_cache or a general capture store); entitlement/freemium tier model; provider health monitoring; shared conformance kit.
