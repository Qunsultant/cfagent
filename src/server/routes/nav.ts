/**
 * #6151 S1+S2+S3 — the nav-availability endpoint (GET /api/platform/nav-availability)
 * and the saved-preset routes (GET/POST /api/platform/nav-presets and friends).
 *
 * The first production consumer of the one shared context resolution
 * (resolvePlatformContext, PR #6220): the endpoint resolves the
 * caller's platform context once per session and returns the
 * effective nav availability, computed server-side. The client never
 * learns "is admin" from the context — admin-ness is a server-side
 * computation, not a client-side flag (#1078 has no roles field).
 *
 * Permission gap (named, not invented): /api/me authorizes with
 * requireAuth only — there is NO session/profile-read permission in
 * PERMISSIONS, and no single PDP permission covers all personas
 * (platform-admin holds only role:assign/audit:read/audit:export at
 * platform scope; member holds task:create/read/cancel, artifact:*,
 * action:propose, integration:connect). This endpoint resolves with
 * `task:read` (precedent: resolveScreenExecutionContext defaults to
 * `task:create`): it covers member, tenant-admin, workspace-admin
 * and auditor at tenant scope. A platform-admin holding ONLY a
 * platform-scope binding is PDP-denied by design (a platform
 * binding never grants tenant permissions) → 403 → the client falls
 * back to its localStorage selection (today's behavior; the app
 * keeps working). The dedicated session-read permission is a
 * CISO-owned naming decision (#5350), not something this slice
 * invents.
 *
 * Computation order: the caller's stored selection (S3 — the active
 * saved preset, else the custom map, else the persona default
 * expanded from the shared preset maps), then subscription
 * entitlements (S2): a nav id named in the product→menu mapping
 * stays visible only while the caller holds an active subscription
 * for a product that enables it. Tenant allowance (S4) and
 * per-user allow-lists (S4) narrow on top of this, for non-admin
 * personas only: the allowance intersects the map when a row
 * exists for the caller's tenant ("no allowance" means the tenant
 * gets everything the platform enables), and the allow-list
 * intersects it when a row exists for the caller ("no allow-list
 * means no narrowing"). A per-user allow-list with
 * savedPresetsAllowed false also hides the caller's saved presets
 * (built-ins only) and ignores the active preset. The persona
 * default itself is the S4 override when one exists for the
 * persona, else the shipped config — so an edit takes effect on
 * the user's next load. Admin personas bypass the subscription
 * narrowing AND the S4 narrowing — they see the entire menu
 * (issue part 2).
 *
 * The tier fact is never re-derived here: it flows through from
 * the resolved context unchanged. The per-PRODUCT fact (which
 * products the caller holds) comes from reading the caller's
 * subscription rows — a store read, not a resolver call (the
 * census pin counts resolveEffectiveTier calls, and this file
 * makes none). The active-row rule is the SAME rule
 * resolveEffectiveTier uses (periodEndMs > nowMs): cancel keeps
 * access to periodEnd (periodEndMs untouched by cancel), refund
 * revokes by moving periodEndMs to nowMs (revokeSubscription),
 * so the two can never disagree about whether a subscription is
 * live. Availability is a UX narrowing, never an authorization
 * gate (the PDP decision is the boundary) — so a transient
 * subscription-store read failure serves the base map ungated
 * instead of breaking the nav.
 *
 * S3 — saved presets: the preset store is a UX store, not an auth
 * store. A missing/unreadable preset store degrades the nav read
 * to the persona default (the selection is a narrowing, never a
 * gate) and the preset list to empty; preset MUTATIONS fail closed
 * with a 503 instead (an operation that cannot persist must not
 * pretend it did). Filtering is always at READ time: the stored
 * map is gated on every call, so a later unsubscribe hides the tab
 * without any re-apply.
 */
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import { createNavPresetAdapter } from "../../data/createNavPresetPorts";
import { createNavAdminConfigAdapter } from "../../data/createNavAdminConfigPorts";
import { listSessionFamilyEntries } from "../../security/session";
import { listMembershipsFromEntries } from "../../security/iaaaMembershipStore";
import type { CommercialStore } from "../../data/commercialPorts";
import type { SubscriptionStore } from "../../data/subscriptionPorts";
import type { NavPresetStore } from "../../data/navPresetPorts";
import type { NavAdminConfigStore } from "../../data/navAdminConfigPorts";
import {
  assertNavAdminId,
  assertPersonaPresetKey,
  isNavPersona,
  NAV_PERSONAS,
} from "../../data/navAdminConfigPorts";
import {
  isPresetMapInput,
  normalizePresetMap,
} from "../../data/navPresetPorts";
import { BusinessError } from "../../outcomes/outcomeAspects";
import type { StoreTier } from "../../data/commercialPorts";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { authenticateRequest } from "../auth";
import { resolvePlatformContext } from "../../security/platformContext";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { sessionStore } from "../../security/session";
import { holdsPlatformAdmin } from "../../security/iaaaGithubEndToEnd";
import type { MembershipStore } from "../../security/authorization";
import {
  builtinPresetKeys,
  personaDefaultPresetKey,
  productMenuMapping,
  type ProductMenuMappingEntry,
  type NavPersona,
} from "../../client/navConfig";
import { expandPresetKey } from "../../client/navPresets";
import { mergeVisibleTabs } from "../../client/platformContextNav";
import type { Env } from "../../types";

export interface NavAvailabilityResponse {
  ok: true;
  visibleTabs: Record<string, boolean>;
  /** Built-in preset keys + the caller's saved-preset ids (S3). */
  availablePresets: string[];
  personaDefault: string;
  persona: NavPersona;
  tier: StoreTier;
}

/** Stores injected by tests; production builds them from env. */
export interface NavRouteDeps {
  commercial?: CommercialStore | null;
  subscriptions?: SubscriptionStore | null;
  /** Test seam: production reads the preset store from env (null when unbound). */
  presets?: NavPresetStore | null;
  /** Test seam: production reads the admin-config store from env (null when unbound). */
  adminConfig?: NavAdminConfigStore | null;
  /** Test seam: production reads the shipped config mapping. */
  productMenuMapping?: ProductMenuMappingEntry[];
}

