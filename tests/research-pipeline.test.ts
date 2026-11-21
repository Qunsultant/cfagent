/**
 * Issue #319 — pipeline tests on fixture data.
 *
 * - End-to-end run produces exactly ONE stored canonical report
 *   (idempotent generation id).
 * - The stored report embeds the effective config snapshot (amendment 1);
 *   changing a threshold changes gate behavior AND the snapshot.
 * - "No qualifying opportunities" is a valid published outcome.
 * - Calibrated (non-live) chains can never qualify.
 * - Manual and scheduled triggers invoke the same pipeline entry with
 *   only the trigger source differing (amendment 2).
 */
import { describe, it, expect } from "vitest";
import {
  runResearchPipeline,
  type ResearchDataProvider,
  type QuoteSnapshot,
  type ChainSnapshot,
  type Technicals,
  type RegimeAssessment,
} from "../src/services/researchPipeline";
import {
  triggerManualResearch,
  triggerScheduledResearch,
} from "../src/services/researchTriggers";
import {
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchConfig,
} from "../src/services/researchConfig";
import {
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import { MockSqlStorage } from "./mock-sql";

const NOW = Date.now();

function chainLegs() {
  const mk = (
    optionType: "call" | "put",
    strike: number,
    bid: number,
    ask: number
  ) => ({
    optionType,
    strike,
    expiry: "2026-12-18",
    dte: 35,
    bid,
    ask,
    iv: 0.4,
    volume: 100,
    openInterest: 500,
  });
  return [
    mk("call", 95, 10.0, 10.4),
    mk("call", 100, 4.8, 5.0),
    mk("call", 105, 2.4, 2.6),
    mk("call", 110, 1.0, 1.1),
    mk("put", 90, 1.1, 1.2),
    mk("put", 95, 2.5, 2.7),
    mk("put", 100, 4.9, 5.1),
    mk("put", 105, 9.0, 9.4),
  ] as ChainSnapshot["expiries"][number]["legs"];
}

function fixtureProvider(opts: {
  provenance?: ChainSnapshot["provenance"];
  marketCap?: number | null;
  trend?: Technicals["trend"];
} = {}): ResearchDataProvider {
  const provenance = opts.provenance ?? "live";
  const quote = (symbol: string): QuoteSnapshot => ({
    symbol,
    price: 100,
    timestamp: NOW - 60_000,
    marketCap: opts.marketCap ?? 10e9,
    isEtf: false,
    quoteStatus: "live",
    source: "etrade",
  });
  return {
    getUniverseSymbols: async () => ["AAA"],
    getQuote: async (s) => quote(s),
    getChain: async (symbol) => ({
      symbol,
      underlyingPrice: 100,
      asOf: NOW - 60_000,
      provenance,
      expiries: [{ expiry: "2026-12-18", dte: 35, legs: chainLegs() }],
    }),
    getTechnicals: async () => ({
      trend: opts.trend ?? "up",
      momentum: 0.3,
      rsi: 58,
      notes: [],
    }),
    getCatalysts: async () => null,
    getRegime: async (): Promise<RegimeAssessment> => ({
      regime: "bull",
      notes: ["Fixture regime."],
      asOf: NOW,
    }),
  };
}

function testConfig(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    ...RESEARCH_CONFIG_DEFAULTS,
    maxCandidates: 4,
    maxChainsPerRun: 4,
    oodaMaxIterations: 10,
    ...overrides,
  };
}

