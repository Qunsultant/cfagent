/**
 * Issue #2223 (final slice) — A2A handlers for the six remaining
 * agents: screener, scheduled, research, report-asset, browser,
 * slack.
 *
 * Before this slice every one of these names 404'd at the A2A
 * dispatcher (or, for report-asset, could not even be reached
 * usefully): no resolution entries, no cards, no handleA2A on any of
 * the six classes. The pins below lock the conforming shape from
 * SURVEY §1.3–§1.8 / §5:
 *
 * - one never-throws dispatch module per agent, executor injected by
 *   the class (the payments precedent — the methods are class-bound);
 * - cards advertise EXACTLY the served operations (anti-drift);
 * - failures carry BOTH the local stable token and an
 *   AGENT_ERROR_CATALOG token; successes carry neither;
 * - instance discipline: screener lands on the service instance
 *   "default" (and fails closed with no service identity — the class
 *   throws on a virgin instance, SURVEY §1.3); research lands on
 *   research:<service-login> and fails closed rather than falling
 *   back to the methods' literal "default" login (SURVEY §1.5);
 *   report-asset lands on "default"; browser/slack are stateless /
 *   env-driven and keep URL-name parity;
 * - browser/slack delivery targets are NEVER taken from A2A args:
 *   a caller-supplied webhookUrl is stripped, so delivery goes only
 *   to the env-configured webhook (SURVEY §1.7 caution).
 *
 * Executor-seam note: the six agents' real methods need live
 * services (E*TRADE, Slack, a browser) or a real DO, so routing and
 * honesty are pinned at the injectable executor seam with fakes —
 * the same seam the classes inject their bound methods through.
 * Nothing here mocks a capability into existence: where a method
 * reports failure (success:false, null), the dispatch must surface
 * failure, and those cases are pinned explicitly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("agents", () => {
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import {
  SCREENER_A2A_OPERATIONS,
  dispatchScreenerA2A,
  screenerA2AOutcome,
  type ScreenerA2AExecutor,
} from "../src/agents/screenerA2aDispatch";
import {
  SCHEDULED_A2A_OPERATIONS,
  dispatchScheduledA2A,
  scheduledA2AOutcome,
  type ScheduledA2AExecutor,
} from "../src/agents/scheduledA2aDispatch";
import {
  RESEARCH_A2A_OPERATIONS,
  dispatchResearchA2A,
  researchA2AOutcome,
  type ResearchA2AExecutor,
} from "../src/agents/researchA2aDispatch";
import {
  REPORT_ASSET_A2A_OPERATIONS,
  dispatchReportAssetA2A,
  reportAssetA2AOutcome,
  type ReportAssetA2AExecutor,
} from "../src/agents/reportAssetA2aDispatch";
import {
  BROWSER_A2A_OPERATIONS,
  dispatchBrowserA2A,
  browserA2AOutcome,
  type BrowserA2AExecutor,
} from "../src/agents/browserA2aDispatch";
import {
  SLACK_A2A_OPERATIONS,
  dispatchSlackA2A,
  slackA2AOutcome,
  type SlackA2AExecutor,
} from "../src/agents/slackA2aDispatch";
import { getAgentCard } from "../src/a2a/agent-cards";
import {
  resolveA2AAgent,
  resolveA2AInstanceName,
} from "../src/a2a/resolution";
import { handleA2A } from "../src/a2a/index";
import { AGENT_ERROR_CATALOG } from "../src/aspects/errorCodes";

const ENV_SVC = { SERVICE_USER_LOGIN: "svc-user" } as any;
const ENV_NONE = {} as any;

const envelope = (data: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: "req-1",
  method: "message/send",
  params: { message: { parts: [{ kind: "data", data }] } },
});

// ---------------------------------------------------------------------------
// Screener
// ---------------------------------------------------------------------------

function makeScreenerExecutor(overrides: Partial<ScreenerA2AExecutor> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const executor: ScreenerA2AExecutor = {
    runScreen: async (req) => {
      calls.push({ method: "runScreen", args: req });
      return {
        timestamp: "2026-10-29T00:00:00.000Z",
        trigger: "manual",
        provider: "etrade",
        universe: "nasdaq100",
        sector: "ALL",
        success: true,
        totalScanned: 42,
        matchedCount: 3,
        opportunities: [],
        allStocks: [],
        discoveryMessage: "ok",
      } as any;
    },
    runGoalScreen: async (req) => {
      calls.push({ method: "runGoalScreen", args: req });
      return { task: { id: "task-1" } as any, executed: true };
    },
    getLatest: async () => {
      calls.push({ method: "getLatest", args: undefined });
      return null;
    },
    getHistory: async () => {
      calls.push({ method: "getHistory", args: undefined });
      return [];
    },
    listScreenerTasks: async (limit) => {
      calls.push({ method: "listScreenerTasks", args: limit });
      return [{ id: "task-1" } as any];
    },
    ...overrides,
  };
  return { executor, calls };
}

describe("dispatchScreenerA2A (#2223 final slice)", () => {
  it("screener.run_screen routes with the service identity threaded, overriding any body-supplied login", async () => {
    const { executor, calls } = makeScreenerExecutor();
    const data = await dispatchScreenerA2A(
      ENV_SVC,
      { operation: "screener.run_screen", trigger: "manual", userLogin: "mallory", maxItems: 5 },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(data.operation).toBe("screener.run_screen");
    expect(data.errorToken).toBeUndefined();
    const req = calls[0].args as any;
    expect(req.userLogin).toBe("svc-user");
    expect(req.maxItems).toBe(5);
    // The scheduled layer's fallback-provenance marker and the test
    // seam are never accepted from an A2A caller.
    expect(req.providerFallback).toBeUndefined();
    expect(req.yahooDeps).toBeUndefined();
  });

  it("screener.run_screen fails closed (not_configured) with no service identity — the executor is never called", async () => {
    const { executor, calls } = makeScreenerExecutor();
    const data = await dispatchScreenerA2A(ENV_NONE, { operation: "screener.run_screen" }, { executor });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("not_configured");
    expect(data.errorToken).toBeDefined();
    expect(AGENT_ERROR_CATALOG[data.errorToken!]).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("screener.run_screen mirrors a failed run (success:false + error) as a failure with the record attached", async () => {
    const { executor } = makeScreenerExecutor({
      runScreen: async () =>
        ({
          timestamp: "2026-10-29T00:00:00.000Z",
          trigger: "manual",
          provider: "etrade",
          universe: "nasdaq100",
          sector: "ALL",
          success: false,
          totalScanned: 0,
          matchedCount: 0,
          opportunities: [],
          allStocks: [],
          discoveryMessage: "",
          error: "E*TRADE quotes returned zero symbols",
        }) as any,
    });
    const data = await dispatchScreenerA2A(ENV_SVC, { operation: "screener.run_screen" }, { executor });
    expect(data.ok).toBe(false);
    expect(data.error).toContain("zero symbols");
    expect((data.result as any).success).toBe(false);
  });

  it("screener.run_goal_screen requires scenario + idempotencyKey and threads the service identity", async () => {
    const { executor, calls } = makeScreenerExecutor();
    const bad = await dispatchScreenerA2A(
      ENV_SVC,
      { operation: "screener.run_goal_screen", scenario: { id: "s1" } },
      { executor },
    );
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("invalid_input");
    const data = await dispatchScreenerA2A(
      ENV_SVC,
      envelope({ operation: "screener.run_goal_screen", scenario: { id: "s1" }, idempotencyKey: "k-1" }),
      { executor },
    );
    expect(data.ok).toBe(true);
    expect((calls[0].args as any).userLogin).toBe("svc-user");
    expect((calls[0].args as any).idempotencyKey).toBe("k-1");
  });

  it("screener.latest serves an honest empty (null) as a successful result", async () => {
    const { executor } = makeScreenerExecutor();
    const data = await dispatchScreenerA2A(ENV_SVC, { operation: "screener.latest" }, { executor });
    expect(data.ok).toBe(true);
    expect(data.result).toBeNull();
    expect(screenerA2AOutcome(data).text).toContain("no screen run");
  });

  it("screener.history and screener.list_tasks route; list_tasks validates limit", async () => {
    const { executor, calls } = makeScreenerExecutor();
    expect((await dispatchScreenerA2A(ENV_SVC, { operation: "screener.history" }, { executor })).ok).toBe(true);
    const listed = await dispatchScreenerA2A(ENV_SVC, { operation: "screener.list_tasks", limit: 5 }, { executor });
    expect(listed.ok).toBe(true);
    expect(calls.find((c) => c.method === "listScreenerTasks")!.args).toBe(5);
    const badLimit = await dispatchScreenerA2A(ENV_SVC, { operation: "screener.list_tasks", limit: -1 }, { executor });
    expect(badLimit.code).toBe("invalid_input");
  });

  it("unknown and missing operations are classified; executor throws never escape", async () => {
    const { executor } = makeScreenerExecutor();
    const unknown = await dispatchScreenerA2A(ENV_SVC, { operation: "screener.run_sharded" }, { executor });
    expect(unknown).toMatchObject({ ok: false, code: "unknown_operation" });
    const missing = await dispatchScreenerA2A(ENV_SVC, { nope: true }, { executor });
    expect(missing).toMatchObject({ ok: false, code: "missing_operation" });
    const throwing = makeScreenerExecutor({
      getHistory: async () => {
        throw new Error("storage exploded");
      },
    });
    const data = await dispatchScreenerA2A(ENV_SVC, { operation: "screener.history" }, { executor: throwing.executor });
    expect(data).toMatchObject({ ok: false, code: "internal_error" });
    expect(data.error).toContain("storage exploded");
    expect(screenerA2AOutcome(data).text).toContain("failed");
  });

  it("without an injected executor the dispatch fails honestly", async () => {
    const data = await dispatchScreenerA2A(ENV_SVC, { operation: "screener.latest" }, {});
    expect(data.ok).toBe(false);
    expect(data.code).toBe("internal_error");
    expect(data.error).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// Scheduled
// ---------------------------------------------------------------------------

function makeScheduledExecutor(overrides: Partial<ScheduledA2AExecutor> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const goal = {
    id: "g1",
    name: "Goal One",
    cron: "0 6 * * *",
    operation: "search.query",
    budgetCents: 100,
    enabled: true,
  } as any;
  const executor: ScheduledA2AExecutor = {
    listGoals: async () => {
      calls.push({ method: "listGoals", args: undefined });
      return [goal];
    },
    getTickHistory: async (limit) => {
      calls.push({ method: "getTickHistory", args: limit });
      return [];
    },
    addGoal: async (g) => {
      calls.push({ method: "addGoal", args: g });
      return { ...goal, ...g } as any;
    },
    removeGoal: async (id) => {
      calls.push({ method: "removeGoal", args: id });
      return id === "g1";
    },
    setGoalEnabled: async (id, enabled) => {
      calls.push({ method: "setGoalEnabled", args: { id, enabled } });
      return id === "g1";
    },
    triggerGoal: async (id) => {
      calls.push({ method: "triggerGoal", args: id });
      return {
        timestamp: "2026-10-29T00:00:00.000Z",
        goalsEvaluated: 1,
        jobsCreated: 1,
        jobsSkipped: 0,
        errors: [],
      } as any;
    },
    ...overrides,
  };
  return { executor, calls };
}

describe("dispatchScheduledA2A (#2223 final slice)", () => {
  it("scheduled.list_goals and scheduled.tick_history route", async () => {
    const { executor, calls } = makeScheduledExecutor();
    const data = await dispatchScheduledA2A(ENV_NONE, { operation: "scheduled.list_goals" }, { executor });
    expect(data.ok).toBe(true);
    expect((data.result as any[]).length).toBe(1);
    expect(scheduledA2AOutcome(data).text).toContain("1 scheduled goal");
    const hist = await dispatchScheduledA2A(ENV_NONE, { operation: "scheduled.tick_history", limit: 5 }, { executor });
    expect(hist.ok).toBe(true);
    expect(calls.find((c) => c.method === "getTickHistory")!.args).toBe(5);
  });

  it("scheduled.add_goal passes the goal through faithfully and validates shapes", async () => {
    const { executor, calls } = makeScheduledExecutor();
    const data = await dispatchScheduledA2A(
      ENV_NONE,
      { operation: "scheduled.add_goal", id: "g2", name: "Two", cron: "0 9 * * 1-5", op: "resource.rollup_daily", budgetCents: 250, enabled: false },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(calls[0].args).toMatchObject({ id: "g2", name: "Two", cron: "0 9 * * 1-5", operation: "resource.rollup_daily", budgetCents: 250, enabled: false });
    const bad = await dispatchScheduledA2A(
      ENV_NONE,
      { operation: "scheduled.add_goal", id: "g3", name: "Three", cron: "0 9 * * *", op: "search.query", budgetCents: -5 },
      { executor },
    );
    expect(bad.code).toBe("invalid_input");
  });

  it("scheduled.add_goal refuses a descriptor-only operation (issue #3122 F2)", async () => {
    const { executor, calls } = makeScheduledExecutor();
    for (const op of ["search.query", "trading.screen_stocks", "tasks.create"]) {
      const data = await dispatchScheduledA2A(
        ENV_NONE,
        { operation: "scheduled.add_goal", id: "g-f2", name: "F2", cron: "0 9 * * *", op, budgetCents: 100 },
        { executor },
      );
      expect(data.ok).toBe(false);
      expect(data.code).toBe("invalid_input");
      expect(data.error).toMatch(/descriptor-only/);
    }
    expect(calls).toHaveLength(0);
  });

  it("scheduled.remove_goal / set_goal_enabled report a missing goal as a state answer, not an error", async () => {
    const { executor } = makeScheduledExecutor();
    const removed = await dispatchScheduledA2A(ENV_NONE, { operation: "scheduled.remove_goal", id: "ghost" }, { executor });
    expect(removed.ok).toBe(true);
    expect(removed.result).toBe(false);
    expect(scheduledA2AOutcome(removed).text).toContain("no goal with id");
    const badEnabled = await dispatchScheduledA2A(
      ENV_NONE,
      { operation: "scheduled.set_goal_enabled", id: "g1", enabled: "yes" },
      { executor },
    );
    expect(badEnabled.code).toBe("invalid_input");
  });

  it("scheduled.trigger_goal returns the tick, including its own error report", async () => {
    const { executor } = makeScheduledExecutor({
      triggerGoal: async () =>
        ({
          timestamp: "2026-10-29T00:00:00.000Z",
          goalsEvaluated: 0,
          jobsCreated: 0,
          jobsSkipped: 1,
          errors: ["Goal not found: ghost"],
        }) as any,
    });
    const data = await dispatchScheduledA2A(ENV_NONE, { operation: "scheduled.trigger_goal", id: "ghost" }, { executor });
    expect(data.ok).toBe(true);
    expect(scheduledA2AOutcome(data).text).toContain("Goal not found: ghost");
  });

  it("unknown operation is classified and executor throws never escape", async () => {
    const { executor } = makeScheduledExecutor();
    expect((await dispatchScheduledA2A(ENV_NONE, { operation: "scheduled.on_cron" }, { executor })).code).toBe("unknown_operation");
    const throwing = makeScheduledExecutor({
      listGoals: async () => {
        throw new Error("do down");
      },
    });
    const data = await dispatchScheduledA2A(ENV_NONE, { operation: "scheduled.list_goals" }, { executor: throwing.executor });
    expect(data).toMatchObject({ ok: false, code: "internal_error" });
  });
});

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

function makeResearchExecutor(overrides: Partial<ResearchA2AExecutor> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const executor: ResearchA2AExecutor = {
    runResearch: async (req) => {
      calls.push({ method: "runResearch", args: req });
      return { success: true, report: { id: "r1" } } as any;
    },
    runDiscovery: async (req) => {
      calls.push({ method: "runDiscovery", args: req });
      return { success: true, proposals: [], persisted: 0, limitations: [] } as any;
    },
    getLatest: async () => {
      calls.push({ method: "getLatest", args: undefined });
      return { id: "r1" } as any;
    },
    getHistory: async () => {
      calls.push({ method: "getHistory", args: undefined });
      return [{ runId: "r1" } as any];
    },
    getTrackRecord: async () => {
      calls.push({ method: "getTrackRecord", args: undefined });
      return { totalRuns: 2 } as any;
    },
    evaluateRun: async (runId, userLogin) => {
      calls.push({ method: "evaluateRun", args: { runId, userLogin } });
      return { runId } as any;
    },
    getResearchConfig: async () => {
      calls.push({ method: "getResearchConfig", args: undefined });
      return { version: 1 } as any;
    },
    ...overrides,
  };
  return { executor, calls };
}

describe("dispatchResearchA2A (#2223 final slice)", () => {
  it("research.run threads the service identity — never the method's \"default\" fallback, never a body-supplied login", async () => {
    const { executor, calls } = makeResearchExecutor();
    const data = await dispatchResearchA2A(
      ENV_SVC,
      { operation: "research.run", trigger: "manual", userLogin: "mallory" },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect((calls[0].args as any).userLogin).toBe("svc-user");
  });

  it("research.run and research.discovery fail closed (not_configured) with no service identity", async () => {
    const { executor, calls } = makeResearchExecutor();
    for (const operation of ["research.run", "research.discovery"]) {
      const data = await dispatchResearchA2A(ENV_NONE, { operation }, { executor });
      expect(data.ok, operation).toBe(false);
      expect(data.code, operation).toBe("not_configured");
    }
    expect(calls).toHaveLength(0);
  });

  it("a run the method reports as failed (success:false) surfaces as a failure", async () => {
    const { executor } = makeResearchExecutor({
      runResearch: async () => ({ success: false, report: null, error: "config invalid" }) as any,
    });
    const data = await dispatchResearchA2A(ENV_SVC, { operation: "research.run" }, { executor });
    expect(data.ok).toBe(false);
    expect(data.error).toContain("config invalid");
  });

  it("research.latest / history / track_record / config route without arguments", async () => {
    const { executor, calls } = makeResearchExecutor();
    for (const operation of ["research.latest", "research.history", "research.track_record", "research.config"]) {
      const data = await dispatchResearchA2A(ENV_SVC, { operation }, { executor });
      expect(data.ok, operation).toBe(true);
    }
    expect(calls.map((c) => c.method)).toEqual(["getLatest", "getHistory", "getTrackRecord", "getResearchConfig"]);
    expect(researchA2AOutcome(await dispatchResearchA2A(ENV_SVC, { operation: "research.latest" }, { executor })).text).toContain("latest research report");
  });

  it("research.evaluate requires runId and passes the service identity", async () => {
    const { executor, calls } = makeResearchExecutor();
    const bad = await dispatchResearchA2A(ENV_SVC, { operation: "research.evaluate" }, { executor });
    expect(bad.code).toBe("invalid_input");
    const data = await dispatchResearchA2A(ENV_SVC, { operation: "research.evaluate", runId: "r1" }, { executor });
    expect(data.ok).toBe(true);
    expect(calls[0].args).toEqual({ runId: "r1", userLogin: "svc-user" });
  });

  it("research.discovery passes discovery args through with the identity threaded", async () => {
    const { executor, calls } = makeResearchExecutor();
    const data = await dispatchResearchA2A(
      ENV_SVC,
      envelope({ operation: "research.discovery", trigger: "scheduled", symbols: ["NVDA"], ivRank: 42 }),
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(calls[0].args).toMatchObject({ trigger: "scheduled", symbols: ["NVDA"], ivRank: 42, userLogin: "svc-user" });
  });

  it("unknown operation is classified; executor throws never escape", async () => {
    const { executor } = makeResearchExecutor();
    expect((await dispatchResearchA2A(ENV_SVC, { operation: "research.run_sharded" }, { executor })).code).toBe("unknown_operation");
    const throwing = makeResearchExecutor({
      getLatest: async () => {
        throw new Error("orm down");
      },
    });
    const data = await dispatchResearchA2A(ENV_SVC, { operation: "research.latest" }, { executor: throwing.executor });
    expect(data).toMatchObject({ ok: false, code: "internal_error" });
  });
});

// ---------------------------------------------------------------------------
// Report asset
// ---------------------------------------------------------------------------

function makeReportAssetExecutor(overrides: Partial<ReportAssetA2AExecutor> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const executor: ReportAssetA2AExecutor = {
    generateAsset: async (req) => {
      calls.push({ method: "generateAsset", args: req });
      return { key: "report:pdf:screener:abc12345", fileName: "screener.pdf" };
    },
    getAsset: async (key) => {
      calls.push({ method: "getAsset", args: key });
      return { bytes: new Uint8Array([1, 2, 3, 250]), fileName: "screener.pdf" };
    },
    listAssets: async (limit) => {
      calls.push({ method: "listAssets", args: limit });
      return [
        { key: "report:pdf:screener:abc12345", fileName: "screener.pdf", storedAt: "2026-10-01T00:00:00.000Z" },
      ];
    },
    ...overrides,
  };
  return { executor, calls };
}

describe("dispatchReportAssetA2A (#2223 final slice)", () => {
  it("report_asset.generate routes with the service identity threaded as the request's user scope", async () => {
    const { executor, calls } = makeReportAssetExecutor();
    const data = await dispatchReportAssetA2A(
      ENV_SVC,
      { operation: "report_asset.generate", type: "screener", data: { rows: [] } },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(data.result).toEqual({ key: "report:pdf:screener:abc12345", fileName: "screener.pdf" });
    expect((calls[0].args as any).userLogin).toBe("svc-user");
    expect(reportAssetA2AOutcome(data).text).toContain("screener.pdf");
  });

  it("report_asset.generate validates the asset type and fails closed with no service identity", async () => {
    const { executor, calls } = makeReportAssetExecutor();
    const badType = await dispatchReportAssetA2A(
      ENV_SVC,
      { operation: "report_asset.generate", type: "memo", data: {} },
      { executor },
    );
    expect(badType.code).toBe("invalid_input");
    const noIdentity = await dispatchReportAssetA2A(
      ENV_NONE,
      { operation: "report_asset.generate", type: "screener", data: {} },
      { executor },
    );
    expect(noIdentity.code).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it("a null from generateAsset (the method's failure signal) is an honest failure, never a success", async () => {
    const { executor } = makeReportAssetExecutor({ generateAsset: async () => null });
    const data = await dispatchReportAssetA2A(
      ENV_SVC,
      { operation: "report_asset.generate", type: "research", data: {} },
      { executor },
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("generation_failed");
  });

  it("report_asset.get returns metadata + base64 bytes that round-trip exactly", async () => {
    const { executor } = makeReportAssetExecutor();
    const data = await dispatchReportAssetA2A(
      ENV_SVC,
      { operation: "report_asset.get", key: "report:pdf:screener:abc12345" },
      { executor },
    );
    expect(data.ok).toBe(true);
    const result = data.result as any;
    expect(result.fileName).toBe("screener.pdf");
    expect(result.byteLength).toBe(4);
    expect(Array.from(Buffer.from(result.bytesBase64, "base64"))).toEqual([1, 2, 3, 250]);
  });

  it("a null from getAsset is a not_found failure, not a success with empty bytes", async () => {
    const { executor } = makeReportAssetExecutor({ getAsset: async () => null });
    const data = await dispatchReportAssetA2A(ENV_SVC, { operation: "report_asset.get", key: "nope" }, { executor });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("not_found");
    expect(reportAssetA2AOutcome(data).text).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function makeBrowserExecutor(overrides: Partial<BrowserA2AExecutor> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const executor: BrowserA2AExecutor = {
    sendTransactionSnapToSlack: async (tx, options) => {
      calls.push({ method: "sendTransactionSnapToSlack", args: { tx, options } });
      return { success: true, transactionId: tx.transactionId, timestamp: "2026-10-29T00:00:00.000Z" } as any;
    },
    capturePageSnapshot: async (url, options) => {
      calls.push({ method: "capturePageSnapshot", args: { url, options } });
      return { success: true, url, timestamp: "2026-10-29T00:00:00.000Z" } as any;
    },
    scrapeTables: async (url) => {
      calls.push({ method: "scrapeTables", args: url });
      return { url, tables: [{ headers: ["A"], rows: [["1"]] }] } as any;
    },
    fetchWeb: async (url) => {
      calls.push({ method: "fetchWeb", args: url });
      return { success: true, url, finalUrl: url, status: 200, contentType: "text/plain", text: "page text", truncated: false, fetchedAt: "2026-10-29T00:00:00.000Z" } as any;
    },
    searchWeb: async (query, count) => {
      calls.push({ method: "searchWeb", args: { query, count } });
      return { provider: "duckduckgo", query, count: 0, results: [] } as any;
    },
    ...overrides,
  };
  return { executor, calls };
}

const TX = { transactionId: "t1", symbol: "NVDA", action: "BUY", quantity: 3, status: "filled" };

describe("dispatchBrowserA2A (#2223 final slice)", () => {
  it("browser.snap_transaction routes and STRIPS a caller-supplied webhookUrl", async () => {
    const { executor, calls } = makeBrowserExecutor();
    const data = await dispatchBrowserA2A(
      ENV_NONE,
      { operation: "browser.snap_transaction", transaction: TX, webhookUrl: "https://hooks.slack.com/evil", caption: "hi" },
      { executor },
    );
    expect(data.ok).toBe(true);
    const options = (calls[0].args as any).options;
    expect(options.webhookUrl).toBeUndefined();
    expect(options.caption).toBe("hi");
  });

  it("browser.snap_transaction requires a transaction with a symbol", async () => {
    const { executor } = makeBrowserExecutor();
    const bad = await dispatchBrowserA2A(ENV_NONE, { operation: "browser.snap_transaction", transaction: { transactionId: "t" } }, { executor });
    expect(bad.code).toBe("invalid_input");
  });

  it("a snap the service reports as undelivered (success:false) surfaces as a failure", async () => {
    const { executor } = makeBrowserExecutor({
      sendTransactionSnapToSlack: async () =>
        ({ success: false, error: "Not delivered: no Slack webhook URL or bot token is configured", timestamp: "2026-10-29T00:00:00.000Z" }) as any,
    });
    const data = await dispatchBrowserA2A(ENV_NONE, { operation: "browser.snap_transaction", transaction: TX }, { executor });
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Not delivered");
  });

  it("browser.capture_page requires a url and strips webhookUrl; browser.scrape_tables routes", async () => {
    const { executor, calls } = makeBrowserExecutor();
    const bad = await dispatchBrowserA2A(ENV_NONE, { operation: "browser.capture_page" }, { executor });
    expect(bad.code).toBe("invalid_input");
    const page = await dispatchBrowserA2A(
      ENV_NONE,
      { operation: "browser.capture_page", url: "https://example.com", webhookUrl: "https://hooks.slack.com/evil" },
      { executor },
    );
    expect(page.ok).toBe(true);
    expect((calls.find((c) => c.method === "capturePageSnapshot")!.args as any).options.webhookUrl).toBeUndefined();
    const scrape = await dispatchBrowserA2A(ENV_NONE, envelope({ operation: "browser.scrape_tables", url: "https://example.com" }), { executor });
    expect(scrape.ok).toBe(true);
    expect(browserA2AOutcome(scrape).text).toContain("1 table");
  });

  it("unknown operation is classified; executor throws never escape", async () => {
    const { executor } = makeBrowserExecutor();
    expect((await dispatchBrowserA2A(ENV_NONE, { operation: "browser.open" }, { executor })).code).toBe("unknown_operation");
    const throwing = makeBrowserExecutor({
      scrapeTables: async () => {
        throw new Error("browser binding down");
      },
    });
    const data = await dispatchBrowserA2A(ENV_NONE, { operation: "browser.scrape_tables", url: "https://x.example" }, { executor: throwing.executor });
    expect(data).toMatchObject({ ok: false, code: "internal_error" });
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

function makeSlackExecutor(overrides: Partial<SlackA2AExecutor> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const executor: SlackA2AExecutor = {
    sendPreTradeApprovalTicket: async (draft, options) => {
      calls.push({ method: "sendPreTradeApprovalTicket", args: { draft, options } });
      return { success: true, payload: { text: "ticket" } as any, orderId: draft.orderId };
    },
    dispatchTransactionSnap: async (tx, options) => {
      calls.push({ method: "dispatchTransactionSnap", args: { tx, options } });
      return { success: true, transactionId: tx.transactionId, timestamp: "2026-10-29T00:00:00.000Z" } as any;
    },
    ...overrides,
  };
  return { executor, calls };
}

const DRAFT = { orderId: "o1", symbol: "NVDA", action: "BUY", quantity: 3 };

describe("dispatchSlackA2A (#2223 final slice)", () => {
  it("slack.send_pre_trade_approval routes a validated draft and strips webhookUrl", async () => {
    const { executor, calls } = makeSlackExecutor();
    const data = await dispatchSlackA2A(
      ENV_NONE,
      { operation: "slack.send_pre_trade_approval", draft: DRAFT, webhookUrl: "https://hooks.slack.com/evil", channel: "C1" },
      { executor },
    );
    expect(data.ok).toBe(true);
    const { draft, options } = calls[0].args as any;
    expect(draft).toMatchObject(DRAFT);
    expect(options.webhookUrl).toBeUndefined();
    expect(options.channel).toBe("C1");
    expect(slackA2AOutcome(data).text).toContain("o1");
  });

  it("slack.send_pre_trade_approval rejects a draft with an unknown action or missing fields", async () => {
    const { executor } = makeSlackExecutor();
    const badAction = await dispatchSlackA2A(
      ENV_NONE,
      { operation: "slack.send_pre_trade_approval", draft: { ...DRAFT, action: "HOLD" } },
      { executor },
    );
    expect(badAction.code).toBe("invalid_input");
    const missing = await dispatchSlackA2A(ENV_NONE, { operation: "slack.send_pre_trade_approval", draft: { symbol: "NVDA" } }, { executor });
    expect(missing.code).toBe("invalid_input");
  });

  it("a ticket the service reports as failed (success:false) surfaces as a failure", async () => {
    const { executor } = makeSlackExecutor({
      sendPreTradeApprovalTicket: async () => ({ success: false, payload: { text: "x" } as any, orderId: "o1" }),
    });
    const data = await dispatchSlackA2A(ENV_NONE, { operation: "slack.send_pre_trade_approval", draft: DRAFT }, { executor });
    expect(data.ok).toBe(false);
  });

  it("slack.dispatch_transaction_snap routes and strips webhookUrl", async () => {
    const { executor, calls } = makeSlackExecutor();
    const data = await dispatchSlackA2A(
      ENV_NONE,
      envelope({ operation: "slack.dispatch_transaction_snap", transaction: TX, webhookUrl: "https://hooks.slack.com/evil" }),
      { executor },
    );
    expect(data.ok).toBe(true);
    expect((calls[0].args as any).options.webhookUrl).toBeUndefined();
  });

  it("the Slack ingress (onRequest) is NOT an A2A operation", async () => {
    const { executor } = makeSlackExecutor();
    for (const operation of ["slack.post_message", "slack.events", "slack.slash_command"]) {
      const data = await dispatchSlackA2A(ENV_NONE, { operation }, { executor });
      expect(data.code, operation).toBe("unknown_operation");
    }
  });

  it("executor throws never escape", async () => {
    const { executor } = makeSlackExecutor({
      dispatchTransactionSnap: async () => {
        throw new Error("slack down");
      },
    });
    const data = await dispatchSlackA2A(ENV_NONE, { operation: "slack.dispatch_transaction_snap", transaction: TX }, { executor });
    expect(data).toMatchObject({ ok: false, code: "internal_error" });
  });
});

// ---------------------------------------------------------------------------
// Anti-drift: cards advertise exactly what the dispatches serve
// ---------------------------------------------------------------------------

describe("cards == served operations for the six agents (#2223 final slice)", () => {
  const cases: Array<[string, readonly string[]]> = [
    ["screener", SCREENER_A2A_OPERATIONS],
    ["scheduled", SCHEDULED_A2A_OPERATIONS],
    ["research", RESEARCH_A2A_OPERATIONS],
    ["report-asset", REPORT_ASSET_A2A_OPERATIONS],
    ["browser", BROWSER_A2A_OPERATIONS],
    ["slack", SLACK_A2A_OPERATIONS],
  ];
  for (const [name, operations] of cases) {
    it(`${name}: card exists and its operations equal the dispatch's served set`, () => {
      const card = getAgentCard(name);
      expect(card, name).toBeDefined();
      expect([...card!.operations].sort()).toEqual([...operations].sort());
      expect(card!.endpoint).toBe(`/a2a/${name}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Resolution: the six names land on the survey's instances
// ---------------------------------------------------------------------------

describe("resolution for the six agents (#2223 final slice)", () => {
  it("screener → SCREENER_AGENT on \"default\" with a service identity; fail-closed (null) without one", () => {
    const resolution = resolveA2AAgent("screener");
    expect(resolution!.binding).toBe("SCREENER_AGENT");
    expect(resolveA2AInstanceName(resolution!, "screener", ENV_SVC)).toBe("default");
    expect(resolveA2AInstanceName(resolution!, "screener", ENV_NONE)).toBeNull();
  });

  it("research → RESEARCH_AGENT on research:<service-login>; fail-closed (null) without one — never a \"default\" login", () => {
    const resolution = resolveA2AAgent("research");
    expect(resolution!.binding).toBe("RESEARCH_AGENT");
    expect(resolveA2AInstanceName(resolution!, "research", ENV_SVC)).toBe("research:svc-user");
    expect(resolveA2AInstanceName(resolution!, "research", ENV_NONE)).toBeNull();
  });

  it("report-asset (hyphenated key) → REPORT_ASSET_AGENT on \"default\"", () => {
    const resolution = resolveA2AAgent("report-asset");
    expect(resolution!.binding).toBe("REPORT_ASSET_AGENT");
    expect(resolveA2AInstanceName(resolution!, "report-asset", ENV_SVC)).toBe("default");
  });

  it("browser and slack keep URL-name parity on their bindings (stateless / env-driven)", () => {
    const browser = resolveA2AAgent("browser");
    expect(browser!.binding).toBe("BROWSER_AGENT");
    expect(resolveA2AInstanceName(browser!, "browser", ENV_NONE)).toBe("browser");
    const slack = resolveA2AAgent("slack");
    expect(slack!.binding).toBe("SLACK_AGENT");
    expect(resolveA2AInstanceName(slack!, "slack", ENV_NONE)).toBe("slack");
  });
});

// ---------------------------------------------------------------------------
// Entrypoint: the newly-served names reach their stubs through the real
// edge dispatcher (src/a2a/index) instead of 404ing.
// ---------------------------------------------------------------------------

function makeEntrypointEnv(extra: Record<string, unknown> = {}) {
  const idFromNameCalls: Array<{ binding: string; name: string }> = [];
  const namespace = (binding: string) => ({
    idFromName: (name: string) => {
      idFromNameCalls.push({ binding, name });
      return { name };
    },
    get: (_id: { name: string }) => ({
      handleA2A: async () => ({ text: "ok", data: { ok: true } }),
    }),
  });
  const env: Record<string, unknown> = {
    A2A_API_TOKEN: "test-token",
    SCREENER_AGENT: namespace("SCREENER_AGENT"),
    SCHEDULED_AGENT: namespace("SCHEDULED_AGENT"),
    RESEARCH_AGENT: namespace("RESEARCH_AGENT"),
    REPORT_ASSET_AGENT: namespace("REPORT_ASSET_AGENT"),
    BROWSER_AGENT: namespace("BROWSER_AGENT"),
    SLACK_AGENT: namespace("SLACK_AGENT"),
    ...extra,
  };
  return { env, idFromNameCalls };
}

const postEntrypoint = (path: string, env: Record<string, unknown>) =>
  handleA2A(
    new Request(`https://agent.example${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "message/send", params: { message: { parts: [{ kind: "data", data: { operation: "x.y" } }] } } }),
    }),
    env,
  );

describe("entrypoint: six names reach their stubs (#2223 final slice)", () => {
  it("report-asset reaches REPORT_ASSET_AGENT on \"default\" (hyphenated name, end to end)", async () => {
    const { env, idFromNameCalls } = makeEntrypointEnv();
    const res = await postEntrypoint("/a2a/report-asset", env);
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual([{ binding: "REPORT_ASSET_AGENT", name: "default" }]);
  });

  it("screener reaches SCREENER_AGENT on \"default\" when a service identity is configured", async () => {
    const { env, idFromNameCalls } = makeEntrypointEnv({ SERVICE_USER_LOGIN: "svc-user" });
    const res = await postEntrypoint("/a2a/screener", env);
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual([{ binding: "SCREENER_AGENT", name: "default" }]);
  });

  it("screener and research fail honestly (500, not-configured) with no service identity — no virgin instance is started", async () => {
    const { env, idFromNameCalls } = makeEntrypointEnv();
    for (const path of ["/a2a/screener", "/a2a/research"]) {
      const res = await postEntrypoint(path, env);
      expect(res.status, path).toBe(500);
      const body = (await res.json()) as any;
      expect(body.error.code, path).toBe(-32003);
    }
    expect(idFromNameCalls).toHaveLength(0);
  });

  it("research reaches RESEARCH_AGENT on research:<login>; scheduled/browser/slack reach their stubs", async () => {
    const { env, idFromNameCalls } = makeEntrypointEnv({ SERVICE_USER_LOGIN: "svc-user" });
    expect((await postEntrypoint("/a2a/research", env)).status).toBe(200);
    expect((await postEntrypoint("/a2a/scheduled", env)).status).toBe(200);
    expect((await postEntrypoint("/a2a/browser", env)).status).toBe(200);
    expect((await postEntrypoint("/a2a/slack", env)).status).toBe(200);
    expect(idFromNameCalls).toEqual([
      { binding: "RESEARCH_AGENT", name: "research:svc-user" },
      { binding: "SCHEDULED_AGENT", name: "default" },
      { binding: "BROWSER_AGENT", name: "browser" },
      { binding: "SLACK_AGENT", name: "slack" },
    ]);
  });
});
