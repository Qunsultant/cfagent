/**
 * Cloudflare Email Trading Agent for E*TRADE
 * Repurposed from Cloudflare Agents Email SDK pattern:
 * https://developers.cloudflare.com/agents/examples/email-agent/
 *
 * Implements:
 * - Inbound email parsing & intent recognition (Quotes, Screener, Portfolio, Trade Previews)
 * - Human-in-the-Loop (HITL) order preview emails with Agent DID attestation
 * - Email-based order approval via signed approval links (Phase 5) and
 *   rejection ("CANCEL <orderId>")
 * - Live E*TRADE execution and outbound transaction receipts
 * - Cloudflare Worker email(message, env, ctx) handler integration
 */

import type { Env, InboundEmailPayload, EmailTradingResult, ETradeOrderDraft } from "../../types";
import { getServiceUserLogin, SHARED_ORCHESTRATOR_INSTANCE } from "../../security/serviceIdentity";
import { DatabaseORM, requireOrm } from "../../orm";
import { ETradeService } from "../../services/etrade";
import { executeNaturalLanguageQuery, planNLQ } from "../../agents/nlq";
import { AGENT_DIDS } from "../../agents/did";
import {
  channelPlanRefusal,
  tierAtLeast,
  type ChannelNlqDeps,
  type ChannelPrincipal,
} from "../channels/intake";
import {
  approvePreviewedOrder,
  cancelPreviewedOrder,
} from "../channels/approval";
import {
  extractApprovalTokenFromText,
  issueApprovalLink,
  verifyApprovalLinkForPrincipal,
} from "../channels/signedLinks";
import PostalMime from "postal-mime";
import { SERVER_PALETTE } from "../../theme/serverPalette";
import { createEmailSender } from "../../services/cloudflareEmailSender";
import { actorGateway } from "../../services/cloudflareActorGateway";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

