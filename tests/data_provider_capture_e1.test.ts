/**
 * Issue #1133 (E1 of epic #1116) — E*TRADE capture pins.
 *
 *  - Every E*TRADE retrieval routed through the platform (the P1
 *    adapter wired with capture deps) writes a capture: the provider's
 *    raw response and the normalized result, linked to the run that
 *    fetched them (mas_data_captures metadata + blob-seam payload).
 *  - Raw is byte-faithful AT THE SEAM THE PLATFORM CAN REACH: for both
 *    capabilities the adapter requests the REST client's
 *    includeRawResponse hook — pre-existing for optionsChains, added
 *    for quotes (fetchQuoteDetailed, forwarded by ETradeService
 *    .getQuoteAsync / fetchQuoteRemote) — so the stored raw payload is
 *    the client's parsed response object (OptionChainResponse /
 *    QuoteResponse) serialized exactly as received. When a wrapped
 *    surface does not honor the hook, the capture falls back to the
 *    service's result object. The capture row's rawKind records which
 *    seam supplied the raw ("provider-response" vs "provider-result").
 *  - A fetch with no caller run context is still captured, under a
 *    generated collection-run id; tenant scope defaults to "default".
 *  - Captures are queryable by runId (exactly that run's captures), by
 *    provider, and by capability; every query is tenant-scoped — a
 *    cross-tenant query returns nothing.
 *  - Capture failure is visible, never silent, never fatal: a failed
 *    capture write leaves the fetch result intact and records a
 *    queryable failure marker (status "capture_failed").
 *  - Every capture row carries a retention classification from day one
 *    (assessment-01 §8.1 classes; default "retained-365d").
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import { DatabaseORM } from "../src/orm";
import { ETradeService } from "../src/services/etrade";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { createETradeDataProvider } from "../src/trading/dataProviders/adapters";
import {
  DATA_CAPTURE_TABLE,
  ensureCaptureTable,
  recordCapture,
  getCaptureById,
  listCapturesByRun,
  listCapturesByProvider,
  listCapturesByCapability,
  listCaptureFailures,
  readCaptureRaw,
  generateCollectionRunId,
  resolveRunContext,
  canonicalJson,
} from "../src/trading/dataProviders/captureStore";
import type {
  Env,
  ETradeQuote,
  ETradeOptionChain,
  ETradeBrokerStatus,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures — recorded-shape E*TRADE surface results (no live calls).
// ---------------------------------------------------------------------------

const etradeQuoteFixture = {
  symbol: "AAPL",
  companyName: "Apple Inc.",
  lastPrice: 232.5,
  change: 1.2,
  changePercent: 0.52,
  bid: 232.4,
  ask: 232.6,
  volume: 1_000_000,
  open: 230.0,
  high: 233.0,
  low: 229.0,
  timestamp: "2026-10-23T13:30:00.000Z",
} as unknown as ETradeQuote;

const etradeChainFixture = {
  symbol: "AAPL",
  underlyingPrice: 232.5,
  pairs: [
    {
      call: {
        optionType: "CALL",
        strikePrice: 230,
        symbol: "AAPL",
        bid: 4.1,
        ask: 4.3,
        lastPrice: 4.2,
      },
    },
  ],
} as unknown as ETradeOptionChain;

/**
 * The OptionChainResponse object the REST client's includeRawResponse
 * hook attaches to the chain (client.ts) — the pre-normalization
 * provider response the capture must store byte-for-byte.
 */
const rawChainResponseFixture = {
  OptionPair: [
    {
      Call: {
        symbol: "AAPL---261120C00230000",
        strikePrice: 230,
        bid: 4.1,
        ask: 4.3,
        lastPrice: 4.2,
        OptionGreeks: { delta: 0.55, iv: 0.24 },
      },
      Put: {
        symbol: "AAPL---261120P00230000",
        strikePrice: 230,
        bid: 1.8,
        ask: 2.0,
        lastPrice: 1.9,
        OptionGreeks: { delta: -0.45, iv: 0.25 },
      },
    },
  ],
  nearPrice: 232.5,
  SelectedED: { year: 2026, month: 11, day: 20 },
  timeStamp: 1761240600,
};

