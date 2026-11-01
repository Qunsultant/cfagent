/** @vitest-environment jsdom */
/**
 * Issue #1235 (E6 of epic #1116) — provider health + usage metering
 * derived from capture records.
 *
 * Pins:
 *  - aggregation exactness: captures written through the REAL
 *    recordCapture path (captured / capture_failed / no_payload)
 *    aggregate to exact counts, failure rate, last-success /
 *    last-failure times, consecutive-failure streak, captured-byte
 *    total (only bytes actually stored count), and 24h-window
 *    counts against an injected `now`, per provider and per
 *    capability; aggregation is tenant-scoped like every capture
 *    read;
 *  - status boundaries: deriveProviderHealth is a pure function of
 *    the aggregates — no-data at zero captures, healthy below the
 *    thresholds, degraded at failureRate exactly 0.2 or when the
 *    latest record failed, down at 3 consecutive failures; a
 *    success after failures resets the streak;
 *  - API: GET /data-providers and /data-providers/:id carry the
 *    health block computed from the same store the captures were
 *    written to, existing fields intact, capture-less providers
 *    reporting honest no-data;
 *  - panel: each status renders its plain-language label plus the
 *    served numbers (no client-side derivation), including the
 *    no-data state and a sane fallback when an older API response
 *    lacks the health block.
 *
 * No live network and no synthetic health: every number below comes
 * from rows the real capture path stored.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MockSqlStorage } from "./mock-sql";
import {
  recordCapture,
  type DataCaptureRecord,
} from "../src/trading/dataProviders/captureStore";
import {
  aggregateProviderHealth,
  deriveProviderHealth,
  PROVIDER_HEALTH_THRESHOLDS,
  type CaptureAggregates,
  type ProviderHealth,
} from "../src/trading/dataProviders/providerHealth";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import type { Env } from "../src/types";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  fmtCaptureBytes,
  fmtDataProviderTime,
  type DataProviderHealth,
  type DataProviderView,
} from "../src/client/dataProvidersApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Capture-writing fixtures — everything goes through recordCapture.
// ---------------------------------------------------------------------------

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
    get: async (_key: string) => undefined,
    put: async (_key: string, _value: unknown) => {
      throw new Error("forced blob put failure");
    },
  };
}

interface WriteOpts {
  providerId: string;
  capability: string;
  fetchedAt: string;
  /** Omit for a no_payload record. */
  payload?: unknown;
  /** Route the write through a failing blob store → capture_failed. */
  fail?: boolean;
  tenantId?: string;
}

async function writeCapture(
  sql: MockSqlStorage,
  opts: WriteOpts
): Promise<DataCaptureRecord> {
  const storage = opts.fail ? failingBlobStorage() : okBlobStorage();
  return recordCapture(
    sql as any,
    { storage, env: {} },
    {
      providerId: opts.providerId as any,
      capability: opts.capability as any,
      requestParams: { symbol: "AAPL" },
      runId: "run-e6",
      tenantId: opts.tenantId ?? TENANT,
      userLogin: "ops",
      ...(opts.payload !== undefined
        ? { rawPayload: opts.payload, rawKind: "provider-response" as const }
        : {}),
      fetchedAt: opts.fetchedAt,
    }
  );
}

/**
 * The shared etrade capture set (tenant "default"):
 *
 * quotes —
 *   r0 captured       2026-10-22T12:00:00Z  (exactly now-24h: in window) {z:0} 7B
 *   r1 captured       2026-10-22T10:00:00Z  (26h ago: out of window)      {a:1} 7B
 *   r2 captured       2026-10-23T08:00:00Z                               "hello" 5B
 *   r3 capture_failed 2026-10-23T09:00:00Z                               {b:2}
 *   r4 captured       2026-10-23T10:00:00Z                               {c:3} 7B
 * optionsChains —
 *   r5 captured       2026-10-23T07:00:00Z                               [1,2,3] 7B
 *   r6 no_payload     2026-10-23T07:30:00Z
 *
 * Insertion order is deliberately not chronological (r1 before r0 in
 * time order) so the aggregation's own ordering is exercised.
 */
