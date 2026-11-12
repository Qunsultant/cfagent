import { resolveEnvironmentConfig } from "../../config/environment";
import {
  buildSchedulePayload,
  parseOptionScreenerFilter,
  parseStockScreenerFilter,
  SCREENING_SCHEDULE_CALLBACKS,
} from "../../trading";
import { ETradeAgenticPaymentService, TRADING_PAID_SERVICES } from "../../services/agenticPayments";
import { describeX402PaymentPath } from "../../services/x402PaymentPath";
import { ETradeBrowserService } from "../../services/browserAgent";
import { ETradeService } from "../../services/etrade";
import { createComparisonRunner } from "../../services/comparisonNlqRunner";
import { getPlatformCapabilitiesDeskSummary } from "../../services/platformKnowledge";
import { UnifiedOptionsService, ETradeSlackTradingService, describeFlowProvenance, getDynamicLiveFlowItems, isNonLivePricingQuoteStatus, nonLivePricingNotice } from "../../trading";
import { runOptionsStrategyAction, type OptionsStrategyIntent } from "../nlqOptionsStrategy";
import {
  controlOptionsStage,
  type OptionsStageControlOperation,
} from "../../workflows/optionsStageControl";
import type { DatabaseORM, SqlStorage } from "../../orm";
import type { OptionsStageStorage } from "../../workflows/optionsScreenPorts";
import type { ScanRunStore, StrategyProfileStore } from "../../trading";
import type { AgentScheduleItem, Env, OptionScreenResult } from "../../types";
import { formatMarketCap, formatTradingQuoteBidAsk, formatTradingQuoteHeadline } from "./formatting";
import { planNLQ, validateNLQPlanWithLLM } from "./llmPlanning";
import { STOP_WORDS_REGEX } from "./orderParams";
import { NLQPlan, isNlqTableAllowed } from "./schema";
import {
  agentScheduleProvenance,
  executeAgentScheduleAction,
  isNlqScheduleCallbackAllowed,
  type AgentScheduleExecutorDeps,
  type AgentSdkTiming,
} from "../../services/agentScheduleCapability";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { NLQExecutionDeps, NLQQueryResult, NLQSchedulingPort, type NLQSocialBriefPort, type NLQStockScreenPort, type NLQStockScreenRunResult } from "./types";
import { SOCIAL_BRIEF_MAX_CHARS, resolveBriefDate } from "../social/briefStore";
import { getUserDid } from "../did";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/nlq/execution",
});
function auditNlqExecution(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  result: NLQQueryResult | null,
  durationMs: number,
  error?: unknown
): void {
  if (!orm?.events) return;
  try {
    const payload: Record<string, unknown> = {
      domain: plan.domain,
      status: result?.status ?? "ok",
      count: typeof result?.count === "number" ? result.count : 0,
      durationMs: Math.max(0, Math.round(durationMs)),
    };
    if (typeof result?.targetTable === "string") payload.targetTable = result.targetTable;
    if (typeof plan.planSource === "string") payload.planSource = plan.planSource;
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      payload.error = message.slice(0, 200);
    }
    orm.events.create({
      id: crypto.randomUUID(),
      sessionId,
      type: error ? "nlq.error" : "nlq.executed",
      agent: "nlq",
      payload,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Audit is best-effort; never fail the execution for a logging write.
  }
}

/**
 * Issue #982 (screening consolidation S2): the unified options service
 * for NLQ executions. Every NLQ options screen runs through it (the
 * REST unified route's service), so execution — and, with the persist
 * helpers below, the canonical run record — is entry-point
 * independent. Constructed the env-preserving way the other NLQ
 * services are: the ORM is forwarded as-is (#781) and a missing env
 * degrades to the empty-env idiom ETradeService itself uses.
 */
function nlqUnifiedOptionsService(
  orm: DatabaseORM,
  env: Env | undefined,
  userLogin: string
): UnifiedOptionsService {
  return new UnifiedOptionsService(env ?? ({} as Env), userLogin, undefined, orm);
}

/**
 * Issue #982: persist an NLQ options screen's canonical copy in
 * mas_reports, mirroring the REST options-screen route's division of
 * labour (the route persists the service run's copy — see
 * routes/etradeOptions.ts) and its shape, with the entry point
 * recorded in the generation id + body trigger ("nlq", cf. the REST
 * route's "manual"). Best-effort exactly like the route's: a failed
 * store never breaks the answer (storeReportAtGeneration logs the
 * failure loudly itself, #876).
 */
function persistNlqOptionsScreenReport(
  orm: DatabaseORM,
  userLogin: string,
  filter: { underlyingSymbols?: string[] },
  result: {
    totalUnderlyingsScanned: number;
    totalContractsEvaluated: number;
    matchedCount: number;
  },
  generatedAt: string,
  env?: Env
): void {
  try {
    const generationId = `options_scanner:nlq:${generatedAt}`;
    orm.storeCanonicalReport(
      {
        runId: generationId,
        generationId,
        title: `Options contract screen — ${(filter.underlyingSymbols || []).join(", ") || "selected underlyings"}`,
        source: "options_scanner",
        summary: `${result.totalUnderlyingsScanned} underlyings scanned, ${result.totalContractsEvaluated} contracts evaluated, ${result.matchedCount} matched.`,
        body: { generatedAt, filter, result, trigger: "nlq" },
        userLogin,
        createdAt: generatedAt,
      },
      env
    );
  } catch {
    // Non-critical: persistence failure must not break the screen
    // (the same rule the REST route and premium endpoints follow).
  }
}

/**
 * Issue #982: persist an NLQ stock screen's canonical copy, mirroring
 * the orchestrator's persistScreenerReportCanonical (the REST stock
 * route's caller-layer persist) field for field — source "screener",
 * generation `screener:<timestamp>` — with the entry point in the
 * body's trigger ("nlq"; REST manual runs record "manual"). Same
 * best-effort rule.
 */
function persistNlqStockScreenReport(
  orm: DatabaseORM,
  userLogin: string,
  run: NLQStockScreenRunResult,
  env?: Env
): void {
  try {
    const generationId = `screener:${run.timestamp}`;
    orm.storeCanonicalReport(
      {
        runId: generationId,
        generationId,
        title: `Market screen — ${String(run.universe ?? run.sector ?? "ALL")} (nlq)`,
        source: "screener",
        summary: run.success
          ? `Scanned ${run.totalScanned} symbols, ${run.matchedCount} matched, ${run.opportunities.length} opportunities.`
          : `Screen failed: ${run.error ?? "unknown error"}.`,
        userLogin,
      body: {
        timestamp: run.timestamp,
        universe: run.universe,
        sector: run.sector,
        trigger: "nlq",
        success: run.success,
        totalScanned: run.totalScanned,
        matchedCount: run.matchedCount,
        opportunities: run.opportunities,
        allStocks: run.allStocks,
        pdfKey: run.pdfKey,
        reportUrl: run.pdfKey
          ? `/api/screener/report.pdf?key=${encodeURIComponent(run.pdfKey)}`
          : undefined,
        error: run.error,
      },
      createdAt: run.timestamp,
      },
      env
    );
  } catch {
    // Non-critical: persistence failure must not break the screen.
  }
}

/**
 * Issue #982: build the NLQ stock-screen envelope from a service run
 * (the ScreenerAgent pipeline result the stock-screen port returns),
 * in the same shape the listings-screener path produces — same
 * scanner states, same summary wording, same row keys. Fields the
 * pipeline does not carry (per-stock market cap, absolute change, the
 * listings discovery object) read as explicit "N/A" / are omitted
 * rather than fabricated.
 */
function stockScreenEnvelopeFromServiceRun(
  plan: NLQPlan,
  run: NLQStockScreenRunResult,
  screenFilters: { gainersOnly?: boolean; losersOnly?: boolean },
  executedAt: string
): NLQQueryResult {
  const hasMismatch = run.allStocks.some((s) => {
    if (screenFilters.gainersOnly && s.changePercent <= 0) return true;
    if (screenFilters.losersOnly && s.changePercent >= 0) return true;
    return false;
  });
  let scannerState: "no_universe" | "scan_failed" | "no_matches" | "matches_found" | "SCAN_INVALID_DATA_MISMATCH";
  let summary: string;
  if (!run.success) {
    scannerState = "scan_failed";
    summary = `Market Scanner: ${run.error || "The screening service reported a failed run."} (${run.filterSummary || "no filter summary"}).`;
  } else if (hasMismatch) {
    scannerState = "SCAN_INVALID_DATA_MISMATCH";
    summary = `🚨 SCAN INVALID — DATA MISMATCH: One or more returned rows contradicted requested screen filter (${run.filterSummary}). Action shortcuts disabled.`;
  } else if (run.totalScanned === 0) {
    scannerState = "no_universe";
    summary = run.discoveryMessage || "The screening service processed no universe for this request.";
  } else if (run.matchedCount === 0) {
    scannerState = "no_matches";
    summary = `Market Scanner: [Scanned ${run.totalScanned} equities; 0 matched criteria] (${run.filterSummary}).`;
  } else {
    scannerState = "matches_found";
    summary = `Market Scanner: [Scanned ${run.totalScanned} equities; ${run.matchedCount} passed criteria] (${run.filterSummary}).`;
  }
  return {
    plan,
    domain: "trading",
    targetTable: "etrade_market_screener",
    count: run.matchedCount,
    status: scannerState,
    summary,
    validationError: run.success ? undefined : run.error,
    provenance: {
      scannerState,
      universeCount: run.totalScanned,
      passedCount: run.matchedCount,
      rejectedCount: run.rejections?.length ?? 0,
      dataSource: "ScreenerAgent screening pipeline (E*TRADE quotes) — the REST stock screening service",
      quoteTimestamp: run.timestamp,
      executedAt,
    },
    rows: run.allStocks.map((s) => {
      const rowMismatch =
        (screenFilters.gainersOnly && s.changePercent <= 0) ||
        (screenFilters.losersOnly && s.changePercent >= 0);
      return {
        symbol: s.symbol,
        companyName: s.companyName,
        sector: s.sector || "N/A",
        exchange: "N/A",
        price: `$${s.lastPrice.toFixed(2)}`,
        rawPrice: s.lastPrice,
        change: `${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%`,
        changePercent: s.changePercent,
        marketCap: "N/A",
        source: s.source || "ScreenerAgent pipeline",
        quoteTimestamp: run.timestamp,
        validationStatus: rowMismatch ? "FAIL_MISMATCH" : "PASS_CONFIRMED",
        actionAvailable: (hasMismatch || rowMismatch) ? "DISABLED (DATA MISMATCH)" : `Preview Buy/Sell for ${s.symbol}`,
      };
    }),
    executedAt,
  };
}

/**
 * Issue #2396 (Agent Mesh S11 / #2225 G3): the refusal for the NLQ paid
 * actions (paid_scan / paid_research), shared by both executors.
 *
 * A paid action may only be served against a VERIFIED x402 payment, and
 * this executor cannot collect or verify one: the NLQ plan schema
 * (agenticPaymentsData) carries no payment-proof field, and the payment
 * service holds no signing key — the only proof it can produce is the
 * simulated one real verifiers reject. The previous behavior ran the
 * premium service for free and recorded a self-minted receipt in the
 * payments ledger (labelled "simulated" since #122, but still a receipt
 * for a payment that never happened). The verified rail already exists:
 * the premium endpoint the tier names answers 402, the payer's wallet
 * pays, the claim is verified on-chain, and only then is a verified
 * receipt recorded from the settlement (src/agents/routes/premium.ts).
 * So the paid actions refuse here — nothing executed, nothing recorded —
 * the same disposition channels apply to these actions (#183,
 * src/trading/channels/intake.ts).
 */
function nlqPaidActionRefusal(
  plan: NLQPlan,
  serviceLabel: string,
  tier: { priceUSD: number; resource: string },
  executedAt: string,
  // #2406 (Phase 1.1): the refusal states the payment path next to the
  // price. Default is the gate's default network (base-sepolia,
  // testnet funds, no real money); call sites pass env?.X402_NETWORK
  // when env is in scope. The NLQ path itself collects nothing — it
  // refuses and points at the signed-in app's verified x402 path.
  network?: string,
): NLQQueryResult {
  const pathLabel = describeX402PaymentPath(network || "base-sepolia").label;
  return {
    plan,
    domain: "agentic_payments",
    targetTable: "agentic_payments",
    count: 0,
    status: "error",
    summary:
      `${serviceLabel} ($${tier.priceUSD.toFixed(2)} USDC) requires a verified x402 payment, ` +
      `and no payment can be collected from this request — nothing was executed and nothing was recorded. ` +
      `Payment path: ${pathLabel} ` +
      `To use it, open ${tier.resource} in the signed-in app: you pay $${tier.priceUSD.toFixed(2)} USDC from your wallet there, ` +
      `the payment is verified, and only then does the service run.`,
    rows: [],
    executedAt,
  };
}

/** Issue #257: the original synchronous executor (renamed); the exported
 *  executeNLQQuery below wraps it with the mas_events audit write. */
function executeNLQQueryCore(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  env?: Env,
  userDid?: string
): NLQQueryResult {
  const executedAt = new Date().toISOString();

  // 1. List Tables & Schema
  if (plan.domain === "tables") {
    const tables = orm.listTables();
    return {
      plan,
      domain: "tables",
      count: tables.length,
      summary: `Found ${tables.length} tables in SQLite database schema.`,
      rows: tables.map((t) => ({
        tableName: t.name,
        rowCount: t.rowCount,
        description: t.description,
        columnCount: t.columns.length,
        columns: t.columns.map((c) => `${c.name} (${c.type}${c.isPrimary ? ", PK" : ""})`).join(", "),
      })),
      executedAt,
    };
  }

  // 1b. Task Scheduling Operations (Cloudflare Agents Schedule API)
  // Issue #109: scheduling actions arm REAL Agent schedules through the
  // injected NLQSchedulingPort, which only the asynchronous executor
  // (executeNLQQueryAsync) can call. The sync executor must never
  // fabricate a schedule — it previously invented `sched_<type>_<ts>`
  // ids, wrote a schedule.created audit event against a nonexistent
  // mas_schedules table, and reported success for schedules that did
  // not exist. Direct sync calls now get an honest refusal, matching
  // the guard pattern used for async-only trading actions below.
  if (plan.domain === "scheduling") {
    const action = plan.scheduleData?.action || "list";
    return {
      plan,
      domain: "scheduling",
      targetTable: "cf_agent_schedules",
      count: 0,
      status: "error",
      summary: `Scheduling (${action}): this action requires the asynchronous NLQ executor (executeNLQQueryAsync) with a live agent scheduling port. Nothing was created, cancelled, or listed by this call.`,
      rows: [],
      executedAt,
    };
  }

  // #1077 Phase 5b slice 2: the sync executor cannot write a brief
  // (the store is async-only), so it refuses honestly like
  // scheduling above. The async executor with a live social brief
  // port is the only write path.
  if (plan.domain === "social") {
    return {
      plan,
      domain: "social",
      count: 0,
      status: "error",
      summary: "Social brief: this action requires the asynchronous NLQ executor (executeNLQQueryAsync) with a live social brief port. Nothing was stored by this call.",
      rows: [],
      executedAt,
    };
  }

  // 1c. Cloudflare Agentic Payments Operations (x402 & MPP)
  if (plan.domain === "agentic_payments") {
    const paymentService = new ETradeAgenticPaymentService(orm, env, sessionId);
    const action = plan.agenticPaymentsData?.action || "wallet_status";

    if (action === "paid_scan" || action === "paid_research") {
      // Issue #2396: paid actions refuse on every executor (see
      // nlqPaidActionRefusal). Without this branch the plan fell
      // through to the conversation-history default below and answered
      // a paid request with chat records.
      return action === "paid_scan"
        ? nlqPaidActionRefusal(plan, "Paid Options Screener", TRADING_PAID_SERVICES.OPTIONS_SCREENER, executedAt, env?.X402_NETWORK)
        : nlqPaidActionRefusal(plan, "Paid Market Research", TRADING_PAID_SERVICES.MARKET_RESEARCH, executedAt, env?.X402_NETWORK);
    }

    if (action === "wallet_status") {
      // Issue #122: delegate to the payment service (single source of truth)
      // and disclose that the balance is a simulated local-ledger figure —
      // a $50.00 local starting credit plus/minus locally recorded entries,
      // NOT an on-chain wallet balance.
      const wallet = paymentService.getWalletStatusSync();

      return {
        plan,
        domain: "agentic_payments",
        targetTable: "mas_agentic_wallet",
        count: 1,
        summary: `Agentic Wallet: Balance $${wallet.balanceUSD.toFixed(2)} USDC on ${wallet.network}. This is a SIMULATED local-ledger balance (includes a $${wallet.startingCreditUSD.toFixed(2)} local starting credit and locally recorded entries only) — not an on-chain wallet balance. Auto-approve limit: $${wallet.autoApproveLimitUSD.toFixed(2)}. Total spent: $${wallet.totalSpentUSD.toFixed(2)}, total earned: $${wallet.totalEarnedUSD.toFixed(2)} across ${wallet.transactionCount} micropayments.`,
        rows: [
          {
            network: wallet.network,
            balanceUSD: `$${wallet.balanceUSD.toFixed(2)}`,
            autoApproveLimitUSD: `$${wallet.autoApproveLimitUSD.toFixed(2)}`,
            totalSpentUSD: `$${wallet.totalSpentUSD.toFixed(2)}`,
            totalEarnedUSD: `$${wallet.totalEarnedUSD.toFixed(2)}`,
            micropaymentCount: wallet.transactionCount,
            status: "SIMULATED",
            simulated: true,
            source: wallet.source,
            startingCreditUSD: `$${wallet.startingCreditUSD.toFixed(2)}`,
          },
        ],
        executedAt,
      };
    }

    if (action === "set_limit") {
      const limit = plan.agenticPaymentsData?.limitUSD ?? 0.05;
      paymentService.setAutoApproveLimit(limit);
      return {
        plan,
        domain: "agentic_payments",
        targetTable: "mas_agentic_wallet",
        count: 1,
        summary: `Agentic micropayment auto-approval limit updated to $${limit.toFixed(2)} USD (HITL safeguard active).`,
        rows: [
          {
            action: "SET_LIMIT",
            limitUSD: `$${limit.toFixed(2)}`,
            status: "SUCCESS",
            updatedAt: executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "micropayments_list") {
      const allTx = orm.transactions ? orm.transactions.findMany({ limit: plan.limit || 25, orderBy: "created_at DESC" }) : [];
      const micropayments = allTx.filter((t) => t.gateway === "x402" || t.gateway === "mpp");
      return {
        plan,
        domain: "agentic_payments",
        targetTable: "mas_transactions",
        count: micropayments.length,
        summary: `Found ${micropayments.length} micropayment transaction(s) in durable financial ledger.`,
        rows: micropayments.map((t) => ({
          id: t.id,
          action: t.action,
          amount: `$${t.amount.toFixed(2)} ${t.currency}`,
          customer: t.customer,
          gateway: t.gateway,
          status: t.status,
          proposerDid: t.proposerDid,
          proofSignature: t.proofSignature,
          createdAt: t.createdAt,
        })),
        executedAt,
      };
    }
  }

  // 2. Add or Update Referral Categories via ORM
  if (plan.domain === "category_mutation") {
    const catName = plan.categoryData?.name || plan.terms || "New Category";
    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const now = new Date().toISOString();
    const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;

    // #2345: categories are a marketplace-port table now. The
    // synchronous executor can only serve the DO composition
    // (AGENT_DB unbound — the facade's sync repository over the
    // instance's own table, exactly the pre-move behaviour).
    // When AGENT_DB is bound the table is D1-resident and a
    // sync executor cannot write it; writing the per-instance
    // table anyway would split the fleet table, so — matching
    // the scheduling/social guard pattern above — the sync
    // executor refuses honestly and the asynchronous executor
    // (executeNLQQueryAsyncCore) serves the domain.
    if (env?.AGENT_DB) {
      return {
        plan,
        domain: "category_mutation",
        targetTable: "mas_categories",
        count: 0,
        status: "error",
        summary:
          "Category mutation: this action requires the asynchronous NLQ executor (executeNLQQueryAsync) — the categories table is D1-resident in this environment and cannot be written synchronously. Nothing was created by this call.",
        rows: [],
        executedAt,
      };
    }

    const created = orm.categories.create({
      id,
      name: catName,
      slug,
      description: plan.categoryData?.description || `Category for ${catName} referrals`,
      icon: plan.categoryData?.icon || "🏷️",
      isActive: true,
      sortOrder: (orm.categories.count() || 0) + 1,
      createdAt: now,
      updatedAt: now,
    });

    const allCategories = orm.categories.findMany({ orderBy: "sort_order ASC" });

    return {
      plan,
      domain: "category_mutation",
      targetTable: "mas_categories",
      count: allCategories.length,
      summary: `Category "${created.name}" created successfully via ORM. Total active categories: ${allCategories.length}.`,
      rows: allCategories.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        slug: c.slug,
        description: c.description,
        status: c.isActive ? "ACTIVE" : "INACTIVE",
        sortOrder: c.sortOrder,
      })),
      executedAt,
    };
  }

  // 3. Query Specific Table Data via ORM
  if (plan.domain === "table_data") {
    const table = plan.targetTable || "mas_categories";
    // Assessment P0 (#143): a prompt-injected planner could previously name
    // any table here (e.g. sqlite_master) because targetTable was a free
    // string. Refuse anything off the explicit allowlist — clean refusal,
    // never partial data.
    if (!isNlqTableAllowed(table)) {
      return {
        plan,
        domain: "table_data",
        targetTable: table,
        count: 0,
        status: "error",
        summary: `Refused: table "${table}" is not readable through natural language queries. Nothing was read.`,
        rows: [],
        executedAt,
      };
    }
    const data = orm.getTableData(table, { search: plan.terms, limit: plan.limit });
    return {
      plan,
      domain: "table_data",
      targetTable: table,
      count: data.rows.length,
      summary: `Retrieved ${data.rows.length} rows from ${table} (Total: ${data.total}).`,
      rows: data.rows,
      executedAt,
    };
  }

  // 4. Trading Domain (E*TRADE stock screening, quotes, order previews, positions)
  if (plan.domain === "trading") {
    const etrade = new ETradeService(orm, env, sessionId);
    const action = plan.tradingData?.action || "screen";

    if (action === "capabilities") {
      const caps = getPlatformCapabilitiesDeskSummary();
      return {
        plan,
        domain: "trading",
        targetTable: "platform_capabilities",
        count: caps.workflows.length,
        status: "matches_found",
        summary: caps.spokenSummary,
        displayMarkdown: caps.markdownOverview,
        rows: caps.workflows as any,
        executedAt,
      };
    }

    if (action === "screen") {
      // Issue #959: NLQ stock screens validate through the ONE shared
      // stock-filter schema — a mis-shaped plan filter is an explicit
      // error, never a silently-mis-shaped engine run.
      const parsedFilters = parseStockScreenerFilter(plan.tradingData?.filters ?? {});
      if (!parsedFilters.ok) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_market_screener",
          count: 0,
          status: "error",
          summary: `Market Scanner: ${parsedFilters.error}`,
          rows: [],
          executedAt,
        };
      }
      const screenFilters = parsedFilters.value;
      const screenRes = etrade.screenStocks(screenFilters);
      let scannerState: "not_run" | "no_universe" | "data_unavailable" | "scan_failed" | "no_matches" | "matches_found" | "SCAN_INVALID_DATA_MISMATCH";
      let summary = "";

      const hasMismatch = screenRes.status === "SCAN_INVALID_DATA_MISMATCH" || screenRes.stocks.some((s) => {
        if (screenFilters.gainersOnly && s.changePercent <= 0) return true;
        if (screenFilters.losersOnly && s.changePercent >= 0) return true;
        return false;
      });

      if (hasMismatch) {
        scannerState = "SCAN_INVALID_DATA_MISMATCH";
        summary = `🚨 SCAN INVALID — DATA MISMATCH: Screened candidates contradict requested filter criteria (${screenRes.filterSummary}). Action shortcuts disabled.`;
      } else if (screenRes.totalScreened === 0) {
        scannerState = "no_universe";
        summary = "⚠️ Scanner State: [No universe processed] (0 equities configured or retrieved). Data unavailable or scan not run.";
      } else if (screenRes.stocks.length === 0) {
        scannerState = "no_matches";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; 0 matched criteria] (${screenRes.filterSummary}).`;
      } else {
        scannerState = "matches_found";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; ${screenRes.stocks.length} passed criteria] (${screenRes.filterSummary}).`;
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_screener",
        count: screenRes.stocks.length,
        status: scannerState,
        summary,
        scanLedger: screenRes.ledger,
        movers: screenRes.movers,
        provenance: {
          scannerState,
          universeCount: screenRes.totalScreened,
          passedCount: screenRes.stocks.length,
          rejectedCount: screenRes.ledger?.rejectedCount ?? 0,
          rsiLookback: "14-Period Daily RSI",
          macdSettings: "12, 26, 9 EMA",
          quoteDelay: "Level 1 Quotes (E*TRADE Sandbox / Hybrid)",
          executedAt,
        },
        rows: screenRes.stocks.map((s) => {
          const rowMismatch =
            (plan.tradingData?.filters?.gainersOnly && s.changePercent <= 0) ||
            (plan.tradingData?.filters?.losersOnly && s.changePercent >= 0);
          return {
            symbol: s.symbol,
            companyName: s.companyName,
            sector: s.sector,
            exchange: s.listingExchange || (s as any).exchange || "N/A",
            price: `$${s.price.toFixed(2)}`,
            rawPrice: s.price,
            change: `${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)} (${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%)`,
            changePercent: s.changePercent,
            changePeriod: s.changePeriod || "1D (Regular Trading Day)",
            priorClose: `$${(s.previousClose ?? (s.price - s.change)).toFixed(2)}`,
            rsi14: s.rsi14,
            rsiLookback: s.rsiLookback || "14-Period Daily RSI",
            macdSignal: s.macdSignal,
            calculationVersion: s.macdIndicatorVersion || "MACD (12, 26, 9 EMA)",
            marketCap: formatMarketCap(s.marketCap),
            peRatio: s.peRatio ? s.peRatio.toFixed(1) : "N/A",
            signal: s.signal,
            source: s.source || "Level 1 Quotes (E*TRADE Sandbox / Hybrid)",
            quoteTimestamp: s.timestamp || executedAt,
            validationStatus: rowMismatch ? "FAIL_MISMATCH" : (s.validationStatus || "PASS_CONFIRMED"),
            actionAvailable: (hasMismatch || rowMismatch) ? "DISABLED (DATA MISMATCH)" : `Preview Buy/Sell for ${s.symbol}`,
          };
        }),
        executedAt,
      };
    }

    if (action === "quote") {
      const sym = plan.tradingData?.symbol || plan.terms || "NVDA";
      const q = etrade.getQuote(sym);
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_quotes",
        count: 1,
        summary: formatTradingQuoteHeadline(q),
        rows: [
          {
            symbol: q.symbol,
            company: q.companyName,
            lastPrice: `$${q.lastPrice.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            changePeriod: "1D (Regular Trading Day)",
            priorClose: `$${(q.previousClose || (q.lastPrice - q.change)).toFixed(2)}`,
            bidAsk: formatTradingQuoteBidAsk(q),
            volume: q.volume.toLocaleString(),
            range52Week: `$${((q.low52 ?? q.week52Low) || 0).toFixed(2)} - ${((q.high52 ?? q.week52High) || 0).toFixed(2)}`,
            peRatio: q.peRatio ? q.peRatio.toFixed(1) : "N/A",
            marketCap: formatMarketCap(q.marketCap),
            source: q.source,
            quoteStatus: q.quoteStatus || "UNKNOWN",
            quoteTimestamp: q.timestamp || executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "preview_order") {
      const sym = (plan.tradingData?.symbol || "").trim().toUpperCase();
      if (!sym) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: "E*TRADE order preview requires a valid stock symbol (e.g. 'buy 10 shares of NVDA').",
          rows: [],
          executedAt,
        };
      }
      const qty = plan.tradingData?.quantity || 1;
      const orderAction = plan.tradingData?.orderAction || "BUY";
      const quote = etrade.getQuote(sym);
      const relativeOffset = plan.tradingData?.relativePriceOffsetPercent;
      const relativeDesc = plan.tradingData?.relativePriceDescription;

      // #913/#920: a relative-priced order ("x% below market") may only be
      // priced off a LIVE E*TRADE quote. A static/simulated fallback quote
      // or a missing price refuses the order — no draft is created and no
      // static-derived price is ever substituted.
      if (relativeOffset !== undefined && (!(quote.lastPrice > 0) || isNonLivePricingQuoteStatus(quote.quoteStatus))) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: `Cannot price this relative order for ${sym}: no live E*TRADE quote is available (quote status: ${quote.quoteStatus || "UNAVAILABLE"}). Relative orders are priced only from a live E*TRADE quote — no order draft was created.`,
          rows: [],
          executedAt,
        };
      }

      let limitPrice = plan.tradingData?.limitPrice;
      let orderType = plan.tradingData?.orderType || (limitPrice !== undefined || relativeOffset !== undefined ? "LIMIT" : "MARKET");

      if (relativeOffset !== undefined && quote.lastPrice > 0) {
        orderType = "LIMIT";
        limitPrice = Number((quote.lastPrice * (1 + relativeOffset / 100)).toFixed(2));
      } else if (limitPrice !== undefined) {
        orderType = "LIMIT";
      }

      const draft = etrade.previewOrder({
        sessionId,
        symbol: sym,
        orderAction,
        quantity: qty,
        orderType,
        limitPrice,
        ...(plan.tradingData?.takeProfitPercent !== undefined
          ? { takeProfitPercent: plan.tradingData.takeProfitPercent }
          : {}),
        ...(plan.tradingData?.stopLossPercent !== undefined
          ? { stopLossPercent: plan.tradingData.stopLossPercent }
          : {}),
      });

      const shareWord = draft.quantity === 1 ? "share" : "shares";
      const marketPriceStr = quote.lastPrice > 0 ? `$${quote.lastPrice.toFixed(2)}` : "Market";

      let pricingSummary = `at ~$${draft.estimatedPrice.toFixed(2)}`;
      if (draft.orderType === "LIMIT") {
        if (relativeDesc && quote.lastPrice > 0) {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)} (${relativeDesc} prevailing quote ${marketPriceStr})`;
        } else {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)}`;
        }
      }

      // Dispatch Pre-Trade Approval Ticket to Slack (Strict HITL Gate)
      if (env?.SLACK_WEBHOOK_URL || env?.SLACK_BOT_TOKEN) {
        try {
          const slackService = new ETradeSlackTradingService(env, orm, sessionId);
          slackService.sendPreTradeApprovalTicket({
            orderId: draft.orderId,
            symbol: draft.symbol,
            action: draft.orderAction,
            quantity: draft.quantity,
            orderType: draft.orderType,
            limitPrice: draft.limitPrice,
            estimatedPrice: draft.estimatedPrice,
            estimatedTotal: draft.estimatedTotal,
            commission: draft.estimatedCommission,
            proposerDid: draft.proposerDid,
            expiresAt: draft.expiresAt,
          }).catch((e) => structuredLog.warn("execution.pre_trade_approval_ticket_dispatch_failed", {
            message: "Pre-trade approval ticket dispatch to Slack failed",
            orderId: draft.orderId,
            error: e instanceof Error ? e.message : String(e),
          }));
        } catch {
          // Non-blocking dispatch
        }
      }

      // Issue #118: if the preview was priced from a static fallback quote,
      // the summary (read verbatim by chat/voice) must say so.
      const pricingQuoteStatus = draft.pricingQuoteStatus ?? quote.quoteStatus;
      const nonLivePricingNote = isNonLivePricingQuoteStatus(pricingQuoteStatus)
        ? ` ${nonLivePricingNotice(pricingQuoteStatus)}`
        : "";

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `E*TRADE order preview drafted for ${draft.orderAction} ${draft.quantity} ${shareWord} of ${draft.symbol} ${pricingSummary}. Total: $${draft.estimatedTotal.toFixed(2)}. Attested by ${draft.proposerDid}. Awaiting Human Authorization.${nonLivePricingNote}`,
        rows: [
          {
            orderId: draft.orderId,
            symbol: draft.symbol,
            action: draft.orderAction,
            quantity: draft.quantity,
            orderType: draft.orderType,
            limitPrice: draft.limitPrice !== undefined ? `$${draft.limitPrice.toFixed(2)}` : "N/A (Market Order)",
            prevailingMarketPrice: marketPriceStr,
            pricingQuoteStatus: pricingQuoteStatus || "UNKNOWN",
            relativePricing: relativeDesc,
            estimatedPrice: `$${draft.estimatedPrice.toFixed(2)}`,
            estimatedTotal: `$${draft.estimatedTotal.toFixed(2)}`,
            commission: `$${draft.estimatedCommission.toFixed(2)}`,
            proposerDid: draft.proposerDid,
            status: draft.status.toUpperCase(),
            safetyGuarantee: "No live trade submitted. Human approval required.",
            authorizationPrompt: `Reply 'approve ${draft.orderId}' or execute via Trading Hub.`,
          },
        ],
        executedAt,
      };
    }

    if (action === "execute_order" || action === "approve_order") {
      const orderId = (plan.tradingData?.symbol || "").trim();
      const existingTrade = orm.trades?.findById(orderId.toLowerCase()) || orm.trades?.findById(orderId);

      if (!existingTrade) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: `Order draft '${orderId}' was not found. Orders must be previewed and drafted before authorization.`,
          rows: [],
          executedAt,
        };
      }

      if (existingTrade.status !== "previewed") {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 1,
          summary: `Order '${orderId}' cannot be executed. Current status is '${existingTrade.status.toUpperCase()}'. Only 'previewed' drafts may be authorized.`,
          rows: [{ ...existingTrade }],
          executedAt,
        };
      }

      // #2389: order placement is asynchronous (the platform places
      // through the broker client), so this synchronous executor
      // cannot execute an approval — and it must never claim one.
      // It used to call the old synchronous platform executeOrder and
      // report "APPROVED & EXECUTED" unconditionally, with a fallback
      // broker reference ("et_fill_confirmed") when the result carried
      // none. Approvals route through the async executor
      // (executeNLQQueryAsyncCore); this path refuses honestly and
      // leaves the draft untouched in its previewed state.
      const effectiveAuthorizer = userDid || `did:user:slack:approver`;
      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `E*TRADE order ${existingTrade.id} (${existingTrade.action} ${existingTrade.quantity} ${existingTrade.symbol}) was NOT executed: order approval requires the asynchronous execution path, which places the order with the broker. The draft remains previewed; no funds were moved. (Requested by ${effectiveAuthorizer}.)`,
        rows: [
          {
            orderId: existingTrade.id,
            symbol: existingTrade.symbol,
            action: existingTrade.action,
            quantity: existingTrade.quantity,
            status: existingTrade.status.toUpperCase(),
            authorizerDid: effectiveAuthorizer,
            totalValue: `$${Number(existingTrade.totalValue || 0).toFixed(2)}`,
            executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "cancel_order") {
      const orderId = (plan.tradingData?.symbol || "").trim();
      const existingTrade = orm.trades?.findById(orderId.toLowerCase()) || orm.trades?.findById(orderId);
      const effectiveAuthorizer = userDid || `did:user:slack:canceller`;

      if (existingTrade && orm.trades) {
        orm.trades.update(existingTrade.id, {
          status: "rejected",
          authorizerDid: effectiveAuthorizer,
          updatedAt: executedAt,
        });
      }

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `❌ Order draft '${orderId}' CANCELLED by ${effectiveAuthorizer}. No broker order submitted.`,
        rows: [
          {
            orderId,
            status: "REJECTED",
            authorizerDid: effectiveAuthorizer,
            cancelledAt: executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "positions") {
      const posRes = etrade.getPositions();
      const posTotal = Number(posRes.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0).toFixed(2));
      const statedCash = Number((posRes.account.cashAvailableForInvestment || 0).toFixed(2));
      const calculatedTotal = Number((posTotal + statedCash).toFixed(2));
      const statedTotal = Number((posRes.account.totalAccountValue || posRes.account.netAccountValue || calculatedTotal).toFixed(2));
      const variance = Math.abs(Number((statedTotal - calculatedTotal).toFixed(2)));
      const isReconciled = variance <= 1.00;

      if (!isReconciled) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_portfolio_live",
          count: posRes.positions.length,
          status: "RECONCILIATION_FAILED",
          reconciled: false,
          summary: `⚠️ UNVERIFIED / POSSIBLE DEMO DATA: Portfolio result cannot be reconciled ($${variance.toFixed(2)} unexplained variance between stated total $${statedTotal.toFixed(2)} and positions+cash $${calculatedTotal.toFixed(2)})—no account conclusion shown.`,
          discrepancy: {
            statedAccountTotal: `$${statedTotal.toFixed(2)}`,
            positionsMarketValue: `$${posTotal.toFixed(2)}`,
            statedCash: `$${statedCash.toFixed(2)}`,
            calculatedTotal: `$${calculatedTotal.toFixed(2)}`,
            unexplainedVariance: `$${variance.toFixed(2)}`,
          },
          provenance: {
            dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
            environment: resolveEnvironmentConfig(env).name,
            accountKey: `••••${posRes.account.accountId.slice(-4)}`,
            reconciliationStatus: "FAIL_CLOSED",
            pricesObservedAt: executedAt,
            evaluatedAt: executedAt,
          },
          rows: [],
          executedAt,
        };
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_portfolio_live",
        count: posRes.positions.length,
        status: "RECONCILED",
        reconciled: true,
        summary: `E*TRADE Account ••••${posRes.account.accountId.slice(-4)}: Reconciled Total Value $${statedTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })} (Holdings: $${posTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}, Cash: $${statedCash.toLocaleString("en-US", { minimumFractionDigits: 2 })}), Open Positions: ${posRes.positions.length}.`,
        provenance: {
          dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
          environment: resolveEnvironmentConfig(env).name,
          accountKey: `••••${posRes.account.accountId.slice(-4)}`,
          reconciliationStatus: "VERIFIED_EXACT",
          pricesObservedAt: executedAt,
          evaluatedAt: executedAt,
        },
        rows: posRes.positions.map((p) => ({
          symbol: p.symbol,
          description: p.description,
          shares: p.quantity,
          costBasis: `$${p.costBasis.toFixed(2)}`,
          lastPrice: `$${p.marketPrice.toFixed(2)}`,
          marketValue: `$${p.marketValue.toFixed(2)}`,
          unrealizedGainLoss: `${p.unrealizedGainLoss >= 0 ? "+" : ""}$${p.unrealizedGainLoss.toFixed(2)} (${p.unrealizedGainLossPercent.toFixed(2)}%)`,
        })),
        executedAt,
      };
    }

    if (action === "options_screen") {
      // Live chain screening requires upstream E*TRADE fetches and is handled by
      // executeNLQQueryAsync; the sync executor only guards against direct calls.
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_options_screener",
        count: 0,
        status: "error",
        summary: "Options Screener: this action requires the asynchronous NLQ executor (executeNLQQueryAsync).",
        rows: [],
        executedAt,
      };
    }

    if (action === "options_flow") {
      return {
        plan,
        domain: "trading",
        targetTable: "options_flows",
        count: 0,
        status: "info",
        summary: "Options Flow: this action requires the asynchronous NLQ executor (executeNLQQueryAsync).",
        rows: [],
        executedAt,
        planSource: plan.planSource || "fastpath",
      };
    }

    if (action === "watchlist_save") {
      const name = plan.tradingData?.watchlistName || "My Watchlist";
      let symbols = plan.tradingData?.symbols || [];
      if (symbols.length === 0) {
        const screened = etrade.screenStocks(plan.tradingData?.filters);
        symbols = screened.stocks.slice(0, 10).map((s) => s.symbol);
      }
      if (symbols.length === 0) {
        symbols = ["NVDA", "AAPL", "MSFT", "AMD"];
      }

      const saved = orm.saveWatchlist({
        name,
        userLogin: sessionId,
        symbols,
        source: "local_durable_sqlite",
      });

      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: symbols.length,
        summary: `Successfully saved ${symbols.length} symbol(s) into watchlist "${name}" (ID: ${saved.id}). Tickers: [${symbols.join(", ")}].`,
        rows: [
          {
            watchlistId: saved.id,
            name: saved.name,
            symbolCount: symbols.length,
            symbols: symbols.join(", "),
            source: saved.source,
            status: "SAVED",
            createdAt: saved.createdAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "watchlist_list") {
      const all = orm.getWatchlists(sessionId);
      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: all.length,
        summary: `Found ${all.length} saved watchlist(s) in durable storage.`,
        rows: all.map((w) => {
          let syms: string[] = [];
          try {
            syms = JSON.parse(w.symbolsJson);
          } catch {}
          return {
            watchlistId: w.id,
            name: w.name,
            symbolCount: syms.length,
            symbols: syms.join(", "),
            source: w.source,
            updatedAt: w.updatedAt,
          };
        }),
        executedAt,
      };
    }
  }

  // Handle Market Data Research & Quoting Domain (Yahoo Finance & Alpaca)
  // Issue #923 (epic #913 S5): the synchronous market-data accessors are gone —
  // live market data can only be fetched asynchronously, and the sync NLQ
  // executor cannot await it. A sync research request therefore returns an
  // explicit unavailable result (count 0, status "error", no rows, no
  // numbers) instead of a static/generated profile. The async NLQ entry
  // serves paid research through the live async report path, and the
  // /api/market-data/* routes serve live quotes, fundamentals, bars, and reports.
  if (plan.domain === "research") {
    const sym = plan.researchData?.symbol || plan.terms || "NVDA";
    const action = plan.researchData?.action || "report";
    const targetTable =
      action === "fundamentals"
        ? "yfinance_fundamentals"
        : action === "snapshot"
          ? "alpaca_snapshot"
          : action === "quote"
            ? "market_data_quote"
            : action === "compare"
              ? "market_data_stock_comparison"
              : "market_data_research_report";
    return {
      plan,
      domain: "research",
      targetTable,
      count: 0,
      status: "error",
      summary: `Market data ${action} for ${sym} unavailable in the synchronous NLQ executor: live market data requires the asynchronous path (#923 — no static or generated substitute is served). Use the /api/market-data/* routes or the asynchronous NLQ executor for live data.`,
      rows: [],
      executedAt,
    };
  }

  // 5. Default: Query Conversation History
  const messages = orm.messages.findMany({
    where: { sessionId },
    orderBy: "created_at DESC",
    limit: 100,
  });

  const cleanTerms = (plan.terms || "").replace(STOP_WORDS_REGEX, " ").trim().toLowerCase();
  const keywords = cleanTerms
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);

  let filtered = messages;
  if (plan.role && plan.role !== "any") {
    filtered = filtered.filter((m) => m.role === plan.role);
  }

  if (keywords.length > 0) {
    filtered = filtered.filter((m) => {
      const content = (m.content || "").toLowerCase();
      const agent = (m.agent || "").toLowerCase();
      return keywords.some((kw) => content.includes(kw) || agent.includes(kw));
    });
  }

  filtered = filtered.slice(0, plan.limit);

  return {
    plan,
    domain: "conversation",
    targetTable: "mas_messages",
    count: filtered.length,
    summary: `Found ${filtered.length} conversation records matching query.`,
    rows: filtered.map((m) => ({
      role: m.role,
      agent: m.agent,
      content: m.content,
      created_at: m.createdAt,
    })),
    executedAt,
  };
}

