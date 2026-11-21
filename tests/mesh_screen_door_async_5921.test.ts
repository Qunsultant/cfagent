/**
 * Issue #5921 — Copilot screen async dispatch parity: the
 * delivery:"async" leg of `run_stock_screen`.
 *
 * - Door (meshScreenDoor.ts): when the caller EXPLICITLY asks
 *   for delivery:"async", the door returns early with the run
 *   id and status link instead of awaiting; explicit sync and
 *   the family default still await, byte-identical. The
 *   explicit-async-only keying matters because the family
 *   default delivery IS "async" — keying on the resolved mode
 *   would flip every default chat screen to an early return.
 * - Read-back parity is structural: the async run produces the
 *   identical run record (same command, same bridge row), so it
 *   is readable through the same surfaces as the sync run
 *   (Workflow Runs, D1 collation). `get_job_status` does NOT
 *   resolve a screen run's id in either leg, so no read-tool
 *   change is made and none is claimed.
 * - Refusal parity is free by construction (provider + preset
 *   checks run before the async branch) and is pinned here,
 *   not built twice.
 *
 * Deliberately NOT covered here: the #4136 loop
 * execution-mode config (a different axis), and any change to
 * the sync leg's behaviour.
 */
import { describe, expect, it } from "vitest";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  runStockScreenViaDoor,
  type MeshScreenDoorContext,
} from "../src/agents/orchestrator/meshScreenDoor";
import { RunStockScreenCommand } from "../src/mcps/openaimp/meshDoorCommands";
import { workflowRunUrl } from "../src/services/providerUxLinks";
import type { WorkflowJobCommand, WorkflowPort } from "../src/workflows/workflowPorts";
import { MockSqlStorage } from "./mock-sql";

const LOGIN = "alice";
const PAID_EMAIL = "alice@example.com";
const PAID_TENANT = "test-tenant";

function seedPreset(
  sql: MockSqlStorage,
  row: { id: string; userLogin: string; assetClass: string; criteriaJson: string },
): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS mas_screener_presets (id TEXT, user_login TEXT, asset_class TEXT, criteria_json TEXT)",
  );
  sql.exec(
    "INSERT INTO mas_screener_presets (id, user_login, asset_class, criteria_json) VALUES (?, ?, ?, ?)",
    row.id,
    row.userLogin,
    row.assetClass,
    row.criteriaJson,
  );
}

interface DoorHarness {
  started: WorkflowJobCommand[];
  historyCalls: { count: number };
  statusCalls: { count: number };
  ctx: MeshScreenDoorContext;
}

function makeDoorHarness(env: Record<string, unknown>, sql: MockSqlStorage): DoorHarness {
  const started: WorkflowJobCommand[] = [];
  const historyCalls = { count: 0 };
  const statusCalls = { count: 0 };
  const port: WorkflowPort = {
    start: async (command) => {
      started.push(command);
      return {
        workflowId: `screen-${command.jobId}`,
        jobId: command.jobId,
        status: "running",
        existing: false,
        statusUrl: `/api/jobs/history?chainId=${encodeURIComponent(command.jobId)}`,
      };
    },
    status: async () => {
      statusCalls.count += 1;
      return { status: "complete" };
    },
  };
  const ctx: MeshScreenDoorContext = {
    env: env as MeshScreenDoorContext["env"],
    ensureTables: () => sql as never,
    workflowPort: port,
    readWorkflowJobHistory: async (_tenantId, chainId) => {
      historyCalls.count += 1;
      return [
        {
          jobKey: chainId,
          resultJson: JSON.stringify({
            jobId: chainId,
            workflowId: `screen-${chainId}`,
            lifecycle: "Failed",
            qualified: false,
            coverage: { evaluated: 0, considered: 0, ratio: null },
            shards: [],
            lifecycleTransitions: [],
            stageTransitions: [],
            reportKeys: [],
            storedShards: [],
            deliveredShards: [],
            error: "test collation",
          }),
        } as never,
      ];
    },
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 5_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
  };
  return { started, historyCalls, statusCalls, ctx };
}

function bridgeRows(sql: MockSqlStorage, jobId: string): Array<Record<string, unknown>> {
  return Array.from(
    sql.exec("SELECT * FROM mas_async_jobs WHERE job_id = ?", jobId),
  ) as Array<Record<string, unknown>>;
}

describe("issue #5921 — async early return (free path)", () => {
  it("returns promptly with the run id and status link — no await, one start", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({}, sql);
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, {
      executionMode: { delivery: "async" },
    });
    expect(h.started).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.jobId).toBe(h.started[0].jobId);
    expect(result.jobId).toMatch(/^screener:chat:NASDAQ100:/);
    expect(result.statusUrl).toBe(workflowRunUrl(result.jobId!));
    expect(result.statusUrl).toBe(
      `?tab=workflow-runs&run=${encodeURIComponent(result.jobId!)}`,
    );
    expect(result.matchedCount).toBe(0);
    expect(result.totalScanned).toBe(0);
    expect(result.allStocks).toEqual([]);
    expect(result.opportunities).toEqual([]);
    expect(result.discoveryMessage).toContain(result.jobId!);
    // No await happened: neither the history read nor the
    // workflow status was ever polled.
    expect(h.historyCalls.count).toBe(0);
    expect(h.statusCalls.count).toBe(0);
  });
});

