/**
 * Issue #359-17 (FINAL slice of the #359 orchestrator breakup): the
 * thin-router inventory.
 *
 * After slices #359-01..16 extracted every domain block and this slice
 * extracted the last two inline blocks (schema introspection into
 * routes/schema.ts, Cloudflare Agentic Payments into
 * routes/agenticPayments.ts), OrchestratorAgent.routeRequest is a THIN
 * ordered dispatcher: a prelude (url/path, ensureTables, sessionKey, the
 * requestedEnv binding), a sequence of delegation calls to
 * src/agents/routes/*.ts - each guarded by `if (response) return
 * response;` - and the Not-found fallthrough. NO path-matched handler
 * block remains inline.
 *
 * This test pins that end state:
 *  (a) the delegation sequence (24 calls, exact order) and its guards;
 *  (b) the absence of any inline path-matching condition in
 *      routeRequest;
 *  (c) the non-handler logic that legitimately stays inline (the
 *      dispatcher prelude and the 404 terminus, after the last
 *      delegation);
 *  (d) the FULL ordered route inventory: every path-matching condition
 *      in the whole router, reconstructed by walking routeRequest and
 *      expanding each delegation into its module's conditions in order -
 *      150 conditions, byte-for-byte the pre-breakup sequence (proven
 *      against the pre-slice tree by the same scripted scan during the
 *      slice; the two blocks this slice moved appear at positions
 *      14-15 (schema) and 44-47 (agentic payments), now attributed to
 *      their handlers).
 *
 * Post-#359 growth, recorded deliberately: issue #126 (PR-E) added
 * two route conditions — GET /etrade/options/discovery-runs (in
 * handleEtradeOptionsRoutes, after scans/diff) and POST
 * /schedules/trigger-discovery (in handleSchedulesRoutes, last) —
 * bringing the inventory to 152. New routes update this pin; the
 * pin's purpose (no UNINTENTIONAL route-surface change) is unchanged.
 * Issue #341 added one more — GET /api/reports/research/browse (in
 * handleReportsRoutes, after the trading/reports webhook handler and
 * before the reports list) — bringing the inventory to 156.
 * Issue #340 added GET /research/track-record (in
 * handleScreenerResearchRoutes, after /research/history) — 157.
 * Issue #273 added seven — POST /schedules/:id/pause, /resume and
 * /trigger plus PUT /schedules/:id (in handleSchedulesRoutes, after
 * the get-by-id block and before create) — bringing the inventory
 * to 164.
 * Issue #649 added one more — POST /reports/semantic-search (in
 * handleReportsRoutes, after the /api/reports list) — bringing the
 * inventory to 165; the pin update landed with #714 after the route
 * was found unpinned during #686 post-merge verification.
 * #714 also pinned five more routes that had landed unpinned:
 * /trading/setup-catalog and /learnings ×2 (handleEtradeBroker-
 * ActivityRoutes, after /etrade/lookup; #650, #706) and
 * /options/strategy-reviews + /options/strategy-reviews/decide
 * (handleEtradeOptionsRoutes, after /trading/options/config; #653)
 * — bringing the inventory to 170. Issue #705 added one more —
 * POST /reflection/run (handleEtradeBrokerActivityRoutes, last) —
 * 171, pinned by #714 as well. Issue #1057 (consolidation S5) added
 * one more — GET /runs (in handleReportsRoutes, after
 * /reports/research/browse and before the reports list) — bringing
 * the inventory to 172.
 * Issue #1162 (epic #1096 Phase 6) added three more — GET
 * /screening/activity and GET|POST /screening/controls (in
 * handleScreenerResearchRoutes, after /research/evaluate, last in
 * that handler) — bringing the pinned array to 192 entries.
 * Issue #1201 (consolidation C1) added two more — POST
 * /screening/goal-screen and POST /screening/backtest (in
 * handleScreenerResearchRoutes, after /screening/controls, last in
 * that handler) — bringing the pinned array to 197 entries.
 * Issue #1246 (consolidation C2) added six more — GET
 * /adaptation/candidates/approvals and GET
 * /adaptation/candidates/verdicts (in handleScreenerResearchRoutes,
 * after /adaptation/candidates/evaluations), and GET
 * /screening/goals, POST /screening/goals/decide, GET
 * /screening/reselection-proposals and GET /screening/outcomes (in
 * handleScreenerResearchRoutes, after /screening/controls, before
 * /screening/goal-screen) — bringing the pinned array to 203 entries.
 * Issue #1278 (#1173 R5) added one more — POST
 * /screener/report/regenerate (in handleScreenerResearchRoutes, after
 * /screener/report.pdf, before /screener/report.xlsx) — bringing the
 * pinned array to 204 entries.
 * Issue #1361 (consolidation C5) added two more — GET
 * /trading/options/comparison/outcomes and POST
 * /trading/options/comparison (in handleEtradeOptionsRoutes, after
 * /trading/options/compare, before /trading/options/recommend) —
 * bringing the pinned array to 206 entries.
 * Issue #1257 (challenger re-point) removes one — POST
 * /adaptation/candidates/approve/decide, retired with the #759
 * two-step — and adds three: GET /adaptation/promotions/active
 * (drain gate), POST /adaptation/promotions/promote, and POST
 * /adaptation/promotions/rollback — bringing the pinned array to
 * 208 entries.
 * Issue #1257 (retirement) removes three — POST
 * /adaptation/promotions/start, POST /adaptation/promotions/advance,
 * and GET /adaptation/promotions/active, deleted with
 * stagedPromotion once the active list drained to empty.
 * Issue #1326 added one more — GET /trading/reports/confirmations
 * (in handleReportsRoutes, after the pending list).
 * Issue #1169 (S1) added one more — POST /knowledge/corpus (in
 * handleKnowledgeCorpusRoutes, after the data-provider handler) —
 * bringing the pinned array to 216 entries and the delegation
 * sequence to 24 calls.
 * Issue #1169 (S2) added one more — GET /knowledge/file (in
 * handleKnowledgeCorpusRoutes, before POST /knowledge/corpus in
 * source order, flag-gated: returns null when
 * KNOWLEDGE_SERVING_ENABLED is off) — bringing the pinned array
 * to 217 entries; the delegation sequence is unchanged (same
 * handler, same position).
 * Issue #1169 (S4-4) added two more — GET /knowledge/integrity
 * (in handleKnowledgeCorpusRoutes, after GET /knowledge/file in
 * source order, audit read, NOT flag-gated) and POST
 * /knowledge/corpus-sync (in handleKnowledgeCorpusRoutes, after
 * POST /knowledge/corpus) — bringing the pinned array to 268
 * entries; the delegation sequence is unchanged (same handler,
 * same position).
 * Issue #1888 added six — GET /enrichment/status, GET
 * /enrichment/runs, POST /enrichment/run, POST
 * /enrichment/killswitch, GET /enrichment/calibration (in
 * handleEnrichmentRoutes, after the data-provider handler), plus
 * the canonical GET /market-data/bars alias (in
 * handleMarketDataQuoteResearchRoutes, before the retained legacy bars
 * path) — bringing the delegation sequence to 26 calls.
 *
 * Issue #1906 renamed the research routes to canonical /market-data/*
 * paths (handlers handleMarketDataQuoteResearchRoutes,
 * handleAlpacaMarketDataRoutes, handleMarketDataCompareScreenRoutes in
 * marketDataResearch.ts / alpaca.ts) with the deprecated /foss/*
 * aliases on the same branches — bringing the pinned array to 236
 * entries (225 + 11 alias entries); the delegation sequence is
 * unchanged at 26 calls.
 *
 * Issue #2059 added four — POST /api/assurance/payment-workflow/start,
 * POST /api/assurance/payment-workflow/event, GET
 * /api/assurance/payment-workflow/status, POST
 * /api/assurance/payment-workflow/check-payment (in
 * handlePaymentAssuranceLiveRoutes, between the payments and
 * agentic-payments handlers) — bringing the pinned array to 240
 * entries and the delegation sequence to 27 calls.
 *
 * Issue #2019 added two — POST /payments/agentic/ledger/record-cfpay
 * and GET /payments/agentic/ledger/cfpay (in
 * handleAgenticPaymentsRoutes, after the #896 record endpoint) —
 * bringing the pinned array to 242 entries; the delegation sequence
 * is unchanged (same handler, same position).
 *
 * Issue #2022 added one — GET /payments/agentic/ledger/cfpay-revenue
 * (in handleAgenticPaymentsRoutes, after the cfpay list endpoint) —
 * bringing the pinned array to 243 entries; the delegation sequence
 * is unchanged (same handler, same position).
 *
 * Issue #2022 added one — GET /ads/banner-config (in
 * handleReferralsAdsRoutes, before the /ads block) — bringing the
 * pinned array to 247 entries on the post-#2089 main; the
 * delegation sequence is unchanged (same handler, same position).
 *
 * Issues #2015/#2020/#2022 added seven — the commercial account,
 * credits, tenant-settings, submit, and submission-status
 * endpoints (in handleAgenticPaymentsRoutes, after the cfpay
 * revenue endpoint) — bringing the pinned array to 254 entries;
 * the delegation sequence is unchanged (same handler, same
 * position). The D1 rework dropped the three hop-only endpoints
 * (consume, redeem-credit, unredeemed-credit): with D1 shared
 * across instances, the adapter and submit route call the port
 * directly, so no hop-only endpoint needs to exist.
 *
 * Issue #2137 added three — the checkout UI support routes
 * (pricing, submission check-payment, goal-command, in
 * handleAgenticPaymentsRoutes, after the submission-status
 * endpoint) — bringing the pinned array to 257 entries; the
 * delegation sequence is unchanged (same handler, same position).
 *
 * Issues #2020/#2127 added seven — the subscription plans list,
 * create, and deactivate endpoints plus the subscription
 * checkout, purchase, cancel, and status endpoints (in
 * handleAgenticPaymentsRoutes, after the submission-status
 * endpoint) — bringing the pinned array to 263 entries; the
 * delegation sequence is unchanged (same handler, same
 * position).
 *
 * Issue #1169 (S4-2) added one — POST /search/mas (in
 * handleSearchHubRoutes, after /search/knowledge) — bringing the
 * pinned array to 264 entries; the delegation sequence is
 * unchanged (same handler, same position).
 * Rebuild of #2137 onto current main (superseding #2163)
 * re-applies the same three checkout UI routes (pricing,
 * submission check-payment, goal-command, in
 * handleAgenticPaymentsRoutes, after the subscription
 * endpoints) — bringing the pinned array to 267 entries; the
 * delegation sequence is unchanged. The rebuild also restores
 * the two search-hub entries and the search nav entry the old
 * branch had dropped at navOrder 23.
 *
 * Issue #1169 (S4-1) added one more — POST /trading/reports/index-backfill (in
 * handleReportsRoutes, after the trading/reports webhook handler and before
 * /reports/research/browse) — bringing the pinned array to 263 entries; the
 * delegation sequence is unchanged (same handler, same position).
 *
 * Issue #2185 added one — POST /payments/agentic/commercial/prices (in
 * handleAgenticPaymentsRoutes, after the pricing route) — bringing the
 * pinned array to 275 entries; the delegation sequence is unchanged
 * (same handler, same position).
 *
 * Issue #2208 adds seven — the referral balance and
 * record-earn endpoints plus the lifecycle preferences
 * (GET + POST), welcome, digest send, and unsubscribe
 * endpoints (in handleAgenticPaymentsRoutes, after the
 * auto-approve-limit block) — bringing the pinned array to
 * 282 entries; the delegation sequence is unchanged (same
 * handler, same position).
 *
 * Issue #2192 added one more — POST /payments/agentic/ledger/record-native (in
 * handleAgenticPaymentsRoutes, after the record-cfpay endpoint) — bringing the
 * pinned array to 283 entries; the delegation sequence is unchanged (same
 * handler, same position). The webhook native branch reuses the existing
 * /payments/webhook condition, so it adds no inventory entry. (Rebuild of
 * #2234 onto current main 3d90dfb2: main's baseline was already 282 via the
 * lifecycle slice, so the rebuild's count is 283, not the old PR's 276.)
 *
 * Issue #2204 added six — POST /payments/agentic/commercial/refunds,
 * POST /payments/agentic/commercial/refunds/approve, POST
 * /payments/agentic/commercial/refunds/execute, GET
 * /payments/agentic/commercial/refunds, GET
 * /payments/agentic/commercial/refund-policy, and POST
 * /payments/agentic/commercial/refund-policy (in
 * handleAgenticPaymentsRoutes, after the prices route) — bringing the
 * pinned array to 289 entries; the delegation sequence is unchanged
 * (same handler, same position). (Main-based rebuild superseding
 * #2298: main's EXPECTED_INVENTORY was measured at 283 entries on
 * current main, so the rebuild's count is 289, not the old PR's 291.)
 * Issue #2219 added one — GET /payments/agentic/commercial/identity (in
 * handleAgenticPaymentsRoutes, after the commercial account GET) —
 * bringing the pinned array to 294 entries; the delegation sequence
 * is unchanged (same handler, same position).
 *
 * Issue #2457 added five — GET /admin/tenants and POST
 * /admin/tenants/:tenantId/queues/resolve, /dump, /cancel-all,
 * /clear-table (in handleAdminTenantQueueRoutes, after serviceUser,
 * before schedules) — bringing the pinned array to 299 entries and
 * the delegation sequence to 32 calls.
 *
 * Issue #2481 added one — GET/POST /tenant/settings/auto-refresh
 * (in handleReportsRoutes, after the report-dispatch-hitl handler
 * and before /trading/reports/confirm) — bringing the pinned
 * array to 301 entries; the delegation sequence is unchanged
 * (same handler, same position).
 *
 * LANDMARK RULE (#405): all position assertions anchor to DELEGATION
 * CALLS - the only landmarks a thin router has.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const HANDLER_FILE: Record<string, string> = {
  "handleReportsRoutes": "reports.ts",
  "handleScreenerPresetRoutes": "screenerPresets.ts",
  "handleMcpChatNlqRoutes": "mcpChatNlq.ts",
  "handleSchemaRoutes": "schema.ts",
  "handleAdsRevenueReferralsRoutes": "adsRevenueReferrals.ts",
  "handleReferralsAdsRoutes": "adsRevenueReferrals.ts",
  "handleAuditRoutes": "audit.ts",
  "handleDataProviderRoutes": "dataProviders.ts",
  "handleEnrichmentRoutes": "enrichment.ts",
  "handleWorkflowRunsRoutes": "workflowRuns.ts",
  "handleKnowledgeCorpusRoutes": "knowledgeCorpus.ts",
  "handleSearchHubRoutes": "searchHub.ts",
  "handleAutopilotRoutes": "autopilot.ts",
  "handleMemoryResetRoutes": "memoryReset.ts",
  "handlePaymentsRoutes": "payments.ts",
  "handlePaymentAssuranceLiveRoutes": "paymentAssuranceLive.ts",
  "handleAgenticPaymentsRoutes": "agenticPayments.ts",
  "handlePremiumRoutes": "premium.ts",
  "handleEtradeBrokerRoutes": "etradeBroker.ts",
  "handleEtradeBrokerActivityRoutes": "etradeBroker.ts",
  "handleTradingIntegrationsRoutes": "tradingIntegrations.ts",
  "handleEtradeOptionsRoutes": "etradeOptions.ts",
  "handleWatchlistsRoutes": "watchlists.ts",
  "handleAlpacaTradingRoutes": "alpaca.ts",
  "handleAlpacaMarketDataRoutes": "alpaca.ts",
  "handleMarketDataQuoteResearchRoutes": "marketDataResearch.ts",
  "handleMarketDataCompareScreenRoutes": "marketDataResearch.ts",
  "handleScreenerResearchRoutes": "screenerResearch.ts",
  "handleMaintenanceRoutes": "maintenance.ts",
  "handleServiceUserRoutes": "serviceUser.ts",
  "handleAdminTenantQueueRoutes": "adminTenantQueues.ts",
  "handleKvWipeRoutes": "kvWipe.ts",
  "handleSchedulesRoutes": "schedules.ts"
};

const EXPECTED_DELEGATIONS = [
  "handleReportsRoutes",
  "handleScreenerPresetRoutes",
  "handleMcpChatNlqRoutes",
  "handleSchemaRoutes",
  "handleAdsRevenueReferralsRoutes",
  "handleAuditRoutes",
  "handleDataProviderRoutes",
  "handleEnrichmentRoutes",
  "handleWorkflowRunsRoutes",
  "handleKnowledgeCorpusRoutes",
  "handleSearchHubRoutes",
  "handleAutopilotRoutes",
  "handleMemoryResetRoutes",
  "handleReferralsAdsRoutes",
  "handlePaymentsRoutes",
  "handlePaymentAssuranceLiveRoutes",
  "handleAgenticPaymentsRoutes",
  "handlePremiumRoutes",
  "handleEtradeBrokerRoutes",
  "handleTradingIntegrationsRoutes",
  "handleEtradeBrokerActivityRoutes",
  "handleEtradeOptionsRoutes",
  "handleWatchlistsRoutes",
  "handleAlpacaTradingRoutes",
  "handleMarketDataQuoteResearchRoutes",
  "handleAlpacaMarketDataRoutes",
  "handleMarketDataCompareScreenRoutes",
  "handleScreenerResearchRoutes",
  "handleMaintenanceRoutes",
  "handleServiceUserRoutes",
  "handleAdminTenantQueueRoutes",
  "handleKvWipeRoutes",
  "handleSchedulesRoutes"
];

const EXPECTED_INVENTORY = [
  "handleReportsRoutes :: endsWith(\"/trading/reports/pending\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/confirmations\")",
  "handleReportsRoutes :: endsWith(\"/trading/settings/report-dispatch-hitl\")",
  "handleReportsRoutes :: endsWith(\"/trading/settings/report-dispatch-hitl\")",
  "handleReportsRoutes :: endsWith(\"/tenant/settings/auto-refresh\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/confirm\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/email\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/webhook\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/index-backfill\")",
  "handleReportsRoutes :: endsWith(\"/reports/research/browse\")",
  // Issue #2534: GET /api/runs/details (in handleReportsRoutes,
  // before /runs so the details path is not swallowed by /runs).
  "handleReportsRoutes :: endsWith(\"/runs/details\")",
  "handleReportsRoutes :: endsWith(\"/runs\")",
  "handleReportsRoutes :: endsWith(\"/reports\")",
  "handleReportsRoutes :: === \"/reports\"",
  "handleReportsRoutes :: === \"/api/reports\"",
  "handleReportsRoutes :: endsWith(\"/reports/semantic-search\")",
  "handleScreenerPresetRoutes :: endsWith(\"/screener/presets\")",
  "handleScreenerPresetRoutes :: endsWith(\"/screener/presets\")",
  "handleScreenerPresetRoutes :: startsWith(\"/screener/presets/\")",
  "handleMcpChatNlqRoutes :: endsWith(\"/mcp\")",
  "handleMcpChatNlqRoutes :: === \"/chat\"",
  "handleMcpChatNlqRoutes :: === \"/api/chat\"",
  "handleMcpChatNlqRoutes :: endsWith(\"/nlq\")",
  "handleSchemaRoutes :: endsWith(\"/schema/tables\")",
  "handleSchemaRoutes :: endsWith(\"/schema/query\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/categories\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/revenue\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/external-ads\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/external-ads/impression\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/external-ads/click\")",
  "handleAuditRoutes :: endsWith(\"/audit\")",
  "handleAuditRoutes :: endsWith(\"/audit\")",
  "handleAuditRoutes :: endsWith(\"/audit/event\")",
  "handleDataProviderRoutes :: === \"/data-providers\"",
  "handleDataProviderRoutes :: === \"/data-providers/\"",
  "handleEnrichmentRoutes :: === \"/enrichment/status\"",
  "handleEnrichmentRoutes :: === \"/enrichment/runs\"",
  "handleEnrichmentRoutes :: === \"/enrichment/run\"",
  "handleEnrichmentRoutes :: === \"/enrichment/killswitch\"",
  "handleEnrichmentRoutes :: === \"/enrichment/calibration\"",
  "handleWorkflowRunsRoutes :: === \"/workflow-runs\"",
  "handleWorkflowRunsRoutes :: === \"/api/workflow-runs\"",
  "handleKnowledgeCorpusRoutes :: endsWith(\"/knowledge/file\")",
  "handleKnowledgeCorpusRoutes :: endsWith(\"/knowledge/integrity\")",
  "handleKnowledgeCorpusRoutes :: endsWith(\"/knowledge/corpus\")",
  "handleKnowledgeCorpusRoutes :: endsWith(\"/knowledge/corpus-sync\")",
  "handleSearchHubRoutes :: endsWith(\"/search/agent\")",
  "handleSearchHubRoutes :: endsWith(\"/search/knowledge\")",
  "handleSearchHubRoutes :: endsWith(\"/search/mas\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/jobs\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/state\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/kill-switch\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/limits\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/evaluate\")",
  "handleMemoryResetRoutes :: endsWith(\"/memory\")",
  "handleMemoryResetRoutes :: endsWith(\"/clear\")",
  "handleMemoryResetRoutes :: endsWith(\"/reset\")",
  "handleReferralsAdsRoutes :: endsWith(\"/referrals\")",
  "handleReferralsAdsRoutes :: endsWith(\"/referrals/click\")",
  "handleReferralsAdsRoutes :: endsWith(\"/ads/banner-config\")",
  "handleReferralsAdsRoutes :: endsWith(\"/ads\")",
  "handleReferralsAdsRoutes :: endsWith(\"/ads/click\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/gateways\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/status\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/dids\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/transactions\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/receipts\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/create\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/confirm\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/capture\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/webhook\")",
  "handlePaymentAssuranceLiveRoutes :: endsWith(\"/api/assurance/payment-workflow/start\")",
  "handlePaymentAssuranceLiveRoutes :: endsWith(\"/api/assurance/payment-workflow/event\")",
  "handlePaymentAssuranceLiveRoutes :: endsWith(\"/api/assurance/payment-workflow/status\")",
  "handlePaymentAssuranceLiveRoutes :: endsWith(\"/api/assurance/payment-workflow/check-payment\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/wallet\")",
  "handleAgenticPaymentsRoutes :: includes(\"/payments/agentic/wallet\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/ledger/record\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/ledger/record-cfpay\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/ledger/record-native\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/ledger/cfpay\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/ledger/cfpay-revenue\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/account\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/identity\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/account\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/account/credits\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/tenant-settings\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/tenant-settings\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/submit\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/submission-status\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/plans\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/plans\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/plans/deactivate\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/subscription/checkout\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/subscription/purchase\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/subscription/cancel\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/subscription\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/pricing\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/prices\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/refunds\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/refunds/approve\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/refunds/execute\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/refunds\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/refund-policy\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/refund-policy\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/submission/check-payment\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/goal-command\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/ledger/budget-state\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/ledger/payments\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/auto-approve-limit\")",
  "handleAgenticPaymentsRoutes :: includes(\"/payments/agentic/auto-approve-limit\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/referral/balance\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/referral/record-earn\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/lifecycle/preferences\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/lifecycle/preferences\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/lifecycle/welcome\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/lifecycle/digest/send\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/commercial/lifecycle/unsubscribe\")",
  "handlePremiumRoutes :: includes(\"/premium/options-scan\")",
  "handlePremiumRoutes :: includes(\"/premium/market-research\")",
  "handlePremiumRoutes :: includes(\"/premium/stock-signals\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/environment/switch\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/broker/etrade/environment\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/environment/switch\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/broker/etrade/environment\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/status\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/diagnostics\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/accounts\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/screen\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/quote\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/order/preview\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/order/execute\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/positions\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk/evaluate\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk/correlation\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk/size\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk/bundle\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/think/evaluate\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/hedge/analyze\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-repair/analyze\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/orders\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/orders/remote\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/orders/cancel\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/email/inbound\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/email/approve-link\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/slack/event\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/slack/interaction\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/slack/command\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/browser/transaction-snap\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/browser/transaction-snap\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/voice/turn\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/voice/greeting\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/etrade/transactions\")",
  "handleEtradeBrokerActivityRoutes :: includes(\"/etrade/transactions/\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/etrade/alerts\")",
  "handleEtradeBrokerActivityRoutes :: includes(\"/etrade/alerts/\")",
  "handleEtradeBrokerActivityRoutes :: includes(\"/etrade/alerts/\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/etrade/lookup\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/trading/setup-catalog\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/learnings\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/learnings\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/reflection/run\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/options/latest\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/chains\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/strategy\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/expire-dates\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/scans\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/scans/diff\")",
  // Issue #2180: the discovery run-report downloads.
  "handleEtradeOptionsRoutes :: endsWith(\"/discovery/report.pdf\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/discovery/report.xlsx\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/discovery/report.csv\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/discovery-runs\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/iv-history\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/profiles\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/profiles\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/llm-ideas\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/compare\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/compare\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/comparison/outcomes\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/comparison\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/recommend\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/catalog\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/strategies\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/best-trade\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/best-trade\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/screen\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/unified\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/config\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/options/strategy-reviews\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/options/strategy-reviews/decide\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlists\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/details\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/create\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/save-screen\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/delete\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/order\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/account\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/positions\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/orders\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/market-data/quote\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/foss/quote\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/market-data/fundamentals\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/foss/fundamentals\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/market-data/bars\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/foss/bars\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/market-data/research\")",
  "handleMarketDataQuoteResearchRoutes :: endsWith(\"/foss/research\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/market-data/snapshot\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/foss/snapshot\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/market-data/alpaca/account\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/foss/alpaca/account\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/market-data/alpaca/positions\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/foss/alpaca/positions\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/market-data/alpaca/orders\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/foss/alpaca/orders\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/market-data/alpaca/order\")",
  "handleAlpacaMarketDataRoutes :: endsWith(\"/foss/alpaca/order\")",
  "handleMarketDataCompareScreenRoutes :: endsWith(\"/market-data/compare\")",
  "handleMarketDataCompareScreenRoutes :: endsWith(\"/foss/compare\")",
  "handleMarketDataCompareScreenRoutes :: endsWith(\"/market-data/providers\")",
  "handleMarketDataCompareScreenRoutes :: endsWith(\"/foss/providers\")",
  "handleMarketDataCompareScreenRoutes :: endsWith(\"/market-data/screen\")",
  "handleMarketDataCompareScreenRoutes :: endsWith(\"/foss/screen\")",
  "handleMarketDataCompareScreenRoutes :: endsWith(\"/yfinance/screen\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screener/latest\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screener/report.pdf\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screener/report/regenerate\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screener/report.xlsx\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screener/report.csv\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/goal-screen/report.pdf\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/goal-screen/report.xlsx\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/goal-screen/report.csv\")",
  "handleScreenerResearchRoutes :: endsWith(\"/options/report.xlsx\")",
  "handleScreenerResearchRoutes :: endsWith(\"/options/report.csv\")",
  "handleScreenerResearchRoutes :: endsWith(\"/options/report.pdf\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/report.pdf\")",
  // Issue #2167: the research workbook and CSV download routes.
  "handleScreenerResearchRoutes :: endsWith(\"/research/report.xlsx\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/report.csv\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/run\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/scheduled-tick\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/latest\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/history\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/track-record\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/track-record/calibration\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/weights\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/weights/run\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates/generate\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates/evaluate\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates/evaluations\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates/approvals\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates/verdicts\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates/approve\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/candidates/gate\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/promotions\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/promotions/promote\")",
  "handleScreenerResearchRoutes :: endsWith(\"/adaptation/promotions/rollback\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/settings\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/settings\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/evaluate\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/activity\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/controls\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/controls\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/goals\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/goals/decide\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/reselection-proposals\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/outcomes\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/goal-screen\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screening/backtest\")",
  "handleMaintenanceRoutes :: endsWith(\"/maintenance/events-export\")",
  "handleMaintenanceRoutes :: endsWith(\"/maintenance/clear-table\")",
  "handleServiceUserRoutes :: endsWith(\"/admin/service-user/provision\")",
  "handleServiceUserRoutes :: endsWith(\"/admin/service-user/revoke\")",
  "handleServiceUserRoutes :: endsWith(\"/admin/service-user/status\")",
  "handleAdminTenantQueueRoutes :: endsWith(\"/admin/tenants\")",
  "handleAdminTenantQueueRoutes :: endsWith(\"/queues/resolve\")",
  "handleAdminTenantQueueRoutes :: endsWith(\"/queues/dump\")",
  "handleAdminTenantQueueRoutes :: endsWith(\"/queues/cancel-all\")",
  "handleAdminTenantQueueRoutes :: endsWith(\"/queues/clear-table\")",
  "handleKvWipeRoutes :: endsWith(\"/maintenance/kv-wipe\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules\")",
  "handleSchedulesRoutes :: endsWith(\"/api/schedules\")",
  "handleSchedulesRoutes :: === \"/schedules\"",
  "handleSchedulesRoutes :: === \"/api/schedules\"",
  "handleSchedulesRoutes :: endsWith(\"/schedules/cancel\")",
  "handleSchedulesRoutes :: includes(\"/schedules/cancel/\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/cancel-all\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/pause\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/resume\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/trigger\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/create\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-screen\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-renew\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-options-analysis\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-retention\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-iv-collection\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-discovery\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/feed-snapshot\")"
];

function routeRequestBody(orchSrc: string): string {
  const start = orchSrc.indexOf("private async routeRequest");
  expect(start, "routeRequest must exist").toBeGreaterThan(-1);
  return orchSrc.slice(start);
}

const COND_RE = /path\.(endsWith|includes|startsWith)\("([^"]+)"\)|path === "([^"]+)"/g;

function conditionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(COND_RE))
    out.push(m[3] !== undefined ? `=== "${m[3]}"` : `${m[1]}("${m[2]}")`);
  return out;
}

function handlerConditions(handler: string): string[] {
  const file = HANDLER_FILE[handler];
  expect(file, `no route module mapped for ${handler}`).toBeTruthy();
  const moduleSrc = src(`agents/routes/${file}`);
  const start = moduleSrc.indexOf(`export async function ${handler}(`);
  expect(start, `${handler} must be exported from routes/${file}`).toBeGreaterThan(-1);
  const rest = moduleSrc.slice(start);
  const nextExport = rest.indexOf("\nexport ", 10);
  const body = nextExport < 0 ? rest : rest.slice(0, nextExport);
  return conditionsIn(body).map((c) => `${handler} :: ${c}`);
}

describe("thin router inventory (#359-17)", () => {
  it("routeRequest delegates to the route modules in the pinned order, each one guarded", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    const delegations = [...body.matchAll(/const (\w+) = await (handle\w+Routes)\(request, url, path, sessionId,/g)];
    expect(delegations.map((m) => m[2])).toEqual(EXPECTED_DELEGATIONS);
    // Every delegation is guarded by `if (<var>) return <var>;` in the
    // same order — a non-null return matched, exactly as the inline
    // blocks returned directly.
    const guards = [...body.matchAll(/if \((\w+)\) return \1;/g)].map((m) => m[1]);
    expect(guards).toEqual(delegations.map((m) => m[1]));
  });

  it("routeRequest contains NO inline path-matching conditions", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    const inline = [...body.matchAll(/path\.(endsWith|includes|startsWith)\("/g)];
    expect(inline, "no path.endsWith/includes/startsWith conditions may remain inline").toHaveLength(0);
    const inlineEq = [...body.matchAll(/path === "/g)];
    expect(inlineEq, "no path === conditions may remain inline").toHaveLength(0);
  });

  it("the only logic left inline is the dispatcher prelude and the 404 terminus", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    // Prelude: request-scoped bindings the delegations consume.
    expect(body).toContain("const url = new URL(request.url);");
    expect(body).toContain("const path = url.pathname;");
    expect(body).toContain("const sql = this.ensureTables();");
    expect(body).toContain("const sessionId = this.sessionKey();");
    // requestedEnv is computed once in the dispatcher and passed through
    // the context to the E*TRADE options and watchlists delegations.
    expect(body).toContain('const requestedEnv: "TEST" | "PROD" | undefined');
    // Terminus: exactly one Not-found fallthrough, after the last delegation.
    const notFound = [...body.matchAll(/return new Response\("Not found", \{ status: 404 \}\);/g)];
    expect(notFound).toHaveLength(1);
    const lastDelegation = body.lastIndexOf("handleSchedulesRoutes(request, url, path, sessionId,");
    expect(lastDelegation).toBeGreaterThan(-1);
    expect(body.indexOf('return new Response("Not found"')).toBeGreaterThan(lastDelegation);
  });

  it("the full ordered route inventory across all modules matches the pinned pre-breakup sequence", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    const inventory: string[] = [];
    const tokenRe =
      /handle\w+Routes\(request, url, path, sessionId,|path\.(endsWith|includes|startsWith)\("([^"]+)"\)|path === "([^"]+)"/g;
    for (const m of body.matchAll(tokenRe)) {
      if (m[0].startsWith("handle")) {
        const name = m[0].slice(0, m[0].indexOf("("));
        inventory.push(...handlerConditions(name));
      } else if (m[3] !== undefined) inventory.push(`INLINE :: === "${m[3]}"`);
      else inventory.push(`INLINE :: ${m[1]}("${m[2]}")`);
    }
    expect(inventory).toEqual(EXPECTED_INVENTORY);
  });
});
