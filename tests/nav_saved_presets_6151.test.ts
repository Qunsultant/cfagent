// @vitest-environment node
/**
 * #6151 S3 — saved named presets, server-side.
 *
 * Migration 0085 (`agent_nav_presets` + `agent_nav_preset_state`)
 * behind the store port (`src/data/navPresetPorts.ts`, D1 +
 * in-memory adapters), CRUD routes under
 * `/api/platform/nav-presets`, and the nav-availability endpoint
 * reading the stored selection as its base.
 *
 * Rules pinned here:
 * - Save: 201 with a normalized map; a duplicate name for the same
 *   user is a 409 (FAILURE_NAV_PRESET_CONFLICT); an empty/overlong
 *   name or a missing map is a 400; an unbound store is a 503 on
 *   mutations but the LIST degrades to empty (a read never breaks
 *   the nav).
 * - Names are unique PER USER — the same name under another user
 *   saves fine.
 * - normalizePresetMap: a sub-item key follows its parent unless
 *   explicitly named (unnamed under a visible parent reads true,
 *   unnamed under a hidden parent reads false; an explicit value
 *   wins); unknown keys and non-boolean values are dropped; the
 *   result covers exactly the availability ids.
 * - Apply: the response's visibleTabs is the preset map FILTERED
 *   by the subscription gating — a saved preset never resurrects
 *   a tab the caller's subscription gating removes — and the next
 *   nav-availability call returns the same filtered map (filtering
 *   is at READ time: unsubscribing after the apply hides the tab
 *   without any re-apply).
 * - Selection: a manual-toggle write persists the custom map
 *   (activePresetId null) and the nav-availability base follows
 *   it, gated the same way.
 * - Delete the ACTIVE preset: the nav-availability map is
 *   unchanged (the selection keeps the deleted preset's map as a
 *   custom selection) and the list's activePresetId clears.
 * - Rename to an existing name is a 409; rename/apply/delete of a
 *   missing id is a 404; unauthenticated is a 401 on every route.
 * - availablePresets on nav-availability is the built-in keys plus
 *   the caller's saved-preset ids; with an unbound preset store
 *   it is the built-in keys only (the S1 pin still holds).
 * - Migration 0085 is registered (version 85, name, DDL in the
 *   catalogue + D1_MIGRATION_CODES[85]), the drizzle tables exist,
 *   and the D1 adapter round-trips through MockD1Database.
 *
 * Harness mirrors the S1 file (Map-backed DO stub, KV membership
 * store, in-memory commercial/subscription adapters) plus the
 * in-memory preset adapter passed as a dep. The resolver caches
 * facts per session, so every test mints its own session.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleNavRoutes } from "../src/server/routes/nav";
import { type ProductMenuMappingEntry } from "../src/client/navConfig";
import { expandPresetKey } from "../src/client/navPresets";
import { enumerateNavAvailabilityIds } from "../src/client/navConfig";
import { NAV_TAB_PRESETS } from "../src/client/navPresets";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryNavPresetAdapter } from "../src/data/inMemoryNavPresetAdapter";
import {
  createD1NavPresetDb,
  D1NavPresetAdapter,
  ensureNavPresetSchema,
} from "../src/data/d1NavPresetAdapter";
import {
  assertPresetName,
  isPresetMapInput,
  normalizePresetMap,
} from "../src/data/navPresetPorts";
import {
  ALL_MIGRATIONS,
  MIGRATION_0085_NAV_PRESETS,
} from "../src/data/migrationRunner";
import { D1_MIGRATION_CODES } from "../src/data/schemaComponent/d1Catalogue";
import {
  agentNavPresets,
  agentNavPresetState,
} from "../src/data/drizzleSchema";
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
  presets: InMemoryNavPresetAdapter;
}

function makeWorld(): World {
  const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
  return {
    env,
    memberships: createKvMembershipStore(sessionStore(env)),
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    presets: new InMemoryNavPresetAdapter(),
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

function presetRequest(
  path: string,
  sessionId: string | undefined,
  method: string,
  body?: unknown,
): Request {
  return new Request(`https://agent.test${path}`, {
    method,
    ...(sessionId ? { headers: { Cookie: `session_id=${sessionId}` } } : {}),
    ...(body !== undefined
      ? {
          headers: {
            "Content-Type": "application/json",
            ...(sessionId ? { Cookie: `session_id=${sessionId}` } : {}),
          },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

async function callPresets(
  world: World,
  path: string,
  sessionId: string | undefined,
  method: string,
  body?: unknown,
  deps?: { presets?: InMemoryNavPresetAdapter | null; productMenuMapping?: ProductMenuMappingEntry[] },
) {
  return handleNavRoutes(
    presetRequest(path, sessionId, method, body),
    world.env,
    new URL(`https://agent.test${path}`),
    path,
    {
      commercial: world.commercial,
      subscriptions: world.subscriptions,
      presets: deps?.presets !== undefined ? deps.presets : world.presets,
      ...(deps?.productMenuMapping !== undefined
        ? { productMenuMapping: deps.productMenuMapping }
        : {}),
    },
  );
}

async function callNav(
  world: World,
  sessionId: string,
  productMenuMapping?: ProductMenuMappingEntry[],
) {
  return handleNavRoutes(
    new Request("https://agent.test/api/platform/nav-availability", {
      method: "GET",
      headers: { Cookie: `session_id=${sessionId}` },
    }),
    world.env,
    new URL("https://agent.test/api/platform/nav-availability"),
    "/api/platform/nav-availability",
    {
      commercial: world.commercial,
      subscriptions: world.subscriptions,
      presets: world.presets,
      ...(productMenuMapping !== undefined ? { productMenuMapping } : {}),
    },
  );
}

/** A full-visibility map with one id flipped — the saved-preset base for the tests. */
function mapWith(id: string, value: boolean): Record<string, boolean> {
  const map = expandPresetKey("alltabs");
  map[id] = value;
  return map;
}

