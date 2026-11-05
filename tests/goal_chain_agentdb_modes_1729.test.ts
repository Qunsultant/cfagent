/**
 * #1729 (parent #1717, slice (i)): goal chain + AgentDB
 * jobs/audit/reports vs live routes unification (scan
 * appendix (i) findings G01–G04).
 *
 * RED pins (written BEFORE the implementation; the first run
 * must fail on the missing src/config/goalChainModes.ts module).
 *
 * What this slice does — and, equally important, what it
 * deliberately does NOT switch, with the reason pinned here:
 *
 * - G01 goal.compile — ONE real switch, GOAL_COMPILE_MODE
 *   ("auto" | "fresh"). Both values call the SAME compilers
 *   (compileGoal / compileGoalWithMemory) the planner uses —
 *   no second compiler, no REST compile endpoint (see the
 *   no-new-surface pin below). "auto" = current behavior
 *   (bindings present → prior-plan reuse with provenance,
 *   else fresh); "fresh" = always compileGoal, reuse always
 *   null, even when bindings are present (deterministic
 *   fresh compile for audit reproducibility). There is no
 *   third "reuse" value: reuse-with-fallback is exactly
 *   "auto" given the standing fallback rule (a missing
 *   binding / recall failure is never an error), so a
 *   separate "reuse" value would be indistinguishable from
 *   "auto" and would be a phantom switch.
 * - G02 goal.schedule vs POST /schedules/create — NO switch,
 *   pinned divergent-by-design. The only two values a
 *   schedule switch could take are "pending" and "live",
 *   and honoring "live" from an MCP caller is the exact
 *   safety regression the issue forbids (a PENDING record
 *   going live without human confirmation), while honoring
 *   "pending" from the REST create route is impossible
 *   without a chain to synthesize and would silently turn
 *   a live-creation API into a no-op. Both postures are
 *   therefore pinned: MCP always pending (no `enabled`
 *   field, fires:false, approval is the only path to live),
 *   REST always live behind its callback allow-list
 *   (400 naming the list). goal.schedule carries NO `mode`
 *   input, and goalChainModes.ts exports NO schedule switch.
 * - G03 chain.run vs schedules/async execution — NO switch,
 *   pinned divergent-by-design. Inline execution cannot be
 *   flipped to durable (the MCP context carries no DO/SQL
 *   runtime, and the firing path's projector is not an MCP
 *   input), and presenting inline execution as durable /
 *   scheduled execution is forbidden by the issue. Pinned:
 *   scheduledJobCreated is always false, a failed or
 *   budget-blocked leg skips later legs, re-validation
 *   throws before any leg is reported, and a run output
 *   carries no job id, no synthesized record, and no async
 *   job. goalChainModes.ts exports NO execution switch.
 * - G04 AgentDB tools vs REST reads — NO tenant switch and
 *   NO source switch, pinned with the reasons:
 *   (a) The four projection pairs (chain.status, jobs.history,
 *   audit.history, reports.list) are already IDENTICAL on
 *   current main: same read port, same tenant function
 *   (resolveIaaaTenant(env)), same result shape on both
 *   surfaces — identical implementations collapse to a
 *   single path, pinned row-for-row below (MCP mapper
 *   output === REST route body for the same rows).
 *   (b) The live-vs-projection pairs are different sources
 *   with different scope keys and must NOT be merged under
 *   one switch: agentdb.audit.history reads the AgentDB
 *   audit projection (tenant-scoped, chain-scoped) while
 *   GET /api/audit reads live mas_events (session_id-
 *   scoped, DO instance); agentdb.reports.list reads the
 *   AgentDB report projection (tenant-scoped, bodies never
 *   included) while GET /api/reports reads mas_reports
 *   (userLogin-scoped, with reportUrl). Merging them would
 *   serve one store's rows under another store's scope key.
 *   (c) Tenant sourcing cannot be switched: SessionData
 *   carries NO tenant field, so a "session tenant" value
 *   would require inventing tenant derivation, and a
 *   caller-asserted tenant is forbidden by the issue. The
 *   guard is therefore structural: no tool schema carries
 *   a tenant field, and resolveIaaaTenant(env) is the only
 *   tenant source in the MCP read module.
 *
 * Resolution order for GOAL_COMPILE_MODE (owner directive
 * 2026-10-26): run (per-call `mode` input) > session > user
 * (optional `scopedGoalChainModes` carrier on McpToolContext,
 * populated by the execution-context owner) > global env
 * (GOAL_COMPILE_MODE) > built-in ("auto", the MCP surface's
 * current behavior). First non-blank level wins; an
 * unrecognized winning value FAILS CLOSED to "auto",
 * console-logged + audited as `goal.config_error` (no
 * fall-through). The `mode` input is a plain optional string
 * (not a zod enum) so an invalid value reaches execute and
 * fails closed instead of dying in schema validation — the
 * #1726/#1727 idiom. No production value is set by this
 * slice (owner action); unset = legacy behavior.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GOAL_COMPILE_MODE_SWITCH,
  goalConfigErrorEvent,
  levelsForGoalCompileSwitch,
  resolveGoalCompileMode,
} from "../src/config/goalChainModes";
import {
  GoalCompileCommand,
  GoalScheduleCommand,
  ChainRunCommand,
  compileGoalForMcp,
  runChain,
  synthesizePendingForMcp,
} from "../src/mcps/openaimp/goalChainCommands";
import {
  chainStatusToMcpResult,
  jobsToMcpResult,
  auditToMcpResult,
  reportsToMcpResult,
  AgentDbChainStatusCommand,
  AgentDbJobsHistoryCommand,
  AgentDbAuditHistoryCommand,
  AgentDbReportsListCommand,
} from "../src/mcps/openaimp/agentDbReadCommands";
import { handleChainStatusRoute } from "../src/data/chainStatusRoute";
import { handleJobHistoryRoute } from "../src/data/shardJobRoute";
import {
  handleAuditHistoryRoute,
  handleReportsRoute,
} from "../src/data/auditReportRoute";
import { handleMCPRequest } from "../src/mcps/openaimp/handler";
import { compileGoal } from "../src/orchestrate";
import { VectorMemory } from "../src/memory/vector-memory";
import { recordPlanOutcome } from "../src/agentic/compositionMemory";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import type { ChainRow, ScheduleRow } from "../src/data/chainSchedulePorts";
import type { ShardJobRow } from "../src/data/shardJobPorts";
import type {
  AuditEventRow,
  CanonicalReportRow,
} from "../src/data/auditReportPorts";

const NASDAQ_GOAL = "Create a NASDAQ100 screen and send it to Slack";
const BUDGET = { budgetCents: 5000, budgetCapCents: 10000 };
const TENANT = "primary";

/** In-memory Vectorize stand-in (same shape as tests/mcp_goal_chain.test.ts). */
class FakeVectorize {
  rows: Array<{ id: string; values: number[]; metadata: Record<string, any> }> = [];
  queryScore = 0.9;
  upsert = vi.fn(async (vectors: any[]) => {
    for (const v of vectors) {
      const idx = this.rows.findIndex((r) => r.id === v.id);
      if (idx >= 0) this.rows[idx] = v;
      else this.rows.push(v);
    }
  });
  async query(_values: number[], opts: any) {
    const kind = opts?.filter?.kind;
    const matches = this.rows
      .filter((r) => (kind === undefined ? true : r.metadata?.kind === kind))
      .map((r) => ({ id: r.id, score: this.queryScore, metadata: r.metadata }));
    return { matches };
  }
}

