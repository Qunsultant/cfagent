/**
 * Issue #3311 — webhook-triggered scheduling: the domain core of the
 * webhook follow-up mint.
 *
 * A workflow step calls POST /api/schedules/webhook/followup; the
 * scheduler mints a scheduled follow-up job/sub-job on the async-job
 * chain. This module is pure domain code (no DO access, no fetch, no
 * env reads): the capability allow-list, the submission builder, and
 * the mint ledger-record builder. The edge handler
 * (src/server/routes/scheduleWebhook.ts) owns HMAC/throttle/replay;
 * the DO route (src/agents/routes/schedules.ts) owns identity, PDP,
 * and the submitAsyncJob call.
 *
 * Rules consumed from #3122 (not re-invented):
 *  - PDP enforcement + tenant scope (per-login instance) at the DO
 *    route via evaluateAgentSchedulePdp (task:create); this module
 *    does not authorize.
 *  - The follow-up capability allow-list mirrors the T4 follow-up
 *    family (followup.report / deliver / notify) — the only
 *    capabilities a webhook may mint. Anything else is refused, the
 *    F1 allow-list discipline applied to this new entry point.
 *  - The §4 correlation ID (trigger, scheduleId, asyncJobId,
 *    workflowId) rides the payload's ledgerLinkage and the mint
 *    ledger row, exactly as the T4 planners stamp it
 *    (followupLedgerLinkage in screenerFollowups.ts).
 *  - No self-re-arm: minting requires the HMAC secret, which a
 *    follow-up payload never carries (the edge rebuilds the forwarded
 *    request from the validated body; zod strips unknown keys).
 */
import type { LedgerLinkage } from "../data/jobRunRecordPorts";
import type { JobRunRecord } from "../data/jobRunRecordPorts";
import type { AsyncJobSubmission } from "../types";
import type { ScheduleWebhookFollowupBody } from "../api/ingressSchemas";
import {
  followupChannelLabel,
  screenerKindLabel,
  type ScreenerRunOutcome,
} from "../services/screenerFollowups";

/** Audit events for the webhook path (emitted via ctx.audit at the DO route). */
export const SCHEDULE_WEBHOOK_AUDIT_EVENTS = {
  received: "schedule.webhook.received",
  denied: "schedule.webhook.denied",
  minted: "schedule.webhook.followup_minted",
  mintLedgerFailed: "schedule.webhook.mint_ledger_failed",
} as const;

/** The mint ledger row's operation (the follow-up's own execution rows carry the chain's operations). */
export const SCHEDULE_WEBHOOK_MINT_OPERATION = "schedule.webhook.followup_minted";

/**
 * The only follow-up capabilities a webhook may mint — the T4
 * follow-up family. Anything else (SDK callbacks, goal operations,
 * http.request, mcp.tool, …) is refused: the webhook mints
 * follow-ups onto the chain, it does not arm schedules or run tools.
 */
export const SCHEDULE_WEBHOOK_FOLLOWUP_CAPABILITIES = [
  "followup.report",
  "followup.deliver",
  "followup.notify",
] as const;

export type ScheduleWebhookFollowupCapability =
  (typeof SCHEDULE_WEBHOOK_FOLLOWUP_CAPABILITIES)[number];

