/**
 * Issue #4402 (sub-issue of #4276) — the live-LLM end-to-end: the REAL
 * comparison core (runProductionComparison) through the engine path
 * (runComparisonViaEngine) with a stubbed LLM gateway.
 *
 * The gap this closes: #4276's runner tests mock runProductionComparison
 * at the module seam (the core "needs a live LLM gateway"), #4399's route
 * tests do the same, and the C5 suite pins the core with injected
 * generateDetailsFn/rankWithLlmFn stubs — so the real gateway calls
 * (generateLlmIdeaDetails and rankCandidatesWithLlm, both through
 * requireGatewayPorts) never executed in any suite, on either path.
 * Here nothing about the core is mocked: no module mock, no injected
 * LLM fns. The only fake sits at the provider binding seam — env.AI.run
 * returns canned model text, the gateway_executors.test.ts idiom — so
 * the prompt builders, the JSON repair/parsing, the verified snapshot
 * mapping, the kernel's three arms, the gates, and the ledger write all
 * run for real, deterministically, with no network: the stub binding is
 * the only gateway the test env can reach (no AI_GATEWAY_ID, so the
 * direct executor calls binding.run), and fetch is stubbed to throw
 * (the #4276 idiom), so any network attempt fails the test loudly.
 *
 * The build/rank/screen fns are the core's data inputs, not the core:
 * they are the C5 suite's fixtures, reused verbatim in shape. The DO
 * storage is the node:sqlite double from the #4068/#4276 suites. The
 * engine, the ports, the control plane, the gateway port, and the core
 * are all real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { resolveAiModelName } from "../src/agents/model";
import { GatewayAllProvidersFailedError } from "../src/gateway/gatewayPorts";
import {
  comparisonJobId,
  optionsEngineStoresFromSql,
  runComparisonViaEngine,
} from "../src/workflows/optionsScreenEngine";
import {
  listComparisonOutcomes,
  runProductionComparison,
} from "../src/services/comparisonRunner";
import type { KernelSnapshot } from "../src/services/recommendationKernel";
import type { ScreenedOptionContractItem } from "../src/types";
import type { StrategyCandidate, StrategyLeg } from "../src/trading/options/strategyEngine";

/** The node:sqlite DO-storage double (tests/strategy_entry_routing_4273 idiom). */
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

function screened(symbol: string, optionType: "CALL" | "PUT", strike: number): ScreenedOptionContractItem {
  return {
    symbol, optionType, strikePrice: strike, bid: 2.0, ask: 2.4, lastPrice: 2.2,
    volume: 1000, openInterest: 5000, impliedVolatility: 0.3,
    underlyingSymbol: "XYZ", underlyingPrice: 200, daysToExpiration: 30,
    expirationDate: "2026-11-22", moneyness: "ATM", strikeDistancePct: 0,
    spreadPct: 0.08, technicalSignal: "", highlightReason: "",
  } as ScreenedOptionContractItem;
}

function snapshot(contracts: ScreenedOptionContractItem[]): KernelSnapshot {
  return {
    symbol: "XYZ", contracts, dataSource: "live", chainProvenance: "live",
    underlyingPrice: 200, screen: { underlyingsScanned: 1, contractsEvaluated: contracts.length, contractsMatched: contracts.length },
    rejections: [],
  } as KernelSnapshot;
}

function leg(partial: Partial<StrategyLeg>): StrategyLeg {
  return {
    symbol: "XYZ", optionType: "CALL", side: "BUY", quantity: 1, strike: 200,
    expirationDate: "2026-11-22", daysToExpiration: 30, entryPrice: 2, bid: 1.8, ask: 2.2,
    impliedVolatility: 0.3, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.05,
    openInterest: 5_000, volume: 1_000, spreadPct: 0.08,
    quoteTimestamp: "2026-10-24T00:00:00.000Z", quoteFreshness: "FRESH", multiplier: 100,
    ...partial,
  };
}

function engineCandidate(id: string, structure: string, legs: StrategyLeg[]): StrategyCandidate {
  return {
    id, rank: 1, type: structure as any, label: `${id} label`, symbol: "XYZ",
    underlyingPrice: 200, expirationDate: "2026-11-22", dataFreshness: "FRESH",
    legs, netDebit: 2, estimatedFees: 2, maxProfit: null, maxProfitUnbounded: true, maxLoss: 200,
    breakevens: [203], targetPnl: 300, targetRewardRisk: 1, modelImpliedProbabilityOfProfit: 0.45,
    netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.02, vega: 0.05 },
    liquidityScore: 80, score: 70, scoreBreakdown: {} as any, payoffCurve: [], scenarios: [],
    explanations: [], warnings: [], assumptions: [],
  } as StrategyCandidate;
}

