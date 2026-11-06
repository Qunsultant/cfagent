/**
 * Issue #2327 — Agent Mesh S3 (programme #2225, G8/G14): identity
 * retirement sweep.
 *
 * Pins the fail-closed identity discipline on the three paths where a
 * synthetic login was silently substituted for a missing one:
 *
 * - ResearchAgent: runResearch / runDiscovery refused an absent login
 *   instead of running as "default"; evaluateRun / refreshIdeaQuotes
 *   resolve identity from the caller or the run record's own owner —
 *   never the retired literal, and never a fabricated one.
 * - Orchestrator research path: the publish entry refuses a run with
 *   no identity before any stub is resolved; the scheduled-tick route
 *   answers the route family's unauthenticated response when the
 *   identity header is absent (server.ts only dispatches the tick
 *   with the configured service identity, #1185); the scheduled
 *   trigger helper carries no "default" parameter value.
 * - PaymentsAgent: budgetCheck requires an explicit agentId and fails
 *   closed without one; ScheduledAgent names the budget bucket it
 *   checks (AGENTIC_SPEND_AGENT_ID — the orchestrator-attributed
 *   spend its goals gate, per the src/payments/ledger.ts contract)
 *   explicitly at both call sites; the A2A payments.budget_check door
 *   requires agentId like payments.process already does.
 *
 * The orchestrator class cannot be instantiated under Node (see
 * tests/agent-fallback-observability.test.ts), so its stub helper is
 * pinned by source evidence; everything else here is behavioural.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// PortThink stub (the research-delivery.test.ts idiom): a plain base
// class so the Think-coupled adapter's `cloudflare:` imports never
// reach the node loader.
vi.mock("../src/actors/thinkAdapter", () => {
  return {
    PortThink: class MockPortThink {
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

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Research provider spy: records the login every provider is
// constructed under, so a test can prove which identity a run used.
const providerLogins: string[] = [];
const mockGetQuote = vi.fn();
vi.mock("../src/services/researchProviders", () => ({
  EtradeResearchDataProvider: class {
    constructor(_env: unknown, userLogin: string) {
      providerLogins.push(userLogin);
    }
    getQuote = mockGetQuote;
  },
}));

import { ResearchAgent } from "../src/agents/research-agent";
import { runResearchAndPublish } from "../src/agents/orchestrator/researchPublish";
import { handleScreenerResearchRoutes } from "../src/agents/routes/screenerResearch";
import {
  triggerManualResearch,
  triggerScheduledResearch,
} from "../src/services/researchTriggers";
import { PaymentsAgent } from "../src/agents/payments-agent";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { dispatchPaymentsA2A } from "../src/agents/payments/a2aDispatch";
import { AGENTIC_SPEND_AGENT_ID } from "../src/payments/ledger";
import { compileGoal } from "../src/orchestrate";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { handleAgenticPaymentsRoutes } from "../src/agents/routes/agenticPayments";

beforeEach(() => {
  providerLogins.length = 0;
  mockGetQuote.mockReset();
});

// ---------------------------------------------------------------------------
// ResearchAgent: run methods refuse an absent identity
// ---------------------------------------------------------------------------

function makeResearchAgent(): ResearchAgent {
  const agent = Object.create(ResearchAgent.prototype) as ResearchAgent;
  (agent as any).env = {};
  (agent as any).ctx = {
    storage: {
      get: async () => null,
      put: async () => {},
      sql: new MockSqlStorage(),
    },
  };
  return agent;
}

describe("ResearchAgent identity discipline (#2327)", () => {
  it("runResearch refuses a request with no userLogin — no run, no provider, nothing persisted", async () => {
    const agent = makeResearchAgent();
    const result = await agent.runResearch({ trigger: "manual" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/explicit userLogin/);
    expect(providerLogins).toEqual([]);
    expect(await agent.getLatest()).toBeNull();
  });

  it("runResearch refuses a blank login and the retired literal itself", async () => {
    const agent = makeResearchAgent();
    for (const userLogin of ["", "   ", "default"]) {
      const result = await agent.runResearch({ trigger: "manual", userLogin });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/explicit userLogin/);
    }
    expect(providerLogins).toEqual([]);
  });

  it("runResearch with an explicit login passes the identity guard", async () => {
    const agent = makeResearchAgent();
    const result = await agent.runResearch({
      trigger: "manual",
      userLogin: "alice@example.com",
    });
    // Whatever the harness pipeline does next is other suites'
    // concern; the identity refusal must NOT be the failure.
    expect(result.error ?? "").not.toMatch(/explicit userLogin/);
  });

  it("runDiscovery refuses a request with no userLogin", async () => {
    const agent = makeResearchAgent();
    const result = await agent.runDiscovery({ trigger: "scheduled" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/explicit userLogin/);
    expect(providerLogins).toEqual([]);
  });

  it("runDiscovery with an explicit login passes the identity guard", async () => {
    const agent = makeResearchAgent();
    const result = await agent.runDiscovery({
      trigger: "scheduled",
      userLogin: "svc-background",
    });
    expect(result.error ?? "").not.toMatch(/explicit userLogin/);
  });
});

// ---------------------------------------------------------------------------
// ResearchAgent: evaluation / refresh resolve identity from the record
// ---------------------------------------------------------------------------

function reportFixture(userLogin?: string) {
  return {
    runId: "run-s3",
    generationId: "gen-s3",
    trigger: "scheduled",
    ...(userLogin !== undefined ? { userLogin } : {}),
    createdAt: "2026-10-20T12:00:00.000Z",
    rulesVersion: "v1",
    configSnapshot: {} as any,
    regime: { regime: "chop", notes: [], asOf: 0 },
    summary: "s",
    ideas: [{ rank: 1, symbol: "AVGO", entrySpot: 300, score: 28 } as any],
    watchlist: [],
    rejected: [],
    stats: {} as any,
    oodaTrace: [],
  } as any;
}

describe("ResearchAgent evaluation/refresh identity (#2327)", () => {
  it("refreshIdeaQuotes threads the report's recorded owner when the caller omits a login", async () => {
    mockGetQuote.mockImplementation(async () => ({ price: 300 }));
    const agent = makeResearchAgent();
    const flags = await agent.refreshIdeaQuotes(reportFixture("owner-x"));
    expect(flags).toEqual([]);
    expect(providerLogins).toEqual(["owner-x"]);
  });

  it("refreshIdeaQuotes runs nothing when neither caller nor record carries an identity", async () => {
    mockGetQuote.mockImplementation(async () => ({ price: 300 }));
    const agent = makeResearchAgent();
    const flags = await agent.refreshIdeaQuotes(reportFixture(undefined));
    expect(flags).toEqual([]);
    expect(providerLogins).toEqual([]);
    expect(mockGetQuote).not.toHaveBeenCalled();
  });

  function seedRun(agent: ResearchAgent, report: any) {
    (agent as any).ensureTables();
    const sql = (agent as any).ctx.storage.sql;
    sql.exec(
      `INSERT INTO research_runs
         (run_id, trigger, user_login, created_at, rules_version, status, ideas_count, report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      report.runId,
      report.trigger,
      report.userLogin ?? "",
      report.createdAt,
      report.rulesVersion,
      "published",
      report.ideas.length,
      JSON.stringify(report),
    );
  }

  it("evaluateRun threads the stored run's recorded owner when the caller omits a login", async () => {
    const agent = makeResearchAgent();
    seedRun(agent, reportFixture("owner-x"));
    await agent.evaluateRun("run-s3");
    expect(providerLogins).toEqual(["owner-x"]);
  });

  it("evaluateRun prefers the caller's explicit login over the record's", async () => {
    const agent = makeResearchAgent();
    seedRun(agent, reportFixture("owner-x"));
    await agent.evaluateRun("run-s3", "caller-y");
    expect(providerLogins).toEqual(["caller-y"]);
  });

  it("evaluateRun declines (null) and constructs no provider when no identity exists anywhere", async () => {
    const agent = makeResearchAgent();
    seedRun(agent, reportFixture(undefined));
    const evaluation = await agent.evaluateRun("run-s3");
    expect(evaluation).toBeNull();
    expect(providerLogins).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator research path: publish entry, tick route, trigger helper
// ---------------------------------------------------------------------------

function makePublishCtx() {
  const sql = new MockSqlStorage();
  return {
    env: {},
    agentCtx: { storage: { sql } },
    ensureTables: () => sql,
    getOrm: () => {
      throw new Error("unused in this pin");
    },
    getResearchAgent: vi.fn((_userLogin?: string) => null),
    runAgentTool: vi.fn(async () => ({ status: "completed" })),
    getReportDispatchHitl: () => false,
    createReportConfirmation: () => "conf",
    RESEARCH_TASK_HEARTBEAT_MS: 60_000,
  } as any;
}

describe("orchestrator research publish entry (#2327)", () => {
  it("refuses a run with no identity before any ResearchAgent stub is resolved", async () => {
    const ctx = makePublishCtx();
    const out = await runResearchAndPublish(ctx, "scheduled", undefined);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/explicit userLogin/);
    expect(ctx.getResearchAgent).not.toHaveBeenCalled();
  });

  it("refuses the retired literal as an identity", async () => {
    const ctx = makePublishCtx();
    const out = await runResearchAndPublish(ctx, "manual", "default");
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/explicit userLogin/);
    expect(ctx.getResearchAgent).not.toHaveBeenCalled();
  });

  it("an explicit login flows to the stub helper unchanged", async () => {
    const ctx = makePublishCtx();
    const out = await runResearchAndPublish(ctx, "scheduled", "svc-background");
    expect(ctx.getResearchAgent).toHaveBeenCalledWith("svc-background");
    // The fake resolves no agent, so the run stops at the binding
    // failure — proof the identity guard let it through.
    expect(out.error).toMatch(/binding not configured/);
  });
});

describe("research scheduled-tick route (#2327)", () => {
  function makeRouteCtx() {
    return {
      getScreenerAgent: () => {
        throw new Error("unused in this pin");
      },
      getScreenerExecutionContext: async () => undefined,
      getResearchAgent: vi.fn((_userLogin?: string) => null),
      runResearchAndPublish: vi.fn(async () => ({ success: true })),
      getOrm: () => {
        throw new Error("unused in this pin");
      },
      readSettingRaw: () => null,
      writeSetting: () => {},
      env: {},
    } as any;
  }

  it("answers 401 and dispatches nothing when the identity header is absent", async () => {
    const ctx = makeRouteCtx();
    const request = new Request("https://agent.internal/research/scheduled-tick", {
      method: "POST",
    });
    const res = await handleScreenerResearchRoutes(
      request,
      new URL(request.url),
      "/research/scheduled-tick",
      "session",
      ctx,
    );
    expect(res?.status).toBe(401);
    expect(ctx.runResearchAndPublish).not.toHaveBeenCalled();
  });

  it("an identity header is honoured (the tick proceeds past the identity gate)", async () => {
    const ctx = makeRouteCtx();
    const request = new Request("https://agent.internal/research/scheduled-tick", {
      method: "POST",
      headers: { "x-user-login": "svc-background" },
    });
    const res = await handleScreenerResearchRoutes(
      request,
      new URL(request.url),
      "/research/scheduled-tick",
      "session",
      ctx,
    );
    expect(res?.status).toBe(200);
  });
});

describe("research trigger helpers (#2327)", () => {
  it("triggerScheduledResearch carries no default identity", async () => {
    const publish = vi.fn(async () => ({ success: true }));
    await triggerScheduledResearch(publish as any);
    expect(publish).toHaveBeenCalledWith("scheduled", undefined);
  });

  it("trigger helpers forward an explicit login unchanged", async () => {
    const publish = vi.fn(async () => ({ success: true }));
    await triggerScheduledResearch(publish as any, "svc-background");
    await triggerManualResearch(publish as any, "alice@example.com");
    expect(publish).toHaveBeenNthCalledWith(1, "scheduled", "svc-background");
    expect(publish).toHaveBeenNthCalledWith(2, "manual", "alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// PaymentsAgent: budgetCheck requires an explicit caller identity
// ---------------------------------------------------------------------------

function makePaymentsCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  };
}

// The payments_guard.test.ts harness: a real ledger owner (DatabaseORM
// over MockSqlStorage) served through the real agentic-payments route
// handler, bound as ORCHESTRATOR_AGENT.
function makeLedgerEnv(): any {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("default_trader");
  const routeCtx = { env: {}, getOrm: () => orm, audit: () => {} };
  return {
    CF_WALLET_FACILITATOR: "https://facilitator.test",
    SERVICE_USER_LOGIN: "default_trader",
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          const res = await handleAgenticPaymentsRoutes(
            req,
            url,
            url.pathname,
            "default_trader",
            routeCtx as any,
          );
          return res ?? Response.json({ error: "no such route" }, { status: 404 });
        },
      }),
    },
  };
}

describe("PaymentsAgent budgetCheck identity (#2327)", () => {
  it("fails closed when the caller supplies no agentId", async () => {
    const agent = new (PaymentsAgent as any)(makePaymentsCtx(), makeLedgerEnv());
    const verdict = await agent.budgetCheck({
      operation: "search.query",
      amountCents: 100,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/agentId/);
  });

  it("fails closed when the caller supplies a blank agentId", async () => {
    const agent = new (PaymentsAgent as any)(makePaymentsCtx(), makeLedgerEnv());
    const verdict = await agent.budgetCheck({
      operation: "search.query",
      amountCents: 100,
      agentId: "  ",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/agentId/);
  });

  it("an explicit agentId gets the guard's real verdict", async () => {
    const agent = new (PaymentsAgent as any)(makePaymentsCtx(), makeLedgerEnv());
    const verdict = await agent.budgetCheck({
      operation: "search.query",
      amountCents: 100,
      agentId: AGENTIC_SPEND_AGENT_ID,
    });
    expect(verdict.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ScheduledAgent threads its budget identity explicitly
// ---------------------------------------------------------------------------

function makeScheduledHarness() {
  const budgetCalls: any[] = [];
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
  };
  const env = {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({
        budgetCheck: async (req: any) => {
          budgetCalls.push(req);
          return { allowed: true };
        },
      }),
    },
  } as any;
  return { budgetCalls, store, ctx, env };
}

function dueCron() {
  const now = new Date();
  return `0 ${now.getUTCHours()} * * *`;
}

describe("ScheduledAgent budget-check threading (#2327)", () => {
  it("onCron names the budget bucket explicitly on every goal check", async () => {
    const { budgetCalls, store, ctx, env } = makeScheduledHarness();
    const agent = new (ScheduledAgent as any)(ctx, env);
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "s3-thread-oncron", cron: dueCron() });
    await agent.approveSynthesizedSchedule("s3-thread-oncron");
    const goal = await agent.materializeSynthesizedSchedule("s3-thread-oncron");
    store.set("goals", [goal]);
    await agent.onCron();
    expect(budgetCalls.length).toBeGreaterThan(0);
    for (const call of budgetCalls) {
      expect(call.agentId).toBe(AGENTIC_SPEND_AGENT_ID);
    }
  });

  it("fireSynthesizedSchedule names the budget bucket explicitly", async () => {
    const { budgetCalls, ctx, env } = makeScheduledHarness();
    const agent = new (ScheduledAgent as any)(ctx, env);
    const chain = compileGoal("Send me yesterday's report by email", { budgetCents: 0 });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "s3-thread-onefire" });
    await agent.approveSynthesizedSchedule("s3-thread-onefire");
    const fired = await agent.fireSynthesizedSchedule("s3-thread-onefire");
    expect(fired.fired).toBe(true);
    expect(budgetCalls.length).toBeGreaterThan(0);
    for (const call of budgetCalls) {
      expect(call.agentId).toBe(AGENTIC_SPEND_AGENT_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// A2A payments door: budget_check requires the caller's agentId
// ---------------------------------------------------------------------------

describe("payments.budget_check A2A door (#2327)", () => {
  function makeExecutor() {
    const calls: any[] = [];
    return {
      calls,
      executor: {
        budgetCheck: async (req: any) => {
          calls.push(req);
          return { allowed: true };
        },
        todaySpent: async () => 0,
        listPayments: async () => [],
        processPaidRequest: async () => {
          throw new Error("unused in this pin");
        },
      },
    };
  }

  it("refuses a budget_check with no agentId as invalid input; the executor is never called", async () => {
    const { executor, calls } = makeExecutor();
    const data = await dispatchPaymentsA2A(
      {} as any,
      { operation: "payments.budget_check", op: "search.query", amountCents: 5 } as any,
      { executor },
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("an explicit agentId reaches the executor unchanged", async () => {
    const { executor, calls } = makeExecutor();
    const data = await dispatchPaymentsA2A(
      {} as any,
      {
        operation: "payments.budget_check",
        op: "search.query",
        amountCents: 5,
        agentId: "sched-1",
      } as any,
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      { operation: "search.query", amountCents: 5, agentId: "sched-1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Source evidence: the retired literals are gone from the in-scope paths
// (the orchestrator class cannot be instantiated under Node — the
// agent-fallback-observability.test.ts precedent).
// ---------------------------------------------------------------------------

describe("retired fallback literals — source evidence (#2327)", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, rel), "utf8");

  it("research-agent.ts carries no \"default\" login fallback", () => {
    const src = read("../src/agents/research-agent.ts");
    expect(src).not.toContain('|| "default"');
    expect(src).not.toContain('?? "default"');
  });

  it("payments-agent.ts carries no attribution default", () => {
    const src = read("../src/agents/payments-agent.ts");
    expect(src).not.toContain('?? "orchestrator"');
  });

  it("researchTriggers.ts carries no default identity value", () => {
    const src = read("../src/services/researchTriggers.ts");
    expect(src).not.toContain('"default"');
  });

  it("the orchestrator research-stub helper resolves no default instance", () => {
    const src = read("../src/agents/orchestrator.ts");
    const start = src.indexOf("private getResearchAgent");
    expect(start).toBeGreaterThan(-1);
    const section = src.slice(start, start + 700);
    // The fallback shape is gone (an explicit rejection comparison
    // against the retired literal is the opposite of a fallback and
    // is not what this pin protects against).
    expect(section).not.toContain('|| "default"');
    expect(section).toContain("return null");
  });

  it("the scheduled-tick handler fabricates no default login", () => {
    const src = read("../src/agents/routes/screenerResearch.ts");
    const start = src.indexOf('"/research/scheduled-tick"');
    expect(start).toBeGreaterThan(-1);
    const section = src.slice(start, start + 400);
    expect(section).not.toContain('|| "default"');
  });
});
