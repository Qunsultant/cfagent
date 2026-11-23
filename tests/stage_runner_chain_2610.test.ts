/**
 * Issue #2610 (Options Screener programme slice 6): the sharded chain is
 * the async-alarm invocation of the one stage runner.
 *
 * Pins that the chain's advance decisions run on the stage-runner contract
 * (one plan per stage, one checkpoint, planNext, resumeUnits) and decide
 * EXACTLY what the hand-rolled row predicates decided — this is the test
 * plan #3026 named but never landed ("Stage-advance pins driven through
 * the async driver with a fake queue, asserting the same decisions as
 * planNext"). The submission construction (shard specs, stagger, parent
 * linkage) and the chain's domain rules (feed order, assemble gate,
 * per-format options rules) are unchanged; only the decision layer moved.
 *
 * Deliberate differences, pinned here so they are never "fixed" away:
 *  - planNext treats a failed unit as non-terminal (it is outstanding),
 *    while the options branches advance past failed legs once every leg
 *    is terminal — the chain-domain rule, stated over the checkpoint.
 *  - The feed branch waits for in-flight retries (a symbol whose retry
 *    is queued is not terminal — assembly needs its data); the
 *    generate/store branches do not (stageTerminal counts a failed leg
 *    terminal — the serve outcome carries the leg error).
 */

import { describe, expect, it } from "vitest";
import {
  assessFeedGate,
  chainStageCheckpoint,
  chainStageInflightRetries,
  chainStageNext,
  chainStagePlan,
  chainStageResumeUnits,
  chainStageUnits,
  planShardAdvance,
  type ShardChainContext,
  type ShardRow,
} from "../src/services/shardJobs";

const T1 = "2026-10-24T12:00:00.000Z";
const T2 = "2026-10-24T12:01:00.000Z";

const stockChain = (over: Partial<ShardChainContext> = {}): ShardChainContext => ({
  chainId: "chain-1",
  screenType: "stock",
  universe: "NASDAQ100",
  userLogin: "u1",
  trigger: "scheduled",
  timestamp: T1,
  channels: ["slack"],
  ...over,
});

const optionsChain = (symbols: string[] = ["AAPL", "MSFT"]): ShardChainContext => ({
  chainId: "chain-opt",
  screenType: "options",
  universe: "symbols",
  userLogin: "u1",
  trigger: "scheduled",
  timestamp: T1,
  channels: ["slack"],
  options: { symbols, thesis: "bullish" },
});

const row = (over: Partial<ShardRow> & { jobId: string }): ShardRow => ({
  stage: "feed",
  status: "completed",
  createdAt: T1,
  ...over,
});

const feed = (key: string, status: string, jobId = `feed-${key}`, createdAt = T1, error?: string) =>
  row({ jobId, stage: "feed", shardKey: key, status, createdAt, ...(error ? { error } : {}) });

const advanceFeed = (c: ShardChainContext, rows: ShardRow[], completedKey: string) =>
  planShardAdvance({
    chain: c,
    rows,
    completedStage: "feed",
    completedKey,
    rootJobId: "root",
    nowIso: T1,
  });

const shardKeysOf = (specs: unknown[]) =>
  (specs as Array<{ payload: { shard: { key: string } } }>).map((s) => s.payload.shard.key).sort();

describe("chain → stage-runner bridge: plan shape (issue 2610)", () => {
  it("plans one stage at a time, async-alarm, run id is the chain id", () => {
    const plan = chainStagePlan(stockChain(), "feed");
    expect(plan.runId).toBe("chain-1");
    expect(plan.invocation).toBe("async-alarm");
    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0].stage).toBe("feed");
    expect(plan.stages[0].retryBucket).toBe("acquisition");
    expect(plan.stages[0].execution).toBe("sequential");
  });

  it("feed units are the provider keys (stock) or the symbols (options)", () => {
    expect(chainStageUnits(stockChain(), "feed")).toEqual(["nasdaq", "etrade", "yahoo"]);
    expect(chainStageUnits(optionsChain(), "feed")).toEqual(["AAPL", "MSFT"]);
    expect(chainStageUnits(optionsChain(["msft", " AAPL ", "MSFT"]), "feed")).toEqual([
      "MSFT",
      "AAPL",
    ]);
  });

  it("generate maps to the runner analysis stage with the report bucket", () => {
    const plan = chainStagePlan(stockChain(), "generate");
    expect(plan.stages[0].stage).toBe("analysis");
    expect(plan.stages[0].retryBucket).toBe("report");
    expect(plan.stages[0].execution).toBe("parallel");
    expect(chainStageUnits(stockChain(), "generate")).toEqual(["assemble", "pdf", "xlsx", "csv"]);
    expect(chainStageUnits(stockChain(), "store")).toEqual(["pdf", "xlsx", "csv"]);
  });

  it("serve/deliver carry the implicit run unit (no fan-out)", () => {
    expect(chainStageUnits(stockChain(), "serve")).toEqual([]);
    expect(chainStagePlan(stockChain(), "serve").units).toEqual([]);
    expect(chainStagePlan(stockChain(), "serve").stages[0].stage).toBe("serve");
    expect(chainStagePlan(stockChain(), "deliver").stages[0].stage).toBe("deliver");
  });
});

