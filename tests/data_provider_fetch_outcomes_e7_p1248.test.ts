/** @vitest-environment jsdom */
/**
 * Issue #1248 (E7 of epic #1116) — fetch-outcome tracking: every
 * platform fetch records its outcome, success AND failure.
 *
 * E1 recorded only fetches that succeeded (a capture row) or whose
 * capture WRITE failed (a capture_failed marker): a fetch that
 * THREW wrote no row at all, so E6 health saw provider failures
 * only as staleness. This slice closes the hole:
 *
 *  - a narrow PORT (FetchOutcomeRecorder) injected through the
 *    existing capture-deps seam, implemented by the capture store;
 *  - ONE decorator (trackFetchOutcome) at every adapter fetch
 *    boundary: success → the existing capture row is the record
 *    (no double-writing); throw → classify (pure Strategy) →
 *    record one fetch_failed row → rethrow the IDENTICAL error;
 *  - failure rows carry a classified kind and a bounded (≤200
 *    chars), credential-scrubbed message, and store no blob;
 *  - health projection v2: fetchAttempts / fetchFailures /
 *    fetchFailureRate / captureFailures (kept separate so
 *    "provider down" ≠ "our storage broke"), fetch-based
 *    lastFailureAt / streak semantics, latest failure kind;
 *  - verifier probes record outcomes through the same wrapper;
 *  - the panel renders the latest failure WITH its kind.
 *
 * Error identity is pinned by reference: the error an adapter
 * throws is the exact object the wrapped fetch threw.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MockSqlStorage } from "./mock-sql";
import {
  classifyFetchError,
  scrubFailureMessage,
  trackFetchOutcome,
  MAX_FAILURE_MESSAGE_LENGTH,
  type FetchOutcomeMeta,
  type FetchOutcomeRecorder,
} from "../src/trading/dataProviders/fetchOutcome";
import {
  recordCapture,
  recordFetchFailure,
  createCaptureFetchOutcomeRecorder,
  listCapturesByProvider,
  listFetchFailures,
  type DataCaptureRecord,
} from "../src/trading/dataProviders/captureStore";
import {
  aggregateProviderHealth,
  deriveProviderHealth,
  type CaptureAggregates,
} from "../src/trading/dataProviders/providerHealth";
import {
  createETradeDataProvider,
  createPublicDataProvider,
  createYahooDataProvider,
  createNasdaqDataProvider,
  verifyETradeDataProvider,
  verifyPublicDataProvider,
  type ETradeDataSurface,
} from "../src/trading/dataProviders/adapters";
import { bindEtradeQuoteDeps } from "../src/trading/screenerPipeline";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import { ETradeError, ETradeErrorCode } from "../src/aspects/errorCodes";
import { PublicMcpClient, PublicMcpError } from "../src/mcps/public/publicMcp";
import { PublicDataError } from "../src/services/publicData";
import type { Env, ETradeQuote } from "../src/types";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { __resetDefaultBreakerRegistry } from "../src/breakers/createBreakerPorts";
import type {
  DataProviderView,
} from "../src/client/dataProvidersApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "default";
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

function okBlobStorage() {
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
    get: async () => undefined,
    put: async () => {
      throw new Error("blob store unavailable");
    },
  };
}

const META: FetchOutcomeMeta = {
  providerId: "etrade",
  capability: "quotes",
  requestParams: { symbol: "AAPL" },
  runId: "run-e7",
  tenantId: TENANT,
  userLogin: "ops",
};

// ---------------------------------------------------------------------------
// Classifier (Strategy) — error shape → kind, table-pinned.
// ---------------------------------------------------------------------------

// Issue #1745: the public breaker is shared per isolate, and this
// file runs several public failure cases before success/probe tests
// — without a reset the tripped breaker would (correctly) change
// their outcomes. Resetting test state, not production behavior.
beforeEach(() => { __resetDefaultBreakerRegistry(); });

describe("classifyFetchError (issue #1248)", () => {
  it("maps E*TRADE's coded errors by their catalog code", () => {
    expect(classifyFetchError(new ETradeError(ETradeErrorCode.AUTH_REQUIRED))).toBe("auth");
    expect(classifyFetchError(new ETradeError(ETradeErrorCode.TOKEN_EXPIRED))).toBe("auth");
    expect(classifyFetchError(new ETradeError(ETradeErrorCode.CREDENTIALS_MISSING))).toBe("auth");
    expect(classifyFetchError(new ETradeError(ETradeErrorCode.UNAUTHORIZED_ACTION))).toBe("auth");
    expect(classifyFetchError(new ETradeError(ETradeErrorCode.RATE_LIMITED))).toBe("rate_limit");
    expect(classifyFetchError(new ETradeError(ETradeErrorCode.UPSTREAM_ERROR))).toBe("upstream");
  });

  it("maps HTTP statuses deterministically (status / httpStatus carriers)", () => {
    const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
    const withHttpStatus = (httpStatus: number) =>
      Object.assign(new Error(`HTTP ${httpStatus}`), { httpStatus });
    expect(classifyFetchError(withStatus(401))).toBe("auth");
    expect(classifyFetchError(withStatus(403))).toBe("auth");
    expect(classifyFetchError(withHttpStatus(429))).toBe("rate_limit");
    expect(classifyFetchError(withStatus(408))).toBe("timeout");
    expect(classifyFetchError(withStatus(500))).toBe("upstream");
    expect(classifyFetchError(withStatus(502))).toBe("upstream");
    expect(classifyFetchError(withStatus(503))).toBe("upstream");
    expect(classifyFetchError(withStatus(400))).toBe("upstream");
    expect(classifyFetchError(withStatus(404))).toBe("upstream");
  });

  it("maps Public's MCP errors: 401 naming is auth, JSON-RPC errors are upstream, unparseable is parse", () => {
    expect(
      classifyFetchError(new PublicMcpError("Public.com tools/call failed (401): the access token was rejected.", 401))
    ).toBe("auth");
    expect(classifyFetchError(new PublicMcpError("Public.com tools/call failed (429): slow down", 429))).toBe(
      "rate_limit"
    );
    expect(classifyFetchError(new PublicMcpError("Public.com tools/call failed (503): down", 503))).toBe("upstream");
    expect(
      classifyFetchError(
        new PublicMcpError(
          "no Public.com credential is available for this user (connect Public in Settings, or store a personal access token); the MCP server was not called."
        )
      )
    ).toBe("auth");
    expect(
      classifyFetchError(new PublicMcpError('Public.com tools/call error: {"code":-32601,"message":"method not found"}'))
    ).toBe("upstream");
    expect(classifyFetchError(new PublicMcpError("unparseable MCP response: <html>oops</html>"))).toBe("parse");
    expect(
      classifyFetchError(
        new PublicMcpError('tool "place_order" is not on the Public data allow-list; the data provider is read-only by construction and never calls it.')
      )
    ).toBe("unknown");
  });

  it("maps Public's payload/mapping errors to parse", () => {
    expect(classifyFetchError(new PublicDataError("get_quotes requires account_id, which could not be mapped from its declared schema."))).toBe("parse");
    expect(classifyFetchError(new PublicDataError("Public.com get_quotes returned no usable quote for AAPL."))).toBe("parse");
  });

  it("maps transport shapes: aborts/timeouts, network TypeErrors, JSON SyntaxErrors", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifyFetchError(abort)).toBe("timeout");
    const timeoutDom = new Error("timed out");
    timeoutDom.name = "TimeoutError";
    expect(classifyFetchError(timeoutDom)).toBe("timeout");
    expect(classifyFetchError(new Error("request timed out after 30000ms"))).toBe("timeout");
    expect(classifyFetchError(new TypeError("fetch failed"))).toBe("network");
    expect(classifyFetchError(new Error("socket hang up"))).toBe("network");
    expect(classifyFetchError(new Error("getaddrinfo ENOTFOUND api.etrade.com"))).toBe("network");
    expect(classifyFetchError(new SyntaxError("Unexpected token < in JSON at position 0"))).toBe("parse");
  });

  it("falls back to unknown for unclassifiable shapes — never guesses", () => {
    expect(classifyFetchError(new Error("E*TRADE returned no live quote for ZZZZ"))).toBe("unknown");
    expect(classifyFetchError(new Error("something entirely bespoke"))).toBe("unknown");
    expect(classifyFetchError(null)).toBe("unknown");
    expect(classifyFetchError(undefined)).toBe("unknown");
    expect(classifyFetchError(42)).toBe("unknown");
    expect(classifyFetchError("rate limit exceeded")).toBe("rate_limit");
  });
});

// ---------------------------------------------------------------------------
// Scrubber — no credential material survives into a stored message.
// ---------------------------------------------------------------------------

describe("scrubFailureMessage (issue #1248)", () => {
  it("strips bearer tokens and authorization headers", () => {
    const out = scrubFailureMessage("call failed with Authorization: Bearer abcdef0123456789 tail");
    expect(out).not.toContain("abcdef0123456789");
    expect(out).toContain("call failed");
    const out2 = scrubFailureMessage("headers { authorization: 'Bearer xyz987' } rejected");
    expect(out2).not.toContain("xyz987");
  });

  it("strips key=value credential forms", () => {
    const out = scrubFailureMessage("upstream said api_key=AKIAEXAMPLE123456 was refused");
    expect(out).not.toContain("AKIAEXAMPLE123456");
    const out2 = scrubFailureMessage('token: "hunter2hunter2" is invalid');
    expect(out2).not.toContain("hunter2hunter2");
    // Fragment-assembled like the hostile fixture below: the VALUE is
    // secret-shaped (the scrubber must strip it) but no secret-shaped
    // literal enters the source (the Gitleaks full-range rule).
    const rtValue = ["rt", "abcdef", "1234567890"].join("-");
    const out3 = scrubFailureMessage(`refresh_token=${rtValue} expired`);
    expect(out3).not.toContain(rtValue);
  });

  it("strips secret-shaped values assembled from fragments (hostile fixture)", () => {
    // Assembled at runtime so no secret-shaped literal enters the
    // source (the Gitleaks full-range rule): the VALUE is hostile,
    // the fixture text is not.
    const hostile = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("-");
    const hexSecret = ["deadbeef", "cafebabe", "0123456789abcdef", "ff00ff00"].join("");
    const jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "sigpart"].join(".");
    const out = scrubFailureMessage(
      `auth failed for key ${hostile}; hex ${hexSecret}; jwt ${jwt}; end`
    );
    expect(out).not.toContain("4eC39HqLyjWDarjtT1zdp7dc");
    expect(out).not.toContain(hexSecret);
    expect(out).not.toContain("eyJzdWIiOiIxMjM0NTY3ODkwIn0");
    expect(out).toContain("auth failed for key");
    expect(out).toContain("end");
  });

  it("leaves ordinary failure text intact and bounds length at the cap", () => {
    const plain = "E*TRADE session expired at midnight US Eastern Time.";
    expect(scrubFailureMessage(plain)).toBe(plain);
    const long = "upstream wobble ".repeat(60);
    const out = scrubFailureMessage(long);
    expect(out.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_LENGTH);
    expect(MAX_FAILURE_MESSAGE_LENGTH).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Decorator (trackFetchOutcome) — skeleton semantics + error identity.
// ---------------------------------------------------------------------------

describe("trackFetchOutcome (issue #1248)", () => {
  function spyRecorder(overrides: Partial<FetchOutcomeRecorder> = {}) {
    const calls: Array<{ method: string; meta: FetchOutcomeMeta; failure?: unknown }> = [];
    const recorder: FetchOutcomeRecorder = {
      recordSuccess: async (meta) => {
        calls.push({ method: "recordSuccess", meta });
      },
      recordFailure: async (meta, failure) => {
        calls.push({ method: "recordFailure", meta, failure });
      },
      ...overrides,
    };
    return { recorder, calls };
  }

  it("success: returns the fetch value untouched and records success only", async () => {
    const { recorder, calls } = spyRecorder();
    const value = { lastPrice: 232.5 };
    const out = await trackFetchOutcome(recorder, META, async () => value);
    expect(out).toBe(value);
    expect(calls.map((c) => c.method)).toEqual(["recordSuccess"]);
    expect(calls[0].meta).toBe(META);
  });

  it("failure: records the classified failure and rethrows the IDENTICAL error object", async () => {
    const { recorder, calls } = spyRecorder();
    const err = new ETradeError(ETradeErrorCode.TOKEN_EXPIRED);
    const caught = await trackFetchOutcome(recorder, META, async () => {
      throw err;
    }).catch((e) => e);
    expect(caught).toBe(err);
    expect(calls.map((c) => c.method)).toEqual(["recordFailure"]);
    expect((calls[0].failure as { kind: string }).kind).toBe("auth");
    expect((calls[0].failure as { message: string }).message).toBe(err.message);
  });

  it("a throwing recorder never alters the fetch outcome, in either direction", async () => {
    const broken: FetchOutcomeRecorder = {
      recordSuccess: async () => {
        throw new Error("recorder store down");
      },
      recordFailure: async () => {
        throw new Error("recorder store down");
      },
    };
    await expect(trackFetchOutcome(broken, META, async () => "fine")).resolves.toBe("fine");
    const err = new Error("the real failure");
    const caught = await trackFetchOutcome(broken, META, async () => {
      throw err;
    }).catch((e) => e);
    expect(caught).toBe(err);
  });
});

// ---------------------------------------------------------------------------
// Store — fetch_failed rows: shape, scrubbing at the boundary,
// never-throws, legacy rows, and the capture-store recorder.
// ---------------------------------------------------------------------------

describe("recordFetchFailure + capture-store recorder (issue #1248)", () => {
  it("writes exactly one fetch_failed row with kind, scrubbed message, and no blob", async () => {
    const sql = new MockSqlStorage();
    const hostile = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("-");
    const record = await recordFetchFailure(sql as any, {
      providerId: "etrade",
      capability: "quotes",
      requestParams: { symbol: "AAPL" },
      runId: "run-e7",
      tenantId: TENANT,
      userLogin: "ops",
      kind: "auth",
      message: `E*TRADE auth failed presenting ${hostile} to the broker`,
      fetchedAt: "2026-10-23T11:00:00.000Z",
    });
    expect(record.status).toBe("fetch_failed");
    expect(record.failureKind).toBe("auth");
    expect(record.failureMessage).toContain("E*TRADE auth failed");
    expect(record.failureMessage).not.toContain("4eC39HqLyjWDarjtT1zdp7dc");
    expect(record.failureMessage!.length).toBeLessThanOrEqual(200);
    expect(record.rawBlobRef).toBeNull();
    expect(record.rawByteSize).toBe(0);
    expect(record.rawSha256).toBeNull();
    expect(record.failureError).toBeNull();
    expect(record.retentionClass).toBe("retained-365d");
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(record.id);
    expect(listFetchFailures(sql as any, TENANT).map((r) => r.id)).toEqual([record.id]);
    // tenant-scoped like every capture read
    expect(listFetchFailures(sql as any, "other-tenant")).toEqual([]);
  });

  it("never throws when the store itself is broken — returns the unpersisted record", async () => {
    const brokenSql = {
      exec: () => {
        throw new Error("sql on fire");
      },
    };
    const record = await recordFetchFailure(brokenSql as any, {
      providerId: "public",
      capability: "quotes",
      requestParams: { tool: "get_quotes" },
      runId: "run-e7",
      tenantId: TENANT,
      kind: "network",
      message: "fetch failed",
    });
    expect(record.status).toBe("fetch_failed");
    expect(record.failureKind).toBe("network");
  });

  it("a pre-E7 capture row (no failure columns in its write) reads back with null kind/message", async () => {
    const sql = new MockSqlStorage();
    // The pre-E7 column set, written directly — as a row stored by
    // the E1-era code path exists on disk today.
    sql.exec(
      `INSERT INTO mas_data_captures
       (id, provider_id, capability, request_params_json, run_id, tenant_id, user_login, fetched_at, status, raw_kind, raw_blob_ref, raw_byte_size, raw_sha256, normalized_digest, retention_class, failure_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "legacy-1",
      "etrade",
      "quotes",
      "{}",
      "run-legacy",
      TENANT,
      "ops",
      "2026-10-22T09:00:00.000Z",
      "captured",
      "provider-result",
      null,
      12,
      null,
      null,
      "retained-365d",
      null,
      "2026-10-22T09:00:00.000Z"
    );
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].failureKind).toBeNull();
    expect(rows[0].failureMessage).toBeNull();
    // And new failure rows write fine alongside the legacy row.
    await recordFetchFailure(sql as any, {
      providerId: "etrade",
      capability: "quotes",
      requestParams: { symbol: "AAPL" },
      runId: "run-e7",
      tenantId: TENANT,
      kind: "timeout",
      message: "request timed out",
    });
    expect(listCapturesByProvider(sql as any, TENANT, "etrade")).toHaveLength(2);
  });

  it("the capture-store recorder: recordFailure writes the row; recordSuccess writes NO row", async () => {
    const sql = new MockSqlStorage();
    const recorder = createCaptureFetchOutcomeRecorder(sql as any);
    await recorder.recordSuccess(META);
    expect(listCapturesByProvider(sql as any, TENANT, "etrade")).toEqual([]);
    const err = new PublicMcpError("Public.com tools/call failed (429): slow down", 429);
    await recorder.recordFailure(META, { kind: "rate_limit", message: err.message });
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fetch_failed");
    expect(rows[0].failureKind).toBe("rate_limit");
    expect(rows[0].runId).toBe("run-e7");
  });

  it("the recorder never throws even when the underlying store is broken", async () => {
    const brokenSql = {
      exec: () => {
        throw new Error("sql on fire");
      },
    };
    const recorder = createCaptureFetchOutcomeRecorder(brokenSql as any);
    await expect(recorder.recordFailure(META, { kind: "auth", message: "x" })).resolves.toBeUndefined();
    await expect(recorder.recordSuccess(META)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adapter integration — E*TRADE: every fetch boundary records failure
// with the identical error propagating; success leaves exactly the
// pre-existing capture row (no double-writing).
// ---------------------------------------------------------------------------

const quoteFixture = {
  symbol: "AAPL",
  companyName: "Apple Inc.",
  lastPrice: 232.5,
  timestamp: "2026-10-23T13:30:00.000Z",
} as unknown as ETradeQuote;

function stubETradeService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getQuoteAsync: async () => quoteFixture,
    getOptionChains: async () => null,
    getStatus: () => ({ broker: "etrade", configured: true }),
    fetchQuotesRemote: async (symbols: string[]) =>
      symbols.map((s) => ({ ...quoteFixture, symbol: s })),
    getOptionExpireDates: async () => [{ expiryYear: 2026, expiryMonth: 11, expiryDay: 20 }],
    ...overrides,
  } as unknown as ETradeDataSurface;
}

function captureDeps(sql: MockSqlStorage, storage: unknown = okBlobStorage()) {
  return { sql: sql as any, blobStorage: storage as any, env: {} };
}

const RUN = { runId: "run-e7", tenantId: TENANT, userLogin: "ops" };

describe("E*TRADE adapter fetch outcomes (issue #1248)", () => {
  it("quote failure: one fetch_failed row (kind auth, run-attributed); the identical error propagates", async () => {
    const sql = new MockSqlStorage();
    const err = new ETradeError(ETradeErrorCode.TOKEN_EXPIRED);
    const provider = createETradeDataProvider(
      stubETradeService({
        getQuoteAsync: async () => {
          throw err;
        },
      }),
      { capture: captureDeps(sql) }
    );
    const caught = await provider.getQuote!("AAPL", RUN).catch((e) => e);
    expect(caught).toBe(err);
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fetch_failed");
    expect(rows[0].failureKind).toBe("auth");
    expect(rows[0].capability).toBe("quotes");
    expect(rows[0].runId).toBe("run-e7");
    expect(rows[0].requestParams).toEqual({ symbol: "AAPL" });
  });

  it("quote success: exactly the pre-existing captured row — no extra outcome row", async () => {
    const sql = new MockSqlStorage();
    const provider = createETradeDataProvider(stubETradeService(), {
      capture: captureDeps(sql),
    });
    const out = await provider.getQuote!("AAPL", RUN);
    expect((out.result as ETradeQuote).lastPrice).toBe(232.5);
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("captured");
  });

  it("chain failure: kind rate_limit under optionsChains", async () => {
    const sql = new MockSqlStorage();
    const err = new ETradeError(ETradeErrorCode.RATE_LIMITED);
    const provider = createETradeDataProvider(
      stubETradeService({
        getOptionChains: async () => {
          throw err;
        },
      }),
      { capture: captureDeps(sql) }
    );
    const caught = await provider.getOptionsChain!({ symbol: "AAPL" }, RUN).catch((e) => e);
    expect(caught).toBe(err);
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fetch_failed");
    expect(rows[0].failureKind).toBe("rate_limit");
    expect(rows[0].capability).toBe("optionsChains");
  });

  it("batch failure and expiry failure each record one fetch_failed row", async () => {
    const sql = new MockSqlStorage();
    const batchErr = new Error("socket hang up");
    const provider = createETradeDataProvider(
      stubETradeService({
        fetchQuotesRemote: async () => {
          throw batchErr;
        },
        getOptionExpireDates: async () => {
          throw new ETradeError(ETradeErrorCode.UPSTREAM_ERROR);
        },
      }),
      { capture: captureDeps(sql) }
    );
    const caughtBatch = await provider.getQuotesBatch!(["AAPL", "MSFT"], RUN).catch((e) => e);
    expect(caughtBatch).toBe(batchErr);
    const caughtExpiry = await provider.getOptionExpiryDates!("AAPL", RUN).catch((e) => e);
    expect(caughtExpiry).toBeInstanceOf(ETradeError);
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(2);
    const batchRow = rows.find((r) => r.requestParams.kind === undefined && r.capability === "quotes")!;
    expect(batchRow.status).toBe("fetch_failed");
    expect(batchRow.failureKind).toBe("network");
    const expiryRow = rows.find((r) => r.capability === "optionsChains")!;
    expect(expiryRow.status).toBe("fetch_failed");
    expect(expiryRow.failureKind).toBe("upstream");
  });

  it("the stock-screener binding path records failures too (deps carry the same seam)", async () => {
    const sql = new MockSqlStorage();
    const err = new ETradeError(ETradeErrorCode.AUTH_REQUIRED);
    // #1356: the stock-screener binding path is now the pipeline's
    // QuoteScreenerDeps binding over an adapter constructed with the
    // same capture deps the retired bindETradeScreenerDeps took.
    const provider = createETradeDataProvider(
      stubETradeService({
        getQuoteAsync: async () => {
          throw err;
        },
      }),
      { capture: captureDeps(sql) }
    );
    const deps = bindEtradeQuoteDeps(provider, RUN);
    const caught = await deps.fetchQuote("AAPL").catch((e) => e);
    expect(caught).toBe(err);
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fetch_failed");
    expect(rows[0].failureKind).toBe("auth");
  });

  it("a capture-WRITE failure on a successful fetch stays a capture_failed marker — never a fetch failure", async () => {
    const sql = new MockSqlStorage();
    const provider = createETradeDataProvider(stubETradeService(), {
      capture: captureDeps(sql, failingBlobStorage()),
    });
    const out = await provider.getQuote!("AAPL", RUN);
    expect((out.result as ETradeQuote).lastPrice).toBe(232.5);
    const rows = listCapturesByProvider(sql as any, TENANT, "etrade");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("capture_failed");
    const health = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(health.captureFailures).toBe(1);
    expect(health.fetchFailures).toBe(0);
  });

  it("without capture deps there is no store to record into — errors still propagate identically", async () => {
    const err = new ETradeError(ETradeErrorCode.TOKEN_EXPIRED);
    const provider = createETradeDataProvider(
      stubETradeService({
        getQuoteAsync: async () => {
          throw err;
        },
      })
    );
    const caught = await provider.getQuote!("AAPL", RUN).catch((e) => e);
    expect(caught).toBe(err);
  });
});

// ---------------------------------------------------------------------------
// Adapter integration — Public: MCP failures classify by the client's
// own error shapes; successes leave exactly the capture row.
// ---------------------------------------------------------------------------

function publicClient(fetchImpl: typeof fetch, token: string | null = "test-token") {
  return new PublicMcpClient({
    accessTokenProvider: async () => token,
    fetchImpl,
  });
}

const MCP_URL = "https://mcp.public.com/mcp";

function httpErrorFetch(status: number): typeof fetch {
  return (async (input: unknown) => {
    void input;
    return new Response(JSON.stringify({ error: "nope" }), { status });
  }) as unknown as typeof fetch;
}

const PUBLIC_TOOLS = [
  {
    name: "get_quotes",
    inputSchema: {
      type: "object",
      properties: { symbols: { type: "array" } },
      required: ["symbols"],
    },
  },
  {
    name: "get_option_expirations",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_option_chain",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
];

function publicOkFetch(): typeof fetch {
  return (async (input: unknown, init: any = {}) => {
    const url = typeof input === "string" ? input : (input as any).url;
    if (url !== MCP_URL) throw new Error(`unexpected URL ${url}`);
    const rpc = JSON.parse(init.body as string);
    if (rpc.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: PUBLIC_TOOLS } });
    }
    if (rpc.method === "tools/call" && rpc.params?.name === "get_quotes") {
      const payload = {
        quotes: [
          {
            instrument: { symbol: "AAPL", type: "EQUITY" },
            last: 232.5,
            bid: 232.4,
            ask: 232.6,
            volume: 100,
            timestamp: "2026-10-23T15:59:00Z",
          },
        ],
      };
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      });
    }
    throw new Error(`unexpected rpc ${rpc.method}/${rpc.params?.name}`);
  }) as unknown as typeof fetch;
}

describe("Public adapter fetch outcomes (issue #1248)", () => {
  it("no credential: the MCP refusal records kind auth and the identical error propagates", async () => {
    const sql = new MockSqlStorage();
    const provider = createPublicDataProvider(publicClient(publicOkFetch(), null), {
      capture: captureDeps(sql),
    });
    const caught = await provider.getQuote!("AAPL", RUN).catch((e) => e);
    expect(caught).toBeInstanceOf(PublicMcpError);
    const rows = listCapturesByProvider(sql as any, TENANT, "public");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fetch_failed");
    expect(rows[0].failureKind).toBe("auth");
    expect(rows[0].capability).toBe("quotes");
  });

  it("HTTP 429 from the MCP endpoint records rate_limit; HTTP 503 records upstream; a transport throw records network", async () => {
    for (const [status, kind] of [
      [429, "rate_limit"],
      [503, "upstream"],
    ] as const) {
      const sql = new MockSqlStorage();
      const provider = createPublicDataProvider(publicClient(httpErrorFetch(status)), {
        capture: captureDeps(sql),
      });
      await expect(provider.getQuotesBatch!(["AAPL"], RUN)).rejects.toBeInstanceOf(PublicMcpError);
      const rows = listCapturesByProvider(sql as any, TENANT, "public");
      expect(rows).toHaveLength(1);
      expect(rows[0].failureKind).toBe(kind);
    }
    const sql = new MockSqlStorage();
    const networkFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const provider = createPublicDataProvider(publicClient(networkFetch), {
      capture: captureDeps(sql),
    });
    await expect(provider.getOptionExpiryDates!("AAPL", RUN)).rejects.toBeInstanceOf(TypeError);
    const rows = listCapturesByProvider(sql as any, TENANT, "public");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fetch_failed");
    expect(rows[0].failureKind).toBe("network");
    expect(rows[0].capability).toBe("optionsChains");
  });

  it("success: exactly the capture row — no fetch_failed, no extra row", async () => {
    const sql = new MockSqlStorage();
    const provider = createPublicDataProvider(publicClient(publicOkFetch()), {
      capture: captureDeps(sql),
    });
    const out = await provider.getQuote!("AAPL", RUN);
    expect((out.result as ETradeQuote).lastPrice).toBe(232.5);
    const rows = listCapturesByProvider(sql as any, TENANT, "public");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("captured");
  });
});

// ---------------------------------------------------------------------------
// Market-data + nasdaq wrappers: no recorder is wired in production yet
// (their capture seam lands with the add-provider slices), but the
// wrapper is construction-level: supply a recorder and fetches are
// tracked; omit it and behaviour is the plain parity wrapper.
// ---------------------------------------------------------------------------

describe("Market-data / nasdaq wrapper readiness (issue #1248)", () => {
  it("yahoo: with a recorder, a failing fetch records and rethrows identically; without one it just throws", async () => {
    const err = new Error("yahoo upstream 429 rate limit");
    const marketDataResearch = {
      isConfigured: () => true,
      getQuote: async () => {
        throw err;
      },
      getHistoricalBars: async () => [],
      getFundamentals: async () => ({}),
    } as any;
    const seen: Array<{ meta: FetchOutcomeMeta; kind?: string }> = [];
    const recorder: FetchOutcomeRecorder = {
      recordSuccess: async (meta) => {
        seen.push({ meta });
      },
      recordFailure: async (meta, failure) => {
        seen.push({ meta, kind: failure.kind });
      },
    };
    const withRec = createYahooDataProvider(marketDataResearch, undefined, { outcomeRecorder: recorder });
    const caught = await withRec.getQuote!("AAPL").catch((e) => e);
    expect(caught).toBe(err);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("rate_limit");
    expect(seen[0].meta.providerId).toBe("yahoo");

    const plain = createYahooDataProvider(marketDataResearch);
    const caught2 = await plain.getQuote!("AAPL").catch((e) => e);
    expect(caught2).toBe(err);
  });

  it("nasdaq: with a recorder, a failing universe fetch records kind network", async () => {
    const err = new TypeError("fetch failed");
    const seen: string[] = [];
    const recorder: FetchOutcomeRecorder = {
      recordSuccess: async () => {},
      recordFailure: async (_meta, failure) => {
        seen.push(failure.kind);
      },
    };
    const provider = createNasdaqDataProvider(
      async () => {
        throw err;
      },
      { outcomeRecorder: recorder }
    );
    const caught = await provider.getScreenUniverse!().catch((e) => e);
    expect(caught).toBe(err);
    expect(seen).toEqual(["network"]);
  });
});

// ---------------------------------------------------------------------------
// Verifier probes record outcomes through the same wrapper.
// ---------------------------------------------------------------------------

describe("verifier probe outcomes (issue #1248)", () => {
  it("public: a probe against a 401-ing MCP endpoint records fetch_failed rows per probed capability", async () => {
    const sql = new MockSqlStorage();
    const recorder = createCaptureFetchOutcomeRecorder(sql as any);
    const env = { PUBLIC_E7_TEST_TOKEN: "test-token" } as unknown as Env;
    const result = await verifyPublicDataProvider(env, "ops", "env:PUBLIC_E7_TEST_TOKEN", {
      fetchImpl: httpErrorFetch(401),
      outcomeRecorder: recorder,
    });
    expect(result.ok).toBe(false);
    const rows = listCapturesByProvider(sql as any, TENANT, "public");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.status === "fetch_failed")).toBe(true);
    expect(rows.every((r) => r.failureKind === "auth")).toBe(true);
    expect(new Set(rows.map((r) => r.capability))).toEqual(new Set(["quotes", "optionsChains"]));
  });

  it("etrade: an unconfigured service fails verify BEFORE any probe — no fetch, no rows", async () => {
    const sql = new MockSqlStorage();
    const recorder = createCaptureFetchOutcomeRecorder(sql as any);
    // Scrub ambient credentials (the CI-hermeticity lesson): the
    // service must honestly report itself unconfigured.
    const saved = new Map<string, string | undefined>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ET_") || key.startsWith("ETRADE")) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
    }
    try {
      const result = await verifyETradeDataProvider({} as Env, "ops", {
        outcomeRecorder: recorder,
      });
      expect(result.ok).toBe(false);
      expect(listCapturesByProvider(sql as any, TENANT, "etrade")).toEqual([]);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Health projection v2 — fetch truth alongside (never instead of)
// the v1 capture semantics.
// ---------------------------------------------------------------------------

async function writeCaptured(sql: MockSqlStorage, at: string, capability = "quotes") {
  return recordCapture(
    sql as any,
    { storage: okBlobStorage(), env: {} },
    {
      providerId: "etrade",
      capability: capability as any,
      requestParams: { symbol: "AAPL" },
      runId: "run-e7",
      tenantId: TENANT,
      userLogin: "ops",
      rawPayload: { ok: true },
      rawKind: "provider-response",
      fetchedAt: at,
    }
  );
}

async function writeNoPayload(sql: MockSqlStorage, at: string) {
  return recordCapture(
    sql as any,
    { storage: okBlobStorage(), env: {} },
    {
      providerId: "etrade",
      capability: "optionsChains",
      requestParams: { symbol: "AAPL" },
      runId: "run-e7",
      tenantId: TENANT,
      userLogin: "ops",
      fetchedAt: at,
    }
  );
}

async function writeCaptureFailed(sql: MockSqlStorage, at: string) {
  return recordCapture(
    sql as any,
    { storage: failingBlobStorage(), env: {} },
    {
      providerId: "etrade",
      capability: "quotes",
      requestParams: { symbol: "AAPL" },
      runId: "run-e7",
      tenantId: TENANT,
      userLogin: "ops",
      rawPayload: { ok: true },
      rawKind: "provider-response",
      fetchedAt: at,
    }
  );
}

async function writeFetchFailed(
  sql: MockSqlStorage,
  at: string,
  kind: "auth" | "rate_limit" | "upstream" = "auth",
  capability = "quotes"
) {
  return recordFetchFailure(sql as any, {
    providerId: "etrade",
    capability: capability as any,
    requestParams: { symbol: "AAPL" },
    runId: "run-e7",
    tenantId: TENANT,
    userLogin: "ops",
    kind,
    message: `${kind} failure`,
    fetchedAt: at,
  });
}

describe("health projection v2 (issue #1248)", () => {
  it("a log of pure auth fetch failures reads DOWN from fetch evidence — the case E6 could only show as stale", async () => {
    const sql = new MockSqlStorage();
    await writeFetchFailed(sql, "2026-10-23T10:00:00.000Z");
    await writeFetchFailed(sql, "2026-10-23T10:05:00.000Z");
    await writeFetchFailed(sql, "2026-10-23T10:10:00.000Z");
    const health = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(health.status).toBe("down");
    expect(health.fetchAttempts).toBe(3);
    expect(health.fetchFailures).toBe(3);
    expect(health.fetchFailureRate).toBe(1);
    expect(health.latestFetchFailureKind).toBe("auth");
    expect(health.lastFetchFailureAt).toBe("2026-10-23T10:10:00.000Z");
    expect(health.fetchConsecutiveFailures).toBe(3);
    // fetch-based semantics reach the shared fields…
    expect(health.lastFailureAt).toBe("2026-10-23T10:10:00.000Z");
    expect(health.consecutiveFailures).toBe(3);
    // …while the v1 capture fields keep their exact meanings:
    expect(health.capturedCount).toBe(0);
    expect(health.failedCount).toBe(0);
    expect(health.failureRate).toBe(0);
    expect(health.captureFailures).toBe(0);
    expect(health.lastSuccessAt).toBeNull();
  });

  it("mixed logs: fetch and capture failures counted separately, rates exact", async () => {
    const sql = new MockSqlStorage();
    await writeCaptured(sql, "2026-10-23T08:00:00.000Z");
    await writeCaptured(sql, "2026-10-23T08:30:00.000Z");
    await writeCaptureFailed(sql, "2026-10-23T09:00:00.000Z");
    await writeCaptured(sql, "2026-10-23T09:30:00.000Z");
    await writeCaptured(sql, "2026-10-23T10:00:00.000Z");
    await writeFetchFailed(sql, "2026-10-23T10:30:00.000Z", "rate_limit");
    const health = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(health.totalCaptures).toBe(6);
    expect(health.fetchAttempts).toBe(6);
    expect(health.fetchFailures).toBe(1);
    expect(health.fetchFailureRate).toBeCloseTo(1 / 6);
    expect(health.captureFailures).toBe(1);
    expect(health.failedCount).toBe(1);
    // latest record is the fetch failure: unified streak 1 → degraded
    expect(health.consecutiveFailures).toBe(1);
    expect(health.fetchConsecutiveFailures).toBe(1);
    expect(health.status).toBe("degraded");
    expect(health.lastFailureAt).toBe("2026-10-23T10:30:00.000Z");
    expect(health.latestFetchFailureKind).toBe("rate_limit");
    expect(health.capturedCount).toBe(4);
    expect(health.lastSuccessAt).toBe("2026-10-23T10:00:00.000Z");
  });

  it("a success (or a no_payload) after fetch failures breaks the streaks", async () => {
    const sql = new MockSqlStorage();
    await writeFetchFailed(sql, "2026-10-23T09:00:00.000Z");
    await writeFetchFailed(sql, "2026-10-23T09:05:00.000Z");
    await writeNoPayload(sql, "2026-10-23T09:10:00.000Z");
    const health = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(health.fetchConsecutiveFailures).toBe(0);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.fetchFailures).toBe(2);
    expect(health.fetchFailureRate).toBeCloseTo(2 / 3);
    // rate alone still degrades — honestly, the provider IS failing 2 of 3 fetches
    expect(health.status).toBe("degraded");
    expect(health.byCapability.optionsChains!.fetchFailures).toBe(0);
    expect(health.byCapability.quotes!.fetchFailures).toBe(2);
  });

  it("a v1-shaped log (no fetch rows) reports zeroed fetch fields and untouched v1 fields", async () => {
    const sql = new MockSqlStorage();
    await writeCaptured(sql, "2026-10-23T08:00:00.000Z");
    await writeCaptureFailed(sql, "2026-10-23T09:00:00.000Z");
    await writeCaptured(sql, "2026-10-23T10:00:00.000Z");
    const health = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(health.fetchAttempts).toBe(3);
    expect(health.fetchFailures).toBe(0);
    expect(health.fetchFailureRate).toBe(0);
    expect(health.lastFetchFailureAt).toBeNull();
    expect(health.fetchConsecutiveFailures).toBe(0);
    expect(health.latestFetchFailureKind).toBeNull();
    expect(health.captureFailures).toBe(1);
    // E6 semantics untouched: 1 capture failure in 3 records is a
    // 1/3 failure rate ≥ 0.2, which degraded under E6 too — the
    // fetch fields being zeroed changes nothing about the v1 read.
    expect(health.status).toBe("degraded");
    expect(health.lastFailureAt).toBe("2026-10-23T09:00:00.000Z");
  });

  it("deriveProviderHealth: the fetch failure rate degrades at exactly the threshold, not below it", () => {
    const base: CaptureAggregates = {
      totalCaptures: 0,
      capturedCount: 0,
      failedCount: 0,
      failureRate: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      totalRawBytes: 0,
      capturesLast24h: 0,
      failuresLast24h: 0,
      fetchAttempts: 0,
      fetchFailures: 0,
      fetchFailureRate: 0,
      captureFailures: 0,
      lastFetchFailureAt: null,
      fetchConsecutiveFailures: 0,
      latestFetchFailureKind: null,
    };
    expect(
      deriveProviderHealth({ ...base, totalCaptures: 5, capturedCount: 4, fetchAttempts: 5, fetchFailures: 1, fetchFailureRate: 0.2 })
    ).toBe("degraded");
    expect(
      deriveProviderHealth({ ...base, totalCaptures: 100, capturedCount: 81, fetchAttempts: 100, fetchFailures: 19, fetchFailureRate: 0.19 })
    ).toBe("healthy");
    expect(
      deriveProviderHealth({ ...base, totalCaptures: 3, fetchAttempts: 3, fetchFailures: 3, fetchFailureRate: 1, consecutiveFailures: 3, fetchConsecutiveFailures: 3 })
    ).toBe("down");
  });

  it("GET /data-providers serves the v2 health block computed from the same store", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as any);
    await writeFetchFailed(sql, "2026-10-23T10:00:00.000Z");
    await writeFetchFailed(sql, "2026-10-23T10:05:00.000Z");
    const ctx: DataProviderRoutesContext = {
      env: {} as Env,
      sql: sql as any,
      userLogin: "ops",
      recordAudit: () => ({ id: "audit-1" }),
    };
    const res = await handleDataProviderRoutes(
      new Request("http://x/data-providers"),
      new URL("http://x/data-providers"),
      "/data-providers",
      "sess",
      ctx
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    const etrade = body.providers.find((p: any) => p.id === "etrade");
    expect(etrade.health.fetchFailures).toBe(2);
    expect(etrade.health.fetchAttempts).toBe(2);
    expect(etrade.health.fetchFailureRate).toBe(1);
    expect(etrade.health.latestFetchFailureKind).toBe("auth");
    expect(etrade.health.captureFailures).toBe(0);
    expect(etrade.health.status).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Panel — the latest failure renders WITH its kind; v1-shaped health
// (an older API response) renders without inventing fetch numbers.
// ---------------------------------------------------------------------------

const PANEL_BASE_VIEW = {
  adapterKind: "stub-adapter",
  lifecycleState: "enabled",
  enabled: true,
  precedence: 1,
  credentialRef: null,
  config: {},
  createdAt: "2026-10-23T09:00:00.000Z",
  updatedAt: "2026-10-23T09:00:00.000Z",
  declaredCapabilities: ["quotes"],
  verification: null,
  serving: true,
};

function panelHealth(partial: Record<string, unknown>) {
  return {
    status: "healthy",
    totalCaptures: 0,
    capturedCount: 0,
    failedCount: 0,
    failureRate: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    totalRawBytes: 0,
    capturesLast24h: 0,
    failuresLast24h: 0,
    byCapability: {},
    ...partial,
  };
}

describe("DataProvidersPanel fetch outcomes (issue #1248)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderProviders(providers: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/api/data-providers")) {
          return Response.json({ providers, routes: [] }, { status: 200 });
        }
        throw new Error(`unstubbed fetch: ${method} ${url}`);
      })
    );
    await act(async () => {
      root.render(React.createElement(ToastProvider, null, React.createElement(DataProvidersPanel)));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("renders the fetch failure rate and the latest failure WITH its kind", async () => {
    await renderProviders([
      {
        ...PANEL_BASE_VIEW,
        id: "etrade",
        health: panelHealth({
          status: "down",
          totalCaptures: 4,
          capturedCount: 1,
          lastSuccessAt: "2026-10-23T08:00:00.000Z",
          lastFailureAt: "2026-10-23T10:10:00.000Z",
          consecutiveFailures: 3,
          fetchAttempts: 4,
          fetchFailures: 3,
          fetchFailureRate: 0.75,
          captureFailures: 0,
          lastFetchFailureAt: "2026-10-23T10:10:00.000Z",
          fetchConsecutiveFailures: 3,
          latestFetchFailureKind: "auth",
        }),
      },
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Fetch failure rate: 75%");
    expect(text).toContain("3 of 4 attempts failed");
    expect(text).toContain("Latest fetch failure");
    expect(text).toContain("auth");
  });

  it("a v1-shaped health block (no fetch fields) renders as before — no NaN, no invented numbers", async () => {
    await renderProviders([
      {
        ...PANEL_BASE_VIEW,
        id: "etrade",
        health: panelHealth({
          status: "healthy",
          totalCaptures: 2,
          capturedCount: 2,
          lastSuccessAt: "2026-10-23T10:00:00.000Z",
        }),
      },
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Healthy");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Fetch failure rate");
  });
});
