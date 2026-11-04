/**
 * Screening channel delivery (issue #1162, Phase 6 of epic #1096).
 *
 * Channel parity for the screening system — discovery results,
 * recommendation bundles, and goal-driven screen results — over the
 * system's EXISTING transports, with no new channel silos:
 *
 *  - Slack: `deliverScreenerToSlack` (A2A first, direct fallback) —
 *    the unified screener Slack delivery used by research reports.
 *  - Email: `ETradeEmailTradingService.sendOutboundEmail`, guarded by
 *    `validateEmailRecipient` exactly like research report dispatch.
 *  - Webhook: `ETradeWebhookService.dispatchOutboundWebhook` — the
 *    HMAC-SHA256 signed outbound dispatch; it refuses to send at all
 *    when no signing secret is configured, and that honest failure is
 *    surfaced per channel, never papered over.
 *  - Voice: NOT a push channel. Voice reaches the same results
 *    conversationally through the NLQ path (Phase 6 fit-discovery
 *    phrases); a request to "deliver to voice" returns that explicit
 *    explanation instead of a fake success.
 *
 * Senders are injected (the discoveryAlerts #18 pattern): production
 * wiring builds them from env via `createScreeningDeliverySenders`;
 * tests supply spies. A failing channel never blocks the others, and
 * every outcome is reported per channel. Delivery is draft-only under
 * docs/COMPLIANCE.md: texts carry the research-only footer, contain no
 * order instructions, and a delivery attempt is recorded in the
 * screening activity log when a store is supplied.
 */

