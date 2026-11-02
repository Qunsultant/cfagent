/**
 * Issue #2763 (tracker #2708 item B4) — durableFibers checkpoint recovery.
 *
 * The fiber service has always WRITTEN checkpoints (FIBER_STARTED /
 * FIBER_CHECKPOINT events in mas_events, one per ctx.stash) but never
 * READ them: live records sat in an in-memory Map, so an eviction
 * mid-run lost the run and execute_durable_twap re-previewed every
 * slice from zero. These tests pin the read half:
 *
 * - a run carrying a runId, (re)started by a NEW service instance over
 *   the SAME event store, resumes from its latest checkpoint —
 *   checkpointed slices are not re-previewed and the run completes;
 * - a fully checkpointed run replays its stored plan with zero
 *   preview calls;
 * - no checkpoint -> today's behavior, unchanged;
 * - a corrupt checkpoint for the run's identity fails loud with a
 *   named FiberCheckpointError (fiber_checkpoint_corrupt) — never a
 *   silent fresh start on a trading path;
 * - a checkpoint written for a different plan fails loud
 *   (fiber_checkpoint_mismatch);
 * - identity isolation: another runId's or another session's
 *   checkpoints are never read;
 * - runs without a runId behave exactly as before.
 *
 * Eviction is simulated the honest way: incarnation A is discarded
 * entirely (its in-memory Map dies with it); incarnation B is a fresh
 * ETradeDurableFiberService over the same DatabaseORM/event store.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  ETradeDurableFiberService,
  FiberCheckpointError,
} from "../src/services/durableFibers";
import { DurableTWAPOrderCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";
import { ETradeService } from "../src/services/etrade";

const SESSION = "sess-2763";

const makeOrm = (session: string = SESSION) => {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(session);
  return orm;
};

const CFG = {
  symbol: "NVDA",
  action: "BUY" as const,
  totalQuantity: 12,
  slices: 4,
  intervalSeconds: 0,
};

const fakePreview = (sliceNum: number, sliceQty: number) =>
  Promise.resolve({
    orderId: `ord_slice${sliceNum}`,
    status: "previewed",
    quantity: sliceQty,
    estimatedPrice: 100,
    estimatedTotal: 100 * sliceQty,
  });

/** A preview callback that records the slices it was asked to preview
 *  and throws on `failOnSlice` (the interruption). */
