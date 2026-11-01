/**
 * Issue #2041 S4 — saga outcome notices (gap G-OUTCOME-NOTICE).
 *
 * A terminal saga outcome is noticed through the EXISTING
 * delivery channels: a Slack text post (mirroring
 * postSlackJourneyPrompt: same token + channel resolution, same
 * best-effort receipts) plus the UI row the status route already
 * serves from the same run id. The notice copy resolves from the
 * single outcome catalog (businessMessage → channels, never
 * inline strings; unknown codes pass through unresolved, never
 * invented — the raw code stays visible).
 *
 * A failed post is a visible failed receipt, never a thrown
 * error and never a silent absence; the flow records it in a
 * saga.outcome_notice audit row and the saga still ends.
 * Email is NOT built here: saga outcomes have no report-backed
 * delivery path to ride, and the brief allows email only on
 * existing delivery without new infrastructure.
 */
import { codedMessage, resolveOutcome } from "../outcomes/outcomeAspects";

export interface SagaOutcomeNotice {
  code: string;
  sagaId: string;
  runRequestId: string;
  statusUrl: string;
  text: string;
}

export interface SagaOutcomeNoticeReceipts {
  slack: "posted" | "skipped" | "failed";
  slackChannel?: string;
  slackTs?: string;
  slackDetail?: string;
}

export function buildSagaOutcomeNotice(input: {
  sagaId: string;
  runRequestId: string;
  outcomeCode: string;
  statusUrl: string;
}): SagaOutcomeNotice {
  const resolved = resolveOutcome(input.outcomeCode);
  const message = resolved.resolved
    ? codedMessage(input.outcomeCode)
    : `Saga ${input.sagaId} ended with outcome ${input.outcomeCode} (not in the outcome catalog).`;
  return {
    code: input.outcomeCode,
    sagaId: input.sagaId,
    runRequestId: input.runRequestId,
    statusUrl: input.statusUrl,
    text: `${message} Saga: ${input.sagaId}. Status: ${input.statusUrl}`,
  };
}

/**
 * Post the notice to Slack, mirroring postSlackJourneyPrompt:
 * token first, then SLACK_CHANNEL, then SCREENER_SLACK_CHANNEL.
 * No token or no channel → skipped receipt (recorded, never a
 * guess at a destination). Attempted but failed → failed
 * receipt. Never throws.
 */
export async function postSlackSagaOutcome(
  notice: SagaOutcomeNotice,
  env: { SLACK_BOT_TOKEN?: string },
): Promise<SagaOutcomeNoticeReceipts> {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return { slack: "skipped", slackDetail: "no Slack bot token configured" };
  const envRec = env as Record<string, unknown>;
  const channel =
    typeof envRec["SLACK_CHANNEL"] === "string"
      ? (envRec["SLACK_CHANNEL"] as string)
      : typeof envRec["SCREENER_SLACK_CHANNEL"] === "string"
        ? (envRec["SCREENER_SLACK_CHANNEL"] as string)
        : undefined;
  if (!channel) {
    return {
      slack: "skipped",
      slackDetail: "no Slack channel configured (SLACK_CHANNEL/SCREENER_SLACK_CHANNEL)",
    };
  }
  try {
    const res = await fetch(new URL("https://slack.com/api/chat.postMessage"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text: notice.text }),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      ts?: unknown;
      channel?: unknown;
    } | null;
    if (!res.ok || !data?.ok || typeof data.ts !== "string") {
      return { slack: "failed", slackDetail: `Slack post failed (HTTP ${res.status})` };
    }
    return {
      slack: "posted",
      slackChannel: typeof data.channel === "string" ? data.channel : channel,
      slackTs: data.ts,
    };
  } catch (err) {
    return {
      slack: "failed",
      slackDetail: `Slack post threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