describe("issue #5921 — read-back parity: the async run's record is the sync run's record", () => {
  it("starts the identical command (provider, mode, presetRef, triggers, job id scheme) and leaves a running bridge row", async () => {
    const sql = new MockSqlStorage();
    seedPreset(sql, {
      id: "p1",
      userLogin: LOGIN,
      assetClass: "stocks",
      criteriaJson: JSON.stringify({ minRsi: 30 }),
    });
    const h = makeDoorHarness({}, sql);
    h.ctx.asyncJobSessionId = "owner-login-1";
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, {
      presetId: "p1",
      executionMode: { delivery: "async" },
    });
    expect(h.started).toHaveLength(1);
    const started = h.started[0];
    expect(result.jobId).toBe(started.jobId);
    expect(started.provider).toBe("alpaca");
    expect(started.executionMode).toMatchObject({ delivery: "async" });
    expect(started.presetRef).toMatchObject({ presetId: "p1" });
    expect(started.specTrigger).toBe("mesh");
    expect(started.trigger).toBe("manual");
    expect(started.jobId).toMatch(/^screener:chat:NASDAQ100:/);
    // The bridge row was started BEFORE the early return and
    // is never settled on it — the still-running run keeps its
    // `running` row for the #3784 sweep.
    const rows = bridgeRows(sql, started.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
  });
});

describe("issue #5921 — refusal parity: async refuses coded before any start", () => {
  it("provider-less async refuses with [FAILURE_NO_SCREENING_PROVIDER] — zero starts", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({ TENANT_DATA_PROVIDER_ID: "nasdaq" }, sql);
    const err = await runStockScreenViaDoor(h.ctx, LOGIN, {
      executionMode: { delivery: "async" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect((err as MeshDoorError).message).toContain("[FAILURE_NO_SCREENING_PROVIDER]");
    expect((err as MeshDoorError).message).toMatch(/No workflow was started/);
    expect(h.started).toHaveLength(0);
  });

  it("missing-preset async refuses preset_not_found — zero starts", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({}, sql);
    await expect(
      runStockScreenViaDoor(h.ctx, LOGIN, {
        presetId: "nope",
        executionMode: { delivery: "async" },
      }),
    ).rejects.toMatchObject({ code: "preset_not_found" });
    expect(h.started).toHaveLength(0);
  });
});

describe("issue #5921 — sync leg unchanged: explicit sync and the family default still await", () => {
  it("explicit delivery:\"sync\" awaits the Failed collation result (no run id, no status link)", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({}, sql);
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, {
      executionMode: { delivery: "sync" },
    });
    expect(h.started).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe("test collation");
    expect(result.jobId).toBeUndefined();
    expect(result.statusUrl).toBeUndefined();
    expect(h.historyCalls.count).toBeGreaterThanOrEqual(1);
  });

  it("family default (no executionMode) awaits identically — the async default does not early-return", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({}, sql);
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, {});
    expect(h.started).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe("test collation");
    expect(result.jobId).toBeUndefined();
    expect(result.statusUrl).toBeUndefined();
    expect(h.historyCalls.count).toBeGreaterThanOrEqual(1);
  });
});

describe("issue #5921 — paid async: receipt after the payment submission, no await", () => {
  it("submits one payment run, returns the receipt with the in-turn source, and never awaits", async () => {
    const sql = new MockSqlStorage();
    const paymentCreates: string[] = [];
    const h = makeDoorHarness({ IAAA_TENANT_ID: PAID_TENANT }, sql);
    h.ctx.asyncJobSessionId = "owner-login-1";
    h.ctx.monetizationOn = async () => true;
    h.ctx.paidScreenPriceUSD = async () => 5;
    h.ctx.paidBudgetCheck = async () => ({ allowed: true });
    h.ctx.paidScreenStores = {
      commercial: {
        getAccount: async (userId: string) => ({
          id: userId,
          tenantId: PAID_TENANT,
          tier: "Subscribed" as const,
          tierSource: "operator" as const,
          creditsUSD: 0,
          includedRuns: 1,
          updatedAtMs: Date.now(),
        }),
      } as never,
      subscriptions: {
        listSubscriptions: async () => [],
      } as never,
    };
    h.ctx.paymentWorkflowBinding = {
      create: async ({ id }: { id: string }) => {
        paymentCreates.push(id);
        return { id };
      },
    } as never;
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, {
      executionMode: { delivery: "async" },
      receiptEmail: PAID_EMAIL,
    });
    expect(paymentCreates).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.jobId).toBe(paymentCreates[0]);
    expect(result.jobId).toMatch(/^screener:chat:NASDAQ100:/);
    expect(result.statusUrl).toBe(workflowRunUrl(result.jobId!));
    expect(result.receiptEmailSource).toBe("in-turn");
    expect(result.matchedCount).toBe(0);
    expect(result.allStocks).toEqual([]);
    expect(h.historyCalls.count).toBe(0);
    expect(h.statusCalls.count).toBe(0);
    // The paid bridge row is started before the early return too.
    const rows = bridgeRows(sql, result.jobId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
  });
});

describe("issue #5921 — tool description names the async dispatch receipt", () => {
  it("RunStockScreenCommand describes the async receipt on the command and the delivery field", () => {
    const command = new RunStockScreenCommand();
    expect(command.description).toContain("dispatch receipt");
    expect(command.description).toContain('delivery:"async"');
    const props = (command.jsonSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.executionMode.description).toContain("online+sync is refused");
    expect(props.executionMode.description).toContain("delivery async returns promptly");
  });
});
