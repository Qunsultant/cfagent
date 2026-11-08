/**
 * GET /workflow-runs — the route contract for the Workflow Runs tab.
 * Seeds the same stores the producers write (mas_async_jobs,
 * mas_job_outcomes, mas_screening_activity) so the test pins the read
 * contract, not a hand-shaped fixture: one run per chain, its stages in
 * order, the recorded failure reason, and no raw payload in the body.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { recordJobOutcome } from "../src/services/jobOutcomes";
import { recordScreeningActivity } from "../src/services/screeningActivity";

const JOB_COLUMNS =
  "job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at";
const JOB_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

function insertJob(
  sql: MockSqlStorage,
  input: {
    jobId: string;
    displayName: string;
    status: string;
    payload: unknown;
    result?: unknown;
    error?: string | null;
    createdAt: string;
    completedAt?: string | null;
    parentJobId?: string | null;
    jobKind?: string | null;
    stage: string;
    chainId?: string | null;
    stuckAlertedAt?: string | null;
  },
): void {
  sql.exec(
    `INSERT INTO mas_async_jobs (${JOB_COLUMNS}) VALUES (${JOB_PLACEHOLDERS})`,
    input.jobId,
    "session-1",
    "http.request",
    input.displayName,
    input.status,
    JSON.stringify(input.payload),
    input.result === undefined ? null : JSON.stringify(input.result),
    input.error ?? null,
    input.createdAt,
    input.createdAt,
    input.createdAt,
    input.completedAt ?? null,
    input.parentJobId ?? null,
    input.jobKind ?? "main",
    null,
    null,
    input.stage,
    input.chainId ?? null,
    input.stuckAlertedAt ?? null,
  );
}

function ctxFor(sql: MockSqlStorage, userLogin = "analyst") {
  return { ensureTables: () => sql, userLogin, env: {} };
}

function request(path = "/workflow-runs"): Request {
  return new Request(`https://agent.internal${path}`, { method: "GET" });
}

describe("GET /workflow-runs", () => {
  it("returns one run per job chain with ordered stages and recorded reasons", async () => {
    const sql = new MockSqlStorage();
    insertJob(sql, {
      jobId: "job-main",
      displayName: "Stock screen — NASDAQ100",
      status: "completed",
      stage: "generate",
      chainId: "chain-1",
      payload: {
        method: "POST",
        pathAndQuery: "/etrade/screen",
        body: { trigger: "scheduled", universe: "NASDAQ100" },
      },
      result: { success: true, matchedCount: 12, totalScanned: 100 },
      createdAt: "2026-10-27T13:00:00.000Z",
      completedAt: "2026-10-27T13:01:00.000Z",
    });
    insertJob(sql, {
      jobId: "job-deliver",
      displayName: "Deliver by Slack",
      status: "failed",
      stage: "deliver",
      chainId: "chain-1",
      parentJobId: "job-main",
      jobKind: "delivery",
      payload: { channel: "slack", outcome: { trigger: "scheduled" } },
      error: "[SLACK_002] channel not configured",
      createdAt: "2026-10-27T13:01:00.000Z",
      completedAt: "2026-10-27T13:01:05.000Z",
    });
    recordScreeningActivity(sql, {
      userLogin: "analyst",
      kind: "stage",
      summary: "Stage deliver failed: [SLACK_002] channel not configured",
      detail: {
        chainId: "chain-1",
        jobId: "job-deliver",
        stage: "deliver",
        status: "failed",
        reason: "[SLACK_002] channel not configured",
      },
      refId: "job-deliver",
      createdAt: "2026-10-27T13:01:06.000Z",
    });
    recordJobOutcome(sql, {
      id: "workflow:job-main:shard-1",
      kind: "stock",
      trigger: "scheduled",
      status: "completed",
      scanned: 100,
      matched: 12,
      pdfKey: "stocks/report.pdf",
      origin: "job-tree",
      createdAt: "2026-10-27T13:00:00.000Z",
    });

    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    // One job-chain run plus the #3021 binding schedule row (last).
    expect(body.count).toBe(2);
    const run = body.runs[0];
    expect(run.id).toBe("chain-1");
    expect(run.stages.map((s: any) => s.stage)).toEqual(["generate", "deliver"]);
    expect(run.stages[1].status).toBe("failed");
    expect(run.stages[1].reason).toContain("[SLACK_002]");
    expect(run.status).toBe("failed");
    expect(run.trigger).toBe("scheduled");
    expect(run.artifacts[0]).toMatchObject({ kind: "pdf" });
    expect(body.runs[1]).toMatchObject({ source: "schedule", lifecycle: "scheduled" });
    expect(body.runs[1].schedule.mechanism).toBe("workflow-binding");
    expect(body.summary.total).toBe(2);
    expect(body.summary.scheduled).toBe(1);
    expect(body.summary.failed).toBe(1);
    expect(body.generatedAt).toMatch(/^\d{4}-/);
  });

  it("keeps an outcome with no job twin as its own run", async () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, {
      id: "discovery-9",
      kind: "discovery",
      trigger: "manual",
      status: "completed",
      scanned: 20,
      matched: 3,
      origin: "manual-options-inline",
      createdAt: "2026-10-27T12:00:00.000Z",
    });
    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql));
    const body = (await res!.json()) as any;
    // The outcome run plus the #3021 binding schedule row (last).
    expect(body.count).toBe(2);
    expect(body.runs[0]).toMatchObject({ id: "discovery-9", source: "job-outcome", trigger: "manual", status: "completed" });
    expect(body.runs[0].stages).toEqual([]);
    expect(body.runs[1]).toMatchObject({ source: "schedule", lifecycle: "scheduled" });
  });

  it("never returns raw payloads or secret values", async () => {
    const sql = new MockSqlStorage();
    const secretName = ["api", "Key"].join("");
    const secretValue = ["place", "holder"].join("-");
    insertJob(sql, {
      jobId: "job-secret",
      displayName: "Tool run",
      status: "completed",
      stage: "generate",
      payload: { toolName: "scan", [secretName]: secretValue, body: { trigger: "manual" } },
      result: { ok: true },
      createdAt: "2026-10-27T12:00:00.000Z",
      completedAt: "2026-10-27T12:00:01.000Z",
    });
    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql));
    const text = await res!.text();
    expect(text).not.toContain(secretValue);
    // The whitelisted fields still render; the secret field is simply absent.
    expect(text).toContain("toolName");
  });

  it("names missing identity scope instead of silently reading all stage records", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(
      request(),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      ctxFor(sql, ""),
    );
    const body = (await res!.json()) as any;
    // No stage records leak without identity — but the #3021 binding
    // schedule row is platform config, not user data, so it still
    // shows. The store error naming the missing scope is the point.
    expect(body.count).toBe(1);
    expect(body.runs[0]).toMatchObject({ source: "schedule", lifecycle: "scheduled" });
    expect(body.storeErrors.stages).toContain("no authenticated user identity");
  });

  it("clamps the limit and rejects non-GET", async () => {
    const sql = new MockSqlStorage();
    for (let i = 0; i < 3; i++) {
      insertJob(sql, {
        jobId: `job-${i}`,
        displayName: `Run ${i}`,
        status: "completed",
        stage: "generate",
        payload: { trigger: "manual" },
        createdAt: `2026-10-27T1${i}:00:00.000Z`,
        completedAt: `2026-10-27T1${i}:00:05.000Z`,
      });
    }
    const limited = await handleWorkflowRunsRoutes(
      request("/workflow-runs?limit=1"),
      new URL("https://agent.internal/workflow-runs?limit=1"),
      "/workflow-runs",
      "session-1",
      ctxFor(sql),
    );
    expect(((await limited!.json()) as any).count).toBe(1);

    const post = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "POST" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      ctxFor(sql),
    );
    expect(post!.status).toBe(405);
  });

  it("is not the handler for other paths", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(request("/runs"), new URL("https://agent.internal/runs"), "/runs", "session-1", ctxFor(sql));
    expect(res).toBeNull();
  });

  it("carries the stuck flag through to a running chain (#3784)", async () => {
    const sql = new MockSqlStorage();
    insertJob(sql, {
      jobId: "job-stuck",
      displayName: "MCP etrade_preview_order",
      status: "running",
      stage: "generate",
      payload: { trigger: "manual" },
      createdAt: "2026-11-08T15:29:00.000Z",
      stuckAlertedAt: "2026-11-08T15:59:00.000Z",
    });
    const res = await handleWorkflowRunsRoutes(request(), new URL("https://agent.internal/workflow-runs"), "/workflow-runs", "session-1", ctxFor(sql));
    const body = (await res!.json()) as any;
    const run = body.runs.find((r: any) => r.id === "job-stuck");
    expect(run).toBeDefined();
    expect(run.status).toBe("running");
    expect(run.stuck).toBe(true);
  });
});