const countingPreview = (calls: number[], failOnSlice?: number) =>
  async (sliceNum: number, sliceQty: number) => {
    calls.push(sliceNum);
    if (sliceNum === failOnSlice) throw new Error("simulated eviction mid-run");
    return fakePreview(sliceNum, sliceQty);
  };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("previewDurableTWAP checkpoint recovery (#2763)", () => {
  it("resumes from the latest checkpoint: checkpointed slices are not re-previewed and the run completes", async () => {
    const orm = makeOrm();
    const callsA: number[] = [];
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview(callsA, 3), { runId: "twap-run-1" })
    ).rejects.toThrow("simulated eviction mid-run");
    expect(callsA).toEqual([1, 2, 3]); // slices 1-2 checkpointed; slice 3 died before its checkpoint

    // Incarnation B: fresh service (empty in-memory registry), same store.
    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    expect(svcB.listFibers()).toHaveLength(0);
    const callsB: number[] = [];
    const result = await svcB.previewDurableTWAP(CFG, countingPreview(callsB), {
      runId: "twap-run-1",
    });

    expect(callsB).toEqual([3, 4]); // only the un-checkpointed slices ran
    expect(result.completed).toBe(true);
    expect(result.slicesPreviewed).toBe(4);
    expect(result.totalPreviewed).toBe(12);
    expect(result.previews.map((p) => p.preview.orderId)).toEqual([
      "ord_slice1",
      "ord_slice2",
      "ord_slice3",
      "ord_slice4",
    ]);
    expect(result.resumed).toBe(true);
    expect(result.resumedFromStep).toBe(2);
    expect(result.fiberId).toBe("fib_run_twap-run-1");
  });

  it("a fully checkpointed run replays its stored plan with zero preview calls", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    const first = await svcA.previewDurableTWAP(CFG, fakePreview, { runId: "twap-done-1" });
    expect(first.resumed).toBe(false);

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    const callsB: number[] = [];
    const replayed = await svcB.previewDurableTWAP(CFG, countingPreview(callsB), {
      runId: "twap-done-1",
    });
    expect(callsB).toEqual([]);
    expect(replayed.completed).toBe(true);
    expect(replayed.slicesPreviewed).toBe(4);
    expect(replayed.totalPreviewed).toBe(12);
    expect(replayed.resumed).toBe(true);
    expect(replayed.resumedFromStep).toBe(4);
  });

  it("no checkpoint for the identity -> fresh run, all slices previewed, resumed:false", async () => {
    const orm = makeOrm();
    const svc = new ETradeDurableFiberService(orm, undefined, SESSION);
    const calls: number[] = [];
    const result = await svc.previewDurableTWAP(CFG, countingPreview(calls), {
      runId: "never-seen",
    });
    expect(calls).toEqual([1, 2, 3, 4]);
    expect(result.resumed).toBe(false);
    expect(result.resumedFromStep).toBe(0);
    expect(result.fiberId).toBe("fib_run_never-seen");
  });

  it("a run interrupted before its first checkpoint resumes from step 0 under the same identity", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview([], 1), { runId: "twap-early-1" })
    ).rejects.toThrow("simulated eviction mid-run");

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    const callsB: number[] = [];
    const result = await svcB.previewDurableTWAP(CFG, countingPreview(callsB), {
      runId: "twap-early-1",
    });
    expect(callsB).toEqual([1, 2, 3, 4]); // nothing was checkpointed, nothing is skipped
    expect(result.fiberId).toBe("fib_run_twap-early-1");
    expect(result.resumedFromStep).toBe(0);
  });

  it("corrupt checkpoint (unparseable payload) fails loud with fiber_checkpoint_corrupt and previews nothing", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview([], 3), { runId: "twap-corrupt-1" })
    ).rejects.toThrow("simulated eviction mid-run");

    const checkpoints = orm.events.findMany({
      where: { sessionId: SESSION, type: "FIBER_CHECKPOINT" },
    });
    const latest = checkpoints[checkpoints.length - 1];
    expect(latest.id).toContain("fib_run_twap-corrupt-1");
    orm.events.update(latest.id, { payload: "not-json{{{" as never });

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    const callsB: number[] = [];
    const err = await svcB
      .previewDurableTWAP(CFG, countingPreview(callsB), { runId: "twap-corrupt-1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(FiberCheckpointError);
    expect(err.code).toBe("fiber_checkpoint_corrupt");
    expect(callsB).toEqual([]); // never silently restarted from slice 0
  });

  it("corrupt checkpoint (shape-invalid payload) fails loud with fiber_checkpoint_corrupt", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview([], 3), { runId: "twap-corrupt-2" })
    ).rejects.toThrow("simulated eviction mid-run");

    const checkpoints = orm.events.findMany({
      where: { sessionId: SESSION, type: "FIBER_CHECKPOINT" },
    });
    const latest = checkpoints[checkpoints.length - 1];
    orm.events.update(latest.id, {
      payload: {
        fiberId: "fib_run_twap-corrupt-2",
        name: "twap_preview_NVDA_BUY",
        status: "running",
        currentStep: "two",
        totalSteps: 4,
        stashedData: {},
        startedAt: "2026-11-02T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
      } as never,
    });

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    const callsB: number[] = [];
    const err = await svcB
      .previewDurableTWAP(CFG, countingPreview(callsB), { runId: "twap-corrupt-2" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(FiberCheckpointError);
    expect(err.code).toBe("fiber_checkpoint_corrupt");
    expect(callsB).toEqual([]);
  });

  it("a checkpoint written for a different plan fails loud with fiber_checkpoint_mismatch", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview([], 3), { runId: "twap-mismatch-1" })
    ).rejects.toThrow("simulated eviction mid-run");

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    const callsB: number[] = [];
    const err = await svcB
      .previewDurableTWAP(
        { ...CFG, totalQuantity: 20 },
        countingPreview(callsB),
        { runId: "twap-mismatch-1" }
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(FiberCheckpointError);
    expect(err.code).toBe("fiber_checkpoint_mismatch");
    expect(callsB).toEqual([]);
  });

  it("identity isolation: another runId's checkpoint is never read", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview([], 3), { runId: "iso-a" })
    ).rejects.toThrow("simulated eviction mid-run");

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    const callsB: number[] = [];
    const result = await svcB.previewDurableTWAP(CFG, countingPreview(callsB), {
      runId: "iso-b",
    });
    expect(callsB).toEqual([1, 2, 3, 4]);
    expect(result.resumed).toBe(false);
    expect(result.fiberId).toBe("fib_run_iso-b");
  });

  it("identity isolation: another session's checkpoint is never read", async () => {
    const orm = makeOrm();
    orm.initializeSchema("other-session");
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview([], 3), { runId: "iso-a" })
    ).rejects.toThrow("simulated eviction mid-run");

    const svcC = new ETradeDurableFiberService(orm, undefined, "other-session");
    const callsC: number[] = [];
    const result = await svcC.previewDurableTWAP(CFG, countingPreview(callsC), {
      runId: "iso-a",
    });
    expect(callsC).toEqual([1, 2, 3, 4]);
    expect(result.resumed).toBe(false);
  });

  it("an invalid runId is rejected with fiber_run_id_invalid before anything runs", async () => {
    const orm = makeOrm();
    const svc = new ETradeDurableFiberService(orm, undefined, SESSION);
    const calls: number[] = [];
    const err = await svc
      .previewDurableTWAP(CFG, countingPreview(calls), { runId: "bad id!" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(FiberCheckpointError);
    expect(err.code).toBe("fiber_run_id_invalid");
    expect(calls).toEqual([]);
  });

  it("a resume appends a FIBER_RESUMED event naming the run and the from-step", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.previewDurableTWAP(CFG, countingPreview([], 3), { runId: "twap-audit-1" })
    ).rejects.toThrow("simulated eviction mid-run");

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    await svcB.previewDurableTWAP(CFG, fakePreview, { runId: "twap-audit-1" });

    const resumed = orm.events.findMany({
      where: { sessionId: SESSION, type: "FIBER_RESUMED" },
    });
    expect(resumed).toHaveLength(1);
    const payload =
      typeof resumed[0].payload === "string"
        ? JSON.parse(resumed[0].payload)
        : resumed[0].payload;
    expect(payload.fiberId).toBe("fib_run_twap-audit-1");
    expect(payload.resumedFromStep).toBe(2);
  });

  it("without a runId, behavior is unchanged: fresh fiber id per run, every slice previewed, no resume reads", async () => {
    const orm = makeOrm();
    const svc = new ETradeDurableFiberService(orm, undefined, SESSION);
    const calls1: number[] = [];
    const first = await svc.previewDurableTWAP(CFG, countingPreview(calls1));
    const calls2: number[] = [];
    const second = await svc.previewDurableTWAP(CFG, countingPreview(calls2));
    expect(calls1).toEqual([1, 2, 3, 4]);
    expect(calls2).toEqual([1, 2, 3, 4]);
    expect(first.fiberId).toMatch(/^fib_\d+_[0-9a-f]{6}$/);
    expect(second.fiberId).not.toBe(first.fiberId);
    expect(first.resumed).toBe(false);
    expect(
      orm.events.findMany({ where: { sessionId: SESSION, type: "FIBER_RESUMED" } })
    ).toHaveLength(0);
  });
});