/**
 * Issue #257 (Assessment P1, part of #143): the exported NLQ execution entry.
 * Same contract as the original executor; records one mas_events audit row
 * per execution (success or failure) via auditNlqExecution above.
 */
export function executeNLQQuery(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  env?: Env,
  userDid?: string
): NLQQueryResult {
  const startedAt = Date.now();
  try {
    const result = executeNLQQueryCore(orm, sessionId, plan, env, userDid);
    auditNlqExecution(orm, sessionId, plan, result, Date.now() - startedAt);
    return result;
  } catch (err) {
    auditNlqExecution(orm, sessionId, plan, null, Date.now() - startedAt, err);
    throw err;
  }
}

/**
 * Asynchronous NLQ execution pipeline for real-time live quoting and market screening
 */
/** Human-readable description for a real SDK schedule, used by the
 *  scheduling list action. Reminder schedules describe themselves via
 *  their payload message; the baseline system callbacks get stable
 *  labels so listings stay informative without hardcoding schedules
 *  that may not exist (issue #109). */
function describeScheduleItem(item: AgentScheduleItem): string {
  const payload: any = item.payload || {};
  if (typeof payload.message === "string" && payload.message) return payload.message;
  switch (item.callback) {
    case "autoRenewETradeTokens":
      return "Proactive E*TRADE OAuth token renewal";
    case "autonomousMarketScreen":
      return "Autonomous market screener";
    case "collectIvHistory":
      return "Daily IV history collection";
    case "autonomousOptionsAnalysis":
      return "Autonomous options analysis";
    case "expireStaleOrderDraft":
      return "Order draft auto-expiry (15-minute HITL window)";
    case "sendScheduledReminder":
      return "Scheduled reminder";
    default:
      return item.callback;
  }
}

