/**
 * #1724 (parent #1717, slice (d)): async jobs systems unification pins.
 *
 * NEVER EITHER/OR — ALWAYS CONFIGURABLE. No endpoint is removed and no
 * code path is deleted by this slice. The three "jobs" systems stay three
 * different things sharing a word (J01); what this slice unifies is the
 * delivery split (J02) and the list envelope (M04), each behind ONE
 * runtime switch, plus pins for each system's contract separately.
 *
 * Switch 1 — HTTP_DELIVERY_MODE ("sync" | "queued", Worker env var,
 * non-secret, owner-set; this slice sets NO production value):
 *   Governs the DO /api delivery decision AND the MCP tools/call
 *   wrapping decision. Built-in default = the calling surface's own
 *   legacy: HTTP = the per-prefix rule (immediate prefixes sync, every
 *   other /api-prefixed or async-eligible request queued); MCP =
 *   queued when a submitJob submitter is present, direct execution
 *   otherwise. An explicitly set level (run > session > user > env)
 *   overrides the prefix/submitter rule on BOTH transports.
 *   "sync" runs the handler via routeRequest/executeMCPTool; "queued"
 *   submits an async job (capability "http.request" / "mcp.tool").
 *   Exclusions stand in EVERY mode: /jobs* (the async-job endpoints
 *   themselves), /mcp* (its own wrapping rule below), /schedules*,
 *   and the Worker special branches (incl. /api/jobs/history and
 *   /api/jobs/reconcile, which never reach the DO jobs handler).
 *   get_async_job / list_async_jobs are NEVER wrapped, in any mode.
 *
 * Switch 2 — JOB_LIST_ENVELOPE ("count" | "nocount", Worker env var,
 * non-secret, owner-set; this slice sets NO production value):
 *   Governs the LIST envelope only. Built-in default = the calling
 *   surface's own legacy: MCP list_async_jobs → "count"
 *   ({count, jobs}); REST GET /jobs → "nocount" ({jobs}). An explicitly
 *   set level overrides BOTH surfaces uniformly. Single-job reads are
 *   NOT switched: MCP get_async_job and REST GET /jobs/{uuid} both
 *   return the FULL record including `result` already, and list
 *   records are result-stripped on both surfaces already — those two
 *   facts are pinned, not switched. REST-only POST /jobs/{uuid}/retry
 *   is unchanged (failed-only, 404/409/500, duplicate-retry refusal).
 *
 * Resolution order (owner directive 2026-10-26), both switches:
 *   run > session > user > global env > built-in (surface legacy).
 *   HTTP run = the `x-delivery-mode` request header; REST list run =
 *   the `?envelope=` query param; MCP list run = the per-call
 *   `envelope` input; MCP tools/call run = the `x-delivery-mode`
 *   header on the /mcp POST. Session/user = the optional scoped
 *   carriers on the execution context, populated by the
 *   execution-context owner; unset carriers fall through to env.
 *   A blank/unset level falls through; the FIRST non-blank level wins;
 *   an unrecognized winning value FAILS CLOSED to the surface legacy,
 *   logged + audited as jobs.config_error, with NO fall-through.
 *
 * What the switches do NOT govern (ENFORCEMENT, never opt-out):
 * - Job visibility/tenancy: mas_async_jobs reads are session-scoped
 *   (sessionKey) in every mode; the AgentDB projection read
 *   (GET /api/jobs/history) is tenant-scoped and reconcile
 *   (POST /api/jobs/reconcile) stays platform-admin-only, in every
 *   mode. No switch value widens a session or tenant boundary, and
 *   no switch value lets a caller disable its own audit scoping.
 * - The outcome sink (mas_job_outcomes) is NOT merged into
 *   mas_async_jobs and is NOT queryable by async jobId; the AgentDB
 *   projection is NOT absorbed (#1729's slice). Queue consumption
 *   stays idempotent: submitAsyncJob schedules executeAsyncJob with
 *   {idempotent: true}, and execute claims queued→running atomically
 *   (rowsWritten === 1 wins; a duplicate claim is a no-op).
 * - Caps stand in every mode: async-job payload 17 MB, async-job
 *   result 12 MB, queued HTTP request body 8 MB, REST list limit
 *   default 50 clamped 1–100, outcome list limit default 50 clamped
 *   1–200 at the /autopilot/jobs route, stale-running auto-fail 2 h.
 *
 * M04 truth, established on current main (closing the scan
 * disagreement — an earlier carry-over called the MCP tools
 * "unpaired"; the scan appendix (d) says paired/divergent-minor and
 * current main proves the scan right): MCP get_async_job /
 * list_async_jobs and REST GET /jobs[/{uuid}] read the SAME
 * mas_async_jobs table. MCP get returns the FULL record (like REST
 * single); MCP list returns {count, jobs} with jobs result-stripped
 * by the /mcp route context; REST list returns {jobs} (no count)
 * with jobs result-stripped by onRequest; REST single returns the
 * FULL record. Missing job: MCP throws "Async job not found.",
 * REST single 404s with the same message. MCP list takes no limit
 * argument (default 50 via listAsyncJobs); REST list takes ?limit=
 * (default 50, clamped 1–100 by listAsyncJobs).
 *
 * S5 (pin only, NOT unified): researchTaskLedger and
 * screenerTaskLedger share the lifecycle pattern (create → claim →
 * start → heartbeat → complete/fail → escalate; stale sweep
 * fails+escalates)
 * but keep separate stores, separate row shapes, and separate owning
 * agents. This slice introduces NO shared base class for them.
 *
 * TDD Red: this file fails module-missing before
 * src/config/asyncJobModes.ts exists, and its delivery/envelope
 * behavior pins fail before the call-site wiring lands.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

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
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import {
  HTTP_DELIVERY_MODE_SWITCH,
  JOB_LIST_ENVELOPE_SWITCH,
  applyJobListEnvelope,
  jobsConfigErrorEvent,
  levelsForHttpDelivery,
  levelsForJobListEnvelope,
  resolveHttpDeliveryMode,
  resolveJobListEnvelope,
  shouldQueueApiRequest,
  type HttpDeliveryMode,
  type JobListEnvelope,
} from "../src/config/asyncJobModes";
import { handleMCPRequest } from "../src/mcps/openaimp/handler";
import {
  GetAsyncJobCommand,
  ListAsyncJobsCommand,
} from "../src/mcps/openaimp/commands";
import {
  getAsyncJob,
  listAsyncJobs,
  retryAsyncJob,
  submitAsyncJob,
} from "../src/agents/orchestrator/asyncJobs";
import { FakeAsyncSql, makeAsyncCtx } from "./async-job-testkit";
import { enqueueHttpRequest } from "../src/agents/orchestrator/httpEntry";
import {
  listJobOutcomes,
  recordJobOutcome,
  type JobOutcomeInput,
} from "../src/services/jobOutcomes";
import {
  ResearchTaskLedger,
  evaluateResearchOutcome,
  type ResearchTaskStore,
} from "../src/services/researchTaskLedger";
import {
  ScreenerTaskLedger,
  evaluateScreenerOutcome,
  type ScreenerTaskStore,
} from "../src/services/screenerTaskLedger";
import { handleAutopilotRoutes } from "../src/agents/routes/autopilot";
import { makeFakeSessionStore } from "./fake-session-store";
import worker from "../src/server";

/* ------------------------------------------------------------------ */
/* Switch resolvers                                                    */
/* ------------------------------------------------------------------ */

