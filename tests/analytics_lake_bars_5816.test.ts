// @vitest-environment node
/**
 * Issue #5816 — technicals bars as lake events, and the wire format the
 * stream schema requires (the #5830 blocker).
 *
 * Pins:
 *  - 5816-P01 granularity and the event ceiling are externalized, with
 *    `dataset` / 500 as the defaults;
 *  - 5816-P02 bars granularity emits ONE event per (run, symbol), carrying
 *    that symbol's compacted series and the run provenance;
 *  - 5816-P03 the ceiling drops the excess and never silently truncates a
 *    batch that fits;
 *  - 5816-P04 dataset granularity is unchanged (one event per artifact);
 *  - 5816-P05 the wire body carries `payload` as a JSON STRING (a Basin
 *    stream schema is scalar-typed) and round-trips to the same object.
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveAnalyticsLakeConfig,
  ANALYTICS_LAKE_GRANULARITY_SETTING,
  ANALYTICS_LAKE_MAX_EVENTS_SETTING,
  ANALYTICS_LAKE_MODE_SWITCH,
} from "../src/config/analyticsLakeConfig";
import { withLakeArchive } from "../src/aspects/analyticsLakeAspect";
import { BasinLakeAdapter } from "../src/data/basinLakeAdapter";
import { InMemoryAnalyticsLakeAdapter } from "../src/data/inMemoryAnalyticsLakeAdapter";

const artifact = { id: "art-9", asOf: "2026-11-19T00:00:05.000Z" } as never;

function barsInput(symbols: Array<{ symbol: string; bars: unknown[] }>) {
  return {
    jobId: "yahoo-nasdaq100-technicals",
    sourceId: "yahoo",
    dataset: "technicals",
    elements: [],
    universe: { kind: "index", index: "nasdaq100", label: "NASDAQ 100" },
    providerId: "yahoo",
    asOf: "2026-11-19T00:00:00.000Z",
    quotes: [],
    bars: symbols,
    run: {
      runId: "run:abc-1",
      trigger: "scheduled",
      kind: "feed",
      startedAt: "2026-11-19T00:00:00.000Z",
      finishedAt: "2026-11-19T00:00:05.000Z",
      status: "success",
      requested: symbols.length,
      received: symbols.length,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    nowIso: "2026-11-19T00:00:05.000Z",
  } as never;
}

const BARS = [
  { date: "2026-11-17", open: 100, high: 105, low: 99, close: 104, volume: 1000 },
  { date: "2026-11-18", open: 104, high: 108, low: 103, close: 107, volume: 1200 },
];

function fakeStore() {
  return {
    store: async () => artifact,
    latest: async () => undefined,
    latestUsable: async () => undefined,
    listRuns: async () => [],
  } as never;
}

describe("5816-P01 granularity and ceiling are externalized", () => {
  it("defaults to dataset granularity and 500 events", () => {
    const config = resolveAnalyticsLakeConfig({});
    expect(config.granularity).toBe("dataset");
    expect(config.maxEvents).toBe(500);
  });

  it("reads bars granularity and a custom ceiling", () => {
    const config = resolveAnalyticsLakeConfig({
      [ANALYTICS_LAKE_MODE_SWITCH]: "basin",
      [ANALYTICS_LAKE_GRANULARITY_SETTING]: "bars",
      [ANALYTICS_LAKE_MAX_EVENTS_SETTING]: "50",
    });
    expect(config.granularity).toBe("bars");
    expect(config.maxEvents).toBe(50);
  });

  it("ignores a nonsense ceiling rather than accepting it", () => {
    const config = resolveAnalyticsLakeConfig({
      [ANALYTICS_LAKE_MAX_EVENTS_SETTING]: "-5",
    });
    expect(config.maxEvents).toBe(500);
  });
});

describe("5816-P02 one event per (run, symbol)", () => {
  it("carries the symbol, its compacted bars and the run provenance", async () => {
    const lake = new InMemoryAnalyticsLakeAdapter();
    const decorated = withLakeArchive(fakeStore(), lake, {
      datasets: ["technicals"],
      table: "market_data.technicals_bars",
      granularity: "bars",
    });
    await decorated.store(
      barsInput([
        { symbol: "nvda", bars: BARS },
        { symbol: "msft", bars: BARS },
      ]),
    );
    expect(lake.events).toHaveLength(2);
    const nvda = lake.events.find((e) => e.eventId.endsWith(":NVDA"))!;
    expect(nvda.eventId).toBe("bars:art-9:NVDA");
    expect(nvda.table).toBe("market_data.technicals_bars");
    expect(nvda.payload).toMatchObject({
      artifactId: "art-9",
      jobId: "yahoo-nasdaq100-technicals",
      dataset: "technicals",
      runId: "run:abc-1",
      symbol: "NVDA",
      barCount: 2,
    });
    expect(nvda.payload.bars).toEqual([
      ["2026-11-17", 100, 105, 99, 104, 1000],
      ["2026-11-18", 104, 108, 103, 107, 1200],
    ]);
  });

  it("skips a symbol with no usable bars instead of emitting an empty row", async () => {
    const lake = new InMemoryAnalyticsLakeAdapter();
    const decorated = withLakeArchive(fakeStore(), lake, {
      datasets: ["technicals"],
      table: "t",
      granularity: "bars",
    });
    await decorated.store(
      barsInput([
        { symbol: "nvda", bars: BARS },
        { symbol: "empty", bars: [] },
        { symbol: "bad", bars: [{ nope: true }] },
      ]),
    );
    expect(lake.events.map((e) => e.payload.symbol)).toEqual(["NVDA"]);
  });
});

describe("5816-P03 the ceiling drops the excess", () => {
  it("emits only maxEvents events for a larger run", async () => {
    const lake = new InMemoryAnalyticsLakeAdapter();
    const decorated = withLakeArchive(fakeStore(), lake, {
      datasets: ["technicals"],
      table: "t",
      granularity: "bars",
      maxEvents: 2,
    });
    await decorated.store(
      barsInput([
        { symbol: "AAA", bars: BARS },
        { symbol: "BBB", bars: BARS },
        { symbol: "CCC", bars: BARS },
      ]),
    );
    expect(lake.events).toHaveLength(2);
  });
});

describe("5816-P04 dataset granularity is unchanged", () => {
  it("still emits exactly one artifact event", async () => {
    const lake = new InMemoryAnalyticsLakeAdapter();
    const decorated = withLakeArchive(fakeStore(), lake, {
      datasets: ["technicals"],
      table: "t",
    });
    await decorated.store(barsInput([{ symbol: "NVDA", bars: BARS }]));
    expect(lake.events).toHaveLength(1);
    expect(lake.events[0].eventId).toBe("dataset:art-9");
    expect("bars" in lake.events[0].payload).toBe(false);
  });
});

describe("5816-P05 the wire payload is a JSON string", () => {
  it("stringifies the body and round-trips it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const adapter = new BasinLakeAdapter({
      endpoint: "https://stream.example/ingest",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const payload = { symbol: "NVDA", bars: [["2026-11-17", 100, 105, 99, 104, 1000]] };
    await adapter.append([
      { table: "t", eventId: "e1", asOf: "2026-11-19T00:00:00.000Z", payload },
    ]);
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(typeof body[0].payload).toBe("string");
    expect(JSON.parse(body[0].payload)).toEqual(payload);
    expect(body[0].eventId).toBe("e1");
    expect(body[0].table).toBe("t");
  });
});
