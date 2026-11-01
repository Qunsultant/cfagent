/** @vitest-environment jsdom */
/**
 * Issue #1202 (E5 of epic #1116) — tier entitlements (freemium /
 * premium) at the data-provider layer.
 *
 * Pins:
 *  (a) route minTier persistence: seeds are freemium; an upserted
 *      premium tier persists; an upsert that omits the tier preserves
 *      the stored one (the deprovision gap-fill clearing path relies
 *      on this); a route row written before the tier column existed
 *      reads as freemium.
 *  (b) entitlement-aware resolution: resolveRoute with a caller tier
 *      serves freemium routes to everyone and premium routes to
 *      premium callers (primary and gap-fill positions), and refuses
 *      premium routes to freemium callers with a typed
 *      DataProviderTierError carrying the route facts. An omitted
 *      caller tier is exactly the pre-E5 behaviour, and a disabled
 *      primary still fails as DataProviderNotFoundError — an outage
 *      stays distinguishable from an entitlement refusal.
 *  (c) management: the lifecycle configure action accepts
 *      routeTiers for the slots the provider occupies (primary and
 *      gap-fill), persists them, rejects invalid tier values /
 *      unknown capabilities / unoccupied capabilities with nothing
 *      stored, and carries the tier change inside the configure
 *      audit event; the routes module exposes minTier on the GET
 *      route views and rejects an invalid routeTiers configure
 *      with the typed 409.
 *  (d) entry-point enforcement at the options service: with
 *      platform deps wired, a default-tier (freemium)
 *      UnifiedOptionsService is refused by a premium optionsChains
 *      route, while the same service constructed with callerTier
 *      "premium" runs the scan and its captures land linked to the
 *      persisted scan run. (The premium x402 host itself is a named
 *      residual for #1202: its route context exposes no sql/blob
 *      storage handle — see the issue's §15.)
 *  (e) the admin panel renders a Freemium/Premium tier badge per
 *      route row from the served minTier.
 *
 * Fixtures are deterministic (mock SQL storage, stub adapters, the
 * E2 mocked-fetch options harness). No live market data, no network.
 * No secret-shaped literals: token fixtures are plainly synthetic.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import type {
  DataProvider,
  DataProviderCapability,
} from "../src/trading/dataProviders/contract";
import {
  DataProviderRegistry,
  DataProviderNotFoundError,
  DataProviderTierError,
} from "../src/trading/dataProviders/registry";
import {
  bootstrapDataProviders,
  ensureProviderRoutingTable,
  getCapabilityRoute,
  getProviderConfig,
  listCapabilityRoutes,
  listProviderConfigs,
  seedProviderConfigs,
  upsertCapabilityRoute,
  upsertProviderConfig,
} from "../src/trading/dataProviders/providerConfigStore";
import {
  transitionProvider,
  ProviderLifecycleError,
  type ProviderLifecycleAuditEvent,
} from "../src/trading/dataProviders/lifecycle";
import { listCapturesByRun } from "../src/trading/dataProviders/captureStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { InMemoryScanRunStore } from "../src/trading/options/scanRunStore";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import type {
  CapabilityRouteView,
  DataProviderView,
} from "../src/client/dataProvidersApi";
import type { Env } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ACTOR = "admin_trader";

function freshSql(): any {
  return new MockSqlStorage() as any;
}

/** Seed the platform and mark the given providers enabled, the way
 *  the P1/E3 suites arrange servable configs directly at the store. */
function storeWithEnabled(ids: string[]) {
  const sql = freshSql();
  seedProviderConfigs(sql);
  for (const id of ids) {
    const rec = getProviderConfig(sql, id as any)!;
    upsertProviderConfig(sql, {
      ...rec,
      enabled: true,
      lifecycleState: "enabled",
    });
  }
  return sql;
}

function stubProvider(
  id: string,
  capabilities: DataProviderCapability[]
): DataProvider {
  return {
    id,
    name: `${id} (stub)`,
    capabilities,
    isConfigured: () => true,
    getQuote: async () => {
      throw new Error("stub provider: getQuote is not exercised here");
    },
  } as unknown as DataProvider;
}

function registryWithStubs() {
  const registry = new DataProviderRegistry();
  registry.register(stubProvider("etrade", ["quotes", "optionsChains"]));
  registry.register(stubProvider("yahoo", ["quotes"]));
  return registry;
}

