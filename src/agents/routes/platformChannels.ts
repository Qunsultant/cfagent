/**
 * Issue #3169 (program #2218) — tenant delivery-channel
 * administration routes, extracted-style sibling of
 * routes/platformTenants.ts — invoked from
 * OrchestratorAgent.routeRequest in the sequential
 * path.endsWith sequence (immediately after the account-admin
 * handler, before premium — there is no central route table).
 * Returns a Response on match, null when no channel-admin path
 * matches.
 *
 *   GET    /platform-channels/:id              channel config for a tenant (defaults when no row)
 *   PATCH  /platform-channels/:id/channels     update channel flags (partial, booleans only)
 *
 * (Paths are the DO-internal spellings: src/server.ts strips the
 * /api prefix when forwarding, so externally these are
 * /api/platform-channels*.)
 *
 * SCOPE — READ THIS BEFORE EXTENDING:
 * - Session-scoped ALWAYS: the operator login comes from the
 *   x-user-login header, which server.ts sets from the verified
 *   session (401 without a session). A tenant id in a path
 *   names the operator's ADMINISTRATION target, never the
 *   caller's scope: an operator administers ALL tenants (the
 *   #2457 owner ruling), and nothing here trusts a caller claim
 *   to BE that tenant.
 * - Gate: effective operators = env COMMERCIAL_STORE_OPERATORS
 *   UNION the store list (#2680, empty = deny all), the same
 *   idiom the commercial price routes and the tenant slice use.
 *   A missing login is 401, a non-operator is 403, an unbound
 *   store is 503.
 * - Known tenants only: the tenant id must appear in the tenant
 *   directory (account + settings rows, the #2221 authority);
 *   an unknown tenant is 404, never an invented config row.
 * - Enablement flags ONLY: PATCH accepts booleans for the five
 *   known channels and nothing else. A webhook URL, token, or
 *   secret in a patch is rejected (unknown-field 400 for an
 *   unknown channel id; the shape carries no secret field at
 *   all). Secrets stay in worker bindings.
 * - Defaults are all-enabled: GET for a tenant with no channel
 *   row returns the port defaults and creates nothing, so a
 *   tenant never configured behaves exactly as before.
 * - Audit funnel: operator writes are audit-annotated
 *   best-effort when the caller supplies a funnel (an audit
 *   failure never fails the write), the same posture as the
 *   tenant slice; the orchestrator dispatch supplies the funnel
 *   (routeRequest.ts passes `audit` into this handler), and the
 *   BizCopilot channel executor passes the turn audit through as
 *   the funnel (#5608) — so every channel mutation emits its
 *   `platform-channel-admin` record on both paths. The gate above
 *   is the control; the annotation is the audit trail, not a
 *   gate. Audit-before-write is implemented here (#5867, E5):
 *   the IAAA audit record is written BEFORE the D1 write over
 *   the wired store, and a failed audit write BLOCKS the
 *   mutation — the funnel annotation above is a turn-level
 *   mas_events record, NOT the IAAA chain, so it stays as the
 *   after-write annotation alongside the before-write chain
 *   record.
 */
import { createTenantChannelAdapter } from "../../data/createTenantChannelPorts";
import type { TenantChannelStore } from "../../data/tenantChannelPorts";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
  shouldBlockAction,
  type AuditStore,
} from "../../security/iaaaAudit";
import type { Env } from "../../types";
import {
  TENANT_CHANNEL_IDS,
  normalizeTenantSlackChannel,
  normalizeTenantWebhookUrl,
  type TenantChannelConfig,
  type TenantChannelId,
  type TenantChannelPatch,
} from "../../data/tenantChannelPorts";
import { createTenantDirectoryAdapter } from "../../data/createTenantDirectoryPorts";
import type { TenantDirectory } from "../../data/tenantDirectoryPorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";
import { resolveStoreOperatorAccess } from "../../security/storeOperatorGate";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { sessionStore } from "../../security/session";
import type { MembershipStore } from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import {
  channelPatchBodySchema,
  isTenantIdShaped,
  requestInvalidResponse,
  slackChannelBodySchema,
  validateRequestShape,
  webhookUrlBodySchema,
} from "../../api/requestValidation";
import { BusinessError, codedMessage, resolveOutcome } from "../../outcomes/outcomeAspects";
import {
  PLATFORM_ROUTE_TAILS,
  matchCatalogRoute,
  platformRouteById,
  segmentsAfterMarker,
} from "../../data/platformUrlCatalog";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #5606 (G-3) — module logger on the structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/platformChannels",
});


