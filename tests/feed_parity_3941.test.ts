// @vitest-environment node
/**
 * Issue #3941 (sub of #3550) — feed parity: provider pull works in
 * either residency (workflow and host).
 *
 * Today the workflow residency refuses every feed pull
 * (providerFor is unwired: capture deps need a DO host's
 * storage), while the ScheduledAgent host residency runs them.
 * This slice wires the engine's provider in workflow residency
 * with the SAME capture construction the host uses — the D1
 * capture port for rows, the R2 blob seam for raw bytes, and an
 * R2-backed metadata store in place of the DO storage the
 * workflow residency does not have — so a feed pull executes
 * identically in either residency: same provider ports, same
 * capture wiring, same persisted dataset hand-off, same coded
 * refusals, no uncaptured fetch.
 *
 * Standing rules: one branch, one PR, Merge Queue only, no
 * deletions, locally rebased and re-verified before the PR
 * opens; §15 draft only with separate approval.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import { createCaptureWiredFeedProvider } from "../src/services/feedProviderWiring";
import { createR2CaptureBlobStorage } from "../src/data/r2CaptureBlobAdapter";
import { feedStepDepsForWorkflow } from "../src/workflows/jobPipelineWorkflow";
import { feedStepDepsForScheduledAgent } from "../src/agents/scheduledTasksPipeline";
import { createProviderCaptureAdapter } from "../src/data/createProviderCapturePorts";
import {
  createD1ProviderCaptureDb,
  ensureProviderCaptureSchema,
  D1ProviderCaptureAdapter,
} from "../src/data/d1ProviderCaptureAdapter";
import { InMemoryProviderCaptureAdapter } from "../src/data/inMemoryProviderCaptureAdapter";
import { createFeedDatasetAdapter } from "../src/data/createFeedDatasetPorts";
import { D1IndexListStore } from "../src/data/d1IndexListAdapter";
import { createJobPipelineStoresFromD1 } from "../src/data/createJobPipelinePorts";
import { createBlobStore } from "../src/services/blobStoreR2Adapter";
import {
  getCaptureBlob,
  putCaptureBlob,
  type CaptureBlobStorage,
} from "../src/data/providerCapturePorts";
import { createFeedStepRegistry, ensureFeedPipelineJobs } from "../src/services/feedPipelineJobs";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT"];

/** Minimal D1Database stand-in over node:sqlite (the foundation tests' double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    const runStmt = (params: unknown[]) => ({
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
    });
    return {
      // The real D1 prepared statement also answers run/all/first
      // directly (parameterless statements skip bind()).
      ...runStmt([]),
      bind(...params: unknown[]) {
        return runStmt(params);
      },
    };
  }
  async batch(statements: { run: () => Promise<unknown> }[]) {
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

/** node:sqlite double for the SqlStorage seam (same shape as the J1 suite's). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

interface FakeObject {
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

/** Fake R2 bucket (the blob_store_1777 idiom). */
function makeFakeBucket() {
  const objects = new Map<string, FakeObject>();
  const puts: Array<{ key: string; options?: unknown }> = [];
  return {
    objects,
    puts,
    async put(key: string, value: Uint8Array | string, options?: Record<string, unknown>) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      objects.set(key, {
        bytes,
        contentType: (options?.httpMetadata as { contentType?: string } | undefined)
          ?.contentType,
        customMetadata: options?.customMetadata as Record<string, string> | undefined,
      });
      puts.push({ key, options });
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        async arrayBuffer() {
          return obj.bytes.buffer.slice(
            obj.bytes.byteOffset,
            obj.bytes.byteOffset + obj.bytes.byteLength,
          ) as ArrayBuffer;
        },
        async text() {
          return new TextDecoder().decode(obj.bytes);
        },
        httpMetadata: obj.httpMetadata ?? {},
        customMetadata: obj.customMetadata ?? {},
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...objects.keys()]
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map((key) => ({ key })),
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

/** Map-backed DO-shaped storage (the host's blobStorage shape). */
function makeDoStorage() {
  const kv = new Map<string, unknown>();
  return {
    kv,
    get: async <T>(key: string): Promise<T | undefined> => kv.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      kv.set(key, value);
    },
  };
}