const NAV_AVAILABILITY_PATH = "/api/platform/nav-availability";
const NAV_PRESETS_PATH = "/api/platform/nav-presets";
const NAV_PRESETS_SELECTION_PATH = "/api/platform/nav-presets/selection";
const NAV_ADMIN_CONFIG_PATH = "/api/platform/nav-admin/config";
const NAV_ADMIN_TENANT_ALLOWANCE_PATH = "/api/platform/nav-admin/tenant-allowance";
const NAV_ADMIN_USER_ALLOWLIST_PATH = "/api/platform/nav-admin/user-allowlist";
const NAV_ADMIN_PERSONA_DEFAULT_PATH = "/api/platform/nav-admin/persona-default";

/**
 * #6151 S2 — the active (unexpired) subscription product ids for
 * a caller, by the SAME rule resolveEffectiveTier uses:
 * periodEndMs > nowMs. Status is deliberately ignored — cancel
 * keeps access to periodEnd (periodEndMs untouched by cancel);
 * refund revokes by moving periodEndMs to nowMs
 * (revokeSubscription), so a revoked row never counts. Rows whose
 * plan is unknown contribute nothing (no product can be named for
 * them). This reads rows; it never calls resolveEffectiveTier — the
 * tier fact still comes from the resolved context.
 */
export function activeSubscriptionProductIds(
  subscriptions: Array<{ planId: string; periodEndMs: number }>,
  plansById: Map<string, { productId: string }>,
  nowMs: number,
): Set<string> {
  const active = new Set<string>();
  for (const row of subscriptions) {
    if (row.periodEndMs <= nowMs) continue;
    const productId = plansById.get(row.planId)?.productId;
    if (typeof productId === "string" && productId.length > 0) {
      active.add(productId);
    }
  }
  return active;
}

/**
 * #6151 S2 — apply the product→menu mapping to a base
 * availability map. A mapped nav id stays visible only when the
 * caller holds an active subscription for at least one product
 * that enables it (OR across products); unmapped ids pass through
 * unchanged, and a product with no mapping entry enables nothing.
 * The result covers exactly the base keys — a mapping id outside
 * the base map is ignored, never invented.
 */
export function applyProductMenuGating(
  base: Record<string, boolean>,
  mapping: ProductMenuMappingEntry[],
  activeProductIds: Set<string>,
): Record<string, boolean> {
  const gateByNavId = new Map<string, Set<string>>();
  for (const entry of mapping) {
    for (const navId of entry.navIds) {
      const gate = gateByNavId.get(navId) ?? new Set<string>();
      gate.add(entry.productId);
      gateByNavId.set(navId, gate);
    }
  }
  const out: Record<string, boolean> = {};
  for (const [id, visible] of Object.entries(base)) {
    const gate = gateByNavId.get(id);
    out[id] =
      gate === undefined
        ? visible
        : visible === true && [...gate].some((p) => activeProductIds.has(p));
  }
  return out;
}

/**
 * Classify the caller's persona from the resolved tenant +
 * memberships. Platform-admin via holdsPlatformAdmin (reused);
 * tenant-admin via a live, non-revoked, tenant-scope binding in
 * the resolved tenant (the dataLifecycle inline pattern); else
 * paid/non-paid by the resolved tier fact.
 */
export async function classifyNavPersona(
  membershipStore: MembershipStore,
  internalUserId: string,
  tenantId: string,
  tier: StoreTier,
  nowMs: number,
): Promise<NavPersona> {
  if (await holdsPlatformAdmin(membershipStore, internalUserId, nowMs)) {
    return "platform-admin";
  }
  const memberships = await membershipStore.getMembershipsByUser(internalUserId);
  const isTenantAdmin = memberships.some(
    (m) =>
      m.tenantId === tenantId &&
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) =>
          b.role === "tenant-admin" &&
          b.scope === "tenant" &&
          (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
      ),
  );
  if (isTenantAdmin) return "tenant-admin";
  return tier === "Subscribed" ? "paid" : "non-paid";
}

// ---------------------------------------------------------------------------
// #6151 S3 — shared helpers for the nav + preset routes.
// ---------------------------------------------------------------------------

/** The preset store for this call: injected, built from env, or null when unbound. */
function presetStoreFromDeps(deps: NavRouteDeps | undefined, env: Env): NavPresetStore | null {
  return deps?.presets !== undefined ? deps.presets : createNavPresetAdapter(env);
}

/** The admin-config store for this call: injected, built from env, or null when unbound. */
function adminConfigStoreFromDeps(
  deps: NavRouteDeps | undefined,
  env: Env,
): NavAdminConfigStore | null {
  return deps?.adminConfig !== undefined
    ? deps.adminConfig
    : createNavAdminConfigAdapter(env);
}

function jsonError(code: string, error: string, status: number): Response {
  return Response.json({ ok: false, code, error }, { status });
}

/** Authenticate the caller (401 without a session, 403 for a legacy session with no identity). */
async function authenticateNavCaller(request: Request, env: Env) {
  const auth = await authenticateRequest(request, env);
  if (!auth) {
    return jsonError(
      "FAILURE_AUTH_NO_SESSION",
      "Unauthorized: verified login required.",
      401,
    );
  }
  const { session, sessionId } = auth;
  // Legacy sessions carry no internalUserId, so no stable identity
  // exists to resolve against — fail closed, never resolve as
  // someone else.
  if (!session.internalUserId) {
    return jsonError(
      "FAILURE_NAV_NO_IDENTITY",
      "Forbidden: the session carries no wired identity.",
      403,
    );
  }
  return { userId: session.internalUserId, sessionId };
}

interface NavCaller {
  userId: string;
  tenantId: string;
  tier: StoreTier;
  persona: NavPersona;
  commercial: CommercialStore;
  subscriptions: SubscriptionStore;
  membershipStore: MembershipStore;
  nowMs: number;
}