/**
 * The QuoteResponse object the REST client's includeRawResponse hook
 * attaches to the quote (fetchQuoteDetailed) — the parsed wire payload
 * the normalized ETradeQuote was derived from. It deliberately carries
 * fields normalization DROPS (bidAskDate, securityType, the
 * wireOnlySentinel, the QuoteResponse wrapper itself), so a capture
 * holding these bytes provably holds the wire object, not the
 * normalized result.
 */
const rawQuoteResponseFixture = {
  QuoteResponse: {
    QuoteData: [
      {
        All: {
          symbol: "AAPL",
          companyName: "Apple Inc.",
          lastTrade: 232.5,
          changeClose: 1.2,
          changeClosePercentage: 0.52,
          bid: 232.4,
          ask: 232.6,
          totalVolume: 1000000,
          open: 230.0,
          high: 233.0,
          low: 229.0,
          high52: 265.0,
          low52: 169.0,
          bidAskDate: "2026-10-23 13:30:00",
          securityType: "EQ",
          wireOnlySentinel: "dropped-by-normalization",
        },
        Product: { symbol: "AAPL", securityType: "EQ" },
        dateTime: "23 Oct 2026 13:30:00 EDT",
        quoteStatus: "REALTIME",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Fakes — the wrapped E*TRADE surface and the blob storage seam.
// ---------------------------------------------------------------------------

function fakeETradeService(
  opts: { nullChain?: boolean; honorRaw?: boolean; honorQuoteRaw?: boolean } = {}
) {
  const honorRaw = opts.honorRaw ?? true;
  const honorQuoteRaw = opts.honorQuoteRaw ?? false;
  return {
    getQuoteAsync: async (_symbol: string, options?: any) => {
      if (honorQuoteRaw && options?.includeRawResponse) {
        return { ...etradeQuoteFixture, raw: rawQuoteResponseFixture };
      }
      return etradeQuoteFixture;
    },
    getOptionChains: async (params: any) => {
      if (opts.nullChain) return null;
      if (honorRaw && params?.includeRawResponse) {
        return { ...etradeChainFixture, raw: rawChainResponseFixture };
      }
      return etradeChainFixture;
    },
    getStatus: () =>
      ({ broker: "etrade", configured: true }) as unknown as ETradeBrokerStatus,
  };
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

function failingBlobStorage() {
  return {
    get: async (_key: string) => undefined,
    put: async (_key: string, _value: unknown) => {
      throw new Error("forced blob put failure");
    },
  };
}

function freshSql() {
  return new MockSqlStorage() as any;
}

function captureDeps(sql: any, storage: any = fakeBlobStorage(), extra: any = {}) {
  return { sql, blobStorage: storage, env: {}, ...extra };
}

function capturingProvider(sql: any, deps: any = captureDeps(sql), service: any = fakeETradeService()) {
  return createETradeDataProvider(service as any, { capture: deps });
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Capture store
// ---------------------------------------------------------------------------

describe("provider capture store (issue #1133)", () => {
  it("creates the mas_data_captures table", () => {
    const sql = freshSql();
    const executed: string[] = [];
    const recording = {
      exec: (q: string, ...args: any[]) => {
        executed.push(q);
        return sql.exec(q, ...args);
      },
    };
    ensureCaptureTable(recording as any);
    expect(DATA_CAPTURE_TABLE).toBe("mas_data_captures");
    expect(
      executed.some((q) =>
        /CREATE TABLE IF NOT EXISTS mas_data_captures\b/i.test(q)
      )
    ).toBe(true);
  });

  it("write → read round-trip: metadata fields and byte-identical raw payload", async () => {
    const sql = freshSql();
    const storage = fakeBlobStorage();
    const rawPayload = { hello: "world", n: 42, nested: { ok: true } };
    const record = await recordCapture(
      sql,
      { storage, env: {} },
      {
        providerId: "etrade",
        capability: "quotes",
        requestParams: { symbol: "AAPL" },
        runId: "run-direct",
        tenantId: "tenant-a",
        userLogin: "trader1",
        rawPayload,
        rawKind: "provider-response",
        normalizedResult: { symbol: "AAPL", lastPrice: 232.5 },
        fetchedAt: "2026-10-23T13:31:00.000Z",
      }
    );
    expect(record.status).toBe("captured");
    expect(record.providerId).toBe("etrade");
    expect(record.capability).toBe("quotes");
    expect(record.runId).toBe("run-direct");
    expect(record.tenantId).toBe("tenant-a");
    expect(record.userLogin).toBe("trader1");
    expect(record.requestParams).toEqual({ symbol: "AAPL" });
    expect(record.rawKind).toBe("provider-response");
    expect(record.retentionClass).toBe("retained-365d");
    expect(record.failureError).toBeNull();

    const expectedBytes = encodeJson(rawPayload);
    expect(record.rawByteSize).toBe(expectedBytes.byteLength);
    expect(record.rawSha256).toBe(await sha256HexOf(expectedBytes));

    const back = getCaptureById(sql, "tenant-a", record.id);
    expect(back).toEqual(record);

    const read = await readCaptureRaw(sql, { storage, env: {} }, "tenant-a", record.id);
    expect(read).not.toBeNull();
    expect(read!.record).toEqual(record);
    expect(read!.rawBytes).toEqual(expectedBytes);
  });

  it("canonicalJson is key-order independent (normalized digest form)", () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":1}'
    );
    expect(canonicalJson({ a: { c: 3, d: 4 }, b: 1 })).toBe(
      canonicalJson({ b: 1, a: { d: 4, c: 3 } })
    );
  });

  it("generated collection-run ids are prefixed and unique; run context resolves defaults", () => {
    const a = generateCollectionRunId();
    const b = generateCollectionRunId();
    expect(a).toMatch(/^collection-/);
    expect(a).not.toBe(b);
    const resolved = resolveRunContext(undefined);
    expect(resolved.runId).toMatch(/^collection-/);
    expect(resolved.tenantId).toBe("default");
    expect(resolved.userLogin).toBeNull();
    const supplied = resolveRunContext({
      runId: "run-9",
      tenantId: "tenant-x",
      userLogin: "u1",
    });
    expect(supplied).toEqual({
      runId: "run-9",
      tenantId: "tenant-x",
      userLogin: "u1",
    });
  });
});

// ---------------------------------------------------------------------------
// Capture on fetch — the E*TRADE adapter wired with capture deps
// ---------------------------------------------------------------------------

describe("etrade capture-on-fetch (issue #1133)", () => {
  it("a quote fetch writes a capture whose raw payload reads back byte-identical", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const provider = capturingProvider(sql, deps);
    const envelope = await provider.getQuote!("AAPL", {
      runId: "run-1",
      tenantId: "tenant-a",
      userLogin: "trader1",
    });
    // The fetch itself is untouched: the service's result, by reference.
    expect(envelope.providerId).toBe("etrade");
    expect(envelope.result).toBe(etradeQuoteFixture);

    const captures = listCapturesByRun(sql, "tenant-a", "run-1");
    expect(captures).toHaveLength(1);
    const record = captures[0];
    expect(record.capability).toBe("quotes");
    expect(record.providerId).toBe("etrade");
    expect(record.userLogin).toBe("trader1");
    expect(record.requestParams).toEqual({ symbol: "AAPL" });
    expect(record.status).toBe("captured");
    expect(record.rawKind).toBe("provider-result");
    expect(record.retentionClass).toBe("retained-365d");

    // Raw = the seam payload serialized exactly as received.
    const expectedBytes = encodeJson(etradeQuoteFixture);
    expect(record.rawSha256).toBe(await sha256HexOf(expectedBytes));
    const read = await readCaptureRaw(
      sql,
      { storage: deps.blobStorage, env: {} },
      "tenant-a",
      record.id
    );
    expect(read!.rawBytes).toEqual(expectedBytes);
    // The normalized digest matches the result the caller received.
    expect(record.normalizedDigest).toBe(
      await sha256HexOf(new TextEncoder().encode(canonicalJson(etradeQuoteFixture)))
    );
  });

  it("a quote fetch captures the client's raw wire payload byte-for-byte when the surface honors includeRawResponse", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const provider = capturingProvider(
      sql,
      deps,
      fakeETradeService({ honorQuoteRaw: true })
    );
    const envelope = await provider.getQuote!("AAPL", {
      runId: "run-quote-raw",
      tenantId: "tenant-a",
      userLogin: "trader1",
    });
    // The caller receives the normalized quote — the raw echo the
    // includeRawResponse hook attached is captured, not leaked into
    // the result (the chains behaviour, mirrored for quotes).
    expect(envelope.providerId).toBe("etrade");
    expect(envelope.result).toEqual(etradeQuoteFixture);
    expect((envelope.result as any).raw).toBeUndefined();

    const captures = listCapturesByRun(sql, "tenant-a", "run-quote-raw");
    expect(captures).toHaveLength(1);
    const record = captures[0];
    expect(record.capability).toBe("quotes");
    expect(record.providerId).toBe("etrade");
    expect(record.userLogin).toBe("trader1");
    expect(record.requestParams).toEqual({ symbol: "AAPL" });
    expect(record.status).toBe("captured");
    expect(record.rawKind).toBe("provider-response");

    // Raw bytes + SHA-256 are the WIRE payload's — provably distinct
    // from the normalized result's bytes: the wire object carries
    // fields normalization drops (wireOnlySentinel, bidAskDate).
    const expectedBytes = encodeJson(rawQuoteResponseFixture);
    expect(expectedBytes).not.toEqual(encodeJson(etradeQuoteFixture));
    expect(record.rawByteSize).toBe(expectedBytes.byteLength);
    expect(record.rawSha256).toBe(await sha256HexOf(expectedBytes));
    const read = await readCaptureRaw(
      sql,
      { storage: deps.blobStorage, env: {} },
      "tenant-a",
      record.id
    );
    expect(read!.rawBytes).toEqual(expectedBytes);
    const decoded = new TextDecoder().decode(read!.rawBytes);
    expect(decoded).toContain("wireOnlySentinel");
    expect(JSON.parse(decoded)).toEqual(rawQuoteResponseFixture);
    // The normalized digest matches the quote the caller received
    // (raw echo stripped before digesting).
    expect(record.normalizedDigest).toBe(
      await sha256HexOf(new TextEncoder().encode(canonicalJson(etradeQuoteFixture)))
    );
  });

  it("an options-chain fetch captures the client's raw OptionChainResponse byte-for-byte", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const provider = capturingProvider(sql, deps);
    const envelope = await provider.getOptionsChain!(
      { symbol: "AAPL", chainType: "CALLPUT" },
      { runId: "run-chain", tenantId: "tenant-a" }
    );
    // The caller receives the normalized chain — the raw echo the
    // includeRawResponse hook attached is captured, not leaked into
    // the result.
    expect(envelope.result).toEqual(etradeChainFixture);
    expect((envelope.result as any).raw).toBeUndefined();
    expect((envelope.result as any).pairs).toBe(etradeChainFixture.pairs);

    const captures = listCapturesByRun(sql, "tenant-a", "run-chain");
    expect(captures).toHaveLength(1);
    const record = captures[0];
    expect(record.capability).toBe("optionsChains");
    expect(record.rawKind).toBe("provider-response");
    expect(record.requestParams).toEqual({
      symbol: "AAPL",
      chainType: "CALLPUT",
    });

    const expectedBytes = encodeJson(rawChainResponseFixture);
    expect(record.rawByteSize).toBe(expectedBytes.byteLength);
    expect(record.rawSha256).toBe(await sha256HexOf(expectedBytes));
    const read = await readCaptureRaw(
      sql,
      { storage: deps.blobStorage, env: {} },
      "tenant-a",
      record.id
    );
    expect(read!.rawBytes).toEqual(expectedBytes);
  });

  it("a fetch with no run context is captured under a generated collection-run id", async () => {
    const sql = freshSql();
    const provider = capturingProvider(sql);
    await provider.getQuote!("MSFT");
    const byProvider = listCapturesByProvider(sql, "default", "etrade");
    expect(byProvider).toHaveLength(1);
    expect(byProvider[0].runId).toMatch(/^collection-/);
    expect(byProvider[0].tenantId).toBe("default");
    // …and the generated id is a real run key: the run query finds it.
    expect(listCapturesByRun(sql, "default", byProvider[0].runId)).toHaveLength(1);
  });

  it("queries separate captures exactly: by run, by provider, by capability", async () => {
    const sql = freshSql();
    const provider = capturingProvider(sql);
    await provider.getQuote!("AAPL", { runId: "run-1", tenantId: "tenant-a" });
    await provider.getOptionsChain!(
      { symbol: "AAPL" },
      { runId: "run-1", tenantId: "tenant-a" }
    );
    await provider.getQuote!("MSFT", { runId: "run-2", tenantId: "tenant-a" });

    const run1 = listCapturesByRun(sql, "tenant-a", "run-1");
    expect(run1.map((c) => c.capability).sort()).toEqual([
      "optionsChains",
      "quotes",
    ]);
    const run2 = listCapturesByRun(sql, "tenant-a", "run-2");
    expect(run2).toHaveLength(1);
    expect(run2[0].capability).toBe("quotes");
    // No bleed between runs.
    expect(new Set(run1.map((c) => c.id)).size).toBe(2);
    expect(run1.some((c) => c.id === run2[0].id)).toBe(false);

    expect(listCapturesByProvider(sql, "tenant-a", "etrade")).toHaveLength(3);
    expect(listCapturesByProvider(sql, "tenant-a", "yahoo")).toHaveLength(0);
    expect(listCapturesByCapability(sql, "tenant-a", "quotes")).toHaveLength(2);
    expect(
      listCapturesByCapability(sql, "tenant-a", "optionsChains")
    ).toHaveLength(1);
  });

  it("tenant isolation: another tenant's queries return nothing", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const provider = capturingProvider(sql, deps);
    await provider.getQuote!("AAPL", { runId: "run-1", tenantId: "tenant-a" });
    const [record] = listCapturesByRun(sql, "tenant-a", "run-1");
    expect(record).toBeDefined();

    expect(listCapturesByRun(sql, "tenant-b", "run-1")).toHaveLength(0);
    expect(listCapturesByProvider(sql, "tenant-b", "etrade")).toHaveLength(0);
    expect(listCapturesByCapability(sql, "tenant-b", "quotes")).toHaveLength(0);
    expect(listCaptureFailures(sql, "tenant-b")).toHaveLength(0);
    expect(getCaptureById(sql, "tenant-b", record.id)).toBeNull();
    expect(
      await readCaptureRaw(sql, { storage: deps.blobStorage, env: {} }, "tenant-b", record.id)
    ).toBeNull();
  });

  it("retention classification is stored on every row and honors the deps override", async () => {
    const sql = freshSql();
    const provider = capturingProvider(
      sql,
      captureDeps(sql, fakeBlobStorage(), { retentionClass: "permanent-audit" })
    );
    await provider.getQuote!("AAPL", { runId: "run-r", tenantId: "tenant-a" });
    const [record] = listCapturesByRun(sql, "tenant-a", "run-r");
    expect(record.retentionClass).toBe("permanent-audit");
  });

  it("a null chain (provider has no chain) still leaves an audit row — status no_payload, no fabricated raw", async () => {
    const sql = freshSql();
    const provider = capturingProvider(
      sql,
      captureDeps(sql),
      fakeETradeService({ nullChain: true })
    );
    const envelope = await provider.getOptionsChain!(
      { symbol: "ZZZZ" },
      { runId: "run-null", tenantId: "tenant-a" }
    );
    expect(envelope.result).toBeNull();
    const captures = listCapturesByRun(sql, "tenant-a", "run-null");
    expect(captures).toHaveLength(1);
    expect(captures[0].status).toBe("no_payload");
    expect(captures[0].rawBlobRef).toBeNull();
    expect(captures[0].rawSha256).toBeNull();
    // A no-payload outcome is not a capture failure.
    expect(listCaptureFailures(sql, "tenant-a")).toHaveLength(0);
  });

  it("when the wrapped surface does not honor includeRawResponse, capture falls back to the result object, honestly labeled", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const provider = capturingProvider(
      sql,
      deps,
      fakeETradeService({ honorRaw: false })
    );
    const envelope = await provider.getOptionsChain!(
      { symbol: "AAPL" },
      { runId: "run-fallback", tenantId: "tenant-a" }
    );
    expect(envelope.result).toBe(etradeChainFixture);
    const [record] = listCapturesByRun(sql, "tenant-a", "run-fallback");
    expect(record.status).toBe("captured");
    expect(record.rawKind).toBe("provider-result");
    const read = await readCaptureRaw(
      sql,
      { storage: deps.blobStorage, env: {} },
      "tenant-a",
      record.id
    );
    expect(read!.rawBytes).toEqual(encodeJson(etradeChainFixture));
  });
});