function setRouteTier(
  sql: any,
  capability: DataProviderCapability,
  minTier: "freemium" | "premium"
) {
  const route = getCapabilityRoute(sql, capability)!;
  upsertCapabilityRoute(sql, {
    capability,
    primaryProviderId: route.primaryProviderId,
    gapFillProviderId: route.gapFillProviderId,
    minTier,
  });
}

// ---------------------------------------------------------------------------
// (a) Route minTier persistence
// ---------------------------------------------------------------------------

describe("route minTier persistence (issue #1202)", () => {
  it("seeds every capability route at the freemium tier", () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const routes = listCapabilityRoutes(sql);
    expect(routes).toHaveLength(5);
    for (const route of routes) {
      expect(route.minTier).toBe("freemium");
    }
    expect(getCapabilityRoute(sql, "quotes")!.minTier).toBe("freemium");
    expect(getCapabilityRoute(sql, "optionsChains")!.minTier).toBe(
      "freemium"
    );
  });

  it("persists an upserted premium tier; an omitted tier preserves the stored one; an explicit tier overwrites", () => {
    const sql = freshSql();
    seedProviderConfigs(sql);

    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: "yahoo",
      minTier: "premium",
    });
    expect(getCapabilityRoute(sql, "quotes")!.minTier).toBe("premium");

    // The deprovision path clears a gap-fill slot by re-upserting the
    // row WITHOUT a tier — that must not silently reset the tier.
    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: null,
    });
    const afterClear = getCapabilityRoute(sql, "quotes")!;
    expect(afterClear.gapFillProviderId).toBeNull();
    expect(afterClear.minTier).toBe("premium");

    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: "yahoo",
      minTier: "freemium",
    });
    expect(getCapabilityRoute(sql, "quotes")!.minTier).toBe("freemium");
  });

  it("reads a route row written before the tier column existed as freemium", () => {
    const sql = freshSql();
    ensureProviderRoutingTable(sql);
    // The pre-E5 column set — no min_tier value is stored at all.
    sql.exec(
      `INSERT INTO mas_data_provider_routes
         (capability, primary_provider_id, gap_fill_provider_id, updated_at)
       VALUES (?, ?, ?, ?)`,
      "quotes",
      "etrade",
      "yahoo",
      "2026-10-22T00:00:00.000Z"
    );
    const route = getCapabilityRoute(sql, "quotes")!;
    expect(route.primaryProviderId).toBe("etrade");
    expect(route.gapFillProviderId).toBe("yahoo");
    expect(route.minTier).toBe("freemium");
  });
});

// ---------------------------------------------------------------------------
// (b) Entitlement-aware resolution
// ---------------------------------------------------------------------------

