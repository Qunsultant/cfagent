// @vitest-environment node
/**
 * Issue #6554 (F1) — async_jobs merges into the J-stack as its async
 * single-unit capability. One pin per executor capability, proving the
 * capability executes via the engine's async mode (`runAsyncUnit`):
 * the engine records a run for `async.<capability>` carrying the
 * dispatching async job's id, and the mas_async_jobs row settles
 * from the engine outcome. The executor's leg dispatch (the
 * capability if/else in `executeAsyncJob`) is gone — the step
 * handler is resolved from the engine's step registry by name.
 *
 * The three heavy legs (shard / feed / NLQ) pin the routing, not
 * the leg's business behavior: their payloads fail fast inside the
 * leg (unsupported shard / missing userLogin / empty query), and
 * the test proves the engine ran the step and recorded the failure
 * — the legs' own behavior is covered by their own suites
 * (sharded_jobs_p1355, consolidation_1236_feed_*, NLQ tests).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ASYNC_CAPABILITY_HANDLERS,
  createAsyncCapabilityEngine,
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import {
  ASYNC_CAPABILITIES,
  asyncCapabilityJobId,
  createAsyncCapabilityStepRegistry,
} from "../src/services/asyncCapabilitySteps";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { FakeAsyncSql, makeAsyncCtx } from "./async-job-testkit";

const STOCK_OUTCOME = {
  kind: "stock",
  trigger: "manual",
  success: true,
  deliveryId: "manual:2026-11-26T00:00:00.000Z:TECH",
  matchedCount: 1,
  totalScanned: 10,
  universe: "TECH",
  pdfKeys: ["k1"],
  pdfStatus: "generated",
};

function makeHarness() {
  const sql = new FakeAsyncSql();
  const { ctx } = makeAsyncCtx(sql, "owner-login-1");
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test_session_user");
  const delivered: Array<{ channel: string; artifacts: unknown }> = [];
  const notified: Array<{ channel: string; text: string }> = [];
  const engine = createAsyncCapabilityEngine();
  const harnessCtx = ctx as unknown as AsyncJobsContext & Record<string, unknown>;
  harnessCtx.env = {
    AGENT_DB: new MockD1Database(),
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
    SCREENER_EMAIL_TO: "ops@example.com",
    SCREENER_WEBHOOK_URL: "https://example.com/hook",
  };
  harnessCtx.getOrm = () => orm as never;
  harnessCtx.routeRequest = vi.fn(async () => new Response("ok", { status: 200 })) as never;
  harnessCtx.followupReportPort = () => ({
    getStockPdf: async (_u: string, key: string) => (key === "k1" ? { fileName: "screen.pdf" } : null),
    getOptionsPdf: async () => null,
  });
  harnessCtx.followupDeliveryPort = () => ({
    deliver: async (input: { channel: string; artifacts: unknown }) => {
      delivered.push({ channel: input.channel, artifacts: input.artifacts });
      return { ok: true, detail: "sent-1" };
    },
    notify: async (input: { channel: string; text: string }) => {
      notified.push({ channel: input.channel, text: input.text });
      return { ok: true };
    },
  });
  harnessCtx.engine = engine.control as never;
  return { sql, ctx: harnessCtx as unknown as AsyncJobsContext, engine, delivered, notified };
}

/** The engine run record for one async submission, by capability + job id. */
function engineRunFor(
  h: ReturnType<typeof makeHarness>,
  capability: string,
  jobId: string,
) {
  return h.engine.runStore
    .listByJob(asyncCapabilityJobId(capability as never))
    .find((r) => r.asyncJobId === jobId);
}

async function runJob(
  h: ReturnType<typeof makeHarness>,
  capability: string,
  payload: Record<string, unknown>,
) {
  const submitted = await submitAsyncJob(h.ctx, { capability, payload } as never);
  await executeAsyncJob(h.ctx, { jobId: submitted.jobId });
  const row = getAsyncJob(h.ctx, submitted.jobId);
  return { jobId: submitted.jobId, row };
}