import type { DatabaseORM } from "../orm";
import { ETradeEmailTradingService } from "../trading";
import { validateEmailRecipient } from "../security/webhookReplay";
import { cfpaySendEmail, getCfpayConfig } from "./cfpayA2A";
import { deliverScreenerToSlack } from "./screenerSlackDelivery";
import { ETradeWebhookService } from "./tradingWebhooks";
import { codedMessage } from "../outcomes/outcomeAspects";
import {
  isEmailAllowed,
  type ScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "./screenerFollowups";
import type { FollowupDeliveryInput } from "./screenerFollowupDelivery";
import type { AsyncJobChannel } from "../types";
import {
  formatRecommendationBundleReport,
  type RecommendationBundle,
} from "./recommendationBundle";
import type {
  DiscoveryModeResult,
} from "./researchDiscovery";
import type { GoalDrivenScreenResult } from "./goalDrivenScreen";
import { recordScreeningActivity } from "./screeningActivity";
import {
  channelDisabledError,
  mapScreeningChannelToTenantChannel,
  type TenantChannelGate,
} from "./tenantChannelGate";

export const SCREENING_DRAFT_FOOTER =
  "Research only — a draft for human review; no trades were placed and no outcome is guaranteed.";

export type ScreeningChannel = "slack" | "email" | "webhook" | "voice";

export interface ScreeningDeliverySenders {
  slack?: (input: { text: string }) => Promise<{ ok: boolean; error?: string }>;
  email?: (input: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  webhook?: (input: {
    event: string;
    data: Record<string, unknown>;
  }) => Promise<{ ok: boolean; error?: string }>;
}

export interface ScreeningChannelResult {
  channel: ScreeningChannel;
  ok: boolean;
  error?: string;
}

const money = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "n/a"
    : `$${Math.round(v).toLocaleString("en-US")}`;

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

export function formatDiscoveryDelivery(result: DiscoveryModeResult): {
  subject: string;
  text: string;
} {
  if (result.direction === "name_to_strategies") {
    const r = result.result;
    const lines: string[] = [
      `Fit discovery — strategies for ${r.symbol} (${r.outlook}, chain provenance: ${r.provenance})`,
      "",
      ...r.candidates.slice(0, 8).map((c, i) => {
        // Null economics renders as unverified, never as $0 or
        // "Unlimited" — money() must never see a fabricated figure.
        const econ = !c.economics
          ? "economics unverified"
          : c.economics.netCredit > 0
            ? `credit ${money(c.economics.netCredit)}/unit`
            : `debit ${money(c.economics.netDebit)}/unit`;
        return (
          `${i + 1}. ${c.label} [${c.source}] — ${c.status}, max loss ${c.economics ? money(c.economics.maxLoss) : "unverified"}/unit, ` +
          `${econ}, scenario worst ${money(c.scenario.worstPnlTotal)} / mean ${money(c.scenario.meanPnlTotal)}`
        );
      }),
      ...(r.candidates.length > 8
        ? [`…and ${r.candidates.length - 8} more candidate(s) in the full result.`]
        : []),
      ...(r.rejected.length > 0
        ? ["", "Rejected by the gates:", ...r.rejected.slice(0, 5).map((x) => `- ${x.structure}: ${x.reason}`)]
        : []),
      ...(r.notConstructible.length > 0
        ? [`Not constructible from a provider chain yet: ${r.notConstructible.join(", ")}.`]
        : []),
      ...(r.inadmissibleCatalogIds.length > 0
        ? [`Not admissible for this outlook: ${r.inadmissibleCatalogIds.join(", ")}.`]
        : []),
      ...r.limitations.map((l) => `Limitation: ${l}`),
      "",
      SCREENING_DRAFT_FOOTER,
    ];
    return {
      subject: `Fit discovery: strategies for ${r.symbol} (${r.candidates.length} candidate(s))`,
      text: lines.join("\n"),
    };
  }

  const r = result.result;
  const lines: string[] = [
    `Fit discovery — names for ${r.structure}`,
    "",
    ...r.ranked.slice(0, 8).map((f, i) => {
      const missing =
        f.missingComponents.length > 0
          ? ` (not scored: ${f.missingComponents.join(", ")})`
          : "";
      return (
        `${i + 1}. ${f.symbol} — fit ${f.fitScore.toFixed(1)}, ${f.status} (provenance ${f.provenance}), ` +
        `max loss ${f.economics ? money(f.economics.maxLoss) : "unverified"}/unit${missing}`
      );
    }),
    ...(r.ranked.length > 8
      ? [`…and ${r.ranked.length - 8} more name(s) in the full result.`]
      : []),
    ...(r.rejected.length > 0
      ? ["", "Not scored:", ...r.rejected.slice(0, 5).map((x) => `- ${x.symbol}: ${x.reason}`)]
      : []),
    ...r.limitations.map((l) => `Limitation: ${l}`),
    "",
    SCREENING_DRAFT_FOOTER,
  ];
  return {
    subject: `Fit discovery: names for ${r.structure} (${r.ranked.length} ranked)`,
    text: lines.join("\n"),
  };
}

export function formatGoalScreenDelivery(result: GoalDrivenScreenResult): {
  subject: string;
  text: string;
} {
  const partial =
    result.status === "partial"
      ? `PARTIAL — ${result.partial?.failedClasses.join(", ") ?? "some asset classes"} failed: ${Object.values(result.partial?.reasons ?? {}).join("; ")}`
      : result.status === "failed"
        ? "FAILED — the screen produced no complete result."
        : "Complete.";
  const lines: string[] = [
    `Goal screen — ${result.goalKind} (${result.outlook}): ${partial}`,
    `Scanned ${result.counts.stocksScanned} stocks (${result.counts.stocksMatched} matched), ${result.counts.optionsUnderlyingsScanned} option underlyings (${result.counts.optionsContractsMatched} contracts matched); ${result.counts.hits} hit(s).`,
    "",
    ...result.hits.slice(0, 10).map(
      (h) =>
        `- ${h.symbol} (${h.assetClass} via ${h.providerId})${h.structures?.length ? ` — candidate for ${h.structures.join(", ")}` : ""}`
    ),
    ...(result.hits.length > 10 ? [`…and ${result.hits.length - 10} more hit(s).`] : []),
    "",
    SCREENING_DRAFT_FOOTER,
  ];
  return {
    subject: `Goal screen (${result.goalKind}): ${result.counts.hits} hit(s)${result.status === "partial" ? " — PARTIAL" : ""}`,
    text: lines.join("\n"),
  };
}

export function formatBundleDelivery(bundle: RecommendationBundle): {
  subject: string;
  text: string;
} {
  return {
    subject: `Recommendation bundle — ${bundle.trade?.label ?? "No trade"} (${bundle.qualification}, ${bundle.confidence} confidence)`,
    text: `${formatRecommendationBundleReport(bundle)}\n\n${SCREENING_DRAFT_FOOTER}`,
  };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * Deliver one piece of screening content over the requested channels.
 * Every channel is attempted independently; the per-channel results
 * are returned in request order. When `sql` + `userLogin` are given,
 * the attempt is recorded in the screening activity log.
 *
 * Issue #3169: when `channelGate` is supplied, a channel the
 * tenant disabled records a per-channel failure and its sender
 * is never attempted; other channels still send. Without a gate
 * the behavior is unchanged (callers without tenant context
 * pass none).
 */
export async function deliverScreeningContent(input: {
  channels: ScreeningChannel[];
  subject: string;
  text: string;
  /** Webhook event name, e.g. "screening.bundle". */
  event: string;
  data?: Record<string, unknown>;
  emailTo?: string;
  senders: ScreeningDeliverySenders;
  sql?: { exec: (q: string, ...a: unknown[]) => Iterable<unknown> };
  userLogin?: string;
  actor?: string;
  /** Tenant channel gate (#3169); absent = ungated (prior behavior). */
  channelGate?: TenantChannelGate;
}): Promise<ScreeningChannelResult[]> {
  const results: ScreeningChannelResult[] = [];
  for (const channel of input.channels) {
    if (channel === "voice") {
      results.push({
        channel,
        ok: false,
        error:
          "Voice is a conversational channel, not a push transport: screening results are spoken through the NLQ/chat path (e.g. ask \"what strategies fit NVDA?\"). Nothing was sent.",
      });
      continue;
    }
    // Issue #3169: a tenant-disabled channel is refused before
    // any sender is attempted. Voice never reaches here (above).
    const tenantChannel = mapScreeningChannelToTenantChannel(channel);
    if (
      input.channelGate &&
      tenantChannel &&
      !input.channelGate.isEnabled(tenantChannel)
    ) {
      results.push({
        channel,
        ok: false,
        error: channelDisabledError(tenantChannel, input.channelGate.tenantId),
      });
      continue;
    }
    const sender = input.senders[channel];
    if (!sender) {
      results.push({
        channel,
        ok: false,
        error: `Channel "${channel}" is not configured for screening delivery.`,
      });
      continue;
    }
    try {
      if (channel === "slack") {
        const r = await sender({ text: input.text } as never);
        results.push({ channel, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      } else if (channel === "email") {
        if (!input.emailTo) {
          results.push({
            channel,
            ok: false,
            error: "No email recipient was supplied; screening delivery never guesses a recipient.",
          });
          continue;
        }
        const r = await (sender as NonNullable<ScreeningDeliverySenders["email"]>)({
          to: input.emailTo,
          subject: input.subject,
          text: input.text,
        });
        results.push({ channel, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      } else {
        const r = await (sender as NonNullable<ScreeningDeliverySenders["webhook"]>)({
          event: input.event,
          data: input.data ?? { subject: input.subject, text: input.text },
        });
        results.push({ channel, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      }
    } catch (err) {
      results.push({
        channel,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (input.sql && input.userLogin) {
    const summary =
      `Delivery "${input.subject}": ` +
      results.map((r) => `${r.channel} ${r.ok ? "ok" : `failed (${r.error ?? "unknown"})`}`).join("; ") +
      ".";
    recordScreeningActivity(input.sql, {
      userLogin: input.userLogin,
      kind: "delivery",
      summary,
      detail: { event: input.event, results },
      actor: input.actor,
    });
  }
  return results;
}

/**
 * Production senders over the existing transports. Each sender is
 * present only when its transport can actually be attempted from this
 * environment; the underlying services still fail honestly (e.g. the
 * signed webhook refuses to send without a signing secret).
 */
export function createScreeningDeliverySenders(
  env: unknown,
  orm: DatabaseORM,
  userLogin: string
): ScreeningDeliverySenders {
  const e = (env ?? {}) as Record<string, unknown>;
  const senders: ScreeningDeliverySenders = {};

  senders.slack = async ({ text }) => {
    const r = await deliverScreenerToSlack(env, { text });
    return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  };

  senders.email = async ({ to, subject, text }) => {
    const check = validateEmailRecipient(to, e.EMAIL_TO_ALLOWED_DOMAINS as string | undefined);
    if (!check.ok) return { ok: false, error: check.reason ?? "Recipient not allowed." };
    const cfpay = getCfpayConfig(env);
    if (cfpay) {
      const r = await cfpaySendEmail(cfpay, to, subject, text);
      if (r.ok) return { ok: true };
    }
    const service = new ETradeEmailTradingService(env as never, orm, userLogin);
    const html = `<p>${text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/\n/g, "<br/>")}</p>`;
    const sent = await service.sendOutboundEmail(to, subject, html, text);
    return sent ? { ok: true } : { ok: false, error: "Outbound email service reported a send failure." };
  };

  senders.webhook = async ({ event, data }) => {
    const service = new ETradeWebhookService(orm, env as never, userLogin);
    const r = await service.dispatchOutboundWebhook(event, data);
    return r.success
      ? { ok: true }
      : { ok: false, error: r.error ?? `Webhook dispatch failed (status ${r.status ?? "n/a"}).` };
  };

  return senders;
}

export interface DiscoveryDirectResult {
  channel: AsyncJobChannel;
  ok: boolean;
  error?: string;
}

/**
 * The delivery port surface this helper needs. Declared structurally
 * (not by importing the port factory) so this module keeps no
 * runtime import of screenerFollowupDelivery — that module imports
 * SCREENING_DRAFT_FOOTER from here, and a value import back would
 * be a cycle. The port type itself is imported type-only above
 * (erased at compile time).
 */
export interface DiscoveryDirectPort {
  deliver: (input: FollowupDeliveryInput) => Promise<{ ok: boolean; error?: string; detail?: string }>;
}

/**
 * Consolidation #1236 Phase 1: deliver a non-chain discovery
 * notification directly through the delivery port — the same
 * rendering (draft footer included), transports, and per-channel
 * isolation as the chain path, so direct and chain texts are
 * identical for the same outcome. Channels come ONLY from the
 * outcome's own fields, in CHANNEL_ORDER (slack, email, webhook);
 * a task naming no channels sends nothing. Email is gated by the
 * screener allowlist exactly as the chain executor gates it: a
 * violation is recorded as FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED and email is dropped while
 * the other channels still send. A port throw for one channel is
 * recorded as that channel's failure. This helper NEVER throws, so
 * a delivery problem can never fail the run.
 */
export async function deliverDiscoveryDirect(input: {
  port: DiscoveryDirectPort;
  outcome: ScreenerRunOutcome;
  config: ScreenerFollowupConfig;
  userLogin: string;
  /** Tenant channel gate (#3169); absent = ungated (prior behavior). */
  channelGate?: TenantChannelGate;
}): Promise<DiscoveryDirectResult[]> {
  const { port, outcome, config, userLogin } = input;
  const channels: AsyncJobChannel[] = [];
  if (outcome.slackChannel) channels.push("slack");
  if (outcome.emailTo) channels.push("email");
  if (outcome.webhookUrl) channels.push("webhook");
  const results: DiscoveryDirectResult[] = [];
  for (const channel of channels) {
    // Issue #3169: a tenant-disabled channel is refused before
    // the allowlist check and before the port is called. The
    // refusal uses this funnel's coded-error idiom (the email
    // gate below does the same for its refusal).
    const tenantChannel = mapScreeningChannelToTenantChannel(channel);
    if (
      input.channelGate &&
      tenantChannel &&
      !input.channelGate.isEnabled(tenantChannel)
    ) {
      results.push({
        channel,
        ok: false,
        error: codedMessage(
          "FAILURE_DELIVERY_CHANNEL_DISABLED",
          channelDisabledError(tenantChannel, input.channelGate.tenantId),
        ),
      });
      continue;
    }
    if (channel === "email" && outcome.emailTo && !isEmailAllowed(config, outcome.emailTo, outcome)) {
      results.push({
        channel,
        ok: false,
        error: codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", `recipient ${outcome.emailTo}`),
      });
      continue;
    }
    try {
      const delivered = await port.deliver({ channel, userLogin, outcome, artifacts: [] });
      results.push(delivered.ok
        ? { channel, ok: true }
        : { channel, ok: false, error: delivered.error ?? delivered.detail ?? "delivery failed" });
    } catch (err) {
      results.push({ channel, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
