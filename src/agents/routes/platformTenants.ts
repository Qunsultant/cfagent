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
 *   PATCH  /platform-tenants/:id/settings     update tenant settings (ads, auto-refresh, providers)
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
 *   setTenantProviders): a create is a settings row written with
 *   store defaults (ads enabled, auto-refresh OFF / 15s,
 *   etrade / etrade — the adapters' absent-row defaults, never
 *   code constants in this module). No new migration: the
 *   directory port reads only tables 0007 / 0026 / 0028 create.
 * - Operator writes are audit-annotated best-effort after the
 *   write when the caller supplies an audit funnel (an audit
 *   failure never fails the write); the audit-before-write
 *   obligation channel is an IAAA property and does not apply
 *   to these commercial-settings writes. The orchestrator
 *   dispatch keeps its block minimal and supplies no funnel
 *   today, so this annotation is a follow-up, not a control —
 *   the gate above is the control.
 * - The payment screen is untouched: it keeps showing
 *   tenant/user/account AUTOMATICALLY and READ-ONLY from
 *   resolvePlatformIdentity, with no tenant-id input, and
 *   "Run for free" stays first-class. Editing tenant/user/
 *   account lives on this platform surface, not the payment
 *   screen.
 */
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import { createTenantDirectoryAdapter } from "../../data/createTenantDirectoryPorts";
import type { TenantDirectory } from "../../data/tenantDirectoryPorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";

