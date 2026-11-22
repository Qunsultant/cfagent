/**
 * Issue #5425 (#3515 S5) — SLI/SLO definitions + monitoring.
 *
 * Pins (TDD red→green, load-bearing):
 *  - the two #3515 SLOs (uptime, P95 API latency) are metric +
 *    config threshold ON the S2 model/store (a consumer, not a
 *    new system): gauges `slo.api.uptime` / `slo.api.p95_latency`
 *    on the one recorder, evaluated by pure evaluators.
 *  - thresholds are externalized tenant-scoped config (D1
 *    agentTenantSettings row via the CommercialStore port) — no
 *    hardcoded numbers, no env var; unconfigured = named refusal.
 *  - P95 is computed from raw observations in the recorder (a
 *    bounded in-memory sample — the exported histogram series
 *    keep only sum/count/min/max, so P95 cannot be reconstructed
 *    from AE). Uptime is the share of recorded API requests not
 *    failing (status >= 500) — no prober exists; the recorder's
 *    own request counts are the measurement, parallel to
 *    evaluatePipelineHealth.
 *  - the fetch path records every API request through
 *    withRequestObservability's onRequestObserved callback into
 *    the server metrics handle (one lazy per-isolate handle, the
 *    premiumQuota pattern) — the same handle the SLO read
 *    endpoint evaluates through.
 *  - the evaluation trigger is the SLO read (GET /api/otel/v1/slo,
 *    IAAA admin pattern): it evaluates + records the gauges and
 *    returns the fresh evaluation. Unconfigured SLOs report
 *    "unconfigured" and claim no compliance; no data reports
 *    "no-data". No background evaluation exists (recorded gap).
 *  - compliance surfaces on the one observability surface (a
 *    third "slo" view on ObservabilityHome, never a new surface).
 */
import { describe, expect, it } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  SLO_P95_LATENCY_MAX_MS,
  SLO_P95_LATENCY_MIN_MS,
  SLO_UPTIME_TARGET_MAX_RATIO,
  SLO_UPTIME_TARGET_MIN_RATIO,
  SloThresholdsUnconfiguredError,
  parseSloP95LatencyMaxMs,
  parseSloUptimeTargetRatio,
  resolveSloThresholds,
} from "../src/config/sloThresholds";
import {
  createOtelMetricsRecorder,
  evaluateP95LatencySlo,
  evaluateUptimeSlo,
  percentile95,
  type ApiSloThresholds,
  type OtelMetricsRecorder,
} from "../src/observability/otelMetricsRecorder";
import type { OtelMetricsSettings } from "../src/observability/otelMetrics";
import { withRequestObservability } from "../src/observability/aspects";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { tenantSettingsBodySchema } from "../src/api/requestValidation";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import { d1MigrationSql } from "../src/data/schemaComponent/d1Catalogue";
import {
  handleSloRoutes,
  OTEL_SLO_ROUTE,
  type OtelSloRouteDeps,
} from "../src/server/routes/otelSlo";
import {
  isObservabilityView,
  normalizeObservabilityView,
  OBSERVABILITY_VIEW_LABELS,
  OBSERVABILITY_VIEWS,
  parseObservabilityDeepLink,
} from "../src/client/observabilityView";
import { parseOtelSloResponse } from "../src/client/otelSloApi";
import type { SessionData } from "../src/types";
import type { CommercialStore } from "../src/data/commercialPorts";

/** The default metrics settings (the config-file values). */
function defaultSettings(overrides: Partial<OtelMetricsSettings> = {}): OtelMetricsSettings {
  return {
    exportIntervalMs: 60000,
    freeTierDailyWriteLimit: 100000,
    freeTierDailyReadQueryLimit: 10000,
    healthPipelineMaxFailureRate: 0.05,
    sloResourceRowsReadMaxPct: 0.7,
    ...overrides,
  };
}

/** A recorder over a live MeterProvider (the S2 recorder-test pattern). */
function liveRecorder(
  settings: OtelMetricsSettings = defaultSettings(),
  isEnabled: (component: string) => boolean = () => true,
): { recorder: OtelMetricsRecorder; provider: MeterProvider } {
  const provider = new MeterProvider();
  const meter = provider.getMeter("cfagent-metrics-test-s5");
  const recorder = createOtelMetricsRecorder({ meter, settings, isEnabled });
  return { recorder, provider };
}