const yahooPayload = {
  quoteResponse: {
    result: [
      {
        symbol: "AAPL",
        longName: "Apple Inc.",
        regularMarketPrice: 150.25,
        regularMarketPreviousClose: 148.0,
        regularMarketChange: 2.25,
        regularMarketChangePercent: 1.52,
        regularMarketVolume: 1234567,
        regularMarketOpen: 149.0,
        regularMarketDayHigh: 151.0,
        regularMarketDayLow: 148.5,
        bid: 150.2,
        ask: 150.3,
        trailingPE: 22.5,
        marketCap: 987654321,
        currency: "USD",
      },
      {
        symbol: "MSFT",
        longName: "Microsoft Corp.",
        regularMarketPrice: 300.5,
        regularMarketPreviousClose: 298.0,
        regularMarketChange: 2.5,
        regularMarketChangePercent: 0.84,
        regularMarketVolume: 7654321,
        regularMarketOpen: 299.0,
        regularMarketDayHigh: 301.0,
        regularMarketDayLow: 297.5,
        bid: 300.4,
        ask: 300.6,
        trailingPE: 30.1,
        marketCap: 1234567890,
        currency: "USD",
      },
    ],
    error: null,
  },
};

/** Stub the Yahoo v7 batch fetch (the yahoo_provider_batch idiom). */
function stubYahoo() {
  vi.stubGlobal("fetch", async (url: string) => {
    // Route by parsed hostname + exact pathname (never raw URL
    // substring matching — CodeQL incomplete-sanitization rule).
    const u = new URL(String(url));
    if (u.hostname === "fc.yahoo.com") {
      return { ok: true, status: 200, headers: { get: () => "A3=testcookie" } };
    }
    if (u.hostname === "query1.finance.yahoo.com" && u.pathname === "/v1/test/getcrumb") {
      return { ok: true, status: 200, text: async () => "testcrumb" };
    }
    if (u.hostname === "query1.finance.yahoo.com" && u.pathname === "/v7/finance/quote") {
      return { ok: true, status: 200, json: async () => yahooPayload };
    }
    throw new Error(`unexpected fetch: ${u.toString()}`);
  });
}

afterAll(() => {
  vi.unstubAllGlobals();
});

function yahooDef() {
  return buildFeedJobRegistry({}).get("yahoo-nasdaq100-quotes")!;
}

function etradeDef() {
  return buildFeedJobRegistry({}).get("etrade-nasdaq100-quotes")!;
}

describe("R2 capture-blob storage (#3941)", () => {
  it("returns null when REPORTS_BUCKET is unbound", () => {
    expect(createR2CaptureBlobStorage({})).toBeNull();
    expect(createR2CaptureBlobStorage({ REPORTS_BUCKET: undefined })).toBeNull();
  });

  it("round-trips values through the R2 blob seam", async () => {
    const bucket = makeFakeBucket();
    const storage = createR2CaptureBlobStorage({ REPORTS_BUCKET: bucket as never })!;
    await storage.put("data-capture:default:abc", { storedAt: "2026-11-11T00:00:00.000Z", r2Key: "data-capture:default:abc" });
    expect(await storage.get("data-capture:default:abc")).toEqual({
      storedAt: "2026-11-11T00:00:00.000Z",
      r2Key: "data-capture:default:abc",
    });
    expect(await storage.get("data-capture:default:missing")).toBeUndefined();
  });

  it("never collides with the raw bytes stored under the bare key", async () => {
    const bucket = makeFakeBucket();
    const env = { REPORTS_BUCKET: bucket as never };
    const store = createBlobStore(env)!;
    const raw = new TextEncoder().encode(JSON.stringify({ hello: "raw" }));
    await store.put("data-capture:default:abc", raw, { contentType: "application/json" });
    const storage = createR2CaptureBlobStorage(env)!;
    await storage.put("data-capture:default:abc", { storedAt: "2026-11-11T00:00:00.000Z", r2Key: "data-capture:default:abc" });
    const back = await store.get("data-capture:default:abc");
    expect(back).not.toBeNull();
    expect(new TextDecoder().decode(back!.bytes)).toBe(JSON.stringify({ hello: "raw" }));
    expect(await storage.get("data-capture:default:abc")).toEqual({
      storedAt: "2026-11-11T00:00:00.000Z",
      r2Key: "data-capture:default:abc",
    });
  });
});