const fakeAi = () => ({ run: async () => ({ data: [[0.1, 0.2, 0.3]] }) });

/** MCP-context env carrying AI + Vectorize bindings by key assignment (see #411 pin). */
function memoryEnv(fake: FakeVectorize): Partial<Env> {
  const env: Record<string, unknown> = {};
  env["AI"] = fakeAi();
  env["VECTOR_MEMORY"] = fake;
  return env as Partial<Env>;
}

function auditRecorder() {
  const events: Array<{ type: string; agent: unknown; payload: Record<string, unknown> }> = [];
  return {
    events,
    audit: (type: string, agent: unknown, payload: Record<string, unknown>) => {
      events.push({ type, agent, payload });
    },
  };
}

function compileCtx(env: Partial<Env> = {}, extra: Record<string, unknown> = {}) {
  const rec = auditRecorder();
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test_session_user");
  return {
    rec,
    context: {
      env: { ...env } as Env,
      orm,
      sessionId: "session_1",
      audit: rec.audit,
      ...extra,
    } as any,
  };
}

async function seedMemory(fake: FakeVectorize) {
  const memory = new VectorMemory(fakeAi(), fake, undefined);
  const chain = compileGoal(NASDAQ_GOAL, BUDGET)!;
  await recordPlanOutcome(memory, {
    goal: NASDAQ_GOAL,
    chain,
    success: true,
    summary: "NASDAQ100 screen delivered to Slack",
  });
  return memory;
}