function fakeSession(): SessionData {
  return {
    githubLogin: "op",
    githubAvatar: "",
    githubName: "Op",
    createdAt: 1,
    internalUserId: "u1",
  } as unknown as SessionData;
}

describe("SLO threshold config (#5425)", () => {
  it("accepts an uptime target ratio in (0, 1]", () => {
    expect(parseSloUptimeTargetRatio(0.99)).toBe(0.99);
    expect(parseSloUptimeTargetRatio("0.999")).toBe(0.999);
    expect(parseSloUptimeTargetRatio(SLO_UPTIME_TARGET_MAX_RATIO)).toBe(1);
  });

  it("rejects zero, negative, above-one, and non-numeric uptime targets", () => {
    expect(SLO_UPTIME_TARGET_MIN_RATIO).toBe(0);
    for (const bad of [0, -0.1, 1.0001, 2, "abc", "", null, undefined, {}, NaN]) {
      expect(() => parseSloUptimeTargetRatio(bad)).toThrow();
    }
  });

  it("accepts a P95 latency max inside the bounds", () => {
    expect(parseSloP95LatencyMaxMs(1000)).toBe(1000);
    expect(parseSloP95LatencyMaxMs("250")).toBe(250);
    expect(parseSloP95LatencyMaxMs(SLO_P95_LATENCY_MIN_MS)).toBe(SLO_P95_LATENCY_MIN_MS);
    expect(parseSloP95LatencyMaxMs(SLO_P95_LATENCY_MAX_MS)).toBe(SLO_P95_LATENCY_MAX_MS);
  });

  it("rejects zero, negative, fractional, over-max, and non-numeric latency maxima", () => {
    for (const bad of [0, -1, 1.5, SLO_P95_LATENCY_MAX_MS + 1, "abc", "", null, undefined, {}, NaN]) {
      expect(() => parseSloP95LatencyMaxMs(bad)).toThrow();
    }
  });

  it("unconfigured thresholds are a named refusal, not a default", () => {
    expect(() => resolveSloThresholds({ uptimeTargetRatio: null, p95LatencyMaxMs: null })).toThrowError(
      SloThresholdsUnconfiguredError,
    );
    try {
      resolveSloThresholds({ uptimeTargetRatio: null, p95LatencyMaxMs: 1000 });
    } catch (err) {
      expect(err).toBeInstanceOf(SloThresholdsUnconfiguredError);
      expect((err as SloThresholdsUnconfiguredError).code).toBe("slo_thresholds_unconfigured");
      expect((err as SloThresholdsUnconfiguredError).reason).toBe("absent");
      expect((err as SloThresholdsUnconfiguredError).field).toBe("sloUptimeTargetRatio");
    }
    try {
      resolveSloThresholds({ uptimeTargetRatio: 0.99, p95LatencyMaxMs: null });
    } catch (err) {
      expect((err as SloThresholdsUnconfiguredError).field).toBe("sloP95LatencyMaxMs");
    }
    expect(
      resolveSloThresholds({ uptimeTargetRatio: 0.99, p95LatencyMaxMs: 1000 }),
    ).toEqual({ uptimeTargetRatio: 0.99, p95LatencyMaxMs: 1000 });
  });

  it("an invalid stored value is a named refusal, never a silent default", () => {
    expect(() =>
      resolveSloThresholds({ uptimeTargetRatio: "not-a-number", p95LatencyMaxMs: 1000 }),
    ).toThrowError(SloThresholdsUnconfiguredError);
    try {
      resolveSloThresholds({ uptimeTargetRatio: 0.99, p95LatencyMaxMs: "soon" });
    } catch (err) {
      expect((err as SloThresholdsUnconfiguredError).reason).toBe("invalid");
      expect((err as SloThresholdsUnconfiguredError).field).toBe("sloP95LatencyMaxMs");
    }
  });
});

