/**
 * Issue #4434 (S6/N5) — Copilot screen runnability: full runnability
 * surface on the chat tool.
 *
 * - Tool schema (meshDoorCommands.ts): run_stock_screen accepts
 *   presetId + screenMode/screenIntent (the door already validated
 *   the latter two fail-closed; the schema never exposed them).
 * - Door (meshScreenDoor.ts): presetId resolves via the existing
 *   resolvePresetFilter (user-scoped; missing/foreign refuses coded
 *   preset_not_found, never a silent unfiltered run; explicit
 *   filters win over the preset; presetRef is stamped on the run
 *   record). A tenant whose effective data provider is not a
 *   stock-screen provider refuses pre-start with the planner's
 *   coded FAILURE_NO_SCREENING_PROVIDER in the message — the MCP
 *   wire carries only the message text, so the code rides in it.
 * - Steering (stockCopilotPrompt.ts): the capabilities block
 *   offers run_stock_screen on every broker/mode in HITL mode, not
 *   only Alpaca/paper.
 *
 * Deliberately NOT covered here: the async dispatch leg (the
 * delivery:"async" axis is accepted and threaded, but the door
 * awaits unconditionally — follow-up sub-issue under #4148), the
 * #4136 loop execution-mode config, and the remaining ~23
 * StockScreenerFilter fields on the tool schema (out of scope for
 * this slice — the preset carries the full criteria instead).
 */
import { describe, expect, it } from "vitest";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  runStockScreenViaDoor,
  type MeshScreenDoorContext,
} from "../src/agents/orchestrator/meshScreenDoor";
import { RunStockScreenCommand } from "../src/mcps/openaimp/meshDoorCommands";
import {
  buildStockCopilotCapabilities,
  STOCK_COPILOT_CAPABILITIES,
} from "../src/agents/prompts/stockCopilotPrompt";
import { brokerCopilotCapability } from "../src/trading";
import type { WorkflowJobCommand, WorkflowPort } from "../src/workflows/workflowPorts";
import { MockSqlStorage } from "./mock-sql";

const LOGIN = "alice";

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
  ctx: MeshScreenDoorContext;
}

function makeDoorHarness(env: Record<string, unknown>, sql: MockSqlStorage): DoorHarness {
  const started: WorkflowJobCommand[] = [];
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
    status: async () => ({ status: "complete" }),
  };
  const ctx: MeshScreenDoorContext = {
    // Phase 3 (#6550): monetization is ON via
    // environment.config.json, so the door would fail closed on the
    // paid gate's missing stored price. These tests pin preset
    // resolution on the FREE path, not payment, so the paid gate
    // stays off.
    env: { MONETIZATION_ENABLED: "false", ...env } as MeshScreenDoorContext["env"],
    ensureTables: () => sql as never,
    workflowPort: port,
    readWorkflowJobHistory: async (_tenantId, chainId) => [
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
    ],
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 5_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
  };
  return { started, ctx };
}

