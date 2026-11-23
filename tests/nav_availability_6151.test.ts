// @vitest-environment node
/**
 * #6151 S1 — the nav-availability endpoint (GET /api/platform/nav-availability).
 *
 * The first production consumer of the one shared context resolution
 * (resolvePlatformContext, PR #6220): the endpoint resolves the caller's
 * platform context once per session and returns the effective nav
 * availability, computed server-side — visibleTabs (top-level ids AND
 * `<parentId>:<subId>` sub-item keys), availablePresets (built-in keys),
 * personaDefault, persona, tier.
 *
 * Rules pinned here:
 * - Unauthenticated → 401; a legacy session (no internalUserId) → 403;
 *   unbound commercial/subscription stores → 503 (fail-closed, never a
 *   partial availability).
 * - The tier fact flows through unchanged: the endpoint never re-derives
 *   tier — it returns the tier the resolution produced. A direct
 *   per-concern call in the endpoint fails the existing census pin
 *   (tests/platform_context_census_6151.test.ts), so this file pins the
 *   passthrough by value instead.
 * - Persona is classified server-side from the resolved tenant +
 *   memberships (platform-admin via holdsPlatformAdmin, tenant-admin
 *   via a live tenant-scope binding, else paid/non-paid by tier).
 *   Admin personas see the entire menu; non-paid sees the non-paid
 *   default. S1's four persona defaults are all alltabs-equivalent.
 *   S2 narrows below: a nav id named in the product→menu mapping
 *   stays visible only while the caller holds an active subscription
 *   for a product that enables it (admin personas bypass the
 *   narrowing — they see the entire menu).
 * - visibleTabs covers EXACTLY the ids enumerateNavAvailabilityIds()
 *   yields — one enumeration, shared by client and server, so the two
 *   can never drift.
 * - availablePresets is the built-in key list, pinned equal to
 *   Object.keys(NAV_TAB_PRESETS) — the client owns the preset maps;
 *   the server mirrors only the keys, with this test as the drift guard.
 * - Invalidate-then-reresolve: after the entitlement changes and the
 *   principal's sessions are invalidated, the next resolution returns
 *   fresh values (the webhook/grant wiring calls the same helper this
 *   test exercises).
 *
 * Harness mirrors the established route-test idiom: a Map-backed DO
 * namespace stub (cf. tests/account_binding_chat_5111.test.ts, plus a
 * `list` op for the session listing), the KV membership store over it,
 * and the in-memory commercial/subscription adapters passed as deps.
 * The resolver caches facts per session, so every test mints its own
 * session — a shared session would leak one test's cached facts into
 * the next test's counts.
 */
import { describe, expect, it } from "vitest";
import {
  activeSubscriptionProductIds,
  applyProductMenuGating,
  handleNavRoutes,
} from "../src/server/routes/nav";
import {
  normalizeProductMenuMapping,
  type ProductMenuMappingEntry,
} from "../src/client/navConfig";
import { expandPresetKey } from "../src/client/navPresets";
import {
  invalidatePlatformContextForLogin,
  invalidatePlatformContextForPrincipal,
} from "../src/security/platformContextInvalidate";
import { enumerateNavAvailabilityIds } from "../src/client/navConfig";
import { NAV_TAB_PRESETS } from "../src/client/navPresets";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { createMembership, type MembershipStore } from "../src/security/authorization";
import { sessionStore, createSession } from "../src/security/session";
import type { Env } from "../src/types";

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as {
        op: string;
        key: string;
        value?: string;
      };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      if (payload.op === "list") {
        const entries = [...store.entries()]
          .filter(([k]) => k.startsWith(payload.key ?? ""))
          .map(([key, value]) => ({ key, value }));
        return Response.json({ ok: true, entries });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

interface World {
  env: Env;
  memberships: MembershipStore;
  commercial: InMemoryCommercialAdapter;
  subscriptions: InMemorySubscriptionAdapter;
}

function makeWorld(): World {
  const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
  return {
    env,
    memberships: createKvMembershipStore(sessionStore(env)),
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
  };
}

async function seedMember(
  world: World,
  overrides: {
    login?: string;
    internalUserId?: string;
    tenantId?: string;
    role?: string;
    scope?: string;
  } = {},
): Promise<void> {
  const result = await createMembership(world.memberships, {
    internalUserId: overrides.internalUserId ?? "user-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    roleBindings: [
      {
        role: (overrides.role ?? "member") as never,
        scope: (overrides.scope ?? "tenant") as never,
        grantedBy: "seed",
      },
    ],
    createdBy: "seed",
    nowMs: Date.now(),
  });
  if (!result.ok) throw new Error(result.error);
}

