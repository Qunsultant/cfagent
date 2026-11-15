/**
 * Issue #4608 (parent for #4609, #4610, #4611; sub of #2856) —
 * Channel recipient verification across every delivery channel layer.
 *
 * Architectural decision (where the check lives):
 *   Verification lives at DELIVERY TIME at every channel layer,
 *   never at schedule-creation time alone.
 *
 *   Why:
 *   1. Time-of-check vs time-of-use: a schedule created at t0 can fire at t1
 *      after a tenant membership is revoked, a user's bound email changes,
 *      a tenant's Slack channel mapping changes, or a schedule's bound
 *      webhook URL changes.
 *   2. Multiple delivery entry points: deliveries enter through the async-job
 *      executor (`followup.deliver` and `followup.notify`), the follow-up
 *      delivery port (`createFollowupDeliveryPort`), direct discovery/screening
 *      delivery (`deliverDiscoveryDirect`, `deliverScreeningContent`), gated
 *      Slack dispatch (`deliverGatedSlack`), and bus publishers
 *      (`screenerPublishers`). Schedule-creation checks leave non-schedule
 *      funnels and pre-existing schedules unverified.
 *   3. Single enforcement contract: every layer calls `verifyChannelRecipient`
 *      before attempting any transport send. A recipient outside the run's
 *      `tenant + run` binding is refused with `FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED`
 *      and audited as `delivery.recipient_refused` at the refusing layer.
 */

import { codedMessage } from "../outcomes/outcomeAspects";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { UNRESOLVED_DELIVERY_TENANT } from "./deliveryIdentity";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/channelRecipientVerification",
});

export type VerifiedDeliveryChannel = "email" | "slack" | "webhook";

export type ChannelVerificationLayer =
  | "executor.deliver"
  | "executor.notify"
  | "followup_port.deliver"
  | "followup_port.notify"
  | "discovery_direct"
  | "screening_content"
  | "gated_slack"
  | "publisher";

/** The run identity a delivery is executing on behalf of. */
export interface ChannelRecipientRunScope {
  tenantId?: string | null;
  userLogin?: string | null;
  runId?: string | null;
  scheduleId?: string | null;
}

/**
 * The authoritative recipient binding for a tenant+run.
 * Sub-issues #4609 (email), #4610 (Slack per-tenant mapping), and
 * #4611 (webhook URL binding) populate these fields from their
 * respective stores/resolvers; callers and tests may also supply a
 * binding directly.
 */
export interface ChannelRecipientBinding {
  /** The tenant this binding governs. */
  tenantId: string;
  /** Optional run id this binding is restricted to. */
  runId?: string | null;
  /** Optional schedule id this binding is restricted to. */
  scheduleId?: string | null;
  /** Optional owner login this binding is restricted to. */
  userLogin?: string | null;
  /** Allowed email recipients (normalized case-insensitively) for this tenant+run. */
  emailRecipients?: readonly string[];
  /** Allowed Slack channel ids/names for this tenant+run. */
  slackChannels?: readonly string[];
  /** Allowed outbound webhook URLs for this tenant+run. */
  webhookUrls?: readonly string[];
}

export type ChannelRecipientRefusalReason =
  | "run_tenant_missing"
  | "recipient_tenant_mismatch"
  | "recipient_run_mismatch"
  | "recipient_schedule_mismatch"
  | "recipient_owner_mismatch"
  | "email_recipient_not_in_tenant_run"
  | "slack_channel_not_in_tenant_run"
  | "webhook_url_not_in_tenant_run";

export interface ChannelRecipientAuditPayload extends Record<string, unknown> {
  channel: VerifiedDeliveryChannel;
  recipient: string | null;
  tenantId: string | null;
  bindingTenantId: string;
  userLogin: string | null;
  runId: string | null;
  scheduleId: string | null;
  layer: ChannelVerificationLayer;
  reason: ChannelRecipientRefusalReason;
  detail: string;
}

