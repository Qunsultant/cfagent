/**
 * Issue #319 (amendment 1) — config service tests.
 * The spec defaults table is the fallback; every gate reads thresholds
 * from the loaded config; nothing is hardcoded in the pipeline.
 */
import { describe, it, expect } from "vitest";
import {
  ResearchConfigService,
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchSettingsStore,
} from "../src/services/researchConfig";

function memStore(): ResearchSettingsStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get: (k: string) => (raw.has(k) ? raw.get(k)! : null),
    set: (k: string, v: string) => void raw.set(k, v),
  };
}

describe("ResearchConfigService", () => {
  it("defaults match the spec table", () => {
    expect(RESEARCH_CONFIG_DEFAULTS.marketCapMin).toBe(5_000_000_000);
    expect(RESEARCH_CONFIG_DEFAULTS.priceCap).toBeNull();
    expect(RESEARCH_CONFIG_DEFAULTS.maxIdeas).toBe(5);
    expect(RESEARCH_CONFIG_DEFAULTS.ownershipStrategiesAllowed).toBe(false);
    expect(RESEARCH_CONFIG_DEFAULTS.etfsIncluded).toBe(true);
    expect(RESEARCH_CONFIG_DEFAULTS.rulesVersion).toBe("1.0.0");
  });

  it("loads defaults from an empty store", () => {
    const svc = new ResearchConfigService(memStore());
    expect(svc.load()).toEqual(RESEARCH_CONFIG_DEFAULTS);
  });

  it("round-trips overrides", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { config, errors } = svc.save({ maxSpreadPct: 0.1, ownershipStrategiesAllowed: true });
    expect(errors).toEqual([]);
    expect(config.maxSpreadPct).toBe(0.1);
    expect(config.ownershipStrategiesAllowed).toBe(true);
    // A fresh service over the same store sees the overrides.
    expect(new ResearchConfigService(store).load().maxSpreadPct).toBe(0.1);
  });

  it("rejects invalid patches atomically (nothing written)", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { config, errors } = svc.save({ maxSpreadPct: -3 as unknown as number });
    expect(errors.length).toBeGreaterThan(0);
    expect(store.raw.size).toBe(0);
    expect(config.maxSpreadPct).toBe(RESEARCH_CONFIG_DEFAULTS.maxSpreadPct);
  });

  it("rejects a malformed email recipient", () => {
    const svc = new ResearchConfigService(memStore());
    const { errors } = svc.save({ emailTo: "not-an-email" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("fails closed to defaults on corrupt stored values", () => {
    const store = memStore();
    store.set("research.maxSpreadPct", "banana");
    const svc = new ResearchConfigService(store);
    expect(svc.load().maxSpreadPct).toBe(RESEARCH_CONFIG_DEFAULTS.maxSpreadPct);
  });

  it("snapshot() deep-copies (report embedding cannot alias live config)", () => {
    const svc = new ResearchConfigService(memStore());
    const snap = svc.snapshot(svc.load());
    snap.maxIdeas = 99;
    expect(svc.load().maxIdeas).toBe(RESEARCH_CONFIG_DEFAULTS.maxIdeas);
  });

  it("#6466 — settlement wait: null by default (the deployment default governs)", () => {
    expect(RESEARCH_CONFIG_DEFAULTS.settlementWaitMs).toBeNull();
    expect(new ResearchConfigService(memStore()).load().settlementWaitMs).toBeNull();
  });

  it("#6466 — settlement wait: a stored value round-trips", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { config, errors } = svc.save({ settlementWaitMs: 1_500_000 });
    expect(errors).toEqual([]);
    expect(config.settlementWaitMs).toBe(1_500_000);
    expect(new ResearchConfigService(store).load().settlementWaitMs).toBe(1_500_000);
  });

  it("#6466 — settlement wait: an out-of-range value is refused atomically", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { errors } = svc.save({ settlementWaitMs: 2_000_000 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/settlementWaitMs/);
    expect(store.raw.size).toBe(0);
  });

  it("#6466 — stage timeouts: a stored per-stage map round-trips", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { config, errors } = svc.save({ stageTimeouts: { analyze: 900_000 } });
    expect(errors).toEqual([]);
    expect(config.stageTimeouts).toEqual({ analyze: 900_000 });
    expect(new ResearchConfigService(store).load().stageTimeouts).toEqual({ analyze: 900_000 });
  });

  it("#6466 — stage timeouts: an unknown stage is refused atomically", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { errors } = svc.save({ stageTimeouts: { nope: 1000 } as never });
    expect(errors.length).toBeGreaterThan(0);
    expect(store.raw.size).toBe(0);
  });

  it("#6466 — stage retry buckets: a stored per-stage map round-trips", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { config, errors } = svc.save({ stageRetryBuckets: { feed: "delivery" } });
    expect(errors).toEqual([]);
    expect(config.stageRetryBuckets).toEqual({ feed: "delivery" });
    expect(new ResearchConfigService(store).load().stageRetryBuckets).toEqual({ feed: "delivery" });
  });

  it("#6466 — stage retry buckets: an unknown bucket is refused atomically", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { errors } = svc.save({ stageRetryBuckets: { feed: "nope" } as never });
    expect(errors.length).toBeGreaterThan(0);
    expect(store.raw.size).toBe(0);
  });
});