describe("tier-aware route resolution (issue #1202)", () => {
  it("serves a freemium route to both caller tiers, primary + gap-fill intact", () => {
    const sql = storeWithEnabled(["etrade", "yahoo", "alpaca"]);
    const registry = registryWithStubs();
    registry.register(stubProvider("alpaca", ["optionsChains"]));
    // Issue #2144: quotes no longer carries a gap-fill, so the tier
    // fixture uses optionsChains (etrade primary, alpaca gap-fill).
    upsertCapabilityRoute(sql, {
      capability: "optionsChains",
      primaryProviderId: "etrade",
      gapFillProviderId: "alpaca",
    });
    const configs = listProviderConfigs(sql);
    const routes = listCapabilityRoutes(sql);

    for (const tier of ["freemium", "premium"] as const) {
      const assignment = registry.resolveRoute("optionsChains", configs, routes, tier);
      expect(assignment.primary.id).toBe("etrade");
      expect(assignment.gapFill?.id).toBe("alpaca");
    }
  });

  it("serves a premium route to a premium caller (primary position)", () => {
    const sql = storeWithEnabled(["etrade", "yahoo"]);
    setRouteTier(sql, "optionsChains", "premium");
    const registry = registryWithStubs();

    const assignment = registry.resolveRoute(
      "optionsChains",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql),
      "premium"
    );
    expect(assignment.primary.id).toBe("etrade");
    expect(assignment.gapFill).toBeUndefined();
  });

  it("refuses a premium route to a freemium caller with a typed tier error carrying the route facts", () => {
    const sql = storeWithEnabled(["etrade", "yahoo"]);
    setRouteTier(sql, "optionsChains", "premium");
    const registry = registryWithStubs();

    let caught: unknown;
    try {
      registry.resolveRoute(
        "optionsChains",
        listProviderConfigs(sql),
        listCapabilityRoutes(sql),
        "freemium"
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataProviderTierError);
    expect(caught).not.toBeInstanceOf(DataProviderNotFoundError);
    const err = caught as DataProviderTierError;
    expect(err.providerId).toBe("etrade");
    expect(err.capability).toBe("optionsChains");
    expect(err.requiredTier).toBe("premium");
    expect(err.callerTier).toBe("freemium");
  });

  it("gates the whole route: a premium route's gap-fill never leaks to a freemium caller, and serves a premium caller whole", () => {
    const sql = storeWithEnabled(["etrade", "yahoo", "alpaca"]);
    const registry = registryWithStubs();
    registry.register(stubProvider("alpaca", ["optionsChains"]));
    // Issue #2144: quotes no longer carries a gap-fill, so the tier
    // fixture uses optionsChains (etrade primary, alpaca gap-fill).
    upsertCapabilityRoute(sql, {
      capability: "optionsChains",
      primaryProviderId: "etrade",
      gapFillProviderId: "alpaca",
    });
    setRouteTier(sql, "optionsChains", "premium");
    const configs = listProviderConfigs(sql);
    const routes = listCapabilityRoutes(sql);

    let caught: unknown;
    try {
      registry.resolveRoute("optionsChains", configs, routes, "freemium");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataProviderTierError);
    expect((caught as DataProviderTierError).providerId).toBe("etrade");
    expect((caught as DataProviderTierError).capability).toBe("optionsChains");

    const assignment = registry.resolveRoute("optionsChains", configs, routes, "premium");
    expect(assignment.primary.id).toBe("etrade");
    expect(assignment.gapFill?.id).toBe("alpaca");
  });

  it("an omitted caller tier keeps the pre-E5 behaviour exactly, even on a premium route", () => {
    const sql = storeWithEnabled(["etrade", "yahoo"]);
    setRouteTier(sql, "optionsChains", "premium");
    const registry = registryWithStubs();

    const assignment = registry.resolveRoute(
      "optionsChains",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql)
    );
    expect(assignment.primary.id).toBe("etrade");
  });

  it("a non-servable primary still fails as not-found, not as a tier refusal, whatever the caller tier", () => {
    const sql = storeWithEnabled(["etrade", "yahoo"]);
    setRouteTier(sql, "optionsChains", "premium");
    const rec = getProviderConfig(sql, "etrade")!;
    upsertProviderConfig(sql, {
      ...rec,
      enabled: false,
      lifecycleState: "disabled",
    });
    const registry = registryWithStubs();
    const configs = listProviderConfigs(sql);
    const routes = listCapabilityRoutes(sql);

    for (const tier of ["freemium", "premium"] as const) {
      let caught: unknown;
      try {
        registry.resolveRoute("optionsChains", configs, routes, tier);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DataProviderNotFoundError);
      expect(caught).not.toBeInstanceOf(DataProviderTierError);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Lifecycle configure routeTiers + routes-module views
// ---------------------------------------------------------------------------

function auditCollector() {
  const events: ProviderLifecycleAuditEvent[] = [];
  return {
    events,
    sink: (event: ProviderLifecycleAuditEvent) => {
      events.push(event);
    },
  };
}

describe("configure routeTiers (issue #1202)", () => {
  it("persists a tier for a capability the provider serves as primary, and the audit event carries the tier change", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const { events, sink } = auditCollector();

    const result = await transitionProvider(sql, "etrade", "configure", ACTOR, {
      audit: sink,
      configure: { routeTiers: { quotes: "premium" } },
    });
    expect(result.lifecycleState).toBe("configured");
    expect(getCapabilityRoute(sql, "quotes")!.minTier).toBe("premium");
    // Routes the call did not name keep their tier.
    expect(getCapabilityRoute(sql, "optionsChains")!.minTier).toBe("freemium");

    const accepted = events.filter(
      (e) => e.action === "configure" && e.outcome === "accepted"
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].routeTiers).toEqual({ quotes: "premium" });
  });

  it("persists a tier for a capability the provider serves as gap-fill", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const { sink } = auditCollector();

    // Yahoo is the gap-fill on quotes (etrade is primary) — declared
    // on the stored route. Issue #2144 suppresses quotes gap-fill at
    // resolution, not at storage, so tier configuration still applies.
    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: "yahoo",
    });
    await transitionProvider(sql, "yahoo", "configure", ACTOR, {
      audit: sink,
      configure: { routeTiers: { quotes: "premium" } },
    });
    const route = getCapabilityRoute(sql, "quotes")!;
    expect(route.primaryProviderId).toBe("etrade");
    expect(route.gapFillProviderId).toBe("yahoo");
    expect(route.minTier).toBe("premium");
  });

  it("rejects an invalid tier value with nothing stored — route and provider record untouched", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const before = getProviderConfig(sql, "etrade");
    const { events, sink } = auditCollector();

    let caught: unknown;
    try {
      await transitionProvider(sql, "etrade", "configure", ACTOR, {
        audit: sink,
        configure: { routeTiers: { quotes: "gold" } as any },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderLifecycleError);
    expect((caught as ProviderLifecycleError).code).toBe("invalid_route_tier");
    expect(getCapabilityRoute(sql, "quotes")!.minTier).toBe("freemium");
    expect(getProviderConfig(sql, "etrade")).toEqual(before);
    expect(
      events.filter((e) => e.action === "configure" && e.outcome === "accepted")
    ).toHaveLength(0);
  });

  it("rejects an unknown capability with nothing stored", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const { sink } = auditCollector();

    await expect(
      transitionProvider(sql, "etrade", "configure", ACTOR, {
        audit: sink,
        configure: { routeTiers: { bogus: "premium" } as any },
      })
    ).rejects.toMatchObject({ code: "invalid_route_tier" });
    expect(getCapabilityRoute(sql, "quotes")!.minTier).toBe("freemium");
  });

  it("rejects a tier for a capability the provider does not serve in either slot", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const { sink } = auditCollector();

    // optionsChains belongs to etrade alone; yahoo occupies no slot.
    await expect(
      transitionProvider(sql, "yahoo", "configure", ACTOR, {
        audit: sink,
        configure: { routeTiers: { optionsChains: "premium" } },
      })
    ).rejects.toMatchObject({ code: "invalid_route_tier" });
    expect(getCapabilityRoute(sql, "optionsChains")!.minTier).toBe(
      "freemium"
    );
  });
});