export type ChannelRecipientVerificationResult =
  | { allowed: true }
  | {
      allowed: false;
      code: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED";
      reason: ChannelRecipientRefusalReason;
      detail: string;
      error: string;
      auditPayload: ChannelRecipientAuditPayload;
    };

export type ChannelRecipientAuditFn = (
  type: "delivery.recipient_refused",
  payload: ChannelRecipientAuditPayload,
) => void;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSlackChannel(value: string): string {
  return value.trim();
}

function normalizeWebhookUrl(value: string): string {
  return value.trim();
}

function normalizeTenantId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === UNRESOLVED_DELIVERY_TENANT) return null;
  return trimmed;
}

/**
 * Extract the tenant segment from a tenant-scoped `scheduledDeliveryIdentity`
 * (`<trigger>:<tenant>:<universe>:<minute>`) when no explicit `tenantId` was
 * stamped on the run scope. Never invents a tenant for `manual:` or `unscoped`.
 */
export function inferTenantFromDeliveryId(deliveryId?: string | null): string | null {
  if (typeof deliveryId !== "string" || !deliveryId.trim()) return null;
  const parts = deliveryId.trim().split(":");
  if (parts[0] === "manual" || parts[0] === "workflow") return null;
  if (parts.length >= 4 && parts[1] && parts[1] !== UNRESOLVED_DELIVERY_TENANT) {
    return parts[1];
  }
  return null;
}

/**
 * Resolve a `ChannelRecipientBinding` from `env.CHANNEL_RECIPIENT_BINDINGS_JSON`
 * when configured (externalized config map keyed by `tenantId` or `*`), or
 * return null when no binding is configured.
 */