describe("HTTP_DELIVERY_MODE resolver", () => {
  it("pins the switch name + audit event", () => {
    expect(HTTP_DELIVERY_MODE_SWITCH).toBe("HTTP_DELIVERY_MODE");
    expect(jobsConfigErrorEvent()).toBe("jobs.config_error");
  });
  it("blank levels fall back to the per-request legacy mode", () => {
    expect(resolveHttpDeliveryMode({}, "sync")).toMatchObject({ mode: "sync", level: "builtin" });
    expect(resolveHttpDeliveryMode({}, "queued")).toMatchObject({ mode: "queued", level: "builtin" });
  });
  it("resolution order is run > session > user > env", () => {
    expect(
      resolveHttpDeliveryMode({ run: "sync", session: "queued", user: "queued", env: "queued" }, "queued")
    ).toMatchObject({ mode: "sync", level: "run" });
    expect(
      resolveHttpDeliveryMode({ session: "sync", user: "queued", env: "queued" }, "queued")
    ).toMatchObject({ mode: "sync", level: "session" });
    expect(resolveHttpDeliveryMode({ user: "sync", env: "queued" }, "queued")).toMatchObject({
      mode: "sync",
      level: "user",
    });
    expect(resolveHttpDeliveryMode({ env: "sync" }, "queued")).toMatchObject({
      mode: "sync",
      level: "env",
    });
  });
  it("values are case-insensitive and whitespace-tolerant", () => {
    expect(resolveHttpDeliveryMode({ run: "  QUEUED " }, "sync").mode).toBe("queued");
  });
  it("an invalid winning value fails closed to legacy with no fall-through", () => {
    const r = resolveHttpDeliveryMode({ run: "bogus", env: "sync" }, "queued");
    expect(r).toMatchObject({ mode: "queued", invalid: true, level: "run", raw: "bogus" });
  });
  it("levelsForHttpDelivery wires scoped carriers + run + env", () => {
    expect(levelsForHttpDelivery({ session: "sync", user: "queued" }, undefined, "queued")).toEqual({
      run: undefined,
      session: "sync",
      user: "queued",
      env: "queued",
    });
  });
});