export interface PlatformChannelRouteContext {
  /** Worker env (carries the AGENT_DB + SESSION_STORE bindings). */
  env: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
  /** Test seam: use this IAAA audit store instead of createWiredAuditStore(env). */
  auditStore?: AuditStore | null;
  /** Test seam: use this store instead of the AGENT_DB adapter. */
  channels?: TenantChannelStore | null;
  /** Test seam: use this directory instead of the AGENT_DB adapter. */
  directory?: TenantDirectory | null;
  /** Test seam: use this operator list instead of the AGENT_DB adapter. */
  operators?: Pick<StoreOperators, "listOperators"> | null;
}

/**
 * Issue #5607 (G-5/G-6) — the coded refusal helper: every error
 * return in this module goes through here, so the refusal is
 * logged (warn, with code + status) and the body carries the
 * catalog code + message. Statuses are unchanged from the
 * pre-slice literals.
 */
function jsonError(
  code: string,
  status: number,
  fields: Record<string, unknown> = {},
): Response {
  structuredLog.warn("platformChannels.request_refused", {
    code,
    status,
    ...fields,
  });
  return Response.json({ code, error: codedMessage(code) }, { status });
}

/** #6180 — the store-operator gate, through the one helper. The
 * membership is the gate; the deprecated env/store login list is the
 * lossless fallback (logged). No founding bypass: channel
 * administration is steady-state. */
async function resolveOperator(
  request: Request,
  ctx: PlatformChannelRouteContext,
): Promise<string | Response> {
  const login = request.headers.get("x-user-login")?.trim() ?? "";
  if (!login) {
    return jsonError("FAILURE_COMMERCIAL_UNAUTHORIZED", 401, { login: null });
  }
  let kv: KvLike | undefined;
  let membershipStore: MembershipStore | undefined;
  try {
    kv = sessionStore(ctx.env);
    membershipStore = createKvMembershipStore(kv);
  } catch {
    kv = undefined;
    membershipStore = undefined;
  }
  const access = await resolveStoreOperatorAccess({
    login,
    tenantId: resolveIaaaTenant(ctx.env),
    nowMs: Date.now(),
    kv,
    membershipStore,
    env: ctx.env as unknown as Record<string, unknown>,
    operators: ctx.operators,
  });
  if (!access.allowed) {
    return jsonError("FAILURE_COMMERCIAL_OPERATOR_REQUIRED", 403, { login });
  }
  if (access.via === "legacy-list") {
    structuredLog.warn("platformChannels.store_operator_legacy_fallback", { login });
  }
  if (access.storeDegraded) {
    // #5607 (G-5): the degrade was silent; log it. A membership or
    // store-list failure degrades to the env-only list — never a
    // lockout, never a silent widening (the operator check above
    // still applies).
    structuredLog.warn("platformChannels.operator_list_degraded", {
      login: login || null,
    });
  }
  return login;
}

function auditBestEffort(
  ctx: PlatformChannelRouteContext,
  login: string,
  action: string,
  tenantId: string,
): void {
  try {
    ctx.audit?.("platform-channel-admin", "orchestrator", { actorLogin: login, action, tenantId });
  } catch {
    // #5607 (G-5): the swallow was silent; log it.
    // Best-effort annotation only; see the module header.
    structuredLog.warn("platformChannels.audit_annotation_failed", {
      action,
      tenantId,
      login,
    });
  }
}

/**
 * Issue #5867 — audit-before-write (E5, audit-canonical-store-5084):
 * the IAAA audit record for a channel mutation is written BEFORE the
 * D1 write, over the wired store (`createWiredAuditStore`). The
 * `ctx.audit` funnel is a turn-level mas_events annotation, NOT the
 * IAAA chain — it stays as the after-write annotation
 * (`auditBestEffort`); this is the chain record.
 *
 * Channel mutations are consequential, so a failed audit write BLOCKS
 * the mutation: returns the coded 503 refusal and the caller must not
 * write. The route has only the operator login, so actorPrincipalId is
 * the login — the same fallback `dataLifecycle` uses
 * (`actorInternalUserId ?? actorLogin`). Outcome is "pending": the
 * write has not run yet (first use of "pending" in src; it is in the
 * OUTCOMES enum); the funnel record after the write carries the
 * outcome. Returns null when the record landed and the write may
 * proceed.
 *
 * Residual (#5867, documented not solved): if the D1 write fails
 * after this record lands, an audit record exists for a change that
 * never landed — the chain has no rollback for this.
 */