// ---------------------------------------------------------------------------
// Capture failure: visible, queryable, never fatal to the fetch
// ---------------------------------------------------------------------------

describe("capture failure semantics (issue #1133)", () => {
  it("a failed blob write leaves the fetch intact and records a queryable failure marker", async () => {
    const sql = freshSql();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = capturingProvider(
        sql,
        captureDeps(sql, failingBlobStorage())
      );
      const envelope = await provider.getQuote!("AAPL", {
        runId: "run-fail",
        tenantId: "tenant-a",
      });
      // Fetch survival: the caller still gets the service's result.
      expect(envelope.result).toBe(etradeQuoteFixture);

      const failures = listCaptureFailures(sql, "tenant-a");
      expect(failures).toHaveLength(1);
      expect(failures[0].status).toBe("capture_failed");
      expect(failures[0].runId).toBe("run-fail");
      expect(failures[0].capability).toBe("quotes");
      expect(failures[0].failureError).toMatch(/forced blob put failure/);
      expect(failures[0].rawBlobRef).toBeNull();
      // The marker is also what the run query returns — the run's audit
      // trail shows the gap instead of silently missing the fetch.
      expect(listCapturesByRun(sql, "tenant-a", "run-fail")).toHaveLength(1);
      // The failure was logged in structured form, not swallowed.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("even a totally broken capture store cannot fail the fetch", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const brokenSql: any = {
        exec: () => {
          throw new Error("forced sql failure");
        },
      };
      const provider = capturingProvider(
        brokenSql,
        captureDeps(brokenSql)
      );
      const envelope = await provider.getQuote!("AAPL", {
        runId: "run-broken",
        tenantId: "tenant-a",
      });
      expect(envelope.result).toBe(etradeQuoteFixture);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The quote raw hook itself — real client + real service forwarding
// (the delta that lets quotes capture "provider-response" at all)
// ---------------------------------------------------------------------------

describe("quote includeRawResponse hook (issue #1133)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function hookTestEnv() {
    const userLogin = "test_trader_quote_raw_hook";
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
    const env = {
      APP_NAME: "cfagent-test",
      APP_BASE_URL: "https://agent.openaimp.com",
      SESSION_SECRET: "test-session-secret",
      GITHUB_CLIENT_ID: "gh_id",
      GITHUB_CLIENT_SECRET: "gh_secret",
      AI_SEARCH_ENDPOINT: "https://ai.example.com",
      SESSION_STORE: sessionStoreNs,
      ETRADE_KV: mockKv,
      ORCHESTRATOR_AGENT: {} as any,
      ASSETS: {} as any,
      AI: {} as any,
      APP_ENV: "TEST",
      ET_API_KEY: "test_api_key",
      ET_API_SECRET: "test_api_secret",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_ACCOUNT_ID_KEY: "ACCOUNT_KEY_XYZ999",
    } as unknown as Env;
    return { env, userLogin };
  }

  it("client: fetchQuoteDetailed attaches the parsed wire payload as raw ONLY when includeRawResponse is requested", async () => {
    const { env, userLogin } = hookTestEnv();
    await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
    const client = new ETradeRestClient(env, userLogin);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify(rawQuoteResponseFixture), {
          status: 200,
        })
    );

    // Default path — every existing caller: no raw field is attached
    // and the result shape is exactly the normalized quote.
    const plain = await client.fetchQuoteDetailed("AAPL");
    expect(plain.error).toBeNull();
    expect(plain.quote).not.toBeNull();
    expect(plain.quote!.symbol).toBe("AAPL");
    expect(plain.quote!.lastPrice).toBe(232.5);
    expect(plain.quote!.companyName).toBe("Apple Inc.");
    expect("raw" in (plain.quote as any)).toBe(false);

    // Hooked path: the quote carries the parsed wire payload — the
    // very object normalization consumed, dropped fields and all —
    // while normalization itself is unchanged.
    const hooked = await client.fetchQuoteDetailed("AAPL", {
      includeRawResponse: true,
    });
    expect(hooked.error).toBeNull();
    expect(hooked.quote!.symbol).toBe("AAPL");
    expect(hooked.quote!.lastPrice).toBe(232.5);
    expect((hooked.quote as any).raw).toEqual(rawQuoteResponseFixture);
    expect(
      (hooked.quote as any).raw.QuoteResponse.QuoteData[0].All
        .wireOnlySentinel
    ).toBe("dropped-by-normalization");
  });

  it("service: getQuoteAsync forwards includeRawResponse through fetchQuoteRemote; a default call requests nothing", async () => {
    const liveEnv = {
      APP_BASE_URL: "https://agent.openaimp.com",
      ETRADE_ENVIRONMENT: "live",
    } as Env;
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("e1_quote_raw_hook");
    const service = new ETradeService(orm, liveEnv, "test-user");
    const seenOptions: unknown[] = [];
    (service.client as any).fetchQuoteDetailed = async (
      _symbol: string,
      options?: any
    ) => {
      seenOptions.push(options);
      const quote: any = { ...etradeQuoteFixture };
      if (options?.includeRawResponse) quote.raw = rawQuoteResponseFixture;
      return { quote, error: null };
    };

    const hooked = await service.getQuoteAsync("AAPL", {
      includeRawResponse: true,
    });
    expect(seenOptions[0]).toEqual({ includeRawResponse: true });
    expect((hooked as any).raw).toEqual(rawQuoteResponseFixture);
    expect(hooked.lastPrice).toBe(etradeQuoteFixture.lastPrice);

    const plain = await service.getQuoteAsync("AAPL");
    expect(seenOptions[1]).toBeUndefined();
    expect("raw" in (plain as any)).toBe(false);
  });
});