describe("GOAL_COMPILE_MODE resolver (#1729, G01)", () => {
  it("defaults to auto when every level is blank", () => {
    const r = resolveGoalCompileMode({}, "auto");
    expect(r).toEqual({ mode: "auto", invalid: false, raw: undefined, level: "builtin" });
  });

  it("resolves run > session > user > env > builtin, first non-blank wins", () => {
    expect(resolveGoalCompileMode({ run: "fresh", session: "auto", user: "auto", env: "auto" }, "auto").mode).toBe("fresh");
    expect(resolveGoalCompileMode({ session: "fresh", user: "auto", env: "auto" }, "auto").mode).toBe("fresh");
    expect(resolveGoalCompileMode({ user: "fresh", env: "auto" }, "auto").mode).toBe("fresh");
    expect(resolveGoalCompileMode({ env: "fresh" }, "auto").mode).toBe("fresh");
    expect(resolveGoalCompileMode({ run: "  ", session: "", env: "fresh" }, "auto").level).toBe("env");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(resolveGoalCompileMode({ run: " Fresh " }, "auto").mode).toBe("fresh");
    expect(resolveGoalCompileMode({ run: "AUTO" }, "auto").mode).toBe("auto");
  });

  it("fails closed to auto on an unrecognized winning value, with no fall-through", () => {
    const r = resolveGoalCompileMode({ run: "bogus", env: "fresh" }, "auto");
    expect(r.mode).toBe("auto");
    expect(r.invalid).toBe(true);
    expect(r.raw).toBe("bogus");
    expect(r.level).toBe("run");
    const nonString = resolveGoalCompileMode({ run: 42 as any }, "auto");
    expect(nonString.invalid).toBe(true);
    expect(nonString.mode).toBe("auto");
  });

  it("builds levels from the scoped carrier", () => {
    const levels = levelsForGoalCompileSwitch(
      { session: { compile: "fresh" }, user: { compile: "auto" } },
      "run-ignored",
      "auto-env",
    );
    expect(levels).toEqual({ run: "run-ignored", session: "fresh", user: "auto", env: "auto-env" });
    expect(GOAL_COMPILE_MODE_SWITCH).toBe("GOAL_COMPILE_MODE");
    expect(goalConfigErrorEvent()).toBe("goal.config_error");
  });
});