describe("JOB_LIST_ENVELOPE resolver", () => {
  it("pins the switch name", () => {
    expect(JOB_LIST_ENVELOPE_SWITCH).toBe("JOB_LIST_ENVELOPE");
  });
  it("blank levels fall back to the calling surface's legacy envelope", () => {
    expect(resolveJobListEnvelope({}, "count")).toMatchObject({ mode: "count", level: "builtin" });
    expect(resolveJobListEnvelope({}, "nocount")).toMatchObject({ mode: "nocount", level: "builtin" });
  });
  it("resolution order is run > session > user > env", () => {
    expect(
      resolveJobListEnvelope({ run: "nocount", session: "count", user: "count", env: "count" }, "count")
    ).toMatchObject({ mode: "nocount", level: "run" });
    expect(resolveJobListEnvelope({ session: "nocount", env: "count" }, "count")).toMatchObject({
      mode: "nocount",
      level: "session",
    });
    expect(resolveJobListEnvelope({ user: "nocount", env: "count" }, "count")).toMatchObject({
      mode: "nocount",
      level: "user",
    });
    expect(resolveJobListEnvelope({ env: "nocount" }, "count")).toMatchObject({
      mode: "nocount",
      level: "env",
    });
  });
  it("values are case-insensitive and whitespace-tolerant", () => {
    expect(resolveJobListEnvelope({ run: "  NOCOUNT " }, "count").mode).toBe("nocount");
  });
  it("an invalid winning value fails closed to legacy with no fall-through", () => {
    const r = resolveJobListEnvelope({ run: "bogus", env: "nocount" }, "count");
    expect(r).toMatchObject({ mode: "count", invalid: true, level: "run", raw: "bogus" });
  });
  it("levelsForJobListEnvelope wires scoped carriers + run + env", () => {
    expect(levelsForJobListEnvelope({ session: "nocount", user: "count" }, undefined, "count")).toEqual({
      run: undefined,
      session: "nocount",
      user: "count",
      env: "count",
    });
  });
  it("applyJobListEnvelope adds count only in count mode", () => {
    const jobs = [{ jobId: "a" }, { jobId: "b" }] as any;
    expect(applyJobListEnvelope(jobs, "count")).toEqual({ count: 2, jobs });
    expect(applyJobListEnvelope(jobs, "nocount")).toEqual({ jobs });
  });
});

/* ------------------------------------------------------------------ */
/* Delivery decision (the onRequest queue branch, pure)                */
/* ------------------------------------------------------------------ */

