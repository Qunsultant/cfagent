/**
 * Cloudflare Slack Trading Agent — resolves the tenant's selected broker for
 * execution and names that broker in every card (#5131, #5148).
 * Repurposed from Cloudflare Agents Slack SDK pattern:
 * https://developers.cloudflare.com/agents/examples/slack-agent/
 *
 * Implements:
 * - Slack Event Webhooks (app_mention, message.im, url_verification)
 * - HMAC-SHA256 signature verification with replay protection
 * - Slack Block Kit interactive message cards (Quotes, Screener, Portfolio, Trade Previews)
 * - Interactive Button approvals ([✓ Approve & Submit] and [✕ Cancel Draft])
 * - Multi-tenant OAuth installation & token management
 */

import type {
  Env,
  SlackEventResult,
  SlackInteractionResult,
  SlackBlockKitPayload,
  PreTradeApprovalDraft,
} from "../../types";
import { DatabaseORM, requireOrm } from "../../orm";
import { ETradeService } from "../../services/etrade";
import { executeNaturalLanguageQuery, planNLQ } from "../../agents/nlq";
import { AGENT_DIDS } from "../../agents/did";
import {
  channelPlanRefusal,
  slackPrincipalLinkStoreFromEnv,
  tierAtLeast,
  type ChannelNlqDeps,
  type ChannelPrincipal,
  type ChannelTier,
  type SlackPrincipalLinkStore,
} from "../channels/intake";
import {
  approvePreviewedOrder,
  cancelPreviewedOrder,
  type ApprovalExecutor,
} from "../channels/approval";
import { TradingPlatformRegistry } from "../registry";
import { auditEventPort } from "../../data/createAuditEventPorts";
import { resolveChannelBroker } from "../channelBroker";
import {
  deliverJourneyDecision,
  findDecidedJourneyGate,
  listPendingJourneyGates,
  sagaAuditOwnerStub,
  type SagaJourneyBinding,
} from "../../workflows/sagaJourneyGate";
import { ETradeEmailTradingService } from "../email/agent";
import { ETradeWebhookService } from "../../services/tradingWebhooks";
import { ETradeBrowserService } from "../../services/browserAgent";
import { validateEmailRecipient } from "../../security/webhookReplay";
import { sanitizeInboundText } from "../../security/promptInjectionSanitize";
import { getCfpayConfig, cfpayPostToSlack } from "../../services/cfpayA2A";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "trading/slack/agent",
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

export { timingSafeEqual, verifySlackSignature } from "../../security/webhookSecurity";

