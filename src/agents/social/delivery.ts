/**
 * #1077 Phase 5b slice 3 — Slack approval-card delivery.
 *
 * When publishDueDrafts records a pending approval (an approval-channel
 * draft awaiting a human decision), this module delivers it as a Block
 * Kit card with Approve/Reject buttons — the Phase 5a "record only"
 * flow gains its delivery half. Nothing here publishes: delivery only
 * asks; approval handling lives in interactions.ts / approvalActions.ts.
 *
 * Delivery rules (fail-closed, never duplicate):
 * - Exactly ONE destination per attempt: the incoming webhook when
 *   SLACK_WEBHOOK_URL is configured, else chat.postMessage via
 *   SLACK_BOT_TOKEN. (The trading agent tries webhook, then bot, then
 *   cfpay, which can double-deliver; approval cards must not duplicate,
 *   so this module falls back to the bot ONLY when the webhook call
 *   itself failed — a delivered card is never re-sent on success.)
 * - cfpay slack.post is NOT used: it carries text only, no blocks, so
 *   it cannot carry buttons. The channel is never hardcoded: it
 *   resolves SOCIAL_SLACK_CHANNEL, then SLACK_CHANNEL_ID, then
 *   SLACK_CHANNEL (the screener convention), and a bot-token delivery
 *   without any channel is an honest error, not a guess.
 * - Idempotency is per (date, channel, draftId): a pending record
 *   whose deliveredDraftId already equals its draftId is skipped, and
 *   a rebuilt draft (new draftId) re-delivers. A failed or
 *   undeliverable attempt never marks the record, so the next pass
 *   retries. Drafts that are posted, failed, approved, or missing
 *   never get a card — only status "draft" records do.
 * - The card carries date, channel, and the draft text ONLY. The text
 *   renders as plain_text, so user content can never inject mrkdwn.
 *   Button values encode date|channel|draftId; the interaction
 *   handler verifies the draftId against the pending record, so a
 *   stale card cannot approve a rebuilt draft.
 * - This module never throws for per-record problems: every outcome
 *   is a result entry, so one bad record can never take down a pass.
 */

import type { SocialLedger } from "./ledger";
import type { PendingApproval, PendingApprovalStore } from "./approvals";
import { isBriefDate } from "./briefStore";
import { KNOWN_SOCIAL_CHANNELS } from "./config";

/** Minimal post surface: tests inject a fake; production passes fetch. */
export interface SlackPostFn {
  (url: string, headers: Record<string, string>, body: string): Promise<{
    status: number;
    body: string;
  }>;
}

/** Production poster over global fetch. */
export const fetchSlackPost: SlackPostFn = async (url, headers, body) => {
  const res = await fetch(url, { method: "POST", headers, body });
  return { status: res.status, body: await res.text().catch(() => "") };
};

export interface SlackDeliveryEnv {
  SOCIAL_SLACK_CHANNEL?: string;
  SLACK_CHANNEL_ID?: string;
  SLACK_CHANNEL?: string;
  /** Issue #5083 (S4) — the screener alert channel (the alerting destination). */
  SCREENER_SLACK_CHANNEL?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
  [key: string]: string | undefined;
}

/** Channel resolution: social-specific first, then the shared Slack channel names. Never a hardcoded id. */
export function resolveSocialSlackChannel(env: SlackDeliveryEnv): string | undefined {
  return env.SOCIAL_SLACK_CHANNEL || env.SLACK_CHANNEL_ID || env.SLACK_CHANNEL || undefined;
}

export type SlackTextResult =
  | { ok: true; method: "webhook" | "bot" }
  | { ok: false; error: string; noDestination?: boolean };

/**
 * Post plain text through the existing Slack route (webhook, else bot).
 * Mirrors deliverApprovalCard's destination order; judges the bot reply
 * by Slack's {ok} field, not just the HTTP status. Returns noDestination
 * ONLY when neither a webhook nor a bot token is configured at all — a
 * configured destination that fails is a failure, not a missing config.
 *
 * Issue #5083 (S4) — moved here from src/agents/resourceGoals.ts so
 * the one alerting port (src/observability/otelAlerting.ts) can reuse
 * this single Slack text route without a circular import
 * (resourceGoals imports the port for the cap alert; the port imports
 * this). resourceGoals re-exports it, so its existing callers are
 * unchanged. The optional `channel` overrides the resolution: the
 * alerting port passes SCREENER_SLACK_CHANNEL explicitly (the owner
 * decision: Slack alerts go to SCREENER_SLACK_CHANNEL); when it is
 * unset the shared resolution above applies.
 */
