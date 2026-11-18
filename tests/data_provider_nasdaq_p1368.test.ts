/**
 * Issue #1368 (Nasdaq provider slice, epic #1116) — the slice's NEW
 * behaviour. TDD Red: these pins FAIL on the pre-slice tree (the
 * nasdaq capture option, the nasdaq verifier, the route helper, and
 * the universe binding do not exist yet) and pass after the reroute.
 *
 * Pins:
 *  - bindNasdaqUniverseDeps: a platform nasdaq provider bound to the
 *    pipeline's NasdaqUniverseDeps seam; the bound fetch returns the
 *    listings field-for-field with the direct fetch;
 *  - pipeline-via-platform parity: acquireUniverse all-listings mode
 *    through platform-bound deps reports the stub's per-exchange
 *    counts and symbol set, and fails honestly (no static universe
 *    substituted) when the listings fetch throws or returns empty;
 *  - capture (E1 semantics) on every nasdaq adapter fetch,
 *    run-linked, rawKind "provider-result", with a capture_failed
 *    marker (never a throw) on blob failure;
 *  - outcome (E7): a throwing platform fetch writes fetch_failed
 *    and rethrows the identical error;
 *  - lifecycle: verify → enable nasdaq through transitionProvider
 *    with the nasdaq verifier; the routes GET then serves nasdaq
 *    enabled with a health block, and the seeded screenUniverse
 *    route names nasdaq as primary;
 *  - route-table selection: the universe provider resolves from the
 *    seeded screenUniverse route's primary assignment;
 *  - conformance: the nasdaq adapter passes the kit over stub
 *    listings (drop-in replacement claim);
 *  - feed-shard sibling contract (#1355): executeShardJob feed/nasdaq
 *    returns { listings } identical to the stub, consumable by the
 *    etrade shard's resolveUniverse step, captured under the chain
 *    id — pinning the contract before feedNasdaq is touched.
 *
 * No secret-shaped literals: this file contains no credentials, keys,
 * or tokens in any form.
 */
import { describe, it, expect } from "vitest";
import {
  acquireUniverse,
  bindNasdaqUniverseDeps,
  nasdaqUniverseProviderFromRoute,
} from "../src/trading/screenerPipeline";
import {
  createNasdaqDataProvider,
  verifyNasdaqDataProvider,
  type NasdaqCaptureDeps,
} from "../src/trading/dataProviders/adapters";
import {
  ensureCaptureTable,
  listCapturesByProvider,
  listCapturesByRun,
  listCaptureFailures,
  listFetchFailures,
} from "../src/trading/dataProviders/captureStore";
import {
  getProviderConfig,
  listCapabilityRoutes,
  listProviderConfigs,
  seedProviderConfigs,
} from "../src/trading/dataProviders/providerConfigStore";
import { transitionProvider } from "../src/trading/dataProviders/lifecycle";
import { DataProviderRegistry } from "../src/trading/dataProviders/registry";
import { runDataProviderConformance } from "../src/trading/dataProviders/conformance";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import { executeShardJob } from "../src/services/shardExecutors";
import { resolveUniverse } from "../src/trading";
import { MockSqlStorage } from "./mock-sql";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { Env } from "../src/types";

const RUN = { runId: "run-nasdaq-1368", tenantId: "test-tenant", userLogin: "tester" };

