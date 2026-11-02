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
 * - SCREENER_EMAIL_TO: enables email publishing (local fallback)
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
import { getServiceUserLogin } from "../security/serviceIdentity";
import { ETradeSlackTradingService } from "../trading";
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
import { deliverScreenerToSlack, deliverScreenerToSlackA2A } from "../services/screenerSlackDelivery";
import { checkScreenerDeliveryConfig } from "../services/screenerDeliveryConfig";

export interface ScreenerPublisherDeps {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
}

const registeredBuses = new WeakSet<ScreenerEventBus>();

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
  try {
    const ns = (deps.env as any).SCREENER_AGENT;
    if (!ns) {
      console.warn("[ScreenerPublishers] SCREENER_AGENT binding missing — cannot fetch PDF.");
      return null;
    }
    // Issue #822: if PDF generation failed, log the reason and do NOT fall back
    // to a stale PDF. The failure is already recorded in the result.
    if (pdfStatus === "failed") {
      console.error(`[ScreenerPublishers] PDF generation failed for this run: ${pdfError || "unknown"}. Skipping attachment (not falling back to stale).`);
      return null;
    }
    if (!pdfKey) {
      console.warn("[ScreenerPublishers] No pdfKey on event — skipping PDF attachment.");
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
    console.warn("[ScreenerPublishers] fetchScreenerPdf failed:", err instanceof Error ? err.message : String(err));
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
        console.warn("[ScreenerPublishers] Slack PDF link failed:", err instanceof Error ? err.message : String(err));
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
    console.warn("[ScreenerPublishers] Slack PDF upload failed:", err instanceof Error ? err.message : String(err));
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
  const emailTo = (deps.env as any).SCREENER_EMAIL_TO;
  if (!emailTo) return;
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
    console.warn("[ScreenerPublishers] Email PDF delivery failed:", err instanceof Error ? err.message : String(err));
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
    `Universe: ${event.universe || "TECH"}\n${summary}`;
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
  const universe = event.universe || "TECH";
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
  const { text, html } = formatOpportunities(event);
  const plainText = text.replace(/\*/g, "");

  // Issue #218: prepend an LLM-generated digest (best-effort).
  const digest = await generateScreenerDigest(deps.env, event);
  const textWithDigest = digest ? `💡 ${digest}\n\n${text}` : text;

  // 1. Resolve the exact run's PDF before sending one A2A Slack file
  // notification. Sending a separate summary and then a file generated a
  // duplicate pair of Slack messages for each screen.
  const cfpay = getCfpayConfig(deps.env);
  const slackChannel = event.slackChannel || (deps.env as any).SCREENER_SLACK_CHANNEL || (deps.env as any).SLACK_CHANNEL;
  const pdf = await fetchScreenerPdf(deps, event.pdfKey, event.pdfStatus, event.pdfError);
  const reportUrl = event.pdfKey
    ? screenerReportUrl(deps.env.APP_BASE_URL, event.pdfKey)
    : absoluteReportUrl(deps.env.APP_BASE_URL, "/api/screener/report.pdf");
  const plainTextWithDigest = digest ? `💡 ${digest}\n\n${plainText}` : plainText;
  const slackBody = pdf || cfpay
    ? plainTextWithDigest
    : `${plainTextWithDigest}${event.pdfKey ? `\n\n📄 PDF report: ${reportUrl}` : ""}`;
  const slackDelivery = await deliverScreenerToSlack(deps.env, {
    text: slackBody,
    channel: slackChannel,
    ...(pdf ? {
      pdf: {
        ...pdf,
        title: `Market Screen — ${event.universe || "TECH"} ${event.timestamp.slice(0, 10)}`,
        comment: plainTextWithDigest,
      },
    } : {}),
  });
  if (!slackDelivery.ok) {
    console.warn("[ScreenerPublishers] Slack delivery failed:", slackDelivery.error);
  }

  // 2. Email — try cfpay via A2A first, fall back to local.
  // Issue #1770 (slice B, F-63): when no email transport is
  // configured, skip with the named reason instead of attempting
  // sends that cannot succeed and dropping the failure silently.
  const emailTo = event.emailTo || (deps.env as any).SCREENER_EMAIL_TO;
  if (emailTo) {
    const deliveryConfig = checkScreenerDeliveryConfig(deps.env);
    if (!deliveryConfig.emailConfigured) {
      console.warn(
        `[ScreenerPublishers] Email delivery skipped for ${event.universe || event.sector}: ${deliveryConfig.emailMissingReason}`
      );
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
          console.warn("[ScreenerPublishers] cfpay Email failed, falling back to local:", r.error);
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
            console.warn("[ScreenerPublishers] Local email send failed (env.EMAIL binding is not configured or send failed) — email not delivered.");
          }
        } catch (err) {
          console.warn("[ScreenerPublishers] Email publish failed:", err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  // 3. Webhook
  const webhookUrl = event.webhookUrl || (deps.env as any).OUTBOUND_WEBHOOK_URL;
  if (webhookUrl) {
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
      console.warn("[ScreenerPublishers] Webhook publish failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

async function publishFailed(
  deps: ScreenerPublisherDeps,
  event: ScreenerFailedEvent
): Promise<void> {
  const triggerLabel = event.trigger === "manual" ? "Manual" : "Scheduled";
  const text = `⚠️ Market Screen FAILED — ${event.universe || "TECH"}${event.sector && event.sector !== "ALL" ? ` · ${event.sector}` : ""} · ${triggerLabel}\nError: ${event.error}\n_Time: ${event.timestamp}_`;

  const cfpay = getCfpayConfig(deps.env);
  const slackChannel = event.slackChannel || (deps.env as any).SCREENER_SLACK_CHANNEL || (deps.env as any).SLACK_CHANNEL;
  let attempted = false;
  if (cfpay) {
    attempted = true;
    const result = await deliverScreenerToSlackA2A(deps.env, { text, channel: slackChannel });
    if (!result.ok) console.warn("[ScreenerPublishers] Slack A2A failure-notify failed:", result.error);
  } else if (deps.env.SLACK_BOT_TOKEN || deps.env.SLACK_WEBHOOK_URL) {
    attempted = true;
    try {
      const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
      await slack.postSlackMessage({ text, channel: slackChannel } as any);
    } catch (err) {
      console.warn("[ScreenerPublishers] Slack failure-notify failed:", err instanceof Error ? err.message : String(err));
    }
  }

  const emailTo = event.emailTo || (deps.env as any).SCREENER_EMAIL_TO;
  if (emailTo) {
    attempted = true;
    // Issue #1770 (slice B, F-63): same named skip as the completed
    // path — a missing transport must warn with its reason, not
    // silently drop the failure notice.
    const deliveryConfig = checkScreenerDeliveryConfig(deps.env);
    if (!deliveryConfig.emailConfigured) {
      console.warn(
        `[ScreenerPublishers] Email failure-notify skipped for ${event.universe || "TECH"}: ${deliveryConfig.emailMissingReason}`
      );
    } else if (cfpay) {
      const r = await cfpaySendEmail(cfpay, emailTo, `⚠️ Market Screen FAILED — ${event.universe || "TECH"}`, text);
      if (!r.ok) console.warn("[ScreenerPublishers] cfpay Email failure-notify failed:", r.error);
    } else {
      try {
        const email = new ETradeEmailTradingService(deps.env, deps.orm, deps.userLogin);
        const sent = await email.sendOutboundEmail(emailTo, `⚠️ Market Screen FAILED — ${event.universe || "TECH"}`, `<p>${text}</p>`, text);
        if (!sent) {
          console.warn("[ScreenerPublishers] Local email failure-notify failed (env.EMAIL binding is not configured or send failed) — notice not delivered.");
        }
      } catch (err) {
        console.warn("[ScreenerPublishers] Email failure-notify failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  const webhookUrl = event.webhookUrl || (deps.env as any).OUTBOUND_WEBHOOK_URL;
  if (webhookUrl) {
    attempted = true;
    try {
      const webhook = new ETradeWebhookService(deps.orm, deps.env, deps.userLogin);
      await webhook.dispatchOutboundWebhook(
        "screener.failed",
        { sector: event.sector, error: event.error, timestamp: event.timestamp },
        webhookUrl
      );
    } catch (err) {
      console.warn("[ScreenerPublishers] Webhook failure-notify failed:", err instanceof Error ? err.message : String(err));
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
      console.warn(
        `[screener-publishers] Audit insertion failed (type=screener.failure_notify_skipped, login=${deps.userLogin}): ${err instanceof Error ? err.message : String(err)}`,
      );
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