export async function postSlackText(deps: {
  post: SlackPostFn;
  env: SlackDeliveryEnv;
  text: string;
  channel?: string;
}): Promise<SlackTextResult> {
  const webhookUrl = deps.env.SLACK_WEBHOOK_URL;
  let webhookError: string | undefined;
  if (webhookUrl) {
    try {
      const res = await deps.post(
        webhookUrl,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({ text: deps.text })
      );
      if (res.status >= 200 && res.status < 300) return { ok: true, method: "webhook" };
      webhookError = `Slack webhook delivery failed: HTTP ${res.status}`;
    } catch (err) {
      webhookError = `Slack webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const token = deps.env.SLACK_BOT_TOKEN;
  const channel = deps.channel || resolveSocialSlackChannel(deps.env);
  if (!token) {
    return {
      ok: false,
      error: webhookError ?? "No Slack webhook URL or bot token is configured for delivery",
      noDestination: webhookUrl ? undefined : true,
    };
  }
  if (!channel) {
    return {
      ok: false,
      error: "No Slack channel is configured for delivery (set SOCIAL_SLACK_CHANNEL or SLACK_CHANNEL)",
    };
  }
  try {
    const res = await deps.post(
      "https://slack.com/api/chat.postMessage",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ channel, text: deps.text })
    );
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Slack chat.postMessage failed: HTTP ${res.status}` };
    }
    let data: { ok?: boolean; error?: string } = {};
    try {
      data = JSON.parse(res.body) as { ok?: boolean; error?: string };
    } catch {
      return { ok: false, error: "Slack chat.postMessage returned an unreadable response" };
    }
    if (data.ok) return { ok: true, method: "bot" };
    return { ok: false, error: `Slack chat.postMessage failed: ${data.error ?? "unknown error"}` };
  } catch (err) {
    return {
      ok: false,
      error: `Slack chat.postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ApprovalCardInput {
  date: string;
  channel: string;
  draftId: string;
  text: string;
}

/** Button value encoding: date|channel|draftId. Parsed by parseApprovalCardValue. */
export function approvalCardValue(date: string, channel: string, draftId: string): string {
  return `${date}|${channel}|${draftId}`;
}

/** Strict parse: bad date, unknown channel, or wrong shape is null, never a minted approval target. */
export function parseApprovalCardValue(
  value: unknown,
): { date: string; channel: string; draftId: string } | null {
  if (typeof value !== "string") return null;
  const parts = value.split("|");
  if (parts.length !== 3) return null;
  const [date, channel, draftId] = parts;
  if (!isBriefDate(date)) return null;
  if (!(KNOWN_SOCIAL_CHANNELS as readonly string[]).includes(channel)) return null;
  if (!draftId) return null;
  return { date, channel, draftId };
}

/**
 * Block Kit approval card. The draft text is a plain_text section:
 * user content must never render as mrkdwn. The header and fields use
 * only validated values (date, channel), never free text.
 */
export function buildApprovalCard(input: ApprovalCardInput): unknown[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Social post awaiting approval", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Channel:*\n${input.channel}` },
        { type: "mrkdwn", text: `*Date:*\n${input.date}` },
      ],
    },
    {
      type: "section",
      text: { type: "plain_text", text: input.text, emoji: false },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          action_id: "social_approve",
          value: approvalCardValue(input.date, input.channel, input.draftId),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject", emoji: true },
          style: "danger",
          action_id: "social_reject",
          value: approvalCardValue(input.date, input.channel, input.draftId),
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Approving publishes this post promptly. Rejecting discards the draft (the record is retained).",
        },
      ],
    },
  ];
}

export type ApprovalDeliveryResult =
  | { ok: true; method: "webhook" | "bot" }
  | { ok: false; error: string };