describe("chain → stage-runner bridge: checkpoint projection (issue 2610)", () => {
  it("projects one entry per (stage, unit); no rows is never-attempted", () => {
    const checkpoint = chainStageCheckpoint(stockChain(), [], "feed");
    expect(checkpoint.runId).toBe("chain-1");
    expect(checkpoint.units).toHaveLength(3);
    expect(checkpoint.units.map((u) => [u.unitId, u.status, u.attempt])).toEqual([
      ["nasdaq", "never-attempted", 0],
      ["etrade", "never-attempted", 0],
      ["yahoo", "never-attempted", 0],
    ]);
  });

  it("a healed retry reads completed, not failed (C3 heal rule)", () => {
    const checkpoint = chainStageCheckpoint(stockChain(), [
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
      feed("etrade", "completed", "feed-etrade-2", T2),
      feed("yahoo", "completed"),
    ], "feed");
    const byKey = new Map(checkpoint.units.map((u) => [u.unitId, u]));
    expect(byKey.get("etrade")).toMatchObject({ status: "completed", attempt: 2 });
    expect(byKey.get("etrade")?.error).toBeUndefined();
    expect(byKey.get("nasdaq")?.status).toBe("completed");
    expect(byKey.get("yahoo")?.status).toBe("completed");
  });

  it("an unhealed failure reads failed and names its error", () => {
    const checkpoint = chainStageCheckpoint(stockChain(), [
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
    ], "feed");
    const byKey = new Map(checkpoint.units.map((u) => [u.unitId, u]));
    expect(byKey.get("etrade")).toMatchObject({ status: "failed", error: "provider 429", attempt: 1 });
  });

  it("a failed row with a queued retry still reads failed (retry healed nothing yet)", () => {
    const checkpoint = chainStageCheckpoint(stockChain(), [
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
      feed("etrade", "queued", "feed-etrade-2", T2),
    ], "feed");
    const etrade = checkpoint.units.find((u) => u.unitId === "etrade")!;
    expect(etrade.status).toBe("failed");
    expect(etrade.attempt).toBe(2);
  });

  it("a serve row with no shard key projects onto the implicit run unit", () => {
    const checkpoint = chainStageCheckpoint(stockChain(), [
      row({ jobId: "serve-1", stage: "serve", status: "completed" }),
    ], "serve");
    expect(checkpoint.units).toHaveLength(1);
    expect(checkpoint.units[0]).toMatchObject({ unitId: "chain-1", status: "completed", attempt: 1 });
  });
});

describe("chain → stage-runner bridge: planNext and resumeUnits (issue 2610)", () => {
  it("planNext is null when every unit is terminal", () => {
    expect(chainStageNext(stockChain(), [
      feed("nasdaq", "completed"),
      feed("etrade", "completed"),
      feed("yahoo", "completed"),
    ], "feed")).toBeNull();
  });

  it("planNext returns the failed unit as outstanding (failed is non-terminal)", () => {
    const next = chainStageNext(stockChain(), [
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
      feed("yahoo", "completed"),
    ], "feed");
    expect(next?.stage.stage).toBe("feed");
    expect(next?.units.map((u) => u.unitId)).toEqual(["etrade"]);
  });

  it("resumeUnits never returns a completed unit — or a never-attempted one", () => {
    const resumed = chainStageResumeUnits(stockChain(), [
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
      feed("etrade", "completed", "feed-etrade-2", T2),
    ], "feed");
    // etrade healed (completed) and yahoo never attempted: neither is resumed.
    expect(resumed).toEqual([]);
    const resumed2 = chainStageResumeUnits(stockChain(), [
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
    ], "feed");
    expect(resumed2).toEqual(["etrade"]);
  });

  it("resumeUnits returns a queued unit (it did not complete)", () => {
    expect(chainStageResumeUnits(stockChain(), [
      feed("nasdaq", "queued"),
    ], "feed")).toEqual(["nasdaq"]);
  });
});