describe("capture-wired provider factory honesty (#3941)", () => {
  const env = {} as Env;

  it("builds Yahoo/Alpaca providers from the D1 port + R2 storage, no DO sql", () => {
    const bucket = makeFakeBucket();
    const provider = createCaptureWiredFeedProvider(yahooDef(), {
      env,
      capturePort: new InMemoryProviderCaptureAdapter(),
      blobStorage: createR2CaptureBlobStorage({ REPORTS_BUCKET: bucket as never })!,
    });
    expect(provider?.id).toBe("yahoo");
    const alpaca = createCaptureWiredFeedProvider(
      buildFeedJobRegistry({}).get("alpaca-nasdaq100-quotes")!,
      {
        env,
        capturePort: new InMemoryProviderCaptureAdapter(),
        blobStorage: createR2CaptureBlobStorage({ REPORTS_BUCKET: bucket as never })!,
      },
    );
    expect(alpaca?.id).toBe("alpaca");
  });

  it("refuses E*TRADE/Public without a login, builds them with one", () => {
    const bucket = makeFakeBucket();
    const base = {
      env,
      capturePort: new InMemoryProviderCaptureAdapter(),
      blobStorage: createR2CaptureBlobStorage({ REPORTS_BUCKET: bucket as never })!,
    };
    expect(createCaptureWiredFeedProvider(etradeDef(), base)).toBeUndefined();
    expect(
      createCaptureWiredFeedProvider(etradeDef(), { ...base, userLogin: "svc-test" })?.id,
    ).toBe("etrade");
    const pub = buildFeedJobRegistry({}).get("public-nasdaq100-quotes")!;
    expect(createCaptureWiredFeedProvider(pub, base)).toBeUndefined();
    expect(createCaptureWiredFeedProvider(pub, { ...base, userLogin: "svc-test" })?.id).toBe(
      "public",
    );
  });

  it("returns undefined when neither the port nor sql can be built", () => {
    const bucket = makeFakeBucket();
    const storage = createR2CaptureBlobStorage({ REPORTS_BUCKET: bucket as never })!;
    expect(
      createCaptureWiredFeedProvider(yahooDef(), { env, blobStorage: storage }),
    ).toBeUndefined();
  });

  it("returns undefined when the port is present but no blob storage is", () => {
    expect(
      createCaptureWiredFeedProvider(yahooDef(), {
        env,
        capturePort: new InMemoryProviderCaptureAdapter(),
      }),
    ).toBeUndefined();
  });

  it("the legacy host shape (sql + DO storage, no port) still builds", () => {
    const sql = new SqliteTestStorage();
    const storage = makeDoStorage();
    const provider = createCaptureWiredFeedProvider(yahooDef(), {
      env,
      sql: sql as never,
      blobStorage: storage as unknown as CaptureBlobStorage,
    });
    expect(provider?.id).toBe("yahoo");
  });

  it("an unknown source still resolves to undefined", () => {
    const bucket = makeFakeBucket();
    // "nasdaq" declares screenUniverse only — it has no feed
    // pull provider (the factory's default branch).
    const nasdaq = { sourceId: "nasdaq" } as never;
    expect(
      createCaptureWiredFeedProvider(nasdaq, {
        env,
        capturePort: new InMemoryProviderCaptureAdapter(),
        blobStorage: createR2CaptureBlobStorage({ REPORTS_BUCKET: bucket as never })!,
      }),
    ).toBeUndefined();
  });
});