/**
 * Deliver one card to exactly one destination: the webhook when
 * configured, else chat.postMessage via the bot token. A webhook
 * failure falls back to the bot token (when configured); a bot
 * chat.postMessage failure is judged by Slack's own {ok} field, not
 * just the HTTP status. No destination configured, or a bot token
 * without a channel, is an honest error — never a guessed target.
 */
export async function deliverApprovalCard(input: {
  post: SlackPostFn;
  env: SlackDeliveryEnv;
  card: ApprovalCardInput;
}): Promise<ApprovalDeliveryResult> {
  const blocks = buildApprovalCard(input.card);
  const text = `Social post awaiting approval — ${input.card.channel} — ${input.card.date}`;
  const webhookUrl = input.env.SLACK_WEBHOOK_URL;
  let webhookError: string | undefined;
  if (webhookUrl) {
    try {
      const res = await input.post(
        webhookUrl,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({ text, blocks }),
      );
      if (res.status >= 200 && res.status < 300) return { ok: true, method: "webhook" };
      webhookError = `Slack webhook delivery failed: HTTP ${res.status}`;
    } catch (err) {
      webhookError = `Slack webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const token = input.env.SLACK_BOT_TOKEN;
  const channel = resolveSocialSlackChannel(input.env);
  if (!token) {
    return {
      ok: false,
      error: webhookError ?? "No Slack webhook URL or bot token is configured for delivery",
    };
  }
  if (!channel) {
    return { ok: false, error: "No Slack channel is configured for delivery (set SOCIAL_SLACK_CHANNEL or SLACK_CHANNEL)" };
  }
  try {
    const res = await input.post(
      "https://slack.com/api/chat.postMessage",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ channel, text, blocks }),
    );
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Slack chat.postMessage failed: HTTP ${res.status}` };
    }
    let data: { ok?: boolean; error?: string } = {};
    try {
      data = JSON.parse(res.body) as { ok?: boolean; error?: string };
    } catch {
      return { ok: false, error: "Slack chat.postMessage returned an unreadable response" };
    }
    if (data.ok) return { ok: true, method: "bot" };
    return { ok: false, error: `Slack chat.postMessage failed: ${data.error ?? "unknown error"}` };
  } catch (err) {
    return {
      ok: false,
      error: `Slack chat.postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface PendingDeliveryResult {
  date: string;
  channel: string;
  delivered: boolean;
  method?: "webhook" | "bot";
  skipped?: string;
  error?: string;
}

/**
 * Deliver every undelivered pending approval for the given dates.
 * Never throws for per-record problems: store failures and delivery
 * failures become result entries, so one bad record can never take
 * down a pass — and a failed delivery never marks the record, so the
 * next pass retries it.
 */
export async function deliverPendingApprovals(input: {
  store: SocialLedger;
  approvals: PendingApprovalStore;
  dates: string[];
  post: SlackPostFn;
  env: SlackDeliveryEnv;
}): Promise<PendingDeliveryResult[]> {
  const out: PendingDeliveryResult[] = [];
  for (const date of input.dates) {
    let pending: PendingApproval[];
    try {
      pending = await input.approvals.listPending(date);
    } catch (err) {
      out.push({
        date,
        channel: "*",
        delivered: false,
        error: `pending list failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const record of pending) {
      const base = { date, channel: record.channel };
      try {
        const draft = await input.store.getDraft(date, record.channel);
        if (!draft) {
          out.push({ ...base, delivered: false, skipped: "no draft" });
          continue;
        }
        if (draft.status !== "draft") {
          out.push({ ...base, delivered: false, skipped: `draft already ${draft.status}` });
          continue;
        }
        if (draft.id !== record.draftId) {
          out.push({ ...base, delivered: false, skipped: "draft id mismatch (stale pending)" });
          continue;
        }
        if (record.deliveredDraftId === record.draftId) {
          out.push({ ...base, delivered: false, skipped: "already delivered" });
          continue;
        }
        const res = await deliverApprovalCard({
          post: input.post,
          env: input.env,
          card: { date, channel: record.channel, draftId: record.draftId, text: draft.text },
        });
        if (!res.ok) {
          out.push({ ...base, delivered: false, error: res.error });
          continue;
        }
        await input.approvals.recordPending({ ...record, deliveredDraftId: record.draftId });
        out.push({ ...base, delivered: true, method: res.method });
      } catch (err) {
        out.push({
          ...base,
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return out;
}