describe("every executor capability executes via the engine's async mode (#6554)", () => {
  it("http.request: the route runs as an engine unit and the row completes", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "http.request", {
      pathAndQuery: "/api/x",
      method: "GET",
      headers: {},
    });
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ body: "ok" });
    const run = engineRunFor(h, "http.request", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("success");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("mcp.tool: the tool runs as an engine unit and the row completes", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "mcp.tool", {
      toolName: "list_database_tables",
      arguments: {},
    });
    expect(row?.status).toBe("completed");
    const run = engineRunFor(h, "mcp.tool", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("success");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("task.draft: the draft runs as an engine unit and the row completes", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "task.draft", { title: "review AAPL" });
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ status: "draft", requiresConfirmation: true });
    const run = engineRunFor(h, "task.draft", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("success");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("followup.report: the serve runs as an engine unit and the row completes", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "followup.report", {
      outcome: { ...STOCK_OUTCOME },
      userLogin: "owner-login-1",
    });
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ status: "ready" });
    const run = engineRunFor(h, "followup.report", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("success");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("followup.deliver: the delivery runs as an engine unit and the row completes", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "followup.deliver", {
      outcome: { ...STOCK_OUTCOME },
      userLogin: "alice",
      channel: "slack",
      artifacts: [],
    });
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ status: "sent", channel: "slack" });
    expect(h.delivered.map((d) => d.channel)).toEqual(["slack"]);
    const run = engineRunFor(h, "followup.deliver", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("success");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("followup.notify: the notification runs as an engine unit and the row completes", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "followup.notify", {
      outcome: { ...STOCK_OUTCOME },
      userLogin: "alice",
      channel: "slack",
      event: "completed",
    });
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ status: "notified", channel: "slack", event: "completed" });
    expect(h.notified.map((n) => n.channel)).toEqual(["slack"]);
    const run = engineRunFor(h, "followup.notify", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("success");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("shard.execute: an unsupported shard fails inside the engine unit, recorded as a failed run", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "shard.execute", {
      shard: { stage: "screen", key: "k1" },
    });
    expect(row?.status).toBe("failed");
    expect(String(row?.error ?? "")).toContain("Unsupported shard: screen/k1");
    const run = engineRunFor(h, "shard.execute", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("failure");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("feed.snapshot: a missing userLogin fails inside the engine unit, recorded as a failed run", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "feed.snapshot", {});
    expect(row?.status).toBe("failed");
    expect(String(row?.error ?? "")).toContain("feed.snapshot job requires a userLogin");
    const run = engineRunFor(h, "feed.snapshot", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("failure");
    expect(run?.asyncJobId).toBe(jobId);
  });

  it("nlq.execute: an empty query fails inside the engine unit, recorded as a failed run", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "nlq.execute", { query: "" });
    expect(row?.status).toBe("failed");
    expect(String(row?.error ?? "")).toContain("NLQ job requires a non-empty query");
    const run = engineRunFor(h, "nlq.execute", jobId);
    expect(run).toBeDefined();
    expect(run?.outcome).toBe("failure");
    expect(run?.asyncJobId).toBe(jobId);
  });
});

describe("the async mode's own refusals + concurrency (#6554)", () => {
  it("an unknown capability refuses by name before any run is recorded", async () => {
    const h = makeHarness();
    const { jobId, row } = await runJob(h, "bogus.capability", {});
    expect(row?.status).toBe("failed");
    expect(String(row?.error ?? "")).toContain("bogus.capability");
    expect(h.engine.runStore.listByJob(asyncCapabilityJobId("bogus.capability" as never))).toHaveLength(0);
    await expect(
      h.engine.control.runAsyncUnit({
        capability: "bogus.capability",
        input: {},
        asyncJobId: jobId,
      } as never),
    ).rejects.toBeInstanceOf(JobPipelineError);
    await expect(
      h.engine.control.runAsyncUnit({
        capability: "bogus.capability",
        input: {},
        asyncJobId: jobId,
      } as never),
    ).rejects.toMatchObject({ code: "async_capability_unknown" });
  });

  it("two async submissions run concurrently — no single-row serialization", async () => {
    const h = makeHarness();
    const first = await submitAsyncJob(h.ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/a", method: "GET", headers: {} },
    } as never);
    const second = await submitAsyncJob(h.ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/b", method: "GET", headers: {} },
    } as never);
    await Promise.all([
      executeAsyncJob(h.ctx, { jobId: first.jobId }),
      executeAsyncJob(h.ctx, { jobId: second.jobId }),
    ]);
    expect(getAsyncJob(h.ctx, first.jobId)?.status).toBe("completed");
    expect(getAsyncJob(h.ctx, second.jobId)?.status).toBe("completed");
    expect(engineRunFor(h, "http.request", first.jobId)?.outcome).toBe("success");
    expect(engineRunFor(h, "http.request", second.jobId)?.outcome).toBe("success");
  });

  it("every named capability has a registered engine step", () => {
    const registry = createAsyncCapabilityStepRegistry(ASYNC_CAPABILITY_HANDLERS);
    for (const capability of ASYNC_CAPABILITIES) {
      expect(registry.has(`async.capability.${capability}`)).toBe(true);
    }
  });
});

describe("the executor's leg dispatch is retired (#6554)", () => {
  it("executeAsyncJob carries no capability if/else chain — dispatch is the engine's runAsyncUnit", () => {
    const text = fs.readFileSync(
      path.resolve(__dirname, "../src/agents/orchestrator/asyncJobs.ts"),
      "utf8",
    );
    // The dispatch span: from the deadline creation to the result
    // serialization. The catch block below it still branches on
    // capability for failure-state recording (a monolithic serve
    // failure gets its first-class failure state) — that is
    // bookkeeping, not dispatch, and stays out of this span.
    const start = text.indexOf("const executionDeadline = createExecutionDeadline");
    const end = text.indexOf("const serializedResult = JSON.stringify", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dispatchSpan = text.slice(start, end);
    expect(dispatchSpan).toContain("runAsyncUnit");
    expect(dispatchSpan).not.toContain("job.capability ===");
  });
});
