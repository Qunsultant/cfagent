import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { makeFakeSessionStore } from "./fake-session-store";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (the same pattern as
// tests/browser_and_slack_agents.test.ts); the scheduling methods the route
// uses are stubbed per-test on the instance, which is exactly the surface
// issue #111 governs.
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
import { OrchestratorAgent, CREATABLE_SCHEDULE_CALLBACKS } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";

/**
 * Issue #111 — POST /api/schedules/create must never fabricate success.
 *
 * Before #111 every mode branch fell back to a fabricated
 * `sched_mock_<ts>` id and returned success when the Agents SDK scheduling
 * method was missing, and any callback string was accepted, so the public
 * route could arm internal-only callbacks. These tests pin the honest
 * behaviour: an allow-list of user-creatable callbacks (HTTP 400 for
 * anything else), HTTP 503 {success:false, error} when scheduling is
 * unavailable or throws, and real SDK ids on success.
 *
 * Issue #108 converted the route to the typed Agents SDK API: the
 * scheduling methods are typed members of the Agent base class and
 * always exist, so the honest-failure path is exercised with stubs
 * that throw — the only way scheduling can fail at runtime.
 */
describe("POST /api/schedules/create (#111)", () => {
  let scheduleCalls: any[];
  let scheduleEveryCalls: any[];
  const authenticatedLogin = "screen_test_user";
  const storedTestTokens = JSON.stringify({
    accessToken: "test-access-token",
    accessTokenSecret: "test-access-token-secret",
    storedAt: new Date().toISOString(),
    environment: "TEST",
    userLogin: authenticatedLogin,
  });

  function makeAgent({ bound = true }: { bound?: boolean } = {}) {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => "schedules-create-route-test" },
    } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    // #604: tokens live in the SessionStore DO (ns "etrade"), not KV.
    const { namespace: sessionStoreNs, seed: seedSession } =
      makeFakeSessionStore();
    seedSession(
      "etrade",
      `etrade:token:TEST:${authenticatedLogin}`,
      storedTestTokens
    );
    if (bound) {
      // Issue #5100 (F3 of #5094): creation of an account-scoped
      // schedule refuses when the tenant has no binding, so the
      // success-path tests seed the bound E*TRADE paper account.
      // Seeded raw (the read path JSON-parses the stored array).
      seedSession(
        "account_bindings",
        `acctbind:v1:${authenticatedLogin}`,
        JSON.stringify([
          { broker: "etrade", mode: "paper", accountType: "stock", scope: "tenant", accountId: "ET-123" },
          { broker: "etrade", mode: "paper", accountType: "options", scope: "tenant", accountId: "ET-123" },
        ])
      );
    }
    agent.env = {
      APP_ENV: "TEST",
      SESSION_STORE: sessionStoreNs,
    } as any;
    agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
      scheduleCalls.push([when, callback, payload, options]);
      return { id: `real-schedule-${scheduleCalls.length}`, callback, payload };
    };
    agent.scheduleEvery = async (intervalSeconds: number, callback: string, payload: any) => {
      scheduleEveryCalls.push([intervalSeconds, callback, payload]);
      return { id: `real-interval-${scheduleEveryCalls.length}`, callback, payload };
    };
    return agent;
  }

  async function postCreate(agent: any, body: Record<string, unknown>) {
    const res = await agent.onRequest(
      new Request("https://agent.test/api/schedules/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": authenticatedLogin },
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  beforeEach(() => {
    scheduleCalls = [];
    scheduleEveryCalls = [];
  });

  it("exposes only the stock screen, options screen, discovery, and goal-screen callbacks", () => {
    // Issue #126 (PR-E) deliberately grew this allow-list by one:
    // autonomousStrategyDiscovery (scheduled re-runs of saved strategy
    // requests) is user-creatable through the same route. The pin's
    // purpose — no internal-only callback is creatable — is unchanged.
    // Consolidation C1 (#1201, epic #1151) deliberately grew it by one
    // more: autonomousGoalScreen (scheduled Phase 1 goal/scenario
    // screens through the unified stack) is user-creatable through the
    // same route, with its payload validated by buildSchedulePayload.
    // Issue #4366 deliberately grew it by one more: runPipelineJobSchedule
    // (a job defined from the externalized spec is schedulable through the
    // same store; the callback runs the job by id). The pin's purpose —
    // no internal-only callback is creatable — is unchanged.
    expect([...CREATABLE_SCHEDULE_CALLBACKS].sort()).toEqual(
      ["autonomousGoalScreen", "autonomousMarketScreen", "autonomousOptionsAnalysis", "autonomousStrategyDiscovery", "runPipelineJobSchedule"].sort()
    );
    // Internal-only callbacks are armed by the agent itself, never via the route.
    expect(CREATABLE_SCHEDULE_CALLBACKS as readonly string[]).not.toContain("executeAsyncJob");
    expect(CREATABLE_SCHEDULE_CALLBACKS as readonly string[]).not.toContain("expireStaleOrderDraft");
  });

  it("rejects an unknown callback with 400 and creates no schedule", async () => {
    const agent = makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 3 * * *",
      callback: "someMadeUpCallback",
      payload: {},
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain("someMadeUpCallback");
    expect(body.error).toContain("not allowed");
    expect(scheduleCalls).toHaveLength(0);
    expect(scheduleEveryCalls).toHaveLength(0);
  });

  it("preserves account-owned stock/options screens while retiring only legacy maintenance schedules", async () => {
    const agent = makeAgent();
    const stored = new Map<string, unknown>();
    agent.ctx.storage.get = async (key: string) => stored.get(key);
    agent.ctx.storage.put = async (key: string, value: unknown) => { stored.set(key, value); };
    const schedules = [
      { id: "legacy-stock-screen", callback: "autonomousMarketScreen", cron: "5 * * * *", payload: { userLogin: authenticatedLogin, trigger: "scheduled", universe: "NASDAQ100", maxItems: 100 } },
      { id: "legacy-options-screen", callback: "autonomousOptionsAnalysis", cron: "35 * * * *", payload: { userLogin: authenticatedLogin, trigger: "scheduled", pushToSlack: true } },
      { id: "legacy-token-renewal", callback: "autoRenewETradeTokens", payload: { userLogin: authenticatedLogin } },
      { id: "legacy-iv-collection", callback: "collectIvHistory", cron: "15 22 * * 1-5", payload: { userLogin: authenticatedLogin } },
    ];
    const cancelled = new Set<string>();
    agent.listSchedules = async () => schedules.filter((schedule) => !cancelled.has(schedule.id));
    agent.cancelSchedule = async (id: string) => { cancelled.add(id); return true; };

    const response = await agent.onRequest(new Request("https://agent.test/api/schedules", {
      headers: { "x-user-login": authenticatedLogin, "x-environment": "TEST" },
    }));
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    // Issue #3121 #4239 — the legacy token-renewal alarm stays retired
    // (it is not listed), but the derived token-renewal record IS listed:
    // the list appends the renewal row for the live heartbeat duty.
    // Issue #3121 #4240 — the derived retention record IS listed too:
    // the list appends the retention row after the renewal row.
    // Issue #3121 #4241 — the derived nightly research record IS listed too:
    // the list appends the nightly research row after the retention row.
    // Issue #3121 #4242 — the three derived sweep/watchdog records ARE listed too:
    // the list appends the sweep rows and the watchdog row after the research row.
    expect(body.schedules.map((schedule: any) => schedule.id)).toEqual(["legacy-stock-screen", "legacy-options-screen", "token-renewal", "retention", "nightly-research", "sweep-stale-ledger-tasks", "sweep-stale-async-jobs", "schedule-watchdog"]);
  });

  it.each(["executeAsyncJob", "expireStaleOrderDraft"])(
    "rejects the internal-only callback %s with 400 and creates no schedule",
    async (callback) => {
      const agent = makeAgent();
      const { status, body } = await postCreate(agent, {
        scheduleType: "interval",
        intervalSeconds: 300,
        callback,
        payload: {},
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain(callback);
      expect(scheduleCalls).toHaveLength(0);
      expect(scheduleEveryCalls).toHaveLength(0);
    }
  );

  it("accepts autonomousOptionsAnalysis on an interval via scheduleEvery", async () => {
    const agent = makeAgent();
    const payload = { symbols: ["NVDA"], thesis: "bullish" };
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      // Issue #4235 — a 3600s interval is sub-daily, so creation
      // carries the explicit per-schedule opt-in.
      subDailyOptIn: true,
      callback: "autonomousOptionsAnalysis",
      payload,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.schedule.id).toBe("real-interval-1");
    expect(scheduleEveryCalls).toEqual([[3600, "autonomousOptionsAnalysis", {
      ...payload,
      maxItems: 1,
      userLogin: authenticatedLogin,
      environment: "TEST",
      trigger: "scheduled",
      // Issue #3655 — the create route stamps broker + data provider
      // + mode server-side (TEST → paper; the data provider is the
      // platform default — alpaca since #3990 — for this fixture's
      // unbound store, the broker the fixture's etrade session).
      brokerId: "etrade",
      dataProviderId: "alpaca",
      mode: "paper",
      // Issue #5100 (F3 of #5094) — the bound account tuple is
      // stamped server-side; options analysis resolves the options
      // account, never the stock one.
      accountType: "options",
      accountId: "ET-123",
      // Issue #4235 — the recorded opt-in rides the stored payload.
      subDailyOptIn: true,
      // Issue #3121 S1 — creation provenance travels in the armed
      // payload; createdAt is minted at create time, pinned by shape.
      provenance: expect.objectContaining({
        origin: "user",
        createdBy: authenticatedLogin,
        createdAt: expect.any(String),
      }),
    }]]);
    expect(scheduleCalls).toHaveLength(0);
  });

  it("creates only account-scoped stock/options schedules across supported modes", async () => {
    const agent = makeAgent();

    const delayed = await postCreate(agent, {
      delayInSeconds: 900,
      callback: "autonomousOptionsAnalysis",
      payload: { symbols: ["NVDA"], thesis: "bullish" },
    });
    expect(delayed.status).toBe(200);
    expect(delayed.body.success).toBe(true);
    expect(scheduleCalls[0][0]).toBe(900);
    expect(scheduleCalls[0][1]).toBe("autonomousOptionsAnalysis");
    expect(scheduleCalls[0][2]).toMatchObject({ symbols: ["NVDA"], maxItems: 1, userLogin: authenticatedLogin, environment: "TEST", trigger: "scheduled" });

    const date = "2026-10-20T14:00:00.000Z";
    const scheduled = await postCreate(agent, {
      scheduleType: "scheduled",
      date,
      callback: "autonomousOptionsAnalysis",
      payload: { universe: "NASDAQ100", thesis: "bullish", maxItems: 100 },
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.success).toBe(true);
    expect(scheduleCalls[1][0]).toBeInstanceOf(Date);
    expect((scheduleCalls[1][0] as Date).toISOString()).toBe(date);
    expect(scheduleCalls[1][1]).toBe("autonomousOptionsAnalysis");

    const screen = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 300,
      // Issue #4235 — a 300s interval is sub-daily, so creation
      // carries the explicit per-schedule opt-in.
      subDailyOptIn: true,
      callback: "autonomousMarketScreen",
      payload: { sector: "Technology", universe: "LEV_ETF", maxItems: 29 },
    });
    expect(screen.status).toBe(200);
    expect(screen.body.success).toBe(true);
    expect(scheduleEveryCalls[0]).toEqual([300, "autonomousMarketScreen", {
      sector: "Technology", universe: "LEV_ETF", maxItems: 29,
      userLogin: authenticatedLogin, environment: "TEST", trigger: "scheduled",
      // Issue #3655 — broker + data provider + mode stamped
      // server-side at creation (see the interval test above).
      brokerId: "etrade",
      dataProviderId: "alpaca",
      mode: "paper",
      // Issue #5100 (F3 of #5094) — the bound account tuple is
      // stamped server-side; the market screen resolves the stock
      // account.
      accountType: "stock",
      accountId: "ET-123",
      // Issue #4235 — the recorded opt-in rides the stored payload.
      subDailyOptIn: true,
      // Issue #3121 S1 — creation provenance travels in the armed
      // payload; createdAt is minted at create time, pinned by shape.
      provenance: expect.objectContaining({
        origin: "user",
        createdBy: authenticatedLogin,
        createdAt: expect.any(String),
      }),
    }]);
  });

  it("preserves the cron idempotent opt-out (body.idempotent === false)", async () => {
    const agent = makeAgent();
    const { status } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 3 * * *",
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100", maxItems: 100 },
      idempotent: false,
    });
    expect(status).toBe(200);
    expect(scheduleCalls[0][3]).toEqual({ idempotent: false });
  });

  it.each([
    // Issue #4235 — the interval case is sub-daily, so it carries
    // the explicit opt-in: the 503 under test comes from the SDK
    // throwing, not from validation.
    ["interval", { scheduleType: "interval", intervalSeconds: 3600, subDailyOptIn: true }],
    ["cron", { scheduleType: "cron", cron: "0 3 * * *" }],
    ["scheduled", { scheduleType: "scheduled", date: "2026-10-20T14:00:00.000Z" }],
    ["delayed", { delayInSeconds: 60 }],
  ])(
    "returns an honest 503 with no fabricated id when the SDK scheduling call is unavailable (%s mode)",
    async (_mode, fields) => {
      // Issue #108: the route calls the typed Agents SDK API directly —
      // schedule/scheduleEvery are typed members of the Agent base class
      // and always exist, so a missing-method state can no longer occur
      // (the #111 simulation deleted the methods; that state is now
      // impossible). "Unavailable" is simulated the way it can actually
      // happen at runtime: the scheduling call itself throws.
      const agent = makeAgent();
      agent.schedule = async () => {
        throw new Error("schedule() unavailable in this runtime (test stub)");
      };
      agent.scheduleEvery = async () => {
        throw new Error("scheduleEvery() unavailable in this runtime (test stub)");
      };
      const { status, body } = await postCreate(agent, {
        ...fields,
        callback: "autonomousOptionsAnalysis",
        payload: { symbols: ["NVDA"] },
      });
      expect(status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error).toContain("Scheduling unavailable");
      expect(body.schedule).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("sched_mock_");
    }
  );

  it("returns an honest 503 when the SDK scheduling call throws", async () => {
    const agent = makeAgent();
    agent.schedule = async () => {
      throw new Error("durable object storage exploded");
    };
    const { status, body } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 3 * * *",
      callback: "autonomousOptionsAnalysis",
      payload: { symbols: ["NVDA"] },
    });
    expect(status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toContain("durable object storage exploded");
    expect(JSON.stringify(body)).not.toContain("sched_mock_");
  });

  it("pins the source: no fabricated sched_mock_ id remains anywhere in src/", () => {
    const source = readFileSync("src/agents/orchestrator.ts", "utf8");
    expect(source).not.toContain("sched_mock_");
  });

  it("pins the source: scheduling call sites use the typed SDK API (#108)", () => {
    const source = readFileSync("src/agents/orchestrator.ts", "utf8");
    // No (this as any) receiver casts on scheduling calls (the first
    // pattern also covers scheduleEvery) or on waitUntilStable.
    expect(source).not.toContain("(this as any).schedule");
    expect(source).not.toContain("(this as any).listSchedules");
    expect(source).not.toContain("(this as any).getScheduleById");
    expect(source).not.toContain("(this as any).cancelSchedule");
    expect(source).not.toContain("(this as any).waitUntilStable");
    // The dead list-route fallback chain (deprecated getSchedules call,
    // scheduler.list) and the #111 missing-method helper are gone.
    expect(source).not.toContain("getSchedules(");
    expect(source).not.toContain(".scheduler.list(");
    expect(source).not.toContain("schedulingUnavailable(");
  });

  it("returns the existing schedule for a duplicate submit instead of arming a second (#2071)", async () => {
    const first = makeAgent();
    const body = {
      scheduleType: "interval",
      intervalSeconds: 3600,
      // Issue #4235 — a 3600s interval is sub-daily, so creation
      // carries the explicit per-schedule opt-in.
      subDailyOptIn: true,
      callback: "autonomousOptionsAnalysis",
      payload: { symbols: ["NVDA"], thesis: "bullish" },
    };
    const created = await postCreate(first, body);
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    const stampedPayload = scheduleEveryCalls[0][2];
    const armed = scheduleEveryCalls.length;

    const second = makeAgent();
    second.listSchedules = async () => [
      {
        id: "existing-1",
        callback: "autonomousOptionsAnalysis",
        type: "interval",
        intervalSeconds: 3600,
        payload: stampedPayload,
      },
    ];
    const duplicate = await postCreate(second, body);

    expect(duplicate.status).toBe(200);
    expect(duplicate.body.success).toBe(true);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.schedule.id).toBe("existing-1");
    expect(scheduleEveryCalls).toHaveLength(armed);
  });

  describe("default daily cap, opt-in for finer cadence (#4235)", () => {
    const optionsBody = (extra: Record<string, unknown>) => ({
      callback: "autonomousOptionsAnalysis",
      payload: { symbols: ["NVDA"], thesis: "bullish" },
      ...extra,
    });

    it("rejects a sub-daily interval without the opt-in and arms nothing", async () => {
      const agent = makeAgent();
      const { status, body } = await postCreate(agent, optionsBody({ scheduleType: "interval", intervalSeconds: 3600 }));
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/opt-in/i);
      expect(scheduleEveryCalls).toHaveLength(0);
    });

    it("arms a sub-daily interval with the opt-in", async () => {
      const agent = makeAgent();
      const { status, body } = await postCreate(
        agent,
        optionsBody({ scheduleType: "interval", intervalSeconds: 3600, subDailyOptIn: true }),
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(scheduleEveryCalls).toHaveLength(1);
    });

    it("rejects a sub-daily cron without the opt-in and arms nothing", async () => {
      const agent = makeAgent();
      const { status, body } = await postCreate(agent, optionsBody({ scheduleType: "cron", cron: "0 * * * *" }));
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/opt-in/i);
      expect(scheduleCalls).toHaveLength(0);
    });

    it("arms a monthly cron without any opt-in", async () => {
      const agent = makeAgent();
      const { status, body } = await postCreate(agent, optionsBody({ scheduleType: "cron", cron: "0 9 1 * *" }));
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(scheduleCalls).toHaveLength(1);
      expect(scheduleCalls[0][0]).toBe("0 9 1 * *");
    });

    it("rejects an out-of-range cron with 400 instead of a 503 from the SDK", async () => {
      const agent = makeAgent();
      const { status, body } = await postCreate(agent, optionsBody({ scheduleType: "cron", cron: "99 99 * * *" }));
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(scheduleCalls).toHaveLength(0);
    });
  });

  describe("bound-account enforcement (#5100, F3 of #5094)", () => {
    it("bound creation stamps the resolved tuple on the armed payload", async () => {
      const agent = makeAgent();
      const { status, body } = await postCreate(agent, {
        scheduleType: "interval",
        intervalSeconds: 3600,
        subDailyOptIn: true,
        callback: "autonomousMarketScreen",
        payload: { universe: "NASDAQ100", maxItems: 5 },
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(scheduleEveryCalls).toHaveLength(1);
      expect(scheduleEveryCalls[0][2]).toMatchObject({
        brokerId: "etrade",
        mode: "paper",
        accountType: "stock",
        accountId: "ET-123",
      });
    });

    it("unbound creation is refused with the coded failure and arms nothing", async () => {
      const agent = makeAgent({ bound: false });
      const { status, body } = await postCreate(agent, {
        scheduleType: "interval",
        intervalSeconds: 3600,
        subDailyOptIn: true,
        callback: "autonomousMarketScreen",
        payload: { universe: "NASDAQ100", maxItems: 5 },
      });
      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
      expect(scheduleEveryCalls).toHaveLength(0);
      expect(scheduleCalls).toHaveLength(0);
    });

    // A caller-supplied accountId is an untrusted explicit hint,
    // validated against the broker's enumerated accounts — it is
    // never stamped verbatim. That path is pinned deterministically
    // at the wrapper level (explicit without enumeration fails
    // closed) and at the payload level (identity wins over
    // caller-supplied values, #3655); a route-level explicit test
    // would enumerate the live E*TRADE account list, so it is not
    // asserted here.
  });
});
