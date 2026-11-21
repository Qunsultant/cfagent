/**
 * Issue #210: Screener result publishers (Slack, email, webhook).
 *
 * These are the pub/sub subscribers that harvest the screener's value.
 * Each subscribes to the screener event bus; when a screen completes
 * (or fails), the publisher notifies its channel independently — a
 * failure in one never blocks the others (the bus catches per-handler
 * errors).
 *
 * Configuration (env vars):
 * - CFPAY_A2A_TOKEN: use cfpay's agents via A2A (tried first)
 * - SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL: local Slack fallback
 * - SCREENER_EMAIL_TO: enables email publishing (local fallback).
 *   Issue #488: the per-user stored destination (see
 *   src/services/userEmailDestination.ts) outranks both env vars;
 *   the run's explicit emailTo outranks the stored destination.
 * - OUTBOUND_WEBHOOK_URL: enables webhook publishing (local only;
 *   cfpay has no outbound webhook dispatch via A2A)
 *
 * Issue #215: cfpay via A2A is tried first; local services are the fallback.
 */

import {
  ScreenerEventBus,
  type ScreenerCompletedEvent,
  type ScreenerFailedEvent,
} from "./screenerEvents";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { getServiceUserLogin } from "../security/serviceIdentity";
import { ETradeSlackTradingService } from "../trading";
import { defaultUniverseId } from "../config/defaultUniverse";
import { ETradeEmailTradingService } from "../trading";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import {
  absoluteReportUrl,
  screenerReportUrl,
} from "../services/screenerReportUrl";
import { requireGatewayPorts } from "../gateway/createGatewayPorts";
import { chainModels } from "../models/router";
import { actorGateway } from "../services/cloudflareActorGateway";
import type { ScreenerPdfStub } from "../services/actorGatewayPorts";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import {
  getCfpayConfig,
  cfpayPostToSlack,
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
} from "../services/cfpayA2A";
import { deliverScreenerToSlack } from "../services/screenerSlackDelivery";
import { deliverGatedSlack } from "../services/gatedSlackDelivery";
import { checkScreenerDeliveryConfig } from "../services/screenerDeliveryConfig";
import {
  getStoredEmailDestination,
  resolveEmailDestination,
} from "../services/userEmailDestination";
import {
  inferTenantFromDeliveryId,
  resolveAndVerifySlackRecipientAtDelivery,
  resolveAndVerifyWebhookRecipientAtDelivery,
  resolveEnvChannelRecipientBinding,
  verifyChannelRecipient,
  verifyEmailRecipientAtDelivery,
  type ChannelRecipientBinding,
  type ChannelRecipientRunScope,
} from "../services/channelRecipientVerification";
import type { AsyncJobChannel } from "../types";

export interface ScreenerPublisherDeps {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
  /** Issue #4608: optional recipient binding lookup for publisher-layer verification. */
  getRecipientBinding?: (run: ChannelRecipientRunScope) => ChannelRecipientBinding | null | undefined;
}