describe("shouldQueueApiRequest", () => {
  const base = {
    isApiRequest: true,
    isJobsEndpoint: false,
    isMcpEndpoint: false,
    isScheduleEndpoint: false,
  };
  it("legacy immediate prefixes stay sync; legacy others queue", () => {
    expect(shouldQueueApiRequest({ ...base, deliveryMode: "sync" })).toBe(false);
    expect(shouldQueueApiRequest({ ...base, deliveryMode: "queued" })).toBe(true);
  });
  it("sync mode never queues, even for queue-eligible requests", () => {
    expect(shouldQueueApiRequest({ ...base, deliveryMode: "sync" })).toBe(false);
  });
  it("queued mode queues even immediate-prefix requests", () => {
    expect(shouldQueueApiRequest({ ...base, deliveryMode: "queued" })).toBe(true);
  });
  it("jobs / mcp / schedules endpoints never queue in any mode", () => {
    for (const mode of ["sync", "queued"] as HttpDeliveryMode[]) {
      expect(shouldQueueApiRequest({ ...base, isJobsEndpoint: true, deliveryMode: mode })).toBe(false);
      expect(shouldQueueApiRequest({ ...base, isMcpEndpoint: true, deliveryMode: mode })).toBe(false);
      expect(shouldQueueApiRequest({ ...base, isScheduleEndpoint: true, deliveryMode: mode })).toBe(false);
    }
  });
  it("a non-API request never queues in any mode", () => {
    for (const mode of ["sync", "queued"] as HttpDeliveryMode[]) {
      expect(shouldQueueApiRequest({ ...base, isApiRequest: false, deliveryMode: mode })).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* MCP tools/call delivery (J02, MCP side)                             */
/* ------------------------------------------------------------------ */

describe("MCP tools/call delivery mode", () => {
  let orm: DatabaseORM;
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  } as Env;
  const auditLogs: any[] = [];
  const auditMock = (type: string, agent: any, payload: Record<string, unknown>) => {
    auditLogs.push({ type, agent, payload });
  };
  const receipt = {
    jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d",
    status: "queued" as const,
    statusUrl: "/api/jobs/d9643325-6195-4c4a-bc5a-9d9348070e5d",
  };
  const callTables = (extra: Record<string, unknown> = {}) =>
    handleMCPRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_database_tables", arguments: {} } },
      { env: mockEnv, orm, sessionId: "session_1", audit: auditMock, ...extra } as any
    );

  beforeEach(() => {
    auditLogs.length = 0;
    orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("test_session_user");
  });

  it("legacy: a submitJob submitter queues the tool (job receipt, not result)", async () => {
    const submitJob = vi.fn().mockResolvedValue(receipt);
    const resp = await callTables({ submitJob });
    expect(submitJob).toHaveBeenCalledWith({
      capability: "mcp.tool",
      payload: { toolName: "list_database_tables", arguments: {} },
    });
    expect(JSON.parse(resp.result?.content[0].text)).toMatchObject({ jobId: receipt.jobId, status: "queued" });
  });
  it("sync run override executes directly even with a submitter present", async () => {
    const submitJob = vi.fn().mockResolvedValue(receipt);
    const resp = await callTables({ submitJob, deliveryModeRun: "sync" });
    expect(submitJob).not.toHaveBeenCalled();
    const parsed = JSON.parse(resp.result?.content[0].text);
    expect(parsed.count).toBeGreaterThan(0);
    expect(Array.isArray(parsed.tables)).toBe(true);
  });
  it("queued run override without a submitter still executes directly (nothing to queue with)", async () => {
    const resp = await callTables({ deliveryModeRun: "queued" });
    const parsed = JSON.parse(resp.result?.content[0].text);
    expect(Array.isArray(parsed.tables)).toBe(true);
  });
  it("an invalid run value fails closed to legacy (queued) and audits jobs.config_error", async () => {
    const submitJob = vi.fn().mockResolvedValue(receipt);
    const resp = await callTables({ submitJob, deliveryModeRun: "bogus" });
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(JSON.parse(resp.result?.content[0].text)).toMatchObject({ status: "queued" });
    expect(auditLogs).toContainEqual(
      expect.objectContaining({ type: "jobs.config_error", payload: expect.objectContaining({ setting: "HTTP_DELIVERY_MODE" }) })
    );
  });
  it("get_async_job is never wrapped, in queued mode too", async () => {
    const submitJob = vi.fn();
    const getJob = vi.fn().mockReturnValue({ jobId: receipt.jobId, status: "completed", result: { answer: 42 } });
    const resp = await handleMCPRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_async_job", arguments: { jobId: receipt.jobId } } },
      { env: mockEnv, orm, sessionId: "session_1", audit: auditMock, submitJob, getJob, deliveryModeRun: "queued" } as any
    );
    expect(submitJob).not.toHaveBeenCalled();
    expect(getJob).toHaveBeenCalledWith(receipt.jobId);
    expect(JSON.parse(resp.result?.content[0].text)).toMatchObject({ status: "completed", result: { answer: 42 } });
  });
  it("list_async_jobs is never wrapped, in queued mode too", async () => {
    const submitJob = vi.fn();
    const listJobs = vi.fn().mockReturnValue([{ jobId: "j1", status: "queued" }]);
    const resp = await handleMCPRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_async_jobs", arguments: {} } },
      { env: mockEnv, orm, sessionId: "session_1", audit: auditMock, submitJob, listJobs, deliveryModeRun: "queued" } as any
    );
    expect(submitJob).not.toHaveBeenCalled();
    expect(listJobs).toHaveBeenCalled();
    expect(JSON.parse(resp.result?.content[0].text)).toEqual({ count: 1, jobs: [{ jobId: "j1", status: "queued" }] });
  });
});

/* ------------------------------------------------------------------ */
/* M04: list envelope + single-read contracts                          */
/* ------------------------------------------------------------------ */

describe("M04 list envelope (MCP list_async_jobs)", () => {
  const stripped = [
    { jobId: "j1", status: "queued" },
    { jobId: "j2", status: "completed" },
  ];
  const mcpCtx = (overrides: Record<string, unknown> = {}) =>
    ({ env: {}, orm: {}, sessionId: "sess-1724", audit: vi.fn(), listJobs: () => stripped, ...overrides }) as any;
  const listCmd = new ListAsyncJobsCommand();

  it("legacy MCP list returns {count, jobs} with result-stripped rows", async () => {
    expect(await listCmd.execute({}, mcpCtx())).toEqual({ count: 2, jobs: stripped });
  });
  it("run envelope nocount returns {jobs} with no count", async () => {
    expect(await listCmd.execute({ envelope: "nocount" }, mcpCtx())).toEqual({ jobs: stripped });
  });
  it("env envelope nocount returns {jobs}; session carrier beats env", async () => {
    expect(await listCmd.execute({}, mcpCtx({ env: { JOB_LIST_ENVELOPE: "nocount" } }))).toEqual({ jobs: stripped });
    expect(
      await listCmd.execute(
        {},
        mcpCtx({ env: { JOB_LIST_ENVELOPE: "count" }, scopedJobListModes: { session: "nocount" } })
      )
    ).toEqual({ jobs: stripped });
  });
  it("an invalid envelope fails closed to count and audits jobs.config_error", async () => {
    const audit = vi.fn();
    const out = await listCmd.execute({ envelope: "bogus" }, mcpCtx({ audit }));
    expect(out).toEqual({ count: 2, jobs: stripped });
    expect(audit).toHaveBeenCalledWith(
      "jobs.config_error",
      "orchestrator",
      expect.objectContaining({ setting: "JOB_LIST_ENVELOPE", resolved: "count" })
    );
  });
  it("the list tool schema exposes the optional envelope input (string-typed, so invalid values reach the resolver + audit)", () => {
    expect((listCmd.jsonSchema.properties as any).envelope).toBeDefined();
    expect(listCmd.zodSchema.safeParse({ envelope: "nocount" }).success).toBe(true);
    // Deliberately NOT an enum (the #1723 `mode` precedent): a bogus
    // value passes schema validation and fails closed in execute(),
    // with a jobs.config_error audit (pinned above).
    expect(listCmd.zodSchema.safeParse({ envelope: "bogus" }).success).toBe(true);
    expect(listCmd.zodSchema.safeParse({}).success).toBe(true);
  });
});

describe("M04 single-read contracts (unswitched, pinned)", () => {
  const full = { jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d", status: "completed", result: { answer: 42 } };
  const getCmd = new GetAsyncJobCommand();
  const ctx = (overrides: Record<string, unknown> = {}) =>
    ({ env: {}, orm: {}, sessionId: "sess-1724", audit: vi.fn(), getJob: () => full, ...overrides }) as any;

  it("MCP get_async_job returns the FULL record including result", async () => {
    expect(await getCmd.execute({ jobId: full.jobId }, ctx())).toEqual(full);
  });
  it("MCP get_async_job throws 'Async job not found.' for a missing job", async () => {
    await expect(getCmd.execute({ jobId: full.jobId }, ctx({ getJob: () => undefined }))).rejects.toThrow(
      "Async job not found."
    );
  });
  it("get_async_job validates jobId as a UUID", () => {
    expect(getCmd.zodSchema.safeParse({ jobId: "not-a-uuid" }).success).toBe(false);
    expect(getCmd.zodSchema.safeParse({ jobId: full.jobId }).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* J01 system 1: mas_async_jobs contracts (pinned separately)         */
/* ------------------------------------------------------------------ */

describe("J01 system 1: mas_async_jobs contracts", () => {
  it("submit returns {jobId uuid, status queued, statusUrl /api/jobs/{id}} and audits async_job.queued", async () => {
    const sql = new FakeAsyncSql();
    const { ctx, audit } = makeAsyncCtx(sql);
    const out = await submitAsyncJob(ctx, { capability: "mcp.tool", payload: { toolName: "list_database_tables", arguments: {} } });
    expect(out.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(out.status).toBe("queued");
    expect(out.statusUrl).toBe(`/api/jobs/${out.jobId}`);
    expect(audit).toHaveBeenCalledWith("async_job.queued", "orchestrator", expect.objectContaining({ jobId: out.jobId }));
  });
  it("submit schedules executeAsyncJob idempotently (queue-consumption idempotency key)", async () => {
    const sql = new FakeAsyncSql();
    const { ctx, schedule } = makeAsyncCtx(sql);
    await submitAsyncJob(ctx, { capability: "task.draft", payload: { title: "t" } });
    expect(schedule).toHaveBeenCalledWith(
      expect.any(Number),
      "executeAsyncJob",
      expect.objectContaining({ jobId: expect.any(String) }),
      expect.objectContaining({ idempotent: true })
    );
  });
  it("submit rejects a payload over the 17 MB serialized storage limit", async () => {
    const sql = new FakeAsyncSql();
    const { ctx } = makeAsyncCtx(sql);
    await expect(
      submitAsyncJob(ctx, { capability: "task.draft", payload: { blob: "x".repeat(17_000_001) } })
    ).rejects.toThrow("17 MB");
  });
  it("reads are session-scoped: another session sees neither the job nor the list", async () => {
    const sql = new FakeAsyncSql();
    const a = makeAsyncCtx(sql, "session-1");
    const b = makeAsyncCtx(sql, "session-2");
    const out = await submitAsyncJob(a.ctx, { capability: "task.draft", payload: { title: "t" } });
    expect(getAsyncJob(a.ctx, out.jobId)?.jobId).toBe(out.jobId);
    expect(getAsyncJob(b.ctx, out.jobId)).toBeUndefined();
    expect(listAsyncJobs(b.ctx)).toEqual([]);
    expect(listAsyncJobs(a.ctx)).toHaveLength(1);
  });
  it("list clamps: default 50, explicit limit clamped to 1–100", async () => {
    const sql = new FakeAsyncSql();
    const { ctx } = makeAsyncCtx(sql);
    for (let i = 0; i < 105; i++) {
      await submitAsyncJob(ctx, { capability: "task.draft", payload: { title: `t${i}` } });
    }
    expect(listAsyncJobs(ctx)).toHaveLength(50);
    expect(listAsyncJobs(ctx, 200)).toHaveLength(100);
    expect(listAsyncJobs(ctx, 0)).toHaveLength(1);
    expect(listAsyncJobs(ctx, 3)).toHaveLength(3);
  });
  it("a running job stale past 2 h auto-fails on read; a fresh running job does not", async () => {
    const sql = new FakeAsyncSql();
    const { ctx } = makeAsyncCtx(sql);
    const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const freshAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    sql.rows.push({
      job_id: "stale-job", session_id: "session-1", capability: "task.draft", display_name: "stale",
      status: "running", payload_json: "{}", created_at: staleAt, updated_at: staleAt, started_at: staleAt,
    });
    sql.rows.push({
      job_id: "fresh-job", session_id: "session-1", capability: "task.draft", display_name: "fresh",
      status: "running", payload_json: "{}", created_at: freshAt, updated_at: freshAt, started_at: freshAt,
    });
    const stale = getAsyncJob(ctx, "stale-job");
    expect(stale?.status).toBe("failed");
    expect(stale?.error).toMatch(/outcome may be unknown/);
    expect(getAsyncJob(ctx, "fresh-job")?.status).toBe("running");
  });
  it("retry: failed-only, duplicate-retry refusal, missing → not found (REST-only surface, unchanged)", async () => {
    const sql = new FakeAsyncSql();
    const { ctx } = makeAsyncCtx(sql);
    const out = await submitAsyncJob(ctx, { capability: "task.draft", payload: { title: "t" } });
    await expect(retryAsyncJob(ctx, out.jobId)).rejects.toThrow("Only a failed job");
    await expect(retryAsyncJob(ctx, "no-such-job")).rejects.toThrow("was not found");
    const row = sql.rows.find((r) => r.job_id === out.jobId)!;
    row.status = "failed";
    const retried = await retryAsyncJob(ctx, out.jobId);
    expect(retried.status).toBe("queued");
    expect(retried.jobId).not.toBe(out.jobId);
    await expect(retryAsyncJob(ctx, out.jobId)).rejects.toThrow("already retried");
  });
});

/* ------------------------------------------------------------------ */
/* J02 HTTP entry: enqueueHttpRequest (8 MB cap, header allow-list)    */
/* ------------------------------------------------------------------ */

describe("enqueueHttpRequest (queued HTTP delivery)", () => {
  const entryCtx = (submit: any) =>
    ({
      sessionKey: () => "sess-http",
      recordMessage: vi.fn(),
      addMessages: vi.fn(),
      submitAsyncJob: submit,
    }) as any;

  it("queues as capability http.request with 202 + Location + Retry-After, forwarding only allow-listed headers", async () => {
    const submit = vi.fn().mockResolvedValue({ jobId: "j1", status: "queued", statusUrl: "/api/jobs/j1" });
    const req = new Request("https://agent.internal/payments/status?x=1", {
      method: "GET",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-environment": "TEST",
        "x-user-login": "alice",
        "x-custom-secret": "must-not-forward",
        authorization: "Bearer nope",
      },
    });
    const res = await enqueueHttpRequest(entryCtx(submit), req, new URL(req.url));
    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toBe("/api/jobs/j1");
    expect(res.headers.get("Retry-After")).toBe("1");
    const submitted = submit.mock.calls[0][0];
    expect(submitted.capability).toBe("http.request");
    expect(submitted.payload.pathAndQuery).toBe("/payments/status?x=1");
    expect(submitted.payload.method).toBe("GET");
    expect(submitted.payload.body).toBe("");
    expect(submitted.payload.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-environment": "TEST",
      "x-user-login": "alice",
    });
  });
  it("an invalid x-user-login falls back to the session key (never a caller-asserted identity)", async () => {
    const submit = vi.fn().mockResolvedValue({ jobId: "j1", status: "queued", statusUrl: "/api/jobs/j1" });
    const req = new Request("https://agent.internal/payments/status", {
      method: "POST",
      headers: { "x-user-login": "bad login!" },
      body: "{}",
    });
    await enqueueHttpRequest(entryCtx(submit), req, new URL(req.url));
    expect(submit.mock.calls[0][0].payload.headers["x-user-login"]).toBe("sess-http");
  });
  it("a body over the 8 MB queued-request cap is rejected 413", async () => {
    const submit = vi.fn();
    const req = new Request("https://agent.internal/reports", { method: "POST", body: "x".repeat(8_000_001) });
    const res = await enqueueHttpRequest(entryCtx(submit), req, new URL(req.url));
    expect(res.status).toBe(413);
    expect(submit).not.toHaveBeenCalled();
  });
  it("a submit failure surfaces 503 (the caller retries; nothing is silently dropped)", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("schedule down"));
    const req = new Request("https://agent.internal/reports", { method: "GET" });
    const res = await enqueueHttpRequest(entryCtx(submit), req, new URL(req.url));
    expect(res.status).toBe(503);
  });
});

/* ------------------------------------------------------------------ */
/* J01 system 2: mas_job_outcomes sink (pinned separately, not merged) */
/* ------------------------------------------------------------------ */

describe("J01 system 2: mas_job_outcomes sink", () => {
  const base: JobOutcomeInput = {
    id: "delivery-1", kind: "options", trigger: "scheduled", status: "failed",
    codedError: "[FAILURE_AUTH_NO_SESSION] E*TRADE connection missing", origin: "bus",
  };
  it("records and lists an outcome with its own id/kind/trigger/status shape (no async-job fields)", () => {
    const sql = new MockSqlStorage();
    const row = recordJobOutcome(sql, { ...base, scanned: 100, matched: 0, reportUrl: "/api/screening/reports/xyz" });
    expect(row.id).toBe("delivery-1");
    expect(row).not.toHaveProperty("jobId");
    expect(row).not.toHaveProperty("statusUrl");
    expect(row).not.toHaveProperty("capability");
    expect(listJobOutcomes(sql, 50)).toHaveLength(1);
  });
  it("re-recording the same stable id merges delivery states key-wise and never wipes defined values with undefined", () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, { ...base, deliveryStates: { email: "sent" }, scanned: 100 });
    const merged = recordJobOutcome(sql, { ...base, deliveryStates: { slack: "sent" } });
    expect(merged.deliveryStates).toEqual({ email: "sent", slack: "sent" });
    expect(merged.scanned).toBe(100);
    expect(listJobOutcomes(sql, 50)).toHaveLength(1);
  });
  it("a completed re-record WITHOUT a coded error clears a stale coded error (errors belong to failed outcomes)", () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, base);
    // Omit codedError: the merge rule clears a stale error only when
    // the re-record carries none (an explicit codedError is kept).
    const { codedError: _dropped, ...withoutError } = base;
    const merged = recordJobOutcome(sql, { ...withoutError, status: "completed" });
    expect(merged.codedError).toBeNull();
  });
  it("the /autopilot/jobs route clamps limit 1–200, default 50", async () => {
    const sql = new MockSqlStorage();
    for (let i = 0; i < 205; i++) {
      recordJobOutcome(sql, { ...base, id: `delivery-${i}`, createdAt: `2026-10-24T10:${String(i % 60).padStart(2, "0")}:00.000Z` });
    }
    const ctx = { ensureTables: () => sql } as any;
    const over = await handleAutopilotRoutes(
      new Request("https://agent.internal/autopilot/jobs?limit=500"),
      new URL("https://agent.internal/autopilot/jobs?limit=500"),
      "/autopilot/jobs",
      "sess-1724",
      ctx
    );
    expect(over).not.toBeNull();
    const overBody = await over!.json();
    expect(overBody.count).toBe(200);
    expect(overBody.jobs).toHaveLength(200);
    const dflt = await handleAutopilotRoutes(
      new Request("https://agent.internal/autopilot/jobs"),
      new URL("https://agent.internal/autopilot/jobs"),
      "/autopilot/jobs",
      "sess-1724",
      ctx
    );
    expect((await dflt!.json()).count).toBe(50);
    const one = await handleAutopilotRoutes(
      new Request("https://agent.internal/autopilot/jobs?limit=0"),
      new URL("https://agent.internal/autopilot/jobs?limit=0"),
      "/autopilot/jobs",
      "sess-1724",
      ctx
    );
    expect((await one!.json()).count).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* S5: ledger pattern pins (IDENTICAL pattern, NOT unified)            */
/* ------------------------------------------------------------------ */

function researchMemStore(): ResearchTaskStore {
  const raw = new Map<string, string>();
  return {
    get: (k) => (raw.has(k) ? raw.get(k)! : null),
    set: (k, v) => void raw.set(k, v),
    delete: (k) => void raw.delete(k),
    list: (prefix) =>
      [...raw.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  };
}
function screenerMemStore(): ScreenerTaskStore {
  const raw = new Map<string, string>();
  return {
    get: async (k) => (raw.has(k) ? raw.get(k)! : null),
    set: async (k, v) => void raw.set(k, v),
    delete: async (k) => void raw.delete(k),
    list: async (prefix) =>
      [...raw.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  };
}

describe("S5 ledger pattern (pinned, not unified)", () => {
  it("research ledger: create → claim → start → heartbeat → complete, fail → escalate, stale sweep fails+escalates", () => {
    let now = "2026-10-20T10:00:00.000Z";
    let ids = 0;
    const ledger = new ResearchTaskLedger(researchMemStore(), {
      now: () => now,
      newId: () => `task-${++ids}`,
    });
    const { task, created } = ledger.create({ trigger: "manual", userLogin: "alice", idempotencyKey: "research:manual:alice:run-0" });
    expect(created).toBe(true);
    expect(task.status).toBe("queued");
    expect(ledger.create({ trigger: "manual", userLogin: "alice", idempotencyKey: "research:manual:alice:run-0" }).created).toBe(false);
    const claimed = ledger.claim(task.id);
    expect(claimed.status).toBe("claimed");
    expect(ledger.start(task.id).status).toBe("running");
    now = "2026-10-20T10:01:00.000Z";
    expect(ledger.heartbeat(task.id).heartbeatAt).toBe(now);
    const evaluation = evaluateResearchOutcome(
      { reportRunId: "run-1", previousRunId: "run-0", expectedTrigger: "manual", expectedUserLogin: "alice", reportTrigger: "manual", reportUserLogin: "alice", summary: "3 ideas", ideas: 3, watchlist: 2, rejected: 5 },
      now
    );
    expect(evaluation.verdict).toBe("pass");
    const completed = ledger.complete(task.id, { path: "fallback", reportRunId: "run-1", evaluation });
    expect(completed.status).toBe("completed");
    expect(completed.reportRunId).toBe("run-1");
    // A second, abandoned task is failed → escalated by the stale sweep (never silently dropped).
    const second = ledger.create({ trigger: "scheduled", userLogin: "alice", idempotencyKey: "research:scheduled:alice:run-9" }).task;
    ledger.claim(second.id);
    const swept = ledger.sweepStale(30 * 60 * 1000, "2026-10-20T11:00:00.000Z");
    expect(swept.map((t) => t.id)).toContain(second.id);
    expect(ledger.get(second.id)?.status).toBe("escalated");
  });
  it("screener ledger: same lifecycle vocabulary over its own store and row shape", async () => {
    let now = "2026-10-20T10:00:00.000Z";
    let ids = 0;
    const ledger = new ScreenerTaskLedger(screenerMemStore(), {
      now: () => now,
      newId: () => `stask-${++ids}`,
    });
    const { task, created } = await ledger.create({
      trigger: "manual", universe: "us", sector: "all", idempotencyKey: "screener:manual:alice:run-0",
    });
    expect(created).toBe(true);
    expect(task.status).toBe("queued");
    expect(task.universe).toBe("us");
    expect(
      (await ledger.create({ trigger: "manual", universe: "us", sector: "all", idempotencyKey: "screener:manual:alice:run-0" })).created
    ).toBe(false);
    expect((await ledger.claim(task.id)).status).toBe("claimed");
    expect((await ledger.start(task.id)).status).toBe("running");
    now = "2026-10-20T10:01:00.000Z";
    expect((await ledger.heartbeat(task.id)).heartbeatAt).toBe(now);
    const evaluation = evaluateScreenerOutcome(
      { runTimestamp: now, totalScanned: 10, matchedCount: 3, opportunities: 2, success: true, partial: false, qualificationPresent: false },
      now
    );
    expect(evaluation.verdict).toBe("pass");
    const completed = await ledger.complete(task.id, {
      runTimestamp: now, totalScanned: 10, matchedCount: 3, opportunitiesCount: 2, partial: false, evaluation,
    });
    expect(completed.status).toBe("completed");
    const failed = await ledger.create({
      trigger: "scheduled", universe: "us", sector: "all", idempotencyKey: "screener:scheduled:alice:run-9",
    });
    await ledger.claim(failed.task.id);
    await ledger.start(failed.task.id);
    await ledger.fail(failed.task.id, "boom");
    expect((await ledger.escalate(failed.task.id, "human review")).status).toBe("escalated");
    const stale = await ledger.create({
      trigger: "scheduled", universe: "us", sector: "all", idempotencyKey: "screener:scheduled:alice:run-10",
    });
    await ledger.claim(stale.task.id);
    const swept = await ledger.sweepStale(30 * 60 * 1000, "2026-10-20T11:00:00.000Z");
    expect(swept.map((t) => t.id)).toContain(stale.task.id);
    expect((await ledger.get(stale.task.id))?.status).toBe("escalated");
  });
  it("the two ledgers stay independent: the same idempotency key creates two separate tasks", async () => {
    const rLedger = new ResearchTaskLedger(researchMemStore(), { newId: () => "r-1" });
    const sLedger = new ScreenerTaskLedger(screenerMemStore(), { newId: () => "s-1" });
    const r = rLedger.create({ trigger: "manual", userLogin: "alice", idempotencyKey: "shared-key" });
    const s = await sLedger.create({ trigger: "manual", universe: "us", sector: "all", idempotencyKey: "shared-key" });
    expect(r.created).toBe(true);
    expect(s.created).toBe(true);
    expect(r.task.id).not.toBe(s.task.id);
    expect(r.task).not.toHaveProperty("universe");
    // The screener row carries its own shape (universe/sector); its
    // userLogin is unset here while the research row's is "alice".
    expect(r.task.userLogin).toBe("alice");
    expect(s.task.userLogin).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Worker forwarder: x-delivery-mode header (J02, Worker side)         */
/* ------------------------------------------------------------------ */

const W_LOGIN = "test-trader-1724";
const W_SESSION_ID = "17240000-1c2b-4e3f-8a5b-172400000001";

interface WForwarded {
  id: string;
  pathname: string;
  userLogin: string | null;
  asyncEligible: string | null;
  deliveryMode: string | null;
}

function makeWorkerEnv() {
  const forwarded: WForwarded[] = [];
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", W_SESSION_ID, { githubLogin: W_LOGIN, userLogin: W_LOGIN });
  const env: any = {
    SESSION_STORE: sessionStoreNs,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            userLogin: req.headers.get("x-user-login"),
            asyncEligible: req.headers.get("x-async-eligible"),
            deliveryMode: req.headers.get("x-delivery-mode"),
          });
          return Response.json({ ok: true, forwardedTo: new URL(req.url).pathname });
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
}

const wReq = (path: string, method = "GET", extraHeaders: Record<string, string> = {}) =>
  new Request(`https://agent.test${path}`, {
    method,
    headers: { Cookie: `session_id=${W_SESSION_ID}`, ...extraHeaders },
  });

describe("Worker /api forwarder delivery header", () => {
  it("queued header marks an immediate-prefix request async-eligible (DO decides; Worker grants eligibility)", async () => {
    const { env, forwarded } = makeWorkerEnv();
    const res = await worker.fetch(wReq("/api/etrade/status", "GET", { "x-delivery-mode": "queued" }), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/etrade/status");
    expect(forwarded[0].asyncEligible).toBe("1");
    expect(forwarded[0].deliveryMode).toBe("queued");
  });
  it("sync header suppresses the async-eligible marker for a non-immediate request", async () => {
    const { env, forwarded } = makeWorkerEnv();
    const res = await worker.fetch(wReq("/api/payments/status", "GET", { "x-delivery-mode": "sync" }), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/payments/status");
    expect(forwarded[0].asyncEligible).toBeNull();
    expect(forwarded[0].deliveryMode).toBe("sync");
  });
  it("no header keeps legacy marking (immediate sync, others eligible)", async () => {
    const { env, forwarded } = makeWorkerEnv();
    await worker.fetch(wReq("/api/etrade/status"), env);
    expect(forwarded[0].asyncEligible).toBeNull();
    await worker.fetch(wReq("/api/payments/status"), env);
    expect(forwarded[1].asyncEligible).toBe("1");
  });
  it("a queued header does NOT reroute the AgentDB projection branch to the DO (history stays Worker-served, 503 unbound)", async () => {
    const { env, forwarded } = makeWorkerEnv();
    const res = await worker.fetch(wReq("/api/jobs/history?chainId=c1", "GET", { "x-delivery-mode": "queued" }), env);
    expect(forwarded).toHaveLength(0);
    expect(res.status).toBe(503);
  });
});