describe("normalizePresetMap + name rules (#6151 S3)", () => {
  it("a sub-item follows its parent unless explicitly named", () => {
    // Explicitly named wins: a sub-item named true stays true even
    // under a hidden parent (the stored map is the user's words;
    // the UI hides sub-items under a hidden parent regardless).
    const explicit = normalizePresetMap({
      "options-screener": false,
      "options-screener:discovery": true,
      "stock-hub": true,
    });
    expect(explicit["options-screener"]).toBe(false);
    expect(explicit["options-screener:discovery"]).toBe(true);
    expect(explicit["stock-hub"]).toBe(true);
    // Unnamed follows the parent either way.
    const follows = normalizePresetMap({
      "options-screener": true,
      "stock-hub": false,
    });
    expect(follows["options-screener:discovery"]).toBe(true);
    const followsHidden = normalizePresetMap({ "options-screener": false });
    expect(followsHidden["options-screener:discovery"]).toBe(false);
  });

  it("an explicit sub-item false stays false under a visible parent", () => {
    const map = normalizePresetMap({
      "options-screener": true,
      "options-screener:discovery": false,
    });
    expect(map["options-screener"]).toBe(true);
    expect(map["options-screener:discovery"]).toBe(false);
  });

  it("drops unknown keys and non-boolean values, and covers exactly the availability ids", () => {
    const map = normalizePresetMap({
      "options-screener": true,
      "no-such-tab": true,
      "stock-hub": "yes" as unknown as boolean,
    });
    expect(Object.keys(map).sort()).toEqual([...enumerateNavAvailabilityIds()].sort());
    expect("no-such-tab" in map).toBe(false);
    expect(map["stock-hub"]).toBe(false);
  });

  it("isPresetMapInput accepts any non-array object (an empty map is the hide-everything selection)", () => {
    expect(isPresetMapInput({ "options-screener": true })).toBe(true);
    expect(isPresetMapInput({})).toBe(true);
    expect(normalizePresetMap({})["options-screener"]).toBe(false);
    expect(isPresetMapInput(null)).toBe(false);
    expect(isPresetMapInput("alltabs")).toBe(false);
    expect(isPresetMapInput([{ "options-screener": true }])).toBe(false);
  });

  it("assertPresetName trims, and rejects empty / overlong names", () => {
    expect(assertPresetName("  Morning  ")).toBe("Morning");
    expect(() => assertPresetName("")).toThrow("FAILURE_NAV_PRESET_NAME_INVALID");
    expect(() => assertPresetName("   ")).toThrow("FAILURE_NAV_PRESET_NAME_INVALID");
    expect(() => assertPresetName("x".repeat(81))).toThrow("FAILURE_NAV_PRESET_NAME_INVALID");
    expect(assertPresetName("x".repeat(80))).toBe("x".repeat(80));
  });
});

