/**
 * Issue #275 — the hourly full-catalog strategy scan is armed once per
 * authenticated user (cron 35 * * * *, staggered off the equity-screen
 * minutes), following the ensureStaleSweepSchedule pattern. It must
 * never double-arm, and it must respect a scan the user paused in the
 * Schedules tab (#273's unified store, state paused).
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

// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import { OrchestratorAgent, STRATEGY_SCAN_CRON } from "../src/agents/orchestrator";
import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import { MockSqlStorage } from "./mock-sql";
import { resolveScreenSelection } from "../src/services/providerConnections";
import { resolveTenantProviders } from "../src/services/tenantProviders";
import { resolveValidatedExecutionAccountContext } from "../src/services/accountBindings";

// Issue #5100 (F3 of #5094): the baseline arm resolves the tenant's
// broker selection + bound account and stamps the tuple on the armed
// payload — it never arms unstamped. Stub the three resolution
// functions (the real ones need a live commercial store + broker
// enumeration) so the arm path is exercisable here; the unbound case
// is pinned by the "does not arm" test below.
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
const mockedResolveValidatedExecutionAccountContext = vi.mocked(resolveValidatedExecutionAccountContext);

let scheduleCalls: any[];
let existing: any[];
let audits: any[];
let sql: MockSqlStorage;
let agent: any;

beforeEach(() => {
  scheduleCalls = [];
  existing = [];
  audits = [];
  sql = new MockSqlStorage();
  agent = Object.create(OrchestratorAgent.prototype);
  agent.ctx = { storage: { sql }, id: { toString: () => "strategy-scan-test" } };
  agent.env = {};
  agent.listSchedules = async () => existing;
  agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
    scheduleCalls.push([when, callback, payload, options]);
    return { id: "scan-1", callback, payload };
  };
  agent.audit = (type: string, agentName: string, payload: any) => {
    audits.push([type, agentName, payload]);
  };
  // Issue #5100 (F3 of #5094): the baseline arm's default — a resolved
  // Alpaca/paper selection with a bound options account, so the arm
  // stamps the tuple. Individual tests override per case.
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
      resolvedFromScope: "schedule",
      source: "binding",
    },
  });
});

describe("ensureStrategyScanSchedule (#275)", () => {
  it("the scan cron is hourly and staggered off the :05 equity-screen minute", () => {
    expect(STRATEGY_SCAN_CRON).toBe("35 * * * *");
  });

  it("arms the hourly full-catalog scan for an authenticated user", async () => {
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
    const [when, callback, payload] = scheduleCalls[0];
    expect(when).toBe("35 * * * *");
    expect(callback).toBe("autonomousOptionsAnalysis");
    // No allowedStrategies restriction: the full strategy catalog.
    // Consolidation C3 (#1277): the payload is now the shared
    // builder's record (buildSchedulePayload) — it adds the
    // creation-default maxItems stamp (the UNIVERSES NASDAQ100
    // default the options service applied itself at run time when
    // maxItems was absent, so the armed run is unchanged).
    expect(payload).toEqual({
      userLogin: "venus",
      environment: "PROD",
      universe: "NASDAQ100",
      maxItems: 100,
      trigger: "scheduled",
      // Issue #5100 (F3 of #5094): the baseline arm stamps the
      // resolved binding tuple on the armed payload.
      brokerId: "alpaca",
      dataProviderId: "alpaca",
      mode: "paper",
      accountType: "options",
      accountId: "acct-venus-1",
      // Issue #3121 #4236 — the armed payload carries the system
      // provenance the Schedules home badges on (createdAt is stamped
      // at arm time, so only the stable fields are asserted here).
      provenance: expect.objectContaining({
        origin: "system",
        createdBy: "system",
        reason: "strategy-scan-baseline",
      }),
    });
    expect(payload.allowedStrategies).toBeUndefined();
    expect(audits.some(([t]) => t === "schedule.created")).toBe(true);
  });

  it("does not double-arm when the user already has a scan schedule", async () => {
    existing = [
      { id: "x", callback: "autonomousOptionsAnalysis", payload: { userLogin: "venus" } },
    ];
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
  });

  it("arms for a different user even when someone else's scan exists", async () => {
    existing = [
      { id: "x", callback: "autonomousOptionsAnalysis", payload: { userLogin: "someone-else" } },
    ];
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
  });

  it("respects a paused scan (#273): a paused record blocks re-arming", async () => {
    const store = new SqlUnifiedScheduleStore(sql as any);
    store.save({
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
  });

  it("an unrelated paused job does not block arming", async () => {
    const store = new SqlUnifiedScheduleStore(sql as any);
    store.save({
      id: "paused-screen",
      kind: "screen",
      state: "paused",
      callback: "autonomousMarketScreen",
      definition: {
        type: "cron",
        callback: "autonomousMarketScreen",
        payload: { userLogin: "venus", universe: "SP500" },
        cron: "5 * * * *",
      },
      alarmId: "paused-screen",
      pausedAt: "2026-10-20T16:00:00.000Z",
      createdAt: "2026-10-20T16:00:00.000Z",
      updatedAt: "2026-10-20T16:00:00.000Z",
    });
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
  });

  it("does not arm when the bound account cannot be resolved (#5100)", async () => {
    // Issue #5100 (F3 of #5094): an unstamped baseline would be
    // refused at every fire, so the arm is skipped with a structured
    // warn instead of arming a schedule that can never run.
    mockedResolveValidatedExecutionAccountContext.mockResolvedValueOnce({
      ok: false,
      code: "FAILURE_ACCOUNT_BINDING_MISSING",
      error: "No account bound",
      status: 404,
    });
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
  });
});