async function writeEtradeSet(sql: MockSqlStorage): Promise<DataCaptureRecord[]> {
  const out: DataCaptureRecord[] = [];
  out.push(await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: "2026-10-22T10:00:00.000Z", payload: { a: 1 } }));
  out.push(await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: "2026-10-22T12:00:00.000Z", payload: { z: 0 } }));
  out.push(await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: "2026-10-23T08:00:00.000Z", payload: "hello" }));
  out.push(await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: "2026-10-23T09:00:00.000Z", payload: { b: 2 }, fail: true }));
  out.push(await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: "2026-10-23T10:00:00.000Z", payload: { c: 3 } }));
  out.push(await writeCapture(sql, { providerId: "etrade", capability: "optionsChains", fetchedAt: "2026-10-23T07:00:00.000Z", payload: [1, 2, 3] }));
  out.push(await writeCapture(sql, { providerId: "etrade", capability: "optionsChains", fetchedAt: "2026-10-23T07:30:00.000Z" }));
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation exactness
// ---------------------------------------------------------------------------

describe("provider health aggregation (issue #1235)", () => {
  it("the write helper produces the three real capture statuses", async () => {
    const records = await writeEtradeSet(new MockSqlStorage());
    expect(records.map((r) => r.status)).toEqual([
      "captured",
      "captured",
      "captured",
      "capture_failed",
      "captured",
      "captured",
      "no_payload",
    ]);
  });

  it("aggregates the etrade set exactly, per provider and per capability", async () => {
    const sql = new MockSqlStorage();
    await writeEtradeSet(sql);

    const health = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(health.totalCaptures).toBe(7);
    expect(health.capturedCount).toBe(5);
    expect(health.failedCount).toBe(1);
    expect(health.failureRate).toBe(1 / 7);
    expect(health.lastSuccessAt).toBe("2026-10-23T10:00:00.000Z");
    expect(health.lastFailureAt).toBe("2026-10-23T09:00:00.000Z");
    expect(health.consecutiveFailures).toBe(0);
    // Only bytes actually stored count: 7+7+5+7 (quotes) + 7 (chains);
    // the capture_failed payload was never stored and contributes 0.
    expect(health.totalRawBytes).toBe(33);
    expect(health.capturesLast24h).toBe(6);
    expect(health.failuresLast24h).toBe(1);
    expect(health.status).toBe("healthy");

    const quotes = health.byCapability.quotes!;
    expect(quotes.totalCaptures).toBe(5);
    expect(quotes.capturedCount).toBe(4);
    expect(quotes.failedCount).toBe(1);
    expect(quotes.failureRate).toBe(0.2);
    expect(quotes.lastSuccessAt).toBe("2026-10-23T10:00:00.000Z");
    expect(quotes.lastFailureAt).toBe("2026-10-23T09:00:00.000Z");
    expect(quotes.consecutiveFailures).toBe(0);
    expect(quotes.totalRawBytes).toBe(26);
    expect(quotes.capturesLast24h).toBe(4);
    expect(quotes.failuresLast24h).toBe(1);

    const chains = health.byCapability.optionsChains!;
    expect(chains.totalCaptures).toBe(2);
    expect(chains.capturedCount).toBe(1);
    expect(chains.failedCount).toBe(0);
    expect(chains.failureRate).toBe(0);
    expect(chains.lastSuccessAt).toBe("2026-10-23T07:00:00.000Z");
    expect(chains.lastFailureAt).toBeNull();
    expect(chains.consecutiveFailures).toBe(0);
    expect(chains.totalRawBytes).toBe(7);
    expect(chains.capturesLast24h).toBe(2);
    expect(chains.failuresLast24h).toBe(0);
  });

  it("an empty store aggregates to honest zeros, and a capture-less provider is no-data next to a healthy one", async () => {
    const sql = new MockSqlStorage();
    const empty = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(empty).toEqual({
      status: "no-data",
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
      // E7 (#1248): the health block's fetch dimension, zeroed on an
      // empty store — additive fields, every E6 field above unchanged.
      fetchAttempts: 0,
      fetchFailures: 0,
      fetchFailureRate: 0,
      captureFailures: 0,
      lastFetchFailureAt: null,
      fetchConsecutiveFailures: 0,
      latestFetchFailureKind: null,
      byCapability: {},
    });

    await writeEtradeSet(sql);
    const nasdaq = aggregateProviderHealth(sql as any, TENANT, "nasdaq", NOW);
    expect(nasdaq.status).toBe("no-data");
    expect(nasdaq.totalCaptures).toBe(0);
    const etrade = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(etrade.status).toBe("healthy");
  });

  it("aggregation is tenant-scoped: other tenants' captures are invisible", async () => {
    const sql = new MockSqlStorage();
    await writeCapture(sql, {
      providerId: "etrade",
      capability: "quotes",
      fetchedAt: "2026-10-23T11:00:00.000Z",
      payload: { x: 1 },
      tenantId: "tenant-b",
    });
    const health = aggregateProviderHealth(sql as any, TENANT, "etrade", NOW);
    expect(health.totalCaptures).toBe(0);
    expect(health.status).toBe("no-data");
    const other = aggregateProviderHealth(sql as any, "tenant-b", "etrade", NOW);
    expect(other.totalCaptures).toBe(1);
    expect(other.status).toBe("healthy");
  });

  it("three failures as the latest records aggregate to down; a later success resets the streak", async () => {
    const sql = new MockSqlStorage();
    for (const t of ["2026-10-23T09:00:00.000Z", "2026-10-23T10:00:00.000Z", "2026-10-23T11:00:00.000Z"]) {
      await writeCapture(sql, { providerId: "public", capability: "quotes", fetchedAt: t, payload: { q: 1 }, fail: true });
    }
    const down = aggregateProviderHealth(sql as any, TENANT, "public", NOW);
    expect(down.consecutiveFailures).toBe(3);
    expect(down.failedCount).toBe(3);
    expect(down.lastSuccessAt).toBeNull();
    expect(down.lastFailureAt).toBe("2026-10-23T11:00:00.000Z");
    expect(down.status).toBe("down");

    for (const t of ["2026-10-23T08:00:00.000Z", "2026-10-23T09:00:00.000Z", "2026-10-23T10:00:00.000Z"]) {
      await writeCapture(sql, { providerId: "alpaca", capability: "quotes", fetchedAt: t, payload: { q: 1 }, fail: true });
    }
    await writeCapture(sql, { providerId: "alpaca", capability: "quotes", fetchedAt: "2026-10-23T11:00:00.000Z", payload: { q: 2 } });
    const reset = aggregateProviderHealth(sql as any, TENANT, "alpaca", NOW);
    expect(reset.consecutiveFailures).toBe(0);
    expect(reset.failureRate).toBe(0.75);
    expect(reset.status).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Status derivation boundaries (pure)
// ---------------------------------------------------------------------------

function agg(partial: Partial<CaptureAggregates>): CaptureAggregates {
  return {
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
    ...partial,
  };
}

describe("deriveProviderHealth boundaries (issue #1235)", () => {
  it("pins the stated threshold constants", () => {
    expect(PROVIDER_HEALTH_THRESHOLDS.downConsecutiveFailures).toBe(3);
    expect(PROVIDER_HEALTH_THRESHOLDS.degradedFailureRate).toBe(0.2);
    expect(PROVIDER_HEALTH_THRESHOLDS.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  it("zero captures is no-data, never an invented green", () => {
    expect(deriveProviderHealth(agg({}))).toBe("no-data");
  });

  it("below every threshold with a successful latest record is healthy", () => {
    expect(
      deriveProviderHealth(agg({ totalCaptures: 10, capturedCount: 9, failedCount: 1, failureRate: 0.1, consecutiveFailures: 0 }))
    ).toBe("healthy");
    expect(
      deriveProviderHealth(agg({ totalCaptures: 6, capturedCount: 5, failedCount: 1, failureRate: 1 / 6, consecutiveFailures: 0 }))
    ).toBe("healthy");
  });

  it("failureRate exactly at 0.2 is degraded", () => {
    expect(
      deriveProviderHealth(agg({ totalCaptures: 5, capturedCount: 4, failedCount: 1, failureRate: 0.2, consecutiveFailures: 0 }))
    ).toBe("degraded");
  });

  it("a failed latest record is degraded even at a low overall rate, at 1 and 2 consecutive", () => {
    expect(
      deriveProviderHealth(agg({ totalCaptures: 100, capturedCount: 99, failedCount: 1, failureRate: 0.01, consecutiveFailures: 1 }))
    ).toBe("degraded");
    expect(
      deriveProviderHealth(agg({ totalCaptures: 100, capturedCount: 98, failedCount: 2, failureRate: 0.02, consecutiveFailures: 2 }))
    ).toBe("degraded");
  });

  it("3 consecutive failures is down regardless of the overall rate", () => {
    expect(
      deriveProviderHealth(agg({ totalCaptures: 100, capturedCount: 97, failedCount: 3, failureRate: 0.03, consecutiveFailures: 3 }))
    ).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// API surface (E3 route idiom)
// ---------------------------------------------------------------------------

function makeRouteCtx(sql: MockSqlStorage) {
  const ctx: DataProviderRoutesContext = {
    env: {} as Env,
    sql,
    userLogin: "ops",
    recordAudit: () => ({ id: "audit-1" }),
    buildVerifier: () => undefined,
  };
  return ctx;
}

function callRoute(
  ctx: DataProviderRoutesContext,
  method: string,
  path: string
): Promise<Response> {
  const url = new URL(`https://agent.internal${path}`);
  const request = new Request(url, { method });
  return handleDataProviderRoutes(request, url, path, "session-1", ctx) as Promise<Response>;
}

describe("GET /data-providers health block (issue #1235)", () => {
  it("list and detail views carry health computed from the same store, existing fields intact", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql);
    // etrade: 3 captured + 1 failed (fetched INSIDE the handler's real
    // clock — the handler aggregates with the current time, so use
    // timestamps close to now rather than the fixed fixture clock).
    const recent = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
    const lastSuccess = recent(5);
    await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: recent(30), payload: { a: 1 } });
    await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: recent(20), payload: { b: 2 }, fail: true });
    await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: recent(10), payload: { c: 3 } });
    await writeCapture(sql, { providerId: "etrade", capability: "quotes", fetchedAt: lastSuccess, payload: { d: 4 } });

    const ctx = makeRouteCtx(sql);
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    const etrade = body.providers.find((p: any) => p.id === "etrade");
    // Existing fields intact.
    expect(etrade.adapterKind).toBeDefined();
    expect(etrade.lifecycleState).toBeDefined();
    expect(etrade).toHaveProperty("serving");
    expect(etrade).toHaveProperty("verification");
    expect(Array.isArray(body.routes)).toBe(true);
    expect(typeof body.routes[0].minTier).toBe("string");

    const h = etrade.health as ProviderHealth;
    expect(h.totalCaptures).toBe(4);
    expect(h.capturedCount).toBe(3);
    expect(h.failedCount).toBe(1);
    expect(h.failureRate).toBe(0.25);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastSuccessAt).toBe(lastSuccess);
    expect(h.status).toBe("degraded"); // rate 0.25 ≥ 0.2
    expect(h.byCapability.quotes!.totalCaptures).toBe(4);

    // A provider with config but no captures reports honest no-data.
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo.health.status).toBe("no-data");
    expect(yahoo.health.totalCaptures).toBe(0);
    expect(yahoo.health.lastSuccessAt).toBeNull();
    expect(yahoo.health.lastFailureAt).toBeNull();
    expect(yahoo.health.byCapability).toEqual({});

    const detail = await callRoute(ctx, "GET", "/data-providers/etrade");
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as any;
    expect(detailBody.provider.health.totalCaptures).toBe(4);
    expect(detailBody.provider.health.status).toBe("degraded");
    expect(detailBody.provider.id).toBe("etrade");
  });
});

// ---------------------------------------------------------------------------
// Panel rendering (E4 jsdom idiom)
// ---------------------------------------------------------------------------

const BASE_VIEW = {
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

function capAgg(partial: Partial<DataProviderHealth>): DataProviderHealth {
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

const PANEL_PROVIDERS: DataProviderView[] = [
  {
    ...BASE_VIEW,
    id: "etrade",
    health: capAgg({
      status: "healthy",
      totalCaptures: 12,
      capturedCount: 11,
      failedCount: 1,
      failureRate: 1 / 12,
      lastSuccessAt: "2026-10-23T11:30:00.000Z",
      lastFailureAt: "2026-10-23T09:15:00.000Z",
      totalRawBytes: 2048,
      capturesLast24h: 5,
      failuresLast24h: 1,
      byCapability: {
        quotes: capAgg({ totalCaptures: 8, capturedCount: 7, failedCount: 1, failureRate: 0.125 }),
        optionsChains: capAgg({ totalCaptures: 4, capturedCount: 4, failedCount: 0 }),
      } as DataProviderHealth["byCapability"],
    }),
  },
  {
    ...BASE_VIEW,
    id: "yahoo",
    health: capAgg({
      status: "degraded",
      totalCaptures: 8,
      capturedCount: 6,
      failedCount: 2,
      failureRate: 0.25,
      lastSuccessAt: "2026-10-23T10:00:00.000Z",
      lastFailureAt: "2026-10-23T11:00:00.000Z",
      consecutiveFailures: 1,
      capturesLast24h: 8,
      failuresLast24h: 2,
    }),
  },
  {
    ...BASE_VIEW,
    id: "nasdaq",
    health: capAgg({
      status: "down",
      totalCaptures: 3,
      capturedCount: 0,
      failedCount: 3,
      failureRate: 1,
      lastFailureAt: "2026-10-23T11:45:00.000Z",
      consecutiveFailures: 3,
      capturesLast24h: 3,
      failuresLast24h: 3,
    }),
  },
  {
    ...BASE_VIEW,
    id: "alpaca",
    health: capAgg({ status: "no-data" }),
  },
];

function installFetch(list: unknown) {
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.endsWith("/api/data-providers")) {
      return Response.json(list, { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mock);
}

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ToastProvider, null, React.createElement(DataProvidersPanel)));
  });
  await flush(60);
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 900)}`);
}

function providerItem(id: string): Element {
  const item = container.querySelector(`[data-provider-id="${id}"]`);
  if (!item) throw new Error(`No provider item rendered for "${id}". Panel: ${container.textContent?.slice(0, 500)}`);
  return item;
}

beforeEach(() => {
  document.body.innerHTML = "";
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

describe("DataProvidersPanel health rendering (issue #1235)", () => {
  it("formats captured bytes plainly", () => {
    expect(fmtCaptureBytes(0)).toBe("0 B");
    expect(fmtCaptureBytes(512)).toBe("512 B");
    expect(fmtCaptureBytes(2048)).toBe("2 KB");
    expect(fmtCaptureBytes(1536)).toBe("1.5 KB");
    expect(fmtCaptureBytes(1048576)).toBe("1 MB");
  });

  it("renders each status label with the served numbers, including no-data", async () => {
    installFetch({ providers: PANEL_PROVIDERS, routes: [] });
    await renderPanel();
    await waitForText("Healthy");

    const etrade = providerItem("etrade");
    expect(etrade.textContent).toContain("Healthy");
    expect(etrade.textContent).toContain("Captures: 12");
    expect(etrade.textContent).toContain("Failure rate: 8%");
    expect(etrade.textContent).toContain(`Last success: ${fmtDataProviderTime("2026-10-23T11:30:00.000Z")}`);
    expect(etrade.textContent).toContain(`Last failure: ${fmtDataProviderTime("2026-10-23T09:15:00.000Z")}`);
    expect(etrade.textContent).toContain("Captured data: 2 KB");
    expect(etrade.textContent).toContain("quotes: 8 captures (1 failed)");
    expect(etrade.textContent).toContain("optionsChains: 4 captures (0 failed)");

    const yahoo = providerItem("yahoo");
    expect(yahoo.textContent).toContain("Degraded");
    expect(yahoo.textContent).toContain("Failure rate: 25%");

    const nasdaq = providerItem("nasdaq");
    expect(nasdaq.textContent).toContain("Down");
    expect(nasdaq.textContent).toContain("Captures: 3");

    const alpaca = providerItem("alpaca");
    expect(alpaca.textContent).toContain("No data yet");
    expect(alpaca.textContent).toContain("Captures: 0");
    expect(alpaca.textContent).toContain("Last success: Never");
  });

  it("renders a sane fallback when an older API response lacks the health block", async () => {
    const legacy = { ...BASE_VIEW, id: "etrade" } as unknown as DataProviderView;
    installFetch({ providers: [legacy], routes: [] });
    await renderPanel();
    await waitForText("Health unavailable");
    expect(providerItem("etrade").textContent).toContain("Health unavailable");
  });
});
