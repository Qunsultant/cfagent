/**
 * Issue #4236 — the strategy-scan baseline as a unified-store record.
 *
 * The baseline (autonomousOptionsAnalysis, NASDAQ100) arms via ctx.schedule
 * and is audited, but it has no unified-store record: the Schedules home
 * cannot name its system origin, and pause/resume only adopts a record on
 * first touch. After this slice, arming saves the record (origin
 * `strategy-scan-baseline`), an already-armed baseline is adopted into the
 * store without re-arming, and the armed payload carries the same system
 * provenance the home badges on.
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

// Issue #1738: OrchestratorAgent is an Agents SDK actor now — mock the SDK
// with a plain base class (the api_chat_route.test.ts idiom) so the real
// module graph's `cloudflare:` imports never reach the node loader.
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
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { MockD1Database } from "./mock-d1";
import {
  STRATEGY_SCAN_BASELINE_ORIGIN,
  strategyScanBaselineToRecord,
} from "../src/services/unifiedScheduleManagement";
import { MockSqlStorage } from "./mock-sql";
import { resolveScreenSelection } from "../src/services/providerConnections";
import { resolveTenantProviders } from "../src/services/tenantProviders";
import { resolveValidatedExecutionAccountContext } from "../src/services/accountBindings";

// Issue #5100 (F3 of #5094): the baseline arm resolves the tenant's
// broker selection + bound account and stamps the tuple — it never
// arms unstamped. Same stub as tests/strategy_scan_schedule.test.ts.
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

const NOW_ISO = "2026-11-18T10:30:00.000Z";
const BASELINE_PAYLOAD = {
  userLogin: "venus",
  environment: "PROD",
  universe: "NASDAQ100",
  maxItems: 100,
  trigger: "scheduled",
};

describe("strategyScanBaselineToRecord (#4236)", () => {
  it("builds a screen record with the system origin on the record and the payload", () => {
    const record = strategyScanBaselineToRecord(
      {
        id: "scan-1",
        callback: "autonomousOptionsAnalysis",
        payload: BASELINE_PAYLOAD,
      },
      { userLogin: "venus", environment: "PROD", cron: "35 * * * *" },
      NOW_ISO,
    );
    expect(record.id).toBe("scan-1");
    expect(record.kind).toBe("screen");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("autonomousOptionsAnalysis");
    expect(record.alarmId).toBe("scan-1");
    expect(record.ownerLogin).toBe("venus");
    expect(record.definition).toEqual({
      type: "cron",
      callback: "autonomousOptionsAnalysis",
      payload: {
        ...BASELINE_PAYLOAD,
        provenance: {
          origin: "system",
          createdBy: "system",
          reason: STRATEGY_SCAN_BASELINE_ORIGIN,
          createdAt: NOW_ISO,
        },
      },
      cron: "35 * * * *",
    });
    expect(record.provenance).toEqual({
      origin: "system",
      createdBy: "system",
      reason: STRATEGY_SCAN_BASELINE_ORIGIN,
      createdAt: NOW_ISO,
    });
    expect(record.createdAt).toBe(NOW_ISO);
    expect(record.updatedAt).toBe(NOW_ISO);
  });

  it("keeps an already-stamped payload provenance instead of restamping", () => {
    const stamped = {
      ...BASELINE_PAYLOAD,
      provenance: {
        origin: "system",
        createdBy: "system",
        reason: STRATEGY_SCAN_BASELINE_ORIGIN,
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    };
    const record = strategyScanBaselineToRecord(
      { id: "scan-1", callback: "autonomousOptionsAnalysis", payload: stamped },
      { userLogin: "venus", environment: "PROD", cron: "35 * * * *" },
      NOW_ISO,
    );
    expect(
      (record.definition.payload as { provenance: { createdAt: string } }).provenance.createdAt,
    ).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("ensureStrategyScanSchedule saves the baseline record (#4236)", () => {
  let scheduleCalls: any[];
  let existing: any[];
  let sql: MockSqlStorage;
  let agent: any;

  beforeEach(() => {
    scheduleCalls = [];
    existing = [];
    sql = new MockSqlStorage();
    agent = Object.create(OrchestratorAgent.prototype);
    agent.ctx = { storage: { sql }, id: { toString: () => "strategy-scan-test" } };
    // #6503 — the arm/adopt path saves the baseline record in the
    // D1 unified store (resolved from env.AGENT_DB); the DO store
    // this file used to read back from is retired.
    agent.env = { AGENT_DB: new MockD1Database() };
    agent.listSchedules = async () => existing;
    agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
      scheduleCalls.push([when, callback, payload, options]);
      return { id: "scan-1", callback, payload };
    };
    agent.audit = () => {};
    // Issue #5100 (F3 of #5094): the baseline arm's default — a resolved
    // Alpaca/paper selection with a bound options account, so the arm
    // stamps the tuple.
    vi.mocked(resolveScreenSelection).mockResolvedValue({
      resolved: true,
      selection: {
        connectionId: "conn-test",
        brokerId: "alpaca",
        environment: "TEST",
        mode: "paper",
        externalAccountId: "ext-test",
      },
    });
    vi.mocked(resolveTenantProviders).mockResolvedValue({ brokerId: "alpaca", dataProviderId: "alpaca" });
    vi.mocked(resolveValidatedExecutionAccountContext).mockResolvedValue({
      ok: true,
      context: {
        broker: "alpaca",
        mode: "paper",
        accountType: "options",
        accountId: "acct-venus-1",
        scope: "schedule",
        resolvedFromScope: "schedule",
        source: "binding",
      },
    });
  });

  /** The D1 unified store the arm/adopt path writes. */
  function d1Store() {
    return createD1UnifiedSchedulePorts({ d1: agent.env.AGENT_DB as never }).unifiedSchedules;
  }

  it("saves a screen record for the armed alarm, origin named", async () => {
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
    const store = d1Store();
    const record = await store.get("scan-1");
    expect(record).toBeDefined();
    expect(record?.kind).toBe("screen");
    expect(record?.state).toBe("active");
    expect(record?.callback).toBe("autonomousOptionsAnalysis");
    expect(record?.ownerLogin).toBe("venus");
    expect(record?.alarmId).toBe("scan-1");
    expect(record?.provenance).toEqual(
      expect.objectContaining({
        origin: "system",
        reason: STRATEGY_SCAN_BASELINE_ORIGIN,
      }),
    );
    // The armed payload carries the same provenance the home badges on.
    const armedPayload = scheduleCalls[0][2] as Record<string, unknown>;
    expect(armedPayload.provenance).toEqual(
      expect.objectContaining({
        origin: "system",
        reason: STRATEGY_SCAN_BASELINE_ORIGIN,
      }),
    );
    // The record is the list's record: the merged list shows it active.
    expect((await store.listByState("active")).some((r) => r.id === "scan-1")).toBe(true);
  });

  it("adopts an already-armed baseline into the store without re-arming", async () => {
    existing = [
      {
        id: "x",
        callback: "autonomousOptionsAnalysis",
        payload: { userLogin: "venus", environment: "PROD", universe: "NASDAQ100", trigger: "scheduled" },
      },
    ];
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    const store = d1Store();
    const record = await store.get("x");
    expect(record).toBeDefined();
    expect(record?.kind).toBe("screen");
    expect(record?.state).toBe("active");
    expect(record?.provenance).toEqual(
      expect.objectContaining({
        origin: "system",
        reason: STRATEGY_SCAN_BASELINE_ORIGIN,
      }),
    );
  });

  it("does not adopt a record that already exists (no duplicate save churn)", async () => {
    existing = [
      {
        id: "x",
        callback: "autonomousOptionsAnalysis",
        payload: { userLogin: "venus", environment: "PROD", universe: "NASDAQ100", trigger: "scheduled" },
      },
    ];
    const store = d1Store();
    await store.save({
      id: "x",
      kind: "screen",
      state: "active",
      callback: "autonomousOptionsAnalysis",
      definition: {
        type: "cron",
        callback: "autonomousOptionsAnalysis",
        payload: { userLogin: "venus" },
        cron: "35 * * * *",
      },
      alarmId: "x",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    expect((await store.get("x"))?.createdAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("a paused baseline still blocks re-arming and keeps its paused record", async () => {
    const store = d1Store();
    await store.save({
      id: "paused-scan",
      kind: "screen",
      state: "paused",
      callback: "autonomousOptionsAnalysis",
      definition: {
        type: "cron",
        callback: "autonomousOptionsAnalysis",
        payload: { userLogin: "venus", environment: "PROD", universe: "NASDAQ100", trigger: "scheduled" },
        cron: "35 * * * *",
      },
      alarmId: "paused-scan",
      pausedAt: "2026-10-20T16:00:00.000Z",
      createdAt: "2026-10-20T16:00:00.000Z",
      updatedAt: "2026-10-20T16:00:00.000Z",
    });
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    expect((await store.get("paused-scan"))?.state).toBe("paused");
  });

  it("arming still succeeds when the unified store is unavailable", async () => {
    // #6503 — the unavailable leg is an unbound AGENT_DB now (the
    // store resolves to null, best-effort); the throwing DO sql
    // below is the old shape of "unavailable" and no longer the
    // seam the arm reads.
    agent.env = {};
    agent.ctx = {
      storage: {
        sql: {
          exec: () => {
            throw new Error("paused store unavailable in this harness");
          },
        },
      },
      id: { toString: () => "strategy-scan-test" },
    };
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
  });
});
