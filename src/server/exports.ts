/**
 * Slice 9 (#2902 Cleanup) — the Worker entrypoint's agent / Durable
 * Object / workflow exports, moved verbatim from src/server.ts.
 *
 * Q3 (contract §8.3) is answered YES: wrangler requires every bound
 * DO class to be exported from the entrypoint itself, otherwise
 * `wrangler deploy` fails — so server.ts re-exports every name
 * below from this module (same names, same live bindings, runtime
 * surface unchanged). The per-class justification comments travel
 * with the exports they justify; nothing here is blanket-copied.
 */

export { OrchestratorAgent } from "../agents/orchestrator";

// Issue #1387 — the agents SDK resolves sub-agent roots through
// ctx.exports by constructor.name, so OrchestratorAgent is exported
// under its own name: the root-namespace lookup requires
// ctx.exports["OrchestratorAgent"] to expose idFromName.
// Issue #2523 (Agent Mesh S2-B, gate record #2326) — the two-deploy
// G0 rename is complete. Migration v14 (#2330, Deploy A) tombstoned
// the colliding v9 OrchestratorAgent namespace (and, per the legacy
// Delete-migration procedure, temporarily removed this own-name
// export); migration v15 now renames the SEARCH_AGENT namespace
// onto OrchestratorAgent (renamed_classes), so the SearchAgent
// export alias is retired and this own-name export is restored. The
// SEARCH_AGENT binding name is unchanged — only its class_name is
// now OrchestratorAgent — so instance names (logins) and their
// stored state carry over, the class's own-name namespace is the
// renamed namespace, and sub-agent root resolution through
// ctx.exports works again.
// Issue #2230 — wrangler requires every bound DO class to be exported from
// the entrypoint, otherwise `wrangler deploy` fails.

export { TickerAgent, TICKER_INSTANCE_NAME } from "../agents/ticker-agent";

export { OptionsScannerMCP } from "../mcps/scanner/cloudflareWalletsScanner";

export { BrowserAgent } from "../agents/browserAgent";

export { SlackAgent } from "../agents/slackAgent";

export { AiSearchAgent } from "../agents/aiSearchAgent";

// Issue #2253 — SandboxAgent DO: wrangler binds SANDBOX_AGENT to this
// class, so it must be exported from the entrypoint (same rule as the
// #2230 note above).

export { SandboxAgent } from "../agents/sandbox-agent";

// Issue #197: wrangler.jsonc binds PAYMENTS_AGENT/SCHEDULED_AGENT as Durable
// Objects — wrangler requires every bound DO class to be exported from the
// entrypoint, otherwise `wrangler deploy` fails.

export { PaymentsAgent } from "../agents/payments-agent";

export { ScheduledAgent } from "../agents/scheduled-agent";

export { ScreenerAgent } from "../agents/screener-agent";

// Issue #319 — wrangler requires every bound DO class to be exported from
// the entrypoint, otherwise `wrangler deploy` fails.

export { ResearchAgent } from "../agents/research-agent";

export { TradingAgent } from "../agents/trading-agent";

export { TradingTradeWorkflow } from "../agents/trading-trade-workflow";

export { ScreenerScreenWorkflow } from "../workflows/screenerWorkflow";

export { PaymentWorkflow } from "../workflows/paymentWorkflow";

export { CrossDomainSagaWorkflow } from "../workflows/sagaWorkflow";

export { ReportAssetAgent } from "../agents/report-asset-agent";

export { SessionStore } from "../security/sessionStore";

// Slice 7 (#2902): PREMIUM_GATEWAY_INSTANCE moved to src/server/routes/platform.ts;
// re-exported here so existing imports from the entry keep working.

export { PREMIUM_GATEWAY_INSTANCE } from "./routes/platform";

