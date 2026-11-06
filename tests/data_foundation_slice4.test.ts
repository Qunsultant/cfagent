// @vitest-environment node
/**
 * Issue #1697 ([AGENTIC] Slice 4, MCP read tools + dashboard
 * routes, sub-issue of the #1546 AgentDB program) — TDD
 * red-first.
 *
 * Four read-only MCP tools over the slices 1–3 projections:
 *   - `agentdb.chain.status`  — chain + schedule latest rows
 *   - `agentdb.jobs.history`  — shard jobs for one chain
 *   - `agentdb.audit.history` — audit events for one chain
 *   - `agentdb.reports.list`  — canonical reports for the tenant
 *
 * Pinned contracts:
 *   - Tools read the PROJECTION ONLY, never durable-object
 *     state, by reusing the slice-1/2/3 read helpers — no
 *     duplicated query logic, no new tables, no new migrations.
 *   - Tenant comes from IAAA resolution of env, never from
 *     caller input: a forged tenantId in the arguments changes
 *     nothing, and cross-tenant reads return nothing.
 *   - Unbound AgentDB yields a clean unavailable error, never
 *     a crash. Reads write nothing.
 *   - Report list shape excludes bodies (the durable object
 *     holds the full copy), matching the route shape.
 *   - `chain.run` execution semantics are untouched: the tool
 *     stays registered and still reports legs unimplemented
 *     with no executor; this slice adds reads only.
 *   - The four dashboard routes already exist (slices 1–3)
 *     and are already catalogued — verified by source pins
 *     below, so slice 4 adds no server route.
 *   - The MCP module never imports drizzle-orm, never
 *     references the store binding directly, and never
 *     accepts auth material (pinned by source scan).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleMCPRequest } from "../src/mcps/openaimp/handler";
import { MCP_TOOLS } from "../src/mcps/openaimp";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { ChainRunCommand } from "../src/mcps/openaimp/goalChainCommands";
import {
  chainStatusToMcpResult,
  jobsToMcpResult,
  auditToMcpResult,
  reportsToMcpResult,
} from "../src/mcps/openaimp/agentDbReadCommands";
import { MCP_TOOLS_CATALOG } from "../src/client/mcpEndpointsData";
import {
  API_ENDPOINT_CATALOG,
} from "../src/client/iaaaEndpointCatalog";
import {
  createD1ChainScheduleDb,
  D1ChainScheduleAdapter,
  ensureChainScheduleSchema,
} from "../src/data/d1ChainScheduleAdapter";
import {
  createD1ShardJobDb,
  D1ShardJobAdapter,
  ensureShardJobSchema,
} from "../src/data/d1ShardJobAdapter";
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";
import type { ChainRow, ScheduleRow } from "../src/data/chainSchedulePorts";
import type { ShardJobRow } from "../src/data/shardJobPorts";
import type {
  AuditEventRow,
  CanonicalReportRow,
} from "../src/data/auditReportPorts";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

/** Minimal D1 stand-in over node:sqlite (same shape as slice 1). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

const TENANT = "primary";
const OTHER_TENANT = "other";
const WORKSPACE = "ws-1";

function chainRow(over: Partial<ChainRow> = {}): ChainRow {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    chainId: "c1",
    version: 1,
    status: "approved",
    goal: "Create a NASDAQ100 screen and send it to Slack",
    stepsJson: JSON.stringify([{ capabilityId: "feed-screener-pipeline" }]),
    createdAtMs: 1000,
    updatedAtMs: 2000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
    ...over,
  };
}

function scheduleRow(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
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
    ...over,
  };
}

function jobRow(over: Partial<ShardJobRow> = {}): ShardJobRow {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    chainId: "c1",
    jobKey: "chain-exec:leg-1",
    version: 1,
    status: "completed",
    stage: "feed",
    capabilityId: "feed-screener-pipeline",
    detail: "Completed via the caller-supplied existing execution path.",
    resultJson: JSON.stringify({ shardJobIds: ["s1"] }),
    createdAtMs: 1000,
    updatedAtMs: 2000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
    ...over,
  };
}

function auditRow(over: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: `${TENANT}:approve:chain:c1:2000:0`,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
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
    ...over,
  };
}

function reportRow(over: Partial<CanonicalReportRow> = {}): CanonicalReportRow {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
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
    ...over,
  };
}

interface Seeded {
  mock: MockD1Database;
  chainStore: D1ChainScheduleAdapter;
  jobStore: D1ShardJobAdapter;
  auditStore: D1AuditReportAdapter;
}

async function seed(): Promise<Seeded> {
  const mock = new MockD1Database();
  const chainDb = createD1ChainScheduleDb(mock as any);
  const jobDb = createD1ShardJobDb(mock as any);
  const auditDb = createD1AuditReportDb(mock as any);
  await ensureChainScheduleSchema(chainDb);
  await ensureShardJobSchema(jobDb);
  await ensureAuditReportSchema(auditDb);
  const chainStore = new D1ChainScheduleAdapter(chainDb);
  const jobStore = new D1ShardJobAdapter(jobDb);
  const auditStore = new D1AuditReportAdapter(auditDb);
  await chainStore.recordChain(chainRow());
  await chainStore.recordSchedule(scheduleRow());
  await jobStore.recordJob(jobRow());
  await auditStore.recordAuditEvent(auditRow());
  await auditStore.recordReport(reportRow());
  return { mock, chainStore, jobStore, auditStore };
}

function ctx(env: Partial<Env> = {}) {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test_session_user");
  return {
    env: { AI: {} as any, ORCHESTRATOR_AGENT: {} as any, AGENT_SESSIONS: {} as any, ...env } as Env,
    orm,
    sessionId: "session_1",
    audit: () => {},
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Partial<Env> = {},
) {
  const resp = await handleMCPRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx(env),
  );
  expect(resp.error).toBeUndefined();
  const text = resp.result?.content?.[0]?.text as string;
  return JSON.parse(text);
}

async function callToolError(
  name: string,
  args: Record<string, unknown>,
  env: Partial<Env> = {},
) {
  const resp = await handleMCPRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx(env),
  );
  expect(resp.error).toBeDefined();
  return resp.error as { message?: string };
}

const NEW_TOOLS = [
  "agentdb.chain.status",
  "agentdb.jobs.history",
  "agentdb.audit.history",
  "agentdb.reports.list",
];

describe("registration (#1697)", () => {
  it("registers exactly the four new read tools, each once", () => {
    for (const name of NEW_TOOLS) {
      const tool = McpToolFactory.getTool(name);
      expect(tool, `${name} registered`).toBeDefined();
      expect(tool!.name).toBe(name);
    }
    const names = McpToolFactory.getAllTools().map((t) => t.name);
    for (const name of NEW_TOOLS) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
  });

  it("exposes the new tools in tools/list", () => {
    const listed = MCP_TOOLS.map((t) => t.name);
    for (const name of NEW_TOOLS) expect(listed).toContain(name);
  });

  it("leaves the pre-existing goal/chain tools registered and intact", () => {
    expect(McpToolFactory.getTool("goal.compile")).toBeDefined();
    expect(McpToolFactory.getTool("goal.schedule")).toBeDefined();
    const chainRun = McpToolFactory.getTool("chain.run");
    expect(chainRun).toBeInstanceOf(ChainRunCommand);
  });

  it("adds the four tools to the MCP explorer catalog", () => {
    const catalogNames = MCP_TOOLS_CATALOG.map((t) => t.name);
    for (const name of NEW_TOOLS) expect(catalogNames).toContain(name);
  });
});

describe("validation (#1697)", () => {
  it("chain-scoped tools require a non-empty chainId", async () => {
    for (const name of [
      "agentdb.chain.status",
      "agentdb.jobs.history",
      "agentdb.audit.history",
    ]) {
      const err = await callToolError(name, { chainId: "" });
      expect(err.message).toMatch(/chainId/);
      const err2 = await callToolError(name, {});
      expect(err2.message).toMatch(/chainId/);
    }
  });

  it("reports.list accepts an absent reportId", async () => {
    const { mock } = await seed();
    const result = await callTool(
      "agentdb.reports.list",
      {},
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].reportId).toBe("r1");
  });
});

describe("unbound store (#1697)", () => {
  it("yields a clean unavailable error, never a crash", async () => {
    for (const [name, args] of [
      ["agentdb.chain.status", { chainId: "c1" }],
      ["agentdb.jobs.history", { chainId: "c1" }],
      ["agentdb.audit.history", { chainId: "c1" }],
      ["agentdb.reports.list", {}],
    ] as const) {
      const err = await callToolError(name, args);
      expect(err.message).toMatch(/unavailable/i);
      expect(err.message).toMatch(/not bound/i);
    }
  });
});

describe("bound reads (#1697)", () => {
  it("chain.status mirrors the route shape from the projection", async () => {
    const { mock } = await seed();
    const result = await callTool(
      "agentdb.chain.status",
      { chainId: "c1" },
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(result).toMatchObject({
      projected: true,
      chain: {
        chainId: "c1",
        status: "approved",
        version: 1,
        goal: "Create a NASDAQ100 screen and send it to Slack",
        updatedAtMs: 2000,
      },
      schedule: {
        scheduleId: "c1",
        status: "approved",
        version: 1,
        kind: "recurring",
        cron: "0 * * * *",
        updatedAtMs: 2000,
      },
    });
  });

  it("chain.status reports unprojected chains as not projected", async () => {
    const { mock } = await seed();
    const result = await callTool(
      "agentdb.chain.status",
      { chainId: "missing" },
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(result).toEqual({ projected: false, chain: null, schedule: null });
  });

  it("jobs.history returns the mapped job rows", async () => {
    const { mock } = await seed();
    const result = await callTool(
      "agentdb.jobs.history",
      { chainId: "c1" },
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(result.chainId).toBe("c1");
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      jobKey: "chain-exec:leg-1",
      status: "completed",
      stage: "feed",
      capabilityId: "feed-screener-pipeline",
      version: 1,
      updatedAtMs: 2000,
    });
  });

  it("audit.history returns the mapped event rows", async () => {
    const { mock } = await seed();
    const result = await callTool(
      "agentdb.audit.history",
      { chainId: "c1" },
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(result.chainId).toBe("c1");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventKind: "approve",
      subjectType: "chain",
      subjectId: "c1",
      actor: "system",
      occurredAtMs: 2000,
    });
  });

  it("reports.list excludes bodies and filters by reportId", async () => {
    const { mock } = await seed();
    const all = await callTool(
      "agentdb.reports.list",
      {},
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(all.reports).toHaveLength(1);
    expect(all.reports[0]).not.toHaveProperty("body");
    expect(JSON.stringify(all)).not.toContain("FULL BODY THAT MUST NEVER LEAVE THE STORE");
    expect(all.reports[0]).toMatchObject({
      reportId: "r1",
      runId: "run-1",
      title: "NASDAQ100 screen",
      source: "mas_reports",
    });
    const one = await callTool(
      "agentdb.reports.list",
      { reportId: "r1" },
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(one.reports).toHaveLength(1);
    const none = await callTool(
      "agentdb.reports.list",
      { reportId: "missing" },
      { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT },
    );
    expect(none.reports).toEqual([]);
  });

  it("reads write nothing", async () => {
    const seeded = await seed();
    const env = { AGENT_DB: seeded.mock as any, IAAA_TENANT_ID: TENANT };
    const before = {
      jobs: await seeded.jobStore.listJobsForChain(TENANT, "c1"),
      events: await seeded.auditStore.listAuditForChain(TENANT, "c1"),
      reports: await seeded.auditStore.listReports(TENANT),
    };
    await callTool("agentdb.chain.status", { chainId: "c1" }, env);
    await callTool("agentdb.jobs.history", { chainId: "c1" }, env);
    await callTool("agentdb.audit.history", { chainId: "c1" }, env);
    await callTool("agentdb.reports.list", {}, env);
    expect(await seeded.jobStore.listJobsForChain(TENANT, "c1")).toEqual(before.jobs);
    expect(await seeded.auditStore.listAuditForChain(TENANT, "c1")).toEqual(before.events);
    expect(await seeded.auditStore.listReports(TENANT)).toEqual(before.reports);
  });
});

describe("tenancy (#1697, R7)", () => {
  it("cross-tenant reads return nothing", async () => {
    const { mock } = await seed();
    const env = { AGENT_DB: mock as any, IAAA_TENANT_ID: OTHER_TENANT };
    expect(await callTool("agentdb.chain.status", { chainId: "c1" }, env)).toEqual({
      projected: false,
      chain: null,
      schedule: null,
    });
    expect((await callTool("agentdb.jobs.history", { chainId: "c1" }, env)).jobs).toEqual([]);
    expect((await callTool("agentdb.audit.history", { chainId: "c1" }, env)).events).toEqual([]);
    expect((await callTool("agentdb.reports.list", {}, env)).reports).toEqual([]);
  });

  it("a caller-supplied tenant in the arguments is ignored", async () => {
    const { mock } = await seed();
    const env = { AGENT_DB: mock as any, IAAA_TENANT_ID: TENANT };
    const forged = await callTool(
      "agentdb.chain.status",
      { chainId: "c1", tenantId: "evil" },
      env,
    );
    const plain = await callTool("agentdb.chain.status", { chainId: "c1" }, env);
    expect(forged).toEqual(plain);
    expect(forged.chain.chainId).toBe("c1");
  });

  it("tool input schemas carry no tenant field", () => {
    for (const name of NEW_TOOLS) {
      const tool = McpToolFactory.getTool(name)!;
      expect(Object.keys(tool.jsonSchema.properties)).not.toContain("tenantId");
    }
  });
});

describe("mappers (#1697)", () => {
  it("mapper functions reproduce the route shapes exactly", () => {
    expect(chainStatusToMcpResult({ chain: chainRow(), schedule: scheduleRow() })).toMatchObject({
      projected: true,
      chain: { chainId: "c1", status: "approved" },
      schedule: { scheduleId: "c1", kind: "recurring" },
    });
    expect(chainStatusToMcpResult({ chain: null, schedule: null })).toEqual({
      projected: false,
      chain: null,
      schedule: null,
    });
    expect(jobsToMcpResult("c1", [jobRow()]).jobs[0]).toMatchObject({ jobKey: "chain-exec:leg-1" });
    expect(auditToMcpResult("c1", [auditRow()]).events[0]).toMatchObject({ eventKind: "approve" });
    const listed = reportsToMcpResult([reportRow()]);
    expect(listed.reports[0]).not.toHaveProperty("body");
    expect(listed.reports[0]).toMatchObject({ reportId: "r1" });
  });
});

describe("dashboard routes already exist (#1697)", () => {
  it("the four dashboard reads are present in the server entry and catalogued", () => {
    // Slice 4 of Qunsultant/cfagent#2902 (2026-11-05): the four reads
    // moved verbatim from src/server.ts to src/server/routes/privacy.ts;
    // the entry surface is server.ts + routes/*.ts, so the pin reads
    // both files. The catalog assertion is unchanged.
    const server =
      readFileSync(resolve(__dirname, "../src/server.ts"), "utf8") +
      readFileSync(resolve(__dirname, "../src/server/routes/privacy.ts"), "utf8");
    for (const path of [
      "/api/chains/status",
      "/api/jobs/history",
      "/api/audit/history",
      "/api/reports/list",
    ]) {
      expect(server).toContain(`path === "${path}"`);
      expect(API_ENDPOINT_CATALOG.some((e) => e.path === path)).toBe(true);
    }
  });
});

describe("port purity (#1697, R1/R9)", () => {
  it("the MCP read module never imports a store client, writes SQL, or touches auth material", () => {
    const text = readFileSync(
      resolve(__dirname, "../src/mcps/openaimp/agentDbReadCommands.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/drizzle-orm/);
    expect(text).not.toMatch(/D1Database/);
    expect(text).not.toMatch(/env\.AGENT_DB/);
    expect(text).not.toMatch(/SELECT|INSERT INTO/);
    expect(text).not.toMatch(/credential/i);
  });
});
