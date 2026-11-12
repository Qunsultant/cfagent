import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  planNLQ,
  executeNLQQueryAsync,
  executeNaturalLanguageQuery,
  type NLQPlan,
  type NLQSchedulingPort,
} from "../src/agents/nlq";
import type { AgentScheduleItem, Env } from "../src/types";

/**
 * Issue #109: NLQ scheduling actions must arm REAL Cloudflare Agents
 * schedules through the injected NLQSchedulingPort. These tests drive
 * the async executor with a fake port whose ids are unmistakably its
 * own (`fake-port-id-N`), proving the executor returns the port's id
 * verbatim and never mints a synthetic `sched_<type>_<ts>` id, and
 * that failures (no port, throwing port, unfulfillable plan) are
 * reported honestly instead of as fabricated success.
 */
class FakeSchedulingPort implements NLQSchedulingPort {
  items: AgentScheduleItem[] = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  failWith: Error | null = null;
  private seq = 0;

  private maybeFail(): void {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
  }

  async schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean }
  ): Promise<AgentScheduleItem> {
    this.calls.push({ method: "schedule", args: [when, callback, payload, options] });
    this.maybeFail();
    const nowSec = Math.floor(Date.now() / 1000);
    const item: AgentScheduleItem = {
      id: `fake-port-id-${++this.seq}`,
      callback,
      payload,
      type: typeof when === "number" ? "delayed" : typeof when === "string" ? "cron" : "scheduled",
      time:
        typeof when === "number"
          ? nowSec + when
          : typeof when === "string"
            ? nowSec + 3600
            : Math.floor(when.getTime() / 1000),
      ...(typeof when === "string" ? { cron: when } : {}),
      ...(typeof when === "number" ? { delayInSeconds: when } : {}),
    };
    this.items.push(item);
    return item;
  }

  async scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem> {
    this.calls.push({ method: "scheduleEvery", args: [intervalSeconds, callback, payload] });
    this.maybeFail();
    const item: AgentScheduleItem = {
      id: `fake-port-id-${++this.seq}`,
      callback,
      payload,
      type: "interval",
      intervalSeconds,
      time: Math.floor(Date.now() / 1000) + intervalSeconds,
    };
    this.items.push(item);
    return item;
  }

  async cancelSchedule(id: string): Promise<boolean> {
    this.calls.push({ method: "cancelSchedule", args: [id] });
    this.maybeFail();
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  async listSchedules(): Promise<AgentScheduleItem[]> {
    this.calls.push({ method: "listSchedules", args: [] });
    this.maybeFail();
    return [...this.items];
  }
}

function seedBaselineSchedules(port: FakeSchedulingPort): void {
  const nowSec = Math.floor(Date.now() / 1000);
  port.items.push(
    {
      id: "baseline-renew-id",
      callback: "autoRenewETradeTokens",
      type: "cron",
      cron: "0 3 * * *",
      time: nowSec + 3600,
      payload: { userLogin: "scheduler_test_trader" },
    },
    {
      id: "baseline-screen-id",
      callback: "autonomousMarketScreen",
      type: "interval",
      intervalSeconds: 300,
      time: nowSec + 300,
      payload: { sector: "Technology", maxItems: 5 },
    }
  );
}