describe("evaluateUptimeSlo — the uptime SLO as a metric + threshold", () => {
  it("is within SLO when uptime meets the target (a floor: >=, not strict <)", () => {
    const r = evaluateUptimeSlo({ total: 100, failed: 1, targetRatio: 0.99 });
    expect(r.uptime).toBeCloseTo(0.99);
    expect(r.withinSlo).toBe(true);
    expect(evaluateUptimeSlo({ total: 1000, failed: 1, targetRatio: 0.99 }).withinSlo).toBe(true);
  });

  it("is breached when uptime falls below the target", () => {
    expect(evaluateUptimeSlo({ total: 100, failed: 2, targetRatio: 0.99 }).withinSlo).toBe(false);
  });

  it("has no value and no verdict with no requests yet (no signal is not compliance)", () => {
    const r = evaluateUptimeSlo({ total: 0, failed: 0, targetRatio: 0.99 });
    expect(r.uptime).toBeNull();
    expect(r.withinSlo).toBeNull();
  });

  it("treats an invalid target as never-within (fail-closed)", () => {
    const r = evaluateUptimeSlo({ total: 100, failed: 0, targetRatio: NaN });
    expect(r.uptime).toBeCloseTo(1);
    expect(r.withinSlo).toBe(false);
  });
});

describe("percentile95 / evaluateP95LatencySlo — the P95 SLO as a metric + threshold", () => {
  it("computes the nearest-rank P95 over the raw sample", () => {
    expect(percentile95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])).toBe(19);
    expect(percentile95([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(100);
    expect(percentile95([42])).toBe(42);
    expect(percentile95([])).toBeNull();
    // Order does not matter: the sample is sorted before ranking.
    expect(percentile95([100, 10, 50, 90, 20, 80, 30, 70, 40, 60])).toBe(100);
  });

  it("is within SLO when the P95 is at or below the max (a ceiling: <=)", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const r = evaluateP95LatencySlo({ samples, maxMs: 95 });
    expect(r.p95Ms).toBe(95);
    expect(r.withinSlo).toBe(true);
  });

  it("is breached when the P95 exceeds the max", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(evaluateP95LatencySlo({ samples, maxMs: 94 }).withinSlo).toBe(false);
  });

  it("has no value and no verdict with no samples yet", () => {
    const r = evaluateP95LatencySlo({ samples: [], maxMs: 1000 });
    expect(r.p95Ms).toBeNull();
    expect(r.withinSlo).toBeNull();
  });

  it("treats an invalid max as never-within (fail-closed)", () => {
    const r = evaluateP95LatencySlo({ samples: [10, 20, 30], maxMs: NaN });
    expect(r.p95Ms).toBe(30);
    expect(r.withinSlo).toBe(false);
  });
});

