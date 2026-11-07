/**
 * Issue #28 — Saved Strategy Profiles.
 *
 * "My strategy" as a named, reusable, versioned object: the profile
 * module (validation, the layered merge core, the disclosure line), the
 * profile stores (SQL over a statement-exact fake + in-memory, identical
 * semantics), scanner application + provenance, the week-apart
 * acceptance criterion, NLQ selection ("against my income profile") on
 * both the scan and single-name paths, and the unified service —
 * including the cache-key fix: profile application happens inside the
 * scan/request assembly, so the unified cache key must segment on the
 * resolved profile id + version or profile and profile-less calls would
 * serve each other's results.
 */

import { afterEach, describe, expect, it, vi} from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import { OpportunityScanner, type ScanRequestTemplate } from "../src/trading/options/opportunityScanner";
import {
  applyProfileFields,
  profileDisclosure,
  validateStrategyProfile,
  type StrategyProfile,
  type StrategyProfileSpec,
} from "../src/trading/options/strategyProfile";
import {
  InMemoryStrategyProfileStore,
  SqlStrategyProfileStore,
  type StrategyProfileStore,
} from "../src/trading/options/strategyProfileStore";
import { InMemoryScanRunStore, type ScanSqlExecutor } from "../src/trading/options/scanRunStore";
import { parseOptionsStrategyIntent, runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OptionStrategyType } from "../src/trading/options/strategyEngine";
import type { Env, ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures (duplicated per repo convention from
// tests/options_scan_persistence.test.ts / tests/options_scanner.test.ts)
// ---------------------------------------------------------------------------

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function baseTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: expiryDate,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
    minDte: 14,
    maxDte: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    maxQuoteAgeSeconds: 60,
    eventPolicy: "warn",
    ...overrides,
  };
}

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

const FULL_MULTS = [0.9, 0.95, 1, 1.05, 1.1];

function makeContracts(symbol: string, spot: number, expiry: string = expiryDate): ScreenedOptionContractItem[] {
  const now = Date.now();
  return FULL_MULTS.flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: expiry,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `${symbol}${strike}C`, osiKey: `${symbol}-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `${symbol}${strike}P`, osiKey: `${symbol}-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

const SPOTS: Record<string, number> = { NVDA: 250, AMD: 40, MSFT: 500 };

function fakeScreener(expiry: string = expiryDate): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const contracts = makeContracts(symbol, SPOTS[symbol] ?? 100, expiry);
      return {
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        totalUnderlyingsScanned: 1,
        scannedAt: new Date().toISOString(),
        rejections: [],
      } as unknown as OptionScreenResult;
    },
  } as unknown as DynamicOptionsScreener;
}

