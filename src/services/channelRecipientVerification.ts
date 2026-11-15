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
import { validateEmailRecipient } from "../security/webhookReplay";
import type { Env } from "../types";
import { UNRESOLVED_DELIVERY_TENANT } from "./deliveryIdentity";
import { getStoredEmailDestination } from "./userEmailDestination";

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
  | "publisher"
  | "webhook_service";

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
  | "slack_tenant_channel_unmapped"
  | "webhook_url_not_in_tenant_run"
  | "webhook_tenant_url_unmapped";

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

/**
 * Issue #4609 (G14) — Resolve the authoritative tenant+owner email recipient
 * binding at delivery time.
 *
 * Combines:
 * 1. Explicit `ChannelRecipientBinding` (from caller/outcome or `CHANNEL_RECIPIENT_BINDINGS_JSON`),
 * 2. The run owner's stored email destination (`userEmailDestinationStore(env).get(userLogin)`),
 * 3. Explicit `ownerEmail` carried on the run/outcome/event,
 * 4. Explicit `SCREENER_EMAIL_ALLOWLIST` in `env`.
 *
 * When any owner/tenant email binding is present, caller-supplied `emailTo`
 * from schedule creation is verified against this binding at delivery time
 * instead of being trusted by self-comparison.
 */
export async function resolveTenantOwnerEmailBinding(input: {
  env?: unknown;
  run: ChannelRecipientRunScope;
  ownerEmail?: string | null;
  storedEmailTo?: string | null;
  binding?: ChannelRecipientBinding | null;
}): Promise<{
  binding: ChannelRecipientBinding | null;
  effectiveRun: ChannelRecipientRunScope;
}> {
  const { env, run, ownerEmail, storedEmailTo } = input;
  const envRecord = env && typeof env === "object" ? (env as Record<string, unknown>) : {};
  const explicitBinding = input.binding ?? resolveEnvChannelRecipientBinding(env, run);

  let resolvedStored = typeof storedEmailTo === "string" && storedEmailTo.trim()
    ? storedEmailTo.trim()
    : undefined;
  if (!resolvedStored && run.userLogin?.trim() && envRecord["SESSION_STORE"]) {
    resolvedStored = await getStoredEmailDestination(env as Env, run.userLogin.trim());
  }

  const ownerBoundEmails = new Set<string>();
  if (typeof ownerEmail === "string" && ownerEmail.trim()) {
    ownerBoundEmails.add(normalizeEmail(ownerEmail));
  }
  if (resolvedStored) {
    ownerBoundEmails.add(normalizeEmail(resolvedStored));
  }
  const allowlistRaw =
    typeof envRecord["SCREENER_EMAIL_ALLOWLIST"] === "string"
      ? envRecord["SCREENER_EMAIL_ALLOWLIST"].trim()
      : "";
  if (allowlistRaw) {
    for (const entry of allowlistRaw.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) ownerBoundEmails.add(normalizeEmail(trimmed));
    }
  }

  if (explicitBinding) {
    if (explicitBinding.emailRecipients !== undefined || ownerBoundEmails.size === 0) {
      return { binding: explicitBinding, effectiveRun: run };
    }
    return {
      binding: {
        ...explicitBinding,
        emailRecipients: Array.from(ownerBoundEmails),
      },
      effectiveRun: run,
    };
  }

  if (ownerBoundEmails.size === 0) {
    return { binding: null, effectiveRun: run };
  }

  const resolvedTenantId =
    normalizeTenantId(run.tenantId) ??
    inferTenantFromDeliveryId(run.runId) ??
    (run.userLogin?.trim() ? `owner:${run.userLogin.trim()}` : "owner-scope");

  return {
    binding: {
      tenantId: resolvedTenantId,
      userLogin: run.userLogin?.trim() || null,
      emailRecipients: Array.from(ownerBoundEmails),
    },
    effectiveRun: {
      ...run,
      tenantId: normalizeTenantId(run.tenantId) ?? inferTenantFromDeliveryId(run.runId) ?? resolvedTenantId,
    },
  };
}

/**
 * Issue #4609 (G14) — Delivery-time email recipient verification against
 * format/domain rules AND the run's `tenant + owner` email binding.
 *
 * Refuses with `FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED` and audits
 * `delivery.recipient_refused` at `layer` whenever:
 * - the address fails format or `EMAIL_TO_ALLOWED_DOMAINS` validation, or
 * - the address is outside the run's `tenant + owner` binding (including a
 *   schedule created with someone else's email address).
 */