export function resolveEnvChannelRecipientBinding(
  env: unknown,
  run: ChannelRecipientRunScope,
): ChannelRecipientBinding | null {
  if (!env || typeof env !== "object") return null;
  const raw = (env as Record<string, unknown>)["CHANNEL_RECIPIENT_BINDINGS_JSON"];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, ChannelRecipientBinding>;
    if (!parsed || typeof parsed !== "object") return null;
    const tenantId = normalizeTenantId(run.tenantId);
    if (tenantId && parsed[tenantId]) {
      return parsed[tenantId];
    }
    if (parsed["*"]) {
      return parsed["*"];
    }
    const keys = Object.keys(parsed);
    if (keys.length === 1) {
      return parsed[keys[0]];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify that `recipient` on `channel` belongs to `run` under `binding`.
 *
 * When `binding` is null or undefined, no tenant+run recipient constraint is
 * active on this call and verification succeeds (`{ allowed: true }`).
 * When `binding` is present, any mismatch on tenant, runId, scheduleId,
 * userLogin, or channel recipient membership fails closed, emits the
 * `delivery.recipient_refused` audit event, and returns the coded refusal.
 */
export function verifyChannelRecipient(input: {
  channel: VerifiedDeliveryChannel;
  recipient?: string | null;
  run: ChannelRecipientRunScope;
  binding?: ChannelRecipientBinding | null;
  layer: ChannelVerificationLayer;
  audit?: ChannelRecipientAuditFn;
}): ChannelRecipientVerificationResult {
  const { channel, run, binding, layer, audit } = input;
  if (!binding) {
    return { allowed: true };
  }

  const recipient = typeof input.recipient === "string" ? input.recipient.trim() : "";
  const runTenantId = normalizeTenantId(run.tenantId) ?? inferTenantFromDeliveryId(run.runId);
  const bindingTenantId = binding.tenantId.trim();

  const refuse = (
    reason: ChannelRecipientRefusalReason,
    detail: string,
  ): ChannelRecipientVerificationResult => {
    const auditPayload: ChannelRecipientAuditPayload = {
      channel,
      recipient: recipient || null,
      tenantId: runTenantId,
      bindingTenantId,
      userLogin: run.userLogin?.trim() || null,
      runId: run.runId?.trim() || null,
      scheduleId: run.scheduleId?.trim() || null,
      layer,
      reason,
      detail,
    };
    try {
      audit?.("delivery.recipient_refused", auditPayload);
    } catch {
      // Best-effort callback; structured log below always records.
    }
    structuredLog.warn("delivery.recipient_refused", auditPayload);
    return {
      allowed: false,
      code: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED",
      reason,
      detail,
      error: codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", detail),
      auditPayload,
    };
  };

  // 1. Tenant verification: the run must belong to the binding's tenant.
  if (!runTenantId) {
    return refuse(
      "run_tenant_missing",
      `run carries no verified tenant for bound ${channel} delivery (expected tenant "${bindingTenantId}")`,
    );
  }
  if (runTenantId !== bindingTenantId) {
    return refuse(
      "recipient_tenant_mismatch",
      `recipient tenant "${bindingTenantId}" does not match run tenant "${runTenantId}"`,
    );
  }

  // 2. Run / schedule / owner scope verification when the binding pins them.
  if (binding.runId) {
    const expectedRunId = binding.runId.trim();
    const actualRunId = run.runId?.trim() || "";
    if (!actualRunId || actualRunId !== expectedRunId) {
      return refuse(
        "recipient_run_mismatch",
        `recipient bound to run "${expectedRunId}", attempted on run "${actualRunId || "none"}"`,
      );
    }
  }

  if (binding.scheduleId) {
    const expectedScheduleId = binding.scheduleId.trim();
    const actualScheduleId = run.scheduleId?.trim() || "";
    if (!actualScheduleId || actualScheduleId !== expectedScheduleId) {
      return refuse(
        "recipient_schedule_mismatch",
        `recipient bound to schedule "${expectedScheduleId}", attempted on schedule "${actualScheduleId || "none"}"`,
      );
    }
  }

  if (binding.userLogin) {
    const expectedLogin = binding.userLogin.trim();
    const actualLogin = run.userLogin?.trim() || "";
    if (!actualLogin || actualLogin !== expectedLogin) {
      return refuse(
        "recipient_owner_mismatch",
        `recipient bound to owner "${expectedLogin}", attempted by "${actualLogin || "none"}"`,
      );
    }
  }

  // 3. Per-channel recipient membership in the tenant+run binding.
  if (channel === "email" && binding.emailRecipients !== undefined) {
    const allowedEmails = binding.emailRecipients.map(normalizeEmail);
    const candidate = normalizeEmail(recipient);
    if (!candidate || !allowedEmails.includes(candidate)) {
      return refuse(
        "email_recipient_not_in_tenant_run",
        `recipient ${recipient || "(empty)"} is not bound to tenant "${bindingTenantId}"${run.runId ? ` run "${run.runId}"` : ""}`,
      );
    }
  } else if (channel === "slack" && binding.slackChannels !== undefined) {
    const allowedChannels = binding.slackChannels.map(normalizeSlackChannel);
    const candidate = normalizeSlackChannel(recipient);
    if (!candidate || !allowedChannels.includes(candidate)) {
      return refuse(
        "slack_channel_not_in_tenant_run",
        `Slack channel ${recipient || "(unmapped)"} is not bound to tenant "${bindingTenantId}"${run.runId ? ` run "${run.runId}"` : ""}`,
      );
    }
  } else if (channel === "webhook" && binding.webhookUrls !== undefined) {
    const allowedUrls = binding.webhookUrls.map(normalizeWebhookUrl);
    const candidate = normalizeWebhookUrl(recipient);
    if (!candidate || !allowedUrls.includes(candidate)) {
      return refuse(
        "webhook_url_not_in_tenant_run",
        `webhook URL ${recipient || "(unbound)"} is not bound to tenant "${bindingTenantId}"${run.scheduleId ? ` schedule "${run.scheduleId}"` : ""}${run.runId ? ` run "${run.runId}"` : ""}`,
      );
    }
  }

  return { allowed: true };
}
