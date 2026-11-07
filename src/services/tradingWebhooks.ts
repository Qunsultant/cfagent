/**
 * Cloudflare Agents Trading Webhooks Communication Channel
 * Repurposed from Cloudflare Agents Webhooks standard:
 * https://developers.cloudflare.com/agents/communication-channels/webhooks/
 *
 * Implements:
 * - Inbound TradingView PineScript alerts with HMAC-SHA256 & passphrase verification
 * - Inbound E*TRADE broker notifications (order filled, cancelled, execution alerts)
 * - Replay protection: provider-derived nonces claimed in a durable SQLite
 *   nonce cache (issue #143 P0) — replays are rejected with 409. The audit
 *   trail records processed events but is not the dedupe mechanism.
 * - Outbound HMAC-SHA256 signed trading webhooks to external subscriber systems
 * - Real-time WebSocket event broadcasting to connected trading desks
 */

import type {
  Env,
  TradingViewWebhookPayload,
  ETradeWebhookPayload,
  TradingWebhookEvent,
  OutboundWebhookConfig,
} from "../types";
import { DatabaseORM } from "../orm";
import { AGENT_DIDS, createDidAttestation } from "../agents/did";
import { ETradeService } from "./etrade";

import { verifyHmacSha256Signature, assertSafeOutboundWebhookUrl } from "../security/webhookSecurity";
import { checkSlackWebhookRateLimit, isSlackWebhookUrl } from "./slackWebhookRateLimit";
import {
  deriveTradingViewNonce,
  deriveETradeNonce,
  OrmReplayStore,
  sharedMemoryReplayStore,
  type ReplayStore,
} from "../security/webhookReplay";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/tradingWebhooks",
});


export class ETradeWebhookService {
  constructor(
    private orm?: DatabaseORM,
    private env?: Env,
    private sessionId: string = "webhook_trading_agent"
  ) {}

  /**
   * Verify HMAC-SHA256 webhook signature using Web Crypto API.
   * Fails closed: with no secret configured this returns false
   * (issue #140) — it never reports an unverifiable caller as verified.
   */
  async verifySignature(rawBody: string, signature: string | null, secret?: string): Promise<boolean> {
    return verifyHmacSha256Signature(rawBody, signature, secret);
  }

  /**
   * Replay-protection store for inbound webhooks (issue #143 P0).
   * Prefers the durable ORM-backed store; without an ORM only the
   * isolate-scoped memory fallback is available (signature + timestamp
   * windows remain the primary control in that case).
   */
  private replayStore(): ReplayStore {
    if (this.orm) return new OrmReplayStore(this.orm);
    structuredLog.warn("tradingWebhooks.replay_store_memory_fallback", {
      message:
        "[ETradeWebhookService] No ORM configured: inbound webhook replay protection " +
        "uses an isolate-scoped memory fallback (not durable across isolates).",
    });
    return sharedMemoryReplayStore();
  }

  /**
   * Inbound Webhook: Process TradingView Pine Script Alert
   */
  async processTradingViewAlert(
    rawBody: string,
    headers: Headers | Record<string, string>,
    userLogin: string = "trader_default"
  ): Promise<{
    success: boolean;
    statusCode: number;
    eventId: string;
    message: string;
    orderDraftId?: string;
    orderStatus?: string;
  }> {
    const signature =
      headers instanceof Headers
        ? headers.get("X-TradingView-Signature") || headers.get("x-signature-256")
        : (headers["X-TradingView-Signature"] || headers["x-signature-256"] || headers["x-hub-signature-256"]);

    const secret = this.env?.TRADINGVIEW_WEBHOOK_SECRET;
    if (!secret) {
      // Issue #140: unconfigured is a configuration error (503), not a
      // bad signature — and never a pass. The verifier below also fails
      // closed on a missing secret; this branch exists so operators see
      // the real reason instead of a misleading "invalid signature".
      return {
        success: false,
        statusCode: 503,
        eventId: `tv_err_${Date.now()}`,
        message: "TRADINGVIEW_WEBHOOK_SECRET is not configured; TradingView alert rejected.",
      };
    }
    const isValid = await this.verifySignature(rawBody, signature, secret);

    if (!isValid) {
      return {
        success: false,
        statusCode: 401,
        eventId: `tv_err_${Date.now()}`,
        message: "Invalid TradingView webhook signature.",
      };
    }

    let payload: TradingViewWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return {
        success: false,
        statusCode: 400,
        eventId: `tv_err_${Date.now()}`,
        message: "Malformed JSON payload in TradingView webhook.",
      };
    }