const okVerifier = async () => ({ ok: true, summary: "stub verifier ok" });

function makeRouteCtx(
  sql: any,
  overrides: Partial<DataProviderRoutesContext> = {}
) {
  const auditRows: Array<{
    type: string;
    agent: string;
    payload: Record<string, unknown>;
  }> = [];
  const ctx: DataProviderRoutesContext = {
    env: {} as Env,
    sql,
    userLogin: ACTOR,
    recordAudit: (type, agent, payload) => {
      auditRows.push({ type, agent, payload });
      return {
        id: "audit-1",
        type,
        agent,
        payload,
        created_at: "2026-10-23T00:00:00.000Z",
      };
    },
    buildVerifier: (providerId: string) =>
      providerId === "etrade" ? (okVerifier as any) : undefined,
    ...overrides,
  };
  return { ctx, auditRows };
}

function callRoute(
  ctx: DataProviderRoutesContext,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const url = new URL(`https://agent.internal${path}`);
  const request = new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleDataProviderRoutes(
    request,
    url,
    path,
    "session-1",
    ctx
  ) as Promise<Response>;
}

describe("data-provider routes: tier surface (issue #1202)", () => {
  it("POST configure with routeTiers persists, GET route views expose minTier, and the audit payload carries the tier change", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const { ctx, auditRows } = makeRouteCtx(sql);

    const post = await callRoute(ctx, "POST", "/data-providers/etrade/configure", {
      routeTiers: { quotes: "premium" },
    });
    expect(post.status).toBe(200);

    const get = await callRoute(ctx, "GET", "/data-providers");
    expect(get.status).toBe(200);
    const body = (await get.json()) as any;
    const quotes = body.routes.find((r: any) => r.capability === "quotes");
    const chains = body.routes.find(
      (r: any) => r.capability === "optionsChains"
    );
    expect(quotes.minTier).toBe("premium");
    expect(chains.minTier).toBe("freemium");

    const configureAudits = auditRows.filter(
      (row) => (row.payload as any).action === "configure"
    );
    expect(configureAudits).toHaveLength(1);
    expect((configureAudits[0].payload as any).routeTiers).toEqual({
      quotes: "premium",
    });
  });

  it("POST configure with an invalid routeTiers tier is a 409 with the typed code and stores nothing", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const { ctx } = makeRouteCtx(sql);

    const post = await callRoute(ctx, "POST", "/data-providers/etrade/configure", {
      routeTiers: { quotes: "gold" },
    });
    expect(post.status).toBe(409);
    const body = (await post.json()) as any;
    expect(body.code).toBe("invalid_route_tier");
    expect(getCapabilityRoute(sql, "quotes")!.minTier).toBe("freemium");
  });
});

