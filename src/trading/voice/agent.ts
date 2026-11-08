/**
 * Cloudflare Voice Trading Agent for E*TRADE
 * Repurposed from Cloudflare Agents Voice SDK pattern:
 * https://developers.cloudflare.com/agents/examples/voice-agent/
 *
 * Implements:
 * - Real-time conversational voice trading desk over WebSocket and HTTP
 * - Speech-to-Text (STT) turn detection and natural language processing
 * - Text-to-Speech (TTS) with financial pronunciation tuning (tickers, currencies, percentages)
 * - Strict Human-in-the-Loop (HITL) voice order drafting and two-phase verbal confirmation
 * - Real-time market quotes, technical screening, and portfolio balance voice queries
 * - Cryptographic Agent DID attestation for all spoken order proposals
 */

import type {
  Env,
  VoiceTradingTurnRequest,
  VoiceTradingTurnResponse,
  VoiceTranscriptMessage,
  ETradeOrderDraft,
  ScreenedStockItem,
  ETradeQuote,
} from "../../types";
import { DatabaseORM, requireOrm } from "../../orm";
import { ETradeService } from "../../services/etrade";
import { executeNaturalLanguageQuery, planNLQ, type NLQSchedulingPort } from "../../agents/nlq";
import { AGENT_DIDS } from "../../agents/did";
import {
  channelPlanRefusal,
  type ChannelNlqDeps,
  type ChannelPrincipal,
} from "../channels/intake";
import {
  approvePreviewedOrder,
  cancelPreviewedOrder,
} from "../channels/approval";
import { getVoiceConfig, getTradingConstraints } from "../../config/etapiConfig";
import { brokerPresentation } from "../brokerPresentation";
import { getPlatformCapabilitiesDeskSummary } from "../../services/platformKnowledge";
import { actorGateway } from "../../services/cloudflareActorGateway";

/**
 * Normalizes speech-to-text transcript for financial and trading intents.
 * Converts spoken numbers and common company names to stock symbols.
 */
export function normalizeVoiceTradingTranscript(raw: string, env?: Env): string {
  if (!raw) return "";
  let text = raw.trim();

  // 1. Remove verbal fillers
  text = text.replace(/\b(um|uh|er|ah|like|you know|please)\b/gi, "").trim();

  // 1b. Normalize spaced-out alphanumeric characters (e.g. from speech "6 d 7 3 7 3 4 3" -> "6d737343")
  text = text.replace(/\b(?:order\s+)?((?:[a-zA-Z0-9]\s+){4,}[a-zA-Z0-9])\b/gi, (match) => {
    return match.replace(/\s+/g, "");
  });

  const voiceCfg = getVoiceConfig(env);

  // 1c. Apply phonetic speech-to-text corrections (e.g. "text talks" -> "tech stocks")
  const defaultPhonetic: Record<string, string> = {
    "text talks": "tech stocks",
    "text talk": "tech stock",
    "tech talks": "tech stocks",
    "text stocks": "tech stocks",
  };
  const phonetic = { ...defaultPhonetic, ...(voiceCfg.phoneticCorrections || {}) };
  for (const [misheard, corrected] of Object.entries(phonetic)) {
    const reg = new RegExp(`\\b${misheard}\\b`, "gi");
    text = text.replace(reg, corrected);
  }
  // Also handle trailing or isolated "talks" in financial screening context e.g. "all talks" -> "all stocks"
  text = text.replace(/\b(all|tech|top|buy|sell|screen|find)\s+talks\b/gi, "$1 stocks");

  // 2. Normalize spoken company names to canonical tickers from externalized config
  const companyToTicker = voiceCfg.companyToTicker || {};
  for (const [name, sym] of Object.entries(companyToTicker)) {
    const reg = new RegExp(`\\b${name}\\b`, "gi");
    text = text.replace(reg, sym);
  }

  // 3. Normalize spoken numbers for common trade quantities from externalized config
  const wordToNumber = voiceCfg.wordToNumber || {};
  for (const [word, num] of Object.entries(wordToNumber)) {
    const reg = new RegExp(`\\b${word}\\b`, "gi");
    text = text.replace(reg, num);
  }

  return text.replace(/\s+/g, " ").trim();
}

/**
 * Financial pronunciation optimization before Text-to-Speech synthesis.
 * Transforms symbols, percentages, and currencies so they sound fluent and natural aloud.
 */