describe("NLQ scheduling executes against the real scheduling port (issue #109)", () => {
  let orm: DatabaseORM;
  let env: Env;
  const sessionId = "scheduler_test_trader";

  beforeEach(() => {
    vi.restoreAllMocks();
    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
    } as Env;
  });

  it("creates a delayed reminder through schedule() and returns the port's real id", async () => {
    const port = new FakeSchedulingPort();
    const plan = await planNLQ(env, "remind me to check NVDA in 15 minutes");
    expect(plan.scheduleData?.scheduleType).toBe("delayed");
    expect(plan.scheduleData?.delayInSeconds).toBe(900);

    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    // The port received the right mode, callback, and payload contract
    // for sendScheduledReminder ({ reminderId, message, userLogin }).
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("schedule");
    expect(port.calls[0].args[0]).toBe(900);
    expect(port.calls[0].args[1]).toBe("sendScheduledReminder");
    const payload = port.calls[0].args[2] as Record<string, unknown>;
    expect(payload.message).toBe("check NVDA");
    expect(typeof payload.reminderId).toBe("string");
    expect((payload.reminderId as string).length).toBeGreaterThan(0);
    expect(payload.userLogin).toBe(sessionId);

    // The reply carries the port's real id — never a synthetic one.
    expect(result.domain).toBe("scheduling");
    expect(result.targetTable).toBe("cf_agent_schedules");
    expect(result.status).toBe("scheduled");
    expect(result.count).toBe(1);
    expect(result.rows[0].id).toBe("fake-port-id-1");
    expect(result.summary).toContain("fake-port-id-1");
    expect(result.rows[0].id).not.toMatch(/^sched_(delayed|scheduled|cron|interval)_/);
    expect(result.summary).not.toMatch(/sched_(delayed|scheduled|cron|interval)_/);

    // The audit event is stamped with the REAL schedule id.
    const created = orm.events.findMany({ where: { type: "schedule.created" } });
    expect(created).toHaveLength(1);
    // #2178 S1: stored payload is JSON text — parse the stored form.
    expect((JSON.parse(created[0].payload as unknown as string) as any)?.scheduleId).toBe("fake-port-id-1");
  });

  it("creates an interval market screen through scheduleEvery() with the schema-built payload", async () => {
    const port = new FakeSchedulingPort();
    const plan = await planNLQ(env, "schedule market screen every 5 minutes");
    expect(plan.scheduleData?.scheduleType).toBe("interval");

    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("scheduleEvery");
    expect(port.calls[0].args[0]).toBe(300);
    expect(port.calls[0].args[1]).toBe("autonomousMarketScreen");
    // Issue #959 ADAPTATION (disclosed): this pin previously expected
    // the NLQ port's hardcoded legacy payload {sector:"Technology",
    // maxItems:5} — a payload no user asked for, which #959 removes.
    // A criteria-less plan now arms only the shared builder's identity
    // stamps (buildSchedulePayload in src/trading/screeningSchemas.ts);
    // the market-screen service's own defaults apply at run time.
    // Issue #3122 — agent provenance rides every agent-armed schedule.
    const screenPayload = port.calls[0].args[2] as Record<string, unknown>;
    expect(screenPayload.userLogin).toBe(sessionId);
    expect(screenPayload.trigger).toBe("scheduled");
    expect(screenPayload.provenance).toMatchObject({
      origin: "agent",
      createdBy: sessionId,
      agentId: "nlq",
    });
    expect(typeof (screenPayload.provenance as Record<string, unknown>).createdAt).toBe("string");
    expect(result.status).toBe("scheduled");
    expect(result.rows[0].id).toBe("fake-port-id-1");
    expect(result.rows[0].type).toBe("interval");
  });

  it("creates a cron schedule through schedule() with the idempotent option", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "cron",
        cron: "30 13 * * 1-5",
        callback: "autonomousOptionsAnalysis",
        description: "Weekday options analysis",
      },
      terms: "",
      role: "any",
      since: null,
      limit: 1,
    };

    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("schedule");
    expect(port.calls[0].args[0]).toBe("30 13 * * 1-5");
    expect(port.calls[0].args[1]).toBe("autonomousOptionsAnalysis");
    expect(port.calls[0].args[3]).toEqual({ idempotent: true });
    expect(result.status).toBe("scheduled");
    expect(result.rows[0].type).toBe("cron");
    expect(result.rows[0].cron).toBe("30 13 * * 1-5");
  });

  it("creates a one-time scheduled entry through schedule() with a Date", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "scheduled",
        date: "2030-01-15T14:30:00.000Z",
        callback: "sendScheduledReminder",
        description: "review the plan",
      },
      terms: "",
      role: "any",
      since: null,
      limit: 1,
    };

    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("schedule");
    const when = port.calls[0].args[0];
    expect(when).toBeInstanceOf(Date);
    expect((when as Date).getTime()).toBe(Date.parse("2030-01-15T14:30:00.000Z"));
    expect(result.status).toBe("scheduled");
    expect(result.rows[0].type).toBe("scheduled");
  });

  it("fails honestly when a one-time schedule plan carries no date", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "scheduled",
        callback: "sendScheduledReminder",
        description: "review the plan",
      },
      terms: "",
      role: "any",
      since: null,
      limit: 1,
    };

    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    expect(port.calls).toHaveLength(0);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("NOT created");
    expect(result.summary).not.toContain("successfully");
    expect(orm.events.findMany({ where: { type: "schedule.created" } })).toHaveLength(0);
  });

  it("fails honestly when the port throws — no success claim, no audit event", async () => {
    const port = new FakeSchedulingPort();
    port.failWith = new Error("scheduler exploded");
    const plan = await planNLQ(env, "remind me to check AAPL in 10 minutes");

    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    expect(result.status).toBe("error");
    expect(result.count).toBe(0);
    expect(result.summary).toContain("NOT created");
    expect(result.summary).not.toContain("Task scheduled successfully");
    expect(orm.events.findMany({ where: { type: "schedule.created" } })).toHaveLength(0);
  });

  it("fails honestly when no scheduling port is wired", async () => {
    const plan = await planNLQ(env, "remind me to check AAPL in 10 minutes");

    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId);

    expect(result.status).toBe("error");
    expect(result.count).toBe(0);
    expect(result.summary).toContain("NOT executed");
    expect(result.summary).not.toContain("successfully");
    expect(orm.events.findMany({ where: { type: "schedule.created" } })).toHaveLength(0);
  });

  it("lists the port's real schedules — baselines included, phantoms gone", async () => {
    const port = new FakeSchedulingPort();
    seedBaselineSchedules(port);

    const createPlan = await planNLQ(env, "remind me to check NVDA in 15 minutes");
    await executeNLQQueryAsync(orm, sessionId, createPlan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    const listPlan = await planNLQ(env, "list all scheduled tasks");
    const result = await executeNLQQueryAsync(orm, sessionId, listPlan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    expect(port.calls.some((c) => c.method === "listSchedules")).toBe(true);
    expect(result.status).toBe("matches_found");
    expect(result.count).toBe(3);
    const byCallback = new Map(result.rows.map((r: any) => [r.callback, r]));
    expect(byCallback.get("autoRenewETradeTokens")?.id).toBe("baseline-renew-id");
    expect(byCallback.get("autoRenewETradeTokens")?.cron).toBe("0 3 * * *");
    expect(byCallback.get("autoRenewETradeTokens")?.status).toBe("ACTIVE");
    expect(byCallback.get("autonomousMarketScreen")?.intervalSeconds).toBe(300);
    expect(byCallback.get("sendScheduledReminder")?.description).toBe("check NVDA");
    // The old hardcoded phantom ids must never appear.
    expect(result.rows.some((r: any) => r.id === "sched_cron_etrade_renew")).toBe(false);
    expect(result.rows.some((r: any) => r.id === "sched_interval_market_screen")).toBe(false);
  });

  it("cancels by the real id, and reports not_found for unknown ids", async () => {
    const port = new FakeSchedulingPort();
    const createPlan = await planNLQ(env, "remind me to check NVDA in 15 minutes");
    const created = await executeNLQQueryAsync(orm, sessionId, createPlan, env, sessionId, undefined, {
      schedulingPort: port,
    });
    const realId = String(created.rows[0].id);
    expect(realId).toBe("fake-port-id-1");

    const cancelPlan = await planNLQ(env, `cancel schedule ${realId}`);
    const cancelResult = await executeNLQQueryAsync(orm, sessionId, cancelPlan, env, sessionId, undefined, {
      schedulingPort: port,
    });

    expect(port.calls.some((c) => c.method === "cancelSchedule" && c.args[0] === realId)).toBe(true);
    expect(cancelResult.status).toBe("cancelled");
    expect(cancelResult.summary).toContain(realId);
    expect(port.items).toHaveLength(0);
    const cancelEvents = orm.events.findMany({ where: { type: "schedule.cancelled" } });
    expect(cancelEvents).toHaveLength(1);
    expect((JSON.parse(cancelEvents[0].payload as unknown as string) as any)?.scheduleId).toBe(realId);

    const missingPlan = await planNLQ(env, "cancel schedule does-not-exist");
    const missingResult = await executeNLQQueryAsync(orm, sessionId, missingPlan, env, sessionId, undefined, {
      schedulingPort: port,
    });
    expect(missingResult.status).toBe("not_found");
    expect(missingResult.count).toBe(0);
    expect(missingResult.summary).toContain("not found");
    expect(missingResult.summary).not.toContain("cancelled successfully");
  });

  it("threads the schedulingPort through executeNaturalLanguageQuery end to end", async () => {
    const port = new FakeSchedulingPort();
    const { plan, result } = await executeNaturalLanguageQuery(
      orm,
      sessionId,
      "remind me to check NVDA in 15 minutes",
      env,
      sessionId,
      undefined,
      { schedulingPort: port }
    );

    expect(plan.domain).toBe("scheduling");
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("schedule");
    expect(result.rows[0].id).toBe("fake-port-id-1");
    expect(result.summary).toContain("fake-port-id-1");
  });
});