// ---------------------------------------------------------------------------
// (d) Entry-point enforcement at the options service
// ---------------------------------------------------------------------------

describe("UnifiedOptionsService tier enforcement (issue #1202)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Expiry ~35 days out — inside the default 0–90 DTE window (the E2
  // harness pattern).
  const expiry = new Date(Date.now() + 35 * 86_400_000);
  const expiryParts = {
    year: expiry.getUTCFullYear(),
    month: expiry.getUTCMonth() + 1,
    day: expiry.getUTCDate(),
  };
  const targetDate = expiry.toISOString().slice(0, 10);

  function optionsEnv() {
    const kvStorage: Record<string, string> = {};
    const mockKv = {
      get: async (k: string) => kvStorage[k] || null,
      put: async (k: string, v: string) => {
        kvStorage[k] = v;
      },
      delete: async (k: string) => {
        delete kvStorage[k];
      },
    } as any;
    const { namespace: sessionStoreNs } = makeFakeSessionStore();
    return {
      APP_NAME: "cfagent-test",
      APP_BASE_URL: "https://agent.openaimp.com",
      SESSION_SECRET: "e5-session-secret",
      GITHUB_CLIENT_ID: "gh_id",
      GITHUB_CLIENT_SECRET: "e5-github-secret",
      AI_SEARCH_ENDPOINT: "https://ai.example.com",
      SESSION_STORE: sessionStoreNs,
      ETRADE_KV: mockKv,
      SEARCH_AGENT: {} as any,
      ASSETS: {} as any,
      AI: {} as any,
      APP_ENV: "TEST",
      ET_API_KEY: "e5-et-key",
      ET_API_SECRET: "e5-et-secret",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_ACCOUNT_ID_KEY: "ACCOUNT_KEY_XYZ999",
    } as unknown as Env;
  }

  function chainWirePayload() {
    const nowSec = Math.floor(Date.now() / 1000);
    const strikes = [225, 237.5, 250, 262.5, 275];
    const pair = (strike: number) => {
      const callMid = Math.max(0.5, 250 - strike + 2.5);
      const putMid = Math.max(0.5, strike - 250 + 2.5);
      const contract = (type: "Call" | "Put", mid: number, delta: number) => ({
        symbol: `AAPL---${type === "Call" ? "C" : "P"}${strike}`,
        strikePrice: strike,
        bid: Math.max(0.05, mid - 0.1),
        ask: mid + 0.1,
        lastPrice: mid,
        volume: 500,
        openInterest: 1500,
        timeStamp: nowSec,
        OptionGreeks: { delta, gamma: 0.02, theta: -0.03, vega: 0.1, iv: 0.25 },
      });
      return {
        Call: contract("Call", callMid, 0.5),
        Put: contract("Put", putMid, -0.5),
      };
    };
    return {
      OptionChainResponse: {
        OptionPair: strikes.map(pair),
        nearPrice: 250,
        SelectedED: expiryParts,
        timeStamp: nowSec,
      },
    };
  }

  function stubOptionsFetch() {
    const chainPayload = chainWirePayload();
    const expirePayload = {
      OptionExpireDateResponse: { ExpirationDate: [expiryParts] },
    };
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes("optionexpiredate")) {
          return new Response(JSON.stringify(expirePayload), { status: 200 });
        }
        if (url.includes("optionchains")) {
          return new Response(JSON.stringify(chainPayload), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      });
  }

  function fakeBlobStorage() {
    const map = new Map<string, unknown>();
    return {
      map,
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
    };
  }

  /** A platform store whose optionsChains route has been tiered
   *  premium — the state a configure routeTiers call produces. */
  function premiumChainsSql() {
    const sql = freshSql();
    bootstrapDataProviders(sql);
    setRouteTier(sql, "optionsChains", "premium");
    return sql;
  }

  it("a default-tier (freemium) service with platform deps is refused by a premium optionsChains route and captures nothing", async () => {
    const env = optionsEnv();
    const login = "e5_freemium_trader";
    await storeAccessTokens(env, login, "valid_token", "valid_secret");
    stubOptionsFetch();

    const sql = premiumChainsSql();
    const service = new UnifiedOptionsService(
      env,
      login,
      undefined,
      undefined,
      new InMemoryScanRunStore(),
      undefined,
      undefined,
      { sql, blobStorage: fakeBlobStorage() as any, env: {} }
    );

    let caught: unknown;
    try {
      await service.execute({
        action: "opportunities",
        symbols: ["AAPL"],
        targetDate,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataProviderTierError);
    const err = caught as DataProviderTierError;
    expect(err.providerId).toBe("etrade");
    expect(err.capability).toBe("optionsChains");
    expect(err.requiredTier).toBe("premium");
    expect(err.callerTier).toBe("freemium");

    const countRows = [
      ...sql.exec("SELECT COUNT(*) AS count FROM mas_data_captures"),
    ] as Array<{ count: number }>;
    expect(countRows[0].count).toBe(0);
  });

  it("a premium-tier service with platform deps runs the scan over a premium route and captures land under the persisted scan run id", async () => {
    const env = optionsEnv();
    const login = "e5_premium_trader";
    await storeAccessTokens(env, login, "valid_token", "valid_secret");
    stubOptionsFetch();

    const sql = premiumChainsSql();
    const store = new InMemoryScanRunStore();
    const service = new UnifiedOptionsService(
      env,
      login,
      undefined,
      undefined,
      store,
      undefined,
      undefined,
      { sql, blobStorage: fakeBlobStorage() as any, env: {} },
      "premium"
    );
    const result = await service.execute({
      action: "opportunities",
      symbols: ["AAPL"],
      targetDate,
    });
    expect(result.success).toBe(true);
    const scanRunId = (result.data as any).scanRunId as string;
    expect(typeof scanRunId).toBe("string");
    expect(await store.get(scanRunId, { userLogin: login })).not.toBeNull();

    const captures = listCapturesByRun(sql, "default", scanRunId);
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.every((c) => c.capability === "optionsChains")).toBe(true);
    expect(captures.every((c) => c.providerId === "etrade")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) Panel tier badge
// ---------------------------------------------------------------------------

const PANEL_PROVIDER: DataProviderView = {
  id: "etrade",
  adapterKind: "etrade-rest",
  lifecycleState: "enabled",
  enabled: true,
  precedence: 1,
  credentialRef: "sessionstore:etrade:token",
  config: { displayName: "E*TRADE" },
  createdAt: "2026-10-23T09:00:00.000Z",
  updatedAt: "2026-10-23T10:30:00.000Z",
  declaredCapabilities: ["quotes", "optionsChains"],
  verification: null,
  serving: true,
};

const PANEL_ROUTES: CapabilityRouteView[] = [
  {
    capability: "quotes",
    primaryProviderId: "etrade",
    gapFillProviderId: "yahoo",
    minTier: "premium",
    resolves: true,
    resolvedPrimaryId: "etrade",
    resolvedGapFillId: "yahoo",
  },
  {
    capability: "optionsChains",
    primaryProviderId: "etrade",
    gapFillProviderId: null,
    minTier: "freemium",
    resolves: true,
    resolvedPrimaryId: "etrade",
    resolvedGapFillId: null,
  },
];

describe("panel route tier badge (issue #1202)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/data-providers")) {
          return Response.json(
            { providers: [PANEL_PROVIDER], routes: PANEL_ROUTES },
            { status: 200 }
          );
        }
        throw new Error(`unstubbed fetch: ${url}`);
      })
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
    vi.unstubAllGlobals();
  });

  async function flush(ms = 30) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  async function waitForText(text: string, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (container.textContent?.includes(text)) return;
      await flush(50);
    }
    throw new Error(
      `Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 800)}`
    );
  }

  it("renders a Premium badge on the premium route row and a Freemium badge on the freemium one", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ToastProvider, null, React.createElement(DataProvidersPanel)));
    });
    await waitForText("Primary: etrade");

    const rows = [...container.querySelectorAll(".dpp-route")];
    expect(rows).toHaveLength(2);
    const quotesRow = rows.find((r) => r.textContent?.includes("quotes"));
    const chainsRow = rows.find((r) =>
      r.textContent?.includes("optionsChains")
    );
    expect(quotesRow?.textContent).toContain("Tier: Premium");
    expect(chainsRow?.textContent).toContain("Tier: Freemium");
  });
});