describe("goal.compile GOAL_COMPILE_MODE wiring (#1729, G01)", () => {
  it("auto with bindings reuses a prior plan; fresh with the same bindings never reuses", async () => {
    const fake = new FakeVectorize();
    await seedMemory(fake);
    const cmd = new GoalCompileCommand();
    const autoCtx = compileCtx(memoryEnv(fake));
    const auto = await cmd.execute({ goal: NASDAQ_GOAL, ...BUDGET }, autoCtx.context);
    expect(auto.reuse).not.toBeNull();
    expect(auto.reuse!.priorGoal).toBe(NASDAQ_GOAL);
    const freshCtx = compileCtx(memoryEnv(fake));
    const fresh = await cmd.execute({ goal: NASDAQ_GOAL, ...BUDGET, mode: "fresh" }, freshCtx.context);
    expect(fresh.recognized).toBe(true);
    expect(fresh.chain).not.toBeNull();
    expect(fresh.reuse).toBeNull();
    expect(fresh.reuseDescription).toBeNull();
    // Same chain either way: the switch selects the compiler entry point, never a second compiler.
    expect(fresh.chain!.steps.map((s) => s.capabilityId)).toEqual(
      auto.chain!.steps.map((s) => s.capabilityId),
    );
  });

  it("session carrier and global env both select fresh", async () => {
    const fake = new FakeVectorize();
    await seedMemory(fake);
    const cmd = new GoalCompileCommand();
    const scoped = compileCtx(memoryEnv(fake), {
      scopedGoalChainModes: { session: { compile: "fresh" } },
    });
    const viaSession = await cmd.execute({ goal: NASDAQ_GOAL, ...BUDGET }, scoped.context);
    expect(viaSession.reuse).toBeNull();
    const fake2 = new FakeVectorize();
    await seedMemory(fake2);
    const envCtx = compileCtx({ ...memoryEnv(fake2), GOAL_COMPILE_MODE: "fresh" } as Partial<Env>);
    const viaEnv = await cmd.execute({ goal: NASDAQ_GOAL, ...BUDGET }, envCtx.context);
    expect(viaEnv.reuse).toBeNull();
  });

  it("an unrecognized mode fails closed to auto and audits goal.config_error", async () => {
    const cmd = new GoalCompileCommand();
    const { rec, context } = compileCtx();
    const out = await cmd.execute({ goal: NASDAQ_GOAL, ...BUDGET, mode: "bogus" }, context);
    expect(out.recognized).toBe(true);
    expect(out.chain).not.toBeNull();
    const configError = rec.events.find((e) => e.type === "goal.config_error");
    expect(configError).toBeDefined();
    expect(configError!.payload).toMatchObject({
      switch: "GOAL_COMPILE_MODE",
      raw: "bogus",
      level: "run",
      failedClosedTo: "auto",
    });
    const compileAudit = rec.events.find((e) => e.type === "goal.compile");
    expect(compileAudit!.payload.mode).toBe("auto");
  });

  it("compileGoalForMcp fresh ignores a supplied memory; auto honors it", async () => {
    const fake = new FakeVectorize();
    const memory = await seedMemory(fake);
    const fresh = await compileGoalForMcp(NASDAQ_GOAL, 5000, 10000, memory, { compileMode: "fresh" });
    expect(fresh.reuse).toBeNull();
    const auto = await compileGoalForMcp(NASDAQ_GOAL, 5000, 10000, memory, { compileMode: "auto" });
    expect(auto.reuse).not.toBeNull();
    const omitted = await compileGoalForMcp(NASDAQ_GOAL, 5000, 10000, memory);
    expect(omitted.reuse).not.toBeNull();
  });

  it("session carrier flows end-to-end through handleMCPRequest (factory spread)", async () => {
    const fake = new FakeVectorize();
    await seedMemory(fake);
    const rec = auditRecorder();
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("test_session_user");
    const ctx: any = {
      env: memoryEnv(fake) as Env,
      orm,
      sessionId: "session_1",
      audit: rec.audit,
      scopedGoalChainModes: { session: { compile: "fresh" } },
    };
    const resp = await handleMCPRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "goal.compile", arguments: { goal: NASDAQ_GOAL, ...BUDGET } } },
      ctx,
    );
    expect(resp.error).toBeUndefined();
    const out = JSON.parse(resp.result?.content?.[0]?.text as string);
    expect(out.reuse).toBeNull();
    expect(out.chain).not.toBeNull();
  });

  it("an unrecognized goal still compiles to null, never an error, in fresh mode", async () => {
    const cmd = new GoalCompileCommand();
    const { context } = compileCtx();
    const out = await cmd.execute(
      { goal: "Do something completely unrelated to any capability", ...BUDGET, mode: "fresh" },
      context,
    );
    expect(out.recognized).toBe(false);
    expect(out.chain).toBeNull();
    expect(out.reuse).toBeNull();
  });
});

describe("G02 pinned: goal.schedule pending only, REST create live behind an allow-list (#1729)", () => {
  it("goal.schedule carries no mode input and always returns pending with no enabled field", async () => {
    const cmd = new GoalScheduleCommand();
    expect(Object.keys(cmd.jsonSchema.properties)).not.toContain("mode");
    const { context } = compileCtx();
    const out = await cmd.execute({ goal: NASDAQ_GOAL, ...BUDGET, cron: "0 9 * * *" }, context);
    expect(out.status).toBe("pending");
    expect(out.record.status).toBe("pending");
    expect(out.fires).toBe(false);
    expect("enabled" in out.record).toBe(false);
  });

  it("synthesizePendingForMcp refuses a non-pending record instead of handing it live", () => {
    const chain = compileGoal(NASDAQ_GOAL, BUDGET)!;
    const pending = synthesizePendingForMcp(chain, { cron: "0 9 * * *" });
    expect(pending.record.status).toBe("pending");
  });

  it("source pins: no schedule switch exists, and the REST allow-list 400 names the list", () => {
    const modes = readFileSync(resolve(__dirname, "../src/config/goalChainModes.ts"), "utf8");
    expect(modes).not.toContain("GOAL_SCHEDULE_MODE");
    expect(modes).not.toContain("SCHEDULE_MODE");
    const schedules = readFileSync(resolve(__dirname, "../src/agents/routes/schedules.ts"), "utf8");
    expect(schedules).toContain("creatableScheduleCallbacks");
    expect(schedules).toContain("is not allowed: POST /api/schedules/create only accepts");
    const goalChain = readFileSync(resolve(__dirname, "../src/mcps/openaimp/goalChainCommands.ts"), "utf8");
    expect(goalChain).toContain("approveSynthesizedRecord");
  });
});