async function seedAccount(
  world: World,
  overrides: { login?: string; tier?: string; tierSource?: string } = {},
): Promise<void> {
  await world.commercial.upsertAccount({
    userId: overrides.login ?? "user-1",
    tenantId: "tenant-a",
    tier: overrides.tier ?? "Free",
    tierSource: overrides.tierSource ?? "operator",
  });
}

async function seedPlan(
  world: World,
  overrides: { planId?: string; productId?: string; name?: string } = {},
): Promise<void> {
  await world.subscriptions.createPlan({
    id: overrides.planId ?? "plan-pro",
    name: overrides.name ?? "Premium",
    priceUSD: 29,
    periodDays: 30,
    includedRuns: 0,
    productId: overrides.productId ?? "prod-sub-premium",
  });
}

async function seedSubscription(
  world: World,
  overrides: { login?: string; planId?: string; periodEndMs?: number } = {},
): Promise<void> {
  const nowMs = Date.now();
  await world.subscriptions.createSubscription({
    id: `sub-${Math.random().toString(36).slice(2, 8)}`,
    userId: overrides.login ?? "user-1",
    tenantId: "tenant-a",
    planId: overrides.planId ?? "plan-pro",
    provider: "stripe",
    providerPaymentRef: `pay-${Math.random().toString(36).slice(2, 8)}`,
    periodStartMs: nowMs - 86_400_000,
    periodEndMs: overrides.periodEndMs ?? nowMs + 30 * 86_400_000,
  });
}

async function mintSession(
  world: World,
  overrides: { login?: string; internalUserId?: string | null } = {},
): Promise<string> {
  const nowMs = Date.now();
  return createSession(world.env, {
    githubLogin: overrides.login ?? "user-1",
    githubAvatar: "",
    githubName: "User One",
    createdAt: nowMs,
    firstCreatedAt: nowMs,
    ...(overrides.internalUserId === null
      ? {}
      : { internalUserId: overrides.internalUserId ?? "user-1" }),
  });
}

function navRequest(sessionId?: string): Request {
  return new Request("https://agent.test/api/platform/nav-availability", {
    method: "GET",
    ...(sessionId
      ? { headers: { Cookie: `session_id=${sessionId}` } }
      : {}),
  });
}

async function callNav(
  world: World,
  sessionId?: string,
  productMenuMapping?: ProductMenuMappingEntry[],
) {
  return handleNavRoutes(
    navRequest(sessionId),
    world.env,
    new URL("https://agent.test/api/platform/nav-availability"),
    "/api/platform/nav-availability",
    {
      commercial: world.commercial,
      subscriptions: world.subscriptions,
      ...(productMenuMapping !== undefined ? { productMenuMapping } : {}),
    },
  );
}