describe("runFiber generic resume seam (#2763)", () => {
  it("a restarted fiber body sees the restored stash and the recovered flag", async () => {
    const orm = makeOrm();
    const svcA = new ETradeDurableFiberService(orm, undefined, SESSION);
    await expect(
      svcA.runFiber(
        "generic_job",
        async (ctx) => {
          ctx.stash({ progress: 1 });
          throw new Error("died after first stash");
        },
        2,
        { runId: "generic-1" }
      )
    ).rejects.toThrow("died after first stash");

    const svcB = new ETradeDurableFiberService(orm, undefined, SESSION);
    const seen = await svcB.runFiber(
      "generic_job",
      async (ctx) => ({
        recovered: ctx.recovered,
        resumedFromStep: ctx.resumedFromStep,
        restored: ctx.restoredStash,
      }),
      2,
      { runId: "generic-1" }
    );
    expect(seen.recovered).toBe(true);
    expect(seen.resumedFromStep).toBe(1);
    expect(seen.restored.progress).toBe(1);
  });
});

describe("execute_durable_twap runId resume (MCP command, #2763)", () => {
  const sharedContext = (orm: DatabaseORM, auditLog: any[]) =>
    ({
      env: { ETRADE_ENVIRONMENT: "sandbox" },
      orm,
      sessionId: SESSION,
      audit: (type: string, agent: any, payload: Record<string, unknown>) =>
        auditLog.push({ type, agent, payload }),
    }) as any;

  it("schema carries the optional runId input", () => {
    const cmd = new DurableTWAPOrderCommand();
    expect((cmd.jsonSchema.properties as any).runId).toBeDefined();
    expect(cmd.jsonSchema.required).not.toContain("runId");
  });

  it("an interrupted command invocation resumes under the same runId and audits resumed:true", async () => {
    const orm = makeOrm();
    let previewCalls = 0;
    vi.spyOn(ETradeService.prototype, "previewOrder").mockImplementation(() => {
      previewCalls++;
      if (previewCalls === 3) throw new Error("simulated eviction mid-run");
      return {
        orderId: `ord_call${previewCalls}`,
        status: "previewed",
        estimatedPrice: 100,
        estimatedTotal: 300,
      } as any;
    });

    const cmd = new DurableTWAPOrderCommand();
    const auditLogA: any[] = [];
    await expect(
      cmd.execute(
        { symbol: "NVDA", action: "BUY", totalQuantity: 12, slices: 4, runId: "cmd-run-1" },
        sharedContext(orm, auditLogA)
      )
    ).rejects.toThrow("simulated eviction mid-run");
    expect(auditLogA).toHaveLength(0); // no completion audit for a dead run

    // Second invocation = a new incarnation (the command builds a fresh
    // fiber service per call) over the same durable store.
    previewCalls = 0;
    vi.spyOn(ETradeService.prototype, "previewOrder").mockImplementation(() => {
      previewCalls++;
      return {
        orderId: `ord_callB${previewCalls}`,
        status: "previewed",
        estimatedPrice: 100,
        estimatedTotal: 300,
      } as any;
    });
    const auditLogB: any[] = [];
    const result: any = await cmd.execute(
      { symbol: "NVDA", action: "BUY", totalQuantity: 12, slices: 4, runId: "cmd-run-1" },
      sharedContext(orm, auditLogB)
    );

    expect(previewCalls).toBe(2); // only slices 3 and 4 were previewed again
    expect(result.status).toBe("previewed");
    expect(result.executed).toBe(false);
    expect(result.planCompleted).toBe(true);
    expect(result.slicesPreviewed).toBe(4);
    expect(result.totalPreviewed).toBe(12);
    expect(result.resumed).toBe(true);
    expect(result.resumedFromStep).toBe(2);
    expect(result.previews).toHaveLength(4);
    expect(auditLogB).toHaveLength(1);
    expect(auditLogB[0].type).toBe("twap.previewed");
    expect(auditLogB[0].payload.resumed).toBe(true);
    expect(auditLogB[0].payload.resumedFromStep).toBe(2);
  });
});