describe("API request recording on the S2 recorder (#5425)", () => {
  it("accumulates request counts; 5xx counts as failed, 4xx does not", () => {
    const { recorder } = liveRecorder();
    recorder.recordApiRequest({ status: 200, durationMs: 12 });
    recorder.recordApiRequest({ status: 404, durationMs: 8 });
    recorder.recordApiRequest({ status: 500, durationMs: 300 });
    recorder.recordApiRequest({ status: 503, durationMs: 250 });
    const counts = recorder.apiRequestCounts();
    expect(counts.total).toBe(4);
    expect(counts.failed).toBe(2);
    expect(counts.latencySamples).toBe(4);
  });

  it("bounds the latency sample (ring: oldest dropped) while counts stay exact", () => {
    const { recorder } = liveRecorder();
    for (let i = 1; i <= 10_005; i++) {
      recorder.recordApiRequest({ status: 200, durationMs: i });
    }
    const counts = recorder.apiRequestCounts();
    expect(counts.total).toBe(10_005);
    expect(counts.latencySamples).toBe(10_000);
    // Retained window is 6..10005: P95 = 6 + 9499 = 9505.
    const evaluation = recorder.evaluateAndRecordSlo({
      uptimeTargetRatio: 0.99,
      p95LatencyMaxMs: 600_000,
    });
    expect(evaluation.p95Latency.valueMs).toBe(9505);
  });

  it("is a no-op when the recording domain is gated off", () => {
    const { recorder } = liveRecorder(defaultSettings(), () => false);
    recorder.recordApiRequest({ status: 200, durationMs: 12 });
    expect(recorder.apiRequestCounts()).toEqual({ total: 0, failed: 0, latencySamples: 0 });
    const evaluation = recorder.evaluateAndRecordSlo({
      uptimeTargetRatio: 0.99,
      p95LatencyMaxMs: 1000,
    });
    expect(evaluation.uptime.withinSlo).toBeNull();
    expect(evaluation.p95Latency.withinSlo).toBeNull();
  });

  it("evaluateAndRecordSlo keeps the last evaluation for the read path", () => {
    const { recorder } = liveRecorder();
    expect(recorder.lastApiSlo()).toBeNull();
    recorder.recordApiRequest({ status: 200, durationMs: 50 });
    const evaluation = recorder.evaluateAndRecordSlo({
      uptimeTargetRatio: 0.99,
      p95LatencyMaxMs: 1000,
    });
    expect(recorder.lastApiSlo()).toEqual(evaluation);
    expect(evaluation.uptime).toEqual({ value: 1, withinSlo: true, target: 0.99 });
    expect(evaluation.p95Latency).toEqual({ valueMs: 50, withinSlo: true, targetMs: 1000 });
    expect(evaluation.totalRequests).toBe(1);
    expect(evaluation.failedRequests).toBe(0);
    expect(evaluation.latencySamples).toBe(1);
  });

  it("an unconfigured SLO is not evaluated and claims nothing (gauge skipped)", () => {
    const { recorder } = liveRecorder();
    recorder.recordApiRequest({ status: 200, durationMs: 50 });
    const evaluation = recorder.evaluateAndRecordSlo({
      uptimeTargetRatio: null,
      p95LatencyMaxMs: 1000,
    });
    expect(evaluation.uptime).toEqual({ value: 1, withinSlo: null, target: null });
    expect(evaluation.p95Latency.withinSlo).toBe(true);
  });
});

describe("aggregation pin: duration data aggregated against the thresholds (#5425)", () => {
  it("aggregates 100 requests (durations 1..100ms, 2 failures) into uptime + P95", () => {
    const { recorder } = liveRecorder();
    for (let i = 1; i <= 100; i++) {
      // The last two requests fail: 98/100 succeed.
      recorder.recordApiRequest({ status: i > 98 ? 500 : 200, durationMs: i });
    }
    const thresholds: ApiSloThresholds = { uptimeTargetRatio: 0.99, p95LatencyMaxMs: 100 };
    const evaluation = recorder.evaluateAndRecordSlo(thresholds);
    expect(evaluation.totalRequests).toBe(100);
    expect(evaluation.failedRequests).toBe(2);
    expect(evaluation.uptime.value).toBeCloseTo(0.98);
    expect(evaluation.uptime.withinSlo).toBe(false);
    expect(evaluation.p95Latency.valueMs).toBe(95);
    expect(evaluation.p95Latency.withinSlo).toBe(true);
  });
});