export function isScheduleWebhookFollowupCapability(
  value: unknown,
): value is ScheduleWebhookFollowupCapability {
  return (
    typeof value === "string" &&
    (SCHEDULE_WEBHOOK_FOLLOWUP_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * Build the async-job submission for a validated webhook body.
 * Throws a business error (never a technical one) on: an unknown
 * capability, an unparseable runAt, or a missing per-capability
 * requirement (channel/artifacts for deliver, channel/event for
 * notify). The caller maps the throw to a 400.
 *
 * Linkage: trigger "webhook" on the job row (ASYNC_JOB_TRIGGERS
 * already carries it); the payload's ledgerLinkage carries trigger
 * "async-chain" (the follow-up joins the async chain) with the
 * webhook's scheduleId/workflowId and the parent job id as
 * asyncJobId — submitAsyncJob restamps asyncJobId to the minted
 * row's own id (S4), so the pre-submit value is the parent, never
 * a fabricated id. The outcome copy carries the webhook's
 * correlation ids even when the outcome itself lacks them.
 */
export function buildScheduleWebhookFollowupSubmission(
  body: ScheduleWebhookFollowupBody,
): AsyncJobSubmission {
  if (!isScheduleWebhookFollowupCapability(body.capability)) {
    throw new Error(
      `Follow-up capability '${String(body.capability)}' is not webhook-mintable. Allowed: followup.report, followup.deliver, followup.notify.`,
    );
  }
  if (!Number.isFinite(Date.parse(body.runAt))) {
    throw new Error("runAt must be an ISO timestamp.");
  }
  const outcome: ScreenerRunOutcome = {
    ...(body.outcome as unknown as ScreenerRunOutcome),
    scheduleId: body.scheduleId ?? body.outcome.scheduleId,
    workflowId: body.workflowId,
  };
  const linkage: LedgerLinkage = {
    trigger: "async-chain",
    scheduleId:
      typeof outcome.scheduleId === "string" && outcome.scheduleId ? outcome.scheduleId : null,
    asyncJobId:
      typeof body.asyncJobId === "string" && body.asyncJobId ? body.asyncJobId : null,
    workflowId: body.workflowId,
  };
  const kindLabel = screenerKindLabel(outcome.kind);
  const graph = {
    parentJobId: body.asyncJobId ?? null,
    trigger: "webhook" as const,
    triggeredBy: "webhook",
    scheduleId: body.scheduleId ?? null,
    runAt: body.runAt,
    ...(body.chainId ? { chainId: body.chainId } : {}),
  };
  if (body.capability === "followup.report") {
    const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
    return {
      capability: "followup.report",
      payload: {
        outcome,
        userLogin: body.userLogin,
        ledgerLinkage: linkage,
        ...(body.retryOf ? { retryOf: body.retryOf } : {}),
        ...(body.chainId ? { chainId: body.chainId } : {}),
      },
      jobKind: "report",
      displayName: `Generate report — ${kindLabel} screen${scope ? ` (${scope})` : ""}`,
      ...graph,
    } as AsyncJobSubmission;
  }
  if (body.capability === "followup.deliver") {
    if (!body.channel) {
      throw new Error("A followup.deliver follow-up requires a channel.");
    }
    if (!body.artifacts || body.artifacts.length === 0) {
      throw new Error("A followup.deliver follow-up requires artifacts.");
    }
    return {
      capability: "followup.deliver",
      payload: {
        outcome,
        userLogin: body.userLogin,
        channel: body.channel,
        artifacts: body.artifacts,
        ledgerLinkage: linkage,
        ...(body.retryOf ? { retryOf: body.retryOf } : {}),
      },
      jobKind: "delivery",
      channel: body.channel,
      displayName: `Deliver by ${followupChannelLabel(body.channel)} — ${kindLabel} screen`,
      ...graph,
    } as AsyncJobSubmission;
  }
  if (!body.channel) {
    throw new Error("A followup.notify follow-up requires a channel.");
  }
  if (!body.event) {
    throw new Error("A followup.notify follow-up requires an event.");
  }
  return {
    capability: "followup.notify",
    payload: {
      event: body.event,
      outcome,
      userLogin: body.userLogin,
      channel: body.channel,
      ledgerLinkage: linkage,
    },
    jobKind: "notification",
    channel: body.channel,
    // Webhook-minted naming uses the event value as-is; T4's planner
    // capitalizes via its private EVENT_LABEL — the value reads the
    // same in the ledger either way.
    displayName: `Notify: ${body.event} via ${followupChannelLabel(body.channel)}`,
    ...graph,
  } as AsyncJobSubmission;
}

/**
 * Build the mint ledger row: the webhook call's effect, recorded in
 * the consolidated run ledger with the correlation ID. Trigger
 * "async-chain" (the minted job joins the async chain — the five-
 * valued LEDGER_TRIGGERS vocabulary is unchanged; the webhook
 * origin reads off the job row's trigger "webhook" and this row's
 * operation). triggeredBy "scheduled" (the follow-up is a scheduled
 * job). asyncJobId is the minted row's own id.
 */
export function buildScheduleWebhookMintRecord(input: {
  jobId: string;
  body: ScheduleWebhookFollowupBody;
  nowIso: string;
}): Omit<JobRunRecord, "system"> {
  return {
    jobId: input.jobId,
    operation: SCHEDULE_WEBHOOK_MINT_OPERATION,
    started: input.nowIso,
    finished: input.nowIso,
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "async-chain",
    scheduleId: input.body.scheduleId ?? null,
    asyncJobId: input.jobId,
    workflowId: input.body.workflowId,
    detail: `Webhook follow-up minted: ${input.body.capability} for workflow ${input.body.workflowId} at ${input.body.runAt}.`,
  };
}