describe("GET /api/platform/nav-availability (#6151 S1)", () => {
  it("returns null for a non-nav path", async () => {
    const world = makeWorld();
    const res = await handleNavRoutes(
      new Request("https://agent.test/api/me"),
      world.env,
      new URL("https://agent.test/api/me"),
      "/api/me",
    );
    expect(res).toBeNull();
  });

  it("returns 401 without a session", async () => {
    const world = makeWorld();
    const res = await callNav(world);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toMatchObject({ ok: false });
  });

  it("returns 403 for a legacy session with no internalUserId", async () => {
    const world = makeWorld();
    await seedAccount(world);
    const sessionId = await mintSession(world, { internalUserId: null });
    const res = await callNav(world, sessionId);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ ok: false });
  });

  it("returns 503 when the commercial/subscription stores are unbound", async () => {
    const world = makeWorld();
    await seedMember(world);
    const sessionId = await mintSession(world);
    const res = await handleNavRoutes(
      navRequest(sessionId),
      world.env,
      new URL("https://agent.test/api/platform/nav-availability"),
      "/api/platform/nav-availability",
    );
    expect(res?.status).toBe(503);
    expect(await res?.json()).toMatchObject({ ok: false });
  });

  it("returns the non-paid default for a Free member, tier flowing through", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.persona).toBe("non-paid");
    expect(body.personaDefault).toBe("alltabs");
    expect(body.tier).toBe("Free");
    expect(body.availablePresets).toEqual(Object.keys(NAV_TAB_PRESETS));
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    const ids = enumerateNavAvailabilityIds();
    expect(Object.keys(visibleTabs).sort()).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThan(0);
    expect(Object.values(visibleTabs).every((v) => v === true)).toBe(true);
  });

  it("returns the paid default for a Subscribed member, tier flowing through", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Subscribed", tierSource: "subscription" });
    await seedSubscription(world);
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("paid");
    expect(body.personaDefault).toBe("alltabs");
    expect(body.tier).toBe("Subscribed");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(Object.values(visibleTabs).every((v) => v === true)).toBe(true);
  });

  it("a Free account with only an expired subscription resolves tier Free", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Subscribed", tierSource: "subscription" });
    await seedSubscription(world, { periodEndMs: Date.now() - 1_000 });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.tier).toBe("Free");
    expect(body.persona).toBe("non-paid");
  });

  it("a tenant-admin sees the entire menu", async () => {
    const world = makeWorld();
    await seedMember(world, { role: "tenant-admin" });
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("tenant-admin");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(Object.values(visibleTabs).every((v) => v === true)).toBe(true);
  });

  it("a platform-admin (platform-scope binding + tenant membership) sees the entire menu", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedMember(world, {
      tenantId: "tenant-a",
      role: "platform-admin",
      scope: "platform",
    });
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("platform-admin");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(Object.values(visibleTabs).every((v) => v === true)).toBe(true);
  });

  it("visibleTabs carries sub-item keys in <parentId>:<subId> form", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId);
    const body = (await res?.json()) as Record<string, unknown>;
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    const subKeys = Object.keys(visibleTabs).filter((k) => k.includes(":"));
    expect(subKeys.length).toBeGreaterThan(0);
    expect(subKeys).toContain("data-hub:data-providers");
    expect(subKeys).toContain("platform-admin:ads");
    for (const key of subKeys) {
      expect(key.split(":")).toHaveLength(2);
    }
  });

  it("invalidate on entitlement change clears the session cache (re-resolution returns fresh values)", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Subscribed", tierSource: "subscription" });
    await seedSubscription(world);
    const sessionId = await mintSession(world);
    const first = (await (await callNav(world, sessionId))?.json()) as Record<string, unknown>;
    expect(first.tier).toBe("Subscribed");
    expect(first.persona).toBe("paid");

    // The entitlement lapses (subscription expired) — but the session
    // facts are cached, so the next resolution still sees Subscribed.
    const rows = await world.subscriptions.listSubscriptions("user-1");
    expect(rows).toHaveLength(1);
    await world.subscriptions.updateProviderBilling(rows[0].id, {
      status: "canceled",
      periodEndMs: Date.now() - 1_000,
    });
    const stale = (await (await callNav(world, sessionId))?.json()) as Record<string, unknown>;
    expect(stale.tier).toBe("Subscribed");

    // The webhook/grant wiring invalidates the principal's sessions;
    // the next resolution returns the fresh values.
    const dropped = await invalidatePlatformContextForLogin(
      world.env,
      "user-1",
      "subscription-change",
    );
    expect(dropped).toBeGreaterThanOrEqual(1);
    const fresh = (await (await callNav(world, sessionId))?.json()) as Record<string, unknown>;
    expect(fresh.tier).toBe("Free");
    expect(fresh.persona).toBe("non-paid");
  });

  it("invalidate by internalUserId drops the same session cache", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Subscribed", tierSource: "subscription" });
    await seedSubscription(world);
    const sessionId = await mintSession(world);
    const first = (await (await callNav(world, sessionId))?.json()) as Record<string, unknown>;
    expect(first.tier).toBe("Subscribed");
    const rows = await world.subscriptions.listSubscriptions("user-1");
    await world.subscriptions.updateProviderBilling(rows[0].id, {
      status: "canceled",
      periodEndMs: Date.now() - 1_000,
    });
    const dropped = await invalidatePlatformContextForPrincipal(
      world.env,
      "user-1",
      "role-change",
    );
    expect(dropped).toBeGreaterThanOrEqual(1);
    const fresh = (await (await callNav(world, sessionId))?.json()) as Record<string, unknown>;
    expect(fresh.tier).toBe("Free");
  });
});