describe("tenant-scoped SLO thresholds store (#5425)", () => {
  it("round-trips through the commercial store port; absent reads null", async () => {
    const store = new InMemoryCommercialAdapter();
    expect(await store.getTenantSloUptimeTargetRatio("primary")).toBeNull();
    expect(await store.getTenantSloP95LatencyMaxMs("primary")).toBeNull();
    const record = await store.setTenantSloUptimeTargetRatio("primary", 0.99);
    expect(record.sloUptimeTargetRatio).toBe(0.99);
    expect(record.sloP95LatencyMaxMs).toBeNull();
    const record2 = await store.setTenantSloP95LatencyMaxMs("primary", 1000);
    expect(record2.sloP95LatencyMaxMs).toBe(1000);
    expect(record2.sloUptimeTargetRatio).toBe(0.99);
    expect(await store.getTenantSloUptimeTargetRatio("primary")).toBe(0.99);
    expect(await store.getTenantSloP95LatencyMaxMs("primary")).toBe(1000);
    // A sibling tenant is untouched: the values are tenant-scoped.
    expect(await store.getTenantSloUptimeTargetRatio("second")).toBeNull();
    expect(await store.getTenantSloP95LatencyMaxMs("second")).toBeNull();
  });

  it("sibling setters preserve the SLO thresholds", async () => {
    const store = new InMemoryCommercialAdapter();
    await store.setTenantSloUptimeTargetRatio("primary", 0.99);
    await store.setTenantSloP95LatencyMaxMs("primary", 1000);
    const afterAds = await store.setTenantAdsEnabled("primary", false);
    expect(afterAds.sloUptimeTargetRatio).toBe(0.99);
    expect(afterAds.sloP95LatencyMaxMs).toBe(1000);
    const afterProviders = await store.setTenantProviders("primary", {
      dataProviderId: "alpaca",
      brokerId: "alpaca",
    });
    expect(afterProviders.sloUptimeTargetRatio).toBe(0.99);
    expect(afterProviders.sloP95LatencyMaxMs).toBe(1000);
  });

  it("the PATCH body schema accepts the SLO fields", () => {
    expect(
      tenantSettingsBodySchema.safeParse({ sloUptimeTargetRatio: 0.99 }).success,
    ).toBe(true);
    expect(
      tenantSettingsBodySchema.safeParse({ sloP95LatencyMaxMs: 1000 }).success,
    ).toBe(true);
    expect(
      tenantSettingsBodySchema.safeParse({ sloUptimeTargetRatio: "high" }).success,
    ).toBe(false);
    expect(
      tenantSettingsBodySchema.safeParse({ sloP95LatencyMaxMs: "soon" }).success,
    ).toBe(false);
  });
});