describe("getCaptureBlob cross-residency read (#3941)", () => {
  it("a metadata hit reads as before", async () => {
    const bucket = makeFakeBucket();
    const env = { REPORTS_BUCKET: bucket as never };
    const storage = makeDoStorage();
    const bytes = new TextEncoder().encode(JSON.stringify({ live: 1 }));
    await putCaptureBlob(env, storage as unknown as CaptureBlobStorage, "data-capture:default:abc", bytes);
    expect(await getCaptureBlob(env, storage as unknown as CaptureBlobStorage, "data-capture:default:abc")).toEqual(bytes);
  });

  it("a metadata miss falls back to the R2 object under the bare key", async () => {
    const bucket = makeFakeBucket();
    const env = { REPORTS_BUCKET: bucket as never };
    const bytes = new TextEncoder().encode(JSON.stringify({ live: 2 }));
    // Bytes land in R2 (the workflow residency's write); the
    // reader's metadata store has never seen this key.
    await createBlobStore(env)!.put("data-capture:default:xyz", bytes, {
      contentType: "application/json",
    });
    const empty = makeDoStorage();
    expect(
      await getCaptureBlob(env, empty as unknown as CaptureBlobStorage, "data-capture:default:xyz"),
    ).toEqual(bytes);
  });

  it("a metadata miss with nothing in R2 still reads null", async () => {
    const bucket = makeFakeBucket();
    const env = { REPORTS_BUCKET: bucket as never };
    const empty = makeDoStorage();
    expect(
      await getCaptureBlob(env, empty as unknown as CaptureBlobStorage, "data-capture:default:nope"),
    ).toBeNull();
  });

  it("a metadata miss with R2 unbound still reads null", async () => {
    const empty = makeDoStorage();
    expect(
      await getCaptureBlob({}, empty as unknown as CaptureBlobStorage, "data-capture:default:nope"),
    ).toBeNull();
  });
});

