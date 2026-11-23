/**
 * #6151 S1 — the nav-availability endpoint (GET /api/platform/nav-availability).
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
 * Computation order (S1): tenant allowance (absent until S4 — "no
 * allowance" means the tenant gets everything the platform
 * enables), subscription entitlements (the context's `tier` fact —
 * never re-derived; a direct per-concern call here fails the
 * existing census pin), per-user allow-list (absent until S4 — same
 * "no allow-list means no narrowing" rule), persona default (S1's
 * config in nav-config.json). S1's four persona defaults are all
 * alltabs-equivalent, so the endpoint returns the entire menu for
 * every persona and the change is behavior-preserving on day one;
 * the narrowing lands in S2 (subscription mapping) and S4
 * (allow-lists).
 *
 * Expansion note: S1 expands only the `alltabs` default (every
 * enumerated id → true). A non-alltabs configured default falls
 * back to the full map with a warn log — availability is a UX
 * narrowing, never an authorization gate (the PDP decision is the
 * boundary), so the permissive fallback keeps the surface working.
 * S2 moves the preset maps into shared data and expands any key.
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
  enumerateNavAvailabilityIds,
  personaDefaultPresetKey,
  type NavPersona,
} from "../../client/navConfig";
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
}

const NAV_AVAILABILITY_PATH = "/api/platform/nav-availability";

/**
 * Expand a persona-default preset key into the full availability
 * map. S1: only `alltabs` is configured, so every enumerated id
 * maps to true. See the module header for the non-alltabs fallback.
 */
export function expandPersonaDefault(personaDefault: string): Record<string, boolean> {
  // S1: only `alltabs` is configured, so every enumerated id maps
  // to true. A non-alltabs key falls back to the full map (the
  // handler logs it) — availability is a UX narrowing, never an
  // authorization gate, so the permissive fallback keeps the surface
  // working. S2 moves the preset maps into shared data and expands
  // any key.
  return Object.fromEntries(
    enumerateNavAvailabilityIds().map((id) => [id, true]),
  );
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
  if (personaDefault !== "alltabs") {
    const structuredLog = createStructuredLogger(createObservabilitySink(env), {
      component: "server/routes/nav",
    });
    structuredLog.warn("nav.persona_default_unexpanded", {
      message: `[nav-availability] persona default "${personaDefault}" has no server-side expansion yet (S2 generalizes it); serving the full map`,
      personaDefault,
      persona,
    });
  }
  const body: NavAvailabilityResponse = {
    ok: true,
    visibleTabs: expandPersonaDefault(personaDefault),
    availablePresets: builtinPresetKeys(),
    personaDefault,
    persona,
    tier,
  };
  return Response.json(body);
}
