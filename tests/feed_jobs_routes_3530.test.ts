/**
 * Issue #3530 (one-of-everything, S1) — feed-job route pins. TDD Red first.
 *
 * The data-providers surface gains, per provider with a registered
 * feed job:
 * - a `feed` block on the provider view (never-run before the first
 *   run; last run + snapshot age after one; null for providers with
 *   no job — S1 registered Yahoo only; S2 adds E*TRADE + Alpaca, so
 *   the no-job pins below use nasdaq, which remains jobless — see
 *   the S2 adaptation notes on those pins);
 * - POST /data-providers/:id/feed-run — an admin run under the same
 *   session gate as every other mutation here (#1156 mechanism:
 *   no verified login → 401 before any state is read or written);
 * - GET /data-providers/:id/feed — the status + the local-copy read
 *   (the persisted snapshot served with provenance; missing is a
 *   typed state in a 200 body, never fabricated data).
 *
 * No live network: the provider, universe store, and dataset store
 * are injected through the route context (the buildVerifier idiom).
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const ACTOR = "octocat";
const T0 = Date.parse("2026-11-06T12:00:00.000Z");

function quote(symbol: string): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price: 100,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    timestamp: new Date(T0).toISOString(),
  } as MarketDataResearchQuote;
}

async function makeCtx(overrides?: Partial<DataProviderRoutesContext>) {
  const sql = new MockSqlStorage();
  seedProviderConfigs(sql);
  const datasetStore = new InMemoryFeedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  await universeStore.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
  });
  const provider: DataProvider = {
    id: "yahoo",
    name: "Yahoo Finance",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((s) => quote(s)),
      }) as DataResult<QuoteResult[]>,
  };
  const auditRows: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx: DataProviderRoutesContext = {
    env: {} as Env,
    sql,
    userLogin: ACTOR,
    recordAudit: (type, _agent, payload) => {
      auditRows.push({ type, payload });
      return { id: "audit-1" };
    },
    feedDatasetStore: datasetStore,
    feedUniverseStore: universeStore,
    feedProviderFor: () => provider,
    ...overrides,
  };
  return { ctx, datasetStore, auditRows };
}

function callRoute(
  ctx: DataProviderRoutesContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`https://agent.internal${path}`);
  const request = new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Production passes url.pathname (routeRequest.ts) — the query
  // string rides on the URL, never inside `path`.
  return handleDataProviderRoutes(request, url, url.pathname, "session-1", ctx) as Promise<Response>;
}

describe("feed routes (#3530 S1)", () => {
  it("GET /data-providers carries a feed block for Yahoo (never-run) and null for providers without a job", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo.feed).toMatchObject({
      jobId: "yahoo-nasdaq100-quotes",
      state: "never-run",
      lastRun: null,
      snapshot: null,
    });
    // S2 adaptation (#3530 S2, disclosed): the null exemplar was
    // etrade in S1; S2 registers an E*TRADE feed job, so etrade now
    // carries its own never-run block, and the "no job ⇒ null"
    // invariant is asserted on nasdaq, which remains jobless.
    const etrade = body.providers.find((p: any) => p.id === "etrade");
    // #3535 registered an E*TRADE feed job too, so its feed block
    // is a never-run view now, not null.
    expect(etrade.feed).toMatchObject({
      jobId: "etrade-nasdaq100-quotes",
      state: "never-run",
      lastRun: null,
      snapshot: null,
    });
    // Nasdaq registers no quotes/fundamentals job (screenUniverse
    // only) — its feed block stays null.
    const nasdaq = body.providers.find((p: any) => p.id === "nasdaq");
    expect(nasdaq.feed).toBeNull();
  });

  it("POST feed-run without a verified login is refused 401 before anything runs", async () => {
    const { ctx, datasetStore } = await makeCtx({ userLogin: "" });
    const res = await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    expect(res.status).toBe(401);
    expect(await datasetStore.latest("yahoo", "quotes")).toBeUndefined();
  });

  it("POST feed-run runs the job, audits it, and the GET surfaces then show the run + snapshot", async () => {
    const { ctx, auditRows } = await makeCtx();
    const res = await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.run).toMatchObject({ status: "completed", requested: 2, received: 2, failed: 0 });
    expect(body.feed.state).toBe("ready");
    expect(body.feed.snapshot).toMatchObject({ rowsPersisted: 2 });
    expect(auditRows.some((r) => r.type === "data_provider.feed_run")).toBe(true);

    const list = await callRoute(ctx, "GET", "/data-providers");
    const listBody = (await list.json()) as any;
    const yahoo = listBody.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo.feed.state).toBe("ready");
    expect(yahoo.feed.lastRun).toMatchObject({ status: "completed", received: 2 });
    expect(yahoo.feed.snapshot.rowsPersisted).toBe(2);
  });

  it("POST feed-run for a provider with no registered job is a typed 404", async () => {
    // S2 adaptation (#3530 S2, disclosed): the no-job exemplar was
    // etrade in S1; etrade has a job since S2, so the invariant
    // (jobless provider ⇒ typed FEED_JOB_NOT_FOUND 404) is asserted
    // on nasdaq, which remains jobless.
    const { ctx } = await makeCtx();
    // #3535: nasdaq is the provider with no quotes job (its job
    // maintains the index list, not a quotes dataset).
    const res = await callRoute(ctx, "POST", "/data-providers/nasdaq/feed-run", {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_NOT_FOUND");
  });

  it("GET /data-providers/:id/feed serves the persisted copy with provenance; before any run it reports missing", async () => {
    const { ctx } = await makeCtx();
    const before = await callRoute(ctx, "GET", "/data-providers/yahoo/feed?symbols=AAPL");
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as any;
    expect(beforeBody.feed.state).toBe("never-run");
    expect(beforeBody.quotes.status).toBe("missing");

    await callRoute(ctx, "POST", "/data-providers/yahoo/feed-run", {});
    const after = await callRoute(ctx, "GET", "/data-providers/yahoo/feed?symbols=AAPL,TSLA");
    const afterBody = (await after.json()) as any;
    expect(afterBody.quotes.status).toBe("hit");
    expect(afterBody.quotes.quotes).toHaveLength(1);
    expect(afterBody.quotes.quotes[0].symbol).toBe("AAPL");
    expect(afterBody.quotes.missingSymbols).toEqual(["TSLA"]);
    expect(afterBody.quotes.provenance).toMatchObject({ providerId: "yahoo", universeIndex: "nasdaq100" });
  });

  it("GET /data-providers/:id/feed for a provider without a job is a typed 404", async () => {
    // S2 adaptation (#3530 S2, disclosed): exemplar swapped from
    // etrade (jobless in S1, registered in S2) to nasdaq (still
    // jobless); the invariant asserted is unchanged.
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers/nasdaq/feed");
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEED_JOB_NOT_FOUND");
  });
});
