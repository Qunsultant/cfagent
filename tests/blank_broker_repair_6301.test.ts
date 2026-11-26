/**
 * Issue #6301 — the blank-broker repair sweep.
 *
 * Pins:
 * - A blank system-owned strategy-scan baseline is re-stamped on the
 *   maintenance path (create the stamped alarm first, cancel the
 *   blank one after, swap the unified record, audit old → new id).
 * - A blank baseline is cancelled outright when a stamped baseline
 *   already exists (it is redundant).
 * - A blank schedule on any other broker-targeted callback is found
 *   + audited but NOT re-stamped (its id is user-facing; the
 *   fire-time fallback covers its firing).
 * - A blank baseline is left alone (found + audited) when its binding
 *   cannot resolve, when its record is paused, or when it has no cron.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { repairBlankBrokerSchedules } from "../src/agents/orchestrator/scheduleMaintenance";
import { MockSqlStorage } from "./mock-sql";
import { resolveScreenSelection } from "../src/services/providerConnections";
import { resolveTenantProviders } from "../src/services/tenantProviders";
import { resolveValidatedExecutionAccountContext } from "../src/services/accountBindings";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { MockD1Database } from "./mock-d1";
import { strategyScanBaselineToRecord } from "../src/services/unifiedScheduleManagement";

vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/providerConnections")>();
  return { ...actual, resolveScreenSelection: vi.fn() };
});
vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantProviders: vi.fn() };
});
vi.mock("../src/services/accountBindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/accountBindings")>();
  return { ...actual, resolveValidatedExecutionAccountContext: vi.fn() };
});

const mockedResolveScreenSelection = vi.mocked(resolveScreenSelection);
const mockedResolveTenantProviders = vi.mocked(resolveTenantProviders);
const mockedResolveValidatedExecutionAccountContext = vi.mocked(
  resolveValidatedExecutionAccountContext,
);

let scheduleCalls: any[];
let cancelCalls: string[];
let existing: any[];
let audits: any[];
let sql: MockSqlStorage;
let agent: any;

function maintenanceCtx(): any {
  return {
    agentCtx: agent.ctx,
    env: agent.env,
    listSchedules: () => agent.listSchedules(),
    cancelSchedule: (id: string) => agent.cancelSchedule(id),
    schedule: (when: any, callback: string, payload: any, options: any) =>
      agent.schedule(when, callback, payload, options),
    audit: (type: string, agentName: string, payload: any) => agent.audit(type, agentName, payload),
    screenerExecutionContextKey: "test-screener-context",
    legacyScheduleMigrationKey: "test-legacy-migration",
    strategyScanCron: "35 * * * *",
  };
}

// #6503 — the maintenance path reads the unified store from D1
// (unifiedScheduleStore in scheduleMaintenance.ts resolves the D1
// store from env.AGENT_DB, null when unbound); the old DO sync
// store this helper wrapped is retired.
function unifiedStore() {
  return createD1UnifiedSchedulePorts({ d1: agent.env.AGENT_DB as never }).unifiedSchedules;
}

function blankBaseline(id = "TTvDxrpaP") {
  return {
    id,
    callback: "autonomousOptionsAnalysis",
    payload: { userLogin: "venus" },
    cron: "35 * * * *",
  };
}

beforeEach(() => {
  scheduleCalls = [];
  cancelCalls = [];
  existing = [];
  audits = [];
  sql = new MockSqlStorage();
  agent = Object.create(OrchestratorAgent.prototype);
  agent.ctx = { storage: { sql }, id: { toString: () => "blank-broker-repair-test" } };
  // #6503 — the repair/adopt path resolves the D1 unified store
  // from env.AGENT_DB (best-effort null when unbound).
  agent.env = { AGENT_DB: new MockD1Database() };
  agent.listSchedules = async () => existing;
  agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
    scheduleCalls.push([when, callback, payload, options]);
    const created = { id: "scan-1", callback, payload, cron: typeof when === "string" ? when : undefined };
    existing.push(created);
    return created;
  };
  agent.cancelSchedule = async (id: string) => {
    cancelCalls.push(id);
    existing = existing.filter((s: any) => s.id !== id);
    return true;
  };
  agent.audit = (type: string, agentName: string, payload: any) => {
    audits.push([type, agentName, payload]);
  };
  mockedResolveScreenSelection.mockResolvedValue({
    resolved: true,
    selection: {
      connectionId: "conn-test",
      brokerId: "alpaca",
      environment: "TEST",
      mode: "paper",
      externalAccountId: "ext-test",
    },
  });
  mockedResolveTenantProviders.mockResolvedValue({ brokerId: "alpaca", dataProviderId: "alpaca" });
  mockedResolveValidatedExecutionAccountContext.mockResolvedValue({
    ok: true,
    context: {
      broker: "alpaca",
      mode: "paper",
      accountType: "options",
      accountId: "acct-venus-1",
      scope: "schedule",
      source: "binding",
    },
  } as never);
});

describe("repairBlankBrokerSchedules (#6301)", () => {
  it("re-stamps a blank baseline: stamped alarm first, blank cancelled after, record swapped", async () => {
    existing = [blankBaseline()];
    // The pre-repair unified record (as the adopt path would have saved it).
    await unifiedStore().save(
      strategyScanBaselineToRecord(
        { id: "TTvDxrpaP", callback: "autonomousOptionsAnalysis", payload: { userLogin: "venus" } },
        { userLogin: "venus", cron: "35 * * * *" },
        new Date().toISOString(),
      ),
    );
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });

    expect(scheduleCalls).toHaveLength(1);
    const [when, callback, payload] = scheduleCalls[0];
    expect(when).toBe("35 * * * *");
    expect(callback).toBe("autonomousOptionsAnalysis");
    expect(payload.brokerId).toBe("alpaca");
    expect(payload.mode).toBe("paper");
    expect(payload.accountType).toBe("options");
    expect(payload.accountId).toBe("acct-venus-1");
    expect(payload.userLogin).toBe("venus");
    expect(cancelCalls).toEqual(["TTvDxrpaP"]);
    expect(audits).toContainEqual([
      "schedule.blank_broker_repaired",
      "orchestrator",
      expect.objectContaining({ scheduleId: "TTvDxrpaP", newScheduleId: "scan-1", brokerId: "alpaca", mode: "paper" }),
    ]);
    expect(await unifiedStore().get("TTvDxrpaP")).toBeUndefined();
    const newRecord = await unifiedStore().get("scan-1");
    expect(newRecord).toBeDefined();
    expect((newRecord as any).definition.payload.brokerId).toBe("alpaca");
  });

  it("cancels a blank baseline outright when a stamped baseline already exists", async () => {
    existing = [
      blankBaseline(),
      {
        id: "stamped-1",
        callback: "autonomousOptionsAnalysis",
        payload: { userLogin: "venus", brokerId: "alpaca", mode: "paper", accountType: "options", accountId: "acct-venus-1" },
        cron: "35 * * * *",
      },
    ];
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });

    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toEqual(["TTvDxrpaP"]);
    expect(audits).toContainEqual([
      "schedule.blank_broker_removed",
      "orchestrator",
      expect.objectContaining({ scheduleId: "TTvDxrpaP" }),
    ]);
  });

  it("finds but does not re-stamp a blank schedule on another broker-targeted callback", async () => {
    existing = [
      {
        id: "ms-1",
        callback: "autonomousMarketScreen",
        payload: { userLogin: "venus" },
        cron: "0 9 * * 1-5",
      },
    ];
    await repairBlankBrokerSchedules(maintenanceCtx(), { userLogin: "venus" }, existing);

    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toHaveLength(0);
    expect(audits).toContainEqual([
      "schedule.blank_broker_found",
      "orchestrator",
      expect.objectContaining({ scheduleId: "ms-1", callback: "autonomousMarketScreen" }),
    ]);
  });

  it("leaves a blank baseline alone when its binding cannot resolve", async () => {
    mockedResolveValidatedExecutionAccountContext.mockResolvedValue({
      ok: false,
      code: "FAILURE_ACCOUNT_BINDING_MISSING",
      error: "[FAILURE_ACCOUNT_BINDING_MISSING] No binding found.",
      status: 404,
    } as never);
    existing = [blankBaseline()];
    await repairBlankBrokerSchedules(maintenanceCtx(), { userLogin: "venus" }, existing);

    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toHaveLength(0);
    expect(audits).toContainEqual([
      "schedule.blank_broker_found",
      "orchestrator",
      expect.objectContaining({ scheduleId: "TTvDxrpaP", callback: "autonomousOptionsAnalysis" }),
    ]);
  });

  it("never silently re-arms a blank baseline whose record is paused", async () => {
    existing = [blankBaseline()];
    const record = strategyScanBaselineToRecord(
      { id: "TTvDxrpaP", callback: "autonomousOptionsAnalysis", payload: { userLogin: "venus" } },
      { userLogin: "venus", cron: "35 * * * *" },
      new Date().toISOString(),
    );
    await unifiedStore().save({ ...record, state: "paused" });
    await repairBlankBrokerSchedules(maintenanceCtx(), { userLogin: "venus" }, existing);

    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toHaveLength(0);
    expect(audits).toContainEqual([
      "schedule.blank_broker_found",
      "orchestrator",
      expect.objectContaining({ scheduleId: "TTvDxrpaP" }),
    ]);
  });

  it("leaves a blank baseline without a cron alone (cannot re-arm without its cadence)", async () => {
    existing = [{ id: "TTvDxrpaP", callback: "autonomousOptionsAnalysis", payload: { userLogin: "venus" } }];
    await repairBlankBrokerSchedules(maintenanceCtx(), { userLogin: "venus" }, existing);

    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toHaveLength(0);
    expect(audits).toContainEqual([
      "schedule.blank_broker_found",
      "orchestrator",
      expect.objectContaining({ scheduleId: "TTvDxrpaP" }),
    ]);
  });
});