/**
 * Authenticate + resolve the caller's platform context once and
 * classify the persona. The nav read and the preset apply/selection
 * writes share this path, so the entitlement facts are the same
 * ones the availability endpoint returns. Returns a Response on
 * 401/403/503; callers check `instanceof Response`.
 */
async function resolveNavCaller(
  request: Request,
  env: Env,
  taskId: string,
  deps?: NavRouteDeps,
): Promise<NavCaller | Response> {
  const caller = await authenticateNavCaller(request, env);
  if (caller instanceof Response) return caller;
  const { userId, sessionId } = caller;

  const commercial =
    deps?.commercial !== undefined ? deps.commercial : createCommercialAdapter(env);
  const subscriptions =
    deps?.subscriptions !== undefined ? deps.subscriptions : createSubscriptionAdapter(env);
  if (!commercial || !subscriptions) {
    return jsonError(
      "FAILURE_COMMERCIAL_SERVICE_UNAVAILABLE",
      "Billing subscription verification unavailable.",
      503,
    );
  }

  const membershipStore = createKvMembershipStore(sessionStore(env));
  const nowMs = Date.now();
  const result = await resolvePlatformContext(
    {
      authority: {
        memberships: membershipStore,
        // No connectionId is passed to the resolution, so the
        // connection-bound check is never invoked — the same shape
        // as the resolver's own tests.
        isConnectionBound: async () => true,
      },
      ports: { commercial, subscriptions },
      env,
    },
    {
      principalId: userId,
      sessionId,
      taskId,
      serviceId: "nav",
      permission: "task:read",
      environment: "sandbox",
      nowMs,
    },
  );
  if (!result.ok) {
    return jsonError(result.code, result.error, 403);
  }

  // The tier is a top-level session fact on the resolution result
  // (facts.identity.tier) — the #1078 ExecutionContext itself
  // carries no tier field. It flows through unchanged: the endpoint
  // never re-derives it.
  const tier = result.tier;
  const persona = await classifyNavPersona(
    membershipStore,
    userId,
    result.context.tenantId,
    tier,
    nowMs,
  );
  return {
    userId,
    tenantId: result.context.tenantId,
    tier,
    persona,
    commercial,
    subscriptions,
    membershipStore,
    nowMs,
  };
}

/**
 * #6151 S3 — the caller's base selection map: the active saved
 * preset's map, else the stored custom map, else the persona
 * default. A stale active pointer (the preset was deleted
 * out-of-band) falls back to the stored map / default — the read
 * path heals it, so no partial state is ever visible. A missing
 * or unreadable preset store degrades to the persona default.
 *
 * #6151 S4 — when saved presets are disallowed for the caller
 * (their allow-list says so), the active preset is ignored: the
 * base falls back to the stored custom map / persona default, so
 * a disallowed preset never resurrects a tab.
 */