/**
 * #6151 S2 — subscription-driven menus (part 3).
 *
 * Rules pinned here:
 * - A nav id named in the product→menu mapping stays visible only
 *   while the caller holds an ACTIVE subscription for a product
 *   that enables it (tier Subscribed + unexpired row — the same
 *   periodEndMs > nowMs rule resolveEffectiveTier uses). The tier
 *   fact itself is never re-derived: the endpoint returns the tier
 *   the resolution produced, and this file pins the passthrough by
 *   value alongside the gating.
 * - Cancel keeps access to periodEnd (periodEndMs untouched by
 *   cancel); refund revokes immediately (revokeSubscription moves
 *   periodEndMs to nowMs). Status is deliberately ignored by the
 *   active-row rule — a canceled-but-unexpired row still enables.
 * - A product with no mapping entry enables nothing; an active
 *   subscription for an unmapped product does not enable another
 *   product's menus.
 * - Admin personas bypass the narrowing — they see the entire menu
 *   with or without a subscription.
 * - The shipped config mapping is empty (products are operator
 *   data; no subscription-product id is fixed in code), so these
 *   tests inject the mapping through the route deps — the same
 *   seam production uses for the stores.
 */
describe("GET /api/platform/nav-availability — subscription gating (#6151 S2)", () => {
  const MAPPING: ProductMenuMappingEntry[] = [
    {
      productId: "prod-sub-premium",
      navIds: ["options-screener", "options-screener:discovery", "stock-hub"],
    },
    { productId: "prod-sub-basic", navIds: ["autopilot"] },
  ];

  async function paidWorldWithPremium(): Promise<{
    world: World;
    sessionId: string;
  }> {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Subscribed", tierSource: "subscription" });
    await seedPlan(world);
    await seedSubscription(world);
    const sessionId = await mintSession(world);
    return { world, sessionId };
  }

  it("subscribing enables the product's menus", async () => {
    const { world, sessionId } = await paidWorldWithPremium();
    const res = await callNav(world, sessionId, MAPPING);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("paid");
    expect(body.tier).toBe("Subscribed");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(true);
    expect(visibleTabs["options-screener:discovery"]).toBe(true);
    expect(visibleTabs["stock-hub"]).toBe(true);
    // Basic is not held: its menu stays gated off.
    expect(visibleTabs["autopilot"]).toBe(false);
    // Unmapped ids pass through from the persona default.
    expect(visibleTabs["order"]).toBe(true);
    expect(visibleTabs["chat"]).toBe(true);
  });

  it("unsubscribing disables the mapped menus", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Free" });
    await seedPlan(world);
    await seedSubscription(world, { periodEndMs: Date.now() - 1_000 });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId, MAPPING);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("non-paid");
    expect(body.tier).toBe("Free");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(false);
    expect(visibleTabs["options-screener:discovery"]).toBe(false);
    expect(visibleTabs["stock-hub"]).toBe(false);
    expect(visibleTabs["autopilot"]).toBe(false);
    expect(visibleTabs["order"]).toBe(true);
  });

  it("cancel keeps access to periodEnd", async () => {
    const { world, sessionId } = await paidWorldWithPremium();
    const rows = await world.subscriptions.listSubscriptions("user-1");
    expect(rows).toHaveLength(1);
    await world.subscriptions.cancelSubscription(rows[0].id, Date.now());
    const res = await callNav(world, sessionId, MAPPING);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.tier).toBe("Subscribed");
    expect(body.persona).toBe("paid");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(true);
    expect(visibleTabs["stock-hub"]).toBe(true);
  });

  it("refund revokes immediately", async () => {
    const { world, sessionId } = await paidWorldWithPremium();
    const first = (await (await callNav(world, sessionId, MAPPING))?.json()) as Record<
      string,
      unknown
    >;
    expect(
      (first.visibleTabs as Record<string, boolean>)["options-screener"],
    ).toBe(true);
    const rows = await world.subscriptions.listSubscriptions("user-1");
    await world.subscriptions.revokeSubscription(rows[0].id, Date.now());
    const dropped = await invalidatePlatformContextForLogin(
      world.env,
      "user-1",
      "subscription-change",
    );
    expect(dropped).toBeGreaterThanOrEqual(1);
    const res = await callNav(world, sessionId, MAPPING);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.tier).toBe("Free");
    expect(body.persona).toBe("non-paid");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(false);
    expect(visibleTabs["stock-hub"]).toBe(false);
    expect(visibleTabs["order"]).toBe(true);
  });

  it("a product with no mapping entry enables nothing", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Subscribed", tierSource: "subscription" });
    await seedPlan(world, {
      planId: "plan-other",
      productId: "prod-sub-unmapped",
      name: "Unmapped",
    });
    await seedSubscription(world, { planId: "plan-other" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId, MAPPING);
    const body = (await res?.json()) as Record<string, unknown>;
    // The row is unexpired, so the tier is Subscribed — but the
    // product has no mapping entry, so no mapped menu opens.
    expect(body.tier).toBe("Subscribed");
    expect(body.persona).toBe("paid");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(false);
    expect(visibleTabs["stock-hub"]).toBe(false);
    expect(visibleTabs["autopilot"]).toBe(false);
    expect(visibleTabs["order"]).toBe(true);
  });

  it("a tenant-admin with no subscription sees the mapped menus", async () => {
    const world = makeWorld();
    await seedMember(world, { role: "tenant-admin" });
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId, MAPPING);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("tenant-admin");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(true);
    expect(visibleTabs["stock-hub"]).toBe(true);
    expect(visibleTabs["autopilot"]).toBe(true);
  });

  it("a platform-admin with no subscription sees the mapped menus", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedMember(world, {
      tenantId: "tenant-a",
      role: "platform-admin",
      scope: "platform",
    });
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId, MAPPING);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("platform-admin");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(true);
    expect(visibleTabs["autopilot"]).toBe(true);
  });

  it("a Free user with no subscription sees no mapped menu", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await callNav(world, sessionId, MAPPING);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.persona).toBe("non-paid");
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(false);
    expect(visibleTabs["stock-hub"]).toBe(false);
    expect(visibleTabs["autopilot"]).toBe(false);
    expect(visibleTabs["order"]).toBe(true);
  });
});

