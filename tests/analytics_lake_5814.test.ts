// @vitest-environment node
/**
 * Analytics lake foundation (#5814, parent #5813).
 *
 * Pins:
 *  - 5814-P01 config is externalized, off by default, and fail-closed:
 *    `basin` without endpoint/token resolves to `off` WITH a reason;
 *  - 5814-P02 the composition root maps config to an adapter and the inert
 *    adapter drops honestly (accepted 0, dropped N, reason);
 *  - 5814-P03 the Basin adapter is a transport: batch POST with bearer auth,
 *    named failure on non-2xx, chunking above the batch size;
 *  - 5814-P04 the archiving aspect runs AFTER the inner write, archives only
 *    configured datasets, and NEVER throws — a lake outage cannot fail a run;
 *  - 5814-P05 the event body carries counts + provenance, not payload rows.
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveAnalyticsLakeConfig,
  ANALYTICS_LAKE_MODE_SWITCH,
  ANALYTICS_LAKE_ENDPOINT_SETTING,
  ANALYTICS_LAKE_TOKEN_SETTING,
  ANALYTICS_LAKE_DATASETS_SETTING,
} from "../src/config/analyticsLakeConfig";
import { createAnalyticsLakePorts } from "../src/data/createAnalyticsLakePorts";
import { BasinLakeAdapter, ANALYTICS_LAKE_APPEND_FAILED } from "../src/data/basinLakeAdapter";
import { InMemoryAnalyticsLakeAdapter } from "../src/data/inMemoryAnalyticsLakeAdapter";
import {
  withLakeArchive,
  lakeEventForArtifact,
} from "../src/aspects/analyticsLakeAspect";

const baseEnv = {
  [ANALYTICS_LAKE_MODE_SWITCH]: "basin",
  [ANALYTICS_LAKE_ENDPOINT_SETTING]: "https://stream.example/ingest",
  [ANALYTICS_LAKE_TOKEN_SETTING]: "tok",
};

function artifactInput(over: Record<string, unknown> = {}) {
  return {
    jobId: "yahoo-nasdaq100-technicals",
    sourceId: "yahoo",
    dataset: "technicals",
    elements: [],
    universe: { kind: "index", index: "nasdaq100", label: "NASDAQ 100" },
    providerId: "yahoo",
    asOf: "2026-11-19T00:00:00.000Z",
    quotes: [],
    chains: [{ symbol: "NVDA", bars: [] }],
    run: {
      runId: "run:abc-1",
      trigger: "scheduled",
      kind: "feed",
      startedAt: "2026-11-19T00:00:00.000Z",
      finishedAt: "2026-11-19T00:00:05.000Z",
      status: "success",
      requested: 3,
      received: 3,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    nowIso: "2026-11-19T00:00:05.000Z",
    ...over,
  } as never;
}

const artifact = { id: "art-1", asOf: "2026-11-19T00:00:05.000Z" } as never;

describe("5814-P01 externalized, off by default, fail-closed", () => {
  it("defaults to off with the technicals dataset", () => {
    const config = resolveAnalyticsLakeConfig({});
    expect(config.mode).toBe("off");
    expect(config.datasets).toEqual(["technicals"]);
    expect(config.reason).toBeUndefined();
  });

  it("accepts basin only when fully configured", () => {
    const config = resolveAnalyticsLakeConfig(baseEnv);
    expect(config.mode).toBe("basin");
    expect(config.endpoint).toBe("https://stream.example/ingest");
    expect(config.datasets).toEqual(["technicals"]);
  });

  it("refuses basin without a token, naming the missing settings", () => {
    const config = resolveAnalyticsLakeConfig({
      [ANALYTICS_LAKE_MODE_SWITCH]: "basin",
      [ANALYTICS_LAKE_ENDPOINT_SETTING]: "https://stream.example/ingest",
    });
    expect(config.mode).toBe("off");
    expect(config.reason).toContain("analytics_lake_not_configured");
    expect(config.reason).toContain(ANALYTICS_LAKE_TOKEN_SETTING);
  });

  it("parses the dataset allowlist", () => {
    const config = resolveAnalyticsLakeConfig({
      ...baseEnv,
      [ANALYTICS_LAKE_DATASETS_SETTING]: "technicals, quotes",
    });
    expect(config.datasets).toEqual(["technicals", "quotes"]);
  });
});

describe("5814-P02 the composition root is the only env→adapter seam", () => {
  it("returns the inert adapter when off, and it drops honestly", async () => {
    const { config, lake } = createAnalyticsLakePorts({});
    expect(config.mode).toBe("off");
    const result = await lake.append([
      { table: "t", eventId: "e", asOf: "now", payload: {} },
    ]);
    expect(result).toEqual({
      accepted: 0,
      dropped: 1,
      reason: "analytics_lake_off",
    });
  });

  it("returns the Basin adapter when basin is configured", () => {
    const { lake } = createAnalyticsLakePorts(baseEnv);
    expect(lake).toBeInstanceOf(BasinLakeAdapter);
  });
});

describe("5814-P03 the Basin adapter is a transport", () => {
  it("POSTs a JSON batch with bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const adapter = new BasinLakeAdapter({
      endpoint: "https://stream.example/ingest",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await adapter.append([
      { table: "t", eventId: "e1", asOf: "now", payload: { a: 1 } },
    ]);
    expect(result).toEqual({ accepted: 1, dropped: 0 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://stream.example/ingest");
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String((init as RequestInit).body))).toHaveLength(1);
  });

  it("chunks above the batch size", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const adapter = new BasinLakeAdapter({
      endpoint: "https://x",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      batchSize: 2,
    });
    const events = Array.from({ length: 5 }, (_, i) => ({
      table: "t",
      eventId: `e${i}`,
      asOf: "now",
      payload: {},
    }));
    const result = await adapter.append(events);
    expect(result.accepted).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails with the named code on a non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("no", { status: 500 }));
    const adapter = new BasinLakeAdapter({
      endpoint: "https://x",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      adapter.append([{ table: "t", eventId: "e", asOf: "now", payload: {} }]),
    ).rejects.toThrow(ANALYTICS_LAKE_APPEND_FAILED);
  });
});

describe("5814-P04 the aspect: after the write, scoped, never fatal", () => {
  function fakeStore() {
    const calls: unknown[] = [];
    const store = {
      store: async (input: unknown) => {
        calls.push(input);
        return artifact;
      },
      latest: async () => undefined,
      latestUsable: async () => undefined,
      listRuns: async () => [],
    };
    return { store: store as never, calls };
  }

  it("archives a configured dataset exactly once, after the inner write", async () => {
    const { store } = fakeStore();
    const lake = new InMemoryAnalyticsLakeAdapter();
    const decorated = withLakeArchive(store, lake, {
      datasets: ["technicals"],
      table: "market_data.technicals_bars",
    });
    const result = await decorated.store(artifactInput());
    expect(result).toBe(artifact);
    expect(lake.events).toHaveLength(1);
    expect(lake.events[0].table).toBe("market_data.technicals_bars");
    expect(lake.events[0].eventId).toBe("dataset:art-1");
  });

  it("ignores a dataset outside the allowlist", async () => {
    const { store } = fakeStore();
    const lake = new InMemoryAnalyticsLakeAdapter();
    const decorated = withLakeArchive(store, lake, {
      datasets: ["quotes"],
      table: "t",
    });
    await decorated.store(artifactInput());
    expect(lake.events).toHaveLength(0);
  });

  it("never throws when the lake fails", async () => {
    const { store } = fakeStore();
    const exploding = {
      append: async () => {
        throw new Error("lake down");
      },
    };
    const decorated = withLakeArchive(store, exploding, {
      datasets: ["technicals"],
      table: "t",
    });
    await expect(decorated.store(artifactInput())).resolves.toBe(artifact);
  });

  it("passes every other port method through", async () => {
    const { store } = fakeStore();
    const lake = new InMemoryAnalyticsLakeAdapter();
    const decorated = withLakeArchive(store, lake, { datasets: ["technicals"], table: "t" });
    await expect(decorated.latestUsable("yahoo", "technicals")).resolves.toBeUndefined();
    await expect(decorated.listRuns("yahoo", "technicals")).resolves.toEqual([]);
  });
});

describe("5814-P05 the event carries counts and provenance only", () => {
  it("never includes the dataset payload rows", () => {
    const event = lakeEventForArtifact(
      artifactInput(),
      artifact,
      "market_data.technicals_bars",
    );
    expect(event.payload).toMatchObject({
      artifactId: "art-1",
      jobId: "yahoo-nasdaq100-technicals",
      dataset: "technicals",
      runId: "run:abc-1",
      status: "success",
      requested: 3,
      received: 3,
      failed: 0,
      universeIndex: "nasdaq100",
    });
    expect("chains" in event.payload).toBe(false);
    expect("quotes" in event.payload).toBe(false);
  });
});