export async function verifyEmailRecipientAtDelivery(input: {
  recipient?: string | null;
  env?: unknown;
  run: ChannelRecipientRunScope;
  ownerEmail?: string | null;
  storedEmailTo?: string | null;
  binding?: ChannelRecipientBinding | null;
  layer: ChannelVerificationLayer;
  audit?: ChannelRecipientAuditFn;
}): Promise<ChannelRecipientVerificationResult> {
  const { recipient, env, run, ownerEmail, storedEmailTo, binding, layer, audit } = input;
  const trimmedRecipient = typeof recipient === "string" ? recipient.trim() : "";
  const envRecord = env && typeof env === "object" ? (env as Record<string, unknown>) : {};

  if (trimmedRecipient) {
    const allowedDomainsCsv =
      typeof envRecord["EMAIL_TO_ALLOWED_DOMAINS"] === "string"
        ? envRecord["EMAIL_TO_ALLOWED_DOMAINS"]
        : undefined;
    const formatCheck = validateEmailRecipient(trimmedRecipient, allowedDomainsCsv);
    if (!formatCheck.ok) {
      const runTenantId = normalizeTenantId(run.tenantId) ?? inferTenantFromDeliveryId(run.runId);
      const detail = formatCheck.reason ?? `recipient ${trimmedRecipient} failed email validation`;
      const auditPayload: ChannelRecipientAuditPayload = {
        channel: "email",
        recipient: trimmedRecipient,
        tenantId: runTenantId,
        bindingTenantId: binding?.tenantId ?? runTenantId ?? "domain-policy",
        userLogin: run.userLogin?.trim() || null,
        runId: run.runId?.trim() || null,
        scheduleId: run.scheduleId?.trim() || null,
        layer,
        reason: "email_recipient_not_in_tenant_run",
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
        reason: "email_recipient_not_in_tenant_run",
        detail,
        error: codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", detail),
        auditPayload,
      };
    }
  }

  const { binding: resolvedBinding, effectiveRun } = await resolveTenantOwnerEmailBinding({
    env,
    run,
    ownerEmail,
    storedEmailTo,
    binding,
  });

  return verifyChannelRecipient({
    channel: "email",
    recipient: trimmedRecipient,
    run: effectiveRun,
    binding: resolvedBinding,
    layer,
    audit,
  });
}

/**
 * Issue #4610 (G15) — Resolve and verify a tenant's Slack channel at delivery time.
 *
 * When per-tenant Slack channel mapping is active (via `channelGate.slackChannel`,
 * `tenantChannelStore.getTenantSlackChannel`, or `env.TENANT_SLACK_CHANNELS_JSON`):
 * - An unmapped tenant (`slackChannel === null` or missing tenant) is refused with
 *   `FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED` (`reason: "slack_tenant_channel_unmapped"`)
 *   and audited via `delivery.recipient_refused` at `layer`.
 * - A mapped tenant resolves delivery exclusively to its mapped Slack channel
 *   (ignoring deployment-global `SCREENER_SLACK_CHANNEL` / `SLACK_CHANNEL`), and
 *   refuses + audits any explicit `requestedChannel` that does not match the
 *   tenant's mapped channel.
 */
export async function resolveAndVerifySlackRecipientAtDelivery(input: {
  requestedChannel?: string | null;
  envFallbackChannel?: string | null;
  env?: unknown;
  run: ChannelRecipientRunScope;
  channelGate?: { tenantId: string; slackChannel?: string | null } | null;
  tenantChannelStore?: {
    getTenantSlackChannel?: (tenantId: string) => Promise<string | null>;
  } | null;
  binding?: ChannelRecipientBinding | null;
  layer: ChannelVerificationLayer;
  audit?: ChannelRecipientAuditFn;
}): Promise<
  | { allowed: true; channel?: string }
  | {
      allowed: false;
      code: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED";
      reason: ChannelRecipientRefusalReason;
      detail: string;
      error: string;
      auditPayload: ChannelRecipientAuditPayload;
    }