const REQUEST: any = {
  symbol: "XYZ", thesis: "bullish", targetPrice: 210, targetDate: "2026-11-22",
  expectedIvDirection: "unchanged", maxPlannedLoss: 500, minRewardRisk: 1,
};

/** Canned generation text: one real snapshot symbol + one invented symbol (dropped, never invented). */
const GENERATION_JSON = JSON.stringify({
  answer: "Bullish XYZ structures look best.",
  contractSymbols: ["XYZ261122C200", "FAKE123"],
});

/** Canned ranking text: the reverse of the quant order, so the hybrid order proves the LLM order. */
const RANKING_JSON = JSON.stringify({
  selections: [
    { candidateId: "cand-b", score: 90, rationale: "Better risk/reward.", risks: ["IV crush"] },
    { candidateId: "cand-a", score: 70, rationale: "Solid but wider.", risks: ["Theta decay"] },
  ],
});

interface BindingCall {
  model: string;
  inputs: unknown;
  kind: "generation" | "ranking";
}

/**
 * The stubbed LLM gateway: a fake Workers AI binding (the
 * gateway_executors.test.ts idiom). The call kind is read from the
 * prompt text the AI SDK forwards to binding.run, never from call
 * order, so an SDK retry cannot misroute a canned answer.
 */
function stubGatewayEnv(calls: BindingCall[], failWith?: Error) {
  // The binding is an explicit run-stub on one line: the #411 pin
  // (no_live_ai_binding.test.ts) scans each `AI:` site's own line and
  // accepts only `{}`, `{ run...`, `undefined`, or `null`.
  const run = async (model: string, inputs: unknown) => {
    const kind: BindingCall["kind"] = JSON.stringify(inputs ?? {}).includes("Rank every supplied")
      ? "ranking"
      : "generation";
    calls.push({ model, inputs, kind });
    if (failWith) throw failWith;
    return { response: kind === "ranking" ? RANKING_JSON : GENERATION_JSON };
  };
  return { AI: { run } };
}

function quantCandidates(): StrategyCandidate[] {
  return [
    engineCandidate("cand-a", "bull_call_spread", [leg({}), leg({ side: "SELL", strike: 210, symbol: "XYZ261122C210" })]),
    engineCandidate("cand-b", "long_call", [leg({})]),
  ];
}

function comparisonDispatchRequest(runId: string) {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: {
      comparisonRequest: {
        request: REQUEST,
        riskProfile: "balanced",
      },
    },
  };
}