async function auditBeforeWrite(
  ctx: PlatformChannelRouteContext,
  login: string,
  action: string,
  tenantId: string,
): Promise<Response | null> {
  const store = ctx.auditStore ?? createWiredAuditStore(ctx.env);
  const result = await recordAuditEvent(store, {
    timestamp: Date.now(),
    type: "platform-channel-admin",
    actorPrincipalId: login,
    actorType: "human",
    initiatingPrincipalId: login,
    tenantId,
    correlationId: crypto.randomUUID(),
    action,
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "pending",
  });
  if (shouldBlockAction("consequential", !result.ok)) {
    return jsonError("FAILURE_COMMERCIAL_AUDIT_REQUIRED", 503, {
      action,
      tenantId,
      login,
      auditCode: result.ok ? undefined : result.code,
    });
  }
  return null;
}

export async function handlePlatformChannelRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PlatformChannelRouteContext,
): Promise<Response | null> {
  void sessionId;
  if (!matchCatalogRoute(platformRouteById("channelRead"), path)) return null;
  const segments = segmentsAfterMarker(path, platformRouteById("channelRead"));
  let action: "read" | "patch" | "slack-channel" | "webhook-url" | null = null;
  let tenantId = "";
  if (segments.length === 1 && segments[0]) {
    tenantId = decodeURIComponent(segments[0]);
    action = "read";
  } else if (
    segments.length === 2 &&
    segments[0] &&
    segments[1] === PLATFORM_ROUTE_TAILS.channelPatch
  ) {
    tenantId = decodeURIComponent(segments[0]);
    action = "patch";
  } else if (
    segments.length === 2 &&
    segments[0] &&
    segments[1] === PLATFORM_ROUTE_TAILS.channelSlackChannel
  ) {
    tenantId = decodeURIComponent(segments[0]);
    action = "slack-channel";
  } else if (
    segments.length === 2 &&
    segments[0] &&
    segments[1] === PLATFORM_ROUTE_TAILS.channelWebhookUrl
  ) {
    tenantId = decodeURIComponent(segments[0]);
    action = "webhook-url";
  } else {
    return null;
  }

  // #5607 (G-5): entry event — after the route matched, before
  // the operator gate, so unauthenticated probes on real admin
  // paths are logged; the gate verdict is the refusal warn.
  const entryLogin = request.headers.get("x-user-login")?.trim() || null;
  structuredLog.info("platformChannels.request_started", {
    action,
    method: request.method,
    tenantId: tenantId || null,
    login: entryLogin,
  });

  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const channels = ctx.channels ?? createTenantChannelAdapter(ctx.env);
  const directory = ctx.directory ?? createTenantDirectoryAdapter(ctx.env);
  if (!channels || !directory) {
    return jsonError("FAILURE_COMMERCIAL_STORE_UNAVAILABLE", 503, {
      action,
      tenantId: tenantId || null,
      login: operator,
    });
  }

  try {
    if (!isTenantIdShaped(tenantId))
      return jsonError("FAILURE_COMMERCIAL_NOT_FOUND", 404, {
        action,
        tenantId,
        login: operator,
      });
    const known = await directory.listTenantIds();
    if (!known.includes(tenantId))
      return jsonError("FAILURE_COMMERCIAL_NOT_FOUND", 404, {
        action,
        tenantId,
        login: operator,
      });

    if (action === "read") {
      if (request.method !== "GET")
        return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
          action,
          tenantId,
          login: operator,
        });
      const config = await channels.getTenantChannels(tenantId);
      const slackChannel =
        typeof channels.getTenantSlackChannel === "function"
          ? await channels.getTenantSlackChannel(tenantId)
          : null;
      const webhookUrl =
        typeof channels.getTenantWebhookUrl === "function"
          ? await channels.getTenantWebhookUrl(tenantId)
          : null;
      const scheduleWebhookUrls =
        typeof channels.getTenantScheduleWebhookUrls === "function"
          ? await channels.getTenantScheduleWebhookUrls(tenantId)
          : {};
      structuredLog.info("platformChannels.channels_read", {
        action,
        tenantId,
        login: operator,
      });
      return Response.json({
        tenantId,
        channels: config,
        ...(slackChannel ? { slackChannel } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
        ...(Object.keys(scheduleWebhookUrls).length > 0 ? { scheduleWebhookUrls } : {}),
      });
    }

    if (action === "webhook-url") {
      const queryScheduleId = url.searchParams.get("scheduleId")?.trim() || null;
      if (request.method === "GET") {
        const webhookUrl =
          typeof channels.getTenantWebhookUrl === "function"
            ? await channels.getTenantWebhookUrl(tenantId, queryScheduleId)
            : null;
        const scheduleWebhookUrls =
          typeof channels.getTenantScheduleWebhookUrls === "function"
            ? await channels.getTenantScheduleWebhookUrls(tenantId)
            : {};
        structuredLog.info("platformChannels.webhook_url_read", {
          action,
          tenantId,
          login: operator,
        });
        return Response.json({
          tenantId,
          ...(queryScheduleId ? { scheduleId: queryScheduleId } : {}),
          webhookUrl,
          ...(Object.keys(scheduleWebhookUrls).length > 0 ? { scheduleWebhookUrls } : {}),
        });
      }
      if (request.method !== "PUT" && request.method !== "PATCH") {
        return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
          action,
          tenantId,
          login: operator,
        });
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // #5604: the write-body shape goes through the shared helper
      // (`webhookUrlBodySchema` — webhookUrl must be present). The
      // `in` presence check below threw on a scalar body (500);
      // the gate maps it to the existing coded 400 instead (#1768
      // precedent). The normalizer still owns every value rule,
      // with its messages unchanged; every 400 here is coded.
      const bodyShape = validateRequestShape(webhookUrlBodySchema, body);
      if (!bodyShape.ok) {
        return requestInvalidResponse("webhookUrl is required (non-empty HTTPS/HTTP URL string or null).");
      }
      const normalized = normalizeTenantWebhookUrl(body["webhookUrl"]);
      if (!normalized.ok) {
        return requestInvalidResponse(normalized.error);
      }
      const bodyScheduleId =
        typeof body["scheduleId"] === "string" && body["scheduleId"].trim()
          ? body["scheduleId"].trim()
          : queryScheduleId;
      if (typeof channels.setTenantWebhookUrl !== "function") {
        return jsonError("FAILURE_COMMERCIAL_SERVICE_UNAVAILABLE", 503, {
          action,
          tenantId,
          login: operator,
        });
      }
      // #5867: audit-before-write — a failed audit record blocks
      // the mutation; no D1 write runs.
      const webhookAudit = await auditBeforeWrite(ctx, operator, "update-webhook-url", tenantId);
      if (webhookAudit) return webhookAudit;
      const saved = await channels.setTenantWebhookUrl(
        tenantId,
        normalized.webhookUrl,
        bodyScheduleId,
      );
      auditBestEffort(ctx, operator, "update-webhook-url", tenantId);
      structuredLog.info("platformChannels.webhook_url_updated", {
        action,
        tenantId,
        login: operator,
      });
      return Response.json({
        tenantId,
        ...(bodyScheduleId ? { scheduleId: bodyScheduleId } : {}),
        webhookUrl: saved,
      });
    }

    if (action === "slack-channel") {
      if (request.method === "GET") {
        const slackChannel =
          typeof channels.getTenantSlackChannel === "function"
            ? await channels.getTenantSlackChannel(tenantId)
            : null;
        structuredLog.info("platformChannels.slack_channel_read", {
          action,
          tenantId,
          login: operator,
        });
        return Response.json({ tenantId, slackChannel });
      }
      if (request.method !== "PUT" && request.method !== "PATCH") {
        return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
          action,
          tenantId,
          login: operator,
        });
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // #5604: same boundary gate as the webhook-url write
      // (`slackChannelBodySchema` — slackChannel must be present).
      // The `in` presence check below threw on a scalar body (500);
      // the gate maps it to the existing coded 400 instead. The
      // normalizer still owns every value rule, unchanged.
      const bodyShape = validateRequestShape(slackChannelBodySchema, body);
      if (!bodyShape.ok) {
        return requestInvalidResponse("slackChannel is required (non-empty string or null).");
      }
      const normalized = normalizeTenantSlackChannel(body["slackChannel"]);
      if (!normalized.ok) {
        return requestInvalidResponse(normalized.error);
      }
      if (typeof channels.setTenantSlackChannel !== "function") {
        return jsonError("FAILURE_COMMERCIAL_SERVICE_UNAVAILABLE", 503, {
          action,
          tenantId,
          login: operator,
        });
      }
      // #5867: audit-before-write — a failed audit record blocks
      // the mutation; no D1 write runs.
      const slackAudit = await auditBeforeWrite(ctx, operator, "update-slack-channel", tenantId);
      if (slackAudit) return slackAudit;
      const saved = await channels.setTenantSlackChannel(tenantId, normalized.slackChannel);
      auditBestEffort(ctx, operator, "update-slack-channel", tenantId);
      structuredLog.info("platformChannels.slack_channel_updated", {
        action,
        tenantId,
        login: operator,
      });
      return Response.json({ tenantId, slackChannel: saved });
    }

    // action === "patch"
    if (request.method !== "PATCH")
      return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
        action,
        tenantId,
        login: operator,
      });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // #5604: the patch-body shape goes through the shared helper
    // (`channelPatchBodySchema` — channels is a map of channel
    // flags to booleans when present). The JSON-type checks below
    // move into the schema; the known-channel allowlist and the
    // "no flag supplied" rule stay here, with their messages
    // unchanged; every 400 is coded. A body that is not an object
    // fails the gate as "channels must be an object of channel
    // flags.", exactly as before.
    const bodyShape = validateRequestShape(channelPatchBodySchema, body);
    if (!bodyShape.ok) {
      const issue = bodyShape.issues[0]!;
      if (issue.field === "channels" && issue.path.length > 1) {
        return requestInvalidResponse(`Channel flag ${issue.path[1]} must be a boolean.`);
      }
      return requestInvalidResponse("channels must be an object of channel flags.");
    }
    const hasSlackChannelField = "slackChannel" in body;
    let normalizedSlackChannel: string | null | undefined = undefined;
    if (hasSlackChannelField) {
      const normalized = normalizeTenantSlackChannel(body["slackChannel"]);
      if (!normalized.ok) {
        return requestInvalidResponse(normalized.error);
      }
      normalizedSlackChannel = normalized.slackChannel;
    }
    const supplied = body["channels"];
    const patch: TenantChannelPatch = {};
    if (supplied !== undefined) {
      for (const [key, value] of Object.entries(supplied as Record<string, boolean>)) {
        if (!(TENANT_CHANNEL_IDS as readonly string[]).includes(key)) {
          return requestInvalidResponse(`Unknown channel: ${key}.`);
        }
        patch[key as TenantChannelId] = value;
      }
    } else if (!hasSlackChannelField) {
      return requestInvalidResponse("channels must be an object of channel flags.");
    }
    if (Object.keys(patch).length === 0 && !hasSlackChannelField) {
      return requestInvalidResponse("No channel flag supplied.");
    }
    // #5867: audit-before-write — one record per request, before the
    // first D1 write, even when the patch writes both stores. A failed
    // audit record blocks the mutation; no D1 write runs.
    const patchAudit = await auditBeforeWrite(ctx, operator, "update-channels", tenantId);
    if (patchAudit) return patchAudit;
    const config: TenantChannelConfig =
      Object.keys(patch).length > 0
        ? await channels.setTenantChannels(tenantId, patch)
        : await channels.getTenantChannels(tenantId);
    let savedSlackChannel: string | null | undefined = undefined;
    if (hasSlackChannelField && typeof channels.setTenantSlackChannel === "function") {
      savedSlackChannel = await channels.setTenantSlackChannel(
        tenantId,
        normalizedSlackChannel ?? null,
      );
    }
    auditBestEffort(ctx, operator, "update-channels", tenantId);
    structuredLog.info("platformChannels.channels_updated", {
      action,
      tenantId,
      login: operator,
    });
    return Response.json({
      tenantId,
      channels: config,
      ...(hasSlackChannelField ? { slackChannel: savedSlackChannel ?? null } : {}),
    });
  } catch (err) {
    // #5606 (G-3): typed failures render from the catalog; anything
    // else logs server-side and answers the generic code.
    if (err instanceof BusinessError) {
      const outcome = resolveOutcome(err.code);
      return Response.json(
        { code: err.code, error: codedMessage(err.code) },
        { status: outcome.entry?.httpStatus ?? 500 },
      );
    }
    structuredLog.error("platformChannels.channel_administration_failed", {
      message: `[channels] channel administration failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: "FAILURE_UNEXPECTED_ERROR", error: codedMessage("FAILURE_UNEXPECTED_ERROR") },
      { status: 500 },
    );
  }
}
