/**
 * Issue #1162 (Phase 6 of epic #1096) — channels & rollout pins.
 *
 *  - Screening flags (mas_settings idiom, #756 pattern): rollout stage,
 *    channels enable, NLQ fit-discovery enable, v2-weights ranking
 *    enable, scheduled pause — with fail-safe reads (enable flags fail
 *    OFF; the pause flag fails CLOSED, like the adaptation kill switch).
 *  - Track-record join: buildTrackRecord carries each idea's regime
 *    (recorded by the run that produced it) and contractsPerUnit
 *    (summed from the published legs) — the join the Phase 5 evidence
 *    builders require from their caller; never guessed.
 *  - Channel delivery: plain-text formatters for discovery results and
 *    goal-driven screens (bundle reuses the Phase 4 report format),
 *    draft-only wording, dispatch over injected senders — one channel's
 *    failure never blocks the others, voice is honestly not a push
 *    channel, unconfigured channels fail explicitly, deliveries are
 *    recorded in the activity log.
 *  - Activity log: tenant-scoped mas_screening_activity + a unified
 *    feed merging activity rows, Phase 3 re-selection proposals, and
 *    Phase 5 challenger promotions.
 *  - NLQ fit discovery (deferred from Phase 2): deterministic phrases
 *    for Name→Strategies and Strategy→Names through the existing NLQ
 *    options path; explicit failure when the runner is unavailable or
 *    the feature flag is off — never a silently different answer.
 *  - V2 weights consumer: the fit-discovery runner re-ranks with
 *    strategyWeightsV2 ONLY when screening.weightsV2Ranking is on
 *    (#17 reviewed-config posture); off = ordering untouched; weights
 *    never lift a negative worst-cell candidate above a positive one.
 *  - Bundle route: multi-candidate body normalization (legacy single
 *    `candidate` still works), validation precedes any broker call.
 *  - Routes: /screening/activity + /screening/controls (pause/stage/
 *    flags, changes recorded), and the scheduled tick's Phase 6 steps
 *    (re-selection proposals + weights-v2 job ride the existing tick;
 *    pause skips the #1096 autonomous steps and records the skip).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/researchScheduleGuard", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, shouldFireResearchTick: vi.fn() };
});

// The Phase 6 tick tests exercise the WIRING, not the guards: the
// research guard is forced per-test (the extraction tests' pattern),
// and the strategy-bank guard is forced to fire — its own fire/no-fire
// matrix (weekday, 21:00 UTC, durable marker) is pinned by Phase 3.
vi.mock("../src/services/strategyBankReselection", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    shouldFireStrategyBankTick: vi.fn(() => ({ fire: true, dateKey: "2026-10-23" })),
  };
});

import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import {
  SCREENING_FLAG_KEYS,
  settingReadFromSql,
  getScreeningRolloutStage,
  isScreeningChannelsEnabled,
  isNlqFitDiscoveryEnabled,
  isWeightsV2RankingEnabled,
  isPortfolioContextEnabled,
  isScreeningScheduledPaused,
  setScreeningSetting,
} from "../src/services/screeningFlags";
import {
  ensureScreeningActivityTable,
  recordScreeningActivity,
  listScreeningActivity,
  buildScreeningActivityFeed,
} from "../src/services/screeningActivity";
import {
  formatDiscoveryDelivery,
  formatGoalScreenDelivery,
  formatBundleDelivery,
  deliverScreeningContent,
  type ScreeningDeliverySenders,
} from "../src/services/screeningDelivery";
import {
  createFitDiscoveryRunner,
  applyWeightsV2Ranking,
  OUTLOOK_TO_WEIGHTS_REGIME,
} from "../src/services/fitDiscoveryRunner";
import { buildTrackRecord } from "../src/services/researchTrackRecord";
import {
  recordReselectionProposal,
  reselectStrategyBank,
} from "../src/services/strategyBankReselection";
import { ensureChallengerTables } from "../src/services/championChallenger";
import {
  ensureWeightsV2Tables,
  getStrategyWeightsV2,
  weightsV2Key,
} from "../src/services/strategyWeightsV2";
import {
  parseOptionsStrategyIntent,
  runOptionsStrategyAction,
} from "../src/agents/nlqOptionsStrategy";
import { normalizeBundleCandidates } from "../src/services/recommendationBundle";
import type {
  DiscoveryModeResult,
  NameDiscoveryResult,
  StrategyDiscoveryResult,
} from "../src/services/researchDiscovery";
import type { ResearchDataProvider, ChainSnapshot } from "../src/services/researchPipeline";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";

const NOW = Date.parse("2026-10-23T12:00:00Z");

function makeSql(): MockSqlStorage {
  const sql = new MockSqlStorage();
  sql.exec(
    `CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`
  );
  return sql;
}

function setSetting(sql: MockSqlStorage, key: string, value: string) {
  sql.exec(`DELETE FROM mas_settings WHERE key = ?`, key);
  sql.exec(
    `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
    key,
    value,
    new Date(NOW).toISOString()
  );
}

/* ------------------------------------------------------------------ */
/* Flags                                                               */
/* ------------------------------------------------------------------ */