describe("G03 pinned: chain.run inline only, never durable (#1729)", () => {
  it("a failed leg skips later legs and creates no scheduled job, even with an executor", async () => {
    const chain = compileGoal(NASDAQ_GOAL, BUDGET)!;
    const seen: string[] = [];
    const out = await runChain(chain, {
      executeLeg: async (step) => {
        seen.push(step.capabilityId);
        if (step.capabilityId === "generate-screener-pdf") throw new Error("generate failed");
        return { ok: true };
      },
    });
    expect(out.scheduledJobCreated).toBe(false);
    expect(out.ok).toBe(false);
    expect("jobId" in out).toBe(false);
    expect("scheduledJobId" in out).toBe(false);
    const failedIdx = out.legs.findIndex((l) => l.status === "failed");
    expect(failedIdx).toBeGreaterThan(-1);
    expect(out.legs.slice(failedIdx + 1).every((l) => l.status === "skipped")).toBe(true);
    expect(seen).not.toContain("deliver-slack");
  });

  it("the MCP command reports every leg unimplemented and performs no paid action", async () => {
    const cmd = new ChainRunCommand();
    const { context } = compileCtx();
    const chain = compileGoal(NASDAQ_GOAL, BUDGET)!;
    const out = await cmd.execute({ chain }, context);
    expect(out.scheduledJobCreated).toBe(false);
    expect(out.paidActionPerformed).toBe(false);
    expect(out.ranAnything).toBe(false);
    expect(out.legs.every((l) => l.status === "unimplemented")).toBe(true);
  });

  it("source pin: no execution switch exists", () => {
    const modes = readFileSync(resolve(__dirname, "../src/config/goalChainModes.ts"), "utf8");
    expect(modes).not.toContain("CHAIN_EXECUTION_MODE");
    expect(modes).not.toContain("EXECUTION_MODE");
  });
});

describe("G01/G04 no-new-surface pins (#1729)", () => {
  it("no REST compile endpoint exists on either surface", () => {
    const server = readFileSync(resolve(__dirname, "../src/server.ts"), "utf8");
    expect(server).not.toContain("/api/compile");
    expect(server).not.toContain("goal/compile");
    expect(server).not.toContain("goal.compile");
  });

  it("no tool schema in this slice carries a tenant field", () => {
    for (const tool of [
      new GoalCompileCommand(),
      new GoalScheduleCommand(),
      new ChainRunCommand(),
      new AgentDbChainStatusCommand(),
      new AgentDbJobsHistoryCommand(),
      new AgentDbAuditHistoryCommand(),
      new AgentDbReportsListCommand(),
    ]) {
      expect(Object.keys(tool.jsonSchema.properties)).not.toContain("tenantId");
      expect(Object.keys(tool.jsonSchema.properties)).not.toContain("tenant");
    }
    const agentDb = readFileSync(resolve(__dirname, "../src/mcps/openaimp/agentDbReadCommands.ts"), "utf8");
    expect(agentDb).toContain("resolveIaaaTenant");
    expect(agentDb).not.toContain("input.tenantId");
  });
});

