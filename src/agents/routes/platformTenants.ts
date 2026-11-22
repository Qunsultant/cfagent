/**
 * Issue #2221 (program #2218, slice 3) — tenant administration
 * routes, extracted-style sibling of routes/adminTenantQueues.ts —
 * invoked from OrchestratorAgent.routeRequest in the sequential
 * path.endsWith sequence (immediately after the agentic-payments
 * handler, the #2222 pattern — there is no central route table).
 * Returns a Response on match, null when no tenant-admin path
 * matches.
 *
 *   GET    /platform-tenants                  list tenants + settings + member counts
 *   POST   /platform-tenants                  create a tenant (settings row with store defaults)
 *   GET    /platform-tenants/:id              detail: settings + account-row members
 *   PATCH  /platform-tenants/:id/settings     update tenant settings (ads, auto-refresh, providers, turn step timeout, SLO thresholds)
 *
 * (Paths are the DO-internal spellings: src/server.ts strips the
 * /api prefix when forwarding, so externally these are
 * /api/platform-tenants*.)
 *
 * SCOPE — READ THIS BEFORE EXTENDING:
 * - Session-scoped ALWAYS: the operator login comes from the
 *   x-user-login header, which server.ts sets from the verified
 *   session (401 without a session). A tenant id in a path or
 *   body names the operator's ADMINISTRATION target, never the
 *   caller's scope: an operator administers ALL tenants (the
 *   #2457 owner ruling), and nothing here trusts a caller claim
 *   to BE that tenant. No self-service tenant creation for
 *   arbitrary users: every route below is operator-gated.
 * - Gate: effective operators = env COMMERCIAL_STORE_OPERATORS
 *   UNION the store list (#2680, empty = deny all), the same
 *   idiom the commercial price routes use. A missing login is
 *   401, a non-operator is 403, an unbound store is 503.
 * - Membership management is VIEW ONLY here: the client panel
 *   reads memberships from the existing IAAA read path (GET
 *   /api/iaaa/memberships, filtered by tenant) and this module
 *   never writes IAAA state (CISO lane owns IAAA writes). The
 *   `members` on the detail read are account-row members from
 *   the tenant directory port — the same account-row authority
 *   slice 1 (#2219, resolvePlatformIdentity) resolves the
 *   payment screen's tenant/user/account from — so the tenant
 *   identity the panel displays agrees with the payment screen's
 *   read-only identity by construction.
 * - Settings reuse the existing commercial store setters
 *   (setTenantAdsEnabled / setTenantAutoRefresh /
 *   setTenantProviders / setTenantTurnStepTimeoutMs): a create is
 *   a settings row written with store defaults (ads enabled,
 *   auto-refresh OFF / 15s, etrade / etrade — the adapters'
 *   absent-row defaults, never code constants in this module;
 *   the turn step timeout is UNCONFIGURED on a new tenant —
 *   null, never a default — migration 0078, #5423). No new
 *   table: the directory port reads only tables 0007 / 0026 /
 *   0028 create.
 * - Operator writes are audit-annotated best-effort after the
 *   write when the caller supplies an audit funnel (an audit
 *   failure never fails the write); the audit-before-write
 *   obligation channel is an IAAA property and does not apply
 *   to these commercial-settings writes. Issue #4605 wires the
 *   orchestrator audit funnel in routeRequest.ts and also appends
 *   a tenant-scoped tamper-evidence link to the Q7 chain
 *   (agent_audit_chain) best-effort via appendAuditChainBestEffort.
 * - The payment screen is untouched: it keeps showing
 *   tenant/user/account AUTOMATICALLY and READ-ONLY from
 *   resolvePlatformIdentity, with no tenant-id input, and
 *   "Run for free" stays first-class. Editing tenant/user/
 *   account lives on this platform surface, not the payment
 *   screen.
 */
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import { createD1BatchRunner } from "../../data/d1BatchRunner";
import { createTenantDirectoryAdapter } from "../../data/createTenantDirectoryPorts";
import type { TenantDirectory } from "../../data/tenantDirectoryPorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";
import { createEnsuredAuditPolicyAdapter } from "../../data/createAuditPolicyPorts";
import type { AuditPolicyPort } from "../../data/auditPolicyPorts";
import { appendAuditChainBestEffort } from "../../services/auditGate";
import { isLoginTenantId } from "../../services/platformIdentity";
import {
  isTenantIdShaped,
  requestInvalidResponse,
  tenantCreateBodySchema,
  tenantSettingsBodySchema,
  validateRequestShape,
} from "../../api/requestValidation";
import { BusinessError, codedMessage, resolveOutcome } from "../../outcomes/outcomeAspects";
import {
  PLATFORM_ROUTE_SUFFIXES,
  PLATFORM_ROUTE_TAILS,
  matchCatalogRoute,
  platformRouteById,
  segmentsAfterMarker,
} from "../../data/platformUrlCatalog";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { parseTurnStepTimeoutMs } from "../../config/turnStepTimeout";
import {
  parseSloP95LatencyMaxMs,
  parseSloUptimeTargetRatio,
} from "../../config/sloThresholds";