describe("live-LLM comparison end-to-end (#4402)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network disabled in tests");
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the real core through the engine path: durable record, shared run id, verbatim three-arm result", async () => {
    const calls: BindingCall[] = [];
    const env = stubGatewayEnv(calls);
    const runId = "cmp-live-1";
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage, { AGENT_DB: new MockD1Database() });
    const ledgerSql = new MockSqlStorage() as any;
    const snap = snapshot([screened("XYZ261122C200", "CALL", 200), screened("XYZ261122C210", "CALL", 210)]);
    const quant = quantCandidates();

    // The thunk is the NLQ runner's thunk verbatim (comparisonNlqRunner):
    // the real core, no injected LLM fns, the minted id carried in.
    let captured: unknown;
    const execute = async () => {
      captured = await runProductionComparison({
        snapshot: snap,
        request: REQUEST,
        question: "What bullish XYZ strategies look best?",
        riskProfile: "balanced",
        buildFn: async () => ({ candidates: quant }),
        rankFn: (candidates: StrategyCandidate[]) =>
          candidates.map((c, i) => ({ candidate: c, rank: i + 1, compositeScore: 100 - i * 10, components: {} as any })),
        screenFn: (candidates: StrategyCandidate[]) => ({ matched: candidates, rejected: [] }),
        env: env as any,
        ledgerSql,
        runId,
      } as any);
      return captured as never;
    };
    const result = await runComparisonViaEngine(
      { runId, request: comparisonDispatchRequest(runId), engineStores },
      execute,
    );

    // Verbatim: the engine returns the thunk's result object itself.
    expect(result).toBe(captured);
    // The gateway saw both real calls, in the core's fixed order.
    expect(calls.map((c) => c.kind)).toEqual(["generation", "ranking"]);
    expect(calls[0]!.model).toBe(resolveAiModelName(env as never));
    expect(calls[1]!.model).toBe(resolveAiModelName(env as never, "optionsComparison"));
    // The real prompt builders ran: the generation prompt carries the
    // snapshot's contracts, the ranking prompt the quant candidates.
    expect(JSON.stringify(calls[0]!.inputs)).toContain("XYZ261122C200");
    expect(JSON.stringify(calls[1]!.inputs)).toContain("cand-a");
    expect(JSON.stringify(calls[1]!.inputs)).toContain("cand-b");

    // One run id: the engine job and the artifact carry it.
    expect(result.artifact.runId).toBe(runId);
    const definitions = await engineStores.stores.definitions.listDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.jobId).toBe(comparisonJobId(runId));
    expect((definitions[0]!.root as { kind?: string }).kind).toBe("comparison");
    expect(definitions[0]!.rawConfig).toEqual(
      expect.objectContaining({ request: comparisonDispatchRequest(runId) }),
    );
    const latest = await engineStores.runRecorder.latestRun(comparisonJobId(runId));
    expect(latest).toBeDefined();
    expect(latest?.outcome).toBe("success");

    // The real core's three arms: quant order is the panel ranking,
    // hybrid order is the stubbed LLM order, the llm arm carries the
    // verified generation (invented symbol dropped, snapshot prices).
    const artifact = result.artifact;
    expect(JSON.stringify(artifact)).not.toContain('"winner"');
    expect(artifact.arms.quant.ranked.map((c) => c.id)).toEqual(["cand-a", "cand-b"]);
    expect(artifact.arms.hybrid.ranked.map((c) => c.id)).toEqual(["cand-b", "cand-a"]);
    expect(artifact.arms.llm.attrition.generated).toBe(1);
    expect(artifact.arms.llm.ranked[0].provenance).toBe("llm");
    expect(artifact.stats.armRankedCounts.quant).toBe(2);
    expect(result.generationNotes).toMatchObject({
      model: resolveAiModelName(env as never),
      citedCount: 2,
      droppedCount: 1,
      llmGenerated: 1,
      skippedReason: null,
    });

    // The ledger write happened through the engine path, readable by run id.
    const rows = listComparisonOutcomes(ledgerSql, runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.run_id === runId)).toBe(true);
    expect(new Set(rows.map((r) => r.arm))).toEqual(new Set(["llm", "quant", "hybrid"]));

  });

  it("a stubbed-gateway failure surfaces the core's gateway error verbatim and records a failed run", async () => {
    const calls: BindingCall[] = [];
    const env = stubGatewayEnv(calls, new Error("stub gateway down"));
    const runId = "cmp-live-fail";
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage, { AGENT_DB: new MockD1Database() });
    const snap = snapshot([screened("XYZ261122C200", "CALL", 200)]);
    const quant = quantCandidates();

    await expect(
      runComparisonViaEngine(
        { runId, request: comparisonDispatchRequest(runId), engineStores },
        () =>
          runProductionComparison({
            snapshot: snap,
            request: REQUEST,
            question: "What bullish XYZ strategies look best?",
            riskProfile: "balanced",
            buildFn: async () => ({ candidates: quant }),
            rankFn: (candidates: StrategyCandidate[]) =>
              candidates.map((c, i) => ({ candidate: c, rank: i + 1, compositeScore: 100 - i * 10, components: {} as any })),
            screenFn: (candidates: StrategyCandidate[]) => ({ matched: candidates, rejected: [] }),
            env: env as any,
            runId,
          } as any),
      ),
    ).rejects.toThrowError(GatewayAllProvidersFailedError);

    // The generation call failed first, so the ranking call never ran.
    // Exactly TWO generation calls: the engine's unit retry
    // (executeUnit, jobPipelineEngine.ts) retries an uncoded throw
    // within the stage's retry budget, re-executing the whole thunk —
    // so a gateway failure through the engine path costs two
    // generation calls before the run settles failed. The default
    // budget is what makes this count deterministic here.
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.kind === "generation")).toBe(true);
    const latest = await engineStores.runRecorder.latestRun(comparisonJobId(runId));
    expect(latest).toBeDefined();
    expect(latest?.outcome).toBe("failure");
  });

  it("an empty snapshot through the engine path skips both gateway calls and still records the run", async () => {
    const calls: BindingCall[] = [];
    const env = stubGatewayEnv(calls);
    const runId = "cmp-live-empty";
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage, { AGENT_DB: new MockD1Database() });

    const result = await runComparisonViaEngine(
      { runId, request: comparisonDispatchRequest(runId), engineStores },
      () =>
        runProductionComparison({
          snapshot: snapshot([]),
          request: REQUEST,
          question: "What bullish XYZ strategies look best?",
          riskProfile: "balanced",
          buildFn: async () => ({ candidates: [] }),
          rankFn: () => [],
          screenFn: (candidates: StrategyCandidate[]) => ({ matched: candidates, rejected: [] }),
          env: env as any,
          runId,
        } as any),
    );

    expect(calls).toEqual([]);
    expect(result.artifact.stats.armRankedCounts).toEqual({ llm: 0, quant: 0, hybrid: 0 });
    expect(result.generationNotes.skippedReason).toBe(
      "snapshot has no screened contracts; LLM steps skipped",
    );
    expect(result.artifact.runId).toBe(runId);
    const latest = await engineStores.runRecorder.latestRun(comparisonJobId(runId));
    expect(latest).toBeDefined();
    expect(latest?.outcome).toBe("success");
  });
});