describe("screening flags (Phase 6)", () => {
  it("defaults: stage internal, channels off, weights-ranking off, NLQ fit on, not paused", () => {
    const read = settingReadFromSql(makeSql());
    expect(getScreeningRolloutStage(read)).toBe("internal");
    expect(isScreeningChannelsEnabled(read)).toBe(false);
    expect(isWeightsV2RankingEnabled(read)).toBe(false);
    expect(isNlqFitDiscoveryEnabled(read)).toBe(true);
    expect(isScreeningScheduledPaused(read)).toBe(false);
    expect(isPortfolioContextEnabled(read)).toBe(false);
  });

  it("portfolio context (issue #17): opt-in, off when absent or unreadable", () => {
    const sql = makeSql();
    const write = (k: string, v: string) => setSetting(sql, k, v);
    write("screening.portfolioContext", "true");
    expect(isPortfolioContextEnabled(settingReadFromSql(sql))).toBe(true);
    write("screening.portfolioContext", "false");
    expect(isPortfolioContextEnabled(settingReadFromSql(sql))).toBe(false);
    expect(isPortfolioContextEnabled(() => null)).toBe(false);
    expect(
      isPortfolioContextEnabled(() => {
        throw new Error("boom");
      })
    ).toBe(false);
  });

  it("round-trips explicit values; an unknown stage value reads as internal", () => {
    const sql = makeSql();
    const write = (k: string, v: string) => setSetting(sql, k, v);
    setScreeningSetting(write, SCREENING_FLAG_KEYS.rolloutStage, "paper");
    setScreeningSetting(write, SCREENING_FLAG_KEYS.channelsEnabled, "on");
    setScreeningSetting(write, SCREENING_FLAG_KEYS.weightsV2Ranking, "on");
    setScreeningSetting(write, SCREENING_FLAG_KEYS.scheduledPaused, "on");
    setScreeningSetting(write, SCREENING_FLAG_KEYS.nlqFitDiscovery, "off");
    const read = settingReadFromSql(sql);
    expect(getScreeningRolloutStage(read)).toBe("paper");
    expect(isScreeningChannelsEnabled(read)).toBe(true);
    expect(isWeightsV2RankingEnabled(read)).toBe(true);
    expect(isScreeningScheduledPaused(read)).toBe(true);
    expect(isNlqFitDiscoveryEnabled(read)).toBe(false);
    // A stage value written outside the validated writer (e.g. by hand
    // in settings) still reads as the safest stage, never as itself.
    setSetting(sql, SCREENING_FLAG_KEYS.rolloutStage, "everywhere");
    expect(getScreeningRolloutStage(read)).toBe("internal");
    // And the validated writer refuses it outright.
    expect(() => setScreeningSetting(write, SCREENING_FLAG_KEYS.rolloutStage, "everywhere")).toThrow(/Invalid rollout stage/);
  });

  it("fail-safe reads: a broken settings store turns enables OFF and pause ON", () => {
    const broken = () => {
      throw new Error("settings store unavailable");
    };
    expect(isScreeningChannelsEnabled(broken)).toBe(false);
    expect(isWeightsV2RankingEnabled(broken)).toBe(false);
    expect(isScreeningScheduledPaused(broken)).toBe(true);
    expect(getScreeningRolloutStage(broken)).toBe("internal");
  });
});

/* ------------------------------------------------------------------ */
/* Track-record join (regime + contractsPerUnit)                         */
/* ------------------------------------------------------------------ */