describe("chain → stage-runner bridge: in-flight retries (issue 2610)", () => {
  it("names a unit whose retry is queued after a failure — and only that", () => {
    const c = optionsChain();
    expect(chainStageInflightRetries(c, [
      row({ jobId: "f-a", stage: "feed", shardKey: "AAPL", status: "completed" }),
      row({ jobId: "f-m1", stage: "feed", shardKey: "MSFT", status: "failed", createdAt: T1, error: "boom" }),
      row({ jobId: "f-m2", stage: "feed", shardKey: "MSFT", status: "queued", createdAt: T2 }),
    ], "feed")).toEqual(["MSFT"]);
    expect(chainStageInflightRetries(c, [
      row({ jobId: "f-m1", stage: "feed", shardKey: "MSFT", status: "failed", createdAt: T1 }),
    ], "feed")).toEqual([]);
    expect(chainStageInflightRetries(c, [
      row({ jobId: "f-m1", stage: "feed", shardKey: "MSFT", status: "queued", createdAt: T1 }),
    ], "feed")).toEqual([]);
    expect(chainStageInflightRetries(c, [
      row({ jobId: "f-m1", stage: "feed", shardKey: "MSFT", status: "failed", createdAt: T1 }),
      row({ jobId: "f-m2", stage: "feed", shardKey: "MSFT", status: "completed", createdAt: T2 }),
    ], "feed")).toEqual([]);
  });
});

describe("planShardAdvance == bridge decisions: stock feed (issue 2610)", () => {
  it("a failed feed shard blocks the chain — and the bridge names it failed/resumable", () => {
    const c = stockChain();
    const rows = [
      feed("nasdaq", "completed"),
      feed("etrade", "completed"),
      feed("yahoo", "failed", "feed-yahoo-1", T1, "yahoo boom"),
    ];
    expect(advanceFeed(c, rows, "etrade")).toEqual([]);
    expect(chainStageCheckpoint(c, rows, "feed").units.find((u) => u.unitId === "yahoo"))
      .toMatchObject({ status: "failed", error: "yahoo boom" });
    expect(chainStageResumeUnits(c, rows, "feed")).toEqual(["yahoo"]);
  });

  it("a healed feed shard lets the chain advance through the gate", () => {
    const c = stockChain();
    const rows = [
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
      feed("etrade", "completed", "feed-etrade-2", T2),
      feed("yahoo", "completed"),
    ];
    const specs = advanceFeed(c, rows, "yahoo");
    expect(specs).toHaveLength(1);
    expect(shardKeysOf(specs)).toEqual(["assemble"]);
    expect(assessFeedGate(rows, c)).toEqual({ ready: true });
  });

  it("a failed shard with a queued retry still blocks (the retry healed nothing yet)", () => {
    const c = stockChain();
    const rows = [
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
      feed("etrade", "queued", "feed-etrade-2", T2),
    ];
    expect(advanceFeed(c, rows, "nasdaq")).toEqual([]);
    expect(chainStageCheckpoint(c, rows, "feed").units.find((u) => u.unitId === "etrade")?.status)
      .toBe("failed");
  });

  it("the gate names every blocker — failed error, missing shard, unfinished shard", () => {
    const c = stockChain();
    expect(assessFeedGate([
      feed("nasdaq", "completed"),
      feed("etrade", "failed", "feed-etrade-1", T1, "provider 429"),
    ], c)).toEqual({
      ready: false,
      blockedBy: [
        { shardKey: "etrade", reason: "provider 429" },
        { shardKey: "yahoo", reason: "feed shard not submitted" },
      ],
    });
    expect(assessFeedGate([
      feed("nasdaq", "completed"),
      feed("etrade", "running"),
    ], c)).toEqual({
      ready: false,
      blockedBy: [
        { shardKey: "etrade", reason: "feed shard status: running" },
        { shardKey: "yahoo", reason: "feed shard not submitted" },
      ],
    });
    // Backwards compatibility: the one-arg call still answers the same way.
    expect(assessFeedGate([
      feed("nasdaq", "completed"),
      feed("etrade", "completed"),
      feed("yahoo", "completed"),
    ])).toEqual({ ready: true });
  });
});