describe("migration 0079: tenant SLO threshold columns (#5425)", () => {
  it("adds slo_uptime_target_ratio + slo_p95_latency_max_ms to agent_tenant_settings and registers in ALL_MIGRATIONS", () => {
    const sql = d1MigrationSql(79);
    expect(sql).toContain("ALTER TABLE agent_tenant_settings ADD COLUMN slo_uptime_target_ratio");
    expect(sql).toContain("ALTER TABLE agent_tenant_settings ADD COLUMN slo_p95_latency_max_ms");
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(versions).toContain(79);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("SLO read endpoint (#5425)", () => {
  function sloDeps(overrides: Partial<OtelSloRouteDeps> = {}): {
    deps: OtelSloRouteDeps;
    audits: unknown[];
    store: InMemoryCommercialAdapter;
    recorder: OtelMetricsRecorder;
  } {
    const audits: unknown[] = [];
    const store = new InMemoryCommercialAdapter();
    const { recorder } = liveRecorder();
    const deps: OtelSloRouteDeps = {
      requireSession: async () => fakeSession(),
      isPlatformAdmin: async () => true,
      audit: async (_env, input) => {
        audits.push(input);
        return true;
      },
      commercial: () => store as unknown as CommercialStore,
      recorder: () => recorder,
      ...overrides,
    };
    return { deps, audits, store, recorder };
  }

  function sloRequest(tenantId?: string): { request: Request; url: URL } {
    const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
    const url = new URL(`https://example.test${OTEL_SLO_ROUTE}${qs}`);
    return { request: new Request(url, { method: "GET" }), url };
  }

  it("returns null for a non-matching path", async () => {
    const { deps } = sloDeps();
    const url = new URL("https://example.test/api/otel/v1/other");
    expect(
      await handleSloRoutes(new Request(url, { method: "GET" }), {} as never, url, "/api/otel/v1/other", deps),
    ).toBeNull();
  });

  it("rejects non-GET with 405", async () => {
    const { deps } = sloDeps();
    const url = new URL(`https://example.test${OTEL_SLO_ROUTE}`);
    const res = await handleSloRoutes(
      new Request(url, { method: "POST" }),
      {} as never,
      url,
      OTEL_SLO_ROUTE,
      deps,
    );
    expect(res?.status).toBe(405);
  });

  it("returns 401 without a session", async () => {
    const { deps } = sloDeps({ requireSession: async () => null });
    const { request, url } = sloRequest();
    const res = await handleSloRoutes(request, {} as never, url, OTEL_SLO_ROUTE, deps);
    expect(res?.status).toBe(401);
  });

  it("returns 403 for a signed-in non-admin, with a deny audit", async () => {
    const { deps, audits } = sloDeps({ isPlatformAdmin: async () => false });
    const { request, url } = sloRequest();
    const res = await handleSloRoutes(request, {} as never, url, OTEL_SLO_ROUTE, deps);
    expect(res?.status).toBe(403);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { decision: string }).decision).toBe("deny");
  });

  it("fails closed with 500 when the audit record cannot be written", async () => {
    const { deps } = sloDeps({ audit: async () => false });
    const { request, url } = sloRequest();
    const res = await handleSloRoutes(request, {} as never, url, OTEL_SLO_ROUTE, deps);
    expect(res?.status).toBe(500);
  });

  it("reports both SLOs unconfigured when no thresholds are stored (claims nothing)", async () => {
    const { deps } = sloDeps();
    const { request, url } = sloRequest();
    const res = await handleSloRoutes(request, {} as never, url, OTEL_SLO_ROUTE, deps);
    expect(res?.status).toBe(200);
    const body = parseOtelSloResponse(await res!.json());
    expect(body.tenantId).toBe("primary");
    expect(body.uptime).toEqual({ status: "unconfigured", value: null, target: null });
    expect(body.p95Latency).toEqual({ status: "unconfigured", valueMs: null, targetMs: null });
    expect(body.sample).toEqual({ totalRequests: 0, failedRequests: 0, latencySamples: 0 });
  });

  it("reports no-data when thresholds are set but no requests were recorded", async () => {
    const { deps, store } = sloDeps();
    await store.setTenantSloUptimeTargetRatio("primary", 0.99);
    await store.setTenantSloP95LatencyMaxMs("primary", 1000);
    const { request, url } = sloRequest();
    const res = await handleSloRoutes(request, {} as never, url, OTEL_SLO_ROUTE, deps);
    expect(res?.status).toBe(200);
    const body = parseOtelSloResponse(await res!.json());
    expect(body.uptime.status).toBe("no-data");
    expect(body.uptime.target).toBe(0.99);
    expect(body.p95Latency.status).toBe("no-data");
    expect(body.p95Latency.targetMs).toBe(1000);
  });

  it("reporting pin: returns the fresh evaluation for the tenant's thresholds", async () => {
    const { deps, store, recorder } = sloDeps();
    await store.setTenantSloUptimeTargetRatio("primary", 0.99);
    await store.setTenantSloP95LatencyMaxMs("primary", 100);
    for (let i = 1; i <= 100; i++) {
      recorder.recordApiRequest({ status: i > 98 ? 500 : 200, durationMs: i });
    }
    const { request, url } = sloRequest();
    const res = await handleSloRoutes(request, {} as never, url, OTEL_SLO_ROUTE, deps);
    expect(res?.status).toBe(200);
    const body = parseOtelSloResponse(await res!.json());
    expect(body.sample).toEqual({ totalRequests: 100, failedRequests: 2, latencySamples: 100 });
    expect(body.uptime.status).toBe("breached");
    expect(body.uptime.value).toBeCloseTo(0.98);
    expect(body.uptime.target).toBe(0.99);
    expect(body.p95Latency.status).toBe("within");
    expect(body.p95Latency.valueMs).toBe(95);
    expect(body.p95Latency.targetMs).toBe(100);
    expect(typeof body.evaluatedAtMs).toBe("number");
  });

  it("reads the tenant named by ?tenantId= (thresholds are tenant-scoped)", async () => {
    const { deps, store, recorder } = sloDeps();
    await store.setTenantSloUptimeTargetRatio("primary", 0.99);
    await store.setTenantSloUptimeTargetRatio("second", 0.5);
    await store.setTenantSloP95LatencyMaxMs("primary", 1000);
    await store.setTenantSloP95LatencyMaxMs("second", 1000);
    recorder.recordApiRequest({ status: 500, durationMs: 10 });
    recorder.recordApiRequest({ status: 200, durationMs: 10 });
    const { request, url } = sloRequest("second");
    const res = await handleSloRoutes(request, {} as never, url, OTEL_SLO_ROUTE, deps);
    expect(res?.status).toBe(200);
    const body = parseOtelSloResponse(await res!.json());
    expect(body.tenantId).toBe("second");
    // 1/2 uptime meets the second tenant's 0.5 target; it would breach primary's 0.99.
    expect(body.uptime.status).toBe("within");
    expect(body.uptime.target).toBe(0.5);
  });
});

describe("request observation callback (#5425)", () => {
  it("fires with the response status + duration on success (including 5xx)", async () => {
    const observed: { status: number; durationMs: number }[] = [];
    let clock = 1000;
    const wrapped = withRequestObservability(
      async () => new Response("err", { status: 503 }),
      {
        sinkFor: () => null,
        nowMs: () => (clock += 10),
        onRequestObserved: (obs) => {
          observed.push(obs);
        },
      },
    );
    const res = await wrapped(new Request("https://example.test/api/x"), {});
    expect(res.status).toBe(503);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.status).toBe(503);
    expect(observed[0]!.durationMs).toBe(10);
  });

  it("fires with status 500 when the handler throws, and the throw still propagates", async () => {
    const observed: { status: number; durationMs: number }[] = [];
    const wrapped = withRequestObservability(
      async () => {
        throw new Error("boom");
      },
      {
        sinkFor: () => null,
        onRequestObserved: (obs) => {
          observed.push(obs);
        },
      },
    );
    await expect(wrapped(new Request("https://example.test/api/x"), {})).rejects.toThrow("boom");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.status).toBe(500);
  });

  it("a throwing callback never breaks the response", async () => {
    const wrapped = withRequestObservability(async () => new Response("ok", { status: 200 }), {
      sinkFor: () => null,
      onRequestObserved: () => {
        throw new Error("callback blew up");
      },
    });
    const res = await wrapped(new Request("https://example.test/api/x"), {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("SLO view on the observability home (#5425)", () => {
  it("adds 'slo' as a third view with its label", () => {
    expect(OBSERVABILITY_VIEWS).toEqual(["archive", "config", "slo"]);
    expect(OBSERVABILITY_VIEW_LABELS.slo).toBe("SLOs");
    expect(isObservabilityView("slo")).toBe(true);
  });

  it("parses ?view=slo and still falls back to archive for unknown views", () => {
    expect(parseObservabilityDeepLink("?view=slo").view).toBe("slo");
    expect(parseObservabilityDeepLink("?view=nope").view).toBe("archive");
    expect(parseObservabilityDeepLink("").view).toBe("archive");
    expect(normalizeObservabilityView("slo")).toBe("slo");
  });

  it("parses ?tenantId= for the per-tenant SLO read (default primary)", () => {
    expect(parseObservabilityDeepLink("?view=slo&tenantId=second").tenantId).toBe("second");
    expect(parseObservabilityDeepLink("?view=slo").tenantId).toBe("primary");
  });
});

describe("SLO read client (#5425)", () => {
  it("parses a well-formed SLO response", () => {
    const body = parseOtelSloResponse({
      tenantId: "primary",
      evaluatedAtMs: 1_700_000_000_000,
      sample: { totalRequests: 100, failedRequests: 2, latencySamples: 100 },
      uptime: { status: "breached", value: 0.98, target: 0.99 },
      p95Latency: { status: "within", valueMs: 95, targetMs: 100 },
    });
    expect(body.uptime.status).toBe("breached");
    expect(body.p95Latency.valueMs).toBe(95);
  });

  it("rejects a malformed SLO response", () => {
    expect(() => parseOtelSloResponse(null)).toThrow();
    expect(() =>
      parseOtelSloResponse({
        tenantId: "primary",
        evaluatedAtMs: 1,
        sample: { totalRequests: 1, failedRequests: 0, latencySamples: 1 },
        uptime: { status: "maybe", value: 1, target: 0.99 },
        p95Latency: { status: "within", valueMs: 1, targetMs: 100 },
      }),
    ).toThrow();
    expect(() =>
      parseOtelSloResponse({
        tenantId: "primary",
        evaluatedAtMs: 1,
        sample: { totalRequests: 1, failedRequests: 0, latencySamples: 1 },
        uptime: { status: "within", value: 1, target: 0.99 },
      }),
    ).toThrow();
  });
});
