/**
 * Issue #2693 (#2494 Think adoption, screener slice 1) — observe-only
 * adoption of Think's code-declared scheduled tasks for the options
 * strategy-scan baseline.
 *
 * Pins:
 *  (a) declaration shape — OrchestratorAgent.getScheduledTasks()
 *      declares exactly one task, "options-strategy-scan-observe",
 *      schedule "every 1 hour", handler form (no prompt);
 *  (b) zero-dispatch — the handler records the occurrence and NEVER
 *      invokes the scan/dispatch path (autonomousOptionsAnalysis spy
 *      and the SDK schedule surface stay at zero calls);
 *  (c) context gating — instances without a stored screener execution
 *      context declare nothing;
 *  (d) the occurrence ledger is capped (newest-first, cap 50, the
 *      ScheduledAgent tickHistory pattern) and the audit record
 *      carries taskId / scheduledFor / occurrenceKey /
 *      idempotencyKey / firing phase.
 *
 * The existing "35 * * * *" SDK cron row keeps firing the real scan;
 * nothing in this suite touches it.
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

// The strategy_scan_schedule.test.ts idiom: mock the Agents SDK with
// a plain base class so the real module graph loads under Node;
// "@cloudflare/think" resolves to the test-only stub via vite.config.
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
import {
  STRATEGY_SCAN_OBSERVE_TASK_ID,
  STRATEGY_SCAN_OBSERVE_SCHEDULE,
  STRATEGY_SCAN_OBSERVE_LEDGER_KEY,
  STRATEGY_SCAN_OBSERVE_LEDGER_CAP,
  declareStrategyScanObserveTasks,
  recordStrategyScanObserveOccurrence,
  type ScheduledTasksObserveContext,
  type StrategyScanObserveOccurrence,
} from "../src/agents/orchestrator/scheduledTasksObserve";
import type { ThinkScheduledTaskContext } from "../src/actors/thinkAdapter";
import { MockSqlStorage } from "./mock-sql";

const EXECUTION_CONTEXT_KEY = "screener:execution-context";

// 2026-11-01T14:35:00.000Z — phase minute 35 on purpose: the observed
// phase is data this slice exists to collect, never an assumption.
const SCHEDULED_FOR = Date.UTC(2026, 10, 1, 14, 35, 0);

function taskCtx(overrides: Partial<ThinkScheduledTaskContext> = {}): ThinkScheduledTaskContext {
  return {
    taskId: STRATEGY_SCAN_OBSERVE_TASK_ID,
    scheduledFor: SCHEDULED_FOR,
    scheduledForDate: new Date(SCHEDULED_FOR),
    occurrenceKey: "occ-0001",
    idempotencyKey: "idem-0001",
    schedule: STRATEGY_SCAN_OBSERVE_SCHEDULE,
    scheduleKind: "interval",
    ...overrides,
  };
}

function makeModuleCtx(options: {
  executionContext?: { userLogin: string; environment?: "TEST" | "PROD" };
  seedLedger?: StrategyScanObserveOccurrence[];
} = {}) {
  const kv = new Map<string, unknown>();
  if (options.seedLedger) kv.set(STRATEGY_SCAN_OBSERVE_LEDGER_KEY, options.seedLedger);
  const audits: Array<[string, string, Record<string, unknown>]> = [];
  const ctx: ScheduledTasksObserveContext = {
    agentCtx: {
      storage: {
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
      },
    } as never,
    getScreenerExecutionContext: async () => options.executionContext,
    audit: (type, agent, payload) => {
      audits.push([type, agent, payload]);
    },
  };
  return { ctx, kv, audits };
}

describe("declareStrategyScanObserveTasks (#2693)", () => {
  it("(a) declares exactly one handler-form hourly task on screener-context instances", async () => {
    const { ctx } = makeModuleCtx({ executionContext: { userLogin: "venus", environment: "PROD" } });
    const tasks = await declareStrategyScanObserveTasks(ctx);
    expect(Object.keys(tasks)).toEqual([STRATEGY_SCAN_OBSERVE_TASK_ID]);
    const task = tasks[STRATEGY_SCAN_OBSERVE_TASK_ID];
    expect(task.schedule).toBe("every 1 hour");
    expect(STRATEGY_SCAN_OBSERVE_SCHEDULE).toBe("every 1 hour");
    expect(typeof task.handler).toBe("function");
    expect((task as { prompt?: unknown }).prompt).toBeUndefined();
  });

  it("(c) declares nothing on instances without a screener execution context", async () => {
    const { ctx } = makeModuleCtx({ executionContext: undefined });
    expect(await declareStrategyScanObserveTasks(ctx)).toEqual({});
  });

  it("reconcile idempotence: re-declaring yields the same declaration shape", async () => {
    const { ctx } = makeModuleCtx({ executionContext: { userLogin: "venus" } });
    const first = await declareStrategyScanObserveTasks(ctx);
    const second = await declareStrategyScanObserveTasks(ctx);
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(second[STRATEGY_SCAN_OBSERVE_TASK_ID].schedule).toBe(
      first[STRATEGY_SCAN_OBSERVE_TASK_ID].schedule,
    );
  });
});

describe("recordStrategyScanObserveOccurrence (#2693)", () => {
  it("(d) records the occurrence to the ledger and the audit surface with the four fields + phase", async () => {
    const { ctx, kv, audits } = makeModuleCtx({ executionContext: { userLogin: "venus" } });
    await recordStrategyScanObserveOccurrence(ctx, taskCtx());
    const ledger = kv.get(STRATEGY_SCAN_OBSERVE_LEDGER_KEY) as StrategyScanObserveOccurrence[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      taskId: STRATEGY_SCAN_OBSERVE_TASK_ID,
      scheduledFor: SCHEDULED_FOR,
      occurrenceKey: "occ-0001",
      idempotencyKey: "idem-0001",
      phaseMinuteUtc: 35,
    });
    expect(audits).toHaveLength(1);
    const [type, agent, payload] = audits[0];
    expect(type).toBe("schedule.observe_occurrence");
    expect(agent).toBe("orchestrator");
    expect(payload).toMatchObject({
      taskId: STRATEGY_SCAN_OBSERVE_TASK_ID,
      scheduledFor: SCHEDULED_FOR,
      occurrenceKey: "occ-0001",
      idempotencyKey: "idem-0001",
      phaseMinuteUtc: 35,
      userLogin: "venus",
    });
  });

  it("(d) caps the ledger at the cap, newest first, dropping the oldest", async () => {
    const seed: StrategyScanObserveOccurrence[] = Array.from(
      { length: STRATEGY_SCAN_OBSERVE_LEDGER_CAP },
      (_, i) => ({
        taskId: STRATEGY_SCAN_OBSERVE_TASK_ID,
        scheduledFor: SCHEDULED_FOR - (i + 1) * 3_600_000,
        occurrenceKey: `occ-seed-${i}`,
        idempotencyKey: `idem-seed-${i}`,
        phaseMinuteUtc: 35,
        recordedAt: "2026-11-01T00:00:00.000Z",
      }),
    );
    const { ctx, kv } = makeModuleCtx({ seedLedger: seed });
    await recordStrategyScanObserveOccurrence(ctx, taskCtx({ occurrenceKey: "occ-new" }));
    const ledger = kv.get(STRATEGY_SCAN_OBSERVE_LEDGER_KEY) as StrategyScanObserveOccurrence[];
    expect(STRATEGY_SCAN_OBSERVE_LEDGER_CAP).toBe(50);
    expect(ledger).toHaveLength(STRATEGY_SCAN_OBSERVE_LEDGER_CAP);
    expect(ledger[0].occurrenceKey).toBe("occ-new");
    expect(ledger[ledger.length - 1].occurrenceKey).toBe(
      `occ-seed-${STRATEGY_SCAN_OBSERVE_LEDGER_CAP - 2}`,
    );
  });

  it("(b) the declared handler records and never dispatches", async () => {
    const { ctx, kv, audits } = makeModuleCtx({ executionContext: { userLogin: "venus" } });
    const dispatch = vi.fn();
    (ctx as unknown as Record<string, unknown>).autonomousOptionsAnalysis = dispatch;
    const tasks = await declareStrategyScanObserveTasks(ctx);
    const task = tasks[STRATEGY_SCAN_OBSERVE_TASK_ID];
    if (!("handler" in task) || typeof task.handler !== "function") {
      throw new Error("expected handler-form task");
    }
    await task.handler(taskCtx());
    expect(dispatch).not.toHaveBeenCalled();
    expect(kv.get(STRATEGY_SCAN_OBSERVE_LEDGER_KEY)).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});

describe("OrchestratorAgent.getScheduledTasks (#2693 wiring)", () => {
  let kv: Map<string, unknown>;
  let agent: any;
  let audits: Array<[string, string, Record<string, unknown>]>;

  beforeEach(() => {
    kv = new Map<string, unknown>();
    audits = [];
    agent = Object.create(OrchestratorAgent.prototype);
    agent.ctx = {
      storage: {
        sql: new MockSqlStorage(),
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
      },
      id: { toString: () => "think-scheduled-tasks-observe-test" },
    };
    agent.env = {};
    agent.listSchedules = async () => [];
    agent.schedule = vi.fn(async () => ({ id: "mock-schedule" }));
    agent.scheduleEvery = vi.fn(async () => ({ id: "mock-schedule" }));
    agent.audit = (type: string, agentName: string, payload: Record<string, unknown>) => {
      audits.push([type, agentName, payload]);
    };
    agent.autonomousOptionsAnalysis = vi.fn(async () => undefined);
  });

  it("(a)+(c) declares the observe task only when the instance holds a screener execution context", async () => {
    expect(await agent.getScheduledTasks()).toEqual({});
    kv.set(EXECUTION_CONTEXT_KEY, { userLogin: "venus", environment: "PROD" });
    const tasks = await agent.getScheduledTasks();
    expect(Object.keys(tasks)).toEqual([STRATEGY_SCAN_OBSERVE_TASK_ID]);
    expect(tasks[STRATEGY_SCAN_OBSERVE_TASK_ID].schedule).toBe("every 1 hour");
    expect(typeof tasks[STRATEGY_SCAN_OBSERVE_TASK_ID].handler).toBe("function");
  });

  it("(b) the class-declared handler records the occurrence and never dispatches the scan", async () => {
    kv.set(EXECUTION_CONTEXT_KEY, { userLogin: "venus", environment: "PROD" });
    const tasks = await agent.getScheduledTasks();
    await tasks[STRATEGY_SCAN_OBSERVE_TASK_ID].handler(taskCtx());
    expect(agent.autonomousOptionsAnalysis).not.toHaveBeenCalled();
    expect(agent.schedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    const ledger = kv.get(STRATEGY_SCAN_OBSERVE_LEDGER_KEY) as StrategyScanObserveOccurrence[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      taskId: STRATEGY_SCAN_OBSERVE_TASK_ID,
      occurrenceKey: "occ-0001",
      idempotencyKey: "idem-0001",
      phaseMinuteUtc: 35,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0][0]).toBe("schedule.observe_occurrence");
    expect(audits[0][2]).toMatchObject({ userLogin: "venus", occurrenceKey: "occ-0001" });
  });
});