/** Issue #5606 (G-3) — module logger on the structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/platformTenants",
});


/** Re-exported for the BizCopilot parsers, which import the predicate from this module. The single definition lives in the shared helper (#5604). */
export { isTenantIdShaped };

export interface PlatformTenantRouteContext {
  /** Worker env (carries the AGENT_DB + COMMERCIAL_STORE_OPERATORS bindings). */
  env: { AGENT_DB?: unknown };
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
  /** Test seam: use this audit-policy port for Q7 chain appends instead of AGENT_DB. */
  auditPolicy?: AuditPolicyPort | null;
  /** Test seam: use this store instead of the AGENT_DB adapter. */
  commercial?: CommercialStore | null;
  /** Test seam: use this directory instead of the AGENT_DB adapter. */
  directory?: TenantDirectory | null;
  /** Test seam: use this operator list instead of the AGENT_DB adapter. */
  operators?: Pick<StoreOperators, "listOperators"> | null;
}

interface TenantSettingsView {
  tenantId: string;
  adsEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalS: number;
  dataProviderId: string;
  brokerId: string;
  /** Issue #5423 (#3515 S4): per-step timeout (ms); null = unconfigured. Mirrors the client view in tenantAdminApi.ts. */
  turnStepTimeoutMs: number | null;
  /** Issue #5425 (#3515 S5): uptime target ratio; null = unconfigured. Mirrors the client view in tenantAdminApi.ts. */
  sloUptimeTargetRatio: number | null;
  /** Issue #5425 (#3515 S5): P95 API latency max (ms); null = unconfigured. Mirrors the client view in tenantAdminApi.ts. */
  sloP95LatencyMaxMs: number | null;
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
  structuredLog.warn("platformTenants.request_refused", {
    code,
    status,
    ...fields,
  });
  return Response.json({ code, error: codedMessage(code) }, { status });
}

/**
 * Issue #4603 — decided design: tenant creation stays a settings-row write
 * (`"settings_row_only"`), with no separate tenant entity table or lifecycle
 * state. `TenantDirectory` derives distinct `tenantId`s across commercial
 * account rows UNION settings rows.
 */
export const TENANT_CREATION_MODE = "settings_row_only" as const;