function stubListings(): NasdaqStockListing[] {
  return [
    { symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ", lastPrice: 150, change: 1, changePercent: 0.5, sector: "Technology" },
    { symbol: "MSFT", companyName: "Microsoft Corp.", exchange: "NASDAQ", lastPrice: 300, change: 2, changePercent: 0.4, sector: "Technology" },
    { symbol: "IBM", companyName: "IBM Corp.", exchange: "NYSE", lastPrice: 140, change: -1, changePercent: -0.3, sector: "Technology" },
    { symbol: "F", companyName: "Ford Motor Co.", exchange: "NYSE", lastPrice: 12, change: 0.1, changePercent: 0.2, sector: "Consumer" },
    { symbol: "XLF", companyName: "Financial Select ETF", exchange: "AMEX", lastPrice: 40, change: 0.2, changePercent: 0.1, sector: "Financial" },
  ];
}

function fakeBlobStorage() {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

function failingBlobStorage() {
  return {
    get: async (_key: string) => undefined,
    put: async (_key: string, _value: unknown) => {
      throw new Error("forced blob put failure");
    },
  };
}

function captureDeps(sql: MockSqlStorage, storage: unknown = fakeBlobStorage()): NasdaqCaptureDeps {
  ensureCaptureTable(sql as never);
  return { sql: sql as never, blobStorage: storage as never, env: {} as never };
}

function chain() {
  return {
    chainId: "chain-nasdaq-1368",
    universe: "TECH",
    userLogin: "tester",
    timestamp: "2026-10-24T12:00:00.000Z",
    channels: [] as never,
  };
}

describe("binding: platform nasdaq provider → NasdaqUniverseDeps", () => {
  it("the bound fetch returns the listings field-for-field with the direct fetch", async () => {
    const stub = stubListings();
    const adapter = createNasdaqDataProvider(async () => stub);
    const deps = bindNasdaqUniverseDeps(adapter, RUN);
    expect(await deps.fetchListings()).toEqual(stub);
    expect((await adapter.getScreenUniverse(RUN)).result).toEqual(stub);
  });

  it("pipeline all-listings via universeDeps reports the stub's counts and symbol set", async () => {
    const stub = stubListings();
    const adapter = createNasdaqDataProvider(async () => stub);
    const acquired = await acquireUniverse({
      mode: "all-listings",
      universeDeps: bindNasdaqUniverseDeps(adapter, RUN),
    });
    expect(acquired.discovery.listingCount).toBe(stub.length);
    expect(acquired.discovery.sourceCounts?.NASDAQ).toBe(2);
    expect(acquired.discovery.sourceCounts?.NYSE).toBe(2);
    expect(acquired.discovery.sourceCounts?.AMEX).toBe(1);
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(
      stub.map((l) => l.symbol).sort()
    );
  });
});

describe("all-listings honesty through platform deps", () => {
  it("a throwing listings fetch fails with no static universe substituted", async () => {
    const adapter = createNasdaqDataProvider(async () => {
      throw new Error("listings feed down");
    });
    const result = await acquireUniverse({
      mode: "all-listings",
      universeDeps: bindNasdaqUniverseDeps(adapter, RUN),
    });
    expect(result.error).toMatch(/listings feed down/);
    expect(result.discovery.message).toMatch(/no static universe was substituted/);
    expect(result.quotes).toEqual([]);
  });

  it("an empty listings feed fails with the honest empty-directory message", async () => {
    const adapter = createNasdaqDataProvider(async () => []);
    const result = await acquireUniverse({
      mode: "all-listings",
      universeDeps: bindNasdaqUniverseDeps(adapter, RUN),
    });
    expect(result.error).toMatch(/no symbols; no static universe was substituted/);
    expect(result.quotes).toEqual([]);
  });
});

describe("capture: every nasdaq adapter fetch is captured, run-linked, never throwing", () => {
  it("getScreenUniverse writes one capture row under the run id with rawKind provider-result", async () => {
    const sql = new MockSqlStorage();
    const adapter = createNasdaqDataProvider(async () => stubListings(), {
      capture: captureDeps(sql),
    });
    const out = await adapter.getScreenUniverse(RUN);
    expect(out.result).toEqual(stubListings());
    const byRun = listCapturesByRun(sql as never, "test-tenant", "run-nasdaq-1368");
    expect(byRun.length).toBe(1);
    expect(byRun[0].providerId).toBe("nasdaq");
    expect(byRun[0].capability).toBe("screenUniverse");
    expect(byRun[0].rawKind).toBe("provider-result");
    const byProvider = listCapturesByProvider(sql as never, "test-tenant", "nasdaq");
    expect(byProvider.length).toBe(1);
  });

  it("a blob failure writes a capture_failed marker and the fetch still returns", async () => {
    const sql = new MockSqlStorage();
    const adapter = createNasdaqDataProvider(async () => stubListings(), {
      capture: captureDeps(sql, failingBlobStorage()),
    });
    const out = await adapter.getScreenUniverse(RUN);
    expect(out.result).toEqual(stubListings());
    const failures = listCaptureFailures(sql as never, "test-tenant");
    expect(failures.length).toBe(1);
    expect(failures[0].providerId).toBe("nasdaq");
    expect(failures[0].capability).toBe("screenUniverse");
  });
});

describe("outcome: throwing platform fetches are tracked and rethrown identically", () => {
  it("a throwing listings fetch writes fetch_failed and rethrows the identical error", async () => {
    const sql = new MockSqlStorage();
    const boom = new Error("listings feed down");
    const adapter = createNasdaqDataProvider(async () => {
      throw boom;
    }, { capture: captureDeps(sql) });
    let caught: unknown;
    try {
      await adapter.getScreenUniverse(RUN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    const failed = listFetchFailures(sql as never, "test-tenant");
    expect(failed.length).toBe(1);
    expect(failed[0].providerId).toBe("nasdaq");
    expect(failed[0].failureKind).toBe("unknown");
  });
});

describe("lifecycle + routes: nasdaq verifies, enables, and serves with health", () => {
  it("verify → enable through transitionProvider; GET serves nasdaq enabled with a health block", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    expect(getProviderConfig(sql as never, "nasdaq")?.lifecycleState).toBe("configured");
    const verifier = () => verifyNasdaqDataProvider({ fetchListings: async () => stubListings() });
    const verified = await transitionProvider(sql as never, "nasdaq", "verify", "tester", {
      verifier: verifier as never,
    });
    expect(verified.lifecycleState).toBe("verified");
    const enabled = await transitionProvider(sql as never, "nasdaq", "enable", "tester", {});
    expect(enabled.lifecycleState).toBe("enabled");
    expect(enabled.enabled).toBe(true);

    // A capture under the run gives the health block activity to report.
    const blob = fakeBlobStorage();
    const adapter = createNasdaqDataProvider(async () => stubListings(), {
      capture: captureDeps(sql, blob),
    });
    await adapter.getScreenUniverse(RUN);

    const ctx: DataProviderRoutesContext = {
      env: {} as Env,
      sql: sql as never,
      userLogin: "tester",
      recordAudit: () => ({ id: "audit-1", type: "t", agent: "a", payload: {}, created_at: "" }) as never,
    };
    const request = new Request("https://agent.internal/data-providers", { method: "GET" });
    const res = (await handleDataProviderRoutes(
      request,
      new URL("https://agent.internal/data-providers"),
      "/data-providers",
      "session-1",
      ctx
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const nasdaq = body.providers.find((p: any) => p.id === "nasdaq");
    expect(nasdaq.lifecycleState).toBe("enabled");
    expect(nasdaq.enabled).toBe(true);
    expect(nasdaq.health).toBeDefined();
    expect(typeof nasdaq.health.status).toBe("string");
    const universeRoute = body.routes.find((r: any) => r.capability === "screenUniverse");
    expect(universeRoute.primaryProviderId).toBe("nasdaq");
  });

  it("the seeded screenUniverse route names nasdaq as primary with no gap-fill", () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const routes = listCapabilityRoutes(sql as never);
    const route = routes.find((r) => r.capability === "screenUniverse");
    expect(route?.primaryProviderId).toBe("nasdaq");
    expect(route?.gapFillProviderId).toBeNull();
    expect(route?.minTier).toBe("freemium");
  });
});

describe("route-table selection: nasdaq universe resolves from the screenUniverse route", () => {
  it("returns the registered nasdaq adapter when the route names it and its config is enabled", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    await transitionProvider(sql as never, "nasdaq", "verify", "tester", {
      verifier: (async () => verifyNasdaqDataProvider({ fetchListings: async () => stubListings() })) as never,
    });
    await transitionProvider(sql as never, "nasdaq", "enable", "tester", {});
    const registry = new DataProviderRegistry();
    const adapter = createNasdaqDataProvider(async () => stubListings());
    registry.register(adapter);
    const resolved = nasdaqUniverseProviderFromRoute(
      registry,
      listProviderConfigs(sql as never),
      listCapabilityRoutes(sql as never)
    );
    expect(resolved).toBe(adapter);
  });

  it("throws when nasdaq is not enabled or the route does not name it", () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const registry = new DataProviderRegistry();
    registry.register(createNasdaqDataProvider(async () => stubListings()));
    expect(() =>
      nasdaqUniverseProviderFromRoute(
        registry,
        listProviderConfigs(sql as never),
        listCapabilityRoutes(sql as never)
      )
    ).toThrow(/not enabled/);
  });
});

describe("conformance: nasdaq adapter is a drop-in for the listings feed", () => {
  it("passes the kit for screenUniverse over stub listings", async () => {
    const adapter = createNasdaqDataProvider(async () => stubListings());
    const report = await runDataProviderConformance(adapter);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.capability)).toEqual(["screenUniverse"]);
  });
});