describe("runResearchPipeline", () => {
  it("records every universe symbol, budget exclusion, data source and structure outcome", async () => {
    const base = fixtureProvider();
    const provider: ResearchDataProvider = {
      ...base,
      getUniverseSymbols: async () => ["AAA", "BBB", "CCC", "DDD"],
      getQuote: async (symbol) => symbol === "BBB" ? null : {
        symbol, price: 100, timestamp: NOW, marketCap: symbol === "CCC" ? 1_000_000_000 : 10_000_000_000,
        isEtf: false, quoteStatus: "live", source: "alpaca",
      },
      getChain: async (symbol) => ({
        symbol, underlyingPrice: 100, asOf: NOW, provenance: "live", source: "alpaca",
        expiries: [{ expiry: "2026-12-18", dte: 35, legs: chainLegs() }],
      }),
    };
    const report = await runResearchPipeline(
      { provider },
      testConfig({ maxCandidates: 1, maxChainsPerRun: 1 }),
      { trigger: "manual", userLogin: "tester", brokerId: "alpaca", mode: "paper", runId: "audit-test", now: NOW },
    );
    expect(report.symbolEvaluations).toHaveLength(4);
    expect(report.symbolEvaluations?.map(({ symbol, outcome }) => [symbol, outcome])).toEqual([
      ["AAA", "evaluated"], ["BBB", "quote_unavailable"], ["CCC", "filtered"], ["DDD", "not_screened"],
    ]);
    expect(report.symbolEvaluations?.[0].quote?.source).toBe("alpaca");
    expect(report.symbolEvaluations?.[0].chain?.source).toBe("alpaca");
    expect(report.symbolEvaluations?.[0].strategies.length).toBeGreaterThan(0);
    expect(report.stats.chainsAttempted).toBe(1);
    expect(report.brokerId).toBe("alpaca");
    expect(report.mode).toBe("paper");
  });

  it("counts empty option-chain responses as attempted refusals within the chain budget", async () => {
    const base = fixtureProvider();
    const report = await runResearchPipeline(
      {
        provider: {
          ...base,
          getUniverseSymbols: async () => ["AAA", "BBB"],
          getChain: async (symbol) => ({ symbol, underlyingPrice: 0, asOf: NOW, provenance: "unavailable", source: "alpaca", expiries: [] }),
        },
      },
      testConfig({ maxChainsPerRun: 1 }),
      { trigger: "manual", userLogin: "tester", runId: "empty-chain-test", now: NOW },
    );
    expect(report.stats.chainsAttempted).toBe(1);
    expect(report.stats.chainsFetched).toBe(0);
    expect(report.symbolEvaluations?.[0]).toMatchObject({ outcome: "chain_failed", chain: { outcome: "failed", source: "alpaca", expiryCount: 0 } });
    expect(report.symbolEvaluations?.[1]).toMatchObject({ outcome: "not_evaluated" });
  });

  it("qualifies ideas on clean fixture data", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider() },
      testConfig(),
      { trigger: "manual", userLogin: "tester", runId: "rsr_test1", now: NOW }
    );
    expect(report.ideas.length).toBeGreaterThan(0);
    expect(report.ideas.length).toBeLessThanOrEqual(5);
    const card = report.ideas[0];
    expect(card.symbol).toBe("AAA");
    expect(card.scenarios).toHaveLength(5);
    expect(card.falsification.invalidation.length).toBeGreaterThan(0);
    expect(card.premortem.causes.length).toBe(7);
    expect(card.limitations.length).toBeGreaterThan(0);
    expect(card.sources.length).toBeGreaterThan(0);
    // Amendment 1: effective config snapshot embedded.
    expect(report.configSnapshot.marketCapMin).toBe(5_000_000_000);
    expect(report.rulesVersion).toBe("1.0.0");
    expect(report.trigger).toBe("manual");
  });

  it("trace entries carry level-qualified short ids (#4774)", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider() },
      testConfig(),
      { trigger: "manual", userLogin: "tester", runId: "rsr_test4774", now: NOW }
    );
    expect(report.runId).toBe("rsr_test4774");
    // The candidate-level OODA loop: every entry is `ooda:<stage>`.
    expect(report.oodaTrace.length).toBeGreaterThan(0);
    for (const step of report.oodaTrace) {
      expect(step.shortId).toBe(`ooda:${step.stage}`);
    }
    // The run-level pipeline stages carry no shortId: `respipe:` was
    // retired by the uniform-convention adoption (#5175) — a run-level
    // stage is identified by its stage execution id.
    expect(report.stageTrace.length).toBeGreaterThan(0);
    for (const step of report.stageTrace) {
      expect("shortId" in step).toBe(false);
    }
    // The bare stage strings are unchanged — only the short id differs.
    expect(report.oodaTrace.some((s) => s.stage === "observe")).toBe(true);
    expect(report.stageTrace.some((s) => s.stage === "observe")).toBe(true);
  });

  it("stores exactly ONE canonical report (idempotent generation id)", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider() },
      testConfig(),
      { trigger: "manual", userLogin: "tester", runId: "rsr_test2", now: NOW }
    );
    const sql = new MockSqlStorage();
    const input = {
      runId: report.runId,
      generationId: report.generationId,
      title: "Options research — fixture",
      source: "options_research",
      summary: report.summary,
      body: report as unknown as Record<string, unknown>,
      userLogin: "tester",
    };
    const first = storeReportAtGeneration(sql, input);
    const second = storeReportAtGeneration(sql, input);
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(first?.reportId).toBe(second?.reportId);
    const rows = Array.from(
      sql.exec("SELECT COUNT(*) AS count FROM mas_reports")
    ) as Array<{ count: number }>;
    expect(rows[0].count).toBe(1);
    // The stored body embeds the config snapshot.
    const bodies = Array.from(
      sql.exec("SELECT body FROM mas_reports")
    ) as Array<{ body: string }>;
    const storedBody = JSON.parse(String(bodies[0].body));
    expect(storedBody.configSnapshot.marketCapMin).toBe(5_000_000_000);
    expect(storedBody.trigger).toBe("manual");
  });

  it("amendment 1: a tightened threshold changes gate behavior and the snapshot", async () => {
    const tight: ResearchConfig = testConfig({ maxSpreadPct: 0.001 });
    const report = await runResearchPipeline(
      { provider: fixtureProvider() },
      tight,
      { trigger: "manual", userLogin: "tester", runId: "rsr_test3", now: NOW }
    );
    // 4% spreads cannot pass a 0.1% threshold — ideas demote to watchlist.
    expect(report.ideas).toHaveLength(0);
    expect(report.watchlist.length).toBeGreaterThan(0);
    expect(
      report.watchlist.some((w) => w.reason.toLowerCase().includes("spread"))
    ).toBe(true);
    expect(report.configSnapshot.maxSpreadPct).toBe(0.001);
  });

  it("publishes 'no qualifying opportunities' when everything is filtered", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider({ marketCap: 1e9 }) },
      testConfig(),
      { trigger: "scheduled", userLogin: "default", runId: "rsr_test4", now: NOW }
    );
    expect(report.ideas).toHaveLength(0);
    expect(report.summary).toMatch(/No qualifying opportunities/);
    expect(report.trigger).toBe("scheduled");
  });

  it("calibrated chains never qualify (watchlist at best)", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider({ provenance: "calibrated" }) },
      testConfig(),
      { trigger: "manual", userLogin: "tester", runId: "rsr_test5", now: NOW }
    );
    expect(report.ideas).toHaveLength(0);
    expect(report.watchlist.length).toBeGreaterThan(0);
    expect(
      report.watchlist[0].reason.toLowerCase()
    ).toMatch(/calibrated/);
  });
});

describe("thin triggers (amendment 2)", () => {
  it("manual and scheduled invoke the same entry with only the trigger differing", async () => {
    const calls: Array<{ trigger: string; userLogin?: string }> = [];
    const publish = async (trigger: "manual" | "scheduled", userLogin?: string) => {
      calls.push({ trigger, userLogin });
      return { ok: true as const };
    };
    await triggerManualResearch(publish, "u1");
    // Issue #2327: the scheduled trigger no longer defaults the
    // login to "default" — the caller supplies it explicitly (in
    // production the tick route passes the service identity). The
    // same login is passed here so the pin keeps its exact intent:
    // the two invocations differ ONLY in the trigger.
    await triggerScheduledResearch(publish, "u1");
    expect(calls).toEqual([
      { trigger: "manual", userLogin: "u1" },
      { trigger: "scheduled", userLogin: "u1" },
    ]);
  });
});
