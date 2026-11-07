/**
 * Issue #1123 S3: the delivery port behind followup.deliver jobs —
 * content + transport for one channel, sharing the single report
 * artifact the report sub-job secured. Kept out of orchestrator.ts
 * (size budget, #992): the class wires it into the async-job context
 * with its env/orm/ScreenerAgent accessors.
 *
 * Slack reuses the platform's unified delivery (A2A first, direct
 * fallback); email reuses the outbound email service with the report
 * attached; webhook reuses the outbound webhook service. The executor
 * owns policy (allowlist/skip); this module owns sending.
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import type { ScreenerAgent } from "../agents/screener-agent";
import { ETradeEmailTradingService } from "../trading";
import { ETradeWebhookService } from "./tradingWebhooks";
import {
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
  getCfpayConfig,
} from "./cfpayA2A";
import { deliverScreenerToSlack } from "./screenerSlackDelivery";
import {
  formatFollowupDeliveryText,
  followupDeliveryEmailSubject,
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "./screenerFollowups";
import { SCREENING_DRAFT_FOOTER } from "./screeningDelivery";
import type { AsyncJobChannel } from "../types";
import {
  channelDisabledError,
  mapScreeningChannelToTenantChannel,
  resolveTenantChannelGate,
  type TenantChannelGate,
} from "./tenantChannelGate";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/screenerFollowupDelivery",
});

export interface FollowupDeliveryDeps {
  env: Env;
  getOrm: () => DatabaseORM;
  getScreenerAgent: (userLogin?: string) => ScreenerAgent;
  /**
   * Issue #3169 — test seam for tenant channel gate resolution.
   * When absent, the gate resolves from deps.env (commercial
   * account row for the verified login + channel store); a
   * null result means ungated (prior behavior).
   */
  getTenantChannelGate?: (userLogin: string) => Promise<TenantChannelGate | null>;
}

/** Resolve the tenant channel gate for one delivery, never throwing. */
async function resolveDeliveryGate(
  deps: FollowupDeliveryDeps,
  userLogin: string,
): Promise<TenantChannelGate | null> {
  try {
    if (deps.getTenantChannelGate) return await deps.getTenantChannelGate(userLogin);
    return await resolveTenantChannelGate(deps.env, userLogin);
  } catch {
    return null;
  }
}

export interface FollowupDeliveryInput {
  channel: AsyncJobChannel;
  userLogin: string;
  outcome: ScreenerRunOutcome;
  artifacts: Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" | "csv" }>;
}

/**
 * Consolidation #1236 (discovery notifications): the text a delivery
 * sends for a run outcome. Discovery outcomes carry the draft-only
 * footer — the chain text path never appended it, while every direct
 * path did, and draft-only posture for this new notification surface
 * is preserved by content, not by a hold. All other kinds render
 * byte-identically to formatFollowupDeliveryText.
 */