describe("issue #4434 — run_stock_screen schema (presetId + screenMode/screenIntent)", () => {
  const command = new RunStockScreenCommand();

  it("accepts presetId, screenMode, and screenIntent alongside universe and filters", () => {
    const parsed = command.zodSchema.parse({
      universe: "NASDAQ100",
      filters: { maxRsi: 30 },
      presetId: "p1",
      screenMode: "non-deterministic",
      screenIntent: "oversold quality names",
    });
    expect(parsed.presetId).toBe("p1");
    expect(parsed.screenMode).toBe("non-deterministic");
    expect(parsed.screenIntent).toBe("oversold quality names");
  });

  it("exposes presetId, screenMode, and screenIntent on the JSON schema", () => {
    const props = (command.jsonSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toContain("presetId");
    expect(Object.keys(props).sort()).toContain("screenMode");
    expect(Object.keys(props).sort()).toContain("screenIntent");
  });

  it("refuses a blank presetId and an unknown screenMode at the schema", () => {
    expect(() => command.zodSchema.parse({ presetId: "" })).toThrow();
    expect(() => command.zodSchema.parse({ screenMode: "random" })).toThrow();
  });
});

describe("issue #4434 — door preset resolution (S6/N5)", () => {
  it("resolves the preset as the base filters, stamps presetRef, and carries the provider", async () => {
    const sql = new MockSqlStorage();
    seedPreset(sql, {
      id: "p1",
      userLogin: LOGIN,
      assetClass: "stocks",
      criteriaJson: JSON.stringify({ minRsi: 30, maxRsi: 70, sector: "Technology" }),
    });
    const h = makeDoorHarness({}, sql);
    await runStockScreenViaDoor(h.ctx, LOGIN, {
      presetId: "p1",
      filters: { maxRsi: 30 },
    });
    expect(h.started).toHaveLength(1);
    const started = h.started[0];
    expect(started.filters).toMatchObject({
      minRsi: 30,
      maxRsi: 30,
      sector: "Technology",
      universe: "NASDAQ100",
    });
    expect(started.presetRef).toMatchObject({ presetId: "p1" });
    expect(typeof (started.presetRef as { resolvedAt?: unknown } | undefined)?.resolvedAt).toBe(
      "string",
    );
    expect(started.provider).toBe("alpaca");
  });

  it("runs a preset-only screen on the preset's criteria with no explicit filters", async () => {
    const sql = new MockSqlStorage();
    seedPreset(sql, {
      id: "p1",
      userLogin: LOGIN,
      assetClass: "stocks",
      criteriaJson: JSON.stringify({ minRsi: 30, maxRsi: 70 }),
    });
    const h = makeDoorHarness({}, sql);
    await runStockScreenViaDoor(h.ctx, LOGIN, { presetId: "p1" });
    expect(h.started).toHaveLength(1);
    expect(h.started[0].filters).toMatchObject({ minRsi: 30, maxRsi: 70 });
    expect(h.started[0].presetRef).toMatchObject({ presetId: "p1" });
  });

  it("refuses a missing preset coded preset_not_found — zero starts, never unfiltered", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({}, sql);
    await expect(runStockScreenViaDoor(h.ctx, LOGIN, { presetId: "nope" })).rejects.toMatchObject({
      code: "preset_not_found",
    });
    expect(h.started).toHaveLength(0);
  });

  it("refuses another user's preset exactly like a missing one (no existence oracle)", async () => {
    const sql = new MockSqlStorage();
    seedPreset(sql, {
      id: "p1",
      userLogin: "bob",
      assetClass: "stocks",
      criteriaJson: JSON.stringify({ minRsi: 30 }),
    });
    const h = makeDoorHarness({}, sql);
    await expect(runStockScreenViaDoor(h.ctx, LOGIN, { presetId: "p1" })).rejects.toMatchObject({
      code: "preset_not_found",
    });
    expect(h.started).toHaveLength(0);
  });

  it("refuses an options preset on a stock screen — zero starts", async () => {
    const sql = new MockSqlStorage();
    seedPreset(sql, {
      id: "p2",
      userLogin: LOGIN,
      assetClass: "options",
      criteriaJson: JSON.stringify({ contractType: "CALL", minDelta: 0.2 }),
    });
    const h = makeDoorHarness({}, sql);
    const err = await runStockScreenViaDoor(h.ctx, LOGIN, { presetId: "p2" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MeshDoorError);
    expect((err as MeshDoorError).message).toMatch(/options preset/);
    expect(h.started).toHaveLength(0);
  });

  it("refuses unreadable preset criteria — zero starts", async () => {
    const sql = new MockSqlStorage();
    seedPreset(sql, {
      id: "p1",
      userLogin: LOGIN,
      assetClass: "stocks",
      criteriaJson: "{not json",
    });
    const h = makeDoorHarness({}, sql);
    await expect(runStockScreenViaDoor(h.ctx, LOGIN, { presetId: "p1" })).rejects.toThrow(
      /unreadable/,
    );
    expect(h.started).toHaveLength(0);
  });

  it("refuses a blank presetId — zero starts", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({}, sql);
    await expect(runStockScreenViaDoor(h.ctx, LOGIN, { presetId: "   " })).rejects.toMatchObject({
      code: "preset_not_found",
    });
    expect(h.started).toHaveLength(0);
  });
});

describe("issue #4434 — provider refusal surfaces coded to chat (S6/N5)", () => {
  it("refuses pre-start with [FAILURE_NO_SCREENING_PROVIDER] when the tenant's provider is not a screen provider", async () => {
    const sql = new MockSqlStorage();
    const h = makeDoorHarness({ TENANT_DATA_PROVIDER_ID: "nasdaq" }, sql);
    const err = await runStockScreenViaDoor(h.ctx, LOGIN, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect((err as MeshDoorError).message).toContain("[FAILURE_NO_SCREENING_PROVIDER]");
    expect((err as MeshDoorError).message).toMatch(/No workflow was started/);
    expect(h.started).toHaveLength(0);
  });
});

describe("issue #4434 — steering offers run_stock_screen on every broker/mode (S6/N5)", () => {
  it("names run_stock_screen in the capabilities block for a non-Alpaca broker in HITL mode", () => {
    const etrade = brokerCopilotCapability("etrade");
    const capabilities = buildStockCopilotCapabilities({
      brokerId: "etrade",
      brokerLabel: "E*TRADE",
      mode: "paper",
      environment: "TEST",
      tools: etrade.tools,
      bracketOrders: etrade.bracketOrders,
      percentBrackets: etrade.percentBrackets,
    });
    expect(capabilities).toContain("tool_openaimp_run_stock_screen");
  });

  it("keeps the Alpaca/paper capabilities block byte-identical", () => {
    const alpaca = brokerCopilotCapability("alpaca");
    expect(
      buildStockCopilotCapabilities({
        brokerId: "alpaca",
        brokerLabel: "Alpaca",
        mode: "paper",
        environment: "TEST",
        tools: alpaca.tools,
        bracketOrders: alpaca.bracketOrders,
        percentBrackets: alpaca.percentBrackets,
      }),
    ).toBe(STOCK_COPILOT_CAPABILITIES);
  });
});