describe("planShardAdvance == bridge decisions: options feed (issue 2610)", () => {
  it("advances to assemble once every symbol is terminal — failed symbols ride the resume set", () => {
    const c = optionsChain();
    const rows = [
      row({ jobId: "f-a", stage: "feed", shardKey: "AAPL", status: "completed" }),
      row({ jobId: "f-m", stage: "feed", shardKey: "MSFT", status: "failed", error: "MSFT boom" }),
    ];
    const specs = advanceFeed(c, rows, "AAPL");
    expect(specs).toHaveLength(1);
    expect(shardKeysOf(specs)).toEqual(["assemble"]);
    expect(chainStageResumeUnits(c, rows, "feed")).toEqual(["MSFT"]);
    expect(chainStageInflightRetries(c, rows, "feed")).toEqual([]);
  });

  it("waits while a symbol's retry is queued — assembly needs its data", () => {
    const c = optionsChain();
    const rows = [
      row({ jobId: "f-a", stage: "feed", shardKey: "AAPL", status: "completed" }),
      row({ jobId: "f-m1", stage: "feed", shardKey: "MSFT", status: "failed", createdAt: T1, error: "boom" }),
      row({ jobId: "f-m2", stage: "feed", shardKey: "MSFT", status: "queued", createdAt: T2 }),
    ];
    expect(advanceFeed(c, rows, "AAPL")).toEqual([]);
    expect(chainStageInflightRetries(c, rows, "feed")).toEqual(["MSFT"]);
  });

  it("waits while a symbol is still running", () => {
    const c = optionsChain();
    const rows = [
      row({ jobId: "f-a", stage: "feed", shardKey: "AAPL", status: "completed" }),
      row({ jobId: "f-m", stage: "feed", shardKey: "MSFT", status: "running" }),
    ];
    expect(advanceFeed(c, rows, "AAPL")).toEqual([]);
    expect(chainStageCheckpoint(c, rows, "feed").units.find((u) => u.unitId === "MSFT")?.status)
      .toBe("running");
  });
});

describe("planShardAdvance == bridge decisions: options generate (issue 2610)", () => {
  const assembleRow = () =>
    row({ jobId: "gen-assemble", stage: "generate", shardKey: "assemble", result: { scanned: 1, withTrades: 1, opportunities: [], coverage: { evaluated: 1, considered: 1 } } });
  const gen = (format: string) =>
    row({ jobId: `gen-${format}`, stage: "generate", shardKey: format, result: { format, key: `options:${format}:1`, fileName: `${format}.bin` } });
  const advanceGenerate = (c: ShardChainContext, rows: ShardRow[]) =>
    planShardAdvance({ chain: c, rows, completedStage: "generate", completedKey: "csv", rootJobId: "root", nowIso: T1 });

  it("advances completed formats past a failed leg — planNext still names the failed leg outstanding", () => {
    const c = optionsChain(["AAPL"]);
    const rows = [
      assembleRow(),
      gen("pdf"),
      row({ jobId: "gen-xlsx", stage: "generate", shardKey: "xlsx", status: "failed", error: "XLSX boom" }),
      gen("csv"),
    ];
    const specs = advanceGenerate(c, rows);
    expect(shardKeysOf(specs)).toEqual(["csv", "pdf"]);
    expect(specs.every((s) => s.stage === "store")).toBe(true);
    // The deliberate difference, pinned: planNext treats failed as
    // non-terminal (the leg is outstanding to the runner), while the
    // chain's per-format rule advances past it once every leg is terminal.
    expect(chainStageNext(c, rows, "generate")?.units.map((u) => u.unitId)).toEqual(["xlsx"]);
    expect(chainStageResumeUnits(c, rows, "generate")).toEqual(["xlsx"]);
  });

  it("waits while a format is still running — and the bridge agrees", () => {
    const c = optionsChain(["AAPL"]);
    const rows = [
      assembleRow(),
      gen("pdf"),
      row({ jobId: "gen-xlsx", stage: "generate", shardKey: "xlsx", status: "running" }),
      gen("csv"),
    ];
    expect(advanceGenerate(c, rows)).toEqual([]);
    expect(chainStageNext(c, rows, "generate")?.units.map((u) => u.unitId)).toEqual(["xlsx"]);
  });
});