export function followupDeliveryText(outcome: ScreenerRunOutcome): string {
  const text = formatFollowupDeliveryText(outcome);
  return outcome.kind === "discovery" ? `${text}\n\n${SCREENING_DRAFT_FOOTER}` : text;
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_CONTENT_TYPE = "text/csv";

export function createFollowupDeliveryPort(deps: FollowupDeliveryDeps): {
  deliver: (input: FollowupDeliveryInput) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  notify: (input: { channel: AsyncJobChannel; userLogin: string; text: string; emailTo?: string; slackChannel?: string }) => Promise<{ ok: boolean; error?: string; detail?: string }>;
} {
  return {
    deliver: async ({ channel, userLogin, outcome, artifacts }) => {
      // Issue #3169: a tenant-disabled channel is refused before
      // any artifact is fetched or any transport is attempted.
      // A null gate (unbound store, no tenant, resolution
      // failure) means ungated — prior behavior, never a refusal.
      const gate = await resolveDeliveryGate(deps, userLogin);
      const tenantChannel = mapScreeningChannelToTenantChannel(channel);
      if (gate && tenantChannel && !gate.isEnabled(tenantChannel)) {
        return { ok: false, error: channelDisabledError(tenantChannel, gate.tenantId) };
      }
      const config = resolveScreenerFollowupConfig(deps.env as unknown as Record<string, unknown>);
      const text = followupDeliveryText(outcome);
      const agent = deps.getScreenerAgent(userLogin);
      // Issue #1191 (#1173 R3): fetch bytes per artifact kind — PDF
      // via the PDF getters, XLSX via the XLSX getters (stock since
      // R3, options since R3b/#1195). A missing artifact is recorded in the
      // missing list and reported in the delivery detail — the rest
      // still sends; nothing is fabricated.
      const files: Array<{ bytes: Uint8Array; fileName: string; contentType: string }> = [];
      const missingArtifacts: string[] = [];
      for (const artifact of artifacts) {
        const kind = artifact.kind
          ?? (artifact.fileName.endsWith(".xlsx") ? "xlsx"
            : artifact.fileName.endsWith(".csv") ? "csv" : "pdf");
        const fetched = kind === "xlsx"
          ? (outcome.kind === "stock" ? await agent.getXlsxByKey(artifact.key) : await agent.getOptionsXlsxByKey(artifact.key))
          : kind === "csv"
            ? (outcome.kind === "stock" ? await agent.getCsvByKey(artifact.key) : await agent.getOptionsCsvByKey(artifact.key))
            : outcome.kind === "stock"
              ? await agent.getPdfByKey(artifact.key)
              : await agent.getOptionsPdfByKey(artifact.key);
        if (fetched) {
          files.push({
            bytes: fetched.bytes,
            fileName: fetched.fileName,
            contentType: kind === "xlsx" ? XLSX_CONTENT_TYPE : kind === "csv" ? CSV_CONTENT_TYPE : "application/pdf",
          });
        } else {
          missingArtifacts.push(artifact.key);
        }
      }
      const missingNote = missingArtifacts.length > 0
        ? `Artifact(s) missing from storage, not attached: ${missingArtifacts.join(", ")}`
        : undefined;
      if (channel === "slack") {
        const pdfFile = files.find((f) => f.contentType === "application/pdf");
        const rest = files.filter((f) => f !== pdfFile);
        const sent = await deliverScreenerToSlack(deps.env, {
          text,
          channel: outcome.slackChannel ?? config.channels.slack.channel,
          ...(pdfFile ? { pdf: { bytes: pdfFile.bytes, fileName: pdfFile.fileName, title: `Screener report — ${outcome.kind} screen`, comment: text } } : {}),
          ...(rest.length > 0 ? { files: rest.map((f) => ({ bytes: f.bytes, fileName: f.fileName, title: f.fileName })) } : {}),
        });
        return missingNote && sent.ok ? { ...sent, detail: missingNote } : sent;
      }
      if (channel === "email") {
        const to = outcome.emailTo ?? config.channels.email.to;
        if (!to) return { ok: false, error: "Email delivery is not configured (SCREENER_EMAIL_TO is unset)." };
        const subject = followupDeliveryEmailSubject(outcome);
        // Issue #1191: attach EVERY artifact (text + PDF + XLSX +
        // CSV since #1346), each with its own content type — the
        // pre-R3 leg attached only the first file, as PDF.
        const attachments = files.map((f) => {
          let binary = "";
          for (let i = 0; i < f.bytes.length; i += 8192) binary += String.fromCharCode(...f.bytes.subarray(i, i + 8192));
          return { fileName: f.fileName, contentType: f.contentType, contentBase64: btoa(binary) };
        });
        // Issue #1941: try cfpay A2A first (matching Slack and the direct
        // publishers), then fall back to local ETradeEmailTradingService
        // and check the boolean return value so a missing/failing binding
        // never produces a false 'delivered' receipt.
        const cfpay = getCfpayConfig(deps.env);
        let a2aError: string | undefined;
        if (cfpay) {
          const r = attachments.length > 0
            ? await cfpaySendEmailWithAttachments(cfpay, {
                to,
                subject,
                body: text,
                attachments: attachments.map((a) => ({
                  filename: a.fileName,
                  contentB64: a.contentBase64,
                  contentType: a.contentType,
                })),
              })
            : await cfpaySendEmail(cfpay, to, subject, text);
          if (r.ok) {
            return { ok: true, ...(missingNote ? { detail: missingNote } : {}) };
          }
          a2aError = r.error || "cfpay A2A email send failed";
          structuredLog.warn("screener_followup.cfpay_email_failed", {
            message: "[screenerFollowupDelivery] cfpay email failed, falling back to local",
            error: a2aError,
          });
        }
        let orm: DatabaseORM | undefined;
        try {
          orm = deps.getOrm();
        } catch {
          orm = undefined;
        }
        const email = new ETradeEmailTradingService(deps.env, orm, userLogin);
        const sent = await email.sendOutboundEmail(
          to,
          subject,
          `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
          text,
          attachments.length > 0 ? attachments : undefined,
        );
        if (!sent) {
          return {
            ok: false,
            error: a2aError
              ? `cfpay email failed (${a2aError}) and local email send failed (env.EMAIL binding is not configured or send failed).`
              : "Outbound email send failed (env.EMAIL binding is not configured or send failed).",
          };
        }
        return { ok: true, ...(missingNote ? { detail: missingNote } : {}) };
      }
      const webhookUrl = outcome.webhookUrl ?? config.channels.webhook.url;
      if (!webhookUrl) return { ok: false, error: "Webhook delivery is not configured (SCREENER_WEBHOOK_URL is unset)." };
      const webhook = new ETradeWebhookService(deps.getOrm(), deps.env, userLogin);
      await webhook.dispatchOutboundWebhook(
        "screener.completed",
        {
          kind: outcome.kind,
          universe: outcome.universe,
          thesis: outcome.thesis,
          totalScanned: outcome.totalScanned,
          matchedCount: outcome.matchedCount,
          reportUrl: outcome.reportUrl,
          artifacts: artifacts.map((a) => a.key),
        },
        webhookUrl,
      );
      return { ok: true };
    },
    // Issue #1123 S4: text-only lifecycle notifications (no artifact).
    notify: async ({ channel, userLogin, text, emailTo, slackChannel }) => {
      const config = resolveScreenerFollowupConfig(deps.env as unknown as Record<string, unknown>);
      // Issue #3169: same gate as deliver() (slack/email only in
      // practice — webhook below keeps its existing error when
      // enabled, and is refused by the gate when disabled).
      const gate = await resolveDeliveryGate(deps, userLogin);
      const tenantChannel = mapScreeningChannelToTenantChannel(channel);
      if (gate && tenantChannel && !gate.isEnabled(tenantChannel)) {
        return { ok: false, error: channelDisabledError(tenantChannel, gate.tenantId) };
      }
      if (channel === "slack") {
        // Issue #1191: per-task channel wins, mirroring deliveries.
        return deliverScreenerToSlack(deps.env, { text, channel: slackChannel ?? config.channels.slack.channel });
      }
      if (channel === "email") {
        // Issue #1191 (#1173 R3): per-task recipient wins, mirroring
        // the executor's allowlist check on the same address.
        const to = emailTo ?? config.channels.email.to;
        if (!to) return { ok: false, error: "Email notification is not configured (SCREENER_EMAIL_TO is unset)." };
        const subject = text.split("\n")[0].slice(0, 120);
        const cfpay = getCfpayConfig(deps.env);
        let a2aError: string | undefined;
        if (cfpay) {
          const r = await cfpaySendEmail(cfpay, to, subject, text);
          if (r.ok) return { ok: true };
          a2aError = r.error || "cfpay A2A email notification failed";
          structuredLog.warn("screener_followup.cfpay_email_notify_failed", {
            message: "[screenerFollowupDelivery] cfpay email notify failed, falling back to local",
            error: a2aError,
          });
        }
        let orm: DatabaseORM | undefined;
        try {
          orm = deps.getOrm();
        } catch {
          orm = undefined;
        }
        const email = new ETradeEmailTradingService(deps.env, orm, userLogin);
        const sent = await email.sendOutboundEmail(
          to,
          subject,
          `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
          text,
        );
        if (!sent) {
          return {
            ok: false,
            error: a2aError
              ? `cfpay email notification failed (${a2aError}) and local email send failed (env.EMAIL binding is not configured or send failed).`
              : "Outbound email notification failed (env.EMAIL binding is not configured or send failed).",
          };
        }
        return { ok: true };
      }
      return { ok: false, error: "Webhook is a delivery channel, not a notification channel." };
    },
  };
}
