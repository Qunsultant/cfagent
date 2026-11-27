/**
 * Issue #6705 — the Data Providers panel read must complete within a
 * bound even when the pipeline host door never answers.
 *
 * The panel's one read is GET /data-providers. The list handler
 * awaits six host-door list reads per provider; a bare await on a
 * never-settling RPC hangs the route (and the panel spins forever).
 * These pins hold the fix: door reads race an externalized bound,
 * a timed-out read degrades to the honest fallbacks (feed catalog,
 * empty family lists), and each door list is fetched once per
 * request.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
  type FeedPipelineDoorLike,
} from "../src/agents/routes/dataProviders";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import type { Env } from "../src/types";

function hangingDoor(counters: Record<string, number>): FeedPipelineDoorLike {
  const hang = (name: string) => () => {
    counters[name] = (counters[name] ?? 0) + 1;
    return new Promise<never>(() => {});
  };
  return {
    listFeedJobSurfaceStatuses: hang("feed"),
    listEnrichJobSurfaceStatuses: hang("enrich"),
    listAnalyzeJobSurfaceStatuses: hang("analyze"),
    listGenerateJobSurfaceStatuses: hang("generate"),
    listDeliverJobSurfaceStatuses: hang("deliver"),
    listPipelineChainSurfaceStatuses: hang("chains"),
  } as unknown as FeedPipelineDoorLike;
}

function emptyDoor(counters: Record<string, number>): FeedPipelineDoorLike {
  const empty = (name: string) => async () => {
    counters[name] = (counters[name] ?? 0) + 1;
    return [];
  };
  return {
    listFeedJobSurfaceStatuses: empty("feed"),
    listEnrichJobSurfaceStatuses: empty("enrich"),
    listAnalyzeJobSurfaceStatuses: empty("analyze"),
    listGenerateJobSurfaceStatuses: empty("generate"),
    listDeliverJobSurfaceStatuses: empty("deliver"),
    listPipelineChainSurfaceStatuses: empty("chains"),
  } as unknown as FeedPipelineDoorLike;
}

function makeCtx(door: FeedPipelineDoorLike): DataProviderRoutesContext {
  const sql = new MockSqlStorage();
  seedProviderConfigs(sql);
  return {
    env: { DATA_PROVIDERS_PANEL_READ_MS: "25" } as unknown as Env,
    sql,
    userLogin: "octocat",
    recordAudit: async () => ({ id: "audit-1" }),
    feedDatasetStore: new InMemoryFeedDatasetStore(),
    feedPipelineDoor: door,
  };
}

function callList(ctx: DataProviderRoutesContext): Promise<Response> {
  const url = new URL("https://agent.internal/data-providers");
  return handleDataProviderRoutes(
    new Request(url),
    url,
    url.pathname,
    "session-1",
    ctx,
  ) as Promise<Response>;
}

describe("Data Providers panel read bound (#6705)", () => {
  it("GET /data-providers completes when every door list read never settles", async () => {
    const counters: Record<string, number> = {};
    const ctx = makeCtx(hangingDoor(counters));
    const res = await Promise.race([
      callList(ctx),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo).toBeDefined();
    // Feed jobs degrade to the catalog fallback (#6046), never a hang.
    expect(yahoo.feedJobs.length).toBeGreaterThan(0);
    expect(yahoo.enrichJobs).toEqual([]);
    expect(yahoo.pipelineChains).toEqual([]);
  });

  it("fetches each door list once per list request, not once per provider", async () => {
    const counters: Record<string, number> = {};
    const ctx = makeCtx(emptyDoor(counters));
    const res = await callList(ctx);
    expect(res.status).toBe(200);
    expect(counters.feed).toBe(1);
    expect(counters.enrich).toBe(1);
    expect(counters.analyze).toBe(1);
    expect(counters.generate).toBe(1);
    expect(counters.deliver).toBe(1);
    expect(counters.chains).toBe(1);
  });
});