describe("migration 0085 registration (#6151 S3)", () => {
  it("is registered, versioned 85, and carries both tables' DDL", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0085_NAV_PRESETS);
    expect(MIGRATION_0085_NAV_PRESETS.version).toBe(85);
    expect(MIGRATION_0085_NAV_PRESETS.name).toBe("0085_nav_presets");
    expect(MIGRATION_0085_NAV_PRESETS.sql).toContain(
      "CREATE TABLE IF NOT EXISTS agent_nav_presets",
    );
    expect(MIGRATION_0085_NAV_PRESETS.sql).toContain(
      "CREATE TABLE IF NOT EXISTS agent_nav_preset_state",
    );
    expect(MIGRATION_0085_NAV_PRESETS.sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS agent_nav_presets_user_name_idx",
    );
    expect(D1_MIGRATION_CODES[85]).toEqual([
      "schema.d1.agent_nav_presets.create_table",
      "schema.d1.agent_nav_presets.create_index_agent_nav_presets_user_name_idx",
      "schema.d1.agent_nav_presets.create_index_agent_nav_presets_user_idx",
      "schema.d1.agent_nav_preset_state.create_table",
    ]);
  });

  it("the drizzle tables exist with the migrated columns", () => {
    expect(Object.keys(agentNavPresets)).toContain("id");
    expect(Object.keys(agentNavPresets)).toContain("userId");
    expect(Object.keys(agentNavPresets)).toContain("name");
    expect(Object.keys(agentNavPresets)).toContain("mapJson");
    expect(Object.keys(agentNavPresetState)).toContain("userId");
    expect(Object.keys(agentNavPresetState)).toContain("activePresetId");
    expect(Object.keys(agentNavPresetState)).toContain("mapJson");
  });
});

describe("saved presets — store round-trip (#6151 S3)", () => {
  it("in-memory: create/list/get/rename/delete + delete-active keeps the map", async () => {
    const store = new InMemoryNavPresetAdapter();
    await store.ensureSchema();
    const created = await store.createPreset("user-1", "Morning", mapWith("stock-hub", false));
    expect(created.id.startsWith("preset-")).toBe(true);
    expect(created.map["stock-hub"]).toBe(false);
    await expect(
      store.createPreset("user-1", "Morning", mapWith("stock-hub", true)),
    ).rejects.toThrow("FAILURE_NAV_PRESET_CONFLICT");
    // The same name under another user is fine — uniqueness is per user.
    await store.createPreset("user-2", "Morning", mapWith("stock-hub", true));
    expect((await store.listPresets("user-1")).map((p) => p.id)).toEqual([created.id]);
    const renamed = await store.renamePreset("user-1", created.id, "Evening");
    expect(renamed.name).toBe("Evening");
    await expect(store.renamePreset("user-1", "preset-nope", "X")).rejects.toThrow(
      "FAILURE_NAV_PRESET_NOT_FOUND",
    );
    await store.setState("user-1", { activePresetId: created.id, map: created.map });
    expect((await store.getState("user-1"))?.activePresetId).toBe(created.id);
    expect(await store.deletePreset("user-1", created.id)).toBe(true);
    expect(await store.deletePreset("user-1", created.id)).toBe(false);
    expect(await store.listPresets("user-1")).toEqual([]);
    const state = await store.getState("user-1");
    expect(state?.activePresetId).toBeNull();
    expect(state?.map?.["stock-hub"]).toBe(false);
  });

  it("D1: ensure + create/list/state round-trip through MockD1Database", async () => {
    const mock = new MockD1Database();
    const db = createD1NavPresetDb(mock as unknown as D1Database);
    const applied = await ensureNavPresetSchema(db);
    expect(applied).toContain(85);
    const store = new D1NavPresetAdapter(db);
    const created = await store.createPreset("user-1", "Morning", mapWith("stock-hub", false));
    expect((await store.listPresets("user-1")).map((p) => p.id)).toEqual([created.id]);
    expect((await store.getPreset("user-1", created.id))?.name).toBe("Morning");
    await expect(
      store.createPreset("user-1", "Morning", mapWith("stock-hub", true)),
    ).rejects.toThrow("FAILURE_NAV_PRESET_CONFLICT");
    await store.setState("user-1", { activePresetId: created.id, map: created.map });
    const state = await store.getState("user-1");
    expect(state?.activePresetId).toBe(created.id);
    expect(state?.map?.["stock-hub"]).toBe(false);
    // ensure is idempotent — a second apply lands nothing new.
    expect(await ensureNavPresetSchema(db)).toEqual([]);
    expect(await store.deletePreset("user-1", created.id)).toBe(true);
    expect((await store.getState("user-1"))?.activePresetId).toBeNull();
  });
});

