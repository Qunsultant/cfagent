/**
 * Issue #3179 (ScheduledAgent sites): the tick-wide tenant context
 * in ScheduledAgent is threaded in by the caller when one exists
 * (opts.tenantId); otherwise the deployment default is used —
 * resolved explicitly via resolveIaaaTenant and LOGGED, never a
 * silent hardcoded "primary" literal.
 *
 * Covered here:
 * - onCron's halt read receives the threaded tenant when supplied,
 *   else the env default, else the documented default — and the
 *   fallback is logged exactly when no tenant was threaded.
 * - fireSynthesizedSchedule, the sibling one-shot path with the
 *   same halt resolution, behaves identically.
 * - projectSynthesized stamps the projection (tenant + workspace,
 *   mirroring the codebase convention) with the env default and
 *   logs the fallback; the record carries no owner, so per-record
 *   owner derivation is a schema change, not made here.
 *
 * Harness: the MockAgent pattern of
 * tests/chain_firing_scheduled_agent.test.ts, with the structured
 * logger and the chain-schedule projection seam mocked per-file
 * (vi.mock), so no other suite is affected. onCron is driven with
 * an empty preloaded snapshot so the test isolates the halt-read
 * tenant without firing any goal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const logCalls = vi.hoisted(
  () => [] as Array<{ level: string; event: string; fields: unknown }>,
);

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

vi.mock("../src/observability/structuredLogger", () => {
  const logger: any = {
    info: (event: string, fields?: unknown) => {
      logCalls.push({ level: "info", event, fields });
    },
    warn: (event: string, fields?: unknown) => {
      logCalls.push({ level: "warn", event, fields });
    },
    error: (event: string, fields?: unknown) => {
      logCalls.push({ level: "error", event, fields });
    },
    debug: (event: string, fields?: unknown) => {
      logCalls.push({ level: "debug", event, fields });
    },
    trace: (event: string, fields?: unknown) => {
      logCalls.push({ level: "trace", event, fields });
    },
  };
  logger.child = () => logger;
  return { createStructuredLogger: () => logger };
});

vi.mock("../src/data/createChainSchedulePorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/createChainSchedulePorts")>();
  return {
    ...actual,
    projectAfterTransition: vi.fn(async () => ({ projected: true })),
  };
});

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { compileGoal } from "../src/orchestrate";
import { projectAfterTransition } from "../src/data/createChainSchedulePorts";

const DEPLOY_DEFAULT = "deploy-default-tenant";
const FALLBACK_EVENT = "scheduledAgent.tick_tenant_env_fallback";

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    store,
    ctx: {
      storage: {
        get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
        put: async (k: string, v: unknown) => void store.set(k, v),
      },
    },
  };
}

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({
        budgetCheck: async () => ({ allowed: true }),
      }),
    },
    ...extra,
  } as any;
}

/** Cron due in the current UTC hour, so isDue passes regardless of when the test runs. */
function dueCron() {
  const now = new Date();
  return `0 ${now.getUTCHours()} * * *`;
}

function fallbackLogs(site: string) {
  return logCalls.filter(
    (c) => c.event === FALLBACK_EVENT && (c.fields as any)?.site === site,
  );
}

describe("ScheduledAgent tick tenant (#3179)", () => {
  beforeEach(() => {
    logCalls.length = 0;
    vi.mocked(projectAfterTransition).mockClear();
  });

  it("onCron halt read uses the threaded tenant when supplied, with no fallback log", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv({ IAAA_TENANT_ID: DEPLOY_DEFAULT }));
    const seen: string[] = [];
    await agent.onCron({
      haltReader: { isHalted: async (tenantId: string) => void seen.push(tenantId) || false },
      tenantId: "threaded-tenant",
      preloadedGoals: { goals: [], records: [] },
    });
    expect(seen).toEqual(["threaded-tenant"]);
    expect(fallbackLogs("onCron")).toHaveLength(0);
  });

  it("onCron halt read falls back to the env default, logged explicitly", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv({ IAAA_TENANT_ID: DEPLOY_DEFAULT }));
    const seen: string[] = [];
    await agent.onCron({
      haltReader: { isHalted: async (tenantId: string) => void seen.push(tenantId) || false },
      preloadedGoals: { goals: [], records: [] },
    });
    expect(seen).toEqual([DEPLOY_DEFAULT]);
    const logs = fallbackLogs("onCron");
    expect(logs).toHaveLength(1);
    expect((logs[0].fields as any)?.tenantId).toBe(DEPLOY_DEFAULT);
  });

  it("onCron halt read with env unset uses the documented default, logged explicitly", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const seen: string[] = [];
    await agent.onCron({
      haltReader: { isHalted: async (tenantId: string) => void seen.push(tenantId) || false },
      preloadedGoals: { goals: [], records: [] },
    });
    expect(seen).toEqual(["primary"]);
    expect(fallbackLogs("onCron")).toHaveLength(1);
  });

  it("fireSynthesizedSchedule halt read falls back to the env default, logged explicitly", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv({ IAAA_TENANT_ID: DEPLOY_DEFAULT }));
    // Worked example 2 compiles to a one-shot chain — the direct
    // fire path refuses recurring records (they fire via onCron).
    const chain = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-3179-fire" });
    await agent.approveSynthesizedSchedule("synth-3179-fire");
    logCalls.length = 0;
    const seen: string[] = [];
    const fired = await agent.fireSynthesizedSchedule("synth-3179-fire", {
      haltReader: { isHalted: async (tenantId: string) => void seen.push(tenantId) || false },
    });
    expect(fired.fired).toBe(true);
    expect(seen).toEqual([DEPLOY_DEFAULT]);
    const logs = fallbackLogs("fireSynthesizedSchedule");
    expect(logs).toHaveLength(1);
    expect((logs[0].fields as any)?.tenantId).toBe(DEPLOY_DEFAULT);
  });

  it("projection stamps tenant + workspace with the env default, logged explicitly", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv({ IAAA_TENANT_ID: DEPLOY_DEFAULT }));
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-3179-proj", cron: dueCron() });
    expect(projectAfterTransition).toHaveBeenCalledTimes(1);
    const input = vi.mocked(projectAfterTransition).mock.calls[0][1] as any;
    expect(input.tenantId).toBe(DEPLOY_DEFAULT);
    expect(input.workspaceId).toBe(DEPLOY_DEFAULT);
    expect(input.record.id).toBe("synth-3179-proj");
    const logs = fallbackLogs("projectSynthesized");
    expect(logs).toHaveLength(1);
    expect((logs[0].fields as any)?.tenantId).toBe(DEPLOY_DEFAULT);
  });

  it("projection with env unset stamps the documented default, logged explicitly", async () => {
    const { ctx } = makeCtx();
    const agent = new (ScheduledAgent as any)(ctx, makeEnv());
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-3179-proj-unset", cron: dueCron() });
    const input = vi.mocked(projectAfterTransition).mock.calls[0][1] as any;
    expect(input.tenantId).toBe("primary");
    expect(input.workspaceId).toBe("primary");
    expect(fallbackLogs("projectSynthesized")).toHaveLength(1);
  });
});