export class ETradeEmailTradingService {
  /**
   * Issue #1262 Phase 1: `principal` is the resolved channel principal
   * (src/trading/channels/intake) supplied by the route. Three states:
   * a principal object — tier enforcement applies and NLQ/execution run
   * under the principal's login; null — the sender is unmapped and every
   * inbound message gets an explicit refusal; undefined — direct/internal
   * construction with no channel assertion (outbound sending, tests),
   * legacy behaviour.
   */
  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private sessionId: string = "email_agent_session",
    private principal?: ChannelPrincipal | null,
    private nlqDeps?: ChannelNlqDeps
  ) {}

  /** The login trading/NLQ work runs under: the principal's, never a fallback. */
  private identityLogin(): string {
    return this.principal?.userLogin ?? this.sessionId;
  }

  /**
   * Issue #1262 Phase 4: email NLQ already carried untrustedContent
   * (#767/#862); it now also threads the full web-chat deps.
   */
  private nlqOptions(): { untrustedContent: true } & ChannelNlqDeps {
    return { ...this.nlqDeps, untrustedContent: true };
  }

  /**
   * Process inbound email message (from Cloudflare Email Routing or HTTP webhook)
   */
  async processInboundEmail(payload: InboundEmailPayload): Promise<EmailTradingResult> {
    // Issue #781: every inbound branch is persistence-backed — approvals
    // and rejections read/update the trade ledger, and queries run NLQ
    // against it. Without an injected ORM, fail loud instead of the
    // former behaviour (fabricated "no pending preview" answers and NLQ
    // results computed against a stub ORM whose reads all returned
    // empty). Outbound-only sending (sendOutboundEmail) does not pass
    // through here and remains ORM-free.
    requireOrm(this.orm, "ETradeEmailTradingService.processInboundEmail");
    const from = (payload.from || "").trim();
    const to = (payload.to || this.env.EMAIL_AGENT_ADDRESS || "trade@agent.openaimp.com").trim();
    const subject = (payload.subject || "").trim();
    const bodyText = (payload.text || payload.html || "").trim();
    const combinedContent = `${subject}\n${bodyText}`.trim();
    const timestamp = new Date().toISOString();

    // Issue #1262 Phase 1: an unmapped sender (principal === null) is
    // refused explicitly — inbound email never runs under a shared
    // instance identity on behalf of an unknown sender.
    if (this.principal === null) {
      const respText =
        `Your email address (${from || "unknown"}) is not mapped to a trading account, so this request was not processed. ` +
        `Quotes, screens, previews and approvals only run for mapped senders (CHANNEL_EMAIL_PRINCIPALS). ` +
        `Ask the account owner to map your address, then resend.`;
      return {
        success: false,
        actionType: "refusal",
        from: to,
        to: from,
        responseSubject: "⚠️ Trading Request Refused: Sender Not Mapped",
        responseText: respText,
        responseHtml: this.renderEmailContainer(
          "Trading Request Refused",
          `<p style="color: ${SERVER_PALETTE.textSecondary};">${respText}</p>`
        ),
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }

    // Issue #815: env-preserving construction (the pattern #781's
    // pass-through sites adopted). ETradeService's orm-first overload
    // assigns env from its first argument, so an undefined ORM would
    // silently drop the caller's env. requireOrm above guarantees the
    // ORM on this path, but the construction stays env-safe regardless.
    const tradingService = this.orm
      ? new ETradeService(this.orm, this.env, this.identityLogin())
      : new ETradeService(this.env, undefined, this.identityLogin());

    // 1. Detect Approval Action: "APPROVE <orderId>" or "APPROVE"
    const approveMatch = combinedContent.match(/\b(APPROVE|CONFIRM|EXECUTE)\b(?:\s+(ord_[a-zA-Z0-9_-]+))?/i);
    if (approveMatch) {
      return this.handleEmailApproval(from, to, approveMatch[2], tradingService, timestamp, combinedContent);
    }

    // 2. Detect Rejection Action: "REJECT <orderId>" or "CANCEL <orderId>"
    const rejectMatch = combinedContent.match(/\b(REJECT|CANCEL|DECLINE)\b(?:\s+(ord_[a-zA-Z0-9_-]+))?/i);
    if (rejectMatch) {
      return this.handleEmailRejection(from, to, rejectMatch[2], tradingService, timestamp);
    }

    // 3. Process Natural Language Query / Trading Command (Quote, Screen, Preview, Portfolio)
    return this.handleEmailQuery(from, to, subject, bodyText, tradingService, timestamp);
  }

  /**
   * Issue #1262 Phase 5: execute a signed approval link click.
   * Called by the Orchestrator route /trading/email/approve-link (the
   * worker route GET /api/trading/email/approve forwards here — the
   * worker has no ORM, so the ledger lives here). Verification is the
   * same token + principal-map re-check as the reply path, with no
   * message principal: the token + map are the authorization. The
   * result is a plain JSON outcome for the worker to render as an
   * HTML page — never an email reply.
   */
  async executeSignedApprovalLink(token: string): Promise<{
    success: boolean;
    orderId?: string;
    status: string;
    message: string;
    execId?: string;
  }> {
    const orm = requireOrm(this.orm, "ETradeEmailTradingService.executeSignedApprovalLink");
    const timestamp = new Date().toISOString();
    const verified = await verifyApprovalLinkForPrincipal(this.env, token, undefined);
    if (!verified.ok) {
      return { success: false, status: "refused", message: verified.error };
    }
    const principal: ChannelPrincipal = {
      userLogin: verified.claims.login,
      authorizerDid: `did:user:email:${verified.claims.address}`,
      tier: "trade",
    };
    const tradingService = new ETradeService(orm, this.env, verified.claims.login);
    const outcome = await approvePreviewedOrder({
      trades: orm.trades ?? null,
      executor: tradingService,
      principal,
      authorizerDid: principal.authorizerDid,
      userLogin: verified.claims.login,
      orderId: verified.claims.orderId,
      allowLatestFallback: false,
      timestamp,
    });
    if (outcome.kind === "tier_refused") {
      return { success: false, orderId: verified.claims.orderId, status: "refused", message: outcome.reason };
    }
    if (outcome.kind === "not_found") {
      return {
        success: false,
        orderId: verified.claims.orderId,
        status: "not_found",
        message: `No pending order preview found awaiting approval for ID ${verified.claims.orderId}. It may have already been executed or cancelled.`,
      };
    }
    if (outcome.kind === "not_previewed") {
      return {
        success: false,
        orderId: verified.claims.orderId,
        status: outcome.trade.status,
        message: `Order ${verified.claims.orderId} is already in ${outcome.trade.status.toUpperCase()} status. Execution skipped.`,
      };
    }
    const isSuccess = outcome.kind === "executed";
    return {
      success: isSuccess,
      orderId: outcome.trade.id,
      status: isSuccess ? "executed" : "failed",
      message: isSuccess
        ? `Order ${outcome.trade.action} ${outcome.trade.quantity} ${outcome.trade.symbol} executed on E*TRADE.`
        : `Execution failed: ${outcome.message}. No funds moved.`,
      execId: outcome.execId,
    };
  }

  /**
   * Handle human order approval via email reply.
   *
   * Issue #1262 Phase 5: a bare APPROVE no longer executes anything.
   * Execution requires a signed approval link (#149 pattern): either
   * the reply quotes the preview email containing the link URL (the
   * token is extracted from the body), or the sender clicked the link
   * (which routes through /trading/email/approve-link with the same
   * verification). The token binds one order id and one login, carries
   * an expiry, and is re-checked against the principal map at use
   * time — so unmapping a sender revokes their outstanding links. A
   * bare APPROVE (or an invalid/expired link) is refused with a reply
   * that explains the link flow and, for a trade-tier principal with a
   * previewed draft, includes a fresh signed link for that draft.
   * The Phase 1 trade-tier gate still applies underneath: a
   * below-trade principal is refused before any link is issued.
   */
  private async handleEmailApproval(
    from: string,
    to: string,
    specifiedOrderId: string | undefined,
    tradingService: ETradeService,
    timestamp: string,
    combinedContent: string
  ): Promise<EmailTradingResult> {
    const approvalPrincipal = this.principal;
    const refusalResult = (
      subject: string,
      respText: string,
      orderId: string | undefined,
      orderStatus: string,
      authorizerDid?: string
    ): EmailTradingResult => ({
      success: false,
      actionType: "approval",
      from: to,
      to: from,
      responseSubject: subject,
      responseText: respText,
      responseHtml: this.renderEmailContainer(
        "Order Approval Refused",
        `<p style="color: ${SERVER_PALETTE.textSecondary};">${respText}</p>`
      ),
      orderId,
      orderStatus,
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
      timestamp,
    });

    // Below-trade principals are refused before any link is issued or
    // verified (Phase 1 tier gate, unchanged).
    if (approvalPrincipal && !tierAtLeast(approvalPrincipal.tier, "trade")) {
      const respText =
        `Approval refused: your mapped principal (${approvalPrincipal.userLogin}) has ${approvalPrincipal.tier} access, and executing an order requires the trade tier. The order draft was not executed.` +
        (approvalPrincipal.notice ? ` ${approvalPrincipal.notice}` : "");
      return refusalResult(
        "⚠️ E*TRADE Order Approval Refused: Trade Tier Required",
        respText,
        specifiedOrderId,
        "refused",
        approvalPrincipal.authorizerDid
      );
    }

    // Explicit Human Authorization: Stamp user DID from email address
    // (#1262 Phase 1: the resolved principal's DID when one was supplied —
    // the same string, built from the normalized mapped address).
    const authorizerDid = this.principal?.authorizerDid ?? `did:user:email:${from}`;

    // A fresh signed link for a previewed draft, included in refusal
    // replies so a legitimate sender can complete the approval from
    // the refusal itself. Only trade-tier principals ever receive one
    // (a DKIM/SPF-downgraded sender is read-tier for this message).
    const freshLinkFor = async (orderId: string | undefined): Promise<string | null> => {
      if (!approvalPrincipal || approvalPrincipal.tier !== "trade" || !orderId) return null;
      const draft = this.orm?.trades?.findById(orderId);
      if (!draft || draft.status !== "previewed") return null;
      const issued = await issueApprovalLink(this.env, {
        orderId,
        login: approvalPrincipal.userLogin,
        address: from,
        baseUrl: this.env.APP_BASE_URL || "https://agent.openaimp.com",
      });
      return issued?.url ?? null;
    };

    const token = extractApprovalTokenFromText(combinedContent);
    if (!token) {
      // Bare APPROVE: retired in Phase 5. Refuse with the link flow —
      // and a fresh link when one can be issued for the target draft.
      const targetId =
        specifiedOrderId ??
        this.orm?.trades?.findMany({ where: { status: "previewed" }, orderBy: "created_at DESC", limit: 1 })[0]?.id;
      const freshLink = await freshLinkFor(targetId);
      const respText =
        `Approval refused: a bare APPROVE reply no longer executes an order. ` +
        `Approve from the signed link in the order-preview email (click it, or reply quoting it).` +
        (freshLink ? ` Your signed approval link for this draft: ${freshLink}` : ``) +
        (approvalPrincipal
          ? ``
          : ` Email approvals require a mapped trade-tier sender (CHANNEL_EMAIL_PRINCIPALS).`);
      return refusalResult(
        "⚠️ E*TRADE Order Approval Refused: Signed Link Required",
        respText,
        specifiedOrderId,
        "refused",
        approvalPrincipal?.authorizerDid
      );
    }

    const verified = await verifyApprovalLinkForPrincipal(this.env, token, approvalPrincipal ?? undefined);
    if (!verified.ok) {
      return refusalResult(
        "⚠️ E*TRADE Order Approval Refused: Invalid Approval Link",
        `Approval refused: ${verified.error} Request a fresh preview email to get a new signed approval link.`,
        specifiedOrderId,
        "refused",
        approvalPrincipal?.authorizerDid
      );
    }
    if (specifiedOrderId && specifiedOrderId !== verified.claims.orderId) {
      return refusalResult(
        "⚠️ E*TRADE Order Approval Refused: Invalid Approval Link",
        `Approval refused: the signed link is for order ${verified.claims.orderId}, not ${specifiedOrderId}.`,
        specifiedOrderId,
        "refused",
        approvalPrincipal?.authorizerDid
      );
    }

    // The token + map re-check ARE the trade authorization on this
    // path, so the engine runs under a trade-tier principal even when
    // the presenting message itself was DKIM/SPF-downgraded to read
    // (possession of the link, sent only to the mapped address, is
    // strictly stronger than the transport authentication).
    const executionPrincipal: ChannelPrincipal | undefined = approvalPrincipal
      ? { ...approvalPrincipal, tier: "trade" }
      : undefined;
    const outcome = await approvePreviewedOrder({
      trades: this.orm?.trades ?? null,
      executor: tradingService,
      principal: executionPrincipal,
      authorizerDid,
      userLogin: verified.claims.login,
      orderId: verified.claims.orderId,
      allowLatestFallback: false,
      timestamp,
    });
    if (outcome.kind === "tier_refused") {
      return refusalResult(
        "⚠️ E*TRADE Order Approval Refused: Trade Tier Required",
        outcome.reason,
        specifiedOrderId,
        "refused",
        approvalPrincipal?.authorizerDid
      );
    }
    if (outcome.kind === "not_found" || outcome.kind === "not_previewed") {
      const respSub = `⚠️ E*TRADE Order Approval Failed: No Pending Preview`;
      const respText = `No pending order preview found awaiting approval${specifiedOrderId ? ` for ID ${specifiedOrderId}` : ""}. Orders may have already been executed or cancelled.`;
      const respHtml = this.renderEmailContainer(
        "Order Approval Failed",
        `
        <div style="background: ${SERVER_PALETTE.dangerAlpha10}; border: 1px solid ${SERVER_PALETTE.sentimentVeryBearish}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: ${SERVER_PALETTE.sentimentVeryBearish}; margin-top: 0;">❌ Approval Not Processed</h3>
          <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 0;">${respText}</p>
        </div>
        <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px;">To draft a new trade, email commands like: <code>Buy 10 NVDA limit 125.00</code>.</p>
        `
      );
      return {
        success: false,
        actionType: "approval",
        from: to,
        to: from,
        responseSubject: respSub,
        responseText: respText,
        responseHtml: respHtml,
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
    const respSub = isSuccess
      ? `✅ E*TRADE Order Executed: ${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol} (Ref: ${execId})`
      : `⚠️ E*TRADE Execution Failed: ${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}`;

    const respText = isSuccess
      ? `SUCCESS: Your authorized order to ${targetTrade.action} ${targetTrade.quantity} shares of ${targetTrade.symbol} has been routed to E*TRADE.\n\nBroker Order Ref: ${execId}\nStatus: EXECUTED\nTotal: $${targetTrade.totalValue.toFixed(2)} USD\nAuthorizer: ${authorizerDid}\nTimestamp: ${timestamp}`
      : `FAILED: Upstream broker rejected order placement: ${execMessage || "Unknown error"}. No funds moved.`;

    const respHtml = this.renderEmailContainer(
      isSuccess ? "E*TRADE Order Executed Successfully" : "E*TRADE Execution Alert",
      `
      <div style="background: ${isSuccess ? SERVER_PALETTE.greenAlpha10 : SERVER_PALETTE.dangerAlpha10}; border: 1px solid ${isSuccess ? SERVER_PALETTE.green500 : SERVER_PALETTE.sentimentVeryBearish}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="color: ${isSuccess ? SERVER_PALETTE.green500 : SERVER_PALETTE.sentimentVeryBearish}; margin-top: 0;">${isSuccess ? "✓ Order Routed to Broker" : "✕ Execution Blocked"}</h3>
        <p style="color: ${SERVER_PALETTE.textPrimary}; font-size: 15px; margin-bottom: 8px;"><strong>${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}</strong></p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 4px;"><strong>Broker Ref:</strong> <code style="color: ${SERVER_PALETTE.accent};">${execId}</code></p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 4px;"><strong>Execution Total:</strong> $${targetTrade.totalValue.toFixed(2)} USD</p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 0;"><strong>Authorizer DID:</strong> <code>${authorizerDid}</code></p>
      </div>
      <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px;">This trade was authorized via Autonomous Email Desk and stamped with Cryptographic Agent DID proof.</p>
      `
    );

    return {
      success: isSuccess,
      actionType: "approval",
      from: to,
      to: from,
      responseSubject: respSub,
      responseText: respText,
      responseHtml: respHtml,
      orderId: targetTrade.id,
      orderStatus: isSuccess ? "executed" : "failed",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
      timestamp,
    };
  }

  /**
   * Handle human order cancellation via email reply
   */
  private async handleEmailRejection(
    from: string,
    to: string,
    specifiedOrderId: string | undefined,
    tradingService: ETradeService,
    timestamp: string
  ): Promise<EmailTradingResult> {
    // Issue #1262 Phase 3: cancellation runs through the shared
    // engine (preview-tier gate + previewed-only update). The
    // response shape is unchanged: even a missing or non-previewed
    // draft reports "cancelled" (nothing moved), exactly as before.
    const rejectionPrincipal = this.principal;
    const cancelOutcome = cancelPreviewedOrder({
      trades: this.orm?.trades ?? null,
      principal: rejectionPrincipal,
      orderId: specifiedOrderId,
      lookup: "previewed_only",
      timestamp,
    });
    if (cancelOutcome.kind === "tier_refused") {
      const respText = cancelOutcome.reason;
      return {
        success: false,
        actionType: "rejection",
        from: to,
        to: from,
        responseSubject: "⚠️ E*TRADE Order Cancellation Refused: Preview Tier Required",
        responseText: respText,
        responseHtml: this.renderEmailContainer(
          "Order Cancellation Refused",
          `<p style="color: ${SERVER_PALETTE.textSecondary};">${respText}</p>`
        ),
        orderId: specifiedOrderId,
        orderStatus: "refused",
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: rejectionPrincipal?.authorizerDid,
        timestamp,
      };
    }

    const targetTrade = cancelOutcome.kind === "cancelled" || cancelOutcome.kind === "not_previewed"
      ? cancelOutcome.trade ?? null
      : null;
    const orderDesc = targetTrade ? `${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}` : "Draft order";
    const respSub = `❌ E*TRADE Order Cancelled: ${orderDesc}`;
    const respText = `Your order draft (${targetTrade?.id || specifiedOrderId || "N/A"}) has been safely cancelled. No funds or equities were moved.`;
    const respHtml = this.renderEmailContainer(
      "E*TRADE Order Cancelled",
      `
      <div style="background: ${SERVER_PALETTE.slateAlpha10}; border: 1px solid ${SERVER_PALETTE.slate500}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="color: ${SERVER_PALETTE.textMuted}; margin-top: 0;">✓ Draft Discarded Safely</h3>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 4px;"><strong>Order:</strong> ${orderDesc}</p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 0;">Status: <strong>CANCELLED</strong>. No live capital moved.</p>
      </div>
      `
    );

    return {
      success: true,
      actionType: "rejection",
      from: to,
      to: from,
      responseSubject: respSub,
      responseText: respText,
      responseHtml: respHtml,
      orderId: targetTrade?.id || specifiedOrderId,
      orderStatus: "rejected",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: this.principal?.authorizerDid ?? `did:user:email:${from}`,
      timestamp,
    };
  }

  /**
   * Handle NLQ queries over email (Quotes, Market Screener, Order Previews, Portfolio)
   */
  private async handleEmailQuery(
    from: string,
    to: string,
    subject: string,
    body: string,
    tradingService: ETradeService,
    timestamp: string
  ): Promise<EmailTradingResult> {
    const prompt = (subject.trim() + " " + body.trim()).trim();

    try {
      const orm = requireOrm(this.orm, "ETradeEmailTradingService.handleEmailQuery");

      // Issue #1262 Phase 1: channel seam gate. When a principal was
      // resolved, plan first and refuse what the channel must not do —
      // paid actions (all tiers, v1) and tier-gated trading actions —
      // BEFORE anything executes. The executor re-plans deterministically
      // inside executeNaturalLanguageQuery; the paid fast-paths are
      // regex-determined, so the peek and the execution plan agree.
      if (this.principal) {
        const peek = await planNLQ(this.env, prompt, { untrustedContent: true });
        const refusal = channelPlanRefusal(peek, this.principal);
        if (refusal) {
          return {
            success: false,
            actionType: "refusal",
            from: to,
            to: from,
            responseSubject: "⚠️ Trading Request Refused",
            responseText: refusal,
            responseHtml: this.renderEmailContainer(
              "Trading Request Refused",
              `<p style="color: ${SERVER_PALETTE.textSecondary};">${refusal}</p>`
            ),
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid: this.principal.authorizerDid,
            timestamp,
          };
        }
      }

      const { plan, result: nlqRes } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        prompt,
        this.env,
        // #1262 Phase 1: the NLQ userLogin is the resolved principal's
        // login — never the session/instance id (paid actions attribute
        // the payer from this value, #183).
        this.identityLogin(),
        this.principal?.authorizerDid ?? `did:user:email:${from}`,
        // #767/#862: email subject+body is untrusted inbound content — the
        // NLQ planner/validator apply instruction/data separation.
        // Phase 4: plus the full web-chat deps.
        this.nlqOptions(),
      );

      const domain = plan.domain;
      const action = plan.tradingData?.action || "query";

      // Case A: Quote
      if (domain === "trading" && action === "quote") {
        const q: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const lastPriceStr = String(q.lastPrice || "$0.00");
        const changeStr = String(q.change || "0.00%");
        const respSub = `📈 E*TRADE Quote: ${q.symbol || "Ticker"} - ${lastPriceStr} (${changeStr})`;
        const respText = `${nlqRes.summary}\n\nPrice: ${lastPriceStr}\nChange: ${changeStr}\nBid/Ask: ${q.bidAsk || "N/A"}\nVolume: ${q.volume || "N/A"}\n52W Range: ${q.range52Week || "N/A"}\nP/E: ${q.peRatio || "N/A"}\n\nTo preview a trade, reply: "Buy 10 ${q.symbol} limit ${lastPriceStr.replace("$", "") || "100"}"`;

        const respHtml = this.renderEmailContainer(
          `Real-Time Market Quote: ${q.symbol}`,
          `
          <div style="background: ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 20px; border: 1px solid ${SERVER_PALETTE.slate700}; margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
              <h2 style="color: ${SERVER_PALETTE.textPrimary}; margin: 0; font-size: 24px;">${q.symbol} <span style="font-size: 15px; color: ${SERVER_PALETTE.textMuted}; font-weight: normal;">${q.company || ""}</span></h2>
              <span style="font-size: 24px; font-weight: bold; color: ${SERVER_PALETTE.accent};">${q.lastPrice}</span>
            </div>
            <p style="color: ${changeStr.includes("-") ? SERVER_PALETTE.sentimentVeryBearish : SERVER_PALETTE.green500}; font-size: 15px; margin: 0 0 16px 0; font-weight: 600;">
              ${changeStr} Today
            </p>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: ${SERVER_PALETTE.textSecondary};">
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Bid / Ask:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${q.bidAsk || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Volume:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${q.volume || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>52-Week Range:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${q.range52Week || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0;"><strong>Market Cap:</strong></td>
                <td style="padding: 6px 0; text-align: right;">${q.marketCap || "N/A"}</td>
              </tr>
            </table>
          </div>
          <div style="background: ${SERVER_PALETTE.accentAlpha10}; border: 1px solid ${SERVER_PALETTE.sky600}; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            <p style="color: ${SERVER_PALETTE.accent}; margin: 0; font-size: 13px;">💡 <strong>Quick Trade Prompt:</strong> Reply to this email with <code>Preview Buy 10 ${q.symbol} limit ${lastPriceStr.replace("$", "") || "100"}</code> to draft an order ticket.</p>
          </div>
          `
        );

        return {
          success: true,
          actionType: "quote",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case B: Screener
      if (domain === "trading" && action === "screen") {
        const stocks = nlqRes.rows || [];
        const respSub = `🔍 E*TRADE Screener: ${stocks.length} Stocks Matched`;
        let textRows = stocks.length > 0
          ? stocks.slice(0, 8).map((s: any) => `• ${s.symbol} (${s.exchange || "N/A"}): ${s.price} (${s.change}) | Market cap: ${s.marketCap || "N/A"}`).join("\n")
          : "No equities matched the requested screener criteria. Try broadening your filter.";
        const respText = `${nlqRes.summary}\n\n${textRows}\n\nReply with "Quote <SYMBOL>" for deep details or "Buy <QTY> <SYMBOL>" to preview an order.`;

        let htmlRows = stocks.length > 0
          ? stocks.slice(0, 10).map((s: any) => `
          <tr style="border-bottom: 1px solid ${SERVER_PALETTE.slate700};">
            <td style="padding: 8px; font-weight: bold; color: ${SERVER_PALETTE.accent};">${s.symbol}</td>
            <td style="padding: 8px; color: ${SERVER_PALETTE.textSecondary};">${s.exchange || "N/A"}</td>
            <td style="padding: 8px; text-align: right; color: ${SERVER_PALETTE.textPrimary};">${s.price}</td>
            <td style="padding: 8px; text-align: right; color: ${(s.change || "").includes("-") ? SERVER_PALETTE.sentimentVeryBearish : SERVER_PALETTE.green500};">${s.change}</td>
            <td style="padding: 8px; text-align: right; color: ${SERVER_PALETTE.slate100};">${s.marketCap || "N/A"}</td>
          </tr>
        `).join("")
          : `<tr><td colspan="5" style="padding: 16px; text-align: center; color: ${SERVER_PALETTE.textMuted};">No equities matched the requested screener criteria.</td></tr>`;

        const respHtml = this.renderEmailContainer(
          `Market Screener Results (${stocks.length} Equities)`,
          `
          <p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 14px; margin-bottom: 16px;">${nlqRes.summary}</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
            <thead>
              <tr style="background: ${SERVER_PALETTE.slate800}; color: ${SERVER_PALETTE.textMuted}; text-align: left; border-bottom: 2px solid ${SERVER_PALETTE.slate600};">
                <th style="padding: 8px;">Symbol</th>
                <th style="padding: 8px;">Exchange</th>
                <th style="padding: 8px; text-align: right;">Price</th>
                <th style="padding: 8px; text-align: right;">Daily Change</th>
                <th style="padding: 8px; text-align: right;">Market Cap</th>
              </tr>
            </thead>
            <tbody>
              ${htmlRows}
            </tbody>
          </table>
          `
        );

        return {
          success: true,
          actionType: "screener",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case C: Order Preview (Strict HITL enforcement)
      if (domain === "trading" && action === "preview_order") {
        const row: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const orderId: string = String(row.orderId || `ord_${Date.now()}`);
        const actionStr: string = String(row.action || "BUY");
        const symbol: string = String(row.symbol || "EQUITY");
        const qty: number = Number(row.quantity) || 1;
        const total: string = String(row.estimatedTotal || "$0.00");
        const price: string = String(row.estimatedPrice || "$0.00");

        const respSub = `🛡️ HITL Action Required: Preview ${actionStr} ${qty} ${symbol} (${total})`;
        // Issue #1262 Phase 5: the preview carries a signed approval
        // link (HMAC + expiry, bound to this order and this principal).
        // It is issued only to trade-tier principals — the only senders
        // whose reply or click may execute. Without a link (preview
        // tier, or no link secret configured), the preview still
        // renders, but email approval is unavailable.
        const approvalLink = this.principal?.tier === "trade"
          ? await issueApprovalLink(this.env, {
              orderId,
              login: this.principal.userLogin,
              address: from,
              baseUrl: this.env.APP_BASE_URL || "https://agent.openaimp.com",
            })
          : null;
        const authorizeText = approvalLink
          ? `To AUTHORIZE this trade, click the signed approval link:\n${approvalLink.url}\n(or reply to this email quoting it — the link travels with the quote). A bare APPROVE reply no longer executes.`
          : `To AUTHORIZE this trade, approve from the Trading Hub link below (email approval links are issued only to trade-tier senders).`;
        const respText = `ORDER PREVIEW AWAITING HUMAN AUTHORIZATION\n\nAction: ${actionStr}\nSymbol: ${symbol}\nQuantity: ${qty}\nEstimated Price: ${price}\nEstimated Total: ${total}\nCommission: $0.00\nOrder ID: ${orderId}\n\nSAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED.\n\n${authorizeText}\n\nTo CANCEL, reply:\nCANCEL ${orderId}`;

        const approveUrl = `${this.env.APP_BASE_URL || "https://agent.openaimp.com"}/?tab=trading&approveOrder=${orderId}`;

        const respHtml = this.renderEmailContainer(
          `Order Preview Awaiting Human Authorization`,
          `
          <div style="background: ${SERVER_PALETTE.warningAlpha10}; border: 1px solid ${SERVER_PALETTE.warning}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
            <h3 style="color: ${SERVER_PALETTE.warning}; margin-top: 0;">🛡️ Agentic HITL Safety Guarantee</h3>
            <p style="color: ${SERVER_PALETTE.amber100}; font-size: 14px; margin-bottom: 0;">
              No funds have been moved. Every trade drafted by the Multi-Agent System requires explicit human authorization before being routed to E*TRADE.
            </p>
          </div>

          <div style="background: ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 20px; border: 1px solid ${SERVER_PALETTE.slate700}; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: ${SERVER_PALETTE.textSecondary};">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Order Action:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right; color: ${SERVER_PALETTE.accent}; font-weight: bold;">${actionStr}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Ticker Symbol:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right; font-weight: bold; color: ${SERVER_PALETTE.textPrimary};">${symbol}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Quantity:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${qty} shares</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Estimated Price:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${price}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Online Commission:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right; color: ${SERVER_PALETTE.green500};">$0.00 USD</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; font-size: 16px;"><strong>Estimated Total Value:</strong></td>
                <td style="padding: 10px 0; text-align: right; font-size: 18px; font-weight: bold; color: ${SERVER_PALETTE.accent};">${total}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${approveUrl}" style="background: ${SERVER_PALETTE.blue600}; color: ${SERVER_PALETTE.onGradient}; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
              ✓ Review & Approve on Trading Hub
            </a>
          </div>

          ${approvalLink ? `
          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${approvalLink.url}" style="background: ${SERVER_PALETTE.green500}; color: ${SERVER_PALETTE.onGradient}; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
              ✓ Approve via Signed Email Link
            </a>
            <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 12px; margin: 8px 0 0 0; word-break: break-all;">${approvalLink.url}</p>
          </div>` : ``}

          <div style="background: ${SERVER_PALETTE.card}; border-radius: 6px; padding: 12px; border: 1px solid ${SERVER_PALETTE.slate800};">
            <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px; margin: 0 0 6px 0;"><strong>Or Authorize Directly via Email:</strong></p>
            ${approvalLink
              ? `<p style="color: ${SERVER_PALETTE.textSecondary}; font-family: monospace; font-size: 14px; margin: 0 0 4px 0;">Click the signed approval link above, or reply quoting this email — a bare APPROVE reply no longer executes.</p>`
              : `<p style="color: ${SERVER_PALETTE.textSecondary}; font-family: monospace; font-size: 14px; margin: 0 0 4px 0;">Email approval links are issued only to trade-tier senders; approve from the Trading Hub above.</p>`}
            <p style="color: ${SERVER_PALETTE.textSecondary}; font-family: monospace; font-size: 14px; margin: 0;">Reply <code>CANCEL ${orderId}</code> to discard.</p>
          </div>
          `
        );

        return {
          success: true,
          actionType: "preview",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          orderId,
          orderStatus: "previewed",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case D: Portfolio & Balances
      if (domain === "trading" && action === "positions") {
        const respSub = `💼 E*TRADE Portfolio & Balance Summary`;
        const respText = `${nlqRes.summary}`;
        const respHtml = this.renderEmailContainer(
          `E*TRADE Brokerage Account Overview`,
          `
          <p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 15px; margin-bottom: 16px;">${nlqRes.summary}</p>
          <div style="background: ${SERVER_PALETTE.accentAlpha10}; border: 1px solid ${SERVER_PALETTE.sky600}; border-radius: 8px; padding: 12px;">
            <p style="color: ${SERVER_PALETTE.accent}; margin: 0; font-size: 13px;">🛡️ Account data reconciled against live E*TRADE REST API feeds.</p>
          </div>
          `
        );

        return {
          success: true,
          actionType: "portfolio",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case E: Options Research & Strategy Screener
      if (domain === "trading" && ["options_screen", "options_strategies", "options_best_trade", "options_opportunities"].includes(action)) {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        const topResults = rows.slice(0, 5);
        const htmlCards = topResults.map((row, index) => {
          const label = String(row.label || row.strategy || row.contractSymbol || row.symbol || `Option ${index + 1}`);
          const score = row.score ?? row.compositeScore;
          const details = Object.entries(row)
            .filter(([k]) => !["label", "strategy", "contractSymbol", "symbol", "score", "compositeScore"].includes(k))
            .slice(0, 4)
            .map(([k, v]) => `<strong>${k}:</strong> ${String(v)}`)
            .join(" &nbsp;|&nbsp; ");
          return `
            <div style="background: ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 14px; margin-bottom: 12px; border: 1px solid ${SERVER_PALETTE.slate700};">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <h4 style="color: ${SERVER_PALETTE.accent}; margin: 0 0 6px 0;">${escapeHtml(label)}</h4>
                ${score !== undefined ? `<span style="color: ${SERVER_PALETTE.green500}; font-weight: bold;">Score: ${score}</span>` : ""}
              </div>
              ${details ? `<p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px; margin: 0;">${details}</p>` : ""}
            </div>
          `;
        }).join("");

        const respSub = `📊 E*TRADE Options Research: ${nlqRes.summary || "Strategy Screener"}`;
        const respText = `${nlqRes.summary || "Options research completed."}\n\n${topResults.map((r, i) => `${i + 1}. ${r.label || r.strategy || r.symbol || "Option"}`).join("\n")}\n\nResearch only — no orders were placed.`;
        const respHtml = this.renderEmailContainer(
          "Options Research Results",
          `
          <p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 15px; margin-top: 0;">${escapeHtml(nlqRes.summary || "Options strategy evaluation completed.")}</p>
          ${htmlCards || `<p style="color: ${SERVER_PALETTE.textMuted};">No matching option candidates found.</p>`}
          <p style="color: ${SERVER_PALETTE.slate500}; font-size: 12px; margin-top: 16px;">🛡️ Multi-Agent Options Engine • E*TRADE Dynamic API Feed • Research Only</p>
          `
        );

        return {
          success: true,
          actionType: "screener",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Default AI Answer
      const respSub = `🤖 E*TRADE Trading Assistant: ${subject || "Market Research"}`;
      const respText = nlqRes.summary || "Your trading research request was processed.";
      const respHtml = this.renderEmailContainer("E*TRADE Trading Assistant", `<p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 14px;">${respText}</p>`);

      return {
        success: true,
        actionType: "general",
        from: to,
        to: from,
        responseSubject: respSub,
        responseText: respText,
        responseHtml: respHtml,
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    } catch (err: any) {
      const respSub = `⚠️ Error Processing Trading Request`;
      const respText = `An error occurred while processing your request: ${err.message || String(err)}`;
      const respHtml = this.renderEmailContainer("Processing Error", `<p style="color: ${SERVER_PALETTE.sentimentVeryBearish};">${respText}</p>`);

      return {
        success: false,
        actionType: "error",
        from: to,
        to: from,
        responseSubject: respSub,
        responseText: respText,
        responseHtml: respHtml,
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }
  }

  /**
   * Send outbound reply email via Cloudflare Email binding if available
   */
  async sendOutboundEmail(
    to: string,
    subject: string,
    html: string,
    text: string,
    attachment?:
      | { fileName: string; contentType: string; contentBase64: string }
      | Array<{ fileName: string; contentType: string; contentBase64: string }>
  ): Promise<boolean> {
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to) || /[\r\n]/.test(subject)) {
      throw new Error("Invalid outbound email recipient or subject.");
    }
    // Issue #1191 (#1173 R3): one attachment or many — deliveries
    // attach text + PDF + XLSX. Single-attachment callers (the
    // historical shape) are unaffected.
    const attachments = attachment === undefined
      ? []
      : Array.isArray(attachment)
        ? attachment
        : [attachment];
    // Issue #1778 (Adapter S4, program #1717): outbound sends go
    // through the one EmailSender port; the Cloudflare EMAIL
    // implementation lives in services/cloudflareEmailSender.ts.
    // Fail-soft contract preserved: unbound binding -> false (the
    // factory returns null), send failure -> warn + false inside
    // the adapter. Recipient/subject validation above still throws.
    const sender = createEmailSender(this.env);
    if (!sender) return false;
    return sender.send({ to, subject, html, text, attachments });
  }

  /**
   * Renders standard institutional dark-palette HTML email container
   */
  private renderEmailContainer(headerTitle: string, contentHtml: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headerTitle}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${SERVER_PALETTE.pageBackground}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${SERVER_PALETTE.textPrimary};">
  <div style="max-width: 620px; margin: 0 auto; background-color: ${SERVER_PALETTE.card}; border-radius: 10px; border: 1px solid ${SERVER_PALETTE.slate800}; overflow: hidden; margin-top: 20px; margin-bottom: 20px;">
    <!-- Brand Header -->
    <div style="background: linear-gradient(135deg, ${SERVER_PALETTE.blue900} 0%, ${SERVER_PALETTE.card} 100%); padding: 24px; border-bottom: 1px solid ${SERVER_PALETTE.slate800};">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <span style="background: ${SERVER_PALETTE.blue500}; color: ${SERVER_PALETTE.onGradient}; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase;">
            E*TRADE AGENTIC HUB
          </span>
          <h1 style="color: ${SERVER_PALETTE.onGradient}; font-size: 20px; margin: 8px 0 0 0; font-weight: 700;">${headerTitle}</h1>
        </div>
      </div>
    </div>

    <!-- Body Content -->
    <div style="padding: 24px;">
      ${contentHtml}
    </div>

    <!-- Security & Provenance Footer -->
    <div style="background-color: ${SERVER_PALETTE.pageBackground}; padding: 18px 24px; border-top: 1px solid ${SERVER_PALETTE.slate800}; font-size: 12px; color: ${SERVER_PALETTE.slate500};">
      <p style="margin: 0 0 6px 0;">
        🛡️ <strong>Trading Agent DID:</strong> <code style="color: ${SERVER_PALETTE.textMuted};">${AGENT_DIDS.TRADING}</code>
      </p>
      <p style="margin: 0 0 6px 0;">
        ⚖️ <strong>Regulatory Compliance:</strong> Direct REST API execution over OAuth 1.0a. Strict Human-in-the-Loop protection enforced on all equity orders.
      </p>
      <p style="margin: 0;">
        OpenAIMP Agentic Trading Network • <a href="${this.env.APP_BASE_URL || "https://agent.openaimp.com"}" style="color: ${SERVER_PALETTE.accent}; text-decoration: none;">agent.openaimp.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
  }
}

/**
 * The orchestrator DO instance that owns inbound email trading. The
 * worker email handler has no session (Cloudflare Email Routing invokes
 * it directly), so — exactly like the worker's scheduled() handler — it
 * addresses the deployment's established owner instance. The sender
 * address is caller-controlled and is NEVER used to select the instance
 * or the identity header (issue #815).
 */
export const INBOUND_EMAIL_ORCHESTRATOR_INSTANCE = SHARED_ORCHESTRATOR_INSTANCE;

/**
 * Cloudflare Worker email handler helper for exported email(message, env, ctx) handler
 */
export async function handleCloudflareEmailMessage(
  message: any,
  env: Env,
  ctx?: any
): Promise<EmailTradingResult> {
  const from = message.from;
  const to = message.to;

  let subject = "";
  let text = "";
  let html = "";
  // Issue #1262 Phase 1: the Authentication-Results header (RFC 8601) is
  // the transport-authentication evidence the channel intake uses to
  // gate the email trade tier (DKIM/SPF pass). Forward it verbatim; the
  // parsing lives in src/trading/channels/intake.
  let authenticationResults = "";
  try {
    authenticationResults = message.headers?.get?.("authentication-results") || "";
  } catch {
    authenticationResults = "";
  }

  try {
    if (message.raw) {
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(raw);
      subject = parsed.subject || "";
      text = parsed.text || "";
      html = parsed.html || "";
      if (!authenticationResults) {
        const authHeader = (parsed.headers || []).find(
          (h: any) => typeof h?.key === "string" && h.key.toLowerCase() === "authentication-results"
        );
        if (authHeader && typeof authHeader.value === "string") {
          authenticationResults = authHeader.value;
        }
      }
    }
  } catch (err) {
    console.warn("[CloudflareEmail] PostalMime parse failed, falling back to header inspect:", err);
    subject = message.headers?.get?.("subject") || "";
  }

  // Issue #815: inbound email trading is persistence-backed — approvals
  // and rejections read/update the trade ledger, and queries run NLQ
  // against it — and an ORM wraps a specific Durable Object's
  // storage.sql, which the worker isolate does not have. Forward the
  // parsed payload to the owning user's OrchestratorAgent DO, whose
  // POST /trading/email/inbound route runs ETradeEmailTradingService
  // against the DO's real ORM, over the same ORCHESTRATOR_AGENT channel every
  // /api route uses. If the orchestrator path is unavailable this
  // throws (the #781 fail-loud contract) instead of processing the
  // email against an ORM-less local service.
  // Issue #815 (fail-loud guard, pinned by
  // tests/worker_entry_points_orchestrator_wiring.test.ts): the
  // binding must exist with addressing methods BEFORE the
  // service-identity check below, so a missing orchestrator path
  // throws the ORCHESTRATOR_AGENT error (the #781 fail-loud contract)
  // instead of processing the email against an ORM-less local
  // service. This is a capability check only — the addressing and
  // fetch below ride the ActorGateway (#1779), which is the only
  // module that invokes idFromName/get for dispatch.
  const namespace = env.ORCHESTRATOR_AGENT;
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") {
    throw new Error(
      "Inbound email trading requires the ORCHESTRATOR_AGENT (orchestrator) binding to reach the user's Durable Object ORM; refusing to process the email without it (issue #815)."
    );
  }
  // Issue #1185: the instance constant is the ADDRESS, not an identity.
  // The forward asserts no identity header (Issue #1262 Phase 1: the DO
  // resolves the principal from the payload); the service identity must
  // still be configured, or the forward fails closed (mirrors the worker
  // scheduled() handler's skip) instead of asserting a synthetic login.
  const serviceLogin = getServiceUserLogin(env);
  if (!serviceLogin) {
    throw new Error(
      "Inbound email trading requires a configured service identity (SERVICE_USER_LOGIN) to forward under; refusing to process the email without it (issue #1185)."
    );
  }
  const response = await actorGateway.dispatch(
    env.ORCHESTRATOR_AGENT,
    INBOUND_EMAIL_ORCHESTRATOR_INSTANCE,
    new Request("https://agent.internal/trading/email/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Issue #1262 Phase 1: no identity header is asserted here. The
        // instance name above is ROUTING (addressing, #815) only; the
        // caller's identity is resolved inside the DO from the payload
        // (sender → CHANNEL_EMAIL_PRINCIPALS map + Authentication-
        // Results) by the channel intake.
      },
      body: JSON.stringify({ from, to, subject, text, html, authenticationResults }),
    })
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Orchestrator rejected the inbound email forward (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }
  const result = (await response.json()) as EmailTradingResult;

  // Automatically dispatch outbound reply if Cloudflare Email Service reply is supported.
  // Reply dispatch is send-only (no persistence), so it stays in the
  // worker on the ORM-free send path #781 preserved.
  if (typeof message.reply === "function") {
    try {
      await message.reply(
        new Response(
          `From: ${to}\r\nTo: ${from}\r\nSubject: ${result.responseSubject}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${result.responseHtml}`
        ).body
      );
    } catch (e) {
      console.warn("[CloudflareEmail] message.reply error:", e);
    }
  } else {
    const sender = new ETradeEmailTradingService(env);
    await sender.sendOutboundEmail(from, result.responseSubject, result.responseHtml, result.responseText);
  }

  return result;
}