function recordPublisherRecipientRefusal(
  deps: ScreenerPublisherDeps,
  type: "delivery.recipient_refused",
  payload: Record<string, unknown>,
): void {
  try {
    deps.orm?.events?.create({
      id: crypto.randomUUID(),
      sessionId: deps.userLogin,
      type,
      agent: "orchestrator",
      payload,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // verifyChannelRecipient always emits structuredLog.warn("delivery.recipient_refused", ...).
  }
}

function checkPublisherChannelRecipient(
  deps: ScreenerPublisherDeps,
  channel: AsyncJobChannel,
  recipient: string | undefined,
  event: {
    deliveryId?: string;
    scheduleId?: string;
    tenantId?: string | null;
    recipientBinding?: ChannelRecipientBinding | null;
  },
): boolean {
  const runScope: ChannelRecipientRunScope = {
    tenantId: event.tenantId ?? inferTenantFromDeliveryId(event.deliveryId),
    runId: event.deliveryId ?? null,
    scheduleId: event.scheduleId ?? null,
    userLogin: deps.userLogin,
  };
  const binding =
    event.recipientBinding ??
    deps.getRecipientBinding?.(runScope) ??
    resolveEnvChannelRecipientBinding(deps.env, runScope);
  const check = verifyChannelRecipient({
    channel,
    recipient,
    run: runScope,
    binding,
    layer: "publisher",
    audit: (type, payload) => recordPublisherRecipientRefusal(deps, type, payload),
  });
  return check.allowed;
}

async function resolveAndVerifyPublisherSlackChannel(
  deps: ScreenerPublisherDeps,
  event: {
    slackChannel?: string;
    deliveryId?: string;
    scheduleId?: string;
    tenantId?: string | null;
    recipientBinding?: ChannelRecipientBinding | null;
  },
): Promise<{ slackChannel?: string; allowed: boolean }> {
  const envFallback =
    (deps.env as any).SCREENER_SLACK_CHANNEL || (deps.env as any).SLACK_CHANNEL;
  const runScope: ChannelRecipientRunScope = {
    tenantId: event.tenantId ?? inferTenantFromDeliveryId(event.deliveryId),
    runId: event.deliveryId ?? null,
    scheduleId: event.scheduleId ?? null,
    userLogin: deps.userLogin,
  };
  const explicitBinding =
    event.recipientBinding ?? deps.getRecipientBinding?.(runScope) ?? null;
  const check = await resolveAndVerifySlackRecipientAtDelivery({
    requestedChannel: event.slackChannel,
    envFallbackChannel: envFallback,
    env: deps.env,
    run: runScope,
    binding: explicitBinding,
    layer: "publisher",
    audit: (type, payload) => recordPublisherRecipientRefusal(deps, type, payload),
  });
  return {
    slackChannel: check.allowed ? check.channel : undefined,
    allowed: check.allowed,
  };
}

async function resolveAndVerifyPublisherWebhookUrl(
  deps: ScreenerPublisherDeps,
  event: {
    webhookUrl?: string;
    deliveryId?: string;
    scheduleId?: string;
    tenantId?: string | null;
    recipientBinding?: ChannelRecipientBinding | null;
  },
): Promise<{ webhookUrl?: string; allowed: boolean; attempted: boolean }> {
  const envFallback = (deps.env as any).OUTBOUND_WEBHOOK_URL;
  const hasTenantWebhookJson =
    typeof (deps.env as any)?.TENANT_WEBHOOK_URLS_JSON === "string" &&
    (deps.env as any).TENANT_WEBHOOK_URLS_JSON.trim().length > 0;
  if (!event.webhookUrl && !envFallback && !hasTenantWebhookJson) {
    return { webhookUrl: undefined, allowed: false, attempted: false };
  }
  const runScope: ChannelRecipientRunScope = {
    tenantId: event.tenantId ?? inferTenantFromDeliveryId(event.deliveryId),
    runId: event.deliveryId ?? null,
    scheduleId: event.scheduleId ?? null,
    userLogin: deps.userLogin,
  };
  const explicitBinding =
    event.recipientBinding ?? deps.getRecipientBinding?.(runScope) ?? null;
  const check = await resolveAndVerifyWebhookRecipientAtDelivery({
    requestedUrl: event.webhookUrl,
    envFallbackUrl: envFallback,
    env: deps.env,
    run: runScope,
    binding: explicitBinding,
    layer: "publisher",
    audit: (type, payload) => recordPublisherRecipientRefusal(deps, type, payload),
  });
  return {
    webhookUrl: check.allowed ? check.url : undefined,
    allowed: check.allowed,
    attempted: true,
  };
}

const registeredBuses = new WeakSet<ScreenerEventBus>();

/**
 * Issue Qunsultant/cfagent#488 — per-user email destination as data.
 * Resolution for every publisher email send: the run's explicit emailTo,
 * then the user's stored destination, then the deployment-global env
 * vars (OPTIONS_EMAIL_TO, SCREENER_EMAIL_TO). A store failure degrades
 * to the env fallback inside getStoredEmailDestination, never to a
 * failed delivery.
 */
async function resolveAndVerifyPublisherEmailTo(
  deps: ScreenerPublisherDeps,
  event: {
    emailTo?: string;
    ownerEmail?: string | null;
    deliveryId?: string;
    scheduleId?: string;
    tenantId?: string | null;
    recipientBinding?: ChannelRecipientBinding | null;
  },
): Promise<{ emailTo?: string; allowed: boolean }> {
  const stored = await getStoredEmailDestination(deps.env, deps.userLogin);
  const emailTo = resolveEmailDestination({
    eventEmailTo: event.emailTo,
    storedEmailTo: stored,
    env: deps.env as unknown as Record<string, unknown>,
  });
  if (!emailTo) {
    return { emailTo: undefined, allowed: false };
  }
  const runScope: ChannelRecipientRunScope = {
    tenantId: event.tenantId ?? inferTenantFromDeliveryId(event.deliveryId),
    runId: event.deliveryId ?? null,
    scheduleId: event.scheduleId ?? null,
    userLogin: deps.userLogin,
  };
  const explicitBinding =
    event.recipientBinding ?? deps.getRecipientBinding?.(runScope) ?? null;
  const check = await verifyEmailRecipientAtDelivery({
    recipient: emailTo,
    env: deps.env,
    run: runScope,
    ownerEmail: event.ownerEmail,
    storedEmailTo: stored,
    binding: explicitBinding,
    layer: "publisher",
    audit: (type, payload) => recordPublisherRecipientRefusal(deps, type, payload),
  });
  return { emailTo, allowed: check.allowed };
}

interface ScreenerPdf {
  bytes: Uint8Array;
  fileName: string;
}

/** Fetch this run's PDF, never another concurrent run's latest PDF.
 * #333: errors are logged, not swallowed — a null return means "no PDF
 * stored", never "something broke silently". */
export async function fetchScreenerPdf(
  deps: ScreenerPublisherDeps,
  pdfKey?: string,
  pdfStatus?: "generated" | "failed" | "skipped",
  pdfError?: string
): Promise<ScreenerPdf | null> {
  // #3515 S3 batch 9 — env-wired logger: the sink is built from the
  // request's env so the events reach the Analytics Engine
  // `observability` dataset (never an empty-env sink, #5587).
  const log = createStructuredLogger(createObservabilitySink(deps.env), {
    component: "events/screenerPublishers",
  });
  try {
    const ns = (deps.env as any).SCREENER_AGENT;
    if (!ns) {
      log.warn("screenerPublishers.screener_agent_binding_missing", {
        message: "[ScreenerPublishers] SCREENER_AGENT binding missing — cannot fetch PDF.",
      });
      return null;
    }
    // Issue #822: if PDF generation failed, log the reason and do NOT fall back
    // to a stale PDF. The failure is already recorded in the result.
    if (pdfStatus === "failed") {
      log.error("screenerPublishers.pdf_generation_failed", {
        message: `[ScreenerPublishers] PDF generation failed for this run: ${pdfError || "unknown"}. Skipping attachment (not falling back to stale).`,
      });
      return null;
    }
    if (!pdfKey) {
      log.warn("screenerPublishers.pdf_key_missing", {
        message: "[ScreenerPublishers] No pdfKey on event — skipping PDF attachment.",
      });
      return null;
    }
    // Issue #1185: the bare "default" instance name belongs to the
    // configured service identity — the only login that maps to it.
    const serviceUserLogin = getServiceUserLogin(deps.env);
    const agentName = serviceUserLogin && deps.userLogin === serviceUserLogin ? "default" : `screener:${deps.userLogin}`;
    // #1779: PDF RPC rides the ActorGateway; the missing-binding
    // null return above is unchanged.
    const agent = actorGateway.stub<ScreenerPdfStub>(ns, agentName);
    return await agent.getPdfByKey(pdfKey);
  } catch (err) {
    log.warn("screenerPublishers.fetch_screener_pdf_failed", {
      message: "[ScreenerPublishers] fetchScreenerPdf failed:",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Upload the PDF to Slack via files.getUploadURLExternal (issue #269).
 * Falls back to posting the download link when no bot token is configured.
 */
async function deliverPdfToSlack(
  deps: ScreenerPublisherDeps,
  pdf: ScreenerPdf,
  event: ScreenerCompletedEvent,
  plainText: string
): Promise<void> {
  // #3515 S3 batch 9 — env-wired logger (see fetchScreenerPdf).
  const log = createStructuredLogger(createObservabilitySink(deps.env), {
    component: "events/screenerPublishers",
  });
  const botToken = deps.env.SLACK_BOT_TOKEN;
  const channel = (deps.env as any).SCREENER_SLACK_CHANNEL || (deps.env as any).SLACK_CHANNEL;
  const reportUrl = event.pdfKey
    ? screenerReportUrl(deps.env.APP_BASE_URL, event.pdfKey)
    : absoluteReportUrl(deps.env.APP_BASE_URL, "/api/screener/report.pdf");

  if (!botToken) {
    // No bot token: link the downloadable report in the channel message.
    if (channel) {
      try {
        const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
        await slack.postSlackMessage({
          text: `📄 Screener report PDF: ${reportUrl}`,
          channel,
        } as any);
      } catch (err) {
        log.warn("screenerPublishers.slack_pdf_link_failed", {
          message: "[ScreenerPublishers] Slack PDF link failed:",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }

  try {
    // Step 1: get upload URL.
    const getUrl = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename: pdf.fileName,
        length: String(pdf.bytes.length),
      }),
    });
    const urlData = (await getUrl.json()) as any;
    if (!urlData.ok) throw new Error(urlData.error || "getUploadURLExternal failed");

    // Step 2: upload bytes.
    const put = await fetch(urlData.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdf.bytes as unknown as BodyInit,
    });
    if (!put.ok) throw new Error(`upload PUT failed: ${put.status}`);

    // Step 3: complete.
    const complete = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: `Screener report — ${event.sector} ${event.timestamp.slice(0, 10)}` }],
        channel_id: channel,
        initial_comment: `📄 Screener report PDF — ${event.opportunities.length} opportunities`,
      }),
    });
    const doneData = (await complete.json()) as any;
    if (!doneData.ok) throw new Error(doneData.error || "completeUploadExternal failed");
  } catch (err) {
    log.warn("screenerPublishers.slack_pdf_upload_failed", {
      message: "[ScreenerPublishers] Slack PDF upload failed:",
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback: link.
    try {
      const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
      await slack.postSlackMessage({
        text: `${plainText}\n\n📄 Report PDF: ${reportUrl}`,
        channel,
      } as any);
    } catch {
      // Already warned above; don't cascade.
    }
  }
}

/** Attach the PDF to the screener email (issue #269). */
async function deliverPdfToEmail(
  deps: ScreenerPublisherDeps,
  pdf: ScreenerPdf,
  event: ScreenerCompletedEvent,
  html: string,
  plainText: string
): Promise<void> {
  const { emailTo, allowed } = await resolveAndVerifyPublisherEmailTo(deps, event);
  if (!emailTo || !allowed) return;
  // #3515 S3 batch 9 — env-wired logger, built after the guard so
  // no-op calls never construct a sink (batch-6 core.ts precedent).
  const log = createStructuredLogger(createObservabilitySink(deps.env), {
    component: "events/screenerPublishers",
  });
  try {
    let base64 = "";
    const chunk = 8192;
    for (let i = 0; i < pdf.bytes.length; i += chunk) {
      base64 += String.fromCharCode(...pdf.bytes.subarray(i, i + chunk));
    }
    const email = new ETradeEmailTradingService(deps.env, deps.orm, deps.userLogin);
    await email.sendOutboundEmail(
      emailTo,
      `📊 Market Screen [${event.sector}] — ${event.opportunities.length} opportunities (PDF attached)`,
      `${html}<p>Full report attached as PDF.</p>`,
      `${plainText}\n\nFull report attached as PDF.`,
      { fileName: pdf.fileName, contentType: "application/pdf", contentBase64: btoa(base64) }
    );
  } catch (err) {
    log.warn("screenerPublishers.email_pdf_delivery_failed", {
      message: "[ScreenerPublishers] Email PDF delivery failed:",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Register all screener publishers on the bus. Idempotent — call once
 * per service instance.
 */
export function registerScreenerPublishers(
  bus: ScreenerEventBus,
  deps: ScreenerPublisherDeps
): void {
  if (registeredBuses.has(bus)) return;
  registeredBuses.add(bus);

  bus.subscribe("screener.completed", (event) =>
    publishCompleted(deps, event as ScreenerCompletedEvent)
  );
  bus.subscribe("screener.failed", (event) =>
    publishFailed(deps, event as ScreenerFailedEvent)
  );
}

/**
 * Issue #218: LLM-generated digest of screener opportunities.
 * Best-effort — returns null if the model is unavailable. The structured
 * delivery path stays deterministic; this only adds a human-readable lead.
 */
export async function generateScreenerDigest(
  env: Env,
  event: ScreenerCompletedEvent
): Promise<string | null> {
  if (event.opportunities.length === 0) return null;
  const summary = event.opportunities.slice(0, 5).map(
    (o) => `${o.symbol} (${o.companyName}) — ${o.signal}, momentum ${o.momentumScore.toFixed(0)}, $${o.lastPrice.toFixed(2)} (${o.changePercent >= 0 ? "+" : ""}${o.changePercent.toFixed(2)}%)`
  ).join("\n");
  const prompt = `Summarize these screener results in one sentence for a trader. ` +
    `Lead with the count and the top names. Be specific, no hype.\n\n` +
    `Universe: ${event.universe || defaultUniverseId()}\n${summary}`;
  try {
    // #1741: summarize-chain failover now lives in the gateway port.
    const gateway = requireGatewayPorts(env);
    const result = (
      await gateway.generate({ models: chainModels("summarize"), prompt, caller: "screener-digest" })
    ).text.trim();
    return result || null;
  } catch {
    return null;
  }
}

function formatOpportunities(
  event: ScreenerCompletedEvent
): { text: string; html: string } {
  const lines = event.opportunities.map(
    (o, i) =>
      `${i + 1}. *${o.symbol}* (${o.companyName}) — ${o.signal} | ` +
      `momentum ${o.momentumScore.toFixed(0)} | $${o.lastPrice.toFixed(2)} ` +
      `(${o.changePercent >= 0 ? "+" : ""}${o.changePercent.toFixed(2)}%)`
  );
  const universe = event.universe || defaultUniverseId();
  const sectorLabel = event.sector && event.sector !== "ALL" ? ` · ${event.sector}` : "";
  const triggerLabel = event.trigger === "manual" ? "Manual" : "Scheduled";
  const scanned = event.expectedCount && event.expectedCount > event.totalScanned
    ? `Scanned ${event.totalScanned} of ${event.expectedCount} ${universe} stocks, ${event.matchedCount} matched.`
    : `Scanned ${event.totalScanned} ${universe} stocks, ${event.matchedCount} matched.`;
  const filterLine = event.filterSummary ? `Criteria: ${event.filterSummary}` : null;
  // Issue #462: a partial quote set yields a qualified partial report — the
  // qualification rides every delivery so it never reads as a complete screen.
  const partialLine = event.partial
    ? `⚠️ Partial screen — qualified results: ${event.partial.quotedCount} of ${event.partial.requestedCount} symbols quoted; ` +
      `${event.partial.failedSymbols.length} unavailable (${event.partial.failedSymbols.slice(0, 5).join(", ")}${event.partial.failedSymbols.length > 5 ? "…" : ""}). ` +
      `Results cover the quoted subset only; no fallback data substituted.`
    : null;
  const text = [
    `📊 Market Screen — ${universe}${sectorLabel} · ${triggerLabel}`,
    scanned,
    ...(filterLine ? [filterLine] : []),
    ...(partialLine ? [partialLine] : []),
    // Issue #728: rejection breakdown — when few or zero match, show why.
    ...(event.rejections?.length
      ? [
          `Rejections: ${Object.entries(
            event.rejections.reduce((acc: Record<string, number>, r) => {
              // Group by the gate: take the first clause before " (" or " for".
              const gate = r.reason.split(" (")[0].split(" for ")[0].trim();
              acc[gate] = (acc[gate] || 0) + 1;
              return acc;
            }, {})
          )
            .sort((a, b) => b[1] - a[1])
            .map(([gate, n]) => `${n} ${gate}`)
            .join(", ")}`,
        ]
      : []),
    ``,
    ...(event.opportunities.length > 0 ? lines : ["No standout opportunities met the screening criteria."]),
    ``,
    `_Completed ${event.timestamp}_`,
  ].join("\n");

  const htmlRows = event.opportunities
    .map(
      (o) =>
        `<tr><td><b>${o.symbol}</b></td><td>${o.companyName}</td>` +
        `<td>${o.signal}</td><td>${o.momentumScore.toFixed(0)}</td>` +
        `<td>$${o.lastPrice.toFixed(2)}</td>` +
        `<td>${o.changePercent >= 0 ? "+" : ""}${o.changePercent.toFixed(2)}%</td></tr>`
    )
    .join("");
  const html = [
    `<h2>📊 Market Screen — ${universe}${sectorLabel} · ${triggerLabel}</h2>`,
    `<p>${scanned}</p>`,
    ...(filterLine ? [`<p><b>Criteria:</b> ${event.filterSummary}</p>`] : []),
    ...(partialLine ? [`<p><b>${partialLine}</b></p>`] : []),
    ...(event.opportunities.length > 0
      ? [
          `<table border="1" cellpadding="6" cellspacing="0">`,
          `<tr><th>Symbol</th><th>Company</th><th>Signal</th><th>Momentum</th><th>Price</th><th>Change</th></tr>`,
          htmlRows,
          `</table>`,
        ]
      : [`<p><i>No standout opportunities met the screening criteria.</i></p>`]),
    `<p><i>Completed ${event.timestamp}</i></p>`,
  ].join("\n");
  return { text, html };
}

async function publishCompleted(
  deps: ScreenerPublisherDeps,
  event: ScreenerCompletedEvent
): Promise<void> {
  // #3515 S3 batch 9 — env-wired logger (see fetchScreenerPdf).
  const log = createStructuredLogger(createObservabilitySink(deps.env), {
    component: "events/screenerPublishers",
  });
  const { text, html } = formatOpportunities(event);
  const plainText = text.replace(/\*/g, "");

  // Issue #218: prepend an LLM-generated digest (best-effort).
  const digest = await generateScreenerDigest(deps.env, event);
  const textWithDigest = digest ? `💡 ${digest}\n\n${text}` : text;

  // 1. Resolve the exact run's PDF before sending one A2A Slack file
  // notification. Sending a separate summary and then a file generated a
  // duplicate pair of Slack messages for each screen.
  const cfpay = getCfpayConfig(deps.env);
  const { slackChannel, allowed: slackAllowed } = await resolveAndVerifyPublisherSlackChannel(deps, event);
  const pdf = await fetchScreenerPdf(deps, event.pdfKey, event.pdfStatus, event.pdfError);
  const reportUrl = event.pdfKey
    ? screenerReportUrl(deps.env.APP_BASE_URL, event.pdfKey)
    : absoluteReportUrl(deps.env.APP_BASE_URL, "/api/screener/report.pdf");
  const plainTextWithDigest = digest ? `💡 ${digest}\n\n${plainText}` : plainText;
  const slackBody = pdf || cfpay
    ? plainTextWithDigest
    : `${plainTextWithDigest}${event.pdfKey ? `\n\n📄 PDF report: ${reportUrl}` : ""}`;
  if (slackAllowed) {
    const slackDelivery = await deliverScreenerToSlack(deps.env, {
      text: slackBody,
      channel: slackChannel,
      ...(pdf ? {
        pdf: {
          ...pdf,
          title: `Market Screen — ${event.universe || defaultUniverseId()} ${event.timestamp.slice(0, 10)}`,
          comment: plainTextWithDigest,
        },
      } : {}),
    });
    if (!slackDelivery.ok) {
      log.warn("screenerPublishers.slack_delivery_failed", {
        message: "[ScreenerPublishers] Slack delivery failed:",
        error: slackDelivery.error,
      });
    }
  }

  // 2. Email — try cfpay via A2A first, fall back to local.
  // Issue #1770 (slice B, F-63): when no email transport is
  // configured, skip with the named reason instead of attempting
  // sends that cannot succeed and dropping the failure silently.
  const { emailTo, allowed: emailAllowed } = await resolveAndVerifyPublisherEmailTo(deps, event);
  if (emailTo && emailAllowed) {
    const deliveryConfig = checkScreenerDeliveryConfig(deps.env);
    if (!deliveryConfig.emailConfigured) {
      log.warn("screenerPublishers.email_delivery_skipped", {
        message: `[ScreenerPublishers] Email delivery skipped for ${event.universe || event.sector}: ${deliveryConfig.emailMissingReason}`,
        universe: event.universe || event.sector,
        reason: deliveryConfig.emailMissingReason,
      });
    } else {
      let emailOk = false;
      if (cfpay) {
        let r;
        if (pdf) {
          let binary = "";
          for (let i = 0; i < pdf.bytes.length; i += 8192) binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
          r = await cfpaySendEmailWithAttachments(cfpay, {
            to: emailTo,
            subject: `📊 Market Screen [${event.universe || event.sector}] — ${event.opportunities.length} opportunities`,
            body: plainText,
            attachments: [{ filename: pdf.fileName, contentB64: btoa(binary), contentType: "application/pdf" }],
          });
        } else {
          r = await cfpaySendEmail(cfpay, emailTo,
            `📊 Market Screen [${event.universe || event.sector}] — ${event.opportunities.length} opportunities`, plainText);
        }
        emailOk = r.ok;
        if (!r.ok) {
          log.warn("screenerPublishers.cfpay_email_failed", {
            message: "[ScreenerPublishers] cfpay Email failed, falling back to local:",
            error: r.error,
          });
        }
      }
      if (!emailOk) {
        try {
          const email = new ETradeEmailTradingService(deps.env, deps.orm, deps.userLogin);
          const sent = await email.sendOutboundEmail(
            emailTo,
            `📊 Market Screen [${event.universe || event.sector}] — ${event.opportunities.length} opportunities`,
            `${html}${pdf ? `<p>Full report attached: ${pdf.fileName}</p>` : ""}`,
            `${plainText}${reportUrl ? `\n\nPDF report: ${reportUrl}` : ""}`,
            pdf ? (() => {
              let binary = "";
              for (let i = 0; i < pdf.bytes.length; i += 8192) binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
              return { fileName: pdf.fileName, contentType: "application/pdf", contentBase64: btoa(binary) };
            })() : undefined
          );
          // Issue #1770 (slice B): the local send's false return used
          // to be dropped silently — a missing EMAIL binding looked
          // exactly like a delivered email. Name it.
          if (!sent) {
            log.warn("screenerPublishers.local_email_send_failed", {
              message: "[ScreenerPublishers] Local email send failed (env.EMAIL binding is not configured or send failed) — email not delivered.",
            });
          }
        } catch (err) {
          log.warn("screenerPublishers.email_publish_failed", {
            message: "[ScreenerPublishers] Email publish failed:",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // 3. Webhook
  const { webhookUrl, allowed: webhookAllowed } = await resolveAndVerifyPublisherWebhookUrl(deps, event);
  if (webhookAllowed && webhookUrl) {
    try {
      const webhook = new ETradeWebhookService(deps.orm, deps.env, deps.userLogin);
      await webhook.dispatchOutboundWebhook(
        "screener.completed",
        {
          sector: event.sector,
          totalScanned: event.totalScanned,
          matchedCount: event.matchedCount,
          opportunities: event.opportunities,
          reportUrl: event.pdfKey ? reportUrl : undefined,
          timestamp: event.timestamp,
        },
        webhookUrl
      );
    } catch (err) {
      log.warn("screenerPublishers.webhook_publish_failed", {
        message: "[ScreenerPublishers] Webhook publish failed:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function publishFailed(
  deps: ScreenerPublisherDeps,
  event: ScreenerFailedEvent
): Promise<void> {
  // #3515 S3 batch 9 — env-wired logger (see fetchScreenerPdf).
  const log = createStructuredLogger(createObservabilitySink(deps.env), {
    component: "events/screenerPublishers",
  });
  const triggerLabel = event.trigger === "manual" ? "Manual" : "Scheduled";
  const text = `⚠️ Market Screen FAILED — ${event.universe || defaultUniverseId()}${event.sector && event.sector !== "ALL" ? ` · ${event.sector}` : ""} · ${triggerLabel}\nError: ${event.error}\n_Time: ${event.timestamp}_`;

  const cfpay = getCfpayConfig(deps.env);
  let attempted = false;
  // #3177: one gated dispatch replaces the A2A-only branch and the
  // ETradeSlackTradingService fallback. The fallback is provably
  // equivalent-or-better: same channel, same text, same auth sources
  // (bot token / webhook / cfpay A2A) — and the master sender adds the
  // A2A->direct fallback the old branch lacked (an A2A failure used to
  // end the attempt), and never double-posts when both a webhook and a
  // bot token are configured (the ETrade sender tried both).
  // `attempted` keeps its #424 meaning ("a notification channel was
  // available"): a gate refusal is a deliberate, logged outcome, not
  // a missing channel, so a configured Slack counts as attempted even
  // when the tenant disabled it.
  const slackConfigured = Boolean(
    cfpay || deps.env.SLACK_BOT_TOKEN || deps.env.SLACK_WEBHOOK_URL,
  );
  const { slackChannel: resolvedSlackChannel, allowed: slackAllowed } =
    await resolveAndVerifyPublisherSlackChannel(deps, event);
  if (slackAllowed) {
    const result = await deliverGatedSlack(deps.env, {
      userLogin: deps.userLogin,
      text,
      channel: resolvedSlackChannel,
      tenantId: event.tenantId,
      runId: event.deliveryId,
      scheduleId: event.scheduleId,
      recipientBinding: event.recipientBinding,
    });
    if (!result.ok) log.warn("screenerPublishers.slack_failure_notify_failed", {
      message: "[ScreenerPublishers] Slack failure-notify failed:",
      error: result.error,
    });
  }
  attempted = attempted || slackConfigured;

  const { emailTo, allowed: emailAllowed } = await resolveAndVerifyPublisherEmailTo(deps, event);
  if (emailTo) {
    attempted = true;
    if (emailAllowed) {
      // Issue #1770 (slice B, F-63): same named skip as the completed
      // path — a missing transport must warn with its reason, not
      // silently drop the failure notice.
      const deliveryConfig = checkScreenerDeliveryConfig(deps.env);
      if (!deliveryConfig.emailConfigured) {
        log.warn("screenerPublishers.email_failure_notify_skipped", {
          message: `[ScreenerPublishers] Email failure-notify skipped for ${event.universe || defaultUniverseId()}: ${deliveryConfig.emailMissingReason}`,
          universe: event.universe || defaultUniverseId(),
          reason: deliveryConfig.emailMissingReason,
        });
      } else if (cfpay) {
        const r = await cfpaySendEmail(cfpay, emailTo, `⚠️ Market Screen FAILED — ${event.universe || defaultUniverseId()}`, text);
        if (!r.ok) log.warn("screenerPublishers.cfpay_email_failure_notify_failed", {
          message: "[ScreenerPublishers] cfpay Email failure-notify failed:",
          error: r.error,
        });
      } else {
        try {
          const email = new ETradeEmailTradingService(deps.env, deps.orm, deps.userLogin);
          const sent = await email.sendOutboundEmail(emailTo, `⚠️ Market Screen FAILED — ${event.universe || defaultUniverseId()}`, `<p>${text}</p>`, text);
          if (!sent) {
            log.warn("screenerPublishers.local_email_failure_notify_failed", {
              message: "[ScreenerPublishers] Local email failure-notify failed (env.EMAIL binding is not configured or send failed) — notice not delivered.",
            });
          }
        } catch (err) {
          log.warn("screenerPublishers.email_failure_notify_failed", {
            message: "[ScreenerPublishers] Email failure-notify failed:",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const {
    webhookUrl,
    allowed: webhookAllowed,
    attempted: webhookAttempted,
  } = await resolveAndVerifyPublisherWebhookUrl(deps, event);
  if (webhookAttempted) {
    attempted = true;
    if (webhookAllowed && webhookUrl) {
      try {
        const webhook = new ETradeWebhookService(deps.orm, deps.env, deps.userLogin);
        await webhook.dispatchOutboundWebhook(
          "screener.failed",
          { sector: event.sector, error: event.error, timestamp: event.timestamp },
          webhookUrl
        );
      } catch (err) {
        log.warn("screenerPublishers.webhook_failure_notify_failed", {
          message: "[ScreenerPublishers] Webhook failure-notify failed:",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Issue #424: with no channel configured the failure used to vanish
  // silently — the exact complaint behind the issue. Audit the skip so
  // the silence is on the record and diagnosable.
  if (!attempted) {
    try {
      deps.orm?.events?.create({
        id: crypto.randomUUID(),
        sessionId: deps.userLogin,
        type: "screener.failure_notify_skipped",
        agent: "orchestrator",
        payload: {
          sector: event.sector,
          universe: event.universe,
          error: event.error,
          reason: "no notification channel configured",
        },
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      // Issue #1999 (D2): #424 put this audit on the record so the
      // skip is diagnosable — a lost insert must warn, not
      // re-introduce the exact silence #424 fixed.
      log.warn("screenerPublishers.audit_insertion_failed", {
        message: `[screener-publishers] Audit insertion failed (type=screener.failure_notify_skipped, login=${deps.userLogin}): ${err instanceof Error ? err.message : String(err)}`,
        type: "screener.failure_notify_skipped",
        login: deps.userLogin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Shared entry points for manual routes; scheduled runs use the same bus subscribers. */
export function publishScreenerCompleted(
  deps: ScreenerPublisherDeps,
  event: ScreenerCompletedEvent,
): Promise<void> {
  return publishCompleted(deps, event);
}

export function publishScreenerFailed(
  deps: ScreenerPublisherDeps,
  event: ScreenerFailedEvent,
): Promise<void> {
  return publishFailed(deps, event);
}