> {
  const {
    requestedChannel,
    envFallbackChannel,
    env,
    run,
    channelGate,
    tenantChannelStore,
    layer,
    audit,
  } = input;
  const envRecord = env && typeof env === "object" ? (env as Record<string, unknown>) : {};
  const runTenantId =
    normalizeTenantId(run.tenantId) ??
    inferTenantFromDeliveryId(run.runId) ??
    normalizeTenantId(channelGate?.tenantId) ??
    null;

  const trimmedRequested =
    typeof requestedChannel === "string" && requestedChannel.trim()
      ? requestedChannel.trim()
      : undefined;
  const trimmedFallback =
    typeof envFallbackChannel === "string" && envFallbackChannel.trim()
      ? envFallbackChannel.trim()
      : undefined;

  let mappingConsulted = false;
  let mappedChannel: string | null = null;

  if (channelGate && channelGate.slackChannel !== undefined) {
    mappingConsulted = true;
    mappedChannel = channelGate.slackChannel;
  } else if (tenantChannelStore && typeof tenantChannelStore.getTenantSlackChannel === "function") {
    mappingConsulted = true;
    mappedChannel = runTenantId
      ? await tenantChannelStore.getTenantSlackChannel(runTenantId)
      : null;
  } else if (
    typeof envRecord["TENANT_SLACK_CHANNELS_JSON"] === "string" &&
    envRecord["TENANT_SLACK_CHANNELS_JSON"].trim()
  ) {
    try {
      const parsed = JSON.parse(envRecord["TENANT_SLACK_CHANNELS_JSON"]) as Record<
        string,
        string | null
      >;
      if (parsed && typeof parsed === "object") {
        mappingConsulted = true;
        const candidate = runTenantId ? parsed[runTenantId] : null;
        mappedChannel =
          typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
      }
    } catch {
      // Malformed JSON is ignored; falls through to verifyChannelRecipient.
    }
  }

  const refuseSlack = (
    reason: ChannelRecipientRefusalReason,
    recipient: string | null,
    detail: string,
  ) => {
    const auditPayload: ChannelRecipientAuditPayload = {
      channel: "slack",
      recipient,
      tenantId: runTenantId,
      bindingTenantId: runTenantId ?? "unmapped-tenant",
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
      allowed: false as const,
      code: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED" as const,
      reason,
      detail,
      error: codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", detail),
      auditPayload,
    };
  };

  let effectiveChannel = trimmedRequested ?? trimmedFallback;

  if (mappingConsulted) {
    if (!runTenantId || !mappedChannel) {
      return refuseSlack(
        "slack_tenant_channel_unmapped",
        trimmedRequested ?? trimmedFallback ?? null,
        `tenant "${runTenantId ?? "unknown"}" has no mapped Slack channel; Slack delivery refused`,
      );
    }
    if (trimmedRequested && trimmedRequested !== mappedChannel) {
      return refuseSlack(
        "slack_channel_not_in_tenant_run",
        trimmedRequested,
        `Slack channel "${trimmedRequested}" does not match tenant "${runTenantId}" mapped channel "${mappedChannel}"`,
      );
    }
    effectiveChannel = mappedChannel;
  }

  const effectiveRun: ChannelRecipientRunScope = {
    ...run,
    tenantId: runTenantId ?? run.tenantId,
  };
  const explicitBinding = input.binding ?? resolveEnvChannelRecipientBinding(env, effectiveRun);
  const check = verifyChannelRecipient({
    channel: "slack",
    recipient: effectiveChannel,
    run: effectiveRun,
    binding: explicitBinding,
    layer,
    audit,
  });
  if (!check.allowed) {
    return check;
  }
  return { allowed: true, channel: effectiveChannel };
}

/**
 * Issue #4611 (G21) — Per-tenant / per-schedule webhook URL entry in
 * `TENANT_WEBHOOK_URLS_JSON`.
 */
export interface TenantWebhookUrlConfigEntry {
  webhookUrl?: string | null;
  defaultUrl?: string | null;
  schedules?: Readonly<Record<string, string>>;
  runId?: string | null;
}

/**
 * Issue #4611 (G21) — Resolve and verify an outbound webhook URL against its
 * `tenant + schedule + run` binding at send time.
 *
 * Signing (`dispatchOutboundWebhook` in `src/services/tradingWebhooks.ts`) is transport-integrity
 * only; recipient authorization is enforced here before any payload is signed or
 * transmitted:
 * - When per-tenant / per-schedule webhook URL mapping is active (via `channelGate`,
 *   `tenantChannelStore`, or `env.TENANT_WEBHOOK_URLS_JSON`), the webhook fires
 *   ONLY to the URL bound to the run's `tenant + schedule + run` (ignoring
 *   deployment-global `OUTBOUND_WEBHOOK_URL` / `SCREENER_WEBHOOK_URL`).
 * - An unmapped tenant/schedule, a mismatched caller-supplied URL, or a mismatched
 *   `tenantId` / `scheduleId` / `runId` is refused with
 *   `FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED` and audited via
 *   `delivery.recipient_refused` at `layer`.
 */
