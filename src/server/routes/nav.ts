/**
 * #6151 S1+S2 — the nav-availability endpoint (GET /api/platform/nav-availability).
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
 * Computation order: persona default (expanded from the shared
 * preset maps — S2 expands ANY key, S1 expanded only `alltabs`),
 * then subscription entitlements (S2): a nav id named in the
 * product→menu mapping stays visible only while the caller holds
 * an active subscription for a product that enables it. Tenant
 * allowance (S4 storage — absent until S4, "no allowance" means
 * the tenant gets everything the platform enables) and per-user
 * allow-lists (absent until S4 — same "no allow-list means no
 * narrowing" rule) narrow on top of this in S4. Admin personas
 * bypass the subscription narrowing — they see the entire menu
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
 */
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import type { SubscriptionStore } from "../../data/subscriptionPorts";
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
import type { Env } from "../../types";

export interface NavAvailabilityResponse {
  ok: true;
  visibleTabs: Record<string, boolean>;
  availablePresets: string[];
  personaDefault: string;
  persona: NavPersona;
  tier: StoreTier;
}

/** Stores injected by tests; production builds them from env. */
export interface NavRouteDeps {
  commercial?: CommercialStore | null;
  subscriptions?: SubscriptionStore | null;
  /** Test seam: production reads the shipped config mapping. */
  productMenuMapping?: ProductMenuMappingEntry[];
}

const NAV_AVAILABILITY_PATH = "/api/platform/nav-availability";

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

export async function handleNavRoutes(
  request: Request,
  env: Env,
  _url: URL,
  path: string,
  deps?: NavRouteDeps,
): Promise<Response | null> {
  if (path !== NAV_AVAILABILITY_PATH) return null;
  if (request.method !== "GET") {
    return Response.json(
      { ok: false, code: "FAILURE_NAV_METHOD_NOT_ALLOWED", error: "Method not allowed." },
      { status: 405 },
    );
  }

  const auth = await authenticateRequest(request, env);
  if (!auth) {
    return Response.json(
      { ok: false, code: "FAILURE_AUTH_NO_SESSION", error: "Unauthorized: verified login required." },
      { status: 401 },
    );
  }
  const { session, sessionId } = auth;
  // Legacy sessions carry no internalUserId, so no stable identity
  // exists to resolve against — fail closed, never resolve as
  // someone else.
  if (!session.internalUserId) {
    return Response.json(
      { ok: false, code: "FAILURE_NAV_NO_IDENTITY", error: "Forbidden: the session carries no wired identity." },
      { status: 403 },
    );
  }

  const commercial =
    deps?.commercial !== undefined ? deps.commercial : createCommercialAdapter(env);
  const subscriptions =
    deps?.subscriptions !== undefined ? deps.subscriptions : createSubscriptionAdapter(env);
  if (!commercial || !subscriptions) {
    return Response.json(
      { ok: false, code: "FAILURE_COMMERCIAL_SERVICE_UNAVAILABLE", error: "Billing subscription verification unavailable." },
      { status: 503 },
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
      principalId: session.internalUserId,
      sessionId,
      taskId: "nav-availability",
      serviceId: "nav",
      permission: "task:read",
      environment: "sandbox",
      nowMs,
    },
  );
  if (!result.ok) {
    return Response.json(
      { ok: false, code: result.code, error: result.error },
      { status: 403 },
    );
  }

  // The tier is a top-level session fact on the resolution result
  // (facts.identity.tier) — the #1078 ExecutionContext itself
  // carries no tier field. It flows through unchanged: the endpoint
  // never re-derives it.
  const tier = result.tier;
  const persona = await classifyNavPersona(
    membershipStore,
    session.internalUserId,
    result.context.tenantId,
    tier,
    nowMs,
  );
  const personaDefault = personaDefaultPresetKey(persona);
  const base = expandPresetKey(personaDefault);

  // S2: subscription gating applies to paid/non-paid only — admin
  // personas see the entire menu. A mapped nav id stays visible
  // only while the caller holds an active subscription for a
  // product that enables it; unmapped ids pass through.
  let visibleTabs = base;
  if (persona !== "platform-admin" && persona !== "tenant-admin") {
    const mapping =
      deps?.productMenuMapping !== undefined
        ? deps.productMenuMapping
        : productMenuMapping();
    if (mapping.length > 0) {
      try {
        const rows = await subscriptions.listSubscriptions(session.internalUserId);
        const plans = await subscriptions.listPlans(false);
        const plansById = new Map(plans.map((p) => [p.id, p]));
        const active = activeSubscriptionProductIds(rows, plansById, nowMs);
        visibleTabs = applyProductMenuGating(base, mapping, active);
      } catch (err) {
        // The stores are bound (the resolution just read them), so
        // a read failure here is transient — serve the base map
        // ungated. Availability is a UX narrowing, never an
        // authorization gate, so the permissive fallback keeps the
        // surface working.
        const structuredLog = createStructuredLogger(createObservabilitySink(env), {
          component: "server/routes/nav",
        });
        structuredLog.warn("nav.subscription_read_failed", {
          message: `[nav-availability] subscription read failed; serving the persona-default map ungated: ${err instanceof Error ? err.message : String(err)}`,
          persona,
        });
      }
    }
  }
  const body: NavAvailabilityResponse = {
    ok: true,
    visibleTabs,
    availablePresets: builtinPresetKeys(),
    personaDefault,
    persona,
    tier,
  };
  return Response.json(body);
}