describe("NLQ scheduling F1 allow-list (issue #3122)", () => {
  let orm: DatabaseORM;
  let env: Env;
  const sessionId = "scheduler_test_trader";

  beforeEach(() => {
    vi.restoreAllMocks();
    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
    } as Env;
  });

  function createPlan(callback: string): NLQPlan {
    // Discovery needs a saved strategy request; goal screens need a
    // goalKind — the builder refuses criteria-less plans for those two
    // (pre-existing validation, not the F1 allow-list).
    const extra: Record<string, unknown> =
      callback === "autonomousStrategyDiscovery"
        ? {
            requests: [
              {
                symbol: "SPY",
                thesis: "bullish",
                targetPrice: 600,
                targetDate: "2026-12-18",
                expectedIvDirection: "rise",
                maxPlannedLoss: 500,
                minRewardRisk: 1.5,
                allowedStrategies: ["long_call"],
              },
            ],
          }
        : callback === "autonomousGoalScreen"
          ? { goalKind: "income" }
          : {};
    return {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "delayed",
        delayInSeconds: 60,
        callback,
        description: "F1 probe",
        ...extra,
      },
      terms: "",
      role: "any",
      since: null,
      limit: 1,
    };
  }

  it("3122-F1a refuses an internal-only callback honestly: nothing armed, no success claim", async () => {
    const port = new FakeSchedulingPort();
    for (const callback of ["executeAsyncJob", "autoRenewETradeTokens", "expireStaleOrderDraft", "collectIvHistory"]) {
      const result = await executeNLQQueryAsync(orm, sessionId, createPlan(callback), env, sessionId, undefined, {
        schedulingPort: port,
      });
      expect(result.status).toBe("error");
      expect(result.summary).toMatch(/not schedulable through NLQ/i);
      expect(result.summary).toMatch(/NOT created/);
    }
    expect(port.calls).toHaveLength(0);
    expect(port.items).toHaveLength(0);
    expect(orm.events.findMany({ where: { type: "schedule.created" } })).toHaveLength(0);
  });

  it("3122-F1b still arms the reminder and each creatable callback", async () => {
    const port = new FakeSchedulingPort();
    for (const callback of [
      "sendScheduledReminder",
      "autonomousMarketScreen",
      "autonomousOptionsAnalysis",
      "autonomousStrategyDiscovery",
      "autonomousGoalScreen",
    ]) {
      const result = await executeNLQQueryAsync(orm, sessionId, createPlan(callback), env, sessionId, undefined, {
        schedulingPort: port,
      });
      expect(result.status).toBe("scheduled");
    }
    expect(port.items).toHaveLength(5);
  });

  it("3122-F1c the plan schema rejects an unlisted callback at parse time", async () => {
    const { nlqPlanSchema } = await import("../src/agents/nlq/schema");
    const parsed = nlqPlanSchema.safeParse({
      domain: "scheduling",
      operation: "create",
      scheduleData: { action: "create", callback: "executeAsyncJob" },
      terms: "",
    });
    expect(parsed.success).toBe(false);
    const allowed = nlqPlanSchema.safeParse({
      domain: "scheduling",
      operation: "create",
      scheduleData: { action: "create", callback: "autonomousMarketScreen" },
      terms: "",
    });
    expect(allowed.success).toBe(true);
  });
});