describe("expandPresetKey + gating helpers (#6151 S2)", () => {
  it("expands any preset key, sub-items following their parent", () => {
    const research = expandPresetKey("research");
    // Intelligence section only: options + stock hub visible…
    expect(research["options-screener"]).toBe(true);
    expect(research["options-screener:discovery"]).toBe(true);
    expect(research["stock-hub"]).toBe(true);
    // …Execution / Billing / Marketing / Platform hidden, sub-items too.
    expect(research["order"]).toBe(false);
    expect(research["billing"]).toBe(false);
    expect(research["billing:overview"]).toBe(false);
    expect(research["marketing-hub"]).toBe(false);
    const all = expandPresetKey("alltabs");
    expect(Object.values(all).every((v) => v === true)).toBe(true);
    const none = expandPresetKey("none");
    expect(Object.values(none).every((v) => v === false)).toBe(true);
    // An unknown key falls back to alltabs (permissive, never a gate).
    expect(expandPresetKey("no-such-preset")).toEqual(all);
    // The expansion covers exactly the enumerated availability ids.
    expect(Object.keys(all).sort()).toEqual(
      [...enumerateNavAvailabilityIds()].sort(),
    );
  });

  it("activeSubscriptionProductIds uses the tier rule (periodEndMs), ignoring status", () => {
    const nowMs = 1_800_000_000_000;
    const plansById = new Map([
      ["plan-a", { productId: "prod-sub-premium" }],
      ["plan-b", { productId: "prod-sub-basic" }],
    ]);
    const rows = [
      { planId: "plan-a", periodEndMs: nowMs + 1_000 },
      { planId: "plan-b", periodEndMs: nowMs - 1_000 },
      { planId: "plan-unknown", periodEndMs: nowMs + 1_000 },
    ];
    expect(activeSubscriptionProductIds(rows, plansById, nowMs)).toEqual(
      new Set(["prod-sub-premium"]),
    );
    // A canceled-but-unexpired row still counts (cancel keeps
    // access to periodEnd); a row ending exactly now does not.
    expect(
      activeSubscriptionProductIds(
        [{ planId: "plan-a", periodEndMs: nowMs }],
        plansById,
        nowMs,
      ),
    ).toEqual(new Set());
  });

  it("applyProductMenuGating ORs across products and passes unmapped ids through", () => {
    const base = {
      "options-screener": true,
      "options-screener:discovery": true,
      autopilot: true,
      order: true,
      chat: false,
    };
    const mapping: ProductMenuMappingEntry[] = [
      { productId: "prod-sub-premium", navIds: ["options-screener"] },
      {
        productId: "prod-sub-basic",
        navIds: ["options-screener", "autopilot"],
      },
    ];
    // Only basic held: the doubly-gated id opens (OR), autopilot opens.
    const gated = applyProductMenuGating(
      base,
      mapping,
      new Set(["prod-sub-basic"]),
    );
    expect(gated["options-screener"]).toBe(true);
    expect(gated["autopilot"]).toBe(true);
    expect(gated["order"]).toBe(true);
    expect(gated["chat"]).toBe(false);
    // Nothing held: every mapped id closes; unmapped ids unchanged.
    const closed = applyProductMenuGating(base, mapping, new Set());
    expect(closed["options-screener"]).toBe(false);
    expect(closed["autopilot"]).toBe(false);
    expect(closed["order"]).toBe(true);
    expect(closed["chat"]).toBe(false);
    // A mapped id whose base is false stays false even when held.
    const baseClosed = { ...base, autopilot: false };
    expect(
      applyProductMenuGating(baseClosed, mapping, new Set(["prod-sub-basic"]))
        .autopilot,
    ).toBe(false);
  });

  it("normalizeProductMenuMapping drops unknown ids and empty entries, merges duplicates", () => {
    expect(
      normalizeProductMenuMapping([
        { productId: "prod-sub-premium", navIds: ["options-screener", "no-such-tab"] },
        { productId: "prod-sub-premium", navIds: ["stock-hub"] },
        { productId: "prod-sub-basic", navIds: ["no-such-tab"] },
        { productId: "", navIds: ["order"] },
        { productId: "prod-sub-x", navIds: "order" },
        "junk",
        null,
      ]),
    ).toEqual([
      {
        productId: "prod-sub-premium",
        navIds: ["options-screener", "stock-hub"],
      },
    ]);
    expect(normalizeProductMenuMapping(undefined)).toEqual([]);
    expect(normalizeProductMenuMapping("junk")).toEqual([]);
  });
});