/**
 * Issue #109: executes scheduling plans against the REAL Cloudflare
 * Agents scheduling API via the injected port. Every outcome is
 * truthful: creation returns the SDK-issued schedule id, cancellation
 * reports the SDK's actual verdict, listing reflects the Scheduler's
 * live rows (including the baseline system schedules), and any
 * missing port or API failure produces an explicit failure result —
 * never a fabricated success.
 */
async function executeSchedulingAction(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  port: NLQSchedulingPort | undefined,
  userLogin: string,
  executedAt: string,
  // Issue #3122 — the agent schedule capability, when the caller bound
  // it (orchestrator). When present, schedule actions route through it.
  capability?: AgentScheduleExecutorDeps,
  tenantId?: string,
): Promise<NLQQueryResult> {
  const action = plan.scheduleData?.action || "list";
  const base = { plan, domain: "scheduling", targetTable: "cf_agent_schedules", executedAt };
  // The NLQ agent acts for the authenticated login.
  const principal = { login: userLogin, agentId: "nlq" };
  const tenant = tenantId ?? "primary";

  const failure = (summary: string): NLQQueryResult => ({
    ...base,
    count: 0,
    status: "error",
    summary,
    rows: [],
  });

  if (!port) {
    return failure(
      `Scheduling (${action}) unavailable: no live agent scheduling port is wired in this context, so the request was NOT executed. No schedule was created, cancelled, or listed.`
    );
  }

  const audit = (type: string, payload: Record<string, unknown>) => {
    if (!orm.events) return;
    try {
      orm.events.create({
        id: crypto.randomUUID(),
        sessionId,
        type,
        agent: "orchestrator",
        payload,
        createdAt: executedAt,
      });
    } catch {
      // Audit is best-effort; the Scheduler itself is the source of truth.
    }
  };

  if (action === "list") {
    let schedules: AgentScheduleItem[];
    try {
      if (capability) {
        const out = await executeAgentScheduleAction(capability, {
          action: "list",
          kind: "sdk",
          principal,
          tenantId: tenant,
        });
        if (!out.ok) {
          return failure(`Failed to list schedules: ${out.reason}. No schedule data could be read.`);
        }
        schedules = (out.schedule as AgentScheduleItem[]) ?? [];
      } else {
        schedules = await port.listSchedules();
      }
    } catch (err) {
      return failure(
        `Failed to list schedules: ${err instanceof Error ? err.message : String(err)}. No schedule data could be read.`
      );
    }
    const rows = schedules.slice(0, plan.limit || 25).map((s) => ({
      id: s.id,
      callback: s.callback,
      type: s.type,
      ...(s.cron ? { cron: s.cron } : {}),
      ...(s.intervalSeconds ? { intervalSeconds: s.intervalSeconds } : {}),
      ...(s.delayInSeconds ? { delayInSeconds: s.delayInSeconds } : {}),
      description: describeScheduleItem(s),
      status: "ACTIVE",
      ...(s.time ? { nextRunAt: new Date(s.time * 1000).toISOString() } : {}),
    }));
    return {
      ...base,
      count: rows.length,
      status: rows.length > 0 ? "matches_found" : "no_matches",
      summary:
        rows.length > 0
          ? `Found ${rows.length} active scheduled task(s) registered with the Cloudflare Agent scheduler.`
          : "No active scheduled tasks are registered with the Cloudflare Agent scheduler.",
      rows,
    };
  }

  if (action === "cancel") {
    const scheduleId = plan.scheduleData?.scheduleId || "";
    if (!scheduleId) {
      return failure("Schedule cancellation failed: no schedule ID was provided, so nothing was cancelled.");
    }
    if (capability) {
      // Issue #3122 — the capability owns the audit + ledger row here;
      // the executor must not emit a second schedule.cancelled event.
      const out = await executeAgentScheduleAction(capability, {
        action: "delete",
        kind: "sdk",
        principal,
        tenantId: tenant,
        scheduleId,
      });
      if (!out.ok && out.code === "not-found") {
        return {
          ...base,
          count: 0,
          status: "not_found",
          summary: `Schedule '${scheduleId}' was not found among the agent's active schedules, so nothing was cancelled. It may have already fired or been cancelled.`,
          rows: [{ scheduleId, status: "NOT_FOUND", cancelledAt: executedAt }],
        };
      }
      if (!out.ok) {
        return failure(`Failed to cancel schedule '${scheduleId}': ${out.reason}. The schedule was NOT cancelled.`);
      }
      return {
        ...base,
        count: 1,
        status: "cancelled",
        summary: `Task schedule '${scheduleId}' cancelled successfully.`,
        rows: [{ scheduleId, status: "CANCELLED", cancelledAt: executedAt }],
      };
    }
    let cancelled: boolean;
    try {
      cancelled = await port.cancelSchedule(scheduleId);
    } catch (err) {
      return failure(
        `Failed to cancel schedule '${scheduleId}': ${err instanceof Error ? err.message : String(err)}. The schedule was NOT cancelled.`
      );
    }
    if (!cancelled) {
      return {
        ...base,
        count: 0,
        status: "not_found",
        summary: `Schedule '${scheduleId}' was not found among the agent's active schedules, so nothing was cancelled. It may have already fired or been cancelled.`,
        rows: [{ scheduleId, status: "NOT_FOUND", cancelledAt: executedAt }],
      };
    }
    audit("schedule.cancelled", { scheduleId, cancelledAt: executedAt });
    return {
      ...base,
      count: 1,
      status: "cancelled",
      summary: `Task schedule '${scheduleId}' cancelled successfully.`,
      rows: [{ scheduleId, status: "CANCELLED", cancelledAt: executedAt }],
    };
  }

  // action === "create"
  const sd: NonNullable<NLQPlan["scheduleData"]> = plan.scheduleData ?? { action: "create" };
  const callback = sd.callback || "sendScheduledReminder";
  const description = sd.description || "Scheduled task";
  // Issue #3122 (F1): the allow-list is enforced here as well as in the
  // plan schema — a plan object that bypasses zod (a direct executor
  // call, a stale client) still cannot arm an unlisted callback.
  if (!isNlqScheduleCallbackAllowed(callback)) {
    return failure(
      `Schedule creation failed: callback '${callback}' is not schedulable through NLQ. Only sendScheduledReminder and the four screen callbacks may be armed by an agent. The schedule was NOT created.`,
    );
  }
  const scheduleType =
    sd.scheduleType ||
    (sd.cron ? "cron" : sd.intervalSeconds ? "interval" : sd.date ? "scheduled" : "delayed");

  // Payload contracts are owned by the orchestrator callbacks:
  // sendScheduledReminder expects { reminderId, message, userLogin? }
  // (its reminderId is the dispatch/audit identifier, distinct from
  // the schedule id the SDK returns).
  //
  // Issue #959 (screening consolidation S1): the three screening
  // callbacks' payloads are built by the ONE shared builder —
  // buildSchedulePayload in src/trading/screeningSchemas.ts — from the
  // plan's criteria, exactly as REST schedule creation builds them, so
  // the same criteria arm the identical payload through every door.
  // The pre-#959 hardcoded market-screen payload (a fixed Technology
  // sector with a 5-item cap, regardless of what was asked) is gone:
  // a criteria-less plan arms only the identity stamps, and the
  // market-screen service's own defaults apply at run time.
  // Mis-shaped criteria fail the action explicitly; nothing is armed.
  let payload: Record<string, unknown>;
  if (callback === "sendScheduledReminder") {
    payload = {
      reminderId: crypto.randomUUID(),
      message: description,
      userLogin,
      // Issue #3122 — agent provenance on every agent-armed schedule.
      provenance: agentScheduleProvenance("nlq", userLogin, executedAt),
    };
  } else if ((SCREENING_SCHEDULE_CALLBACKS as readonly string[]).includes(callback)) {
    const criteria: Record<string, unknown> = {};
    for (const key of [
      "sector",
      "universe",
      "maxItems",
      "symbols",
      "thesis",
      "riskProfile",
      // Issue #3122 (F1): goal-screen criteria (see schema.ts).
      "goalKind",
      "scenarioId",
      "filters",
      "inputModel",
      "requests",
      "constraintSets",
      "profileId",
      "watchlistName",
      // Consolidation C3 (#1277): stage-chain timing rides the same
      // builder-validated criteria as every other field.
      "stageChain",
    ] as const) {
      if (sd[key] !== undefined) criteria[key] = sd[key];
    }
    // Consolidation #1236 (discovery notifications): per-task
    // delivery recipients ride the NLQ schedule path ONLY for
    // autonomousStrategyDiscovery. Other callbacks never carried
    // delivery fields through NLQ, and this keeps them that way —
    // buildSchedulePayload would 400 pushToSlack-style fields on
    // non-discovery schemas, so the gate is the callback, not the
    // builder.
    if (callback === "autonomousStrategyDiscovery") {
      for (const key of ["emailTo", "slackChannel", "webhookUrl"] as const) {
        if (sd[key] !== undefined) criteria[key] = sd[key];
      }
    }
    const built = buildSchedulePayload(callback, criteria, { userLogin, trigger: "scheduled" });
    if (!built.ok) {
      return failure(
        `Schedule creation failed: ${built.error} The schedule was NOT created.`
      );
    }
    // Issue #3122 — agent provenance on every agent-armed schedule.
    payload = {
      ...(built.value as Record<string, unknown>),
      provenance: agentScheduleProvenance("nlq", userLogin, executedAt),
    };
  } else {
    // Unreachable after the allow-list check above; refused honestly
    // rather than armed with a generic payload (the pre-#3122 hole:
    // any callback name an LLM produced was armed verbatim).
    return failure(
      `Schedule creation failed: callback '${callback}' is not schedulable through NLQ. The schedule was NOT created.`,
    );
  }

  // Timing validation runs before anything arms, on both paths.
  let timing: AgentSdkTiming;
  if (scheduleType === "interval") {
    if (!sd.intervalSeconds || sd.intervalSeconds <= 0) {
      return failure("Schedule creation failed: an interval schedule requires a positive intervalSeconds. The schedule was NOT created.");
    }
    timing = { type: "interval", intervalSeconds: sd.intervalSeconds };
  } else if (scheduleType === "cron") {
    if (!sd.cron) {
      return failure("Schedule creation failed: a cron schedule requires a cron expression. The schedule was NOT created.");
    }
    timing = { type: "cron", cron: sd.cron };
  } else if (scheduleType === "scheduled") {
    if (!sd.date) {
      return failure("Schedule creation failed: a one-time schedule requires a date. The schedule was NOT created.");
    }
    const when = new Date(sd.date);
    if (Number.isNaN(when.getTime())) {
      return failure(`Schedule creation failed: '${sd.date}' is not a valid date. The schedule was NOT created.`);
    }
    timing = { type: "scheduled", time: Math.floor(when.getTime() / 1000) };
  } else {
    // delayed
    if (!sd.delayInSeconds || sd.delayInSeconds <= 0) {
      return failure("Schedule creation failed: a delayed schedule requires a positive delayInSeconds. The schedule was NOT created.");
    }
    timing = { type: "delayed", delayInSeconds: sd.delayInSeconds };
  }

  let created: AgentScheduleItem;
  let auditedByCapability = false;
  try {
    if (capability) {
      // Issue #3122 — the capability owns PDP, classification, the
      // approval gate, agent provenance, and the ledger row; the
      // executor maps its outcome onto the NLQ envelope and must not
      // emit a second schedule.created event.
      const isExternalSend =
        callback === "autonomousStrategyDiscovery" &&
        (sd.emailTo !== undefined || sd.slackChannel !== undefined || sd.webhookUrl !== undefined);
      const out = await executeAgentScheduleAction(capability, {
        action: "create",
        kind: "sdk",
        principal,
        tenantId: tenant,
        callback,
        timing,
        payload,
        isExternalSend,
      });
      if (!out.ok && out.code === "approval-required") {
        return failure(
          `Schedule creation requires approval: ${out.reason}. The schedule was NOT created. Pending approval: ${out.pendingApprovalId}.`,
        );
      }
      if (!out.ok) {
        return failure(`Schedule creation failed: ${out.reason}. The schedule was NOT created.`);
      }
      created = out.schedule as AgentScheduleItem;
      auditedByCapability = true;
    } else if (timing.type === "interval") {
      created = await port.scheduleEvery(timing.intervalSeconds, callback, payload);
    } else if (timing.type === "cron") {
      created = await port.schedule(timing.cron, callback, payload, { idempotent: true });
    } else if (timing.type === "scheduled") {
      created = await port.schedule(new Date(timing.time * 1000), callback, payload);
    } else {
      created = await port.schedule(timing.delayInSeconds, callback, payload);
    }
  } catch (err) {
    return failure(
      `Failed to create schedule: ${err instanceof Error ? err.message : String(err)}. The schedule was NOT created.`
    );
  }

  if (!auditedByCapability) {
    audit("schedule.created", {
      scheduleId: created.id,
      scheduleType: created.type,
      callback: created.callback,
      delayInSeconds: created.delayInSeconds,
      intervalSeconds: created.intervalSeconds,
      cron: created.cron,
      description,
      createdAt: executedAt,
    });
  }

  return {
    ...base,
    count: 1,
    status: "scheduled",
    summary: `Task scheduled successfully [ID: ${created.id}]. Type: ${created.type}. Callback: ${created.callback}${description ? ` ("${description}")` : ""}.`,
    rows: [
      {
        id: created.id,
        callback: created.callback,
        type: created.type,
        ...(created.delayInSeconds ? { delayInSeconds: created.delayInSeconds } : {}),
        ...(created.intervalSeconds ? { intervalSeconds: created.intervalSeconds } : {}),
        ...(created.cron ? { cron: created.cron } : {}),
        description,
        status: "SCHEDULED",
        ...(created.time ? { nextRunAt: new Date(created.time * 1000).toISOString() } : {}),
        scheduledAt: executedAt,
      },
    ],
  };
}