describe("saved preset routes (#6151 S3)", () => {
  it("401 without a session on every route", async () => {
    const world = makeWorld();
    for (const [path, method] of [
      ["/api/platform/nav-presets", "GET"],
      ["/api/platform/nav-presets", "POST"],
      ["/api/platform/nav-presets/selection", "POST"],
      ["/api/platform/nav-presets/preset-x/apply", "POST"],
      ["/api/platform/nav-presets/preset-x/rename", "POST"],
      ["/api/platform/nav-presets/preset-x", "DELETE"],
    ] as const) {
      const res = await callPresets(world, path, undefined, method, method === "POST" ? { name: "X", map: expandPresetKey("alltabs") } : undefined);
      expect(res?.status).toBe(401);
    }
  });

  it("list degrades to empty when the preset store is unbound; mutations 503", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world);
    const sessionId = await mintSession(world);
    const list = await callPresets(world, "/api/platform/nav-presets", sessionId, "GET", undefined, { presets: null });
    expect(list?.status).toBe(200);
    expect(await list?.json()).toEqual({
      ok: true,
      presets: [],
      activePresetId: null,
      stateMap: null,
    });
    const save = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", { name: "X", map: expandPresetKey("alltabs") }, { presets: null });
    expect(save?.status).toBe(503);
    const apply = await callPresets(world, "/api/platform/nav-presets/preset-x/apply", sessionId, "POST", {}, { presets: null });
    expect(apply?.status).toBe(503);
  });

  it("save → list → availablePresets carries the saved id", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world);
    const sessionId = await mintSession(world);
    const save = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", {
      name: "Morning",
      map: mapWith("stock-hub", false),
    });
    expect(save?.status).toBe(201);
    const saved = (await save?.json()) as { preset: { id: string; name: string; map: Record<string, boolean> } };
    expect(saved.preset.name).toBe("Morning");
    expect(saved.preset.map["stock-hub"]).toBe(false);
    const list = await callPresets(world, "/api/platform/nav-presets", sessionId, "GET");
    const listed = (await list?.json()) as { presets: Array<{ id: string }>; activePresetId: string | null; stateMap: null };
    expect(listed.presets.map((p) => p.id)).toEqual([saved.preset.id]);
    expect(listed.activePresetId).toBeNull();
    const nav = await callNav(world, sessionId);
    const navBody = (await nav?.json()) as { availablePresets: string[] };
    expect(navBody.availablePresets).toEqual([
      ...Object.keys(NAV_TAB_PRESETS),
      saved.preset.id,
    ]);
  });

  it("duplicate name is a 409; empty name / missing map is a 400", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world);
    const sessionId = await mintSession(world);
    const map = expandPresetKey("alltabs");
    const first = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", { name: "Morning", map });
    expect(first?.status).toBe(201);
    const dup = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", { name: " Morning ", map });
    expect(dup?.status).toBe(409);
    expect(await dup?.json()).toMatchObject({ code: "FAILURE_NAV_PRESET_CONFLICT" });
    const empty = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", { name: "   ", map });
    expect(empty?.status).toBe(400);
    const noMap = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", { name: "Other" });
    expect(noMap?.status).toBe(400);
  });

  it("apply sets the nav base; the next availability call returns the preset map", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world);
    const sessionId = await mintSession(world);
    const save = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", {
      name: "Research only",
      map: expandPresetKey("research"),
    });
    const { preset } = (await save?.json()) as { preset: { id: string } };
    const apply = await callPresets(world, `/api/platform/nav-presets/${preset.id}/apply`, sessionId, "POST", {});
    expect(apply?.status).toBe(200);
    const applied = (await apply?.json()) as { visibleTabs: Record<string, boolean> };
    expect(applied.visibleTabs).toEqual(expandPresetKey("research"));
    const nav = await callNav(world, sessionId);
    const navBody = (await nav?.json()) as { visibleTabs: Record<string, boolean> };
    expect(navBody.visibleTabs).toEqual(expandPresetKey("research"));
    const list = await callPresets(world, "/api/platform/nav-presets", sessionId, "GET");
    const listed = (await list?.json()) as { activePresetId: string | null };
    expect(listed.activePresetId).toBe(preset.id);
  });

  it("apply filters by subscription gating, and unsubscribing after apply hides the tab without re-apply", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Subscribed", tierSource: "subscription" });
    await seedPlan(world);
    await seedSubscription(world);
    const sessionId = await mintSession(world);
    const mapping: ProductMenuMappingEntry[] = [
      { productId: "prod-sub-premium", navIds: ["options-screener", "options-screener:discovery"] },
    ];
    const save = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", {
      name: "Everything",
      map: expandPresetKey("alltabs"),
    });
    const { preset } = (await save?.json()) as { preset: { id: string } };
    const apply = await callPresets(world, `/api/platform/nav-presets/${preset.id}/apply`, sessionId, "POST", {}, { productMenuMapping: mapping });
    const applied = (await apply?.json()) as { visibleTabs: Record<string, boolean> };
    expect(applied.visibleTabs["options-screener"]).toBe(true);
    expect(applied.visibleTabs["options-screener:discovery"]).toBe(true);
    // The subscription is revoked (refund semantics: periodEndMs
    // moves to nowMs) — the next availability read hides the mapped
    // tabs with no re-apply.
    const rows = await world.subscriptions.listSubscriptions("user-1");
    expect(rows.length).toBe(1);
    await world.subscriptions.revokeSubscription(rows[0].id, Date.now());
    const sessionId2 = await mintSession(world);
    const nav = await callNav(world, sessionId2, mapping);
    const navBody = (await nav?.json()) as { visibleTabs: Record<string, boolean> };
    expect(navBody.visibleTabs["options-screener"]).toBe(false);
    expect(navBody.visibleTabs["options-screener:discovery"]).toBe(false);
    expect(navBody.visibleTabs["stock-hub"]).toBe(true);
  });

  it("a selection write persists the custom map (gated) as the nav base", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world);
    const sessionId = await mintSession(world);
    const mapping: ProductMenuMappingEntry[] = [
      { productId: "prod-sub-premium", navIds: ["autopilot"] },
    ];
    const write = await callPresets(
      world,
      "/api/platform/nav-presets/selection",
      sessionId,
      "POST",
      { map: expandPresetKey("alltabs") },
      { productMenuMapping: mapping },
    );
    expect(write?.status).toBe(200);
    const written = (await write?.json()) as { visibleTabs: Record<string, boolean> };
    // No subscription for the mapped product: the gated tab hides.
    expect(written.visibleTabs["autopilot"]).toBe(false);
    expect(written.visibleTabs["stock-hub"]).toBe(true);
    const nav = await callNav(world, sessionId, mapping);
    const navBody = (await nav?.json()) as { visibleTabs: Record<string, boolean> };
    expect(navBody.visibleTabs["autopilot"]).toBe(false);
    const list = await callPresets(world, "/api/platform/nav-presets", sessionId, "GET");
    const listed = (await list?.json()) as {
      activePresetId: string | null;
      stateMap: Record<string, boolean> | null;
    };
    expect(listed.activePresetId).toBeNull();
    expect(listed.stateMap?.["autopilot"]).toBe(true);
  });

  it("rename / rename-conflict / rename-missing / apply-missing / delete-missing", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world);
    const sessionId = await mintSession(world);
    const map = expandPresetKey("alltabs");
    const first = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", { name: "One", map });
    const second = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", { name: "Two", map });
    const one = ((await first?.json()) as { preset: { id: string } }).preset;
    const two = ((await second?.json()) as { preset: { id: string } }).preset;
    const renamed = await callPresets(world, `/api/platform/nav-presets/${one.id}/rename`, sessionId, "POST", { name: "Uno" });
    expect(renamed?.status).toBe(200);
    expect(((await renamed?.json()) as { preset: { name: string } }).preset.name).toBe("Uno");
    const clash = await callPresets(world, `/api/platform/nav-presets/${one.id}/rename`, sessionId, "POST", { name: "Two" });
    expect(clash?.status).toBe(409);
    const missingRename = await callPresets(world, "/api/platform/nav-presets/preset-nope/rename", sessionId, "POST", { name: "X" });
    expect(missingRename?.status).toBe(404);
    const missingApply = await callPresets(world, "/api/platform/nav-presets/preset-nope/apply", sessionId, "POST", {});
    expect(missingApply?.status).toBe(404);
    const missingDelete = await callPresets(world, "/api/platform/nav-presets/preset-nope", sessionId, "DELETE");
    expect(missingDelete?.status).toBe(404);
    const deleted = await callPresets(world, `/api/platform/nav-presets/${two.id}`, sessionId, "DELETE");
    expect(deleted?.status).toBe(200);
  });

  it("deleting the ACTIVE preset keeps the current tabs (custom selection)", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world);
    const sessionId = await mintSession(world);
    const save = await callPresets(world, "/api/platform/nav-presets", sessionId, "POST", {
      name: "Research only",
      map: expandPresetKey("research"),
    });
    const { preset } = (await save?.json()) as { preset: { id: string } };
    await callPresets(world, `/api/platform/nav-presets/${preset.id}/apply`, sessionId, "POST", {});
    const deleted = await callPresets(world, `/api/platform/nav-presets/${preset.id}`, sessionId, "DELETE");
    expect(deleted?.status).toBe(200);
    expect(((await deleted?.json()) as { activePresetId: string | null }).activePresetId).toBeNull();
    const nav = await callNav(world, sessionId);
    const navBody = (await nav?.json()) as { visibleTabs: Record<string, boolean> };
    expect(navBody.visibleTabs).toEqual(expandPresetKey("research"));
    const list = await callPresets(world, "/api/platform/nav-presets", sessionId, "GET");
    const listed = (await list?.json()) as { presets: unknown[]; activePresetId: string | null };
    expect(listed.presets).toEqual([]);
    expect(listed.activePresetId).toBeNull();
  });

  it("with an unbound preset store the availability falls back to the persona default", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    const res = await handleNavRoutes(
      new Request("https://agent.test/api/platform/nav-availability", {
        method: "GET",
        headers: { Cookie: `session_id=${sessionId}` },
      }),
      world.env,
      new URL("https://agent.test/api/platform/nav-availability"),
      "/api/platform/nav-availability",
      { commercial: world.commercial, subscriptions: world.subscriptions, presets: null },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      visibleTabs: Record<string, boolean>;
      availablePresets: string[];
    };
    expect(body.visibleTabs).toEqual(expandPresetKey("alltabs"));
    expect(body.availablePresets).toEqual(Object.keys(NAV_TAB_PRESETS));
  });
});

/** Minimal D1Database stand-in over node:sqlite (the foundation tests' double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as never[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as never[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as never[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as never[]))
              .map((row: Record<string, unknown>) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results: unknown[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}