    // Verify passphrase if configured in payload
    if (secret && payload.passphrase && payload.passphrase !== secret) {
      return {
        success: false,
        statusCode: 403,
        eventId: `tv_err_${Date.now()}`,
        message: "Invalid TradingView passphrase.",
      };
    }

    // Issue #143 P0: replay protection. The module docstring previously
    // claimed "event deduplication using unique event IDs", but the ID was
    // minted fresh per call, so a replayed (still validly signed) alert
    // inside the window would be processed — and drafted — twice.
    const replayNonce = await deriveTradingViewNonce(signature, rawBody);
    if (await this.replayStore().claim(replayNonce, "tradingview")) {
      return {
        success: false,
        statusCode: 409,
        eventId: replayNonce,
        message: "Duplicate TradingView alert rejected: this event was already processed (replay protection).",
      };
    }

    const eventId = `tv_evt_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const ticker = (payload.ticker || "").toUpperCase().replace(/US:|\.US/gi, "").trim();
    const action = payload.action === "SELL" ? "SELL" : "BUY";
    const qty = Number(payload.quantity) || 1;
    const price = payload.price ? Number(payload.price) : undefined;
    const orderType = payload.orderType || (price ? "LIMIT" : "MARKET");

    // Persist event in SQLite for deduplication & audit trail
    if (this.orm?.events) {
      this.orm.events.create({
        id: eventId,
        sessionId: this.sessionId,
        type: "WEBHOOK_TRADINGVIEW_ALERT",
        agent: "webhook",
        payload: { ...payload } as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      });
    }

    // Automatically draft order in E*TRADE trading engine with Agent DID attestation
    // Issue #922 ([#913 S4]): in the live env the quote step now fails
    // explicit instead of drafting off a curated static price, so a draft
    // can no longer be assumed here — convert that failure into the
    // handler's structured failure response instead of an uncaught throw.
    const tradingService = new ETradeService(this.orm, this.env, userLogin);
    let draft: ReturnType<ETradeService["previewOrder"]>;
    try {
      draft = tradingService.previewOrder({
        symbol: ticker,
        action,
        quantity: qty,
        orderType,
        limitPrice: price,
        sessionId: userLogin,
      });
    } catch (err) {
      return {
        success: false,
        statusCode: 502,
        eventId,
        message: `TradingView alert could not be drafted: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      success: true,
      statusCode: 200,
      eventId,
      message: `TradingView signal received for ${action} ${qty} ${ticker}. Order draft created: ${draft.orderId}.`,
      orderDraftId: draft.orderId,
      orderStatus: draft.status,
    };
  }

  /**
   * Inbound Webhook: Process E*TRADE Broker Notifications (Fills, Cancellations)
   */
  async processETradeBrokerWebhook(
    rawBody: string,
    headers: Headers | Record<string, string>
  ): Promise<{ success: boolean; statusCode: number; eventId: string; message: string }> {
    const signature =
      headers instanceof Headers
        ? headers.get("X-ETrade-Signature")
        : (headers["X-ETrade-Signature"] || headers["x-etrade-signature"]);

    const secret = this.env?.ETRADE_WEBHOOK_SECRET;
    if (!secret) {
      // Issue #140: same fail-closed configuration error as the
      // TradingView processor — an unconfigured secret must never let
      // a caller mutate stored order state as a "verified" broker event.
      return {
        success: false,
        statusCode: 503,
        eventId: `et_err_${Date.now()}`,
        message: "ETRADE_WEBHOOK_SECRET is not configured; broker notification rejected.",
      };
    }
    const isValid = await this.verifySignature(rawBody, signature, secret);

    if (!isValid) {
      return {
        success: false,
        statusCode: 401,
        eventId: `et_err_${Date.now()}`,
        message: "Invalid E*TRADE webhook signature.",
      };
    }

    let payload: ETradeWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return {
        success: false,
        statusCode: 400,
        eventId: `et_err_${Date.now()}`,
        message: "Malformed JSON payload in E*TRADE webhook.",
      };
    }

    // Issue #143 P0: replay protection. A repeated broker notification for
    // the same order+event+timestamp must not re-mutate stored order state.
    const replayNonce = await deriveETradeNonce(payload, signature, rawBody);
    if (await this.replayStore().claim(replayNonce, "etrade")) {
      return {
        success: false,
        statusCode: 409,
        eventId: replayNonce,
        message: "Duplicate E*TRADE broker notification rejected (replay protection).",
      };
    }

    const eventId = `et_evt_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();

    // Update matching order in SQLite
    if (this.orm?.trades && payload.orderId) {
      const existing = this.orm.trades.findById(payload.orderId);
      if (existing) {
        let newStatus = existing.status;
        if (payload.eventType === "ORDER_FILLED") newStatus = "executed";
        if (payload.eventType === "ORDER_CANCELLED") newStatus = "cancelled";
        if (payload.eventType === "ORDER_REJECTED") newStatus = "rejected";

        this.orm.trades.update(payload.orderId, {
          status: newStatus,
          updatedAt: now,
        });
      }
    }

    // Persist event in mas_events
    if (this.orm?.events) {
      this.orm.events.create({
        id: eventId,
        sessionId: this.sessionId,
        type: `ETRADE_${payload.eventType}`,
        agent: "broker_webhook",
        payload: { ...payload } as Record<string, unknown>,
        createdAt: now,
      });
    }

    return {
      success: true,
      statusCode: 200,
      eventId,
      message: `E*TRADE ${payload.eventType} processed for order ${payload.orderId || "unknown"}.`,
    };
  }

  /**
   * Outbound Webhook: Dispatch HMAC-SHA256 signed event to subscriber URLs
   */
  async dispatchOutboundWebhook(
    eventType: string,
    data: Record<string, any>,
    targetUrl?: string,
    secret?: string
  ): Promise<{ success: boolean; url: string; status?: number; error?: string }> {
    const url = targetUrl || this.env?.OUTBOUND_WEBHOOK_URL;
    if (!url) {
      return { success: false, url: "", error: "No outbound webhook URL configured." };
    }

    // Issue #240: SSRF guard — never dispatch to localhost, private,
    // loopback, or link-local targets (caller-supplied `targetUrl` on the
    // dispatch_trading_webhook MCP tool is untrusted input). The URL is
    // deliberately not echoed: it may carry secrets.
    try {
      assertSafeOutboundWebhookUrl(url);
    } catch (err: any) {
      return { success: false, url: "", error: err?.message || "Webhook target not allowed." };
    }

    // Issue #411: Slack webhook destinations are rate-limited per URL
    // (~1/sec sustained, burst 5 — Slack's published webhook guidance).
    // Other destinations carry their own limits and are not throttled here.
    if (isSlackWebhookUrl(url)) {
      const rl = checkSlackWebhookRateLimit(url);
      if (!rl.allowed) {
        return {
          success: false,
          url,
          error: `Rate limited: Slack webhook calls to this destination are capped at ~1/second; delivery skipped (retry after ${rl.retryAfterMs}ms).`,
        };
      }
    }

    // Issue #123 (F20): outbound webhooks are advertised as HMAC-signed, so
    // they are dispatched ONLY when a real signing secret is configured
    // (per-call secret or OUTBOUND_WEBHOOK_SECRET). There is deliberately
    // no default/fallback secret: signing with a published constant would
    // give subscribers a signature anyone can forge while the UI claims
    // "HMAC authenticated". No secret → nothing is sent, honest failure.
    const signingSecret = secret || this.env?.OUTBOUND_WEBHOOK_SECRET;
    if (!signingSecret) {
      return {
        success: false,
        url,
        error:
          "No outbound webhook signing secret configured (set OUTBOUND_WEBHOOK_SECRET); webhook not sent. Outbound webhooks are only dispatched when they can be HMAC-signed with a configured secret.",
      };
    }
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify({
      event: eventType,
      data,
      timestamp,
      proposerDid: AGENT_DIDS.TRADING,
    });

    // Compute HMAC-SHA256 signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const signatureHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-256": `sha256=${signatureHex}`,
          "X-Event-Type": eventType,
          "X-Timestamp": timestamp,
          "User-Agent": "CloudflareAgents-ETradeTradingAgent/1.0",
        },
        body: payload,
      });

      return {
        success: resp.ok,
        url,
        status: resp.status,
      };
    } catch (err: any) {
      return {
        success: false,
        url,
        error: err.message || "Failed to dispatch outbound webhook.",
      };
    }
  }

  /**
   * Retrieve recent webhook events from SQLite audit log
   */
  getRecentWebhookEvents(limit: number = 20): any[] {
    if (!this.orm?.events) return [];
    return this.orm.events.findMany({
      where: { agent: "webhook" },
      orderBy: "timestamp DESC",
      limit,
    });
  }
}