/** Issue #257: the original asynchronous executor (renamed); the exported
 *  executeNLQQueryAsync below wraps it with the mas_events audit write. */
async function executeNLQQueryAsyncCore(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  env?: Env,
  userLogin?: string,
  userDid?: string,
  deps?: NLQExecutionDeps
): Promise<NLQQueryResult> {
  const executedAt = new Date().toISOString();
  const loginStr = typeof userLogin === "string" ? userLogin : undefined;
  const effectiveUserDid = userDid || (loginStr?.startsWith("did:") ? loginStr : undefined);

  if (plan.domain === "trading") {
    // Issue #1185: the threaded authenticated login is required — the
    // session id is an instance key, not a login, and there is no
    // synthetic fallback identity.
    const login = userLogin;
    if (!login) {
      return {
        plan,
        domain: "trading",
        count: 0,
        status: "error",
        summary: "Trading: an authenticated user identity is required for this action. Nothing was executed.",
        rows: [],
        executedAt,
      };
    }
    const etrade = new ETradeService(orm, env, login, undefined, deps?.storage);
    const action = plan.tradingData?.action || "screen";

    if (action === "capabilities") {
      const caps = getPlatformCapabilitiesDeskSummary();
      return {
        plan,
        domain: "trading",
        targetTable: "platform_capabilities",
        count: caps.workflows.length,
        status: "matches_found",
        summary: caps.spokenSummary,
        displayMarkdown: caps.markdownOverview,
        rows: caps.workflows as any,
        executedAt,
      };
    }

    if (action === "screen") {
      // Issue #959: same shared stock-filter schema as the sync path.
      const parsedFilters = parseStockScreenerFilter(plan.tradingData?.filters ?? {});
      if (!parsedFilters.ok) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_market_screener",
          count: 0,
          status: "error",
          summary: `Market Scanner: ${parsedFilters.error}`,
          rows: [],
          executedAt,
        };
      }
      const screenFilters = parsedFilters.value;
      // Issue #982: when the stock-screen port is threaded (the
      // orchestrator binds the ScreenerAgent — the stock screening
      // service the REST route delegates to), the screen runs through
      // the service and persists like a REST run. Contexts without a
      // port keep the listings-screener path below, exactly as
      // store-less contexts behave for scan persistence (#27).
      if (deps?.stockScreenPort) {
        try {
          const run = await deps.stockScreenPort.runScreen({ filters: screenFilters, userLogin: login });
          persistNlqStockScreenReport(orm, login, run, env);
          return stockScreenEnvelopeFromServiceRun(plan, run, screenFilters, executedAt);
        } catch (err) {
          return {
            plan,
            domain: "trading",
            targetTable: "etrade_market_screener",
            count: 0,
            status: "error",
            summary: `Market Scanner: ${err instanceof Error ? err.message : "The stock screening service was unavailable."}`,
            rows: [],
            executedAt,
          };
        }
      }
      const screenRes = await etrade.screenMarketsAsync(screenFilters);
      let scannerState: "not_run" | "no_universe" | "data_unavailable" | "scan_failed" | "no_matches" | "matches_found" | "SCAN_INVALID_DATA_MISMATCH";
      let summary = "";

      const hasMismatch = screenRes.status === "SCAN_INVALID_DATA_MISMATCH" || screenRes.stocks.some((s) => {
        if (screenFilters.gainersOnly && s.changePercent <= 0) return true;
        if (screenFilters.losersOnly && s.changePercent >= 0) return true;
        return false;
      });

      if (screenRes.validationError) {
        scannerState = "data_unavailable";
        summary = screenRes.validationError;
      } else if (hasMismatch) {
        scannerState = "SCAN_INVALID_DATA_MISMATCH";
        summary = `🚨 SCAN INVALID — DATA MISMATCH: One or more returned rows contradicted requested screen filter (${screenRes.filterSummary}). Action shortcuts disabled.`;
      } else if (screenRes.totalScreened === 0) {
        scannerState = "no_universe";
        summary = screenRes.discovery?.message || "Dynamic all-exchange listings returned no equities.";
      } else if (screenRes.stocks.length === 0) {
        scannerState = "no_matches";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; 0 matched criteria] (${screenRes.filterSummary}).`;
      } else {
        scannerState = "matches_found";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; ${screenRes.stocks.length} passed criteria] (${screenRes.filterSummary}).`;
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_screener",
        count: screenRes.stocks.length,
        status: scannerState,
        summary,
        validationError: screenRes.validationError,
        discovery: screenRes.discovery,
        scanLedger: screenRes.ledger,
        movers: screenRes.movers,
        provenance: {
          scannerState,
          universeCount: screenRes.totalScreened,
          passedCount: screenRes.stocks.length,
          rejectedCount: screenRes.ledger?.rejectedCount ?? 0,
          dataSource: "Dynamic Nasdaq / NYSE / AMEX stock listings",
          quoteTimestamp: "Not provided by the listing endpoint",
          executedAt,
        },
        rows: screenRes.stocks.map((s) => {
          const rowMismatch =
            (plan.tradingData?.filters?.gainersOnly && s.changePercent <= 0) ||
            (plan.tradingData?.filters?.losersOnly && s.changePercent >= 0);
          return {
            symbol: s.symbol,
            companyName: s.companyName,
            sector: s.sector,
            exchange: s.listingExchange || (s as any).exchange || "N/A",
            price: `$${s.price.toFixed(2)}`,
            rawPrice: s.price,
            change: `${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)} (${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%)`,
            changePercent: s.changePercent,
            marketCap: formatMarketCap(s.marketCap),
            source: s.source || "Dynamic stock listing",
            quoteTimestamp: s.timestamp || executedAt,
            validationStatus: rowMismatch ? "FAIL_MISMATCH" : (s.validationStatus || "PASS_CONFIRMED"),
            actionAvailable: (hasMismatch || rowMismatch) ? "DISABLED (DATA MISMATCH)" : `Preview Buy/Sell for ${s.symbol}`,
          };
        }),
        executedAt,
      };
    }

    if (action === "quote") {
      const sym = plan.tradingData?.symbol || plan.terms || "NVDA";
      const q = await etrade.fetchQuoteRemote(sym);
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_quotes",
        count: 1,
        summary: formatTradingQuoteHeadline(q),
        rows: [
          {
            symbol: q.symbol,
            company: q.companyName,
            lastPrice: `$${q.lastPrice.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            changePeriod: "1D (Regular Trading Day)",
            priorClose: `$${(q.previousClose || (q.lastPrice - q.change)).toFixed(2)}`,
            bidAsk: formatTradingQuoteBidAsk(q),
            volume: q.volume.toLocaleString(),
            range52Week: `$${((q.low52 ?? q.week52Low) || 0).toFixed(2)} - ${((q.high52 ?? q.week52High) || 0).toFixed(2)}`,
            peRatio: q.peRatio ? q.peRatio.toFixed(1) : "N/A",
            marketCap: formatMarketCap(q.marketCap),
            source: q.source,
            quoteStatus: q.quoteStatus || "UNKNOWN",
            quoteTimestamp: q.timestamp || executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "execute_order" || action === "approve_order") {
      // #2389: approvals execute HERE, on the async path, through the
      // platform's broker-backed executeOrder. The synchronous core
      // used to serve this action by claiming "APPROVED & EXECUTED"
      // unconditionally; it now refuses, and this branch is the only
      // NLQ approval path. An EXECUTED report is produced only from a
      // broker-confirmed result carrying a real broker reference.
      const orderId = (plan.tradingData?.symbol || "").trim();
      const existingTrade = orm.trades?.findById(orderId.toLowerCase()) || orm.trades?.findById(orderId);

      if (!existingTrade) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: `Order draft '${orderId}' was not found. Orders must be previewed and drafted before authorization.`,
          rows: [],
          executedAt,
        };
      }

      if (existingTrade.status !== "previewed") {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 1,
          summary: `Order '${orderId}' cannot be executed. Current status is '${existingTrade.status.toUpperCase()}'. Only 'previewed' drafts may be authorized.`,
          rows: [{ ...existingTrade }],
          executedAt,
        };
      }

      const effectiveAuthorizer = effectiveUserDid || userDid || getUserDid(login);
      const execRes = await etrade.executeOrder(existingTrade.id, effectiveAuthorizer, "approved");

      if (execRes.success && execRes.status === "executed") {
        // Auto-dispatch visual snap receipt to Slack — only for a
        // broker-confirmed execution (issue #120 snap, #2389 honesty).
        if (env?.SLACK_WEBHOOK_URL || env?.SLACK_BOT_TOKEN) {
          try {
            const browserService = new ETradeBrowserService(env);
            browserService.sendTransactionSnapToSlack({
              transactionId: existingTrade.id,
              symbol: existingTrade.symbol,
              action: existingTrade.action,
              quantity: existingTrade.quantity,
              price: existingTrade.price,
              orderType: existingTrade.orderType,
              status: "EXECUTED",
              totalValue: existingTrade.totalValue,
              environment: (env?.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
              timestamp: executedAt,
              humanApproved: true,
            }).catch((e) => structuredLog.warn("execution.transaction_snap_dispatch_failed", {
              message: "Transaction snap dispatch to Slack failed",
              transactionId: existingTrade.id,
              error: e instanceof Error ? e.message : String(e),
            }));
          } catch {
            // Non-blocking snap dispatch
          }
        }

        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 1,
          summary: `✅ E*TRADE order ${existingTrade.id} (${existingTrade.action} ${existingTrade.quantity} ${existingTrade.symbol}) APPROVED & EXECUTED. Broker Ref: ${execRes.brokerOrderRef || execRes.executionId}. Stamped by ${effectiveAuthorizer}.`,
          rows: [
            {
              orderId: existingTrade.id,
              symbol: existingTrade.symbol,
              action: existingTrade.action,
              quantity: existingTrade.quantity,
              status: "EXECUTED",
              executionId: execRes.executionId,
              authorizerDid: effectiveAuthorizer,
              totalValue: `$${Number(existingTrade.totalValue || 0).toFixed(2)}`,
              executedAt,
            },
          ],
          executedAt,
        };
      }

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `E*TRADE order ${existingTrade.id} (${existingTrade.action} ${existingTrade.quantity} ${existingTrade.symbol}) was NOT executed. ${execRes.message} The draft remains '${existingTrade.status.toUpperCase()}'; no funds were moved.`,
        rows: [
          {
            orderId: existingTrade.id,
            symbol: existingTrade.symbol,
            action: existingTrade.action,
            quantity: existingTrade.quantity,
            status: existingTrade.status.toUpperCase(),
            authorizerDid: effectiveAuthorizer,
            totalValue: `$${Number(existingTrade.totalValue || 0).toFixed(2)}`,
            executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "preview_order") {
      const sym = (plan.tradingData?.symbol || "").trim().toUpperCase();
      if (!sym) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: "E*TRADE order preview requires a valid stock symbol (e.g. 'buy 10 shares of NVDA').",
          rows: [],
          executedAt,
        };
      }
      const qty = plan.tradingData?.quantity || 1;
      const orderAction = plan.tradingData?.orderAction || "BUY";
      const quote = await etrade.fetchQuoteRemote(sym);
      const relativeOffset = plan.tradingData?.relativePriceOffsetPercent;
      const relativeDesc = plan.tradingData?.relativePriceDescription;

      // #913/#920: a relative-priced order ("x% below market") may only be
      // priced off a LIVE E*TRADE quote. A static/simulated fallback quote
      // or a missing price refuses the order — no draft is created and no
      // static-derived price is ever substituted.
      if (relativeOffset !== undefined && (!(quote.lastPrice > 0) || isNonLivePricingQuoteStatus(quote.quoteStatus))) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: `Cannot price this relative order for ${sym}: no live E*TRADE quote is available (quote status: ${quote.quoteStatus || "UNAVAILABLE"}). Relative orders are priced only from a live E*TRADE quote — no order draft was created.`,
          rows: [],
          executedAt,
        };
      }

      let limitPrice = plan.tradingData?.limitPrice;
      let orderType = plan.tradingData?.orderType || (limitPrice !== undefined || relativeOffset !== undefined ? "LIMIT" : "MARKET");

      if (relativeOffset !== undefined && quote.lastPrice > 0) {
        orderType = "LIMIT";
        limitPrice = Number((quote.lastPrice * (1 + relativeOffset / 100)).toFixed(2));
      } else if (limitPrice !== undefined) {
        orderType = "LIMIT";
      }

      const draft = await etrade.previewOrderRemote({
        sessionId,
        symbol: sym,
        orderAction,
        quantity: qty,
        orderType,
        limitPrice,
      });

      const shareWord = draft.quantity === 1 ? "share" : "shares";
      const marketPriceStr = quote.lastPrice > 0 ? `$${quote.lastPrice.toFixed(2)}` : "Market";

      let pricingSummary = `at ~$${draft.estimatedPrice.toFixed(2)}`;
      if (draft.orderType === "LIMIT") {
        if (relativeDesc && quote.lastPrice > 0) {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)} (${relativeDesc} prevailing quote ${marketPriceStr})`;
        } else {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)}`;
        }
      }

      // Issue #118: same non-live pricing disclosure as the sync executor.
      const pricingQuoteStatus = draft.pricingQuoteStatus ?? quote.quoteStatus;
      const nonLivePricingNote = isNonLivePricingQuoteStatus(pricingQuoteStatus)
        ? ` ${nonLivePricingNotice(pricingQuoteStatus)}`
        : "";

      const summary = `E*TRADE order preview drafted for ${draft.orderAction} ${draft.quantity} ${shareWord} of ${draft.symbol} ${pricingSummary}. Total: $${draft.estimatedTotal.toFixed(2)}. Attested by ${draft.proposerDid}. Awaiting Human Authorization.${nonLivePricingNote}`;

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary,
        rows: [
          {
            orderId: draft.orderId,
            symbol: draft.symbol,
            action: draft.orderAction,
            quantity: draft.quantity,
            orderType: draft.orderType,
            limitPrice: draft.limitPrice !== undefined ? `$${draft.limitPrice.toFixed(2)}` : "N/A (Market Order)",
            prevailingMarketPrice: marketPriceStr,
            pricingQuoteStatus: pricingQuoteStatus || "UNKNOWN",
            relativePricing: relativeDesc,
            estimatedPrice: `$${draft.estimatedPrice.toFixed(2)}`,
            estimatedTotal: `$${draft.estimatedTotal.toFixed(2)}`,
            commission: `$${draft.estimatedCommission.toFixed(2)}`,
            proposerDid: draft.proposerDid,
            status: draft.status.toUpperCase(),
            safetyGuarantee: "No live trade submitted. Human approval required.",
            authorizationPrompt: `Reply 'approve ${draft.orderId}' or execute via Trading Hub.`,
          },
        ],
        executedAt,
      };
    }

    if (action === "positions") {
      const posRes = await etrade.fetchPortfolioRemote();
      const posTotal = Number(posRes.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0).toFixed(2));
      const statedCash = Number((posRes.account.cashAvailableForInvestment || 0).toFixed(2));
      const calculatedTotal = Number((posTotal + statedCash).toFixed(2));
      const statedTotal = Number((posRes.account.totalAccountValue || posRes.account.netAccountValue || calculatedTotal).toFixed(2));
      const variance = Math.abs(Number((statedTotal - calculatedTotal).toFixed(2)));
      const isReconciled = variance <= 1.00;

      if (!isReconciled) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_portfolio_live",
          count: posRes.positions.length,
          status: "RECONCILIATION_FAILED",
          reconciled: false,
          summary: `⚠️ UNVERIFIED / POSSIBLE DEMO DATA: Portfolio result cannot be reconciled ($${variance.toFixed(2)} unexplained variance between stated total $${statedTotal.toFixed(2)} and positions+cash $${calculatedTotal.toFixed(2)})—no account conclusion shown.`,
          discrepancy: {
            statedAccountTotal: `$${statedTotal.toFixed(2)}`,
            positionsMarketValue: `$${posTotal.toFixed(2)}`,
            statedCash: `$${statedCash.toFixed(2)}`,
            calculatedTotal: `$${calculatedTotal.toFixed(2)}`,
            unexplainedVariance: `$${variance.toFixed(2)}`,
          },
          provenance: {
            dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
            environment: resolveEnvironmentConfig(env).name,
            accountKey: `••••${posRes.account.accountId.slice(-4)}`,
            reconciliationStatus: "FAIL_CLOSED",
            pricesObservedAt: executedAt,
            evaluatedAt: executedAt,
          },
          rows: [],
          executedAt,
        };
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_portfolio_live",
        count: posRes.positions.length,
        status: "RECONCILED",
        reconciled: true,
        summary: `E*TRADE Account ••••${posRes.account.accountId.slice(-4)}: Reconciled Total Value $${statedTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })} (Holdings: $${posTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}, Cash: $${statedCash.toLocaleString("en-US", { minimumFractionDigits: 2 })}), Open Positions: ${posRes.positions.length}.`,
        provenance: {
          dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
          environment: resolveEnvironmentConfig(env).name,
          accountKey: `••••${posRes.account.accountId.slice(-4)}`,
          reconciliationStatus: "VERIFIED_EXACT",
          pricesObservedAt: executedAt,
          evaluatedAt: executedAt,
        },
        rows: posRes.positions.map((p) => ({
          symbol: p.symbol,
          description: p.description,
          shares: p.quantity,
          costBasis: `$${p.costBasis.toFixed(2)}`,
          lastPrice: `$${p.marketPrice.toFixed(2)}`,
          marketValue: `$${p.marketValue.toFixed(2)}`,
          unrealizedGainLoss: `${p.unrealizedGainLoss >= 0 ? "+" : ""}$${p.unrealizedGainLoss.toFixed(2)} (${p.unrealizedGainLossPercent.toFixed(2)}%)`,
        })),
        executedAt,
      };
    }

    if (action === "options_strategies" || action === "options_best_trade" || action === "options_opportunities" || action === "options_fit_discovery" || action === "options_comparison") {
      const res = await runOptionsStrategyAction(etrade, action, plan.tradingData?.filters as OptionsStrategyIntent["filters"] | undefined, {
        scanRunStore: deps?.scanRunStore,
        profileStore: deps?.profileStore,
        discoveryRunner: deps?.discoveryRunner,
        fitDiscoveryRunner: deps?.fitDiscoveryRunner,
        // Issue #3186: the panel leg's stage storage + queue - the
        // NLQ host's blob handle and the SCREENER_EVENTS binding, so
        // NLQ panel runs persist + publish like the other legs. The
        // blob get is untyped (Promise<unknown>); the cast is safe -
        // the stored value is the stage artifact the pipeline wrote.
        pipelineStorage: deps?.storage as unknown as OptionsStageStorage | undefined,
        pipelineQueue: (env as { SCREENER_EVENTS?: { send: (body: unknown) => Promise<unknown> } }).SCREENER_EVENTS ?? null,
        // Issue #4066: the host DO's raw SQLite handle for the engine
        // stores — the NLQ host's storage object IS the DO storage
        // (chatTurnHelpers threads ctx.storage), so its .sql is the
        // same handle the manual route records over. The cast is the
        // established shape (the stock door reads context.storage.sql
        // the same way); absent, the legs run in-memory and a later
        // per-stage control action refuses by name.
        engineSql: (deps?.storage as unknown as { sql?: SqlStorage } | undefined)?.sql,
        // #1257 comparison surfacing: the runner is built from the
        // session's E*TRADE client + environment + orm ledger sink.
        // The runner itself refuses without env, and reports
        // non-persistence without a ledger — never a degraded
        // quant-only run.
        comparisonRunner: createComparisonRunner({ client: etrade.client, env, ledgerSql: orm }),
        // Issue #28: profile resolution is scoped to the session's
        // login — the same fallback chain the ETradeService above uses.
        userLogin: deps?.userLogin ?? login,
      });
      return {
        plan,
        domain: "trading",
        targetTable: action === "options_best_trade" ? "etrade_options_best_trade" : action === "options_opportunities" ? "etrade_options_opportunities" : action === "options_fit_discovery" ? "etrade_options_fit_discovery" : action === "options_comparison" ? "etrade_options_comparison" : "etrade_options_strategies",
        count: res.count,
        status: res.status,
        summary: res.summary,
        validationError: res.validationError,
        quoteQuality: res.quoteQuality as NLQQueryResult["quoteQuality"],
        rejections: res.rejections as NLQQueryResult["rejections"],
        provenance: res.bestTrade ? { bestTrade: res.bestTrade } : undefined,
        // Issue #27: surface the persisted scan run id (opportunities
        // scans only; undefined everywhere else).
        scanRunId: res.scanRunId,
        // Issue #14: surface the persisted discovery run id
        // (the unified options_fit_discovery action's scope leg
        // only; undefined everywhere else).
        discoveryRunId: res.discoveryRunId,
        persisted: res.persisted,
        // Issue #28: surface the applied profile's provenance stamp.
        profileRef: res.profileRef,
        rows: res.rows,
        executedAt,
      };
    }

    if (action === "options_stage_control") {
      // Issue #4066: per-stage chat control of an options run — run /
      // re-run / stop / resume / cancel one stage by (runId, stageId)
      // on the 8-stage vocabulary, through the engine control plane.
      // The runId/stage/operation ride the plan's filters record.
      // A control refusal is a NAMED envelope (stage + reason in
      // validationError), never an absence and never a silent success.
      const controlFilters = (plan.tradingData?.filters ?? {}) as Record<string, unknown>;
      const controlRunId = typeof controlFilters.runId === "string" ? controlFilters.runId.trim() : "";
      const controlStage = typeof controlFilters.stage === "string" ? controlFilters.stage.trim() : "";
      const controlOperation = controlFilters.operation as OptionsStageControlOperation | undefined;
      const controlSql = (deps?.storage as unknown as { sql?: SqlStorage } | undefined)?.sql;
      if (!controlRunId || !controlStage || !controlOperation) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_options_stage_control",
          count: 0,
          status: "invalid_request",
          summary: "Options stage control needs a runId, a stage, and an operation (run, rerun, stop, resume, or cancel).",
          validationError: "Options stage control needs a runId, a stage, and an operation (run, rerun, stop, resume, or cancel).",
          rows: [],
          executedAt,
        };
      }
      if (!controlSql) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_options_stage_control",
          count: 0,
          status: "invalid_request",
          summary: `Options run ${controlRunId}: the stage-control action cannot access SQLite in this turn, so no engine record can be addressed.`,
          validationError: `Options run ${controlRunId}: the stage-control action cannot access SQLite in this turn, so no engine record can be addressed.`,
          rows: [],
          executedAt,
        };
      }
      try {
        const controlResult = await controlOptionsStage({
          sql: controlSql,
          ...(deps?.storage
            ? { storage: deps.storage as unknown as OptionsStageStorage | undefined }
            : {}),
          env,
          runId: controlRunId,
          stage: controlStage,
          operation: controlOperation,
          userLogin: deps?.userLogin ?? login,
          etradeClient: etrade.client,
        });
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_options_stage_control",
          count: 1,
          status: "success",
          summary: `Options run ${controlRunId}: stage ${controlResult.stage} ${controlResult.operation} — ${controlResult.state}.`,
          rows: [
            {
              runId: controlResult.runId,
              jobId: controlResult.jobId,
              stage: controlResult.stage,
              operation: controlResult.operation,
              state: controlResult.state,
              requestShape: controlResult.requestShape,
              stageUnits: controlResult.stageUnits,
            },
          ],
          executedAt,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_options_stage_control",
          count: 0,
          status: "invalid_request",
          summary: `Options run ${controlRunId}: stage ${controlStage} ${controlOperation} refused — ${reason}`,
          validationError: reason,
          rows: [],
          executedAt,
        };
      }
    }

    if (action === "options_screen") {
      const rawFilters = plan.tradingData?.filters || {};
      const hasUniverse = (rawFilters.underlyingSymbols?.length ?? 0) > 0 || rawFilters.maxUnderlyings !== undefined;
      // Broad screens without an explicit universe get a visible, capped discovery limit so a
      // live scan never fans out over every U.S. listing (sanitize clamps it to MAX_SCAN_SYMBOLS).
      const DEFAULT_BROAD_SCAN_UNDERLYINGS = 10;
      const filters = hasUniverse ? rawFilters : { ...rawFilters, maxUnderlyings: DEFAULT_BROAD_SCAN_UNDERLYINGS };
      // Issue #959: the effective filter validates through the ONE
      // shared options-filter schema before the engine sees it — a
      // mis-shaped plan filter is an explicit error naming the field,
      // not a silent engine sanitization.
      const parsedFilters = parseOptionScreenerFilter(filters);
      if (!parsedFilters.ok) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_options_screener",
          count: 0,
          status: "error",
          summary: `Options Screener: ${parsedFilters.error}`,
          rows: [],
          executedAt,
        };
      }
      // Issue #982: the screen executes through UnifiedOptionsService
      // (the REST unified route's service) — the service's data for
      // the screen action is the raw screen result the envelope below
      // is built from. The caller's symbols/limit ride the request so
      // the service's screen filter matches the validated filter
      // exactly. The canonical run copy is persisted at this layer,
      // mirroring the REST options-screen route.
      const service = nlqUnifiedOptionsService(orm, env, login);
      const serviceResponse = await service.execute({
        action: "screen",
        channel: "chat",
        filter: parsedFilters.value,
        symbols: parsedFilters.value.underlyingSymbols,
        limit: parsedFilters.value.limit,
      });
      const res = serviceResponse.data as OptionScreenResult;
      persistNlqOptionsScreenReport(orm, login, parsedFilters.value, res, executedAt, env);
      const freshnessNote = res.quoteQuality?.staleContractsReturned || res.quoteQuality?.unknownFreshnessContracts
        ? ` Freshness: ${res.quoteQuality.staleContractsReturned} returned contracts are stale and ${res.quoteQuality.unknownFreshnessContracts} have unknown timestamps; freshest stale quote was ${Math.round(res.quoteQuality.freshestStaleQuoteAgeSeconds || 0)}s old (freshness reference ${res.quoteQuality.referenceAgeSeconds ?? res.quoteQuality.maxAgeSeconds ?? 60}s).`
        : "";
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_options_screener",
        count: res.contracts.length,
        status: res.status,
        summary: res.status === "error" && res.validationError
          ? `Options Screener: ${res.validationError}`
          : `Options Screener: [Evaluated ${res.totalContractsEvaluated} contracts across ${res.totalUnderlyingsScanned} symbols; ${res.contracts.length} matched criteria${typeof res.totalMatches === "number" && res.totalMatches > res.contracts.length ? ` (${res.totalMatches} total matches before limit)` : ""}] (${res.filterSummary}).${freshnessNote}`,
        validationError: res.validationError,
        quoteQuality: res.quoteQuality,
        rejections: (res.rejections || []).slice(0, 15),
        ...(res.fetchErrors && res.fetchErrors.length > 0 ? { fetchErrors: res.fetchErrors } : {}),
        ...(res.warnings && res.warnings.length > 0 ? { warnings: res.warnings } : {}),
        rows: res.contracts.map((c) => ({
          contractSymbol: c.osiKey || c.symbol,
          underlying: c.underlyingSymbol,
          underlyingPrice: `$${c.underlyingPrice.toFixed(2)}`,
          type: c.optionType,
          strike: `$${c.strikePrice.toFixed(2)}`,
          bidAsk: `$${c.bid.toFixed(2)} / $${c.ask.toFixed(2)}`,
          spreadPercent: `${c.spreadPct.toFixed(2)}%`,
          quoteAgeSeconds: c.quoteAgeSeconds !== undefined ? `${c.quoteAgeSeconds.toFixed(1)}s` : "N/A",
          quoteFreshness: c.quoteFreshness || "UNKNOWN",
          delta: c.delta !== undefined ? c.delta.toFixed(2) : "N/A",
          iv: c.impliedVolatility !== undefined ? `${(c.impliedVolatility * 100).toFixed(1)}%` : "N/A",
          volume: (c.volume || 0).toLocaleString(),
          openInterest: (c.openInterest || 0).toLocaleString(),
          volOiRatio: c.volumeOiRatio !== undefined ? `${c.volumeOiRatio.toFixed(2)}x` : "N/A",
          dte: `${c.daysToExpiration}d (${c.expirationDate})`,
          moneyness: c.moneyness,
          technicalSignal: c.technicalSignal,
        })),
        executedAt,
      };
    }

    if (action === "options_flow") {
      const sym = plan.tradingData?.symbol;
      const flows = await getDynamicLiveFlowItems(env, { tickers: sym ? [sym] : undefined });
      const filtered = flows.filter((f) => {
        if (plan.tradingData?.filters?.bullishOnly && f.sentiment !== "bullish") return false;
        if (plan.tradingData?.filters?.bearishOnly && f.sentiment !== "bearish") return false;
        if (plan.tradingData?.filters?.sweepsOnly && f.type !== "SWEEP") return false;
        if (plan.tradingData?.filters?.unusualOnly && !f.volOverOi) return false;
        return true;
      });

      return {
        plan,
        domain: "trading",
        targetTable: "options_flows",
        count: filtered.length,
        summary: sym
          ? `Options Flow: Found ${filtered.length} modelled flow estimates for ${sym} (${describeFlowProvenance(filtered)}). This product has no live options trade tape, so these are not real-time executed prints.`
          : `Options Flow: Found ${filtered.length} modelled flow estimates across the market universe (${describeFlowProvenance(filtered)}). This product has no live options trade tape, so these are not real-time executed prints.`,
        rows: filtered.slice(0, plan.limit || 25).map((f) => ({
          time: f.time,
          provenance: f.provenance,
          symbol: f.symbol,
          underlyingPrice: `$${f.underlyingPrice.toFixed(2)}`,
          strategy: f.strategy,
          type: f.type,
          side: f.side,
          sentiment: f.sentiment.toUpperCase(),
          premium: f.premiumFormatted,
          volume: f.volume.toLocaleString(),
          openInterest: f.openInterest.toLocaleString(),
          volOverOi: f.volOverOi ? "YES" : "NO",
          dte: `${f.dte}d`,
          reasoning: f.sentimentReasoning,
        })),
        executedAt,
      };
    }

    if (action === "watchlist_save") {
      const name = plan.tradingData?.watchlistName || "My Watchlist";
      let symbols = plan.tradingData?.symbols || [];
      if (symbols.length === 0) {
        // Issue #982: the fallback screen routes through the stock
        // screening service when the port is threaded (the standout
        // opportunities of the service run are its screened picks);
        // contexts without a port keep the listings screener.
        if (deps?.stockScreenPort) {
          const run = await deps.stockScreenPort.runScreen({
            filters: plan.tradingData?.filters ?? {},
            userLogin: login,
          });
          symbols = run.opportunities.map((o) => o.symbol).slice(0, 10);
        } else {
          const screened = await etrade.screenMarketsAsync(plan.tradingData?.filters);
          symbols = screened.stocks.slice(0, 10).map((s) => s.symbol);
        }
      }
      if (symbols.length === 0) {
        symbols = ["NVDA", "AAPL", "MSFT", "AMD"];
      }

      const res = await etrade.saveScanAsWatchlist(name, symbols);
      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: res.symbolCount,
        summary: res.message,
        rows: [
          {
            watchlistId: res.watchlistId,
            name: res.name,
            symbolCount: res.symbolCount,
            symbols: res.symbols.join(", "),
            source: res.source === "etrade_api" ? "E*TRADE Live API" : "Local Durable SQLite",
            status: "SAVED",
            timestamp: res.timestamp,
          },
        ],
        executedAt,
      };
    }

    if (action === "watchlist_list") {
      const all = await etrade.getWatchlists();
      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: all.length,
        summary: `Found ${all.length} saved watchlist(s) across E*TRADE and local storage.`,
        rows: all.map((w) => ({
          watchlistId: w.watchlistId,
          name: w.name,
          symbolCount: w.symbols.length,
          symbols: w.symbols.join(", "),
          source: w.source || "etrade_api",
        })),
        executedAt,
      };
    }
  }

  if (plan.domain === "agentic_payments") {
    const action = plan.agenticPaymentsData?.action || "wallet_status";

    if (action === "paid_scan") {
      // Issue #1185: a paid action requires the verified payer/session
      // login — never the session id or a synthetic identity.
      const login = userLogin;
      if (!login) {
        return {
          plan,
          domain: "agentic_payments",
          targetTable: "agentic_payments",
          count: 0,
          status: "error",
          summary: "Paid options scan: a verified payer identity is required for this action. Nothing was executed or recorded.",
          rows: [],
          executedAt,
        };
      }
      // Issue #2396 (G3): with identity established, the paid action
      // itself is refused — this executor cannot collect or verify the
      // x402 payment the tier requires (see nlqPaidActionRefusal). The
      // scan no longer runs unpaid and no simulated receipt is minted
      // or recorded.
      return nlqPaidActionRefusal(plan, "Paid Options Screener", TRADING_PAID_SERVICES.OPTIONS_SCREENER, executedAt, env?.X402_NETWORK);
    }

    if (action === "paid_research") {
      // Issue #1185 / #183: the receipt's payer is the verified session
      // login only. Without one the paid action is refused — a payment
      // is never attributed to the session id or a synthetic identity.
      if (!userLogin) {
        return {
          plan,
          domain: "agentic_payments",
          targetTable: "agentic_payments",
          count: 0,
          status: "error",
          summary: "Paid Market Research: a verified payer identity is required for this action. Nothing was executed or recorded.",
          rows: [],
          executedAt,
        };
      }
      // Issue #2396 (G3): same disposition as paid_scan — the paid
      // action is refused because no verified x402 payment can be
      // collected on this path (see nlqPaidActionRefusal). The report
      // no longer generates unpaid and no simulated receipt is minted
      // or recorded.
      return nlqPaidActionRefusal(plan, "Paid Market Research", TRADING_PAID_SERVICES.MARKET_RESEARCH, executedAt, env?.X402_NETWORK);
    }
  }

  if (plan.domain === "scheduling") {
    // Issue #109: real Agent schedules via the injected port (see
    // executeSchedulingAction). Handled here, never by the sync
    // executor, which can only refuse honestly.
    // Issue #1185: schedules are owned by the threaded authenticated
    // login — without it the action fails closed.
    if (!loginStr) {
      return {
        plan,
        domain: "scheduling",
        targetTable: "cf_agent_schedules",
        count: 0,
        status: "error",
        summary: "Scheduling: an authenticated user identity is required for this action. Nothing was created, cancelled, or listed.",
        rows: [],
        executedAt,
      };
    }
    return executeSchedulingAction(
      orm,
      sessionId,
      plan,
      deps?.schedulingPort,
      loginStr,
      executedAt,
      // Issue #3122 — the capability routes NLQ schedule actions through
      // PDP + classification + approval + ledger when bound (orchestrator);
      // without it the executor still enforces the F1 allow-list.
      deps?.agentScheduleCapability,
      resolveIaaaTenant(env),
    );
  }

  if (plan.domain === "social") {
    // #1077 Phase 5b slice 2: NLQ brief provisioning. The plan's text
    // is user-provided content, never agent-invented: the executor
    // writes exactly what the plan carries, and only through the
    // injected port. No port (MCP facade, Slack, async jobs, the
    // webhook-forwarded route) means an honest error, never a write
    // through a fallback store. The summary names the date only —
    // the brief text itself is not echoed into result envelopes
    // (they are audited and, on the webhook path, emailed).
    const text = plan.socialData?.text ?? "";
    if (!text.trim()) {
      return {
        plan,
        domain: "social",
        count: 0,
        status: "error",
        summary: "Social brief: no content was provided, so nothing was stored.",
        rows: [],
        executedAt,
      };
    }
    if (text.length > SOCIAL_BRIEF_MAX_CHARS) {
      return {
        plan,
        domain: "social",
        count: 0,
        status: "error",
        summary: `Social brief: text must be ${SOCIAL_BRIEF_MAX_CHARS} characters or fewer; nothing was stored.`,
        rows: [],
        executedAt,
      };
    }
    if (!deps?.socialBriefPort) {
      return {
        plan,
        domain: "social",
        count: 0,
        status: "error",
        summary: "Social brief: this action requires the asynchronous NLQ executor with a live social brief port. Nothing was stored.",
        rows: [],
        executedAt,
      };
    }
    const date = resolveBriefDate(
      Date.now(),
      "America/New_York",
      plan.socialData?.dayOffset === 1 ? 1 : 0,
    );
    try {
      await deps.socialBriefPort.setBrief({ date, text });
    } catch (err) {
      return {
        plan,
        domain: "social",
        count: 0,
        status: "error",
        summary: `Social brief: the brief store failed (${err instanceof Error ? err.message : "unknown error"}); nothing was stored.`,
        rows: [],
        executedAt,
      };
    }
    return {
      plan,
      domain: "social",
      count: 1,
      summary: `Social brief set for ${date}.`,
      rows: [],
      executedAt,
    };
  }

  // #2345: category_mutation is served HERE, not by the sync
  // fall-through — categories live behind the async
  // marketplace ports (D1 when AGENT_DB is bound, the
  // instance's own table when not).
  if (plan.domain === "category_mutation") {
    const catName = plan.categoryData?.name || plan.terms || "New Category";
    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const now = new Date().toISOString();
    const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;
    const mp = await orm.marketplacePorts(env ?? {});
    const created = await mp.categories.create({
      id,
      name: catName,
      slug,
      description: plan.categoryData?.description || `Category for ${catName} referrals`,
      icon: plan.categoryData?.icon || "🏷️",
      isActive: true,
      sortOrder: ((await mp.categories.count()) || 0) + 1,
      createdAt: now,
      updatedAt: now,
    });
    const allCategories = await mp.categories.findMany({ orderBy: "sort_order ASC" });
    return {
      plan,
      domain: "category_mutation",
      targetTable: "mas_categories",
      count: allCategories.length,
      summary: `Category "${created.name}" created successfully via ORM. Total active categories: ${allCategories.length}.`,
      rows: allCategories.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        slug: c.slug,
        description: c.description,
        status: c.isActive ? "ACTIVE" : "INACTIVE",
        sortOrder: c.sortOrder,
      })),
      executedAt,
    };
  }

  return executeNLQQueryCore(orm, sessionId, plan, env, effectiveUserDid);
}

/**
 * Issue #257 (Assessment P1, part of #143): the exported asynchronous NLQ
 * execution entry. Same contract as the original; records one mas_events
 * audit row per execution. The fall-through inside the core calls
 * executeNLQQueryCore directly, so an execution is audited exactly once.
 */
export async function executeNLQQueryAsync(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  env?: Env,
  userLogin?: string,
  userDid?: string,
  deps?: NLQExecutionDeps
): Promise<NLQQueryResult> {
  const startedAt = Date.now();
  try {
    const result = await executeNLQQueryAsyncCore(orm, sessionId, plan, env, userLogin, userDid, deps);
    auditNlqExecution(orm, sessionId, plan, result, Date.now() - startedAt);
    return result;
  } catch (err) {
    auditNlqExecution(orm, sessionId, plan, null, Date.now() - startedAt, err);
    throw err;
  }
}

export async function executeNaturalLanguageQuery(
  orm: DatabaseORM,
  sessionId: string,
  query: string,
  env: Env,
  userLoginOrOptions?: string | { context?: string; validateWithLLM?: boolean; untrustedContent?: boolean },
  userDid?: string,
  options?: { context?: string; validateWithLLM?: boolean; untrustedContent?: boolean; scanRunStore?: ScanRunStore; profileStore?: StrategyProfileStore; schedulingPort?: NLQSchedulingPort; agentScheduleCapability?: NLQExecutionDeps["agentScheduleCapability"]; stockScreenPort?: NLQStockScreenPort; socialBriefPort?: NLQSocialBriefPort; discoveryRunner?: NLQExecutionDeps["discoveryRunner"]; fitDiscoveryRunner?: NLQExecutionDeps["fitDiscoveryRunner"]; storage?: NLQExecutionDeps["storage"] }
): Promise<{ plan: NLQPlan; result: NLQQueryResult }> {
  let userLogin: string | undefined;
  let resolvedOptions = options;
  if (typeof userLoginOrOptions === "object" && userLoginOrOptions !== null) {
    resolvedOptions = userLoginOrOptions;
    userLogin = undefined;
  } else {
    userLogin = userLoginOrOptions;
  }

  const plan = await planNLQ(env, query, { context: resolvedOptions?.context, preferLLM: resolvedOptions?.validateWithLLM, untrustedContent: resolvedOptions?.untrustedContent });
  const validation = await validateNLQPlanWithLLM(env, query, plan, resolvedOptions?.context, { untrustedContent: resolvedOptions?.untrustedContent });
  const result = await executeNLQQueryAsync(
    orm,
    sessionId,
    plan,
    env,
    userLogin,
    userDid,
    resolvedOptions?.storage || resolvedOptions?.scanRunStore || resolvedOptions?.profileStore || resolvedOptions?.schedulingPort || resolvedOptions?.agentScheduleCapability || resolvedOptions?.stockScreenPort || resolvedOptions?.socialBriefPort || resolvedOptions?.discoveryRunner || resolvedOptions?.fitDiscoveryRunner
      ? { scanRunStore: resolvedOptions?.scanRunStore, profileStore: resolvedOptions?.profileStore, userLogin, schedulingPort: resolvedOptions?.schedulingPort, agentScheduleCapability: resolvedOptions?.agentScheduleCapability, stockScreenPort: resolvedOptions?.stockScreenPort, socialBriefPort: resolvedOptions?.socialBriefPort, discoveryRunner: resolvedOptions?.discoveryRunner, fitDiscoveryRunner: resolvedOptions?.fitDiscoveryRunner, storage: resolvedOptions?.storage }
      : undefined,
  );
  if (!result.planSource && plan.planSource) {
    result.planSource = plan.planSource;
  }
  result.llmValidation = validation;
  return { plan, result };
}