export class ETradeSlackTradingService {
  /**
   * Issue #1262 Phase 1: `principal` is the resolved channel principal
   * (src/trading/channels/intake) supplied by the route. Three states:
   * a principal object — tier enforcement applies and NLQ/execution run
   * under the principal's login; null — the Slack user is not linked
   * and every event/interaction gets an explicit refusal (the `link`
   * DM command still works: it is how linking starts); undefined —
   * direct/internal construction with no channel assertion
   * (notifications, OAuth, tests), legacy behaviour.
   */
  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private sessionId: string = "slack_agent_session",
    private principal?: ChannelPrincipal | null,
    private linkStore?: SlackPrincipalLinkStore,
    private nlqDeps?: ChannelNlqDeps
  ) {}

  /** The login trading/NLQ work runs under: the principal's, never a fallback. */
  private identityLogin(): string {
    return this.principal?.userLogin ?? this.sessionId;
  }

  /**
   * Issue #1262 Phase 4: every channel NLQ call carries the full
   * web-chat dependency set (built by the route) and is untrusted
   * inbound content unconditionally (#880) — Slack's NLQ call was the
   * one channel call missing the flag.
   */
  private nlqOptions(): { untrustedContent: true } & ChannelNlqDeps {
    return { ...this.nlqDeps, untrustedContent: true };
  }

  private links(): SlackPrincipalLinkStore {
    return this.linkStore ?? slackPrincipalLinkStoreFromEnv(this.env);
  }

  /**
   * Issue #1262 Phase 1: post an explicit tier refusal and shape it as
   * the event result. Below-tier approvals/previews are refused BEFORE
   * any ledger read or execution attempt.
   */
  private async refuseSlackEvent(
    channel: string,
    threadTs: string | undefined,
    text: string,
    orderId: string | undefined,
    timestamp: string
  ): Promise<SlackEventResult> {
    const refusalPayload: SlackBlockKitPayload = { channel, thread_ts: threadTs, text };
    await this.postSlackMessage(refusalPayload);
    return {
      handled: true,
      actionType: "refusal",
      orderId,
      response: refusalPayload,
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: this.principal?.authorizerDid,
      timestamp,
    };
  }

  /**
   * Issue #1262 Phase 1: the `link` DM command. Issues a short-lived
   * single-use connect code for (team_id, user_id) and posts it back.
   * Confirming happens in an authenticated web session
   * (POST /api/trading/slack/link), which binds this Slack user to the
   * SESSION's login at tier "trade" — the code alone grants nothing.
   */
  private async handleSlackLinkCommand(args: {
    teamId: string;
    user: string;
    channel: string;
    threadTs?: string;
    channelType?: string;
    timestamp: string;
  }): Promise<SlackEventResult> {
    const { teamId, user, channel, threadTs, channelType, timestamp } = args;
    const isDm = channelType === "im" || (typeof channel === "string" && channel.startsWith("D"));
    if (!isDm) {
      const hintPayload: SlackBlockKitPayload = {
        channel,
        thread_ts: threadTs,
        text: "🔒 Account linking starts in a direct message — DM me `link` and I'll issue your connect code there, where only you can see it.",
      };
      await this.postSlackMessage(hintPayload);
      return { handled: true, actionType: "link", response: hintPayload, timestamp };
    }

    const { code, expiresAt } = await this.links().issueLinkCode(teamId, user);
    const expiresIso = new Date(expiresAt).toISOString();
    const codePayload: SlackBlockKitPayload = {
      channel,
      thread_ts: threadTs,
      text:
        `🔗 Your connect code is \`${code}\` (expires ${expiresIso}, single use). ` +
        `While signed in to the trading app, confirm it via POST /api/trading/slack/link with {"code": "${code}"}. ` +
        `Confirming binds THIS Slack user to the account you are signed in as — never share the code.`,
    };
    await this.postSlackMessage(codePayload);
    return { handled: true, actionType: "link", response: codePayload, timestamp };
  }

  /**
   * Process inbound Slack Events API payload (URL verification or event_callback)
   */
  async processSlackEvent(payload: any): Promise<SlackEventResult> {
    const timestamp = new Date().toISOString();

    // 1. URL Verification Handshake
    if (payload.type === "url_verification") {
      return {
        handled: true,
        actionType: "challenge",
        challenge: payload.challenge,
        timestamp,
      };
    }

    // 2. Event Callbacks (app_mention or message.im)
    if (payload.type === "event_callback" && payload.event) {
      const event = payload.event;

      // Ignore bot messages and updates to prevent recursion
      if (event.bot_id || event.subtype) {
        return {
          handled: false,
          actionType: "ignored",
          timestamp,
        };
      }

      // #1763 (SEC-005): sanitize inbound Slack text at entry —
      // marker-defuse + control-strip — before it reaches NLQ or
      // any prompt assembly. Legitimate text passes through verbatim.
      const rawText = sanitizeInboundText((event.text || "").replace(/<@[^>]+>/g, "").trim());
      const emailMatch = rawText.match(/\bemail(?:\s+(?:the\s+)?(?:results?|response))?\s+(?:to\s+)?<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i);
      const emailTo = typeof event.email_to === "string" ? event.email_to.trim() : emailMatch?.[1];
      const queryText = emailMatch ? rawText.replace(emailMatch[0], "").trim() : rawText;
      const channel = event.channel;
      const threadTs = event.thread_ts || event.ts;
      const user = event.user || "unknown";
      const teamId = payload.team_id || payload.team?.id || "unknown";

      // Issue #1262 Phase 1: the connect-code command comes FIRST — it
      // is how an unlinked user starts linking, so it must work with no
      // principal and no ORM. DM-only: a code posted in a channel would
      // be visible to everyone in it, and whoever confirms it first
      // binds this Slack user to THEIR account.
      if (/^link$/i.test(queryText)) {
        return this.handleSlackLinkCommand({
          teamId,
          user,
          channel,
          threadTs,
          channelType: event.channel_type,
          timestamp,
        });
      }

      // Issue #1262 Phase 1: an unlinked Slack user (principal === null)
      // is refused explicitly — never processed under the workspace
      // instance's identity. Workspace membership is not an account
      // relationship, so v1 grants no default tier.
      if (this.principal === null) {
        const refusalPayload: SlackBlockKitPayload = {
          channel,
          thread_ts: threadTs,
          text:
            "🔒 Your Slack user is not linked to a trading account, so I can't run that. " +
            "DM me `link` to get a connect code, confirm it while signed in to the trading app, and then try again.",
        };
        await this.postSlackMessage(refusalPayload);
        return {
          handled: true,
          actionType: "refusal",
          response: refusalPayload,
          timestamp,
        };
      }

      // Issue #781: event handling is persistence-backed (trade approvals
      // read/update the ledger; queries run NLQ against it). Without an
      // injected ORM this must fail loud — the former stub fallback made
      // approvals report real orders as "not found" and discarded writes.
      // Notification-only methods (postSlackMessage) never reach this line
      // and remain ORM-free.
      const orm = requireOrm(this.orm, "ETradeSlackTradingService.processSlackEvent");
      const authorizerDid = this.principal?.authorizerDid ?? `did:user:slack:${user}`;

      // 2a. Direct Conversational Pre-Trade Approval: "approve <orderId>" or "authorize <orderId>"
      const approveMatch = rawText.match(/^(?:approve|authorize|confirm|execute)\s+([a-zA-Z0-9_\-]+)$/i);
      if (approveMatch) {
        const targetOrderId = approveMatch[1].trim();
        // Issue #1262 Phase 3: approval runs through the shared engine
        // (tier gate + draft lookup + execute/fallback) — the service
        // keeps only the Block Kit rendering. The engine's tier gate
        // refuses before any ledger read, so a below-tier principal
        // cannot even probe draft existence (Phase 1 behaviour).
        const channelBroker = await resolveChannelBroker(this.env);
        // Exact pre-#5131 shape preserved: nothing selected → the legacy
        // service; a broker selected → its registry platform (which carries
        // the #1393 frozen-terms guard the bare service does not).
        // Exact pre-#5131 shape kept: the legacy service serves the no-selection
        // case only, and only while that default is E*TRADE (#5147 moves the
        // default to the platform broker, which goes through the registry).
        const useLegacyChannelService =
          channelBroker.source === "no-selection" && channelBroker.executing === "etrade";
        const tradingService: ApprovalExecutor = useLegacyChannelService
          ? new ETradeService(orm, this.env, this.identityLogin())
          : (TradingPlatformRegistry.getPlatform(
              channelBroker.executing,
              this.env,
              orm,
              this.identityLogin(),
            ) as unknown as ApprovalExecutor);
        const outcome = await approvePreviewedOrder({
          trades: orm.trades ?? null,
          executor: tradingService,
          principal: this.principal,
          authorizerDid,
          userLogin: this.identityLogin(),
          orderId: targetOrderId,
          timestamp,
        });
        if (outcome.kind === "tier_refused") {
          return this.refuseSlackEvent(channel, threadTs, `🔒 ${outcome.reason}`, targetOrderId, timestamp);
        }
        if (outcome.kind === "not_found") {
          const notFoundPayload: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `⚠️ Order draft \`${targetOrderId}\` not found in database ledger.`,
          };
          await this.postSlackMessage(notFoundPayload);
          return {
            handled: true,
            actionType: "rejection",
            orderId: targetOrderId,
            response: notFoundPayload,
            timestamp,
          };
        }

        if (outcome.kind === "not_previewed") {
          const statusPayload: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `ℹ️ Order \`${targetOrderId}\` is already in *${outcome.trade.status.toUpperCase()}* status. Execution skipped.`,
          };
          await this.postSlackMessage(statusPayload);
          return {
            handled: true,
            actionType: "rejection",
            orderId: targetOrderId,
            response: statusPayload,
            timestamp,
          };
        }

        const targetTrade = outcome.trade;
        const isSuccess = outcome.kind === "executed";
        const execId = outcome.execId ?? `et_exec_${Date.now()}`;
        const execMessage = outcome.kind === "failed" ? outcome.message : undefined;

        const executedPayload: SlackBlockKitPayload = {
          channel,
          thread_ts: threadTs,
          text: isSuccess
            ? `✅ Order \`${targetOrderId}\` APPROVED & EXECUTED on ${channelBroker.presentation.label} by <@${user}> (Ref: \`${execId}\`)`
            : `❌ Execution failed for order \`${targetOrderId}\`: ${execMessage || "Failed"}`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: isSuccess
                  ? `✅ ORDER EXECUTED ON ${channelBroker.presentation.label}`
                  : `❌ ${channelBroker.presentation.label} EXECUTION FAILED`,
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Action:*\n${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}` },
                { type: "mrkdwn", text: `*Broker Order ID:*\n\`${execId}\`` },
                { type: "mrkdwn", text: `*Execution Total:*\n$${Number(targetTrade.totalValue || 0).toFixed(2)} USD` },
                { type: "mrkdwn", text: `*Authorizer:*\n<@${user}>` },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Status: *${isSuccess ? "EXECUTED" : "REJECTED"}* • Stamped with Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • ${timestamp}`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(executedPayload);

        // Auto-dispatch visual snap receipt
        if (isSuccess) {
          try {
            const browserService = new ETradeBrowserService(this.env);
            await browserService.sendTransactionSnapToSlack({
              transactionId: targetTrade.id,
              symbol: targetTrade.symbol,
              action: targetTrade.action,
              quantity: targetTrade.quantity,
              price: targetTrade.price,
              orderType: targetTrade.orderType,
              status: "EXECUTED",
              totalValue: targetTrade.totalValue,
              environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
              timestamp,
              // This handler IS the human's conversational approval — the
              // receipt may claim HITL verification (issue #120).
              humanApproved: true,
            }, { channel });
          } catch (snapErr) {
            structuredLog.warn("slackAgent.snap_receipt_delivery_failed", {
              message: "[ETradeSlackAgent] Could not deliver snap receipt",
              handler: "processSlackEvent",
              error: snapErr instanceof Error ? snapErr.message : String(snapErr),
            });
          }
        }

        return {
          handled: true,
          actionType: "approval",
          orderId: targetOrderId,
          response: executedPayload,
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          timestamp,
        };
      }

      // 2b. Direct Conversational Pre-Trade Cancellation: "cancel <orderId>" or "reject <orderId>"
      const cancelMatch = rawText.match(/^(?:cancel|reject|abort|dismiss)\s+([a-zA-Z0-9_\-]+)$/i);
      if (cancelMatch) {
        const targetOrderId = cancelMatch[1].trim();
        // Issue #5148: name the broker the draft was destined for, not a literal.
        const channelBroker = await resolveChannelBroker(this.env);
        // Issue #1262 Phase 3: cancellation runs through the shared
        // engine (preview-tier gate + unconditional by-id update,
        // exactly as before — including the authorizer stamp).
        const cancelOutcome = cancelPreviewedOrder({
          trades: orm.trades ?? null,
          principal: this.principal,
          orderId: targetOrderId,
          lookup: "by_id",
          stampAuthorizerDid: authorizerDid,
          timestamp,
        });
        if (cancelOutcome.kind === "tier_refused") {
          return this.refuseSlackEvent(channel, threadTs, `🔒 ${cancelOutcome.reason}`, targetOrderId, timestamp);
        }

        const cancelPayload: SlackBlockKitPayload = {
          channel,
          thread_ts: threadTs,
          text: `❌ Order draft \`${targetOrderId}\` was CANCELLED by <@${user}>. No broker order submitted.`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "❌ ORDER DRAFT CANCELLED", emoji: true },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Order draft \`${targetOrderId}\` was cancelled by <@${user}>. No capital was moved and no order was routed to ${channelBroker.presentation.label}.`,
              },
            },
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: `Status: *CANCELLED* • Authorizer: \`${authorizerDid}\` • ${timestamp}` },
              ],
            },
          ],
        };

        await this.postSlackMessage(cancelPayload);

        return {
          handled: true,
          actionType: "rejection",
          orderId: targetOrderId,
          response: cancelPayload,
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          timestamp,
        };
      }

      // 2c. Direct Conversational Snap: "snap <target>"
      const snapMatch = rawText.match(/^snap\s+([a-zA-Z0-9_\-]+)$/i);
      if (snapMatch) {
        const target = snapMatch[1].trim();
        const browserService = new ETradeBrowserService(this.env);
        const trade = orm.trades?.findById(target.toLowerCase()) || orm.trades?.findById(target);

        if (trade) {
          const snapRes = await browserService.sendTransactionSnapToSlack({
            transactionId: trade.id,
            symbol: trade.symbol,
            action: trade.action,
            quantity: trade.quantity,
            price: trade.price,
            orderType: trade.orderType,
            status: trade.status,
            totalValue: trade.totalValue,
            environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
            timestamp: trade.updatedAt || trade.createdAt,
            humanApproved: Boolean((trade as any).authorizerDid),
          }, { channel });

          const snapMsg: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `📸 Transaction snapshot generated for ${trade.symbol} (${trade.id}): ${snapRes.success ? "Delivered to Slack" : `Not delivered — ${snapRes.error}`}`,
          };
          await this.postSlackMessage(snapMsg);
          return {
            handled: true,
            actionType: "snap",
            orderId: trade.id,
            response: snapMsg,
            timestamp,
          };
        } else {
          const snapRes = await browserService.captureAndSendToSlack(`https://finance.yahoo.com/quote/${target.toUpperCase()}`, {
            channel,
            caption: `Market chart snapshot for ${target.toUpperCase()} requested by <@${user}>`,
          });
          const snapMsg: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `📸 Browser Agent snapshot for ${target.toUpperCase()}: ${snapRes.success ? "Delivered to Slack" : `Not delivered — ${snapRes.error}`}`,
          };
          await this.postSlackMessage(snapMsg);
          return {
            handled: true,
            actionType: "snap",
            response: snapMsg,
            timestamp,
          };
        }
      }

      // Issue #1262 Phase 1: channel seam gate — plan first and refuse
      // paid actions (all tiers, v1) and tier-gated trading actions
      // BEFORE anything executes, exactly as on the email seam.
      if (this.principal) {
        const peek = await planNLQ(this.env, queryText, { untrustedContent: true });
        const refusal = channelPlanRefusal(peek, this.principal);
        if (refusal) {
          return this.refuseSlackEvent(channel, threadTs, `🔒 ${refusal}`, undefined, timestamp);
        }
      }

      const { plan, result: nlqRes } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        queryText,
        this.env,
        // #1262 Phase 1: the NLQ userLogin is the resolved principal's
        // login — never the session/instance id (#183 payer attribution).
        this.identityLogin(),
        this.principal?.authorizerDid ?? `did:user:slack:${event.user || "unknown"}`,
        // #1262 Phase 4: full web-chat deps + untrusted content (#880).
        this.nlqOptions(),
      );

      const domain = plan.domain;
      const action = plan.tradingData?.action || "query";
      // Issue #5148: every card below names the broker this surface resolves,
      // not the first broker in the catalogue. Resolved once per event.
      const brokerLabel = (await resolveChannelBroker(this.env)).presentation.label;
      const rowText = nlqRes.rows.slice(0, 50).map((row) => JSON.stringify(row)).join("\n");
      const responseText = [nlqRes.summary || "NLQ request processed.", rowText].filter(Boolean).join("\n\n");
      const responseHtml = `<h2>NLQ research response</h2><p>${escapeHtml(nlqRes.summary || "NLQ request processed.")}</p>` +
        (nlqRes.rows.length > 0
          ? `<pre style="white-space:pre-wrap">${escapeHtml(nlqRes.rows.slice(0, 50).map((row) => JSON.stringify(row, null, 2)).join("\n\n"))}</pre>`
          : "");
      const deliveryAllowed = !["preview_order", "execute_order"].includes(action) &&
        !["create", "update", "delete"].includes(plan.operation);
      const emailRequested = Boolean(emailTo) || /\bemail\b/i.test(rawText);
      let emailStatus = emailRequested ? "not sent (add `email results to you@example.com`)" : "not requested";
      if (deliveryAllowed && emailTo) {
        // Issue #143 P0: emailTo domain allowlist (EMAIL_TO_ALLOWED_DOMAINS).
        // When configured, only listed domains are accepted; when unset,
        // behavior is unchanged (format check only).
        const emailCheck = validateEmailRecipient(emailTo, this.env.EMAIL_TO_ALLOWED_DOMAINS);
        if (!emailCheck.ok) {
          emailStatus = `failed (${emailCheck.reason})`;
        } else {
          const emailAgent = new ETradeEmailTradingService(this.env, orm, this.sessionId, this.principal);
          emailStatus = await emailAgent.sendOutboundEmail(
            emailTo,
            "NLQ response",
            responseHtml,
            responseText,
          ) ? `sent to ${emailTo}` : `failed for ${emailTo}`;
        }
      }
      const webhook = new ETradeWebhookService(this.orm, this.env, this.sessionId);
      const webhookResult: { success: boolean; error?: string; status?: number } =
        deliveryAllowed && this.env.OUTBOUND_WEBHOOK_URL && this.env.OUTBOUND_WEBHOOK_SECRET
        ? await webhook.dispatchOutboundWebhook("nlq.response", {
          query: queryText,
          domain: nlqRes.domain,
          action,
          result: {
            count: nlqRes.count,
            status: nlqRes.status,
            summary: nlqRes.summary,
            rows: nlqRes.rows.slice(0, 50),
            executedAt: nlqRes.executedAt,
          },
          source: "slack",
          channel,
          user: event.user,
        })
        : { success: false, error: deliveryAllowed ? "Outbound webhook is not configured." : "Not sent for a state-changing action." };
      const deliveryStatus = `Email: ${emailStatus}. Signed webhook: ${webhookResult.success ? "sent" : webhookResult.error || `HTTP ${webhookResult.status}`}.`;

      let blockKitMessage: SlackBlockKitPayload;

      // Case A: Quote
      if (domain === "trading" && action === "quote") {
        const q = nlqRes.rows?.[0] || {};
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: `${brokerLabel} Quote for ${q.symbol}: ${q.lastPrice} (${q.change})`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `📈 ${brokerLabel} Quote: ${q.symbol} - ${q.company || ""}`,
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Last Price:*\n*${q.lastPrice || "$0.00"}*` },
                { type: "mrkdwn", text: `*24h Change:*\n${q.change || "0.00%"}` },
                { type: "mrkdwn", text: `*Bid / Ask:*\n${q.bidAsk || "N/A"}` },
                { type: "mrkdwn", text: `*Volume:*\n${q.volume || "N/A"}` },
                { type: "mrkdwn", text: `*52-Week Range:*\n${q.range52Week || "N/A"}` },
                { type: "mrkdwn", text: `*Market Cap:*\n${q.marketCap || "N/A"}` },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `🛡️ Attested by Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • Direct ${brokerLabel} Live REST API Feed`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "quote",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case B: Screener
      if (domain === "trading" && action === "screen") {
        const stocks = nlqRes.rows || [];
        const topStocks = stocks.slice(0, 5);

        const stockFields = topStocks.flatMap((s: any) => [
          { type: "mrkdwn", text: `*${s.symbol}* (${s.exchange || "N/A"})\n${s.price} (${s.change})` },
          { type: "mrkdwn", text: `*Market cap:* ${s.marketCap || "N/A"}` },
        ]);

        blockKitMessage = {
          channel,
          thread_ts: threadTs,
              text: `Live Stock Listings: ${stocks.length} equities matched`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `🔍 Live Stock Listings: ${stocks.length} Stocks Matched`,
                emoji: true,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${nlqRes.summary}`,
              },
            },
            {
              type: "section",
              fields: stockFields.length > 0 ? stockFields : [{ type: "mrkdwn", text: "No equities matched criteria." }],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `💡 Tip: To preview an order, type \`@ETradeAgent preview buy 10 NVDA limit 125.00\``,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "screener",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case C: Order Preview Ticket with Interactive Approval Buttons (Strict HITL)
      if (domain === "trading" && action === "preview_order") {
        const row: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const orderId: string = String(row.orderId || `ord_${Date.now()}`);
        const actionStr: string = String(row.action || "BUY");
        const symbol: string = String(row.symbol || "EQUITY");
        const qty: number = Number(row.quantity) || 1;
        const total: string = String(row.estimatedTotal || "$0.00");
        const price: string = String(row.estimatedPrice || "$0.00");

        // Issue #5131: the card names the broker the approval path will execute
        // on — resolved by the same shared expression, printed by
        // `brokerPresentation`, never a literal "E*TRADE" for every tenant.
        const previewBroker = await resolveChannelBroker(this.env);
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: `⚠️ ACTION REQUIRED: Authorize ${previewBroker.presentation.label} Order Preview: ${actionStr} ${qty} ${symbol} (${total})`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `🛡️ ${previewBroker.presentation.label} Order Preview (HITL Approval Required)`,
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Order Action:*\n*${actionStr}*` },
                { type: "mrkdwn", text: `*Symbol:*\n*${symbol}*` },
                { type: "mrkdwn", text: `*Quantity:*\n${qty} shares` },
                { type: "mrkdwn", text: `*Est. Price:*\n${price}` },
                { type: "mrkdwn", text: `*Online Commission:*\n$0.00 USD` },
                { type: "mrkdwn", text: `*Total Value:*\n*${total}*` },
              ],
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Agentic HITL Safety Guarantee:*\nNo capital has been moved. An order is held in draft status in the SQLite ledger until you explicitly authorize execution.`,
              },
            },
            {
              type: "actions",
              block_id: "etrade_order_actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "✓ Approve & Submit", emoji: true },
                  style: "primary",
                  action_id: "etrade_approve_order",
                  value: orderId,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "✕ Cancel Draft", emoji: true },
                  style: "danger",
                  action_id: "etrade_cancel_order",
                  value: orderId,
                },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Draft ID: \`${orderId}\` • Trading Agent DID: \`${AGENT_DIDS.TRADING}\` • Reply \`approve ${orderId}\` or click to authorize.`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "preview",
          orderId,
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case D: Portfolio & Balances
      if (domain === "trading" && action === "positions") {
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: `${brokerLabel} Portfolio & Balance: ${nlqRes.summary}`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `💼 ${brokerLabel} Brokerage Account Overview`,
                emoji: true,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${nlqRes.summary}`,
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Reconciled against live ${brokerLabel} REST API • Stamped with Trading Agent DID`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "portfolio",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      if (domain === "research") {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        const details = rows.slice(0, 5).map((row) => {
          const label = String(row.symbol || row.company || row.companyName || "Research result");
          const fields = Object.entries(row)
            .filter(([key]) => !["symbol", "company", "companyName"].includes(key))
            .slice(0, 6)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(" · ");
          return `• *${label}*${fields ? ` — ${fields}` : ""}`;
        }).join("\n");
        const reportText = `${nlqRes.summary || "Market research completed."}${details ? `\n\n${details}` : ""}`;
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: reportText.slice(0, 3000),
          blocks: [
            { type: "header", text: { type: "plain_text", text: "Market Research Results", emoji: true } },
            { type: "section", text: { type: "mrkdwn", text: reportText.slice(0, 2900) } },
          ],
        };
        await this.postSlackMessage(blockKitMessage, deliveryStatus);
        return {
          handled: true,
          actionType: "general",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      if (domain === "trading" && ["options_screen", "options_strategies", "options_best_trade", "options_opportunities"].includes(action)) {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        const details = rows.slice(0, 5).map((row, index) => {
          const label = String(row.label || row.strategy || row.contractSymbol || row.symbol || `Result ${index + 1}`);
          const score = row.score ?? row.compositeScore;
          const reason = row.reason || row.summary || row.status;
          return `• *${label}*${score !== undefined ? ` — score ${score}` : ""}${reason ? `\n  ${String(reason).slice(0, 250)}` : ""}`;
        }).join("\n");
        const reportText = `${nlqRes.summary || "Options research completed."}${details ? `\n\n${details}` : ""}\n\nResearch only — no orders were placed.`;
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: reportText.slice(0, 3000),
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "Options Research Results", emoji: true },
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: reportText.slice(0, 2900) },
            },
          ],
        };
        await this.postSlackMessage(blockKitMessage, deliveryStatus);
        return {
          handled: true,
          actionType: "options_research",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Default Response
      blockKitMessage = {
        channel,
        thread_ts: threadTs,
        text: nlqRes.summary || "Trading Assistant ready.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: nlqRes.summary || "Hello! Ask about quotes (e.g. `quote NVDA`), screening (`screen oversold tech`), or portfolio (`show positions`).",
            },
          },
        ],
      };

      await this.postSlackMessage(blockKitMessage, deliveryStatus);

      return {
        handled: true,
        actionType: "general",
        response: blockKitMessage,
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }

    return {
      handled: false,
      actionType: "ignored",
      timestamp,
    };
  }

  /**
   * Process interactive Slack component actions (Button Clicks: Approve / Cancel)
   */
  async processSlackInteraction(payload: any): Promise<SlackInteractionResult> {
    const timestamp = new Date().toISOString();
    const action = payload.actions?.[0];
    if (!action) {
      return {
        success: false,
        actionId: "unknown",
        status: "error",
        message: "No action found in payload",
        timestamp,
      };
    }

    // Issue #1262 Phase 2: the /trade preview card's legacy button ids
    // (approve_trade / reject_trade, rendered by both the retired
    // SlackAgent handler and this service's processSlackCommand)
    // normalize to the engine's ids here — SlackAgent.handleInteraction
    // used to do this translation before delegating.
    let actionId = action.action_id;
    if (actionId === "approve_trade") actionId = "etrade_approve_order";
    if (actionId === "reject_trade") actionId = "etrade_cancel_order";
    const orderId = action.value;
    const user = payload.user || { id: "unknown", username: "user" };
    const authorizerDid = this.principal?.authorizerDid ?? `did:user:slack:${user.id}`;

    // Issue #1262 Phase 1: interactive components are gated on the
    // resolved principal before any ledger read or execution. An
    // unlinked user is refused outright; below-tier actions are refused
    // with the tier they require. (Dismiss/snap are read-level.)
    if (this.principal === null) {
      return {
        success: false,
        actionId,
        orderId,
        status: "error",
        message:
          "🔒 Your Slack user is not linked to a trading account. DM the bot `link` to get a connect code, confirm it while signed in to the trading app, and then try again.",
        timestamp,
      };
    }
    if (this.principal !== undefined) {
      const requiredTier: ChannelTier =
        actionId === "etrade_approve_order"
          ? "trade"
          : actionId === "etrade_cancel_order" ||
              actionId === "etrade_approve_options_order" ||
              actionId === "etrade_preview_options"
            ? "preview"
            // Issue #2041 S2: the journey gate authorizes proposals,
            // not execution — preview tier. Per-order trade tier
            // still applies at trade approval.
            : actionId === "saga_journey_approve" || actionId === "saga_journey_deny"
              ? "preview"
              : "read";
      if (!tierAtLeast(this.principal.tier, requiredTier)) {
        return {
          success: false,
          actionId,
          orderId,
          status: "error",
          message: `🔒 This action requires the ${requiredTier} tier; your linked principal (${this.principal.userLogin}) has ${this.principal.tier} access. Nothing was changed.`,
          timestamp,
        };
      }
    }

    const channelBroker = await resolveChannelBroker(this.env);
    // Exact pre-#5131 shape preserved: nothing selected → the legacy service;
    // a broker selected → its registry platform.
    // Exact pre-#5131 shape kept: the legacy service serves the no-selection
    // case only, and only while that default is E*TRADE (#5147).
    const useLegacyChannelService =
      channelBroker.source === "no-selection" && channelBroker.executing === "etrade";
    const tradingService: ApprovalExecutor = useLegacyChannelService
      ? new ETradeService(this.orm, this.env, this.identityLogin())
      : (TradingPlatformRegistry.getPlatform(
          channelBroker.executing,
          this.env,
          this.orm,
          this.identityLogin(),
        ) as unknown as ApprovalExecutor);

    // Issue #2041 S2: saga journey-gate buttons. The button value
    // carries the saga id (not an order id); the decider is the
    // linked principal's login. Owner check first (pending gate
    // for this login): a foreign or missing gate is refused here
    // rather than sending an event the flow would refuse — the
    // user gets an honest answer, not a false acceptance.
    // Delivery goes through the single deliverJourneyDecision
    // helper (same path as the panel/chat routes); the flow
    // re-validates owner as defense in depth. The response_url
    // edit IS the Slack-surface cleanup on the decide path.
    if (actionId === "saga_journey_approve" || actionId === "saga_journey_deny") {
      const sagaId = orderId;
      const deciderLogin = this.identityLogin();
      const decision = actionId === "saga_journey_approve" ? "approved" : "denied";
      const editOriginal = async (text: string): Promise<void> => {
        if (payload.response_url) {
          await this.postResponseUrl(payload.response_url, {
            text,
            blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
            replace_original: true,
          });
        }
      };
      let pending = false;
      let decidedBy: string | null = null;
      try {
        const stub = sagaAuditOwnerStub(this.env);
        const gates = await listPendingJourneyGates(stub, deciderLogin);
        pending = gates.some((g) => g.sagaId === sagaId);
        if (!pending) {
          const decided = await findDecidedJourneyGate(stub, sagaId);
          decidedBy = decided?.decidingSurface ?? null;
        }
      } catch (err) {
        return {
          success: false,
          actionId,
          orderId: sagaId,
          status: "error",
          message: `Journey gate lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp,
        };
      }
      if (decidedBy !== null) {
        const text = `⏭️ Already decided (by ${decidedBy}) — this answer was refused as superseded.`;
        await editOriginal(text);
        return {
          success: false,
          actionId,
          orderId: sagaId,
          status: "superseded",
          message: text,
          timestamp,
        };
      }
      if (!pending) {
        return {
          success: false,
          actionId,
          orderId: sagaId,
          status: "error",
          message: "No pending journey gate for this saga under your login.",
          timestamp,
        };
      }
      let result;
      try {
        result = await deliverJourneyDecision(
          this.env.SAGA_WORKFLOW as unknown as SagaJourneyBinding,
          { sagaId, decision: { sagaId, decision, deciderLogin, surface: "slack" } },
        );
      } catch (err) {
        return {
          success: false,
          actionId,
          orderId: sagaId,
          status: "error",
          message: `Journey decision could not be delivered: ${err instanceof Error ? err.message : String(err)}`,
          timestamp,
        };
      }
      if (!result.accepted) {
        const text = `⏭️ Already decided (by ${result.decidedBy}) — this answer was refused as superseded.`;
        await editOriginal(text);
        return {
          success: false,
          actionId,
          orderId: sagaId,
          status: "superseded",
          message: text,
          timestamp,
        };
      }
      const text =
        decision === "approved"
          ? "✅ Journey approved — the saga will enter the trading leg. Each trade will still ask for its own approval."
          : "❌ Journey declined — the saga ends with no trades and no proposals.";
      await editOriginal(text);
      return {
        success: true,
        actionId,
        orderId: sagaId,
        status: "decided",
        message: text,
        timestamp,
      };
    }

    // 1. Approve & Execute the Order
    if (actionId === "etrade_approve_order") {
      // Issue #1262 Phase 3: button approvals run through the shared
      // engine. Exactly the button's order id — never the latest
      // previewed draft. (The tier gate above already refused
      // below-trade principals; the engine re-gates defensively.)
      const outcome = await approvePreviewedOrder({
        trades: this.orm?.trades ?? null,
        executor: tradingService,
        principal: this.principal,
        authorizerDid,
        userLogin: this.identityLogin(),
        orderId,
        allowLatestFallback: false,
        timestamp,
      });
      if (outcome.kind === "tier_refused") {
        return {
          success: false,
          actionId,
          orderId,
          status: "error",
          message: outcome.reason,
          timestamp,
        };
      }
      if (outcome.kind === "not_found") {
        return {
          success: false,
          actionId,
          orderId,
          status: "error",
          message: `Order ${orderId} not found in database ledger.`,
          timestamp,
        };
      }
      if (outcome.kind === "not_previewed") {
        return {
          success: false,
          actionId,
          orderId,
          status: "error",
          message: `Order ${orderId} is already in ${outcome.trade.status.toUpperCase()} status.`,
          timestamp,
        };
      }

      const targetTrade = outcome.trade;
      const isSuccess = outcome.kind === "executed";
      const execId = outcome.execId ?? `et_order_${Date.now()}`;
      const execMessage = outcome.kind === "failed" ? outcome.message : undefined;

      const replacementBlocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: isSuccess
              ? `✅ ORDER EXECUTED ON ${channelBroker.presentation.label}`
              : `❌ ${channelBroker.presentation.label} EXECUTION FAILED`,
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Action:*\n${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}` },
            { type: "mrkdwn", text: `*Broker Order ID:*\n\`${execId}\`` },
            { type: "mrkdwn", text: `*Execution Total:*\n$${targetTrade.totalValue.toFixed(2)} USD` },
            { type: "mrkdwn", text: `*Authorizer:*\n<@${user.id}>` },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Status: *${isSuccess ? "EXECUTED" : "REJECTED"}* • Stamped with Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • ${timestamp}`,
            },
          ],
        },
      ];

      // Auto-dispatch visual snap receipt to Slack on successful execution
      if (isSuccess) {
        try {
          const browserService = new ETradeBrowserService(this.env);
          await browserService.sendTransactionSnapToSlack({
            transactionId: targetTrade.id,
            symbol: targetTrade.symbol,
            action: targetTrade.action,
            quantity: targetTrade.quantity,
            price: targetTrade.price,
            orderType: targetTrade.orderType,
            status: "EXECUTED",
            totalValue: targetTrade.totalValue,
            environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
            timestamp,
            // This dispatch follows the human's approve interaction — a
            // recorded HITL approval (issue #120).
            humanApproved: true,
          }, { channel: payload.channel?.id });
        } catch (snapErr) {
          structuredLog.warn("slackAgent.snap_receipt_delivery_failed", {
            message: "[ETradeSlackAgent] Could not deliver snap receipt",
            handler: "processSlackInteraction",
            error: snapErr instanceof Error ? snapErr.message : String(snapErr),
          });
        }
      }

      // Update message in Slack if response_url is available
      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: isSuccess ? `✅ Order ${orderId} executed on ${channelBroker.presentation.label}` : `❌ Execution failed for order ${orderId}`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: isSuccess,
        actionId,
        orderId,
        status: isSuccess ? "executed" : "error",
        message: isSuccess ? `Order successfully routed to ${channelBroker.presentation.label} (Ref: ${execId})` : (execMessage || "Failed"),
        replacementBlocks,
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        timestamp,
      };
    }

    // Snap Trade Button Action
    if (actionId === "snap_trade" || actionId === "etrade_snap_order") {
      let targetTrade: any = null;
      if (this.orm?.trades && orderId) {
        targetTrade = this.orm.trades.findById(orderId);
      }
      if (targetTrade) {
        const browserService = new ETradeBrowserService(this.env);
        const snapRes = await browserService.sendTransactionSnapToSlack({
          transactionId: targetTrade.id,
          symbol: targetTrade.symbol,
          action: targetTrade.action,
          quantity: targetTrade.quantity,
          price: targetTrade.price,
          orderType: targetTrade.orderType,
          status: targetTrade.status,
          totalValue: targetTrade.totalValue,
          environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
          timestamp: targetTrade.updatedAt || targetTrade.createdAt,
          humanApproved: Boolean((targetTrade as any).authorizerDid),
        }, { channel: payload.channel?.id });

        return {
          success: snapRes.success,
          actionId,
          orderId,
          status: "executed",
          message: snapRes.success ? `Snapshot for ${targetTrade.symbol} delivered to Slack!` : `Not delivered — ${snapRes.error || "Failed"}`,
          timestamp,
        };
      }
    }

    // 2. Cancel Draft Order
    if (actionId === "etrade_cancel_order") {
      // Issue #1262 Phase 3: through the shared engine (by-id update,
      // no authorizer stamp — exactly as before; the preview-tier gate
      // above already applied).
      const cancelOutcome = cancelPreviewedOrder({
        trades: this.orm?.trades ?? null,
        principal: this.principal,
        orderId,
        lookup: "by_id",
        timestamp,
      });
      if (cancelOutcome.kind === "tier_refused") {
        return {
          success: false,
          actionId,
          orderId,
          status: "error",
          message: cancelOutcome.reason,
          timestamp,
        };
      }

      const replacementBlocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "❌ ORDER DRAFT CANCELLED",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Order draft \`${orderId}\` was cancelled by <@${user.id}>. No capital was moved and no order was routed to ${channelBroker.presentation.label}.`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Status: *CANCELLED* • Authorizer: \`${authorizerDid}\` • ${timestamp}`,
            },
          ],
        },
      ];

      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: `❌ Order ${orderId} cancelled`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: true,
        actionId,
        orderId,
        status: "rejected",
        message: `Order draft ${orderId} cancelled by user`,
        replacementBlocks,
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        timestamp,
      };
    }

    // 3. Approve & Preview Options Strategy Order from Scheduled or Omnichannel Alert
    if (actionId === "etrade_approve_options_order" || actionId === "etrade_preview_options") {
      let optData: any = {};
      try {
        optData = JSON.parse(orderId || "{}");
      } catch {
        optData = { symbol: orderId, strategy: "Options Strategy" };
      }
      const sym = optData.symbol || "OPTIONS";
      const strat = optData.strategy || "Strategy";
      const legsCount = Array.isArray(optData.legs) ? optData.legs.length : 1;

      // Create an order draft in SQLite if ORM is available. Issue #2165:
      // the draft row IS the queue entry for the broker routing — a failed
      // create must fail loudly (error post + failure result + audit),
      // never the QUEUED claim with no record behind it.
      const draftId = `opt_${sym}_${Date.now()}`;
      let draftError: Error | null = null;
      if (this.orm?.trades) {
        try {
          this.orm.trades.create({
            id: draftId,
            sessionId: this.sessionId,
            symbol: sym,
            action: (optData.action || "BUY").toUpperCase(),
            quantity: 1,
            price: 0,
            orderType: "LIMIT",
            status: "previewed",
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid,
            proofSignature: `sig_slack_opt_${draftId}`,
            totalValue: optData.maxLoss || 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        } catch (err) {
          draftError = err instanceof Error ? err : new Error(String(err));
        }
      }

      if (draftError) {
        const message = `Options order draft ${draftId} for ${sym} failed to persist: ${draftError.message}`;
        // Audit the failure. Fail-visible, never masking: an audit-write
        // failure warns on the worker-log channel and the draft failure
        // result below still stands.
        // #6102: the row writes to D1 now; a null port (AGENT_DB
        // unbound) skips, a failed write warns via the catch below.
        try {
          const port = await auditEventPort(
            this.env as unknown as { AGENT_DB?: unknown },
          );
          if (port) {
            await port.create({
              id: crypto.randomUUID(),
              sessionId: this.sessionId,
              type: "trade.options_draft_create_failed",
              agent: "trading",
              payload: {
                draftId,
                symbol: sym,
                strategy: strat,
                error: draftError.message,
                authorizerDid,
              },
              createdAt: timestamp,
            });
          }
        } catch (auditErr) {
          structuredLog.warn("slackAgent.options_draft_audit_failed", {
            message: `[ETradeSlackAgent] Audit insertion failed (type=trade.options_draft_create_failed, draft=${draftId}): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            draftId,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }

        const errorBlocks = [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "❌ OPTIONS ORDER DRAFT FAILED",
              emoji: true,
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Underlying Symbol:*\n*${sym}*` },
              { type: "mrkdwn", text: `*Strategy:*\n*${strat}*` },
              { type: "mrkdwn", text: `*Draft ID:*\n\`${draftId}\`` },
              { type: "mrkdwn", text: `*Error:*\n${draftError.message}` },
            ],
          },
        ];

        if (payload.response_url) {
          await this.postResponseUrl(payload.response_url, {
            text: `❌ Options order draft failed for ${sym} (${strat})`,
            blocks: errorBlocks,
            replace_original: true,
          });
        }

        return {
          success: false,
          actionId,
          orderId: draftId,
          status: "error",
          message,
          timestamp,
        };
      }

      const replacementBlocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "✅ OPTIONS ORDER PREVIEW APPROVED & QUEUED",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Underlying Symbol:*\n*${sym}*` },
            { type: "mrkdwn", text: `*Strategy:*\n*${strat}*` },
            { type: "mrkdwn", text: `*Legs:*\n${legsCount} option leg(s)` },
            { type: "mrkdwn", text: `*Draft ID:*\n\`${draftId}\`` },
            { type: "mrkdwn", text: `*Authorizer:*\n<@${user.id}>` },
            { type: "mrkdwn", text: `*Status:*\n*QUEUED FOR ROUTING*` },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Draft ID: \`${draftId}\` • Trading Agent DID: \`${AGENT_DIDS.TRADING}\` • ${timestamp}`,
            },
          ],
        },
      ];

      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: `✅ Options strategy order preview for ${sym} (${strat}) approved by <@${user.id}>`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: true,
        actionId,
        orderId: draftId,
        status: "executed",
        message: `Options order draft ${draftId} for ${sym} approved by user`,
        replacementBlocks,
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        timestamp,
      };
    }

    // 4. Dismiss Options Alert
    if (actionId === "etrade_dismiss_options_alert") {
      const replacementBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `ℹ️ Options alert for *${orderId || "symbol"}* dismissed by <@${user.id}>.`,
          },
        },
      ];

      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: `Options alert dismissed`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: true,
        actionId,
        status: "rejected",
        message: "Options alert dismissed",
        replacementBlocks,
        timestamp,
      };
    }

    return {
      success: false,
      actionId,
      orderId,
      status: "error",
      message: `Unknown action_id: ${actionId}`,
      timestamp,
    };
  }

  /**
   * Issue #1262 Phase 2: slash commands run through THIS service — the
   * single Slack parser. Ported from SlackAgent.handleSlashCommand
   * (retired) with two changes: NLQ runs under the resolved principal
   * (Phase 1 — the old handler passed the DO instance id as userLogin)
   * with full deps + untrustedContent (Phase 4), and commands are tier
   * gated (/trade previews need preview tier; everything else is read
   * level; unlinked users get an ephemeral refusal + link hint).
   * Response shapes (response_type, cards, texts) are unchanged.
   */
  async processSlackCommand(formData: FormData): Promise<Response> {
    const command = ((formData.get("command") as string) || "").trim().toLowerCase();
    // #1763 (SEC-005): same entrypoint sanitization as events.
    const text = sanitizeInboundText(((formData.get("text") as string) || "").trim());
    const channelId = (formData.get("channel_id") as string) || "";
    const userId = (formData.get("user_id") as string) || "unknown_user";
    const responseUrl = (formData.get("response_url") as string) || "";
    void responseUrl;
    // Issue #5148: the slash-command cards name the broker this surface resolves.
    const commandBrokerLabel = (await resolveChannelBroker(this.env)).presentation.label;

    if (this.principal === null) {
      return Response.json({
        response_type: "ephemeral",
        text:
          "🔒 Your Slack user is not linked to a trading account, so I can't run that. " +
          "DM me `link` to get a connect code, confirm it while signed in to the trading app, and then try again.",
      });
    }
    const commandPrincipal = this.principal;
    const requireTier = (minimum: ChannelTier): Response | null => {
      if (commandPrincipal !== undefined && !tierAtLeast(commandPrincipal.tier, minimum)) {
        return Response.json({
          response_type: "ephemeral",
          text: `🔒 This command requires the ${minimum} tier; your linked principal (${commandPrincipal.userLogin}) has ${commandPrincipal.tier} access. Nothing was changed.`,
        });
      }
      return null;
    };
    const did = this.principal?.authorizerDid ?? `did:user:slack:${userId}`;

    // 1. /snap [symbol or orderId]
    if (command === "/snap" || command.endsWith("/snap")) {
      const target = text.toUpperCase() || "SPY";
      const isOrderId = target.startsWith("ORD_") || target.startsWith("TRD_");
      const browserService = new ETradeBrowserService(this.env);

      const trades = this.orm?.trades;
      if (isOrderId && trades) {
        const trade = trades.findById(target.toLowerCase()) || trades.findById(target);
        if (trade) {
          const snapRes = await browserService.sendTransactionSnapToSlack(
            {
              transactionId: trade.id,
              symbol: trade.symbol,
              action: trade.action,
              quantity: trade.quantity,
              price: trade.price,
              orderType: trade.orderType,
              status: trade.status,
              totalValue: trade.totalValue,
              environment: this.env.ETRADE_ENVIRONMENT || "sandbox",
              timestamp: trade.updatedAt || trade.createdAt,
              // Issue #120: the receipt may claim HITL verification only when
              // an approval was actually recorded for this trade.
              humanApproved: Boolean((trade as any).authorizerDid),
            },
            { channel: channelId }
          );
          return Response.json({
            response_type: "in_channel",
            text: `📸 Transaction snapshot generated for ${trade.symbol} (${trade.id}): ${snapRes.success ? "Posted to Slack" : `Not delivered — ${snapRes.error}`}`,
          });
        }
      }

      // Default: Chart / market snapshot for symbol
      const chartUrl = `https://finance.yahoo.com/quote/${target}`;
      const snapRes = await browserService.captureAndSendToSlack(chartUrl, {
        channel: channelId,
        caption: `Market chart snapshot for ${target} requested by <@${userId}> via /snap`,
      });
      return Response.json({
        response_type: "in_channel",
        text: `📸 Browser Agent snapshot for ${target}: ${snapRes.success ? "Delivered to Slack" : `Not delivered — ${snapRes.error}`}`,
      });
    }

    // 2. /quote [symbol]
    if (command === "/quote" || command.endsWith("/quote")) {
      const gated = requireTier("read");
      if (gated) return gated;
      const orm = requireOrm(this.orm, "ETradeSlackTradingService.processSlackCommand");
      const symbol = text.toUpperCase() || "NVDA";
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        `quote ${symbol}`,
        this.env,
        this.identityLogin(),
        did,
        this.nlqOptions()
      );
      const q = result.rows?.[0] || {};
      const payload: SlackBlockKitPayload = {
        channel: channelId,
        text: `Quote for ${symbol}: ${q.lastPrice || "N/A"} (${q.change || "N/A"})`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `📈 ${commandBrokerLabel} Quote: ${symbol}`, emoji: true },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Last Price:*\n*${q.lastPrice || "$0.00"}*` },
              { type: "mrkdwn", text: `*24h Change:*\n${q.change || "0.00%"}` },
              { type: "mrkdwn", text: `*Bid / Ask:*\n${q.bidAsk || "N/A"}` },
              { type: "mrkdwn", text: `*Volume:*\n${q.volume || "N/A"}` },
            ],
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `Requested by <@${userId}> • Attested by Slack Agent (\`${AGENT_DIDS.TRADING}\`)` },
            ],
          },
        ],
      };
      return Response.json(payload);
    }

    // 3. /trade [action] [qty] [symbol] [type] [price]
    if (command === "/trade" || command.endsWith("/trade")) {
      const gated = requireTier("preview");
      if (gated) return gated;
      const orm = requireOrm(this.orm, "ETradeSlackTradingService.processSlackCommand");
      const prompt = `preview ${text || "buy 1 NVDA"}`;
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        prompt,
        this.env,
        this.identityLogin(),
        did,
        this.nlqOptions()
      );
      const row = result.rows?.[0] || {};
      const orderId = String(row.orderId || `ord_${Date.now()}`);
      const action = String(row.action || "BUY").toUpperCase();
      const symbol = String(row.symbol || "EQUITY").toUpperCase();
      const qty = row.quantity || 1;
      const total = row.estimatedTotal || "$0.00";
      // Issue #5131: the slash-command card names the selected broker too.
      const previewBroker = await resolveChannelBroker(this.env);
      const payload: SlackBlockKitPayload = {
        channel: channelId,
        text: `⚠️ Action Required: Authorize ${previewBroker.presentation.label} Order Preview: ${action} ${qty} ${symbol} (${total})`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `⚠️ Order Preview Ticket: ${action} ${symbol}`, emoji: true },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Symbol:*\n*${symbol}*` },
              { type: "mrkdwn", text: `*Action:*\n*${action}*` },
              { type: "mrkdwn", text: `*Quantity:*\n${qty}` },
              { type: "mrkdwn", text: `*Estimated Total:*\n*${total}*` },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✓ Approve & Submit", emoji: true },
                style: "primary",
                value: orderId,
                action_id: "approve_trade",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "✕ Reject Draft", emoji: true },
                style: "danger",
                value: orderId,
                action_id: "reject_trade",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "📸 Snap Receipt", emoji: true },
                value: orderId,
                action_id: "snap_trade",
              },
            ],
          },
        ],
      };
      return Response.json(payload);
    }

    // 4. /portfolio
    if (command === "/portfolio" || command.endsWith("/portfolio")) {
      const gated = requireTier("read");
      if (gated) return gated;
      const orm = requireOrm(this.orm, "ETradeSlackTradingService.processSlackCommand");
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        "show portfolio",
        this.env,
        this.identityLogin(),
        did,
        this.nlqOptions()
      );
      return Response.json({
        response_type: "ephemeral",
        text: `💼 Portfolio Summary: ${result.summary || "Retrieved account balances and positions."}`,
      });
    }

    // 5. /options [symbol] [thesis]
    if (command === "/options" || command.endsWith("/options")) {
      const gated = requireTier("read");
      if (gated) return gated;
      const orm = requireOrm(this.orm, "ETradeSlackTradingService.processSlackCommand");
      const parts = text.split(/\s+/);
      const symbol = (parts[0] || "SPY").toUpperCase();
      const thesis = parts[1] || "bullish";
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        `options ${symbol} ${thesis}`,
        this.env,
        this.identityLogin(),
        did,
        this.nlqOptions()
      );
      return Response.json({
        response_type: "in_channel",
        text: `📊 Options Intelligence for ${symbol} (${thesis}): ${result.summary}`,
      });
    }

    // Default /help
    return Response.json({
      response_type: "ephemeral",
      text: `🤖 *${commandBrokerLabel} Slack Trading Agent Commands:*\n` +
        "• `/trade buy 10 NVDA limit 130.00` - Create interactive order preview with HITL approval buttons\n" +
        "• `/quote AAPL` - Live market quote card\n" +
        "• `/snap SPY` or `/snap ORD_123` - Command Browser Agent to take visual snapshot & deliver to Slack\n" +
        "• `/options NVDA bullish` - AI options strategy recommendation\n" +
        "• `/portfolio` - Account balances and open positions\n" +
        "• `@ETradeAgent <question>` - Conversational analysis in channel thread",
    });
  }

  /**
   * Dispatches a Pre-Trade Approval Ticket Block Kit card to Slack (Strict HITL Gate)
   * Before executing any trade, a message must be sent to Slack and approved.
   */
  async sendPreTradeApprovalTicket(
    draft: PreTradeApprovalDraft,
    options: { channel?: string; threadTs?: string; webhookUrl?: string } = {}
  ): Promise<{ success: boolean; payload: SlackBlockKitPayload; orderId: string }> {
    const orderId = draft.orderId;
    const actionStr = (draft.action || "BUY").toUpperCase();
    const symbol = (draft.symbol || "EQUITY").toUpperCase();
    const qty = Number(draft.quantity) || 1;
    const orderType = draft.orderType || "MARKET";
    const priceStr = typeof draft.estimatedPrice === "number"
      ? `$${draft.estimatedPrice.toFixed(2)}`
      : String(draft.estimatedPrice || (draft.limitPrice ? `$${draft.limitPrice.toFixed(2)}` : "Market"));
    const totalStr = typeof draft.estimatedTotal === "number"
      ? `$${draft.estimatedTotal.toFixed(2)}`
      : String(draft.estimatedTotal || "$0.00");
    const proposerDid = draft.proposerDid || AGENT_DIDS.TRADING;
    const channel = options.channel || draft.channel;
    // Issue #5131: the shared HITL card names the broker the approval path will
    // execute on, not the first broker in the catalogue.
    const brokerLabel = (await resolveChannelBroker(this.env)).presentation.label;

    const payload: SlackBlockKitPayload = {
      channel,
      thread_ts: options.threadTs,
      text: `⚠️ ACTION REQUIRED: Authorize ${brokerLabel} Order Preview: ${actionStr} ${qty} ${symbol} (${totalStr})`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🛡️ Pre-Trade Authorization Required: ${actionStr} ${symbol}`,
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Order Action:*\n*${actionStr}*` },
            { type: "mrkdwn", text: `*Symbol:*\n*${symbol}*` },
            { type: "mrkdwn", text: `*Quantity:*\n${qty} shares` },
            { type: "mrkdwn", text: `*Est. Price:*\n${priceStr}` },
            { type: "mrkdwn", text: `*Order Type:*\n${orderType}` },
            { type: "mrkdwn", text: `*Total Value:*\n*${totalStr}*` },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Agentic HITL Safety Guarantee:*\nAutonomous trade execution is strictly blocked. No capital has been moved. An order draft is held in the SQLite ledger (\`${orderId}\`). Before executing this trade, human authorization in Slack is required.`,
          },
        },
        {
          type: "actions",
          block_id: "etrade_order_actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "✓ Approve & Submit", emoji: true },
              style: "primary",
              action_id: "etrade_approve_order",
              value: orderId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "✕ Cancel Draft", emoji: true },
              style: "danger",
              action_id: "etrade_cancel_order",
              value: orderId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "📸 Snap Receipt", emoji: true },
              action_id: "snap_trade",
              value: orderId,
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Draft ID: \`${orderId}\` • Proposer DID: \`${proposerDid}\` • Reply \`approve ${orderId}\` or click to authorize.`,
            },
          ],
        },
      ],
    };

    const delivered = await this.postSlackMessage(payload);
    return {
      success: delivered,
      payload,
      orderId,
    };
  }

  /**
   * Post message to Slack using Webhook and/or chat.postMessage API (Dual Delivery)
   * Patterned after cfpay & Cloudflare Agents Slack integration
   */
  async postSlackMessage(payload: SlackBlockKitPayload, deliveryStatus?: string): Promise<boolean> {
    if (deliveryStatus) {
      payload.text = `${payload.text}\n\n${deliveryStatus}`;
      payload.blocks = [
        ...(payload.blocks || []),
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: deliveryStatus }],
        },
      ];
    }
    const token = this.env.SLACK_BOT_TOKEN;
    const webhookUrl = this.env.SLACK_WEBHOOK_URL;
    const cfpay = getCfpayConfig(this.env);

    if (!token && !webhookUrl && !cfpay) {
      // In local or test mode, message is returned in result
      return false;
    }

    let delivered = false;

    // 1. Deliver to incoming Webhook if configured
    if (webhookUrl) {
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          delivered = true;
        }
      } catch (err) {
        structuredLog.warn("slackAgent.webhook_delivery_failed", {
          message: "[ETradeSlackAgent] webhook delivery failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Deliver via Bot API chat.postMessage if token is configured
    if (token) {
      try {
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          delivered = true;
        }
      } catch (err) {
        structuredLog.warn("slackAgent.chat_post_message_failed", {
          message: "[ETradeSlackAgent] chat.postMessage failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Deliver via cfpay A2A Slack agent if configured
    if (cfpay) {
      try {
        const channel = (payload as any).channel ||
          (this.env as any).SLACK_CHANNEL ||
          (this.env as any).SCREENER_SLACK_CHANNEL;
        const res = await cfpayPostToSlack(cfpay, payload.text, channel);
        if (res.ok) {
          delivered = true;
        }
      } catch (err) {
        structuredLog.warn("slackAgent.cfpay_slack_post_failed", {
          message: "[ETradeSlackAgent] cfpay A2A slack.post failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return delivered;
  }

  /**
   * Replace or update an interactive message via Slack response_url
   */
  async postResponseUrl(responseUrl: string, payload: SlackBlockKitPayload): Promise<boolean> {
    try {
      const res = await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch (err) {
      structuredLog.warn("slackAgent.post_response_url_failed", {
        message: "[ETradeSlackAgent] postResponseUrl failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Generate Slack OAuth installation URL
   */
  static getInstallUrl(clientId: string, redirectUri: string): string {
    const scopes = [
      "chat:write",
      "chat:write.public",
      "channels:history",
      "app_mentions:read",
      "im:write",
      "im:history",
    ].join(",");

    return `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(
      clientId
    )}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  /**
   * Exchange Slack OAuth code for bot access token
   */
  static async exchangeOAuthCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string
  ): Promise<{ accessToken: string; teamId: string; teamName: string; botUserId: string }> {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const json = (await res.json()) as any;
    if (!json.ok) {
      throw new Error(`Slack OAuth exchange failed: ${json.error || "Unknown error"}`);
    }

    return {
      accessToken: json.access_token,
      teamId: json.team?.id,
      teamName: json.team?.name,
      botUserId: json.bot_user_id,
    };
  }
}
