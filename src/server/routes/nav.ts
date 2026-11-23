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
 * for a product that enables it. Tenant allowance (S4 storage —
 * absent until S4, "no allowance" means the tenant gets everything
 * the platform enables) and per-user allow-lists (absent until S4
 * — same "no allow-list means no narrowing" rule) narrow on top of
 * this in S4. Admin personas bypass the subscription narrowing —
 * they see the entire menu (issue part 2).
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
import type { CommercialStore } from "../../data/commercialPorts";
import type { SubscriptionStore } from "../../data/subscriptionPorts";
import type { NavPresetStore } from "../../data/navPresetPorts";
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
  /** Test seam: production reads the shipped config mapping. */
  productMenuMapping?: ProductMenuMappingEntry[];
}

const NAV_AVAILABILITY_PATH = "/api/platform/nav-availability";
const NAV_PRESETS_PATH = "/api/platform/nav-presets";
const NAV_PRESETS_SELECTION_PATH = "/api/platform/nav-presets/selection";

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
 */
async function loadNavBase(
  presets: NavPresetStore | null,
  userId: string,
  personaDefault: string,
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
  if (state.activePresetId) {
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
  const { userId, tier, persona, subscriptions, nowMs } = caller;
  const personaDefault = personaDefaultPresetKey(persona);
  const presets = presetStoreFromDeps(deps, env);
  const { base } = await loadNavBase(presets, userId, personaDefault);
  const mapping =
    deps?.productMenuMapping !== undefined
      ? deps.productMenuMapping
      : productMenuMapping();
  const visibleTabs = await gateNavBase({
    base,
    persona,
    subscriptions,
    userId,
    mapping,
    nowMs,
    env,
  });
  const savedIds = await listSavedPresetIds(presets, userId);
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
  const visibleTabs = await gateNavBase({
    base: normalized,
    persona: caller.persona,
    subscriptions: caller.subscriptions,
    userId: caller.userId,
    mapping,
    nowMs: caller.nowMs,
    env,
  });
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
    const visibleTabs = await gateNavBase({
      base: normalizePresetMap(preset.map),
      persona: caller.persona,
      subscriptions: caller.subscriptions,
      userId: caller.userId,
      mapping,
      nowMs: caller.nowMs,
      env,
    });
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
  const match = matchNavPresetAction(path);
  if (match) {
    if (match.action === "apply" || match.action === "rename") {
      return handleNavPresetAction(request, env, deps, match.id, match.action);
    }
    return handleNavPresetDelete(request, env, deps, match.id);
  }
  return null;
}