export interface PlatformTenantRouteContext {
  /** Worker env (carries the AGENT_DB + COMMERCIAL_STORE_OPERATORS bindings). */
  env: { AGENT_DB?: unknown };
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
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
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** Same shape rule as isTenantIdShaped (tenantQueueMapping): non-empty, <=512, no whitespace/control. */
function isTenantIdShaped(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512 &&
    !/[\s\x00-\x1F\x7F]/.test(value.trim())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const effective = parseEnvOperators(ctx.env);
  const adapter = ctx.operators ?? createStoreOperatorsAdapter(ctx.env);
  if (adapter) {
    try {
      for (const entry of await adapter.listOperators()) effective.add(entry.login);
    } catch {
      // Store-list failure degrades to env-only, exactly as the
      // commercial price routes behave — never a lockout, never
      // a silent widening (env-only is the narrower set here
      // only when the store list is unreadable, and the operator
      // check below still applies).
    }
  }
  if (!effective.has(login)) {
    return jsonError("Forbidden: tenant administration requires a store operator.", 403);
  }
  return login;
}

function settingsView(
  tenantId: string,
  adsEnabled: boolean,
  autoRefresh: { enabled: boolean; intervalS: number },
  providers: { dataProviderId: string; brokerId: string },
): TenantSettingsView {
  return {
    tenantId,
    adsEnabled,
    autoRefreshEnabled: autoRefresh.enabled,
    autoRefreshIntervalS: autoRefresh.intervalS,
    dataProviderId: providers.dataProviderId,
    brokerId: providers.brokerId,
  };
}

async function readSettings(
  commercial: CommercialStore,
  tenantId: string,
): Promise<TenantSettingsView> {
  const adsEnabled = await commercial.getTenantAdsEnabled(tenantId);
  const autoRefresh = await commercial.getTenantAutoRefresh(tenantId);
  const providers = await commercial.getTenantProviders(tenantId);
  return settingsView(tenantId, adsEnabled, autoRefresh, providers);
}

function auditBestEffort(
  ctx: PlatformTenantRouteContext,
  login: string,
  action: string,
  tenantId: string,
): void {
  try {
    ctx.audit?.("platform-tenant-admin", "orchestrator", { actorLogin: login, action, tenantId });
  } catch {
    // Best-effort annotation only; see the module header.
  }
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
  if (path.endsWith("/platform-tenants")) {
    // A method mismatch on a matched collection path is still a
    // match: it falls into the list branch, which answers 405,
    // instead of falling through to the next handler.
    action = request.method === "POST" ? "create" : "list";
  } else if (path.includes("/platform-tenants/")) {
    const rest = path.split("/platform-tenants/")[1] ?? "";
    const segments = rest.split("/");
    if (segments.length === 1 && segments[0]) {
      tenantId = decodeURIComponent(segments[0]);
      action = "detail";
    } else if (segments.length === 2 && segments[0] && segments[1] === "settings") {
      tenantId = decodeURIComponent(segments[0]);
      action = "settings";
    } else {
      return null;
    }
  } else {
    return null;
  }

  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const commercial = ctx.commercial ?? createCommercialAdapter(ctx.env);
  const directory = ctx.directory ?? createTenantDirectoryAdapter(ctx.env);
  if (!commercial || !directory) {
    return jsonError("Tenant administration unavailable: AGENT_DB is not bound.", 503);
  }

  try {
    if (action === "list") {
      if (request.method !== "GET") return jsonError("Method not allowed", 405);
      const ids = await directory.listTenantIds();
      const tenants = [];
      for (const id of ids) {
        const settings = await readSettings(commercial, id);
        const members = await directory.listTenantMembers(id);
        tenants.push({ ...settings, memberCount: members.length });
      }
      return Response.json({ tenants });
    }

    if (action === "create") {
      if (request.method !== "POST") return jsonError("Method not allowed", 405);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const newTenantId = body["tenantId"];
      if (!isTenantIdShaped(newTenantId)) {
        return jsonError("tenantId is required and must be a non-empty id without whitespace.", 400);
      }
      const existing = await directory.listTenantIds();
      if (existing.includes(newTenantId.trim())) {
        // Idempotent create (the re-grant / re-record idiom):
        // re-creating an existing tenant returns its current
        // settings instead of failing, so a retried create
        // cannot duplicate anything.
        return Response.json({ tenant: await readSettings(commercial, newTenantId.trim()) });
      }
      // A create is a settings row with store defaults; the
      // directory lists it from that row on the next read.
      const settings = await commercial.setTenantAdsEnabled(newTenantId.trim(), true);
      auditBestEffort(ctx, operator, "create", newTenantId.trim());
      return Response.json(
        {
          tenant: settingsView(
            settings.tenantId,
            settings.adsEnabled,
            { enabled: settings.autoRefreshEnabled, intervalS: settings.autoRefreshIntervalS },
            { dataProviderId: settings.dataProviderId, brokerId: settings.brokerId },
          ),
        },
        { status: 201 },
      );
    }

    if (!isTenantIdShaped(tenantId)) return jsonError("Unknown tenant.", 404);
    const known = await directory.listTenantIds();
    if (!known.includes(tenantId)) return jsonError("Unknown tenant.", 404);

    if (action === "detail") {
      if (request.method !== "GET") return jsonError("Method not allowed", 405);
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
      return Response.json({ tenant: { ...settings, members } });
    }

    if (action === "settings") {
      if (request.method !== "PATCH") return jsonError("Method not allowed", 405);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      let applied = false;
      if (body["adsEnabled"] !== undefined) {
        if (typeof body["adsEnabled"] !== "boolean") {
          return jsonError("adsEnabled must be a boolean.", 400);
        }
        await commercial.setTenantAdsEnabled(tenantId, body["adsEnabled"]);
        applied = true;
      }
      if (body["autoRefresh"] !== undefined) {
        const refresh = body["autoRefresh"];
        if (
          !isRecord(refresh) ||
          typeof refresh["enabled"] !== "boolean" ||
          typeof refresh["intervalS"] !== "number" ||
          !Number.isInteger(refresh["intervalS"]) ||
          refresh["intervalS"] <= 0
        ) {
          return jsonError("autoRefresh must be { enabled: boolean, intervalS: positive integer }.", 400);
        }
        await commercial.setTenantAutoRefresh(tenantId, {
          enabled: refresh["enabled"],
          intervalS: refresh["intervalS"],
        });
        applied = true;
      }
      if (body["providers"] !== undefined) {
        const providers = body["providers"];
        if (
          !isRecord(providers) ||
          typeof providers["dataProviderId"] !== "string" ||
          !providers["dataProviderId"] ||
          typeof providers["brokerId"] !== "string" ||
          !providers["brokerId"]
        ) {
          return jsonError("providers must be { dataProviderId: string, brokerId: string }.", 400);
        }
        await commercial.setTenantProviders(tenantId, {
          dataProviderId: providers["dataProviderId"],
          brokerId: providers["brokerId"],
        });
        applied = true;
      }
      if (!applied) return jsonError("No settings field supplied.", 400);
      auditBestEffort(ctx, operator, "update-settings", tenantId);
      return Response.json({ tenant: await readSettings(commercial, tenantId) });
    }

    return jsonError("Method not allowed", 405);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Tenant administration failed.", 500);
  }
}
