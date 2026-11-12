/**
 * Issue #4274 (#3552 G1) — goal-shape stage control: decided-not-to.
 *
 * A goal-shape options run cannot be stage-controlled from a chat/MCP
 * turn. The goal leg runs over in-memory engine stores on the
 * ScreenerAgent DO, so no durable job record exists in the chat host's
 * SQL — the control cannot find the job to drive a stage of it, and
 * binding the ports alone cannot fix that (a cross-DO control path is
 * needed). The decision is recorded on #4274; the refusal names it.
 *
 * The goal leg's shapeReport/deliver ARE pure functions of their
 * inputs (createGoalOptionsLegDelivery) and rebuildable — the blocker
 * is the job record, not the ports. The test pins:
 * - an execution op (run/rerun/resume) on a goal-shape run refuses
 *   stage_port_unavailable, and the message names #4274;
 * - stop/cancel on a goal-shape run are NOT blocked by the goal guard
 *   (they need no ports) — on a completed run they reach the engine
 *   and refuse with the engine's codes (stage_not_stoppable /
 *   stage_not_cancellable), proving the guard gates execution ops only.
 *
 * The dispatch here is the real goal leg: the goalPlan request + the
 * goal leg's delivery fns, over SQL-backed engine stores in the test
 * (so the job IS durable in the test's SQL and the guard is reachable
 * — in production the leg runs over in-memory stores, so the control
 * would refuse job_not_found before ever reaching the guard).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import {
  optionsEngineStoresFromSql,
  runOptionsScreenViaEngine,
} from "../src/workflows/optionsScreenEngine";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "../src/workflows/optionsScreenWorkflow";
import {
  createOptionsScreenPorts,
  type OptionsStageStorage,
} from "../src/workflows/optionsScreenPorts";
import {
  controlOptionsStage,
  OptionsStageControlError,
} from "../src/workflows/optionsStageControl";
import { createGoalOptionsLegDelivery } from "../src/workflows/goalOptionsLeg";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
          impliedVolatility: 0.25,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
          impliedVolatility: 0.25,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

/** The node:sqlite DO-storage double (tests/feed_pipeline_host_3543 idiom). */
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

function makeDoStorage(): {
  sql: SqlStorage;
  storage: OptionsStageStorage & { sql: SqlStorage };
} {
  const sql = new SqliteTestStorage() as unknown as SqlStorage;
  const blob = memoryStageStorage();
  return { sql, storage: { ...blob, sql } };
}

async function expectControlError(
  promise: Promise<unknown>,
  code: string,
): Promise<OptionsStageControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OptionsStageControlError);
    expect((error as OptionsStageControlError).code).toBe(code);
    return error as OptionsStageControlError;
  }
  throw new Error(`expected a control refusal with code ${code}, but the call succeeded`);
}

/**
 * The real goal leg, as dispatched by runGoalOptionsLegViaWorkflow
 * (goalDrivenScreen.ts): a goalPlan request + the goal leg's
 * shapeReport/deliver (createGoalOptionsLegDelivery), over SQL-backed
 * engine stores in the test so the job is durable and the guard is
 * reachable. The goal leg omits the canonical store (the goal run's
 * row is the single canonical home, #783) — the persist stage records
 * the decided omission (created:false) and the goal leg's shapeReport
 * reads the in-memory canonical record from the artifact.
 */
async function dispatchGoal(
  sql: SqlStorage,
  storage: OptionsStageStorage,
  runId: string,
) {
  const request = {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: {
      goalPlan: {
        optionsFilter: { underlyingSymbols: ["AAPL"] },
        structures: ["long_call"],
      },
    },
  };
  const outcome = await runOptionsScreenViaEngine(
    { runId, userLogin: "tester", request },
    {
      stages: createOptionsScreenPorts({
        screener: new DynamicOptionsScreener(undefined),
        storage,
        ...createGoalOptionsLegDelivery({ goalRunId: `goal-screen:${runId}` }),
      }),
      claims: memoryStageClaims(),
      queue: null,
      engineStores: optionsEngineStoresFromSql(sql),
    },
  );
  return outcome;
}

describe("goal-shape stage control (#4274, decided-not-to)", () => {
  it("a goal-shape run dispatches through the engine and completes (the real goal leg)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-goal:1";
      const outcome = await dispatchGoal(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      // The goal leg's shapeReport ran: its report section is the
      // shapeReport artifact, carrying the goal run id + the leg.
      // The artifact is the stage output { terminal, report }.
      const stored = await storage.get<{
        report?: { goalRunId?: string; leg?: string };
      }>(`options:${runId}:shapeReport`);
      expect(stored?.report?.goalRunId).toBe(`goal-screen:${runId}`);
      expect(stored?.report?.leg).toBe("options");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("an execution op on a goal-shape run refuses stage_port_unavailable and names #4274", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-goal:2";
      expect((await dispatchGoal(sql, storage, runId)).outcome).toBe("completed");
      for (const operation of ["run", "rerun", "resume"] as const) {
        const error = await expectControlError(
          controlOptionsStage({
            sql,
            storage,
            runId,
            stage: "screen",
            operation,
            userLogin: "tester",
          }),
          "stage_port_unavailable",
        );
        expect(error.message).toContain("#4274");
        expect(error.message).toContain(runId);
      }
      // The guard fires for every stage, not only "screen" — a
      // goal-shape shapeReport/deliver is refused the same way.
      const error = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "shapeReport",
          operation: "rerun",
          userLogin: "tester",
        }),
        "stage_port_unavailable",
      );
      expect(error.message).toContain("#4274");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("stop/cancel on a goal-shape run are NOT blocked by the goal guard (they reach the engine)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-goal:3";
      expect((await dispatchGoal(sql, storage, runId)).outcome).toBe("completed");
      // The goal guard gates execution ops only. Stop/cancel need no
      // ports, so they reach the engine — on a completed run the
      // engine refuses with its own codes (the stage is terminal),
      // never with stage_port_unavailable.
      const stopped = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "stop",
          userLogin: "tester",
        }),
        "stage_not_stoppable",
      );
      expect(stopped.message).toContain(runId);
      await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "cancel",
          userLogin: "tester",
        }),
        "stage_not_cancellable",
      );
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
