/**
 * Issue #3751 — ProviderIdentity: one identity (display name) per
 * provider/broker, held in the ONE identity map in
 * src/services/tenantProviders.ts, resolved into TenantProviderContext
 * by the existing composed pair (no new resolver), served on
 * GET /api/tenant/settings/providers, and projected client-side.
 *
 * User rulings (2026-11-09) pinned here:
 * - Q1: display name only; the server map is the home of record.
 * - Q2: a fell-back selection renders the DEFAULT provider's identity
 *   (post-#3812 defaults etrade/alpaca are real selections); the
 *   fellBack flags ride the payload. Unknown ids never render a
 *   guessed brand — resolution falls back per field, flagged.
 * - Q3: identity rides the GET providers response; client option
 *   lists remain the pre-load mirror only.
 * - Q5: names resolve at render time; stored provenance stamps ids
 *   only (withProviderProvenance's shape is unchanged — pinned in
 *   the slice-2 suite, not duplicated here).
 *
 * Route note: the GET handler composes resolveTenantProviderContext
 * over the row adapter.getTenantProviders already returns (the
 * adapter applies the platform defaults per field), so at the route
 * an absent row serves the DEFAULT identities — the presence-aware
 * distinction lives in getTenantBrokerSelection, deliberately not
 * used here. The fellBack=true cases are pinned at the context level.
 *
 * Registry-name note: the registry adapters' `name` matches the
 * identity map for etrade/yahoo/nasdaq/public. Alpaca is the ONE
 * documented divergence: the registry's full name is
 * "Alpaca Markets" (pinned by data_provider_alpaca_p1385) while the
 * tenant-facing display name is "Alpaca" (every display source,
 * incl. BROKER_CATALOG). Neither is changed by #3751.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  BROKER_DISPLAY_NAMES,
  BROKER_IDENTITIES,
  BROKER_IDS,
  DATA_PROVIDER_DISPLAY_NAMES,
  DATA_PROVIDER_IDENTITIES,
} from "../src/services/tenantProviders";
import { resolveTenantProviderContext } from "../src/services/optionsProviderContext";
import { DATA_PROVIDER_IDS } from "../src/trading/dataProviders/contract";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";
import {
  handleReportsRoutes,
  type ReportsRouteContext,
} from "../src/agents/routes/reports";
import {
  labelForBroker,
  labelForDataProvider,
  loadTenantProvidersFromServer,
  readTenantProvidersState,
  resetTenantProvidersStateForTest,
  setTenantProvidersStateForTest,
} from "../src/client/tenantProviders";
import { copilotSelectionLabel } from "../src/client/stockCopilotApi";
import { providerDisplayName, type DataProviderView } from "../src/client/dataProvidersApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTenantProvidersStateForTest();
});

describe("#3751 the one identity map", () => {
  it("covers every data-provider and broker id, with no identity for an unknown id", () => {
    expect(Object.keys(DATA_PROVIDER_IDENTITIES).sort()).toEqual([...DATA_PROVIDER_IDS].sort());
    expect(Object.keys(BROKER_IDENTITIES).sort()).toEqual([...BROKER_IDS].sort());
    for (const id of DATA_PROVIDER_IDS) {
      expect(DATA_PROVIDER_IDENTITIES[id].id).toBe(id);
      expect(DATA_PROVIDER_IDENTITIES[id].displayName.length).toBeGreaterThan(0);
    }
    for (const id of BROKER_IDS) {
      expect(BROKER_IDENTITIES[id].id).toBe(id);
      expect(BROKER_IDENTITIES[id].displayName.length).toBeGreaterThan(0);
    }
  });

  it("the display-name projections are derived from the one map, not a second copy", () => {
    for (const id of DATA_PROVIDER_IDS) {
      expect(DATA_PROVIDER_DISPLAY_NAMES[id]).toBe(DATA_PROVIDER_IDENTITIES[id].displayName);
    }
    for (const id of BROKER_IDS) {
      expect(BROKER_DISPLAY_NAMES[id]).toBe(BROKER_IDENTITIES[id].displayName);
    }
  });

  it("broker identities match BROKER_CATALOG labels character-for-character", () => {
    for (const id of BROKER_IDS) {
      expect(BROKER_IDENTITIES[id].displayName).toBe(BROKER_CATALOG[id].label);
    }
  });

  it("data-provider identities keep today's display names (the registry-name divergence is alpaca-only)", () => {
    expect(DATA_PROVIDER_IDENTITIES.etrade.displayName).toBe("E*TRADE");
    expect(DATA_PROVIDER_IDENTITIES.public.displayName).toBe("Public.com");
    expect(DATA_PROVIDER_IDENTITIES.yahoo.displayName).toBe("Yahoo Finance");
    expect(DATA_PROVIDER_IDENTITIES.nasdaq.displayName).toBe("Nasdaq Listings");
    // Registry adapter name is "Alpaca Markets" (data_provider_alpaca_p1385);
    // the tenant-facing display name stays "Alpaca".
    expect(DATA_PROVIDER_IDENTITIES.alpaca.displayName).toBe("Alpaca");
  });
});

describe("#3751 identity in the tenant provider context", () => {
  it("resolves the configured providers' identities — re-pointing changes identity with no code change", () => {
    const a = resolveTenantProviderContext({ dataProviderId: "etrade", brokerId: "alpaca" });
    expect(a.dataProviderDisplayName).toBe("E*TRADE");
    expect(a.brokerDisplayName).toBe("Alpaca");
    const b = resolveTenantProviderContext({ dataProviderId: "yahoo", brokerId: "etrade" });
    expect(b.dataProviderDisplayName).toBe("Yahoo Finance");
    expect(b.brokerDisplayName).toBe("E*TRADE");
    const c = resolveTenantProviderContext({ dataProviderId: "nasdaq", brokerId: "alpaca" });
    expect(c.dataProviderDisplayName).toBe("Nasdaq Listings");
  });

  it("absent/unknown input yields the DEFAULT providers' identities, flagged fellBack (Q2)", () => {
    for (const input of [undefined, null, {}, { dataProviderId: "bogus", brokerId: "bogus" }]) {
      const ctx = resolveTenantProviderContext(input as never);
      // Issue #3990: the default data provider is alpaca now (the
      // broker default was already alpaca) — the fallback identity
      // follows the platform default, not a hardcoded etrade.
      expect(ctx.dataProviderDisplayName).toBe("Alpaca");
      expect(ctx.brokerDisplayName).toBe("Alpaca");
      expect(ctx.dataProviderFellBack).toBe(true);
      expect(ctx.brokerFellBack).toBe(true);
    }
    // Per-field: a known field keeps its own identity, the unknown one falls back flagged.
    const mixed = resolveTenantProviderContext({ dataProviderId: "yahoo", brokerId: "bogus" });
    expect(mixed.dataProviderDisplayName).toBe("Yahoo Finance");
    expect(mixed.dataProviderFellBack).toBe(false);
    expect(mixed.brokerDisplayName).toBe("Alpaca");
    expect(mixed.brokerFellBack).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tenant/settings/providers serves the identity (route pattern
// follows tests/stock_copilot_settings_webhook_3471.test.ts).
// ---------------------------------------------------------------------------

class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as never[]));
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
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

function reportsCtx(env: unknown): ReportsRouteContext {
  return {
    ensureTables: () => ({ exec: () => [] }) as never,
    env: env as ReportsRouteContext["env"],
    getScreenerAgent: () => ({ getHistory: async () => [] }) as never,
    getScreenerExecutionContext: async () => undefined,
    getReportDispatchHitl: () => false,
    setReportDispatchHitl: vi.fn(),
    getReportConfirmation: vi.fn(() => null),
    decideReportConfirmation: vi.fn(),
    createReportConfirmation: vi.fn(() => "conf-1"),
    confirmationDeliveryMeta: vi.fn(() => ({})),
    deliverStoredReportEmail: vi.fn(async () => "sent" as const),
    deliverStoredReportWebhook: vi.fn(async () => ({ outcome: "sent" as const, result: { success: true, status: 200 } })),
    sendReportEmail: vi.fn(async () => true),
    sendReportWebhook: vi.fn(async () => ({ success: true, status: 200 })),
    storeResearchReportCanonicalAsync: vi.fn(async () => ({ reportId: "r1", generationId: "g1" })),
    audit: vi.fn(),
    reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
  } as ReportsRouteContext;
}

function apiRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`https://agent.openaimp.com${path}`, {
    method,
    headers: { "content-type": "application/json", "x-user-login": "alice" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const PROVIDERS_PATH = "/api/tenant/settings/providers";

describe("#3751 GET providers route serves identity", () => {
  it("an absent row serves the default selections WITH their identities", async () => {
    const ctx = reportsCtx({ AGENT_DB: new MockD1Database(), IAAA_TENANT_ID: "tenant-1" });
    const req = apiRequest(PROVIDERS_PATH, "GET");
    const res = await handleReportsRoutes(req, new URL(req.url), PROVIDERS_PATH, "sess", ctx);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown> & {
      identity?: Record<string, unknown>;
    };
    expect(body.dataProviderId).toBe("alpaca");
    expect(body.brokerId).toBe("alpaca");
    expect(body.identity).toEqual({
      dataProviderDisplayName: "Alpaca",
      brokerDisplayName: "Alpaca",
      dataProviderFellBack: false,
      brokerFellBack: false,
    });
  });

  it("re-pointing the tenant changes the served identity with no code change", async () => {
    const ctx = reportsCtx({ AGENT_DB: new MockD1Database(), IAAA_TENANT_ID: "tenant-1" });
    const post = apiRequest(PROVIDERS_PATH, "POST", { dataProviderId: "yahoo", brokerId: "etrade" });
    const postRes = await handleReportsRoutes(post, new URL(post.url), PROVIDERS_PATH, "sess", ctx);
    expect(postRes?.status).toBe(200);
    const get = apiRequest(PROVIDERS_PATH, "GET");
    const res = await handleReportsRoutes(get, new URL(get.url), PROVIDERS_PATH, "sess", ctx);
    const body = (await res!.json()) as Record<string, unknown> & {
      identity?: Record<string, unknown>;
    };
    expect(body.dataProviderId).toBe("yahoo");
    expect(body.brokerId).toBe("etrade");
    expect(body.identity).toEqual({
      dataProviderDisplayName: "Yahoo Finance",
      brokerDisplayName: "E*TRADE",
      dataProviderFellBack: false,
      brokerFellBack: false,
    });
  });
});

describe("#3751 client projection", () => {
  function stubFetch(payload: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => payload })),
    );
  }

  it("a legacy id-only response still validates and loads; labels fall to the mirror lists", async () => {
    stubFetch({ tenantId: "t", dataProviderId: "yahoo", brokerId: "etrade" });
    const state = await loadTenantProvidersFromServer();
    expect(state).toEqual({ dataProviderId: "yahoo", brokerId: "etrade" });
    expect(labelForDataProvider(state!, "yahoo")).toBe("Yahoo Finance");
    expect(labelForBroker(state!, "etrade")).toBe("E*TRADE");
    expect(labelForBroker(state!, "unknown-broker")).toBe("unknown-broker");
  });

  it("a response with identity populates the state and the projection prefers the served identity for the selection", async () => {
    stubFetch({
      tenantId: "t",
      dataProviderId: "yahoo",
      brokerId: "etrade",
      identity: {
        dataProviderDisplayName: "Yahoo Finance",
        brokerDisplayName: "E*TRADE",
        dataProviderFellBack: false,
        brokerFellBack: false,
      },
    });
    const state = await loadTenantProvidersFromServer();
    expect(state?.dataProviderDisplayName).toBe("Yahoo Finance");
    expect(state?.brokerDisplayName).toBe("E*TRADE");
    expect(state?.dataProviderFellBack).toBe(false);
    expect(labelForDataProvider(state!, state!.dataProviderId)).toBe("Yahoo Finance");
    expect(labelForBroker(state!, state!.brokerId)).toBe("E*TRADE");
    // A non-selection id is labelled from the mirror, never from the served identity.
    expect(labelForDataProvider(state!, "alpaca")).toBe("Alpaca");
  });

  it("copilotSelectionLabel renders the same strings as today for both brokers, raw id for unknown", () => {
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
    expect(
      copilotSelectionLabel({ selectionResolved: true, activeBroker: "alpaca", activeMode: "paper" } as never),
    ).toBe("Alpaca · Paper");
    expect(
      copilotSelectionLabel({ selectionResolved: true, activeBroker: "etrade", activeMode: "live" } as never),
    ).toBe("E*TRADE · Live");
    expect(
      copilotSelectionLabel({ selectionResolved: true, activeBroker: "schwab", activeMode: "paper" } as never),
    ).toBe("schwab · Paper");
    expect(copilotSelectionLabel({ selectionResolved: false, activeBroker: null, activeMode: null } as never)).toBeNull();
  });
});

describe("#3751 Data Providers panel registry-name projection", () => {
  function view(partial: Record<string, unknown>): DataProviderView {
    return partial as DataProviderView;
  }

  it("providerDisplayName prefers the tenant-set displayName, then the registry name, then the id", () => {
    expect(
      providerDisplayName(view({ id: "alpaca", name: "Alpaca Markets", config: { displayName: "My Alpaca" } })),
    ).toBe("My Alpaca");
    expect(providerDisplayName(view({ id: "alpaca", name: "Alpaca Markets", config: {} }))).toBe("Alpaca Markets");
    expect(providerDisplayName(view({ id: "alpaca", name: null, config: {} }))).toBe("alpaca");
    // Older responses without a name field behave exactly as today.
    expect(providerDisplayName(view({ id: "yahoo", config: {} }))).toBe("yahoo");
    expect(providerDisplayName(view({ id: "yahoo", config: { displayName: "Yahoo Finance" } }))).toBe(
      "Yahoo Finance",
    );
  });

  it("readTenantProvidersState still returns the id pair (shape guard)", () => {
    const state = readTenantProvidersState();
    expect(typeof state.dataProviderId).toBe("string");
    expect(typeof state.brokerId).toBe("string");
  });
});