export async function resolveAndVerifyWebhookRecipientAtDelivery(input: {
  requestedUrl?: string | null;
  envFallbackUrl?: string | null;
  env?: unknown;
  run: ChannelRecipientRunScope;
  channelGate?: {
    tenantId: string;
    webhookUrl?: string | null;
    scheduleWebhookUrls?: Readonly<Record<string, string>>;
  } | null;
  tenantChannelStore?: {
    getTenantWebhookUrl?: (tenantId: string, scheduleId?: string | null) => Promise<string | null>;
    getTenantScheduleWebhookUrls?: (tenantId: string) => Promise<Readonly<Record<string, string>>>;
  } | null;
  binding?: ChannelRecipientBinding | null;
  layer: ChannelVerificationLayer;
  audit?: ChannelRecipientAuditFn;
}): Promise<
  | { allowed: true; url?: string }
  | {
      allowed: false;
      code: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED";
      reason: ChannelRecipientRefusalReason;
      detail: string;
      error: string;
      auditPayload: ChannelRecipientAuditPayload;
    }
> {
  const {
    requestedUrl,
    envFallbackUrl,
    env,
    run,
    channelGate,
    tenantChannelStore,
    layer,
    audit,
  } = input;
  const envRecord = env && typeof env === "object" ? (env as Record<string, unknown>) : {};
  const runTenantId =
    normalizeTenantId(run.tenantId) ??
    inferTenantFromDeliveryId(run.runId) ??
    normalizeTenantId(channelGate?.tenantId) ??
    null;
  const runScheduleId =
    typeof run.scheduleId === "string" && run.scheduleId.trim() ? run.scheduleId.trim() : null;

  const trimmedRequested =
    typeof requestedUrl === "string" && requestedUrl.trim() ? requestedUrl.trim() : undefined;
  const trimmedFallback =
    typeof envFallbackUrl === "string" && envFallbackUrl.trim() ? envFallbackUrl.trim() : undefined;

  let mappingConsulted = false;
  let mappedUrl: string | null = null;
  let scheduleMismatchReason = false;
  let mappedRunId: string | null = null;

  if (
    channelGate &&
    (channelGate.webhookUrl !== undefined || channelGate.scheduleWebhookUrls !== undefined)
  ) {
    mappingConsulted = true;
    const scheduleMap = channelGate.scheduleWebhookUrls ?? {};
    const hasScheduleEntries = Object.keys(scheduleMap).length > 0;
    if (runScheduleId && scheduleMap[runScheduleId]) {
      mappedUrl = scheduleMap[runScheduleId].trim() || null;
    } else if (hasScheduleEntries && !channelGate.webhookUrl) {
      mappedUrl = null;
      scheduleMismatchReason = true;
    } else {
      mappedUrl =
        typeof channelGate.webhookUrl === "string" && channelGate.webhookUrl.trim()
          ? channelGate.webhookUrl.trim()
          : null;
    }
  } else if (tenantChannelStore && typeof tenantChannelStore.getTenantWebhookUrl === "function") {
    mappingConsulted = true;
    if (runTenantId) {
      const scheduleMap =
        typeof tenantChannelStore.getTenantScheduleWebhookUrls === "function"
          ? await tenantChannelStore.getTenantScheduleWebhookUrls(runTenantId)
          : {};
      mappedUrl = await tenantChannelStore.getTenantWebhookUrl(runTenantId, runScheduleId);
      if (!mappedUrl && Object.keys(scheduleMap).length > 0) {
        scheduleMismatchReason = true;
      }
    }
  } else if (
    typeof envRecord["TENANT_WEBHOOK_URLS_JSON"] === "string" &&
    envRecord["TENANT_WEBHOOK_URLS_JSON"].trim()
  ) {
    try {
      const parsed = JSON.parse(envRecord["TENANT_WEBHOOK_URLS_JSON"]) as Record<
        string,
        string | null | TenantWebhookUrlConfigEntry
      >;
      if (parsed && typeof parsed === "object") {
        mappingConsulted = true;
        const entry = runTenantId ? parsed[runTenantId] : null;
        if (typeof entry === "string" && entry.trim()) {
          mappedUrl = entry.trim();
        } else if (entry && typeof entry === "object") {
          const scheduleMap = entry.schedules ?? {};
          const defaultUrl =
            (typeof entry.webhookUrl === "string" && entry.webhookUrl.trim()) ||
            (typeof entry.defaultUrl === "string" && entry.defaultUrl.trim()) ||
            null;
          if (typeof entry.runId === "string" && entry.runId.trim()) {
            mappedRunId = entry.runId.trim();
          }
          if (runScheduleId && scheduleMap[runScheduleId]) {
            mappedUrl = scheduleMap[runScheduleId].trim() || null;
          } else if (Object.keys(scheduleMap).length > 0 && !defaultUrl) {
            mappedUrl = null;
            scheduleMismatchReason = true;
          } else {
            mappedUrl = defaultUrl;
          }
        }
      }
    } catch {
      // Malformed JSON is ignored; falls through to verifyChannelRecipient.
    }
  }

  const refuseWebhook = (
    reason: ChannelRecipientRefusalReason,
    recipient: string | null,
    detail: string,
    bindingTenantIdOverride?: string,
  ) => {
    const auditPayload: ChannelRecipientAuditPayload = {
      channel: "webhook",
      recipient,
      tenantId: runTenantId,
      bindingTenantId: bindingTenantIdOverride ?? runTenantId ?? "unmapped-tenant",
      userLogin: run.userLogin?.trim() || null,
      runId: run.runId?.trim() || null,
      scheduleId: runScheduleId,
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
      allowed: false as const,
      code: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED" as const,
      reason,
      detail,
      error: codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", detail),
      auditPayload,
    };
  };

  let effectiveUrl = trimmedRequested ?? trimmedFallback;

  if (mappingConsulted) {
    if (!runTenantId) {
      return refuseWebhook(
        "run_tenant_missing",
        trimmedRequested ?? trimmedFallback ?? null,
        "run carries no verified tenant for bound webhook delivery",
      );
    }
    if (mappedRunId) {
      const actualRunId = run.runId?.trim() || "";
      if (!actualRunId || actualRunId !== mappedRunId) {
        return refuseWebhook(
          "recipient_run_mismatch",
          trimmedRequested ?? mappedUrl ?? null,
          `webhook URL bound to run "${mappedRunId}", attempted on run "${actualRunId || "none"}"`,
          runTenantId,
        );
      }
    }
    if (!mappedUrl) {
      if (scheduleMismatchReason) {
        return refuseWebhook(
          "recipient_schedule_mismatch",
          trimmedRequested ?? trimmedFallback ?? null,
          `tenant "${runTenantId}" has no webhook URL bound to schedule "${runScheduleId ?? "none"}"; webhook delivery refused`,
          runTenantId,
        );
      }
      return refuseWebhook(
        "webhook_tenant_url_unmapped",
        trimmedRequested ?? trimmedFallback ?? null,
        `tenant "${runTenantId}" has no bound webhook URL; webhook delivery refused`,
        runTenantId,
      );
    }
    if (trimmedRequested && normalizeWebhookUrl(trimmedRequested) !== normalizeWebhookUrl(mappedUrl)) {
      return refuseWebhook(
        "webhook_url_not_in_tenant_run",
        trimmedRequested,
        `webhook URL "${trimmedRequested}" does not match tenant "${runTenantId}"${runScheduleId ? ` schedule "${runScheduleId}"` : ""} bound URL "${mappedUrl}"`,
        runTenantId,
      );
    }
    effectiveUrl = mappedUrl;
  }

  const effectiveRun: ChannelRecipientRunScope = {
    ...run,
    tenantId: runTenantId ?? run.tenantId,
  };
  const explicitBinding = input.binding ?? resolveEnvChannelRecipientBinding(env, effectiveRun);
  if (
    !effectiveUrl &&
    explicitBinding?.webhookUrls &&
    explicitBinding.webhookUrls.length === 1 &&
    explicitBinding.webhookUrls[0]?.trim()
  ) {
    effectiveUrl = explicitBinding.webhookUrls[0].trim();
  }

  const check = verifyChannelRecipient({
    channel: "webhook",
    recipient: effectiveUrl,
    run: effectiveRun,
    binding: explicitBinding,
    layer,
    audit,
  });
  if (!check.allowed) {
    return check;
  }
  return { allowed: true, url: effectiveUrl };
}