describe("workflow-residency feed wiring (#3941)", () => {
  async function seedUniverse(mock: MockD1Database) {
    const store = new D1IndexListStore(mock as never);
    await store.store({
      index: "nasdaq100",
      snapshotDate: "2026-11-02",
      symbols: SYMBOLS.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 4 * 24 * 3600_000),
    });
  }

  async function makeControl(steps: ReturnType<typeof createFeedStepRegistry>) {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const messaging = new InMemoryMessagingAdapter();
    const ports: MessagingPorts = {
      producer: messaging,
      consumer: messaging,
      publisher: messaging,
      subscriber: messaging,
    };
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: ports.publisher,
      steps,
      now: () => new Date(T0),
    });
    await ensureFeedPipelineJobs(control, stores, {});
    return control;
  }

  async function runYahooQuotes(
    deps: ReturnType<typeof feedStepDepsForWorkflow>,
  ) {
    const control = await makeControl(createFeedStepRegistry(deps));
    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    return { dispatch, outcome };
  }

  it("a Yahoo pull completes in workflow residency with dataset + D1 capture", async () => {
    stubYahoo();
    const mock = new MockD1Database();
    await ensureProviderCaptureSchema(
      createD1ProviderCaptureDb(mock as never),
    );
    await seedUniverse(mock);
    const bucket = makeFakeBucket();
    const env = { AGENT_DB: mock, REPORTS_BUCKET: bucket } as unknown as Env;
    const stores = createJobPipelineStoresFromD1(mock as never);
    const deps = feedStepDepsForWorkflow(env, stores);
    const { dispatch, outcome } = await runYahooQuotes(deps);
    expect(outcome.state).toBe("completed");
    const dataset = await createFeedDatasetAdapter({ AGENT_DB: mock })!.latest("yahoo", "quotes");
    expect(dataset).not.toBeNull();
    const values = (dataset!.quotes as { symbol: string; price: number }[])
      .map((e) => ({ symbol: e.symbol, price: e.price }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(values).toEqual([
      { symbol: "AAPL", price: 150.25 },
      { symbol: "MSFT", price: 300.5 },
    ]);
    const captures = await new D1ProviderCaptureAdapter(
      createD1ProviderCaptureDb(mock as never),
    ).listCapturesByRun("default", dispatch.runId);
    expect(captures.length).toBeGreaterThan(0);
    expect(captures[0]?.providerId).toBe("yahoo");
    expect(captures[0]?.capability).toBe("quotes");
    expect(captures[0]?.status).toBe("captured");
    expect(captures[0]?.rawBlobRef).toMatch(/^data-capture:default:/);
    // The raw bytes are in R2 under the bare blob ref.
    const raw = await createBlobStore({ REPORTS_BUCKET: bucket as never })!.get(
      captures[0]!.rawBlobRef!,
    );
    expect(raw).not.toBeNull();
  });

  it("the same pull in host residency produces the identical dataset and provenance", async () => {
    stubYahoo();
    async function runOnce() {
      const mock = new MockD1Database();
      await ensureProviderCaptureSchema(createD1ProviderCaptureDb(mock as never));
      await seedUniverse(mock);
      const bucket = makeFakeBucket();
      return { mock, bucket };
    }
    // Workflow residency.
    const wf = await runOnce();
    const wfEnv = { AGENT_DB: wf.mock, REPORTS_BUCKET: wf.bucket } as unknown as Env;
    const wfDeps = feedStepDepsForWorkflow(wfEnv, createJobPipelineStoresFromD1(wf.mock as never));
    const wfRun = await runYahooQuotes(wfDeps);
    expect(wfRun.outcome.state).toBe("completed");
    // Host residency (same D1 stores, DO-shaped capture storage).
    const host = await runOnce();
    const hostSql = new SqliteTestStorage();
    const hostStorage = makeDoStorage();
    const hostEnv = { AGENT_DB: host.mock, REPORTS_BUCKET: host.bucket } as unknown as Env;
    const hostCtx = {
      env: hostEnv,
      agentCtx: { storage: { sql: hostSql, get: hostStorage.get, put: hostStorage.put } },
    } as never;
    const hostDeps = feedStepDepsForScheduledAgent(hostCtx);
    const hostRun = await runYahooQuotes(hostDeps);
    expect(hostRun.outcome.state).toBe("completed");

    const readDataset = async (mock: MockD1Database) =>
      (await createFeedDatasetAdapter({ AGENT_DB: mock })!.latest("yahoo", "quotes"))!;
    const readCaptures = async (mock: MockD1Database, runId: string) =>
      new D1ProviderCaptureAdapter(createD1ProviderCaptureDb(mock as never)).listCapturesByRun(
        "default",
        runId,
      );
    const wfDataset = await readDataset(wf.mock);
    const hostDataset = await readDataset(host.mock);
    const valueFields = (d: typeof wfDataset) =>
      (d.quotes as { symbol: string; price: number; change: number; volume: number }[])
        .map((e) => ({ symbol: e.symbol, price: e.price, change: e.change, volume: e.volume }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(valueFields(hostDataset)).toEqual(valueFields(wfDataset));
    const wfCaptures = await readCaptures(wf.mock, wfRun.dispatch.runId);
    const hostCaptures = await readCaptures(host.mock, hostRun.dispatch.runId);
    expect(hostCaptures).toHaveLength(wfCaptures.length);
    for (let i = 0; i < wfCaptures.length; i++) {
      // Wall-clock timestamps differ between runs, so the digests
      // differ — but the stable provenance fields must agree, and
      // the raw byte length agrees (ISO timestamps are fixed-width).
      expect(hostCaptures[i]?.providerId).toBe(wfCaptures[i]?.providerId);
      expect(hostCaptures[i]?.capability).toBe(wfCaptures[i]?.capability);
      expect(hostCaptures[i]?.status).toBe(wfCaptures[i]?.status);
      expect(hostCaptures[i]?.rawByteSize).toBe(wfCaptures[i]?.rawByteSize);
      expect(hostCaptures[i]?.rawBlobRef).toMatch(/^data-capture:default:/);
    }
    // Cross-residency raw read: the host's DO-shaped storage never
    // saw the workflow run's metadata, but the bytes are in R2.
    const wfRef = wfCaptures[0]!.rawBlobRef!;
    const hostRead = await getCaptureBlob(
      { REPORTS_BUCKET: wf.bucket as never },
      hostStorage as unknown as CaptureBlobStorage,
      wfRef,
    );
    expect(hostRead).not.toBeNull();
    // The raw payload is the provider's result: the quotes array.
    const rawQuotes = JSON.parse(new TextDecoder().decode(hostRead!)) as {
      symbol: string;
      price: number;
    }[];
    expect(
      rawQuotes.map((q) => ({ symbol: q.symbol, price: q.price })).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    ).toEqual([
      { symbol: "AAPL", price: 150.25 },
      { symbol: "MSFT", price: 300.5 },
    ]);
  });

  it("R2 unbound in workflow residency still refuses by name", async () => {
    const mock = new MockD1Database();
    await ensureProviderCaptureSchema(createD1ProviderCaptureDb(mock as never));
    await seedUniverse(mock);
    const env = { AGENT_DB: mock } as unknown as Env;
    const deps = feedStepDepsForWorkflow(env, createJobPipelineStoresFromD1(mock as never));
    expect(deps.providerFor(yahooDef())).toBeUndefined();
    const { outcome } = await runYahooQuotes(deps);
    expect(outcome.state).toBe("failed");
    expect(outcome.error ?? "").toContain("FEED_JOB_NOT_CONFIGURED");
  });

  it("no AGENT_DB in workflow residency still refuses by name (dataset store unbound)", async () => {
    const bucket = makeFakeBucket();
    const env = { REPORTS_BUCKET: bucket } as unknown as Env;
    // The dataset store is null without AGENT_DB; the stores
    // object below is only the shardsFor lookup (never called
    // on a monolith run).
    const storesMock = new MockD1Database();
    const deps = feedStepDepsForWorkflow(env, createJobPipelineStoresFromD1(storesMock as never));
    expect(deps.datasetStore).toBeNull();
    expect(deps.providerFor(yahooDef())).toBeUndefined();
  });

  it("E*TRADE in workflow residency needs the configured service login", async () => {
    const mock = new MockD1Database();
    const bucket = makeFakeBucket();
    const plain = { AGENT_DB: mock, REPORTS_BUCKET: bucket } as unknown as Env;
    const plainDeps = feedStepDepsForWorkflow(plain, createJobPipelineStoresFromD1(mock as never));
    expect(plainDeps.providerFor(etradeDef())).toBeUndefined();
    const withLogin = {
      AGENT_DB: mock,
      REPORTS_BUCKET: bucket,
      SERVICE_USER_LOGIN: "svc-test",
    } as unknown as Env;
    const loginDeps = feedStepDepsForWorkflow(withLogin, createJobPipelineStoresFromD1(mock as never));
    expect(loginDeps.providerFor(etradeDef())?.id).toBe("etrade");
  });

  it("the workflow feed wiring carries the Worker env through (sentiment parity)", async () => {
    const mock = new MockD1Database();
    const bucket = makeFakeBucket();
    const env = { AGENT_DB: mock, REPORTS_BUCKET: bucket } as unknown as Env;
    const deps = feedStepDepsForWorkflow(env, createJobPipelineStoresFromD1(mock as never));
    expect(deps.env).toBe(env);
  });
});