function chainFor(symbol: string, spot: number, expiry: { year: number; month: number; day: number }): ETradeOptionChain {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const deltaMag = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiry,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

/** The NLQ etrade facade: stub client (chains) + watchlists + quotes. */
function nlqFacade() {
  const client = {
    getOptionExpireDates: async () => [expiryObj],
    getOptionChains: async (args: { symbol: string }) =>
      SPOTS[args.symbol] !== undefined ? chainFor(args.symbol, SPOTS[args.symbol], expiryObj) : null,
  };
  return {
    client,
    environment: { kind: "sandbox" as const },
    fetchQuoteRemote: async (symbol: string) => ({ lastPrice: SPOTS[symbol] ?? 100 }),
    getWatchlists: async () => [{ name: "Semis", symbols: ["NVDA", "AMD"] }],
    screenMarketsAsync: async () => ({ stocks: [] as Array<{ symbol: string; marketCap?: number }> }),
  };
}

function profileOf(spec: StrategyProfileSpec, overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    ...spec,
    id: "prof_1",
    userLogin: "default_trader",
    name: "Income",
    version: 1,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Validation
// ---------------------------------------------------------------------------

describe("validateStrategyProfile (issue #28)", () => {
  it("accepts a fully populated valid spec (including the \"all\" sentinel)", () => {
    expect(
      validateStrategyProfile("Income", {
        thesis: "range_bound",
        allowedStrategies: ["iron_condor", "put_credit_spread", "all"],
        maxPlannedLoss: 500,
        minRewardRisk: 1.5,
        minDte: 20,
        maxDte: 45,
        eventPolicy: "exclude",
        expectedIvDirection: "fall",
        optimizationBias: 80,
        riskProfile: "conservative",
        mode: "strategy_fit",
        fitGate: { minCompositeScore: 60, minProbabilityOfProfit: 0.4, requireFresh: true, minConfidence: "HIGH" },
      }),
    ).toBeNull();
    expect(validateStrategyProfile("Bare", {})).toBeNull();
  });

  it("rejects an empty name — and the name error wins over spec errors", () => {
    expect(validateStrategyProfile("   ", {})).toBe("Profile name is required.");
    expect(validateStrategyProfile("", { maxPlannedLoss: -1 })).toBe("Profile name is required.");
  });

  it("rejects an unknown strategy type id", () => {
    const error = validateStrategyProfile("X", { allowedStrategies: ["bogus_type" as OptionStrategyType] });
    expect(error).toContain("bogus_type");
    expect(validateStrategyProfile("X", { allowedStrategies: ["long_call"] })).toBeNull();
  });

  it("rejects non-positive caps and negative floors", () => {
    expect(validateStrategyProfile("X", { maxPlannedLoss: 0 })).toBe("maxPlannedLoss must be greater than 0.");
    expect(validateStrategyProfile("X", { maxPlannedLoss: -5 })).toBe("maxPlannedLoss must be greater than 0.");
    expect(validateStrategyProfile("X", { minRewardRisk: -0.1 })).toBe("minRewardRisk must be 0 or greater.");
    expect(validateStrategyProfile("X", { minRewardRisk: 0 })).toBeNull();
  });

  it("rejects a broken DTE window", () => {
    expect(validateStrategyProfile("X", { minDte: -1 })).toBe("minDte must be 0 or greater.");
    expect(validateStrategyProfile("X", { maxDte: -1 })).toBe("maxDte must be 0 or greater.");
    expect(validateStrategyProfile("X", { minDte: 50, maxDte: 20 })).toBe("minDte must not exceed maxDte.");
    expect(validateStrategyProfile("X", { minDte: 20, maxDte: 20 })).toBeNull();
  });

  it("rejects an out-of-range optimization bias (bounds are inclusive)", () => {
    expect(validateStrategyProfile("X", { optimizationBias: -1 })).toBe("optimizationBias must be between 0 and 100.");
    expect(validateStrategyProfile("X", { optimizationBias: 101 })).toBe("optimizationBias must be between 0 and 100.");
    expect(validateStrategyProfile("X", { optimizationBias: 0 })).toBeNull();
    expect(validateStrategyProfile("X", { optimizationBias: 100 })).toBeNull();
  });

  it("rejects out-of-range fit-gate thresholds", () => {
    expect(validateStrategyProfile("X", { fitGate: { minCompositeScore: 101 } })).toBe(
      "fitGate.minCompositeScore must be between 0 and 100.",
    );
    expect(validateStrategyProfile("X", { fitGate: { minCompositeScore: -1 } })).toBe(
      "fitGate.minCompositeScore must be between 0 and 100.",
    );
    expect(validateStrategyProfile("X", { fitGate: { minProbabilityOfProfit: 1.01 } })).toBe(
      "fitGate.minProbabilityOfProfit must be between 0 and 1.",
    );
    expect(validateStrategyProfile("X", { fitGate: { minProbabilityOfProfit: -0.1 } })).toBe(
      "fitGate.minProbabilityOfProfit must be between 0 and 1.",
    );
    expect(validateStrategyProfile("X", { fitGate: { minConfidence: "VERY_HIGH" as never } })).toBe(
      "fitGate.minConfidence must be one of LOW, MEDIUM, HIGH.",
    );
    expect(validateStrategyProfile("X", { fitGate: { minCompositeScore: 100, minProbabilityOfProfit: 1 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The merge core + disclosure line
// ---------------------------------------------------------------------------

describe("applyProfileFields (issue #28)", () => {
  it("the profile wins for fields it sets; appliedFields are in the fixed order", () => {
    const base = { thesis: "bullish" as const, maxPlannedLoss: 5_000, minDte: 7 };
    const { merged, appliedFields } = applyProfileFields(
      base,
      profileOf({ maxPlannedLoss: 500, minRewardRisk: 1.5, minDte: 20, maxDte: 45, eventPolicy: "exclude" }),
      new Set(),
    );
    expect(merged.maxPlannedLoss).toBe(500);
    expect(merged.minRewardRisk).toBe(1.5);
    expect(merged.minDte).toBe(20);
    expect(merged.maxDte).toBe(45);
    expect(merged.eventPolicy).toBe("exclude");
    expect(merged.thesis).toBe("bullish"); // the profile does not set thesis
    expect(appliedFields).toEqual(["maxPlannedLoss", "minRewardRisk", "minDte", "maxDte", "eventPolicy"]);
    expect(base.maxPlannedLoss).toBe(5_000); // base untouched
  });

  it("explicit fields keep the caller's values", () => {
    const { merged, appliedFields } = applyProfileFields(
      { thesis: "bullish" as const, maxPlannedLoss: 900 },
      profileOf({ thesis: "bearish", maxPlannedLoss: 500, optimizationBias: 80 }),
      new Set(["thesis"]),
    );
    expect(merged.thesis).toBe("bullish");
    expect(merged.maxPlannedLoss).toBe(500);
    expect(merged.optimizationBias).toBe(80);
    expect(appliedFields).toEqual(["maxPlannedLoss", "optimizationBias"]);
  });

  it("a full profile applies every field in PROFILE_REQUEST_FIELDS order", () => {
    const { appliedFields } = applyProfileFields(
      {},
      profileOf({
        optimizationBias: 10,
        expectedIvDirection: "fall",
        eventPolicy: "warn",
        maxDte: 45,
        minDte: 20,
        minRewardRisk: 1,
        maxPlannedLoss: 100,
        allowedStrategies: ["long_call"],
        thesis: "bearish",
      }),
      new Set(),
    );
    expect(appliedFields).toEqual([
      "thesis",
      "allowedStrategies",
      "maxPlannedLoss",
      "minRewardRisk",
      "minDte",
      "maxDte",
      "eventPolicy",
      "expectedIvDirection",
      "optimizationBias",
    ]);
  });

  it("an empty profile applies nothing", () => {
    const base = { thesis: "bullish" as const, maxPlannedLoss: 500 };
    const { merged, appliedFields } = applyProfileFields(base, profileOf({}), new Set());
    expect(merged).toEqual(base);
    expect(appliedFields).toEqual([]);
  });
});

describe("profileDisclosure (issue #28)", () => {
  it("renders the full deterministic line", () => {
    const profile = profileOf(
      {
        thesis: "bullish",
        allowedStrategies: ["put_credit_spread", "iron_condor"],
        maxPlannedLoss: 500,
        minRewardRisk: 1.5,
        minDte: 20,
        maxDte: 45,
        eventPolicy: "exclude",
        fitGate: { minCompositeScore: 60, minProbabilityOfProfit: 0.4 },
      },
      { version: 2 },
    );
    const line = profileDisclosure(
      profile,
      ["thesis", "allowedStrategies", "maxPlannedLoss", "minRewardRisk", "minDte", "maxDte", "eventPolicy"],
      true,
    );
    expect(line).toBe(
      'Strategy profile "Income" (v2) applied — thesis bullish, max planned loss $500, min reward/risk 1.5, DTE 20–45, event policy exclude, types: put_credit_spread, iron_condor, fit gate: min score 60, min POP 40%.',
    );
  });

  it("says so when nothing was taken from the profile", () => {
    expect(profileDisclosure(profileOf({}), [], false)).toBe('Strategy profile "Income" (v1) applied (no constraints set).');
  });

  it("renders one-sided DTE windows and gate-only profiles", () => {
    expect(profileDisclosure(profileOf({ minDte: 20 }), ["minDte"], false)).toContain("DTE ≥20");
    expect(profileDisclosure(profileOf({ maxDte: 45 }), ["maxDte"], false)).toContain("DTE ≤45");
    expect(
      profileDisclosure(profileOf({ fitGate: { requireFresh: false, minConfidence: "HIGH" } }), [], true),
    ).toBe('Strategy profile "Income" (v1) applied — fit gate: fresh quotes not required, min confidence HIGH.');
    // Gate set on the profile but NOT applied (caller did not route it) → no gate clause.
    expect(profileDisclosure(profileOf({ fitGate: { minCompositeScore: 60 } }), [], false)).toBe(
      'Strategy profile "Income" (v1) applied (no constraints set).',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Stores — one contract, both implementations
// ---------------------------------------------------------------------------

class FakeProfileSql implements ScanSqlExecutor {
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...params: unknown[]): Array<Record<string, unknown>> {
    if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) return [];
    if (query.startsWith("INSERT INTO mas_strategy_profiles")) {
      const [id, user_login, name, version, spec_json, created_at, updated_at] = params;
      this.rows.push({ id, user_login, name, version, spec_json, created_at, updated_at });
      return [];
    }
    if (query.startsWith("SELECT") && query.includes("WHERE user_login = ? AND id = ?")) {
      return this.rows.filter((r) => r.user_login === params[0] && r.id === params[1]).map((r) => ({ ...r }));
    }
    if (query.startsWith("SELECT") && query.includes("WHERE user_login = ?")) {
      return this.rows.filter((r) => r.user_login === params[0]).map((r) => ({ ...r }));
    }
    if (query.startsWith("UPDATE mas_strategy_profiles")) {
      const [name, version, spec_json, updated_at, user_login, id] = params;
      const row = this.rows.find((r) => r.user_login === user_login && r.id === id);
      if (row) Object.assign(row, { name, version, spec_json, updated_at });
      return [];
    }
    if (query.startsWith("DELETE FROM mas_strategy_profiles")) {
      this.rows = this.rows.filter((r) => !(r.user_login === params[0] && r.id === params[1]));
      return [];
    }
    throw new Error(`FakeProfileSql: unhandled statement: ${query}`);
  }
}

interface StoreHarness {
  store: StrategyProfileStore;
  setNow(iso: string): void;
}

function sqlHarness(): StoreHarness & { fake: FakeProfileSql } {
  const fake = new FakeProfileSql();
  let seq = 0;
  let nowIso = "2026-10-16T12:00:00.000Z";
  const store = new SqlStrategyProfileStore(fake, {
    idFactory: () => `p${++seq}`,
    now: () => new Date(nowIso),
  });
  return { store, fake, setNow: (iso: string) => { nowIso = iso; } };
}

function memoryHarness(): StoreHarness {
  let seq = 0;
  let nowIso = "2026-10-16T12:00:00.000Z";
  const store = new InMemoryStrategyProfileStore({
    idFactory: () => `p${++seq}`,
    now: () => new Date(nowIso),
  });
  return { store, setNow: (iso: string) => { nowIso = iso; } };
}

/** The same contract, run against both stores. */
async function expectProfileStoreContract(harness: StoreHarness): Promise<void> {
  const { store, setNow } = harness;

  const income = await store.create("alice", "Income", {
    thesis: "range_bound",
    maxPlannedLoss: 500,
    allowedStrategies: ["iron_condor", "put_credit_spread"],
  });
  expect(income.version).toBe(1);
  expect(income.name).toBe("Income");
  expect(income.userLogin).toBe("alice");
  expect(income.createdAt).toBe("2026-10-16T12:00:00.000Z");
  expect(income.updatedAt).toBe(income.createdAt);
  expect(income.thesis).toBe("range_bound");
  expect(income.allowedStrategies).toEqual(["iron_condor", "put_credit_spread"]);

  const growth = await store.create("alice", "growth", { thesis: "bullish" });
  // List order: name ascending (case-insensitive).
  expect((await store.list("alice")).map((p) => p.name)).toEqual(["growth", "Income"]);

  // get / getByName (case-insensitive, trimmed).
  expect((await store.get("alice", income.id))?.name).toBe("Income");
  expect((await store.getByName("alice", "  INCOME "))?.id).toBe(income.id);
  expect(await store.getByName("alice", "missing")).toBeNull();
  expect(await store.get("alice", "missing-id")).toBeNull();

  // Duplicate name on create (case-insensitive) throws.
  await expect(store.create("alice", "income", {})).rejects.toThrow('A profile named "income" already exists');

  // Per-user isolation: bob sees none of alice's profiles, and may use
  // the same name for his own.
  expect(await store.list("bob")).toEqual([]);
  expect(await store.get("bob", income.id)).toBeNull();
  expect(await store.getByName("bob", "Income")).toBeNull();
  const bobs = await store.create("bob", "Income", {});
  expect(bobs.id).not.toBe(income.id);

  // Update replaces the spec wholesale, bumps the version, refreshes
  // updatedAt, and keeps createdAt.
  setNow("2026-10-20T12:00:00.000Z");
  const updated = await store.update("alice", income.id, { maxPlannedLoss: 750 });
  expect(updated?.version).toBe(2);
  expect(updated?.maxPlannedLoss).toBe(750);
  expect(updated?.thesis).toBeUndefined();
  expect(updated?.updatedAt).toBe("2026-10-20T12:00:00.000Z");
  expect(updated?.createdAt).toBe("2026-10-16T12:00:00.000Z");

  // Rename via update; the old name no longer resolves.
  const renamed = await store.update("alice", income.id, { maxPlannedLoss: 750 }, "Income Plus");
  expect(renamed?.name).toBe("Income Plus");
  expect(renamed?.version).toBe(3);
  expect((await store.getByName("alice", "income plus"))?.id).toBe(income.id);
  expect(await store.getByName("alice", "Income")).toBeNull();

  // A rename clashing with a DIFFERENT profile of the same user throws.
  await expect(store.update("alice", income.id, {}, "GROWTH")).rejects.toThrow('A profile named "GROWTH" already exists');

  // Update of an absent profile — or another user's — is null.
  expect(await store.update("alice", "missing-id", {})).toBeNull();
  expect(await store.update("bob", income.id, {})).toBeNull();

  // Delete: true once, false afterwards; other users cannot delete.
  expect(await store.delete("bob", income.id)).toBe(false);
  expect(await store.delete("alice", growth.id)).toBe(true);
  expect(await store.get("alice", growth.id)).toBeNull();
  expect(await store.delete("alice", growth.id)).toBe(false);
}

describe("strategy profile stores (issue #28)", () => {
  it("InMemoryStrategyProfileStore satisfies the contract", async () => {
    await expectProfileStoreContract(memoryHarness());
  });

  it("SqlStrategyProfileStore satisfies the contract over its exact statements", async () => {
    const harness = sqlHarness();
    await expectProfileStoreContract(harness);
    // Rows landed in the table with the spec stored as JSON: alice's
    // renamed profile + bob's one (alice's "growth" was deleted during
    // the contract run).
    expect(harness.fake.rows).toHaveLength(2);
    const aliceIncome = harness.fake.rows.find((r) => r.user_login === "alice" && r.name === "Income Plus");
    expect(aliceIncome).toBeDefined();
    expect(JSON.parse(aliceIncome!.spec_json as string)).toEqual({ maxPlannedLoss: 750 });
    expect(aliceIncome!.version).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Scanner application + provenance
// ---------------------------------------------------------------------------

describe("scanner profile application (issue #28)", () => {
  it("stamps profileRef + the full profile snapshot, discloses, and restricts the matrix types", async () => {
    const scanner = new OpportunityScanner(fakeScreener());
    const profile = profileOf({ maxPlannedLoss: 1_234, allowedStrategies: ["long_call", "call_debit_spread"] });

    const baseline = await scanner.scan(["NVDA", "AMD"], baseTemplate());
    expect(baseline.profileRef).toBeNull();
    expect(baseline.requestSnapshot.profile).toBeNull();
    const baselineTypes = new Set(baseline.matrix.flatMap((m) => m.cells.map((c) => c.strategyType)));
    expect(baselineTypes.has("put_credit_spread")).toBe(true);

    const result = await scanner.scan(["NVDA", "AMD"], baseTemplate(), { profile });
    // Acceptance (2): provenance names the profile and its version.
    expect(result.profileRef).toEqual({ id: "prof_1", name: "Income", version: 1 });
    expect(result.requestSnapshot.profile).toEqual(profile);
    expect(result.requestSnapshot.template.maxPlannedLoss).toBe(1_234);
    expect(result.requestSnapshot.template.allowedStrategies).toEqual(["long_call", "call_debit_spread"]);
    const disclosure = result.assumptions.find((a) => a.startsWith('Strategy profile "Income" (v1) applied'));
    expect(disclosure).toContain("max planned loss $1234");
    expect(disclosure).toContain("types: long_call, call_debit_spread");
    const profileTypes = new Set(result.matrix.flatMap((m) => m.cells.map((c) => c.strategyType)));
    expect([...profileTypes].sort()).toEqual(["call_debit_spread", "long_call"]);
  });

  it("an explicit thesis beats the profile's thesis while the profile's cap still applies", async () => {
    const scanner = new OpportunityScanner(fakeScreener());
    const profile = profileOf({ thesis: "bearish", maxPlannedLoss: 777 });

    const explicit = await scanner.scan(["NVDA"], baseTemplate(), { profile, explicitFields: ["thesis"] });
    expect(explicit.requestSnapshot.template.thesis).toBe("bullish"); // the template's, kept
    expect(explicit.requestSnapshot.template.maxPlannedLoss).toBe(777); // the profile's, applied

    const yielded = await scanner.scan(["NVDA"], baseTemplate(), { profile });
    expect(yielded.requestSnapshot.template.thesis).toBe("bearish");
  });

  it("the profile's posture (riskProfile / mode) applies unless declared explicit", async () => {
    const scanner = new OpportunityScanner(fakeScreener());
    const profile = profileOf({ riskProfile: "conservative", mode: "strategy_fit" });

    const fromProfile = await scanner.scan(["NVDA", "AMD"], baseTemplate(), { profile });
    expect(fromProfile.mode).toBe("strategy_fit");
    expect(fromProfile.requestSnapshot.mode).toBe("strategy_fit");
    expect(fromProfile.requestSnapshot.riskProfile).toBe("conservative");

    const declared = await scanner.scan(["NVDA", "AMD"], baseTemplate(), {
      profile,
      mode: "per_name_best",
      riskProfile: "aggressive",
      explicitFields: ["mode", "riskProfile"],
    });
    expect(declared.mode).toBe("per_name_best");
    expect(declared.requestSnapshot.riskProfile).toBe("aggressive");
  });

  it("a profile fit gate flips the fixture pick's bucket deterministically", async () => {
    const scanner = new OpportunityScanner(fakeScreener());
    const baseline = await scanner.scan(["NVDA", "AMD"], baseTemplate());
    expect(baseline.gateParams.minCompositeScore).toBe(55);
    const pick = baseline.opportunities[0];
    expect(pick).toBeDefined();
    expect(pick.score).toBeLessThan(100);
    expect(baseline.matrix.find((m) => m.symbol === pick.symbol)?.gateBucket).toBe("fit");

    // One point above the pick's own composite: the pick now fails
    // exactly one gate criterion (the composite bar) → borderline.
    const strictScore = Math.floor(pick.score) + 1;
    const gated = await scanner.scan(["NVDA", "AMD"], baseTemplate(), {
      profile: profileOf({ fitGate: { minCompositeScore: strictScore } }),
    });
    expect(gated.gateParams.minCompositeScore).toBe(strictScore);
    const row = gated.matrix.find((m) => m.symbol === pick.symbol);
    expect(row?.gateBucket).toBe("borderline");
    expect(row?.gateReasons.join(" ")).toContain("below minimum");
    expect(gated.assumptions.join(" ")).toContain(`fit gate: min score ${strictScore}`);
  });

  it("acceptance: the same profile applied a week apart yields identical fit verdicts", async () => {
    const profile = profileOf({
      thesis: "bullish",
      maxPlannedLoss: 5_000,
      allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
      fitGate: { minCompositeScore: 60 },
    });
    const now1 = new Date();
    const now2 = new Date(now1.getTime() + 7 * 86_400_000);
    const scanAt = async (now: Date) => {
      // The relative-expiry fixture, keyed to the scan's own clock:
      // chains expire 30 days after the injected `now`, exactly as the
      // standard fixture expires 30 days after the wall clock.
      const expiry = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
      const scanner = new OpportunityScanner(fakeScreener(expiry));
      return scanner.scan(["NVDA", "AMD"], baseTemplate({ targetDate: expiry }), { profile, now });
    };

    const first = await scanAt(now1);
    const second = await scanAt(now2);
    expect(second.generatedAt).not.toBe(first.generatedAt); // really a week apart
    const buckets = (r: typeof first) => Object.fromEntries(r.matrix.map((m) => [m.symbol, m.gateBucket]));
    expect(Object.values(buckets(first))).toContain("fit"); // the comparison is meaningful
    expect(buckets(second)).toEqual(buckets(first));
    expect(second.profileRef).toEqual(first.profileRef);
    expect(second.requestSnapshot.profile).toEqual(first.requestSnapshot.profile);
    expect(second.requestSnapshot.profile).toEqual(profile);
  });
});

// ---------------------------------------------------------------------------
// 5. NLQ selection + application
// ---------------------------------------------------------------------------

describe("NLQ profile selection (issue #28)", () => {
  it("extracts the profile name from the acceptance phrasing", () => {
    const intent = parseOptionsStrategyIntent(
      "Find best bullish option opportunities across my Semis watchlist against my income profile",
    );
    expect(intent.action).toBe("options_opportunities");
    expect(intent.filters.scope).toMatchObject({ kind: "watchlist", name: "Semis" });
    expect(intent.filters.profileName).toBe("income");
  });

  it("extracts multi-word names and other phrasings", () => {
    expect(
      parseOptionsStrategyIntent("Find best bullish option opportunities across my Semis watchlist using my income plus profile")
        .filters.profileName,
    ).toBe("income plus");
    expect(
      parseOptionsStrategyIntent("What is the best trade for NVDA bullish target $260 with my income profile").filters
        .profileName,
    ).toBe("income");
  });

  it("adds no profileName key when no profile is named (existing filter shapes unchanged)", () => {
    const intent = parseOptionsStrategyIntent("Find the best bullish option trades across my Semis watchlist max loss $500");
    expect(intent.filters.profileName).toBeUndefined();
    expect("profileName" in intent.filters).toBe(false);
  });

  it("ignores a bare \"my strategy profile\" (guard)", () => {
    const intent = parseOptionsStrategyIntent("What is the best trade for NVDA bullish target $260 against my strategy profile");
    expect(intent.filters.profileName).toBeUndefined();
  });

  it("scan path: resolves + applies the profile; provenance rides on the result and the persisted run", async () => {
    const profileStore = new InMemoryStrategyProfileStore({ idFactory: () => "prof_nlq_1" });
    const created = await profileStore.create("default_trader", "Income", { allowedStrategies: ["long_call"] });
    const scanStore = new InMemoryScanRunStore({ idFactory: () => "run-prof-1" });
    const intent = parseOptionsStrategyIntent(
      "Find best bullish option opportunities across my Semis watchlist against my income profile",
    );
    // Issue #1185: no userLogin in deps fails closed — profile resolution
    // requires the threaded authenticated login, never a synthetic one.
    const noLogin = await runOptionsStrategyAction(nlqFacade() as never, intent.action, intent.filters, {
      profileStore,
      scanRunStore: new InMemoryScanRunStore({ idFactory: () => "run-prof-nologin" }),
    });
    expect(noLogin.status).toBe("invalid_request");
    expect(noLogin.summary).toMatch(/authenticated user/);

    const result = await runOptionsStrategyAction(nlqFacade() as never, intent.action, intent.filters, {
      profileStore,
      scanRunStore: scanStore,
      userLogin: "default_trader",
    });

    expect(result.status).toBe("ranked_opportunities");
    expect(result.profileRef).toEqual({ id: created.id, name: "Income", version: 1 });
    const cellTypes = new Set((result.matrix ?? []).flatMap((m) => m.cells.map((c) => c.strategyType)));
    expect([...cellTypes]).toEqual(["long_call"]); // the profile's narrowing is visible in the matrix
    expect(result.summary).toContain('Strategy profile "Income" (v1) applied');
    expect(result.summary).toContain("types: long_call");

    expect(result.persisted).toBe(true);
    // Issue #1185/#103: the run is owner-stamped with the threaded login —
    // the read-back scopes to that owner.
    const stored = await scanStore.get("run-prof-1", { userLogin: "default_trader" });
    expect(stored?.result.profileRef).toEqual({ id: created.id, name: "Income", version: 1 });
    expect(stored?.result.requestSnapshot.profile?.name).toBe("Income");
    expect(stored?.result.requestSnapshot.template.allowedStrategies).toEqual(["long_call"]);
  });

  it("scan path: an unknown profile name fails with the named message", async () => {
    const intent = parseOptionsStrategyIntent(
      "Find best bullish option opportunities across my Semis watchlist against my missing profile",
    );
    const result = await runOptionsStrategyAction(nlqFacade() as never, intent.action, intent.filters, {
      profileStore: new InMemoryStrategyProfileStore(),
      userLogin: "default_trader",
    });
    expect(result.status).toBe("invalid_request");
    expect(result.summary).toBe('No saved profile named "missing".');
  });

  it("scan path: no store wired fails with the availability message", async () => {
    const intent = parseOptionsStrategyIntent(
      "Find best bullish option opportunities across my Semis watchlist against my income profile",
    );
    const result = await runOptionsStrategyAction(nlqFacade() as never, intent.action, intent.filters, {});
    expect(result.status).toBe("invalid_request");
    expect(result.summary).toBe("Saved profiles aren't available in this context.");
  });

  it("single-name path: the profile's max loss cap binds and the summary discloses it", async () => {
    const profileStore = new InMemoryStrategyProfileStore({ idFactory: () => "prof_single_1" });
    await profileStore.create("default_trader", "Income", { maxPlannedLoss: 1 });
    const intent = parseOptionsStrategyIntent(
      "What is the best trade for NVDA bullish target $260 by 2026-11-20 against my income profile",
    );
    expect(intent.action).toBe("options_best_trade");
    expect(intent.filters.profileName).toBe("income");

    const result = await runOptionsStrategyAction(nlqFacade() as never, intent.action, intent.filters, { profileStore, userLogin: "default_trader" });
    // A $1 planned-loss cap rejects every fixture candidate at the
    // acceptance rules: no trade survives.
    expect((result.bestTrade as { best: unknown } | undefined)?.best ?? null).toBeNull();
    expect(result.summary).toContain('Strategy profile "Income" (v1) applied — max planned loss $1.');
    expect(result.profileRef).toMatchObject({ name: "Income", version: 1 });

    // Control: the same question without the profile finds a trade.
    const control = await runOptionsStrategyAction(
      nlqFacade() as never,
      intent.action,
      { ...intent.filters, profileName: undefined },
      { profileStore },
    );
    expect((control.bestTrade as { best: unknown } | undefined)?.best ?? null).not.toBeNull();
    expect(control.summary).not.toContain("Strategy profile");
  });

  it("single-name path: an unknown profile name fails the same way as the scan path", async () => {
    const intent = parseOptionsStrategyIntent(
      "What is the best trade for NVDA bullish target $260 by 2026-11-20 against my missing profile",
    );
    const result = await runOptionsStrategyAction(nlqFacade() as never, intent.action, intent.filters, {
      profileStore: new InMemoryStrategyProfileStore(),
      userLogin: "default_trader",
    });
    expect(result.status).toBe("invalid_request");
    expect(result.summary).toBe('No saved profile named "missing".');
  });
});

// ---------------------------------------------------------------------------
// 6. Unified service
// ---------------------------------------------------------------------------

describe("unified service profiles (issue #28)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  const env = { ETRADE_ENVIRONMENT: "sandbox" } as Env;

  it("opportunities with profileId applies it and stamps executionData.profileRef", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: chainFor("NVDA", 250, expiryObj),
      AMD: chainFor("AMD", 40, expiryObj),
    });
    const profileStore = new InMemoryStrategyProfileStore({ idFactory: () => "prof_uni_1" });
    const created = await profileStore.create("default_trader", "Income", { allowedStrategies: ["long_call"] });
    const service = new UnifiedOptionsService(env, "default_trader", undefined, undefined, undefined, profileStore);
    const result = await service.execute({ action: "opportunities", symbols: ["NVDA", "AMD"], targetDate: expiryDate, profileId: created.id });

    expect(result.success).toBe(true);
    const data = result.data as unknown as {
      profileRef: unknown;
      requestSnapshot: { profile: { name: string } | null; template: { allowedStrategies: string[] } };
      matrix: Array<{ cells: Array<{ strategyType: string }> }>;
    };
    expect(data.profileRef).toEqual({ id: created.id, name: "Income", version: 1 });
    expect(data.requestSnapshot.profile?.name).toBe("Income");
    expect(data.requestSnapshot.template.allowedStrategies).toEqual(["long_call"]);
    const cellTypes = new Set(data.matrix.flatMap((m) => m.cells.map((c) => c.strategyType)));
    expect([...cellTypes]).toEqual(["long_call"]);
  });

  it("profileName resolves case-insensitively; an unknown profileId errors and does not scan", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: chainFor("NVDA", 250, expiryObj) });
    const profileStore = new InMemoryStrategyProfileStore({ idFactory: () => "prof_uni_2" });
    await profileStore.create("default_trader", "Income", { maxPlannedLoss: 2_500 });
    const service = new UnifiedOptionsService(env, "default_trader", undefined, undefined, undefined, profileStore);

    const byName = await service.execute({ action: "opportunities", symbols: ["NVDA"], targetDate: expiryDate, profileName: "INCOME" });
    expect(byName.success).toBe(true);
    expect((byName.data as { profileRef?: unknown }).profileRef).toEqual({ id: "prof_uni_2", name: "Income", version: 1 });

    const unknown = await service.execute({ action: "opportunities", symbols: ["NVDA"], targetDate: expiryDate, profileId: "nope" });
    expect(unknown.success).toBe(false);
    expect((unknown.data as { error?: string }).error).toBe('No saved profile with id "nope".');
    expect((unknown.data as { matrix?: unknown }).matrix).toBeUndefined(); // never scanned

    const noStore = new UnifiedOptionsService(env, "default_trader");
    const unavailable = await noStore.execute({ action: "opportunities", symbols: ["NVDA"], targetDate: expiryDate, profileId: "prof_uni_2" });
    expect(unavailable.success).toBe(false);
    expect((unavailable.data as { error?: string }).error).toBe("Saved profiles aren't available in this context.");
  });

  it("single-name best_trade applies the profile and stamps profileRef", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: chainFor("NVDA", 250, expiryObj) });
    const profileStore = new InMemoryStrategyProfileStore({ idFactory: () => "prof_uni_3" });
    const created = await profileStore.create("default_trader", "Tight", { maxPlannedLoss: 1 });
    const service = new UnifiedOptionsService(env, "default_trader", undefined, undefined, undefined, profileStore);

    const capped = await service.execute({
      action: "best_trade",
      symbol: "NVDA",
      thesis: "bullish",
      targetPrice: 262,
      targetDate: expiryDate,
      profileId: created.id,
    });
    expect(capped.success).toBe(true);
    const cappedData = capped.data as { bestTrade?: { best: unknown }; profileRef?: unknown };
    expect(cappedData.profileRef).toEqual({ id: created.id, name: "Tight", version: 1 });
    expect(cappedData.bestTrade?.best ?? null).toBeNull(); // the $1 cap binds

    const control = await service.execute({ action: "best_trade", symbol: "NVDA", thesis: "bullish", targetPrice: 262, targetDate: expiryDate });
    expect(((control.data as { bestTrade?: { best: unknown } }).bestTrade?.best ?? null)).not.toBeNull();
  });

  it("cache: profile and profile-less calls never share an entry; a version bump busts the cache", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ MSFT: chainFor("MSFT", 500, expiryObj) });
    const profileStore = new InMemoryStrategyProfileStore({ idFactory: () => "prof_cache_1" });
    const created = await profileStore.create("default_trader", "Income", { allowedStrategies: ["long_call"] });
    const service = new UnifiedOptionsService(env, "default_trader", undefined, undefined, undefined, profileStore);
    const base = { action: "opportunities", symbols: ["MSFT"], targetDate: expiryDate } as const;

    const plain1 = await service.execute({ ...base });
    expect(plain1.meta.cached).toBe(false);
    expect((plain1.data as { profileRef?: unknown }).profileRef).toBeNull();
    const plain2 = await service.execute({ ...base });
    expect(plain2.meta.cached).toBe(true); // profile-less calls still cache among themselves

    // The profile call must NOT be served the profile-less entry.
    const withProfile = await service.execute({ ...base, profileId: created.id });
    expect(withProfile.meta.cached).toBe(false);
    expect((withProfile.data as { profileRef?: unknown }).profileRef).toEqual({ id: created.id, name: "Income", version: 1 });

    // ... and it caches under its own key.
    const withProfile2 = await service.execute({ ...base, profileId: created.id });
    expect(withProfile2.meta.cached).toBe(true);

    // Editing the profile bumps its version, which segments the key:
    // the next call re-runs instead of serving the v1 result.
    await profileStore.update("default_trader", created.id, { allowedStrategies: ["long_put"] });
    const afterEdit = await service.execute({ ...base, profileId: created.id });
    expect(afterEdit.meta.cached).toBe(false);
    expect((afterEdit.data as { profileRef?: { version: number } }).profileRef?.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Unified opportunities limit forwarding (issue #84 slice 1)
// ---------------------------------------------------------------------------

describe("unified opportunities limit forwarding (issue #84 slice 1)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  const env = { ETRADE_ENVIRONMENT: "sandbox" } as Env;

  it("strategy_fit honors req.limit: fits paginate, fitsTotal stays whole, cache segments by limit", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: chainFor("NVDA", 250, expiryObj),
      AMD: chainFor("AMD", 40, expiryObj),
      MSFT: chainFor("MSFT", 500, expiryObj),
      AVGO: chainFor("AVGO", 300, expiryObj),
    });
    const service = new UnifiedOptionsService(env, "default_trader");
    const base = {
      action: "opportunities",
      symbols: ["NVDA", "AMD", "MSFT", "AVGO"],
      targetDate: expiryDate,
      mode: "strategy_fit",
    } as const;

    const all = await service.execute({ ...base });
    expect(all.success).toBe(true);
    const allData = all.data as unknown as { fits: unknown[]; fitsTotal: number };
    expect(allData.fitsTotal).toBeGreaterThanOrEqual(2);
    expect(allData.fits.length).toBe(Math.min(allData.fitsTotal, 10));

    const page = await service.execute({ ...base, limit: 1 });
    expect(page.meta.cached).toBe(false);
    const pageData = page.data as unknown as { fits: unknown[]; fitsTotal: number };
    expect(pageData.fits.length).toBe(1);
    expect(pageData.fitsTotal).toBe(allData.fitsTotal);

    const pageAgain = await service.execute({ ...base, limit: 1 });
    expect(pageAgain.meta.cached).toBe(true); // same limit caches under its own key

    const bigger = await service.execute({ ...base, limit: 2 });
    expect(bigger.meta.cached).toBe(false); // a different limit is a different entry
    expect((bigger.data as unknown as { fits: unknown[] }).fits.length).toBe(2);
  });
});