function parseEnvOperators(env: { AGENT_DB?: unknown }): Set<string> {
  const raw = (env as unknown as Record<string, unknown>)["COMMERCIAL_STORE_OPERATORS"];
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Resolve the verified operator login, or an error Response. */
async function resolveOperator(
  request: Request,
  ctx: PlatformTenantRouteContext,
): Promise<string | Response> {
  const login = request.headers.get("x-user-login")?.trim() ?? "";
  if (!login) {
    return jsonError("FAILURE_COMMERCIAL_UNAUTHORIZED", 401, { login: null });
  }
  const effective = parseEnvOperators(ctx.env);
  const adapter = ctx.operators ?? createStoreOperatorsAdapter(ctx.env);
  if (adapter) {
    try {
      for (const entry of await adapter.listOperators()) effective.add(entry.login);
    } catch {
      // #5607 (G-5): the degrade was silent; log it.
      structuredLog.warn("platformTenants.operator_list_degraded", {
        login: login || null,
      });
      // Store-list failure degrades to env-only, exactly as the
      // commercial price routes behave — never a lockout, never
      // a silent widening (env-only is the narrower set here
      // only when the store list is unreadable, and the operator
      // check below still applies).
    }
  }
  if (!effective.has(login)) {
    return jsonError("FAILURE_COMMERCIAL_OPERATOR_REQUIRED", 403, { login });
  }
  return login;
}

function settingsView(
  tenantId: string,
  adsEnabled: boolean,
  autoRefresh: { enabled: boolean; intervalS: number },
  providers: { dataProviderId: string; brokerId: string },
  turnStepTimeoutMs: number | null,
  sloUptimeTargetRatio: number | null,
  sloP95LatencyMaxMs: number | null,
): TenantSettingsView {
  return {
    tenantId,
    adsEnabled,
    autoRefreshEnabled: autoRefresh.enabled,
    autoRefreshIntervalS: autoRefresh.intervalS,
    dataProviderId: providers.dataProviderId,
    brokerId: providers.brokerId,
    turnStepTimeoutMs,
    sloUptimeTargetRatio,
    sloP95LatencyMaxMs,
  };
}

async function readSettings(
  commercial: CommercialStore,
  tenantId: string,
): Promise<TenantSettingsView> {
  const adsEnabled = await commercial.getTenantAdsEnabled(tenantId);
  const autoRefresh = await commercial.getTenantAutoRefresh(tenantId);
  const providers = await commercial.getTenantProviders(tenantId);
  const turnStepTimeoutMs = await commercial.getTenantTurnStepTimeoutMs(tenantId);
  const sloUptimeTargetRatio = await commercial.getTenantSloUptimeTargetRatio(tenantId);
  const sloP95LatencyMaxMs = await commercial.getTenantSloP95LatencyMaxMs(tenantId);
  return settingsView(
    tenantId,
    adsEnabled,
    autoRefresh,
    providers,
    turnStepTimeoutMs,
    sloUptimeTargetRatio,
    sloP95LatencyMaxMs,
  );
}

function auditBestEffort(
  ctx: PlatformTenantRouteContext,
  login: string,
  action: string,
  tenantId: string,
): void {
  const payload = { actorLogin: login, action, tenantId };
  try {
    ctx.audit?.("platform-tenant-admin", "orchestrator", payload);
  } catch {
    // #5607 (G-5): the swallow was silent; log it.
    // Best-effort annotation only; see the module header.
    structuredLog.warn("platformTenants.audit_annotation_failed", {
      action,
      tenantId,
      login,
    });
  }
  void appendAuditChainBestEffort(
    () =>
      ctx.auditPolicy !== undefined
        ? Promise.resolve(ctx.auditPolicy)
        : createEnsuredAuditPolicyAdapter(ctx.env),
    {
      tenantId,
      action: `platform.tenant_admin.${action}`,
      payload,
    },
    ctx.audit,
  );
}

export async function handlePlatformTenantRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PlatformTenantRouteContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  type Action = "list" | "create" | "detail" | "settings" | null;
  let action: Action = null;
  let tenantId = "";
  if (path.endsWith(PLATFORM_ROUTE_SUFFIXES.tenants)) {
    // A method mismatch on a matched collection path is still a
    // match: it falls into the list branch, which answers 405,
    // instead of falling through to the next handler.
    action = request.method === "POST" ? "create" : "list";
  } else if (matchCatalogRoute(platformRouteById("tenantDetail"), path)) {
    const segments = segmentsAfterMarker(path, platformRouteById("tenantDetail"));
    if (segments.length === 1 && segments[0]) {
      tenantId = decodeURIComponent(segments[0]);
      action = "detail";
    } else if (
      segments.length === 2 &&
      segments[0] &&
      segments[1] === PLATFORM_ROUTE_TAILS.tenantSettings
    ) {
      tenantId = decodeURIComponent(segments[0]);
      action = "settings";
    } else {
      return null;
    }
  } else {
    return null;
  }

  // #5607 (G-5): entry event — after the route matched, before
  // the operator gate, so unauthenticated probes on real admin
  // paths are logged; the gate verdict is the refusal warn.
  const entryLogin = request.headers.get("x-user-login")?.trim() || null;
  structuredLog.info("platformTenants.request_started", {
    action,
    method: request.method,
    tenantId: tenantId || null,
    login: entryLogin,
  });

  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const commercial = ctx.commercial ?? createCommercialAdapter(ctx.env);
  const directory = ctx.directory ?? createTenantDirectoryAdapter(ctx.env);
  if (!commercial || !directory) {
    return jsonError("FAILURE_COMMERCIAL_STORE_UNAVAILABLE", 503, {
      action,
      tenantId: tenantId || null,
      login: operator,
    });
  }

  try {
    if (action === "list") {
      if (request.method !== "GET")
        return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
          action,
          tenantId: tenantId || null,
          login: operator,
        });
      const ids = await directory.listTenantIds();
      const tenants = [];
      for (const id of ids) {
        const settings = await readSettings(commercial, id);
        const members = await directory.listTenantMembers(id);
        tenants.push({ ...settings, memberCount: members.length });
      }
      structuredLog.info("platformTenants.tenants_listed", {
        action,
        login: operator,
        tenantCount: tenants.length,
      });
      return Response.json({ tenants });
    }

    if (action === "create") {
      if (request.method !== "POST")
        return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
          action,
          tenantId: tenantId || null,
          login: operator,
        });
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // #5604: the create-body shape goes through the shared helper
      // (`tenantCreateBodySchema` — presence + string type of
      // tenantId only). The id shape rule, the `login:` reservation,
      // and the existence check stay below, with their messages
      // unchanged; the 400 is coded.
      const bodyShape = validateRequestShape(tenantCreateBodySchema, body);
      if (!bodyShape.ok) {
        return requestInvalidResponse("tenantId is required and must be a non-empty id without whitespace.");
      }
      const newTenantId = body["tenantId"];
      if (!isTenantIdShaped(newTenantId)) {
        return requestInvalidResponse("tenantId is required and must be a non-empty id without whitespace.");
      }
      if (isLoginTenantId(newTenantId.trim())) {
        return requestInvalidResponse("tenantId cannot use the reserved 'login:' personal-scope prefix.");
      }
      const existing = await directory.listTenantIds();
      if (existing.includes(newTenantId.trim())) {
        // Idempotent create (the re-grant / re-record idiom):
        // re-creating an existing tenant returns its current
        // settings instead of failing, so a retried create
        // cannot duplicate anything.
        structuredLog.info("platformTenants.tenant_created", {
          action,
          tenantId: newTenantId.trim(),
          login: operator,
          created: false,
        });
        return Response.json({
          tenant: await readSettings(commercial, newTenantId.trim()),
          creationMode: TENANT_CREATION_MODE,
        });
      }
      // A create is a settings row with store defaults; the
      // directory lists it from that row on the next read.
      const settings = await commercial.setTenantAdsEnabled(newTenantId.trim(), true);
      auditBestEffort(ctx, operator, "create", newTenantId.trim());
      structuredLog.info("platformTenants.tenant_created", {
        action,
        tenantId: newTenantId.trim(),
        login: operator,
        created: true,
      });
      return Response.json(
        {
          tenant: settingsView(
            settings.tenantId,
            settings.adsEnabled,
            { enabled: settings.autoRefreshEnabled, intervalS: settings.autoRefreshIntervalS },
            { dataProviderId: settings.dataProviderId, brokerId: settings.brokerId },
            settings.turnStepTimeoutMs,
            settings.sloUptimeTargetRatio,
            settings.sloP95LatencyMaxMs,
          ),
          creationMode: TENANT_CREATION_MODE,
        },
        { status: 201 },
      );
    }

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

    if (action === "detail") {
      if (request.method !== "GET")
        return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
          action,
          tenantId,
          login: operator,
        });
      const settings = await readSettings(commercial, tenantId);
      const memberUserIds = await directory.listTenantMembers(tenantId);
      const members = [];
      for (const userId of memberUserIds) {
        // Account-row authority, as in slice 1: a member here
        // comes from an account row, so hasAccount is true; the
        // shape still carries it so a future directory source
        // cannot silently upgrade a non-account user.
        const account = await commercial.getAccount(userId);
        members.push({
          userId,
          hasAccount: account !== null,
          tenantId: account ? account.tenantId : null,
          tier: account ? account.tier : "Free",
          creditsUSD: account ? account.creditsUSD : 0,
          includedRuns: account ? account.includedRuns : 0,
        });
      }
      structuredLog.info("platformTenants.tenant_detail_read", {
        action,
        tenantId,
        login: operator,
      });
      return Response.json({ tenant: { ...settings, members } });
    }

    if (action === "settings") {
      if (request.method !== "PATCH")
        return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
          action,
          tenantId,
          login: operator,
        });
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // #5604: the settings-body shape goes through the shared
      // helper (`tenantSettingsBodySchema` — JSON types only). The
      // JSON-type checks below move into the schema; the value
      // bounds stay here (positive-integer intervalS, non-empty
      // provider ids) with their messages unchanged; every 400 is
      // coded. A body that is not an object fails the gate as
      // "No settings field supplied.", exactly as before.
      const bodyShape = validateRequestShape(tenantSettingsBodySchema, body);
      if (!bodyShape.ok) {
        const field = bodyShape.issues[0]!.field;
        if (field === "adsEnabled") {
          return requestInvalidResponse("adsEnabled must be a boolean.");
        }
        if (field === "autoRefresh") {
          return requestInvalidResponse("autoRefresh must be { enabled: boolean, intervalS: positive integer }.");
        }
        if (field === "providers") {
          return requestInvalidResponse("providers must be { dataProviderId: string, brokerId: string }.");
        }
        if (field === "turnStepTimeoutMs") {
          return requestInvalidResponse("turnStepTimeoutMs must be a number.");
        }
        if (field === "sloUptimeTargetRatio") {
          return requestInvalidResponse("sloUptimeTargetRatio must be a number.");
        }
        if (field === "sloP95LatencyMaxMs") {
          return requestInvalidResponse("sloP95LatencyMaxMs must be a number.");
        }
        return requestInvalidResponse("No settings field supplied.");
      }
      // Issue #5605 (G-2): the PATCH's up-to-six settings
      // writes run as ONE D1 batch unit when AGENT_DB is bound —
      // the setters buffer their upserts into the ambient unit
      // the runner opens. Without a binding (a test-seam store)
      // they apply sequentially, exactly as before. A validation
      // failure after an earlier setter buffered still commits
      // that setter's write: the same outcome as the sequential
      // path, which had already applied it before the failure.
      // The final readSettings below re-reads after the unit
      // commits, so the response carries the applied values.
      let applied = false;
      const applySettings = async (): Promise<Response | null> => {
        if (body["adsEnabled"] !== undefined) {
          await commercial.setTenantAdsEnabled(tenantId, body["adsEnabled"] as boolean);
          applied = true;
        }
        if (body["autoRefresh"] !== undefined) {
          const refresh = body["autoRefresh"] as { enabled: boolean; intervalS: number };
          if (!Number.isInteger(refresh["intervalS"]) || refresh["intervalS"] <= 0) {
            return requestInvalidResponse("autoRefresh must be { enabled: boolean, intervalS: positive integer }.");
          }
          await commercial.setTenantAutoRefresh(tenantId, {
            enabled: refresh["enabled"],
            intervalS: refresh["intervalS"],
          });
          applied = true;
        }
        if (body["providers"] !== undefined) {
          const providers = body["providers"] as { dataProviderId: string; brokerId: string };
          if (!providers["dataProviderId"] || !providers["brokerId"]) {
            return requestInvalidResponse("providers must be { dataProviderId: string, brokerId: string }.");
          }
          await commercial.setTenantProviders(tenantId, {
            dataProviderId: providers["dataProviderId"],
            brokerId: providers["brokerId"],
          });
          applied = true;
        }
        if (body["turnStepTimeoutMs"] !== undefined) {
          // #5423 (#3515 S4): the bounds live in the config
          // module (parseTurnStepTimeoutMs) — a value outside
          // 1000–600000 ms is a 400 with the bound in the message.
          let timeoutMs: number;
          try {
            timeoutMs = parseTurnStepTimeoutMs(body["turnStepTimeoutMs"]);
          } catch (err) {
            return requestInvalidResponse(err instanceof Error ? err.message : "turnStepTimeoutMs is invalid.");
          }
          await commercial.setTenantTurnStepTimeoutMs(tenantId, timeoutMs);
          applied = true;
        }
        if (body["sloUptimeTargetRatio"] !== undefined) {
          // #5425 (#3515 S5): the bounds live in the config
          // module (parseSloUptimeTargetRatio) — a value outside
          // (0, 1] is a 400 with the bound in the message.
          let targetRatio: number;
          try {
            targetRatio = parseSloUptimeTargetRatio(body["sloUptimeTargetRatio"]);
          } catch (err) {
            return requestInvalidResponse(err instanceof Error ? err.message : "sloUptimeTargetRatio is invalid.");
          }
          await commercial.setTenantSloUptimeTargetRatio(tenantId, targetRatio);
          applied = true;
        }
        if (body["sloP95LatencyMaxMs"] !== undefined) {
          // #5425 (#3515 S5): the bounds live in the config
          // module (parseSloP95LatencyMaxMs) — a value outside
          // 1–600000 ms is a 400 with the bound in the message.
          let maxMs: number;
          try {
            maxMs = parseSloP95LatencyMaxMs(body["sloP95LatencyMaxMs"]);
          } catch (err) {
            return requestInvalidResponse(err instanceof Error ? err.message : "sloP95LatencyMaxMs is invalid.");
          }
          await commercial.setTenantSloP95LatencyMaxMs(tenantId, maxMs);
          applied = true;
        }
        if (!applied) return requestInvalidResponse("No settings field supplied.");
        return null;
      };
      const batch = ctx.env.AGENT_DB
        ? createD1BatchRunner(ctx.env.AGENT_DB as D1Database)
        : null;
      const early = batch
        ? await batch.runInBatch(
            { operationName: "tenant.settings.patch", domain: "tenants" },
            applySettings,
          )
        : await applySettings();
      if (early) return early;
      auditBestEffort(ctx, operator, "update-settings", tenantId);
      structuredLog.info("platformTenants.tenant_settings_updated", {
        action,
        tenantId,
        login: operator,
      });
      return Response.json({ tenant: await readSettings(commercial, tenantId) });
    }

    return jsonError("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405, {
      action,
      tenantId: tenantId || null,
      login: operator,
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
    structuredLog.error("platformTenants.tenant_administration_failed", {
      message: `[tenants] tenant administration failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: "FAILURE_UNEXPECTED_ERROR", error: codedMessage("FAILURE_UNEXPECTED_ERROR") },
      { status: 500 },
    );
  }
}