async function loadNavBase(
  presets: NavPresetStore | null,
  userId: string,
  personaDefault: string,
  savedPresetsAllowed = true,
): Promise<{ base: Record<string, boolean>; activePresetId: string | null }> {
  const fallback = {
    base: expandPresetKey(personaDefault),
    activePresetId: null as string | null,
  };
  if (!presets) return fallback;
  let state: Awaited<ReturnType<NavPresetStore["getState"]>> = null;
  try {
    state = await presets.getState(userId);
  } catch {
    return fallback;
  }
  if (!state) return fallback;
  if (state.activePresetId && savedPresetsAllowed) {
    let preset: Awaited<ReturnType<NavPresetStore["getPreset"]>> = null;
    try {
      preset = await presets.getPreset(userId, state.activePresetId);
    } catch {
      preset = null;
    }
    if (preset) {
      return { base: normalizePresetMap(preset.map), activePresetId: preset.id };
    }
    // Stale pointer — fall through to the stored map / default.
  }
  if (state.map) {
    return { base: normalizePresetMap(state.map), activePresetId: null };
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// #6151 S4 — tenant allowance + per-user allow-list narrowing.
// ---------------------------------------------------------------------------

/**
 * The caller's S4 narrowing rows, read once per call. Admin
 * personas bypass the narrowing (they see the entire menu), so
 * both rows read null for them; an unbound or unreadable store
 * also reads null — "no row means no narrowing", the same degrade
 * direction as the subscription read below.
 */
async function readCallerAdminNarrowing(args: {
  adminConfig: NavAdminConfigStore | null;
  tenantId: string;
  userId: string;
  persona: NavPersona;
  env: Env;
}): Promise<{
  allowance: Awaited<ReturnType<NavAdminConfigStore["getTenantAllowance"]>>;
  allowlist: Awaited<ReturnType<NavAdminConfigStore["getUserAllowlist"]>>;
}> {
  const none = { allowance: null, allowlist: null };
  const { adminConfig, tenantId, userId, persona, env } = args;
  if (!adminConfig) return none;
  if (persona === "platform-admin" || persona === "tenant-admin") return none;
  try {
    const [allowance, allowlist] = await Promise.all([
      adminConfig.getTenantAllowance(tenantId),
      adminConfig.getUserAllowlist(userId),
    ]);
    return { allowance, allowlist };
  } catch (err) {
    const structuredLog = createStructuredLogger(createObservabilitySink(env), {
      component: "server/routes/nav",
    });
    structuredLog.warn("nav.admin_config_read_failed", {
      message: `[nav-availability] admin-config read failed; serving the map ungated by allowance/allow-list: ${err instanceof Error ? err.message : String(err)}`,
      persona,
    });
    return none;
  }
}

/**
 * Intersect a base map with the caller's allowance and allow-list.
 * Pure — the S4 test pins the intersection through the endpoint.
 * An absent row means no narrowing for that layer.
 */
function applyAdminNarrowing(
  base: Record<string, boolean>,
  allowance: Awaited<ReturnType<NavAdminConfigStore["getTenantAllowance"]>>,
  allowlist: Awaited<ReturnType<NavAdminConfigStore["getUserAllowlist"]>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...base };
  if (allowance) {
    const allowed = new Set(allowance.allowedIds);
    for (const id of Object.keys(out)) out[id] = out[id] && allowed.has(id);
  }
  if (allowlist) {
    const allowed = new Set(allowlist.allowedIds);
    for (const id of Object.keys(out)) out[id] = out[id] && allowed.has(id);
  }
  return out;
}

/**
 * The caller's effective persona-default preset key: the S4
 * stored override when one exists for the persona, else the
 * shipped config. A missing/unreadable store degrades to the
 * shipped config, so an edit takes effect on the next load with
 * no redeploy — and a store outage never changes the default.
 */
async function effectivePersonaDefaultPresetKey(
  adminConfig: NavAdminConfigStore | null,
  persona: NavPersona,
): Promise<string> {
  if (!adminConfig) return personaDefaultPresetKey(persona);
  try {
    const override = await adminConfig.getPersonaDefault(persona);
    if (override) return override.presetKey;
  } catch {
    // Degrade to shipped.
  }
  return personaDefaultPresetKey(persona);
}

/**
 * #6151 S2 (extracted for S3 reuse) — gate a base map by the
 * subscription entitlements. Admin personas bypass the narrowing
 * and see the entire menu. A transient subscription-store read
 * failure serves the base map ungated — availability is a UX
 * narrowing, never an authorization gate, so the permissive
 * fallback keeps the surface working.
 */
async function gateNavBase(args: {
  base: Record<string, boolean>;
  persona: NavPersona;
  subscriptions: SubscriptionStore;
  userId: string;
  mapping: ProductMenuMappingEntry[];
  nowMs: number;
  env: Env;
}): Promise<Record<string, boolean>> {
  const { base, persona, subscriptions, userId, mapping, nowMs, env } = args;
  if (persona === "platform-admin" || persona === "tenant-admin") return base;
  if (mapping.length === 0) return base;
  try {
    const rows = await subscriptions.listSubscriptions(userId);
    const plans = await subscriptions.listPlans(false);
    const plansById = new Map(plans.map((p) => [p.id, p]));
    const active = activeSubscriptionProductIds(rows, plansById, nowMs);
    return applyProductMenuGating(base, mapping, active);
  } catch (err) {
    // The stores are bound (the resolution just read them), so
    // a read failure here is transient — serve the base map
    // ungated.
    const structuredLog = createStructuredLogger(createObservabilitySink(env), {
      component: "server/routes/nav",
    });
    structuredLog.warn("nav.subscription_read_failed", {
      message: `[nav-availability] subscription read failed; serving the persona-default map ungated: ${err instanceof Error ? err.message : String(err)}`,
      persona,
    });
    return base;
  }
}

/** The saved-preset ids for the caller's availablePresets (empty when the store is unbound/unreadable). */
async function listSavedPresetIds(
  presets: NavPresetStore | null,
  userId: string,
): Promise<string[]> {
  if (!presets) return [];
  try {
    const rows = await presets.listPresets(userId);
    return rows.map((p) => p.id);
  } catch {
    return [];
  }
}

/** Map a preset-store BusinessError code to its HTTP status. */
function presetErrorStatus(code: string): number {
  if (code === "FAILURE_NAV_PRESET_NOT_FOUND") return 404;
  if (code === "FAILURE_NAV_PRESET_CONFLICT") return 409;
  if (
    code === "FAILURE_NAV_PRESET_NAME_INVALID" ||
    code === "FAILURE_NAV_PRESET_REQUEST_INVALID"
  ) {
    return 400;
  }
  return 500;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const data: unknown = await request.json().catch(() => null);
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

function methodNotAllowed(): Response {
  return jsonError(
    "FAILURE_NAV_METHOD_NOT_ALLOWED",
    "Method not allowed.",
    405,
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleNavAvailability(
  request: Request,
  env: Env,
  deps?: NavRouteDeps,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const caller = await resolveNavCaller(request, env, "nav-availability", deps);
  if (caller instanceof Response) return caller;
  const { userId, tenantId, tier, persona, subscriptions, nowMs } = caller;
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  const personaDefault = await effectivePersonaDefaultPresetKey(adminConfig, persona);
  const presets = presetStoreFromDeps(deps, env);
  // The allow-list is read before the base: a disallowed saved
  // preset must not become the base in the first place.
  const narrowing = await readCallerAdminNarrowing({
    adminConfig,
    tenantId,
    userId,
    persona,
    env,
  });
  const savedPresetsAllowed = narrowing.allowlist?.savedPresetsAllowed ?? true;
  const { base } = await loadNavBase(presets, userId, personaDefault, savedPresetsAllowed);
  const mapping =
    deps?.productMenuMapping !== undefined
      ? deps.productMenuMapping
      : productMenuMapping();
  const gated = await gateNavBase({
    base,
    persona,
    subscriptions,
    userId,
    mapping,
    nowMs,
    env,
  });
  const visibleTabs = applyAdminNarrowing(gated, narrowing.allowance, narrowing.allowlist);
  const savedIds = savedPresetsAllowed
    ? await listSavedPresetIds(presets, userId)
    : [];
  const body: NavAvailabilityResponse = {
    ok: true,
    visibleTabs,
    availablePresets: [...builtinPresetKeys(), ...savedIds],
    personaDefault,
    persona,
    tier,
  };
  return Response.json(body);
}

async function handleNavPresets(
  request: Request,
  env: Env,
  deps?: NavRouteDeps,
): Promise<Response> {
  if (request.method === "GET") {
    const caller = await authenticateNavCaller(request, env);
    if (caller instanceof Response) return caller;
    const presets = presetStoreFromDeps(deps, env);
    if (!presets) {
      // No store bound: the list degrades to empty (the section
      // hides), never a 503 on a read.
      return Response.json({ ok: true, presets: [], activePresetId: null, stateMap: null });
    }
    try {
      await presets.ensureSchema();
      const rows = await presets.listPresets(caller.userId);
      const state = await presets.getState(caller.userId);
      // stateMap is the stored custom selection (null when the
      // active preset — or nothing — is selected). The shell adopts
      // it on load so a previous session's selection wins over the
      // stale localStorage map; the nav-availability endpoint
      // returns the same map gated, never ungated.
      return Response.json({
        ok: true,
        presets: rows,
        activePresetId: state?.activePresetId ?? null,
        stateMap: state?.map ?? null,
      });
    } catch (err) {
      const structuredLog = createStructuredLogger(createObservabilitySink(env), {
        component: "server/routes/nav",
      });
      structuredLog.warn("nav.preset_list_failed", {
        message: `[nav-presets] preset list failed; serving empty: ${err instanceof Error ? err.message : String(err)}`,
      });
      return Response.json({ ok: true, presets: [], activePresetId: null, stateMap: null });
    }
  }
  if (request.method === "POST") {
    const caller = await authenticateNavCaller(request, env);
    if (caller instanceof Response) return caller;
    const presets = presetStoreFromDeps(deps, env);
    if (!presets) {
      return jsonError(
        "FAILURE_NAV_PRESET_STORE_UNAVAILABLE",
        "Saved presets are unavailable.",
        503,
      );
    }
    const body = await readJsonBody(request);
    if (!body || typeof body.name !== "string" || !isPresetMapInput(body.map)) {
      return jsonError(
        "FAILURE_NAV_PRESET_REQUEST_INVALID",
        "A preset needs a name and a visibility map.",
        400,
      );
    }
    try {
      await presets.ensureSchema();
      const record = await presets.createPreset(
        caller.userId,
        body.name,
        normalizePresetMap(body.map),
      );
      return Response.json({ ok: true, preset: record }, { status: 201 });
    } catch (err) {
      const code =
        err instanceof BusinessError ? err.code : "FAILURE_NAV_PRESET_REQUEST_INVALID";
      return jsonError(code, code, presetErrorStatus(code));
    }
  }
  return methodNotAllowed();
}

async function handleNavPresetSelection(
  request: Request,
  env: Env,
  deps?: NavRouteDeps,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const caller = await resolveNavCaller(request, env, "nav-preset-selection", deps);
  if (caller instanceof Response) return caller;
  const presets = presetStoreFromDeps(deps, env);
  if (!presets) {
    return jsonError(
      "FAILURE_NAV_PRESET_STORE_UNAVAILABLE",
      "Saved presets are unavailable.",
      503,
    );
  }
  const body = await readJsonBody(request);
  if (!body || !isPresetMapInput(body.map)) {
    return jsonError(
      "FAILURE_NAV_PRESET_REQUEST_INVALID",
      "A selection needs a visibility map.",
      400,
    );
  }
  const normalized = normalizePresetMap(body.map);
  const mapping =
    deps?.productMenuMapping !== undefined
      ? deps.productMenuMapping
      : productMenuMapping();
  const gated = await gateNavBase({
    base: normalized,
    persona: caller.persona,
    subscriptions: caller.subscriptions,
    userId: caller.userId,
    mapping,
    nowMs: caller.nowMs,
    env,
  });
  // #6151 S4 — the returned map is capped by the allowance /
  // allow-list exactly like the availability read; the stored
  // selection keeps the full map (filtering is at read time).
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  const narrowing = await readCallerAdminNarrowing({
    adminConfig,
    tenantId: caller.tenantId,
    userId: caller.userId,
    persona: caller.persona,
    env,
  });
  const visibleTabs = applyAdminNarrowing(gated, narrowing.allowance, narrowing.allowlist);
  await presets.ensureSchema();
  await presets.setState(caller.userId, { activePresetId: null, map: normalized });
  return Response.json({ ok: true, visibleTabs });
}

async function handleNavPresetAction(
  request: Request,
  env: Env,
  deps: NavRouteDeps | undefined,
  id: string,
  action: "apply" | "rename",
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (action === "rename") {
    const caller = await authenticateNavCaller(request, env);
    if (caller instanceof Response) return caller;
    const presets = presetStoreFromDeps(deps, env);
    if (!presets) {
      return jsonError(
        "FAILURE_NAV_PRESET_STORE_UNAVAILABLE",
        "Saved presets are unavailable.",
        503,
      );
    }
    const body = await readJsonBody(request);
    if (!body || typeof body.name !== "string") {
      return jsonError(
        "FAILURE_NAV_PRESET_REQUEST_INVALID",
        "A rename needs a name.",
        400,
      );
    }
    try {
      await presets.ensureSchema();
      const record = await presets.renamePreset(
        caller.userId,
        id,
        body.name,
      );
      return Response.json({ ok: true, preset: record });
    } catch (err) {
      const code =
        err instanceof BusinessError ? err.code : "FAILURE_NAV_PRESET_REQUEST_INVALID";
      return jsonError(code, code, presetErrorStatus(code));
    }
  }
  // apply — resolves the caller (persona + entitlements) so the
  // returned map is the preset map filtered by the subscription
  // gating, never a disallowed tab.
  const caller = await resolveNavCaller(request, env, "nav-preset-apply", deps);
  if (caller instanceof Response) return caller;
  const presets = presetStoreFromDeps(deps, env);
  if (!presets) {
    return jsonError(
      "FAILURE_NAV_PRESET_STORE_UNAVAILABLE",
      "Saved presets are unavailable.",
      503,
    );
  }
  // #6151 S4 — a per-user allow-list with saved presets
  // disallowed refuses the apply outright: the preset never
  // becomes the active selection.
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  const narrowing = await readCallerAdminNarrowing({
    adminConfig,
    tenantId: caller.tenantId,
    userId: caller.userId,
    persona: caller.persona,
    env,
  });
  if (narrowing.allowlist && narrowing.allowlist.savedPresetsAllowed === false) {
    return jsonError(
      "FAILURE_NAV_PRESET_NOT_ALLOWED",
      "Saved presets are not available for this user.",
      403,
    );
  }
  try {
    await presets.ensureSchema();
    const preset = await presets.getPreset(caller.userId, id);
    if (!preset) {
      return jsonError(
        "FAILURE_NAV_PRESET_NOT_FOUND",
        "No such saved preset.",
        404,
      );
    }
    const mapping =
      deps?.productMenuMapping !== undefined
        ? deps.productMenuMapping
        : productMenuMapping();
    const gated = await gateNavBase({
      base: normalizePresetMap(preset.map),
      persona: caller.persona,
      subscriptions: caller.subscriptions,
      userId: caller.userId,
      mapping,
      nowMs: caller.nowMs,
      env,
    });
    // #6151 S4 — the returned map is capped by the allowance /
    // allow-list exactly like the availability read (the narrowing
    // was read above, before the apply refusal).
    const visibleTabs = applyAdminNarrowing(gated, narrowing.allowance, narrowing.allowlist);
    await presets.setState(caller.userId, {
      activePresetId: preset.id,
      map: normalizePresetMap(preset.map),
    });
    return Response.json({ ok: true, preset, visibleTabs });
  } catch (err) {
    const code =
      err instanceof BusinessError ? err.code : "FAILURE_NAV_PRESET_REQUEST_INVALID";
    return jsonError(code, code, presetErrorStatus(code));
  }
}

async function handleNavPresetDelete(
  request: Request,
  env: Env,
  deps: NavRouteDeps | undefined,
  id: string,
): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed();
  const caller = await authenticateNavCaller(request, env);
  if (caller instanceof Response) return caller;
  const presets = presetStoreFromDeps(deps, env);
  if (!presets) {
    return jsonError(
      "FAILURE_NAV_PRESET_STORE_UNAVAILABLE",
      "Saved presets are unavailable.",
      503,
    );
  }
  await presets.ensureSchema();
  const deleted = await presets.deletePreset(caller.userId, id);
  if (!deleted) {
    return jsonError(
      "FAILURE_NAV_PRESET_NOT_FOUND",
      "No such saved preset.",
      404,
    );
  }
  const state = await presets.getState(caller.userId);
  return Response.json({
    ok: true,
    deletedId: id,
    activePresetId: state?.activePresetId ?? null,
  });
}

// ---------------------------------------------------------------------------
// #6151 S4 — admin-config routes (parts 4, 5, 6-UX).
//
// Who may write what (enforced here, server-side — the screens
// only reflect it):
// - Tenant allowances: platform admin only.
// - Per-user allow-lists: platform admin (any user) or tenant
//   admin (only users holding a live membership in the caller's
//   own tenant). The row's tenant is derived server-side, never
//   trusted from the client for a tenant-admin write.
// - Persona defaults: platform admin only (they are platform-wide).
// The tenant-allowance cap is enforced again in the store
// (setUserAllowlist refuses an exceeding write), so the route and
// the store agree about what a write may do.
// ---------------------------------------------------------------------------

/** Map an admin-config BusinessError code to its HTTP status. */
function adminConfigErrorStatus(code: string): number {
  if (
    code === "FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE" ||
    code === "FAILURE_NAV_ADMIN_FORBIDDEN"
  ) {
    return 403;
  }
  if (code === "FAILURE_NAV_ADMIN_REQUEST_INVALID") return 400;
  return 500;
}

/** The live (non-revoked) tenant ids a user holds memberships in. */
async function liveTenantIdsForUser(
  membershipStore: MembershipStore,
  userId: string,
): Promise<Set<string>> {
  const memberships = await membershipStore.getMembershipsByUser(userId);
  return new Set(
    memberships
      .filter((m) => m.revokedAtMs === undefined)
      .map((m) => m.tenantId),
  );
}

/**
 * The live member user ids per tenant, from the membership
 * listing (the #1758 list-all source). The admin screen picks
 * allow-list targets from this list — a tenant admin cannot use
 * the IAAA memberships endpoint (platform-admin gated), so the
 * list rides the admin-config read instead. A listing failure
 * degrades to null (the screen falls back to a typed user id).
 */
async function listTenantMemberUserIds(
  env: Env,
): Promise<Map<string, string[]> | null> {
  const entries = await listSessionFamilyEntries(env, "iaaa-membership:");
  if (!entries) return null;
  const byTenant = new Map<string, Set<string>>();
  for (const membership of listMembershipsFromEntries(entries)) {
    if (membership.revokedAtMs !== undefined) continue;
    const set = byTenant.get(membership.tenantId) ?? new Set<string>();
    set.add(membership.internalUserId);
    byTenant.set(membership.tenantId, set);
  }
  const out = new Map<string, string[]>();
  for (const [tenantId, ids] of [...byTenant.entries()].sort()) {
    out.set(tenantId, [...ids].sort());
  }
  return out;
}

async function handleNavAdminConfig(
  request: Request,
  env: Env,
  deps?: NavRouteDeps,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const caller = await resolveNavCaller(request, env, "nav-admin-config", deps);
  if (caller instanceof Response) return caller;
  if (caller.persona !== "platform-admin" && caller.persona !== "tenant-admin") {
    return jsonError(
      "FAILURE_NAV_ADMIN_FORBIDDEN",
      "Admin access required.",
      403,
    );
  }
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  const scope = caller.persona === "platform-admin" ? "platform" : "tenant";
  // The effective default per persona: the stored override when
  // one exists, else the shipped config — the same read the
  // availability endpoint performs, so the screen never shows a
  // default the endpoint would not use.
  const personaDefaults = [];
  for (const persona of NAV_PERSONAS) {
    let presetKey = personaDefaultPresetKey(persona);
    let overridden = false;
    if (adminConfig) {
      try {
        const row = await adminConfig.getPersonaDefault(persona);
        if (row) {
          presetKey = row.presetKey;
          overridden = true;
        }
      } catch {
        // Degrade to shipped.
      }
    }
    personaDefaults.push({ persona, presetKey, overridden });
  }
  if (!adminConfig) {
    return Response.json({
      ok: true,
      scope,
      tenantId: caller.tenantId,
      allowances: [],
      allowlists: [],
      personaDefaults,
      tenantMembers: [],
    });
  }
  try {
    await adminConfig.ensureSchema();
    let allowances: Awaited<
      ReturnType<NavAdminConfigStore["listTenantAllowances"]>
    > = [];
    let allowlists: Awaited<
      ReturnType<NavAdminConfigStore["listUserAllowlists"]>
    > = [];
    if (scope === "platform") {
      allowances = await adminConfig.listTenantAllowances();
      allowlists = await adminConfig.listUserAllowlists();
    } else {
      const allowance = await adminConfig.getTenantAllowance(caller.tenantId);
      allowances = allowance ? [allowance] : [];
      allowlists = await adminConfig.listUserAllowlists(caller.tenantId);
    }
    // Member user ids in scope, for the allow-list target picker.
    // A listing failure degrades to an empty list (the screen
    // falls back to a typed user id).
    let tenantMembers: { tenantId: string; userIds: string[] }[] = [];
    try {
      const members = await listTenantMemberUserIds(env);
      if (members) {
        const entries = [...members.entries()].map(([tenantId, userIds]) => ({
          tenantId,
          userIds,
        }));
        tenantMembers =
          scope === "platform"
            ? entries
            : entries.filter((entry) => entry.tenantId === caller.tenantId);
      }
    } catch {
      tenantMembers = [];
    }
    return Response.json({
      ok: true,
      scope,
      tenantId: caller.tenantId,
      allowances,
      allowlists,
      personaDefaults,
      tenantMembers,
    });
  } catch (err) {
    const structuredLog = createStructuredLogger(createObservabilitySink(env), {
      component: "server/routes/nav",
    });
    structuredLog.warn("nav.admin_config_list_failed", {
      message: `[nav-admin-config] admin config list failed; serving empty: ${err instanceof Error ? err.message : String(err)}`,
    });
    return Response.json({
      ok: true,
      scope,
      tenantId: caller.tenantId,
      allowances: [],
      allowlists: [],
      personaDefaults,
      tenantMembers: [],
    });
  }
}

async function handleNavAdminTenantAllowance(
  request: Request,
  env: Env,
  deps?: NavRouteDeps,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed();
  const caller = await resolveNavCaller(request, env, "nav-admin-tenant-allowance", deps);
  if (caller instanceof Response) return caller;
  if (caller.persona !== "platform-admin") {
    return jsonError(
      "FAILURE_NAV_ADMIN_FORBIDDEN",
      "Only a platform admin writes tenant allowances.",
      403,
    );
  }
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  if (!adminConfig) {
    return jsonError(
      "FAILURE_NAV_ADMIN_STORE_UNAVAILABLE",
      "Admin config is unavailable.",
      503,
    );
  }
  const body = await readJsonBody(request);
  if (!body || typeof body.tenantId !== "string" || !Array.isArray(body.allowedIds)) {
    return jsonError(
      "FAILURE_NAV_ADMIN_REQUEST_INVALID",
      "A tenant allowance needs a tenant id and an id list.",
      400,
    );
  }
  try {
    const tenantId = assertNavAdminId(body.tenantId);
    await adminConfig.ensureSchema();
    const allowance = await adminConfig.setTenantAllowance(
      tenantId,
      body.allowedIds as string[],
      caller.userId,
    );
    return Response.json({ ok: true, allowance });
  } catch (err) {
    const code =
      err instanceof BusinessError ? err.code : "FAILURE_NAV_ADMIN_REQUEST_INVALID";
    return jsonError(code, code, adminConfigErrorStatus(code));
  }
}

async function handleNavAdminUserAllowlist(
  request: Request,
  env: Env,
  deps?: NavRouteDeps,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed();
  const caller = await resolveNavCaller(request, env, "nav-admin-user-allowlist", deps);
  if (caller instanceof Response) return caller;
  if (caller.persona !== "platform-admin" && caller.persona !== "tenant-admin") {
    return jsonError(
      "FAILURE_NAV_ADMIN_FORBIDDEN",
      "Only an admin writes per-user allow-lists.",
      403,
    );
  }
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  if (!adminConfig) {
    return jsonError(
      "FAILURE_NAV_ADMIN_STORE_UNAVAILABLE",
      "Admin config is unavailable.",
      503,
    );
  }
  const body = await readJsonBody(request);
  if (
    !body ||
    typeof body.userId !== "string" ||
    !Array.isArray(body.allowedIds) ||
    (body.savedPresetsAllowed !== undefined &&
      typeof body.savedPresetsAllowed !== "boolean")
  ) {
    return jsonError(
      "FAILURE_NAV_ADMIN_REQUEST_INVALID",
      "An allow-list needs a user id, an id list, and an optional saved-presets flag.",
      400,
    );
  }
  try {
    const targetUserId = assertNavAdminId(body.userId);
    // The row's tenant is derived server-side. A tenant admin
    // writes only users holding a live membership in their own
    // tenant; a platform admin may name a tenant, else the
    // target's first live membership tenant (null when the user
    // holds no tenant membership).
    let tenantId: string | null;
    if (caller.persona === "tenant-admin") {
      const live = await liveTenantIdsForUser(caller.membershipStore, targetUserId);
      if (!live.has(caller.tenantId)) {
        return jsonError(
          "FAILURE_NAV_ADMIN_FORBIDDEN",
          "The user is not a member of your tenant.",
          403,
        );
      }
      tenantId = caller.tenantId;
    } else if (typeof body.tenantId === "string" && body.tenantId.trim().length > 0) {
      tenantId = body.tenantId.trim();
    } else {
      const live = await liveTenantIdsForUser(caller.membershipStore, targetUserId);
      tenantId = [...live].sort()[0] ?? null;
    }
    await adminConfig.ensureSchema();
    const allowlist = await adminConfig.setUserAllowlist(
      targetUserId,
      {
        tenantId,
        allowedIds: body.allowedIds as string[],
        savedPresetsAllowed:
          typeof body.savedPresetsAllowed === "boolean"
            ? body.savedPresetsAllowed
            : undefined,
      },
      caller.userId,
    );
    return Response.json({ ok: true, allowlist });
  } catch (err) {
    const code =
      err instanceof BusinessError ? err.code : "FAILURE_NAV_ADMIN_REQUEST_INVALID";
    return jsonError(code, code, adminConfigErrorStatus(code));
  }
}

async function handleNavAdminPersonaDefault(
  request: Request,
  env: Env,
  deps?: NavRouteDeps,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed();
  const caller = await resolveNavCaller(request, env, "nav-admin-persona-default", deps);
  if (caller instanceof Response) return caller;
  if (caller.persona !== "platform-admin") {
    return jsonError(
      "FAILURE_NAV_ADMIN_FORBIDDEN",
      "Only a platform admin edits persona defaults.",
      403,
    );
  }
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  if (!adminConfig) {
    return jsonError(
      "FAILURE_NAV_ADMIN_STORE_UNAVAILABLE",
      "Admin config is unavailable.",
      503,
    );
  }
  const body = await readJsonBody(request);
  if (!body || !isNavPersona(body.persona) || typeof body.presetKey !== "string") {
    return jsonError(
      "FAILURE_NAV_ADMIN_REQUEST_INVALID",
      "A persona default needs a persona and a built-in preset key.",
      400,
    );
  }
  try {
    const presetKey = assertPersonaPresetKey(body.presetKey);
    await adminConfig.ensureSchema();
    const personaDefault = await adminConfig.setPersonaDefault(
      body.persona,
      presetKey,
      caller.userId,
    );
    return Response.json({ ok: true, personaDefault });
  } catch (err) {
    const code =
      err instanceof BusinessError ? err.code : "FAILURE_NAV_ADMIN_REQUEST_INVALID";
    return jsonError(code, code, adminConfigErrorStatus(code));
  }
}

async function handleNavAdminPersonaDefaultDelete(
  request: Request,
  env: Env,
  deps: NavRouteDeps | undefined,
  persona: string,
): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed();
  const caller = await resolveNavCaller(request, env, "nav-admin-persona-default", deps);
  if (caller instanceof Response) return caller;
  if (caller.persona !== "platform-admin") {
    return jsonError(
      "FAILURE_NAV_ADMIN_FORBIDDEN",
      "Only a platform admin edits persona defaults.",
      403,
    );
  }
  if (!isNavPersona(persona)) {
    return jsonError(
      "FAILURE_NAV_ADMIN_REQUEST_INVALID",
      "No such persona.",
      400,
    );
  }
  const adminConfig = adminConfigStoreFromDeps(deps, env);
  if (!adminConfig) {
    return jsonError(
      "FAILURE_NAV_ADMIN_STORE_UNAVAILABLE",
      "Admin config is unavailable.",
      503,
    );
  }
  await adminConfig.ensureSchema();
  const deleted = await adminConfig.deletePersonaDefault(persona);
  return Response.json({ ok: true, deleted });
}

/** Parse /api/platform/nav-admin/persona-default/:persona; null otherwise. */
function matchNavAdminPersonaDefault(path: string): { persona: string } | null {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (
    parts.length === 5 &&
    parts[0] === "api" &&
    parts[1] === "platform" &&
    parts[2] === "nav-admin" &&
    parts[3] === "persona-default"
  ) {
    return { persona: parts[4] };
  }
  return null;
}

/** Parse /api/platform/nav-presets/:id[/apply|/rename]; null when the path is not a preset-action path. */
function matchNavPresetAction(
  path: string,
): { id: string; action: "apply" | "rename" | null } | null {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (
    parts.length < 4 ||
    parts[0] !== "api" ||
    parts[1] !== "platform" ||
    parts[2] !== "nav-presets"
  ) {
    return null;
  }
  if (parts.length === 4) {
    if (parts[3] === "selection") return null;
    return { id: parts[3], action: null };
  }
  if (
    parts.length === 5 &&
    (parts[4] === "apply" || parts[4] === "rename")
  ) {
    return { id: parts[3], action: parts[4] };
  }
  return null;
}

export async function handleNavRoutes(
  request: Request,
  env: Env,
  _url: URL,
  path: string,
  deps?: NavRouteDeps,
): Promise<Response | null> {
  if (path === NAV_AVAILABILITY_PATH) {
    return handleNavAvailability(request, env, deps);
  }
  if (path === NAV_PRESETS_PATH) {
    return handleNavPresets(request, env, deps);
  }
  if (path === NAV_PRESETS_SELECTION_PATH) {
    return handleNavPresetSelection(request, env, deps);
  }
  if (path === NAV_ADMIN_CONFIG_PATH) {
    return handleNavAdminConfig(request, env, deps);
  }
  if (path === NAV_ADMIN_TENANT_ALLOWANCE_PATH) {
    return handleNavAdminTenantAllowance(request, env, deps);
  }
  if (path === NAV_ADMIN_USER_ALLOWLIST_PATH) {
    return handleNavAdminUserAllowlist(request, env, deps);
  }
  if (path === NAV_ADMIN_PERSONA_DEFAULT_PATH) {
    return handleNavAdminPersonaDefault(request, env, deps);
  }
  const personaDefaultMatch = matchNavAdminPersonaDefault(path);
  if (personaDefaultMatch) {
    return handleNavAdminPersonaDefaultDelete(
      request,
      env,
      deps,
      personaDefaultMatch.persona,
    );
  }
  const match = matchNavPresetAction(path);
  if (match) {
    if (match.action === "apply" || match.action === "rename") {
      return handleNavPresetAction(request, env, deps, match.id, match.action);
    }
    return handleNavPresetDelete(request, env, deps, match.id);
  }
  return null;
}