describe("feed shard: nasdaq shard result feeds the etrade shard's dependency contract", () => {
  it("executeShardJob feed/nasdaq returns { listings } identical to the stub, consumable by resolveUniverse, captured under the chain id", async () => {
    const sql = new MockSqlStorage();
    const stub = stubListings();
    const deps = {
      sql: sql as never,
      env: {},
      orm: {} as never,
      storage: fakeBlobStorage() as never,
      sessionId: "session-1",
      fetchListings: async () => stub,
    };
    const result = (await executeShardJob(deps as never, {
      shard: { stage: "feed", key: "nasdaq" },
      chain: chain() as never,
    } as never)) as { listings: NasdaqStockListing[] };
    expect(result).toEqual({ listings: stub });
    // The etrade shard's consumption step: resolveUniverse over the
    // shard's listings must yield the same symbols as over the stub.
    const fromShard = resolveUniverse("TECH" as never, result.listings).map((s: any) =>
      typeof s === "string" ? s : s.symbol
    );
    const fromStub = resolveUniverse("TECH" as never, stub).map((s: any) =>
      typeof s === "string" ? s : s.symbol
    );
    expect(fromShard).toEqual(fromStub);
    // The shard passes { runId, userLogin } with no tenant, exactly
    // like the etrade shard — resolveRunContext defaults the tenant
    // to "default", so the chain-linked capture is queried there.
    const byRun = listCapturesByRun(sql as never, "primary", "chain-nasdaq-1368");
    expect(byRun.length).toBe(1);
    expect(byRun[0].providerId).toBe("nasdaq");
  });
});