describe("G04 pinned: MCP mapper === REST route body for the same projection rows (#1729)", () => {
  const chainRow: ChainRow = {
    tenantId: TENANT,
    workspaceId: "ws-1",
    chainId: "c1",
    version: 1,
    status: "approved",
    goal: NASDAQ_GOAL,
    stepsJson: JSON.stringify([{ capabilityId: "feed-screener-pipeline" }]),
    createdAtMs: 1000,
    updatedAtMs: 2000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
  };
  const scheduleRow: ScheduleRow = {
    tenantId: TENANT,
    workspaceId: "ws-1",
    scheduleId: "c1",
    chainId: "c1",
    version: 1,
    status: "approved",
    kind: "recurring",
    cron: "0 * * * *",
    createdAtMs: 1000,
    updatedAtMs: 2000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
  };
  const jobRow: ShardJobRow = {
    tenantId: TENANT,
    workspaceId: "ws-1",
    chainId: "c1",
    jobKey: "chain-exec:leg-1",
    version: 1,
    status: "completed",
    stage: "feed",
    capabilityId: "feed-screener-pipeline",
    detail: "Completed.",
    resultJson: JSON.stringify({ shardJobIds: ["s1"] }),
    createdAtMs: 1000,
    updatedAtMs: 2000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
  };
  const auditRow: AuditEventRow = {
    id: `${TENANT}:approve:chain:c1:2000:0`,
    tenantId: TENANT,
    workspaceId: "ws-1",
    chainId: "c1",
    eventKind: "approve",
    subjectType: "chain",
    subjectId: "c1",
    actor: "system",
    detailJson: JSON.stringify({ transition: "approve" }),
    occurredAtMs: 2000,
    createdAtMs: 2000,
    updatedAtMs: 2000,
    version: 1,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
  };
  const reportRow: CanonicalReportRow = {
    tenantId: TENANT,
    workspaceId: "ws-1",
    reportId: "r1",
    runId: "run-1",
    generationId: "gen-1",
    title: "NASDAQ100 screen",
    source: "mas_reports",
    summary: "Top movers",
    body: "FULL BODY THAT MUST NEVER LEAVE THE STORE",
    createdAtMs: 1000,
    updatedAtMs: 2000,
    version: 1,
    provenanceWriter: "test",
    provenanceSourceDo: "Orchestrator",
    provenanceSourceVersion: "1",
  };

  it("chain.status: MCP result equals the /api/chains/status body", async () => {
    const mcp = chainStatusToMcpResult({ chain: chainRow, schedule: scheduleRow });
    const resp = await handleChainStatusRoute({
      session: { internalUserId: "u1" },
      method: "GET",
      tenantId: TENANT,
      chainId: "c1",
      readStatus: async () => ({ chain: chainRow, schedule: scheduleRow }),
    });
    expect(await resp.json()).toEqual(mcp);
  });

  it("jobs.history: MCP result equals the /api/jobs/history body", async () => {
    const mcp = jobsToMcpResult("c1", [jobRow]);
    const resp = await handleJobHistoryRoute({
      session: { internalUserId: "u1" },
      method: "GET",
      tenantId: TENANT,
      chainId: "c1",
      readHistory: async () => [jobRow],
    });
    expect(JSON.parse(await resp.text())).toEqual(mcp);
  });

  it("audit.history: MCP result equals the /api/audit/history body", async () => {
    const mcp = auditToMcpResult("c1", [auditRow]);
    const resp = await handleAuditHistoryRoute({
      session: { internalUserId: "u1" },
      method: "GET",
      tenantId: TENANT,
      chainId: "c1",
      readHistory: async () => [auditRow],
    });
    expect(await resp.json()).toEqual(mcp);
  });

  it("reports.list: MCP result equals the /api/reports/list body, bodies never included", async () => {
    const mcp = reportsToMcpResult([reportRow]);
    expect(JSON.stringify(mcp)).not.toContain("FULL BODY THAT MUST NEVER LEAVE THE STORE");
    expect(mcp.reports[0]).not.toHaveProperty("body");
    const resp = await handleReportsRoute({
      session: { internalUserId: "u1" },
      method: "GET",
      tenantId: TENANT,
      reportId: null,
      readReports: async () => [reportRow],
    });
    expect(await resp.json()).toEqual(mcp);
  });

  it("live-vs-projection pairs stay distinct surfaces with distinct sources", () => {
    const auditRoute = readFileSync(resolve(__dirname, "../src/agents/routes/audit.ts"), "utf8");
    expect(auditRoute).toContain("mas_events");
    expect(auditRoute).toContain("/audit");
    const reportsRoute = readFileSync(resolve(__dirname, "../src/agents/routes/reports.ts"), "utf8");
    expect(reportsRoute).toContain("mas_reports");
    // Slice 4 of Qunsultant/cfagent#2902 (2026-11-05): the audit/reports
    // reads moved verbatim from src/server.ts to
    // src/server/routes/privacy.ts; the entry surface is server.ts +
    // routes/*.ts, so the pin reads both files.
    const server =
      readFileSync(resolve(__dirname, "../src/server.ts"), "utf8") +
      readFileSync(resolve(__dirname, "../src/server/routes/privacy.ts"), "utf8");
    expect(server).toContain('path === "/api/audit/history"');
    expect(server).toContain('path === "/api/reports/list"');
    const agentDb = readFileSync(resolve(__dirname, "../src/mcps/openaimp/agentDbReadCommands.ts"), "utf8");
    expect(agentDb).toContain("projection only");
    expect(agentDb).not.toContain("mas_events");
  });
});