export function tuneFinancialPronunciation(text: string): string {
  if (!text) return "";
  let out = text;

  // 1. Currency: $228.38 -> 228 dollars and 38 cents
  out = out.replace(/\$(\d+)\.(\d{2})\b/g, (_m, dollars, cents) => {
    return `${dollars} dollars and ${cents} cents`;
  });
  out = out.replace(/\$(\d+)\b/g, (_m, dollars) => {
    return `${dollars} dollars`;
  });

  // 2. Percentages: +0.51% -> up 0.51 percent, -1.25% -> down 1.25 percent
  out = out.replace(/\+([0-9.]+)%/g, "up $1 percent");
  out = out.replace(/-([0-9.]+)%/g, "down $1 percent");
  out = out.replace(/([0-9.]+)%/g, "$1 percent");

  // 3. Technical & Financial Indicators
  out = out.replace(/\bRSI\(14\)/gi, "R-S-I");
  out = out.replace(/\bRSI\b/gi, "R-S-I");
  out = out.replace(/\bMACD\b/gi, "M-A-C-D");
  out = out.replace(/\bP\/E(?:\s+ratio)?\b/gi, "P to E ratio");

  // 4. Order ID pronunciation: space out alphanumeric characters for clear speech and avoid stuttering
  out = out.replace(/\b(?:order\s+id\s+is\s+|order\s+id\s*:?\s*)?(ord_[a-zA-Z0-9_-]{4,12})\b/gi, (match, ordId) => {
    const chars = ordId.replace(/^ord_/, "").split("").join(" ");
    if (/order\s+id/i.test(match)) {
      return `Order ID is ${chars}`;
    }
    return `order ${chars}`;
  });
  // Clean up any double "order order"
  out = out.replace(/\border\s+order\b/gi, "order");

  // 5. Clean markdown tokens from spoken output
  out = out.replace(/[*_`#]/g, "");

  return out.replace(/\s+/g, " ").trim();
}

export class ETradeVoiceTradingService {
  private env: Env;
  private orm?: DatabaseORM;
  /** Issue #109: the hosting agent's scheduling port, forwarded to the
   *  NLQ executor so voice-created schedules are real. Absent in
   *  contexts with no hosting agent; scheduling turns then fail
   *  honestly instead of claiming success. */
  private schedulingPort?: NLQSchedulingPort;
  /** Issue #1262 Phase 1: the resolved channel principal (voice adopts
   *  the shared ChannelIntake contract type; behaviour unchanged — the
   *  voice principal is the session login at tier "trade"). */
  private principal?: ChannelPrincipal;

  constructor(
    envOrOrm: Env | DatabaseORM,
    ormOrEnv?: DatabaseORM | Env,
    private sessionId: string = "voice_agent_session",
    schedulingPort?: NLQSchedulingPort,
    principal?: ChannelPrincipal,
    private nlqDeps?: ChannelNlqDeps
  ) {
    this.schedulingPort = schedulingPort;
    this.principal = principal;
    if (envOrOrm instanceof DatabaseORM || (envOrOrm && ("initializeSchema" in (envOrOrm as any) || "watchlists" in (envOrOrm as any)))) {
      this.orm = envOrOrm as DatabaseORM;
      this.env = ormOrEnv as Env;
    } else {
      this.env = envOrOrm as Env;
      this.orm = ormOrEnv as DatabaseORM | undefined;
    }
  }

  /**
   * Process a conversational voice trading turn
   */
  async processVoiceTurn(request: VoiceTradingTurnRequest): Promise<VoiceTradingTurnResponse> {
    const rawTranscript = (request.transcript || request.rawTranscript || "").trim();
    const cleanTranscript = normalizeVoiceTradingTranscript(rawTranscript, this.env);
    const timestamp = new Date().toISOString();
    const userLogin = request.userLogin || this.sessionId;
    const authorizerDid = this.principal?.authorizerDid ?? `did:user:voice:${userLogin}`;
    // Issue #815: env-preserving construction (the pattern #781's
    // pass-through sites adopted). ETradeService's orm-first overload
    // assigns env from its first argument, so an undefined ORM would
    // silently drop the caller's env for the approval/rejection paths
    // that run before handleVoiceNLQ's requireOrm gate.
    const tradingService = this.orm
      ? new ETradeService(this.orm, this.env, this.sessionId)
      : new ETradeService(this.env, undefined, this.sessionId);

    // 0. Conversational Open-Ended Single-Word Prompt (e.g. "Find", "Search", "Help", "Explore")
    if (/^(find|search|help|lookup|show me|explore|menu)$/i.test(cleanTranscript.trim())) {
      const caps = getPlatformCapabilitiesDeskSummary();
      const spokenText = tuneFinancialPronunciation(caps.spokenSummary);
      return {
        success: true,
        spokenText,
        displayMarkdown: caps.markdownOverview,
        actionType: "capabilities",
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }

    // -----------------------------------------------------------------------
    // 1. Detect Voice Approval Intent: "Confirm execution of order <id>" or "Approve order"
    // -----------------------------------------------------------------------
    const approveMatch = cleanTranscript.match(/\b(CONFIRM|APPROVE|EXECUTE|SUBMIT)\b(?:\s+(?:THE\s+)?(?:EXECUTION\s+(?:OF\s+)?)?(?:ORDER|TRADE))?(?:\s+(ord_[a-zA-Z0-9_-]+|[a-zA-Z0-9]{6,}))?/i);
    if (approveMatch) {
      // Issue #3720: a Stock Copilot voice turn carries the copilot's
      // server-resolved broker. The desk's execution arm is E*TRADE
      // (the approval executor below), so an approval under any other
      // resolved broker refuses BY NAME before anything executes —
      // the #3429 invariant, kept at the execution leg for a turn the
      // activation serves. Executing on the selected broker is the
      // neutral desk's build (#3556); the refusal names the way.
      if (request.copilotBrokerId && request.copilotBrokerId !== "etrade") {
        const label = brokerPresentation(request.copilotBrokerId).label;
        const spokenText = tuneFinancialPronunciation(
          `I can't execute that order by voice. Your selected broker is ${label}, and the voice desk executes orders on E*TRADE only — nothing was executed. Use the Trading Hub or the neutral order API for ${label}.`
        );
        return {
          success: false,
          spokenText,
          displayMarkdown: `⚠️ **Voice Execution Refused**: your selected broker is ${label}; the voice desk executes orders on E*TRADE only. Nothing was executed. Use the Trading Hub or the neutral order API (\`/api/broker/order/execute\`) for ${label}.`,
          actionType: "error",
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          timestamp,
        };
      }
      const rawId = approveMatch[2];
      const explicitId = rawId ? (rawId.startsWith("ord_") ? rawId : `ord_${rawId}`) : undefined;
      return this.handleVoiceApproval(explicitId, authorizerDid, tradingService, timestamp);
    }

    // -----------------------------------------------------------------------
    // 2. Detect Voice Rejection Intent: "Cancel order <id>" or "Discard draft"
    // -----------------------------------------------------------------------
    const isScheduleIntent = /\b(schedule|timer|reminder|task)\b/i.test(cleanTranscript);
    const rejectMatch = !isScheduleIntent && cleanTranscript.match(
      /\b(CANCEL|DISCARD|REJECT|ABORT|STOP)\b(?:\s+(?:THE\s+)?(?:ORDER|TRADE|DRAFT))?(?:\s+(ord_[a-zA-Z0-9_-]+|[a-zA-Z0-9]{6,}))?/i
    );
    if (rejectMatch) {
      const rawId = rejectMatch[2];
      const explicitId = rawId ? (rawId.startsWith("ord_") ? rawId : `ord_${rawId}`) : undefined;
      return this.handleVoiceRejection(explicitId, authorizerDid, timestamp);
    }

    // -----------------------------------------------------------------------
    // 3. Process Market Data, Screener, Portfolio, or Order Preview via NLQ Engine
    // -----------------------------------------------------------------------
    return this.handleVoiceNLQ(cleanTranscript, rawTranscript, authorizerDid, tradingService, timestamp);
  }

  /**
   * Handle verbal order authorization with HITL safety gate
   */
  private async handleVoiceApproval(
    specifiedOrderId: string | undefined,
    authorizerDid: string,
    tradingService: ETradeService,
    timestamp: string
  ): Promise<VoiceTradingTurnResponse> {
    // Issue #1262 Phase 3: approval runs through the shared engine
    // (trade-tier gate + draft lookup + execute/fallback). Voice
    // principals are session logins at trade tier, so the gate passes
    // exactly as before; the spoken rendering below is unchanged.
    const outcome = await approvePreviewedOrder({
      trades: this.orm?.trades ?? null,
      executor: tradingService,
      principal: this.principal,
      authorizerDid,
      userLogin: this.sessionId,
      orderId: specifiedOrderId,
      timestamp,
    });
    if (outcome.kind === "tier_refused") {
      return {
        success: false,
        spokenText: outcome.reason,
        displayMarkdown: `⚠️ **Voice Approval Refused**: ${outcome.reason}`,
        actionType: "approval",
        orderId: specifiedOrderId,
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }
    if (outcome.kind === "not_found" || outcome.kind === "not_previewed") {
      const spoken = "I could not find an active pending order preview awaiting authorization. Any previous orders may have already been executed or cancelled.";
      return {
        success: false,
        spokenText: spoken,
        displayMarkdown: `⚠️ **Voice Approval Failed**: No pending order preview found awaiting authorization.`,
        actionType: "approval",
        orderId: specifiedOrderId,
        orderStatus: "not_found",
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }

    const targetTrade = outcome.trade;
    const isSuccess = outcome.kind === "executed";
    const execId = outcome.execId ?? `et_order_${Date.now()}`;
    const execMessage = outcome.kind === "failed" ? outcome.message : undefined;

    const spokenText = isSuccess
      ? tuneFinancialPronunciation(
          `Order ${targetTrade.id} has been successfully executed on E*TRADE. Broker reference is ${execId}. Your trade to ${targetTrade.action} ${targetTrade.quantity} shares of ${targetTrade.symbol} has been placed.`
        )
      : `E*TRADE order execution failed. The broker returned: ${execMessage || "Unknown rejection"}. No capital was moved.`;

    const displayMarkdown = isSuccess
      ? `### ✅ Order Executed on E*TRADE\n\n- **Order ID:** \`${targetTrade.id}\`\n- **Action:** ${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}\n- **Broker Ref:** \`${execId}\`\n- **Total Settled:** $${targetTrade.totalValue.toFixed(2)} USD\n- **Authorizer DID:** \`${authorizerDid}\`\n- **Timestamp:** ${timestamp}`
      : `### ❌ Order Execution Failed\n\n${execMessage || "Upstream broker rejected execution."}`;

    return {
      success: isSuccess,
      spokenText,
      displayMarkdown,
      actionType: "approval",
      orderId: targetTrade.id,
      orderStatus: isSuccess ? "executed" : "rejected",
      brokerOrderRef: execId,
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
      timestamp,
    };
  }

  /**
   * Handle verbal order cancellation
   */
  private async handleVoiceRejection(
    specifiedOrderId: string | undefined,
    authorizerDid: string,
    timestamp: string
  ): Promise<VoiceTradingTurnResponse> {
    // Issue #1262 Phase 3: cancellation runs through the shared
    // engine (preview-tier gate + previewed-only update). The spoken
    // rendering below is unchanged.
    const outcome = cancelPreviewedOrder({
      trades: this.orm?.trades ?? null,
      principal: this.principal,
      orderId: specifiedOrderId,
      lookup: "previewed_only",
      timestamp,
    });
    if (outcome.kind === "tier_refused") {
      return {
        success: false,
        spokenText: outcome.reason,
        displayMarkdown: `⚠️ **Voice Cancellation Refused**: ${outcome.reason}`,
        actionType: "rejection",
        orderId: specifiedOrderId,
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        timestamp,
      };
    }
    const targetTrade =
      outcome.kind === "cancelled" || outcome.kind === "not_previewed" ? outcome.trade ?? null : null;

    const orderId = targetTrade?.id || specifiedOrderId || "draft";
    const spokenText = tuneFinancialPronunciation(
      `Order ${orderId} has been cancelled. The draft was discarded and no funds or equities were moved.`
    );
    const displayMarkdown = `### ✕ Order Draft Cancelled\n\nOrder draft \`${orderId}\` has been discarded safely. No capital moved.`;

    return {
      success: true,
      spokenText,
      displayMarkdown,
      actionType: "rejection",
      orderId: targetTrade?.id || specifiedOrderId,
      orderStatus: "rejected",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
      timestamp,
    };
  }

  /**
   * Handle conversational natural language query via NLQ engine
   */
  private async handleVoiceNLQ(
    cleanTranscript: string,
    rawTranscript: string,
    authorizerDid: string,
    tradingService: ETradeService,
    timestamp: string
  ): Promise<VoiceTradingTurnResponse> {
    try {
      // Issue #781: NLQ execution reads and writes through the ORM
      // (watchlists, trade ledger, messages). Without an injected ORM,
      // fail loud — the throw is caught below and returned as an honest
      // spoken error. The former stub fallback computed answers against
      // an empty ledger and discarded every write.
      const orm = requireOrm(this.orm, "ETradeVoiceTradingService.handleVoiceNLQ");
      // Issue #1262 Phase 4: the channel seam gate (paid actions refused
      // for every tier in v1, tier-gated trading actions refused before
      // anything executes) — voice was the one channel seam missing the
      // peek gate — and the NLQ call itself is untrusted inbound
      // content (#880) with the full web-chat deps.
      if (this.principal) {
        const peek = await planNLQ(this.env, cleanTranscript, { untrustedContent: true });
        const refusal = channelPlanRefusal(peek, this.principal);
        if (refusal) {
          return {
            success: false,
            spokenText: refusal,
            displayMarkdown: `⚠️ **Voice Request Refused**: ${refusal}`,
            actionType: "error",
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }
      }
      const { plan, result: nlqRes } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        cleanTranscript,
        this.env,
        this.sessionId,
        authorizerDid,
        {
          untrustedContent: true,
          ...this.nlqDeps,
          schedulingPort: this.nlqDeps?.schedulingPort ?? this.schedulingPort,
        },
      );

      const domain = plan.domain;
      const action = plan.tradingData?.action || "query";

      if (domain === "trading" && action === "capabilities") {
        const caps = getPlatformCapabilitiesDeskSummary();
        const spokenText = tuneFinancialPronunciation(caps.spokenSummary);
        return {
          success: true,
          spokenText,
          displayMarkdown: caps.markdownOverview,
          actionType: "capabilities",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      if (domain === "research") {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        const topResults = rows.slice(0, 3).map((row) => {
          const symbol = String(row.symbol || row.company || row.companyName || "Research result");
          const price = row.currentPrice || row.price || row.lastPrice;
          const rating = row.analystRating || row.recommendation || row.recommendationKey;
          return `${symbol}${price ? ` at ${price}` : ""}${rating ? `, rating ${rating}` : ""}`;
        }).join("; ");
        const spokenText = tuneFinancialPronunciation(
          `${nlqRes.summary || "Market research completed."}${topResults ? ` Key results: ${topResults}.` : ""}`
        );
        const details = rows.slice(0, 10).map((row) =>
          `| ${String(row.symbol || row.company || row.companyName || "Research result")} | ${String(row.currentPrice || row.price || row.lastPrice || "—")} | ${String(row.analystRating || row.recommendation || row.recommendationKey || "—")} |`
        ).join("\n");
        return {
          success: true,
          spokenText,
          displayMarkdown: `### Market Research Results\n\n${nlqRes.summary || "Market research completed."}\n\n` +
            (details ? `| Symbol / Company | Price | Rating |\n|---|---:|---|\n${details}` : ""),
          actionType: "general",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      if (domain === "trading" && ["options_screen", "options_strategies", "options_best_trade", "options_opportunities"].includes(action)) {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        if (action === "options_screen") {
          const spokenRaw = `I screened ${nlqRes.count} option contracts. ${nlqRes.summary || ""} No orders were placed.`;
          const tableRows = rows.slice(0, 10).map((row) =>
            `| ${String(row.contractSymbol || row.symbol || "Contract")} | ${String(row.optionType || row.type || "—")} | ${String(row.strike ?? "—")} | ${String(row.expiration || row.expirationDate || "—")} | ${String(row.delta ?? "—")} |`
          ).join("\n");
          return {
            success: true,
            spokenText: tuneFinancialPronunciation(spokenRaw),
            displayMarkdown: `### E*TRADE Options Screener (${nlqRes.count} Contracts)\n\n${nlqRes.summary || "Options screen completed."}\n\n` +
              (tableRows ? `| Contract | Type | Strike | Expiration | Delta |\n|---|---|---:|---|---:|\n${tableRows}` : ""),
            actionType: "options_screener",
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }
        const topResults = rows.slice(0, 3).map((row, index) => {
          const label = String(row.label || row.strategy || row.contractSymbol || row.symbol || `result ${index + 1}`);
          const score = row.score ?? row.compositeScore;
          return `${label}${score !== undefined ? `, score ${score}` : ""}`;
        }).join("; ");
        const spokenRaw = `${nlqRes.summary || "Options research completed."}${topResults ? ` Top results: ${topResults}.` : ""} This is research only; no orders were placed.`;
        const spokenText = tuneFinancialPronunciation(spokenRaw);
        const displayRows = rows.slice(0, 10).map((row) =>
          `| ${String(row.label || row.strategy || row.contractSymbol || row.symbol || "Result")} | ${String(row.rank ?? "—")} | ${String(row.score ?? row.compositeScore ?? "—")} | ${String(row.reason || row.summary || row.status || "—")} |`
        ).join("\n");
        const displayMarkdown = `### Options Research Results\n\n${nlqRes.summary || "Options research completed."}\n\n` +
          (displayRows ? `| Strategy / Contract | Rank | Score | Reason |\n|---|---:|---:|---|\n${displayRows}\n\n` : "") +
          `> Research only — no orders were placed.`;
        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "options_research",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case A: Real-Time Stock Quote
      if (domain === "trading" && action === "quote") {
        const q: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const sym = q.symbol || "EQUITY";
        const company = q.company || "";
        const price = String(q.lastPrice || "$0.00");
        const change = String(q.change || "0.00%");
        const bidAsk = q.bidAsk || "N/A";
        const volume = q.volume || "N/A";
        const range52 = q.range52Week || "N/A";

        const spokenRaw = `${company || sym} is trading at ${price}, ${change} today. Bid is ${bidAsk.split("/")[0]?.trim() || "N/A"} and ask is ${bidAsk.split("/")[1]?.trim() || "N/A"}, with volume of ${volume}. Would you like to draft a trade order?`;
        const spokenText = tuneFinancialPronunciation(spokenRaw);

        const displayMarkdown = `### 📈 E*TRADE Quote: **${sym}** - ${company}\n\n- **Last Price:** **${price}** (${change})\n- **Bid / Ask:** ${bidAsk}\n- **Volume:** ${volume}\n- **52-Week Range:** ${range52}\n\n*Say "Buy 10 ${sym} at market" to draft an order.*`;

        const marketQuote: ETradeQuote = {
          symbol: sym,
          companyName: company,
          lastPrice: parseFloat(price.replace(/[^0-9.]/g, "")) || 0,
          change: parseFloat(change.replace(/[^0-9.-]/g, "")) || 0,
          changePercent: parseFloat(change.replace(/[^0-9.-]/g, "")) || 0,
          bid: parseFloat((bidAsk.split("/")[0] || "0").replace(/[^0-9.]/g, "")) || 0,
          ask: parseFloat((bidAsk.split("/")[1] || "0").replace(/[^0-9.]/g, "")) || 0,
          volume: parseInt(volume.replace(/[^0-9]/g, ""), 10) || 0,
          open: 0,
          high: 0,
          low: 0,
          week52High: 0,
          week52Low: 0,
          timestamp,
        };

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "quote",
          marketQuote,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case B: Market Screener
      if (domain === "trading" && action === "screen") {
        const stocks: any[] = nlqRes.rows || [];
        const filters = plan.tradingData?.filters || {};
        const sector = filters.sector;
        const maxRsi = filters.maxRsi;
        const minRsi = filters.minRsi;

        if (nlqRes.validationError) {
          const spokenText = tuneFinancialPronunciation(`I could not apply that stock screen. ${nlqRes.validationError}`);
          return {
            success: true,
            spokenText,
            displayMarkdown: `### Stock Screen Unavailable\n\n${nlqRes.validationError}\n\nAvailable live listing fields: ticker, company, exchange, last sale, daily change, and market capitalization.`,
            actionType: "screener",
            screenedStocks: [],
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        if (stocks.length === 0) {
          // Identify closest candidates from scan ledger or sector rejections
          const rejections = (nlqRes.scanLedger?.rejections || []) as any[];
          const sectorRejections = sector
            ? rejections.filter((r) => !r.reason?.includes("Sector"))
            : rejections;

          let closestHint = "";
          let closestSymbol = "";
          let closestRsi = 0;
          let closestPrice = 0;

          if (maxRsi !== undefined) {
            const withRsi = sectorRejections.filter((r) => r.rsi !== undefined);
            if (withRsi.length > 0) {
              withRsi.sort((a, b) => (a.rsi || 999) - (b.rsi || 999));
              const best = withRsi[0];
              closestSymbol = best.symbol;
              closestRsi = best.rsi;
              closestPrice = best.price || 0;
              closestHint = `The lowest R-S-I in that sector is ${best.symbol} at $${best.price ? best.price.toFixed(2) : "N/A"} with an R-S-I of ${best.rsi.toFixed(1)}.`;
            }
          } else if (minRsi !== undefined) {
            const withRsi = sectorRejections.filter((r) => r.rsi !== undefined);
            if (withRsi.length > 0) {
              withRsi.sort((a, b) => (b.rsi || 0) - (a.rsi || 0));
              const best = withRsi[0];
              closestSymbol = best.symbol;
              closestRsi = best.rsi;
              closestPrice = best.price || 0;
              closestHint = `The highest R-S-I in that sector is ${best.symbol} with an R-S-I of ${best.rsi.toFixed(1)}.`;
            }
          }

          let filterDesc = "";
          if (sector && maxRsi !== undefined) filterDesc = `${sector} stocks with an R-S-I under ${maxRsi}`;
          else if (sector && minRsi !== undefined) filterDesc = `${sector} stocks with an R-S-I over ${minRsi}`;
          else if (sector) filterDesc = `${sector} stocks`;
          else if (maxRsi !== undefined) filterDesc = `stocks with an R-S-I under ${maxRsi}`;
          else filterDesc = "equities matching your criteria";

          const spokenRaw = `I screened the universe, but no ${filterDesc} currently meet that threshold. ${closestHint} You can say "Screen all ${sector || "tech"} stocks", or ask for a quote on a specific symbol.`;
          const spokenText = tuneFinancialPronunciation(spokenRaw);

          const displayMarkdown = `### 🔍 E*TRADE Screener (0 Equities Matched)\n\n` +
            `> ⚠️ **No Matches Found**: No equities in the universe satisfied the criteria: **${nlqRes.summary || filterDesc}**.\n\n` +
            (closestSymbol ? `**Closest Candidate in Sector:**\n- **${closestSymbol}**: Price: $${closestPrice.toFixed(2)} | RSI(14): **${closestRsi.toFixed(1)}**\n\n` : "") +
            `*💡 Voice Desk Tips:* Say *"Screen all ${sector || "tech"} stocks"* to broaden your screen, or say *"Quote ${closestSymbol || "AAPL"}"* for full metrics.`;

          return {
            success: true,
            spokenText,
            displayMarkdown,
            actionType: "screener",
            screenedStocks: [],
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        const isMovers = filters.gainersLosers === "movers" || (Boolean(filters.gainersOnly) && Boolean(filters.losersOnly));
        if (isMovers && (stocks.length > 0 || (nlqRes.movers?.gainers?.length || 0) > 0 || (nlqRes.movers?.losers?.length || 0) > 0)) {
          const movers = nlqRes.movers;
          const gainers = (movers?.gainers && movers.gainers.length > 0)
            ? movers.gainers.slice(0, 3)
            : stocks.filter((s) => (s.changePercent ?? 0) > 0).sort((a, b) => b.changePercent - a.changePercent).slice(0, 3);
          const losers = (movers?.losers && movers.losers.length > 0)
            ? movers.losers.slice(0, 3)
            : stocks.filter((s) => (s.changePercent ?? 0) < 0).sort((a, b) => a.changePercent - b.changePercent).slice(0, 3);

          const formatPrice = (p: any) => typeof p === "number" ? `$${p.toFixed(2)}` : String(p || "N/A");
          const gainersSpoken = gainers.map((s) => `${s.symbol} at ${formatPrice(s.price)}, up ${Math.abs(s.changePercent || 0).toFixed(2)} percent`).join(", and ");
          const losersSpoken = losers.map((s) => `${s.symbol} at ${formatPrice(s.price)}, down ${Math.abs(s.changePercent || 0).toFixed(2)} percent`).join(", and ");

          let spokenRaw = "";
          if (gainers.length > 0 && losers.length > 0) {
            spokenRaw = `Here are today's top market movers across listed stocks. Top gainers include ${gainersSpoken}. Top losers include ${losersSpoken}. Say "Quote symbol" for full metrics, "Options on symbol" for strategy ideas, or specify an order to preview.`;
          } else if (gainers.length > 0) {
            spokenRaw = `Here are today's top market movers. Top gainers include ${gainersSpoken}. Say "Quote symbol" for full metrics, or specify an order to preview.`;
          } else {
            spokenRaw = `Here are today's top market movers. Top losers include ${losersSpoken}. Say "Quote symbol" for full metrics, or specify an order to preview.`;
          }
          const spokenText = tuneFinancialPronunciation(spokenRaw);

          const gainersTable = gainers.map((s) => `| **${s.symbol}** | ${s.exchange || "N/A"} | ${formatPrice(s.price)} | +${Math.abs(s.changePercent || 0).toFixed(2)}% | ${s.marketCap || "N/A"} |`).join("\n");
          const losersTable = losers.map((s) => `| **${s.symbol}** | ${s.exchange || "N/A"} | ${formatPrice(s.price)} | -${Math.abs(s.changePercent || 0).toFixed(2)}% | ${s.marketCap || "N/A"} |`).join("\n");

          const displayMarkdown = `### 📊 Market Movers: Top Gainers & Losers\n\n` +
            `#### 📈 Top Daily Gainers\n| Symbol | Exchange | Price | Daily Change | Market Cap |\n|---|---|---|---|---|\n${gainersTable || "| None | - | - | - | - |"}\n\n` +
            `#### 📉 Top Daily Losers\n| Symbol | Exchange | Price | Daily Change | Market Cap |\n|---|---|---|---|---|\n${losersTable || "| None | - | - | - | - |"}\n\n` +
            `*💡 Voice Desk Tips: Say "Quote <symbol>" for detailed metrics, "Options on <symbol>" for strategy ideas, or "Buy <qty> <symbol>" to draft an order.*`;

          return {
            success: true,
            spokenText,
            displayMarkdown,
            actionType: "screener",
            screenedStocks: stocks as ScreenedStockItem[],
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        const top = stocks.slice(0, 3);
        const topSpoken = top
          .map((s) => `${s.symbol} at ${s.price}, daily change ${s.change}`)
          .join(", and ");

        const sectorPrefix = sector ? `${sector} ` : "";
        const spokenRaw = `I screened ${stocks.length} ${sectorPrefix}listed stocks. Top results include ${topSpoken}. Say "Quote symbol" for full metrics, or specify an order to preview.`;
        const spokenText = tuneFinancialPronunciation(spokenRaw);

        const tableRows = stocks.slice(0, 5).map((stock) =>
          `| **${stock.symbol}** | ${stock.exchange || "N/A"} | ${stock.price} | ${stock.change} | ${stock.marketCap || "N/A"} |`
        ).join("\n");
        const displayMarkdown = `### 🔍 ${sectorPrefix}Market Listings (${stocks.length} Matched)\n\n| Symbol | Exchange | Price | Daily Change | Market Cap |\n|---|---|---|---|---|\n${tableRows}\n\n*Say "Quote <symbol>" for detailed quote data, or "Buy <qty> <symbol>" to draft an order.*`;

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "screener",
          screenedStocks: stocks as ScreenedStockItem[],
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case C: Order Preview Ticket (Strict HITL)
      if (domain === "trading" && action === "preview_order") {
        const row: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const orderId: string = String(row.orderId || `ord_${Date.now()}`);
        const actionStr: string = String(row.action || "BUY");
        const symbol: string = String(row.symbol || "EQUITY");
        const qty: number = Number(row.quantity) || 1;
        const total: string = String(row.estimatedTotal || "$0.00");
        const price: string = String(row.estimatedPrice || "$0.00");
        const orderType: string = String(row.orderType || plan.tradingData?.orderType || "MARKET").toUpperCase();
        const limitPriceStr: string | undefined = row.limitPrice && row.limitPrice !== "N/A (Market Order)" ? String(row.limitPrice) : undefined;
        const marketPriceStr: string | undefined = row.prevailingMarketPrice && row.prevailingMarketPrice !== "N/A" ? String(row.prevailingMarketPrice) : undefined;
        const relativeDesc: string | undefined = row.relativePricing || plan.tradingData?.relativePriceDescription;
        const constraints = getTradingConstraints(this.env);
        if (qty > constraints.maxOrderQuantity) {
          const spoken = `Order rejected by safety constraints. Requested quantity of ${qty} exceeds the maximum limit of ${constraints.maxOrderQuantity} shares.`;
          return {
            success: false,
            spokenText: tuneFinancialPronunciation(spoken),
            displayMarkdown: `⚠️ **Order Safety Limit Exceeded**: Quantity \`${qty}\` exceeds maximum allowed limit of \`${constraints.maxOrderQuantity}\`.`,
            actionType: "preview",
            orderStatus: "rejected",
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid,
            timestamp,
          };
        }

        const shareWord = qty === 1 ? "share" : "shares";

        let priceDesc = "";
        if (orderType === "LIMIT") {
          if (relativeDesc && marketPriceStr) {
            priceDesc = ` at limit price ${price} (${relativeDesc} of ${marketPriceStr})`;
          } else {
            priceDesc = ` at limit price ${price}`;
          }
        }

        const orderDescriptor = orderType === "LIMIT" ? "a LIMIT order" : "an order";
        const spokenRaw = `I have drafted ${orderDescriptor} to ${actionStr} ${qty} ${shareWord} of ${symbol}${priceDesc} for an estimated total of ${total}. Order ID is ${orderId}. Safety guarantee: no capital has been moved. Say "Confirm order ${orderId}" to execute, or say "Cancel order" to discard.`;
        const spokenText = tuneFinancialPronunciation(spokenRaw);

        const orderDraft: ETradeOrderDraft = {
          orderId,
          symbol,
          action: actionStr === "SELL" ? "SELL" : "BUY",
          orderAction: (["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"].includes(actionStr) ? actionStr : "BUY") as any,
          orderType: (orderType === "LIMIT" ? "LIMIT" : "MARKET") as any,
          limitPrice: orderType === "LIMIT" ? parseFloat(price.replace(/[^0-9.]/g, "")) || undefined : undefined,
          quantity: qty,
          estimatedPrice: parseFloat(price.replace(/[^0-9.]/g, "")) || 0,
          term: "GOOD_FOR_DAY",
          estimatedCommission: 0,
          estimatedTotal: parseFloat(total.replace(/[^0-9.]/g, "")) || 0,
          status: "previewed",
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          proofSignature: `sig_0x${Date.now()}`,
          previewMessage: spokenRaw,
          safetyNotice: "STRICT HITL ENFORCEMENT: Awaiting human verbal authorization.",
          placedAt: timestamp,
        };

        const displayMarkdown = `### 🛡️ Order Preview Awaiting Verbal Confirmation\n\n` +
          `- **Action:** **${actionStr}**\n` +
          `- **Symbol:** **${symbol}**\n` +
          `- **Order Type:** **${orderType}**\n` +
          (orderType === "LIMIT" ? `- **Limit Price:** **${price}**${relativeDesc ? ` *(${relativeDesc})*` : ""}\n` : "") +
          (marketPriceStr ? `- **Prevailing Market Price:** **${marketPriceStr}**\n` : "") +
          `- **Quantity:** **${qty} ${shareWord}**\n` +
          `- **Estimated Total:** **${total}**\n` +
          `- **Order ID:** \`${orderId}\`\n\n` +
          `> 🔒 **Human-in-the-Loop Safety Guarantee**: No funds have been moved.\n` +
          `> **To Authorize:** Say *"Confirm order ${orderId}"*\n` +
          `> **To Discard:** Say *"Cancel order ${orderId}"*`;

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "preview",
          orderId,
          orderDraft,
          orderStatus: "previewed",
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          timestamp,
        };
      }

      // Case D: Portfolio & Account Balances
      if (domain === "trading" && action === "positions") {
        const spokenRaw = `Your E*TRADE account has a reconciled net balance. Detailed holdings and purchasing power have been reconciled against live E*TRADE records.`;
        const spokenText = tuneFinancialPronunciation(spokenRaw);
        const displayMarkdown = `### 💼 E*TRADE Portfolio & Balance Summary\n\n${nlqRes.summary}\n\n*🛡️ Verified against live E*TRADE REST API feeds.*`;

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "portfolio",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case E: Task Scheduling & Durable Timers
      if (domain === "scheduling") {
        const scheduleAction = plan.scheduleData?.action || "list";
        const row: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;

        // Issue #109: the NLQ executor reports scheduling outcomes
        // truthfully against the real Agent scheduler. Never voice a
        // success the executor did not confirm.
        if (nlqRes.status === "error") {
          const spokenText = tuneFinancialPronunciation(
            nlqRes.summary || "Scheduling is unavailable right now, so nothing was scheduled."
          );
          return {
            success: false,
            spokenText,
            displayMarkdown: `### ⏰ Scheduling Unavailable\n\n${nlqRes.summary || "The scheduling action could not be completed."}`,
            actionType: "schedule",
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        if (scheduleAction === "cancel" && nlqRes.status === "not_found") {
          const schedId = String(row.scheduleId || plan.scheduleData?.scheduleId || "the task");
          const spokenText = tuneFinancialPronunciation(
            `I could not find a schedule with ID ${schedId}. It may have already fired or been cancelled, so nothing was removed. Say "Show scheduled tasks" to see the active ones.`
          );
          return {
            success: false,
            spokenText,
            displayMarkdown: `### 🛑 Schedule Not Found\n\n- **Schedule ID:** \`${schedId}\`\n- **Status:** **NOT FOUND**\n\n*No timer was removed.*`,
            actionType: "schedule",
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        if (scheduleAction === "create") {
          const schedId = String(row.id || "sched_task");
          const callback = String(row.callback || "sendScheduledReminder");
          const desc = String(row.description || "Scheduled task");
          const delaySec = Number(row.delayInSeconds) || 0;
          const intervalSec = Number(row.intervalSeconds) || 0;

          let timeDesc = "";
          if (delaySec > 0) {
            timeDesc = delaySec >= 60 ? `in ${Math.round(delaySec / 60)} minutes` : `in ${delaySec} seconds`;
          } else if (intervalSec > 0) {
            timeDesc = intervalSec >= 60 ? `every ${Math.round(intervalSec / 60)} minutes` : `every ${intervalSec} seconds`;
          }

          let spokenRaw = "";
          if (callback === "autonomousMarketScreen") {
            spokenRaw = `I have scheduled autonomous market screening ${timeDesc}. The agent will monitor equities and alert you of opportunities. Schedule ID is ${schedId}.`;
          } else {
            spokenRaw = `I have scheduled a reminder to ${desc} ${timeDesc}. Schedule ID is ${schedId}. I will alert your desk when it triggers.`;
          }
          const spokenText = tuneFinancialPronunciation(spokenRaw);

          const displayMarkdown = `### ⏰ Scheduled Task Activated\n\n` +
            `- **Task:** **${desc}**\n` +
            `- **Type:** \`${row.type || "delayed"}\`\n` +
            `- **Trigger:** **${timeDesc}**\n` +
            `- **Callback:** \`${callback}\`\n` +
            `- **Schedule ID:** \`${schedId}\`\n\n` +
            `> ⏱️ **Persistent Background Timer**: Persists across system restarts.\n` +
            `> *To Cancel:* Say *"Cancel schedule ${schedId}"*`;

          return {
            success: true,
            spokenText,
            displayMarkdown,
            actionType: "schedule",
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        if (scheduleAction === "cancel") {
          const schedId = String(row.scheduleId || "the task");
          const spokenRaw = `Task schedule ${schedId} has been cancelled successfully.`;
          const spokenText = tuneFinancialPronunciation(spokenRaw);

          const displayMarkdown = `### 🛑 Task Schedule Cancelled\n\n` +
            `- **Schedule ID:** \`${schedId}\`\n` +
            `- **Status:** **CANCELLED**\n\n` +
            `*The timer has been removed from active background queues.*`;

          return {
            success: true,
            spokenText,
            displayMarkdown,
            actionType: "schedule",
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        // Listing schedules
        const total = nlqRes.count || (nlqRes.rows?.length ?? 0);
        const rows = nlqRes.rows || [];
        const taskDescriptions = rows.slice(0, 3).map((r: any) => `${r.description || r.callback} (${r.status})`).join(", and ");
        const spokenRaw = total > 0
          ? `You have ${total} active scheduled tasks, including ${taskDescriptions}. Say "Cancel schedule ID" to remove a timer.`
          : `You currently have no active background scheduled tasks. Say "Remind me to check symbol in ten minutes" or "Schedule market screen every five minutes" to create one.`;
        const spokenText = tuneFinancialPronunciation(spokenRaw);

        const tableRows = rows.map((r: any) => `| \`${r.id || r.scheduleId}\` | ${r.callback} | ${r.status} | ${r.description || "N/A"} |`).join("\n");
        const displayMarkdown = `### ⏱️ Active Scheduled Tasks (${total})\n\n| Schedule ID | Callback | Status | Description |\n|---|---|---|---|\n${tableRows || "| None | - | - | - |"}\n\n*Say "Cancel schedule <id>" to remove a timer.*`;

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "schedule",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case F: Options Screener Voice Response
      if (domain === "trading" && action === "options_screen") {
        const contracts = nlqRes.rows || [];
        if (contracts.length === 0) {
          const spokenRaw = "I evaluated the options universe, but no contracts matched your specified delta, volume, or volatility criteria. Try relaxing your filters or scanning another underlying.";
          return {
            success: true,
            spokenText: tuneFinancialPronunciation(spokenRaw),
            displayMarkdown: `### 🔍 Options Screener: No Contracts Matched\n\n${nlqRes.summary || "No contracts matched the requested filters."}`,
            actionType: "options_screener",
            proposerDid: AGENT_DIDS.TRADING,
            timestamp,
          };
        }

        const topC = contracts.slice(0, 3);
        const topDesc = topC
          .map((c: any) => `${c.underlying} ${c.strike} ${c.type} at ${c.bidAsk} with delta ${c.delta}`)
          .join(", and ");
        const spokenRaw = `I screened ${contracts.length} option contracts. Top candidates include ${topDesc}. Would you like to review an option order?`;
        const spokenText = tuneFinancialPronunciation(spokenRaw);

        const tableRows = contracts.slice(0, 5).map((c: any) =>
          `| **${c.underlying}** | ${c.type} | ${c.strike} | ${c.bidAsk} | ${c.delta} | ${c.iv} | ${c.volume} | ${c.dte} | \`${c.technicalSignal}\` |`
        ).join("\n");

        const displayMarkdown = `### 📊 E*TRADE Options Screener (${contracts.length} Contracts Matched)\n\n` +
          `| Symbol | Type | Strike | Bid/Ask | Delta | IV | Volume | DTE | Signal |\n` +
          `|---|---|---|---|---|---|---|---|---|\n` +
          `${tableRows}\n\n` +
          `*Say "Preview buy 1 <symbol> <strike> call" to draft an option order.*`;

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "options_screener",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case G: Watchlist Management Voice Response
      if (domain === "trading" && (action === "watchlist_save" || action === "watchlist_list")) {
        const spokenRaw = nlqRes.summary || "Watchlist operation completed successfully.";
        const spokenText = tuneFinancialPronunciation(spokenRaw);

        let tableRows = "";
        if (action === "watchlist_list") {
          tableRows = (nlqRes.rows || [])
            .map((w: any) => `| **${w.name}** | ${w.symbolCount} | ${w.symbols} | \`${w.source}\` |`)
            .join("\n");
        } else {
          tableRows = (nlqRes.rows || [])
            .map((w: any) => `| **${w.name}** | ${w.symbolCount} symbols | ${w.symbols} | \`${w.source}\` |`)
            .join("\n");
        }

        const displayMarkdown = `### 📋 E*TRADE Watchlists\n\n` +
          `${nlqRes.summary}\n\n` +
          `| Watchlist | Symbols Count | Tickers | Storage |\n` +
          `|---|---|---|---|\n` +
          `${tableRows || "| None | 0 | - | - |"}`;

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "watchlist",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case H: Cloudflare Agentic Payments Voice Response
      if (domain === "agentic_payments") {
        const spokenRaw = nlqRes.summary || "Agentic wallet and micropayment status retrieved.";
        const spokenText = tuneFinancialPronunciation(spokenRaw);

        const rows = nlqRes.rows || [];
        const details = rows.map((r: any) =>
          Object.entries(r).map(([k, v]) => `- **${k}:** ${v}`).join("\n")
        ).join("\n\n");

        const displayMarkdown = `### 💳 Agentic Micropayments (x402 & MPP Protocol)\n\n${nlqRes.summary}\n\n${details}`;

        return {
          success: true,
          spokenText,
          displayMarkdown,
          actionType: "agentic_payment",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Default General Voice Assistant Response
      const spokenRaw = nlqRes.summary || "I processed your request on the trading desk.";
      const spokenText = tuneFinancialPronunciation(spokenRaw);

      return {
        success: true,
        spokenText,
        displayMarkdown: nlqRes.summary || "Voice request processed.",
        actionType: "general",
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    } catch (err: any) {
      const spokenText = `I encountered an issue processing your trading request: ${err.message || "Unknown error"}.`;
      return {
        success: false,
        spokenText,
        displayMarkdown: `⚠️ **Voice Agent Error:** ${err.message || "Execution error"}`,
        actionType: "error",
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }
  }

  /**
   * Executive Voice Trading Greeting for incoming calls
   */
  getWelcomeGreeting(): { spokenText: string; displayMarkdown: string } {
    const spokenText =
      "Welcome to the E*TRADE Voice Trading Desk. You can ask for real-time market quotes, technical screening, portfolio status, schedule automated tasks, or draft trade order tickets. How can I assist your portfolio today?";
    const displayMarkdown =
      "### 🎙️ E*TRADE Voice Trading Desk Connected\n\n*Speak freely to query market data, run screener scans, schedule recurring alerts, or propose trade tickets with Human-in-the-Loop protection.*";
    return { spokenText, displayMarkdown };
  }
}

/**
 * Issue #815: a per-turn voice forwarder. The worker isolate hosting the
 * WebSocket has no ORM (an ORM wraps a specific Durable Object's
 * storage.sql), so a voice turn's persistence-backed work is forwarded
 * to the session user's OrchestratorAgent DO, whose
 * POST /trading/voice/turn route runs ETradeVoiceTradingService against
 * the DO's real ORM.
 */
export type VoiceTurnForwarder = (
  request: VoiceTradingTurnRequest
) => Promise<VoiceTradingTurnResponse>;

/**
 * Builds the orchestrator voice-turn forwarder for one session user.
 * The DO instance is keyed by, and the x-user-login header set from,
 * the worker-verified session identity the caller passes in — never
 * from caller-asserted input. Throws when the ORCHESTRATOR_AGENT binding is
 * unavailable or the DO rejects the turn, so a missing orchestrator
 * path fails loud instead of falling back to an ORM-less local turn
 * (the #781 contract).
 */
export function createOrchestratorVoiceTurnForwarder(env: Env, userLogin: string): VoiceTurnForwarder {
  return async (request: VoiceTradingTurnRequest): Promise<VoiceTradingTurnResponse> => {
    // Issue #815 (via ActorGateway, #1779): an unbound ORCHESTRATOR_AGENT
    // binding now throws the gateway's named error at the dispatch
    // below (the #781 fail-loud contract, unchanged) instead of
    // falling back to an ORM-less local turn.
    const response = await actorGateway.dispatch(
      env.ORCHESTRATOR_AGENT,
      userLogin,
      new Request("https://agent.internal/trading/voice/turn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-login": userLogin,
        },
        body: JSON.stringify({
          transcript: request.transcript ?? request.rawTranscript ?? "",
          // Issue #3720: the copilot-context carrier rides the
          // forward, so the DO route can resolve the turn's voice
          // activation. Broker facts are never forwarded — the
          // route resolves them server-side.
          ...(request.sourceTab ? { sourceTab: request.sourceTab } : {}),
        }),
      })
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Orchestrator rejected the voice turn forward (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
      );
    }
    return (await response.json()) as VoiceTradingTurnResponse;
  };
}

/**
 * Handle duplex WebSocket voice connection session (compatible with Cloudflare Voice Agent protocol)
 *
 * Issue #815: when no ORM is injected but a `forwardTurn` forwarder is
 * provided (the worker WebSocket route's wiring), each speech turn is
 * forwarded to the session user's orchestrator DO and executed there
 * against the real ORM. With an ORM injected, turns execute locally as
 * before. With neither, NLQ turns keep failing honestly (#781).
 */
export async function handleVoiceWebSocketConnection(
  ws: WebSocket,
  env: Env,
  orm?: DatabaseORM,
  sessionId: string = "voice_ws_trader",
  forwardTurn?: VoiceTurnForwarder
): Promise<void> {
  const service = new ETradeVoiceTradingService(env, orm, sessionId);

  ws.addEventListener("message", async (event: MessageEvent) => {
    try {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);

        // 1. Call Start handshake
        if (msg.type === "start_call" || msg.type === "hello") {
          const welcome = service.getWelcomeGreeting();
          ws.send(
            JSON.stringify({
              type: "call_accepted",
              protocol: "cloudflare_voice_v1",
              status: "speaking",
              message: welcome.spokenText,
              markdown: welcome.displayMarkdown,
            })
          );
          return;
        }

        // 2. Client speech turn (interim or final text from browser STT or client engine)
        if (msg.type === "turn" || msg.type === "user_transcript") {
          const userTranscript = msg.transcript || msg.text || "";
          ws.send(JSON.stringify({ type: "status", status: "thinking" }));

          // Issue #815: no local ORM + a forwarder wired (the worker
          // route) → the turn executes inside the session user's
          // orchestrator DO against its real ORM, one DO call per turn.
          const turnRequest: VoiceTradingTurnRequest = {
            transcript: userTranscript,
            sessionId,
            userLogin: sessionId,
            // Issue #3720: a turn frame may carry the copilot
            // context (the stock registration's sourceTab); it
            // rides the forwarder to the DO route unchanged.
            ...(typeof msg.sourceTab === "string" ? { sourceTab: msg.sourceTab } : {}),
          };
          const turnRes = !orm && forwardTurn
            ? await forwardTurn(turnRequest)
            : await service.processVoiceTurn(turnRequest);

          ws.send(
            JSON.stringify({
              type: "assistant_turn",
              status: "speaking",
              spokenText: turnRes.spokenText,
              displayMarkdown: turnRes.displayMarkdown,
              actionType: turnRes.actionType,
              orderId: turnRes.orderId,
              orderDraft: turnRes.orderDraft,
              orderStatus: turnRes.orderStatus,
              brokerOrderRef: turnRes.brokerOrderRef,
              marketQuote: turnRes.marketQuote,
              screenedStocks: turnRes.screenedStocks,
              proposerDid: turnRes.proposerDid,
              timestamp: turnRes.timestamp,
            })
          );
          return;
        }

        // 3. User Interrupt signal
        if (msg.type === "interrupt") {
          ws.send(JSON.stringify({ type: "interrupted", status: "listening" }));
          return;
        }

        // 4. End Call
        if (msg.type === "end_call") {
          ws.send(JSON.stringify({ type: "call_ended", status: "idle" }));
          ws.close(1000, "Call Ended");
          return;
        }
      }
    } catch (err: any) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: err.message || "Failed to process voice WebSocket frame",
        })
      );
    }
  });
}