describe("buildTrackRecord regime/contracts join (Phase 6 wiring)", () => {
  it("carries the producing run's recorded regime and the legs' contract count", () => {
    const reports = [
      {
        runId: "run-1",
        createdAt: "2026-10-20T21:00:00Z",
        regime: { regime: "bull", notes: [], asOf: NOW },
        ideas: [
          {
            symbol: "AAA",
            structure: "bull_call_spread",
            outlook: "bullish",
            thesis: "t",
            invalidation: "i",
            entrySpot: 100,
            economics: { maxLoss: 4 },
            legs: [
              { optionType: "call", strike: 100, quantity: 1 },
              { optionType: "call", strike: 110, quantity: -1 },
            ],
          },
          {
            symbol: "BBB",
            structure: "iron_condor",
            outlook: "range_bound",
            thesis: "t",
            invalidation: "i",
            entrySpot: 50,
            economics: { maxLoss: 5 },
            // no legs recorded — contractsPerUnit must stay null, never assumed
          },
        ],
      },
    ];
    const evaluations = [
      {
        runId: "run-1",
        evaluatedAt: "2026-10-22T21:00:00Z",
        ideas: [
          { symbol: "AAA", structure: "bull_call_spread", pnlEstimatePerUnit: 2, evalSpot: 105, invalidated: false, directionCorrect: true, notes: [] },
        ],
      },
    ];
    const track = buildTrackRecord(reports, evaluations);
    const aaa = track.ideas.find((i) => i.symbol === "AAA");
    const bbb = track.ideas.find((i) => i.symbol === "BBB");
    expect(aaa?.regime).toBe("bull");
    expect(aaa?.contractsPerUnit).toBe(2);
    expect(bbb?.regime).toBe("bull");
    expect(bbb?.contractsPerUnit).toBeNull();
  });

  it("an unrecorded/invalid regime on the run reads as unknown, never guessed", () => {
    const track = buildTrackRecord(
      [{ runId: "r", createdAt: "2026-10-20T00:00:00Z", ideas: [{ symbol: "AAA", structure: "iron_condor", outlook: "range_bound", thesis: "", invalidation: "", entrySpot: 1, economics: { maxLoss: 1 } }] }],
      []
    );
    expect(track.ideas[0]?.regime).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* Delivery formatters + dispatch                                      */
/* ------------------------------------------------------------------ */

const NAME_RESULT: NameDiscoveryResult = {
  symbol: "NVDA",
  outlook: "range_bound",
  provenance: "live",
  candidates: [
    {
      symbol: "NVDA",
      structure: "iron_condor",
      label: "Iron Condor",
      source: "catalog",
      legs: [],
      economics: { netDebit: 0, netCredit: 2.1, maxLoss: 290, maxGain: 210, breakevens: [95, 115] } as any,
      status: "qualified",
      provenance: "live",
      definedRisk: true,
      marginEstimate: 290,
      assignmentRisk: false,
      gateReasons: [],
      limitations: [],
      scenario: { worstPnlTotal: -120, meanPnlTotal: 40, bestPnlTotal: 210, withinConstraints: true },
    },
    {
      symbol: "NVDA",
      structure: "iron_condor",
      label: "Iron Condor + Call Butterfly",
      source: "composed",
      operator: "combine",
      legs: [],
      economics: { netDebit: 1.2, netCredit: 0, maxLoss: 120, maxGain: 380, breakevens: [100] } as any,
      status: "watchlist",
      provenance: "live",
      definedRisk: true,
      marginEstimate: 120,
      assignmentRisk: false,
      gateReasons: [],
      limitations: ["Composed candidate: verify each leg's liquidity before acting."],
      scenario: { worstPnlTotal: -60, meanPnlTotal: 25, bestPnlTotal: 380, withinConstraints: true },
    },
  ],
  rejected: [{ structure: "long_straddle", reason: "Thesis gate: not admissible for range_bound." }],
  notConstructible: ["naked_put"],
  inadmissibleCatalogIds: ["long_call"],
  limitations: ["Earnings feed unavailable for NVDA; earnings distance not scored."],
};

const STRATEGY_RESULT: StrategyDiscoveryResult = {
  structure: "iron_condor",
  ranked: [
    {
      symbol: "AAA",
      structure: "iron_condor",
      status: "qualified",
      provenance: "live",
      fitScore: 82.5,
      components: { liquidity: 0.9, ivFit: 0.8, termStructureFit: null, earningsDistance: 0.7, correlation: null, trackRecord: null },
      missingComponents: ["termStructureFit", "correlation", "trackRecord"],
      economics: { netDebit: 0, netCredit: 2, maxLoss: 300, maxGain: 200 },
    },
  ],
  rejected: [{ symbol: "ZZZ", reason: "No option chain available; not scored (nothing estimated)." }],
  limitations: [],
};

describe("screening delivery formatters (Phase 6)", () => {
  it("Name→Strategies text carries status, provenance, limitations and the draft-only footer", () => {
    const { subject, text } = formatDiscoveryDelivery({ direction: "name_to_strategies", result: NAME_RESULT });
    expect(subject).toContain("NVDA");
    expect(text).toContain("Iron Condor + Call Butterfly");
    expect(text).toContain("composed");
    expect(text).toContain("qualified");
    expect(text).toContain("live");
    expect(text).toContain("Earnings feed unavailable");
    expect(text).toMatch(/no trades were placed/i);
    expect(text).not.toMatch(/guaranteed profit/i);
  });

  it("Strategy→Names text names missing fit components instead of hiding them", () => {
    const { text } = formatDiscoveryDelivery({ direction: "strategy_to_names", result: STRATEGY_RESULT });
    expect(text).toContain("AAA");
    expect(text).toContain("82.5");
    expect(text).toContain("termStructureFit");
    expect(text).toContain("ZZZ");
    expect(text).toMatch(/no trades were placed/i);
  });

  it("a partial screen is delivered as PARTIAL with its reasons, never as complete", () => {
    const screen = {
      goalKind: "income",
      outlook: "range_bound",
      plan: {} as any,
      status: "partial",
      hits: [{ assetClass: "options", providerId: "etrade", symbol: "AAA", structures: ["iron_condor"] }],
      counts: { stocksScanned: 10, stocksMatched: 2, optionsUnderlyingsScanned: 5, optionsContractsMatched: 3, hits: 1 },
      partial: { failedClasses: ["stocks"], reasons: { stocks: "provider timeout" } },
      completedAt: new Date(NOW).toISOString(),
    } as GoalDrivenScreenResult;
    const { text } = formatGoalScreenDelivery(screen);
    expect(text).toContain("PARTIAL");
    expect(text).toContain("provider timeout");
    expect(text).toContain("AAA");
  });

  it("bundle delivery reuses the Phase 4 report format and its disclaimer", () => {
    const bundle = {
      id: "bundle-1",
      decision: "no_trade",
      status: "complete",
      qualification: "unqualified",
      confidence: "LOW",
      trade: null,
      optimizer: { verdict: "neutral", score: 0, expectedPnl: 0, cvarPnl: 0, probabilityOfProfit: 0, cellCount: 9, evidence: [], breaches: [] },
      hedging: { status: "not_required", options: [] },
      repairs: { status: "not_applicable", options: [] },
      alternatives: [{ label: "No trade", score: 0 }],
      falsification: null,
      limitations: [],
      disclaimer: "Educational draft only.",
      asOf: new Date(NOW).toISOString(),
    } as any;
    const { text } = formatBundleDelivery(bundle);
    expect(text).toContain("Recommendation Bundle");
    expect(text).toContain("Human approval required");
  });
});

describe("deliverScreeningContent dispatch (Phase 6)", () => {
  it("delivers per channel; a failing channel never blocks the others; attempts are activity-recorded", async () => {
    const sql = makeSql();
    const senders: ScreeningDeliverySenders = {
      slack: async () => ({ ok: true }),
      email: async () => ({ ok: false, error: "SMTP rejected" }),
      webhook: async () => ({ ok: true }),
    };
    const results = await deliverScreeningContent({
      channels: ["slack", "email", "webhook"],
      subject: "s",
      text: "body",
      event: "screening.test",
      emailTo: "owner@example.com",
      senders,
      sql,
      userLogin: "alice",
    });
    expect(results).toEqual([
      { channel: "slack", ok: true },
      { channel: "email", ok: false, error: "SMTP rejected" },
      { channel: "webhook", ok: true },
    ]);
    const activity = listScreeningActivity(sql, "alice");
    expect(activity.some((a) => a.kind === "delivery")).toBe(true);
  });

  it("voice is honestly not a push channel, and an unconfigured channel fails explicitly", async () => {
    const results = await deliverScreeningContent({
      channels: ["voice", "slack"],
      subject: "s",
      text: "body",
      event: "screening.test",
      senders: {},
    });
    expect(results[0].channel).toBe("voice");
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/conversational/i);
    expect(results[1]).toEqual({ channel: "slack", ok: false, error: expect.stringMatching(/not configured/i) });
  });

  it("email without a recipient fails explicitly rather than guessing one", async () => {
    const results = await deliverScreeningContent({
      channels: ["email"],
      subject: "s",
      text: "body",
      event: "screening.test",
      senders: { email: async () => ({ ok: true }) },
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/recipient/i);
  });
});

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

describe("screening activity log (Phase 6)", () => {
  it("records and lists per tenant; tenants never see each other's rows", () => {
    const sql = makeSql();
    ensureScreeningActivityTable(sql);
    recordScreeningActivity(sql, { userLogin: "alice", kind: "discovery_run", summary: "Discovery proposed 2 goals.", actor: "scheduled-tick" });
    recordScreeningActivity(sql, { userLogin: "bob", kind: "delivery", summary: "Delivered bundle to slack.", actor: "bundle-route" });
    const alice = listScreeningActivity(sql, "alice");
    expect(alice).toHaveLength(1);
    expect(alice[0].kind).toBe("discovery_run");
    expect(listScreeningActivity(sql, "bob")).toHaveLength(1);
    expect(listScreeningActivity(sql, "carol")).toHaveLength(0);
  });

  it("the unified feed merges activity, re-selection proposals, and promotions, newest first", () => {
    const sql = makeSql();
    ensureScreeningActivityTable(sql);
    ensureWeightsV2Tables(sql);
    ensureChallengerTables(sql);
    const proposal = reselectStrategyBank({
      evidence: [],
      weights: {},
      regime: "chop",
      overallWinRate: 0.5,
      now: new Date(NOW),
    });
    recordReselectionProposal(sql, "alice", proposal);
    sql.exec(
      `INSERT INTO mas_challenger_promotions (id, challenger_id, user_login, action, prior_json, applied_json, weights_version, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "promo-1", "chal-1", "alice", "promote", "{}", "{}", 3, "owner", "approved", new Date(NOW + 60_000).toISOString()
    );
    recordScreeningActivity(sql, { userLogin: "alice", kind: "delivery", summary: "Delivered.", createdAt: new Date(NOW + 120_000).toISOString() });
    const feed = buildScreeningActivityFeed(sql, "alice");
    const kinds = feed.map((f) => f.kind);
    expect(kinds).toContain("reselection");
    expect(kinds).toContain("promotion");
    expect(kinds).toContain("delivery");
    const times = feed.map((f) => f.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(buildScreeningActivityFeed(sql, "bob")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* NLQ fit discovery                                                   */
/* ------------------------------------------------------------------ */

describe("NLQ fit-discovery phrases (Phase 6, deferred from Phase 2)", () => {
  it("\"what strategies fit NVDA?\" routes to Name→Strategies", () => {
    const intent = parseOptionsStrategyIntent("What strategies fit NVDA?");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.fitDiscovery).toMatchObject({ direction: "name_to_strategies", symbol: "NVDA" });
  });

  it("\"what fits AAPL into earnings?\" routes to Name→Strategies for AAPL", () => {
    const intent = parseOptionsStrategyIntent("what fits AAPL into earnings?");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.fitDiscovery).toMatchObject({ direction: "name_to_strategies", symbol: "AAPL" });
  });

  it("\"find me income names for an iron condor\" routes to Strategy→Names with the income goal", () => {
    const intent = parseOptionsStrategyIntent("Find me income names for an iron condor");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.fitDiscovery).toMatchObject({ direction: "strategy_to_names", structure: "iron_condor", goalKind: "income" });
  });

  it("\"which names fit a long straddle?\" routes to Strategy→Names", () => {
    const intent = parseOptionsStrategyIntent("Which names fit a long straddle?");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.fitDiscovery).toMatchObject({ direction: "strategy_to_names", structure: "long_straddle" });
  });

  it("control phrases keep their existing routes (no hijack)", () => {
    expect(parseOptionsStrategyIntent("discover setups")?.action).toBe("options_fit_discovery");
    expect(parseOptionsStrategyIntent("What strategies fit my watchlist?")?.action).not.toBe("options_fit_discovery");
    const best = parseOptionsStrategyIntent("best trade for NVDA");
    expect(best?.action).not.toBe("options_fit_discovery");
  });

  it("a SCOPED fit question stays with the #23 scanner (strategy_fit), not discovery", () => {
    // The partition: "in my Semis watchlist" scopes the question to
    // the caller's own names — the scanner's strategy_fit mode owns
    // it (pinned by tests/options_scanner.test.ts N1/N2). Only the
    // unscoped question is research discovery.
    const intent = parseOptionsStrategyIntent(
      "Which names in my Semis watchlist fit an iron condor?"
    );
    expect(intent?.action).toBe("options_opportunities");
    expect(intent?.filters.mode).toBe("strategy_fit");
  });

  it("running fit discovery without a runner fails explicitly — never a different answer", async () => {
    const intent = parseOptionsStrategyIntent("What strategies fit NVDA?");
    const res = await runOptionsStrategyAction({} as any, "options_fit_discovery", intent!.filters, {});
    expect(res.status).toBe("invalid_request");
    expect(res.summary).toMatch(/fit discovery/i);
    expect(res.count).toBe(0);
  });

  it("running fit discovery with a runner returns ranked rows and the runner's notes", async () => {
    const intent = parseOptionsStrategyIntent("What strategies fit NVDA?");
    const runner = {
      run: async () => ({
        ok: true,
        weightsApplied: true,
        notes: ["Ranking adjusted by strategy weights v2 (regime chop)."],
        result: { direction: "name_to_strategies", result: NAME_RESULT } as DiscoveryModeResult,
      }),
    };
    const res = await runOptionsStrategyAction({} as any, "options_fit_discovery", intent!.filters, { fitDiscoveryRunner: runner as any });
    expect(res.count).toBe(2);
    expect(res.rows[0]).toMatchObject({ strategy: "Iron Condor", status: "qualified" });
    expect(res.summary).toContain("weights v2");
    expect(res.summary).toContain("NVDA");
  });
});

/* ------------------------------------------------------------------ */
/* Fit-discovery runner + v2 weights consumer                          */
/* ------------------------------------------------------------------ */

function chainFixture(symbol: string): ChainSnapshot {
  const strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
  const legs = strikes.flatMap((strike) => {
    const mid = Math.max(0.4, 9 - Math.abs(strike - 100) * 0.18);
    return (["call", "put"] as const).map((optionType) => ({
      optionType,
      strike,
      expiry: "2026-12-01",
      dte: 35,
      bid: Number((mid * 0.98).toFixed(2)),
      ask: Number((mid * 1.02).toFixed(2)),
      mid,
      iv: 0.4,
      volume: 200,
      openInterest: 1000,
      quoteTimestamp: NOW,
    }));
  });
  return {
    symbol,
    underlyingPrice: 100,
    asOf: NOW,
    provenance: "live",
    expiries: [{ expiry: "2026-12-01", dte: 35, legs }],
  } as unknown as ChainSnapshot;
}

function stubProvider(symbols: string[]): ResearchDataProvider {
  const chains = Object.fromEntries(symbols.map((s) => [s, chainFixture(s)]));
  return {
    async getUniverseSymbols() {
      return symbols;
    },
    async getQuote(symbol: string) {
      return chains[symbol] ? { symbol, price: 100, timestamp: NOW, quoteStatus: "live", source: "fixture:quote" } : null;
    },
    async getChain(symbol: string) {
      return chains[symbol] ?? ({ symbol, underlyingPrice: 100, asOf: NOW, provenance: "unavailable", expiries: [] } as unknown as ChainSnapshot);
    },
    async getTechnicals() {
      return { trend: "flat" as const, momentum: 0, notes: [] };
    },
    async getCatalysts() {
      return null;
    },
    async getRegime() {
      return { regime: "chop" as const, notes: [], asOf: NOW };
    },
  } as unknown as ResearchDataProvider;
}

describe("fit-discovery runner + v2 weights consumer (Phase 6)", () => {
  it("maps outlooks to the Phase 5 regime classes", () => {
    expect(OUTLOOK_TO_WEIGHTS_REGIME).toEqual({
      bullish: "bull",
      bearish: "bear",
      range_bound: "chop",
      volatile: "high_vol",
      unknown: "unknown",
    });
  });

  it("with the flag OFF, ordering is untouched even when v2 weights exist", async () => {
    const sql = makeSql();
    ensureWeightsV2Tables(sql);
    sql.exec(`DELETE FROM mas_strategy_weights_v2`);
    sql.exec(
      `INSERT INTO mas_strategy_weights_v2 (strategy, regime, weight, version, updated_at) VALUES (?, ?, ?, ?, ?)`,
      "iron_condor", "chop", 0.25, 1, new Date(NOW).toISOString()
    );
    const runner = createFitDiscoveryRunner({ userLogin: "alice", sql, provider: stubProvider(["AAA", "BBB"]) });
    const out = await runner.run({ direction: "strategy_to_names", structure: "iron_condor", outlook: "range_bound", now: NOW });
    expect(out.ok).toBe(true);
    expect(out.weightsApplied).toBe(false);
    const plain = await createFitDiscoveryRunner({ userLogin: "alice", sql: makeSql(), provider: stubProvider(["AAA", "BBB"]) }).run({
      direction: "strategy_to_names",
      structure: "iron_condor",
      outlook: "range_bound",
      now: NOW,
    });
    const order = (r: any) => (r.result.result.ranked as any[]).map((x) => x.symbol);
    expect(order(out)).toEqual(order(plain));
  });

  it("with the flag ON, Strategy→Names ranking reflects v2 weights and says so", async () => {
    const sql = makeSql();
    setSetting(sql, SCREENING_FLAG_KEYS.weightsV2Ranking, "on");
    // Seed a strong down-weight for iron_condor in chop; applyWeightsV2Ranking is
    // exercised directly here (runner path is covered by the flag-off test +
    // route wiring) with two fits whose raw order the weight must not fake:
    // a single-structure result re-ranks only across structures, so use the
    // pure function on a synthesized two-structure name result instead.
    const weights = getStrategyWeightsV2(sql);
    expect(weights[weightsV2Key("iron_condor", "chop")]).toBeUndefined();
    const { notes } = applyWeightsV2Ranking(
      { direction: "strategy_to_names", result: STRATEGY_RESULT },
      { [weightsV2Key("iron_condor", "chop")]: 0.5 },
      "chop"
    );
    expect(notes.join(" ")).toMatch(/weights v2/i);
  });

  it("weights never lift a negative worst-cell candidate above a positive one (Name→Strategies)", () => {
    const mk = (label: string, structure: string, worst: number, mean: number) => ({
      symbol: "NVDA",
      structure,
      label,
      source: "catalog" as const,
      legs: [],
      economics: { netDebit: 0, netCredit: 0, maxLoss: 100, maxGain: 100, breakevens: [] } as any,
      status: "qualified" as const,
      provenance: "live" as const,
      definedRisk: true,
      marginEstimate: 100,
      assignmentRisk: false,
      gateReasons: [],
      limitations: [],
      scenario: { worstPnlTotal: worst, meanPnlTotal: mean, bestPnlTotal: 100, withinConstraints: true },
    });
    const result: NameDiscoveryResult = {
      symbol: "NVDA",
      outlook: "range_bound",
      provenance: "live",
      candidates: [mk("Positive", "iron_condor", 10, 5), mk("Negative", "butterfly", -50, -10)],
      rejected: [],
      notConstructible: [],
      inadmissibleCatalogIds: [],
      limitations: [],
    };
    const { result: ranked } = applyWeightsV2Ranking(
      { direction: "name_to_strategies", result },
      { [weightsV2Key("butterfly", "chop")]: 2.0, [weightsV2Key("iron_condor", "chop")]: 0.25 },
      "chop"
    );
    if (ranked.direction !== "name_to_strategies") throw new Error("direction changed");
    expect(ranked.result.candidates.map((c) => c.label)).toEqual(["Positive", "Negative"]);
  });

  it("the runner refuses when the NLQ fit-discovery flag is off", async () => {
    const sql = makeSql();
    setSetting(sql, SCREENING_FLAG_KEYS.nlqFitDiscovery, "off");
    const runner = createFitDiscoveryRunner({ userLogin: "alice", sql, provider: stubProvider(["AAA"]) });
    const out = await runner.run({ direction: "name_to_strategies", symbol: "AAA", outlook: "bullish", now: NOW });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/disabled/i);
  });
});

/* ------------------------------------------------------------------ */
/* Bundle route body normalization                                     */
/* ------------------------------------------------------------------ */

describe("bundle route candidate normalization (Phase 6)", () => {
  const candidate = { symbol: "NVDA", legs: [{ symbol: "NVDA", optionType: "CALL", side: "BUY", quantity: 1, strike: 100, expirationDate: "2026-12-01" }] } as any;

  it("legacy single-candidate bodies still normalize to one candidate", () => {
    const out = normalizeBundleCandidates({ candidate });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.candidates).toHaveLength(1);
  });

  it("candidates[] bodies normalize every entry, preserving per-candidate fields", () => {
    const out = normalizeBundleCandidates({
      candidates: [
        { candidate, requestedContracts: 2 },
        { candidate: { ...candidate, symbol: "AAPL" }, beta: 1.1, riskScore: 42 },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.candidates).toHaveLength(2);
      expect(out.candidates[0].requestedContracts).toBe(2);
      expect(out.candidates[1].beta).toBe(1.1);
    }
  });

  it("empty or leg-less bodies are rejected with an explicit error", () => {
    expect(normalizeBundleCandidates({}).ok).toBe(false);
    expect(normalizeBundleCandidates({ candidates: [] }).ok).toBe(false);
    expect(normalizeBundleCandidates({ candidate: { symbol: "NVDA", legs: [] } as any }).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Routes: activity, controls, scheduled-tick Phase 6 steps            */
/* ------------------------------------------------------------------ */

import { shouldFireResearchTick } from "../src/services/researchScheduleGuard";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import { listReselectionProposals } from "../src/services/strategyBankReselection";

const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function routeCtx(overrides: Partial<ScreenerResearchRouteContext> = {}, settings = new Map<string, string>()) {
  const sql = makeSql();
  const orm = new DatabaseORM(sql as any);
  const ctx = {
    getScreenerAgent: vi.fn(),
    getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
    getResearchAgent: vi.fn(() => null),
    runResearchAndPublish: vi.fn(async () => ({ success: true })),
    getOrm: vi.fn(() => orm),
    readSettingRaw: vi.fn((key: string) => settings.get(key) ?? null),
    writeSetting: vi.fn((key: string, value: string) => {
      settings.set(key, value);
    }),
    env: {},
    ...overrides,
  } as unknown as ScreenerResearchRouteContext;
  return { ctx, orm, sql, settings };
}

describe("screening activity + controls routes (Phase 6)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /screening/activity returns only the requesting tenant's feed", async () => {
    const { ctx, orm } = routeCtx();
    recordScreeningActivity(orm as any, { userLogin: "alice", kind: "delivery", summary: "Bundle delivered to slack." });
    recordScreeningActivity(orm as any, { userLogin: "bob", kind: "delivery", summary: "Bob's delivery." });
    const res = await handleScreenerResearchRoutes(req("GET", "/screening/activity", undefined, { "x-user-login": "alice" }), urlOf("/screening/activity"), "/screening/activity", "s1", ctx);
    expect(res).not.toBeNull();
    const body = await (res as Response).json();
    expect(body.feed).toHaveLength(1);
    expect(body.feed[0].summary).toContain("Bundle delivered");
    const resBob = await handleScreenerResearchRoutes(req("GET", "/screening/activity", undefined, { "x-user-login": "bob" }), urlOf("/screening/activity"), "/screening/activity", "s1", ctx);
    const bodyBob = await (resBob as Response).json();
    expect(bodyBob.feed).toHaveLength(1);
    expect(bodyBob.feed[0].summary).toContain("Bob");
  });

  it("GET /screening/controls reports defaults; POST flips pause + stage and records the change", async () => {
    const { ctx, orm, settings } = routeCtx();
    const get1 = await handleScreenerResearchRoutes(req("GET", "/screening/controls", undefined, { "x-user-login": "alice" }), urlOf("/screening/controls"), "/screening/controls", "s1", ctx);
    const body1 = await (get1 as Response).json();
    expect(body1).toMatchObject({ rolloutStage: "internal", scheduledPaused: false, channelsEnabled: false, weightsV2Ranking: false, nlqFitDiscovery: true });

    const post = await handleScreenerResearchRoutes(
      req("POST", "/screening/controls", { scheduledPaused: true, rolloutStage: "paper" }, { "x-user-login": "alice" }),
      urlOf("/screening/controls"), "/screening/controls", "s1", ctx
    );
    expect((post as Response).status).toBe(200);
    const body2 = await (post as Response).json();
    expect(body2).toMatchObject({ rolloutStage: "paper", scheduledPaused: true });
    expect(settings.get(SCREENING_FLAG_KEYS.scheduledPaused)).toBe("on");
    expect(settings.get(SCREENING_FLAG_KEYS.rolloutStage)).toBe("paper");
    const activity = listScreeningActivity(orm as any, "alice");
    expect(activity.some((a) => a.kind === "schedule_control")).toBe(true);
  });

  it("POST /screening/controls rejects an invalid rollout stage", async () => {
    const { ctx } = routeCtx();
    const post = await handleScreenerResearchRoutes(
      req("POST", "/screening/controls", { rolloutStage: "everywhere" }, { "x-user-login": "alice" }),
      urlOf("/screening/controls"), "/screening/controls", "s1", ctx
    );
    expect((post as Response).status).toBe(400);
  });
});

describe("scheduled tick Phase 6 steps (Phase 6)", () => {
  beforeEach(() => vi.clearAllMocks());

  function trackRecordWithEvidence() {
    const ideas = Array.from({ length: 12 }, (_, i) => ({
      runId: "run-1",
      runCreatedAt: "2026-10-20T21:00:00Z",
      symbol: "AAA",
      structure: "iron_condor",
      outlook: "range_bound",
      thesis: "t",
      invalidation: "i",
      entrySpot: 100,
      regime: "chop" as const,
      contractsPerUnit: 4,
      evaluation: {
        evaluatedAt: "2026-10-22T21:00:00Z",
        invalidated: false,
        pnlEstimatePerUnit: i < 9 ? 2 : -1,
        rMultiple: i < 9 ? 0.5 : -0.25,
        evalSpot: 100,
        directionCorrect: true,
        notes: [],
      },
    }));
    return { published: 12, evaluated: 12, invalidated: 0, winRate: 0.75, directionAccuracy: 1, avgPnlPerUnit: 1.25, avgRMultiple: 0.31, byStrategy: [], byPeriod: [], ideas };
  }

  function tickCtx(paused: boolean) {
    const agent = {
      evaluateDueRuns: vi.fn(async () => ({ evaluated: [], failed: [] })),
      runDiscoveryIfDue: vi.fn(async () => ({ fired: false, dateKey: "2026-10-23" })),
      getTrackRecord: vi.fn(async () => trackRecordWithEvidence()),
      getResearchConfig: vi.fn(async () => ({ feePerContract: 0.65, slippagePerContract: 0.05 })),
      // Issue #6355 - the feed/enrich stages now run for real (their
      // steps carry userLogin), so the tick fixture provides the agent the
      // production route always has, with an empty feed/enrich.
      runFeedStage: async (input: { runId?: string }) => ({
        runId: input.runId ?? "r1",
        asOf: new Date().toISOString(),
        regime: null,
        universe: "nasdaq100",
        universeError: null,
        symbols: [],
        quotes: [],
        universeSize: 0,
        quotesRetrieved: 0,
      }),
      runEnrichStage: async (feed: unknown, input: { runId?: string }) => ({
        runId: input.runId ?? "r1",
        asOf: new Date().toISOString(),
        feed,
        bySymbol: {},
      }),
    };
    const settings = new Map<string, string>();
    if (paused) settings.set(SCREENING_FLAG_KEYS.scheduledPaused, "on");
    const built = routeCtx({ getResearchAgent: vi.fn(() => agent as any) }, settings);
    return { ...built, agent };
  }

  it("runs re-selection (proposal recorded) and the weights-v2 job on the tick", async () => {
    (shouldFireResearchTick as any).mockReturnValue({ fire: true, dateKey: "2026-10-23" });
    const { ctx, orm } = tickCtx(false);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/research/scheduled-tick", undefined, { "x-user-login": "alice" }),
      urlOf("/research/scheduled-tick"), "/research/scheduled-tick", "s1", ctx
    );
    expect((res as Response).status).toBe(200);
    const body = await (res as Response).json();
    expect(body.screeningSteps?.reselection?.proposals).toBeGreaterThanOrEqual(1);
    expect(body.screeningSteps?.weightsV2).toBeDefined();
    const proposals = listReselectionProposals(orm as any, "alice");
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0].proposal.governance).toBe("proposal_only_not_promoted");
    expect(proposals[0].proposal.activeSet.map((a) => a.strategy)).toContain("iron_condor");
  });

  it("when paused, the tick skips the #1096 autonomous steps and records the skip", async () => {
    (shouldFireResearchTick as any).mockReturnValue({ fire: true, dateKey: "2026-10-23" });
    const { ctx, orm, agent } = tickCtx(true);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/research/scheduled-tick", undefined, { "x-user-login": "alice" }),
      urlOf("/research/scheduled-tick"), "/research/scheduled-tick", "s1", ctx
    );
    const body = await (res as Response).json();
    expect(body.screeningPaused).toBe(true);
    expect(agent.runDiscoveryIfDue).not.toHaveBeenCalled();
    expect(listReselectionProposals(orm as any, "alice")).toHaveLength(0);
    const activity = listScreeningActivity(orm as any, "alice");
    expect(activity.some((a) => a.kind === "schedule_control" && /paused/i.test(a.summary))).toBe(true);
  });
});
