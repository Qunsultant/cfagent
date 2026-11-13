/**
 * Workflow Runs read model — the grouping, trigger classification,
 * redaction, and failure semantics the new tab renders must be true
 * before the tab exists. These tests drive the pure model directly:
 * one run per chain, ordered stages, recorded reasons, honest
 * "not recorded" fields, and no raw payload leakage.
 */
import { describe, it, expect } from "vitest";
import {
  buildWorkflowRuns,
  compactJsonValue,
  d1RecordLinkedToJobs,
  runGroupKey,
  stageInputSummary,
  stageOutputSummary,
  summarizeWorkflowRuns,
  triggerLabel,
  type WorkflowRunJobRow,
  type WorkflowRunOutcomeRow,
  type WorkflowRunStageTransition,
} from "../src/services/workflowRuns";
import { buildJobRunRecord } from "../src/services/jobRunRecords";

function job(overrides: Partial<WorkflowRunJobRow> & { job_id: string }): WorkflowRunJobRow {
  return {
    capability: "http.request",
    display_name: "Stock screen — NASDAQ100",
    status: "completed",
    created_at: "2026-10-27T13:00:00.000Z",
    completed_at: "2026-10-27T13:01:00.000Z",
    ...overrides,
  };
}

const stockChain: WorkflowRunJobRow[] = [
  job({
    job_id: "job-main",
    job_kind: "main",
    chain_id: "chain-1",
    stage: "generate",
    payload_json: JSON.stringify({
      method: "POST",
      pathAndQuery: "/etrade/screen?universe=NASDAQ100",
      body: { trigger: "scheduled", universe: "NASDAQ100" },
    }),
    result_json: JSON.stringify({ success: true, matchedCount: 12, totalScanned: 100 }),
    created_at: "2026-10-27T13:00:00.000Z",
    completed_at: "2026-10-27T13:01:00.000Z",
  }),
  job({
    job_id: "job-report",
    job_kind: "report",
    parent_job_id: "job-main",
    chain_id: "chain-1",
    stage: "serve",
    capability: "followup.report",
    display_name: "Generate report — stock screen",
    payload_json: JSON.stringify({
      outcome: { kind: "stock", trigger: "scheduled", universe: "NASDAQ100" },
    }),
    result_json: JSON.stringify({ status: "completed", pdfKey: "stocks/report.pdf" }),
    created_at: "2026-10-27T13:01:00.000Z",
    completed_at: "2026-10-27T13:01:20.000Z",
  }),
  job({
    job_id: "job-deliver",
    job_kind: "delivery",
    parent_job_id: "job-main",
    chain_id: "chain-1",
    stage: "deliver",
    channel: "slack",
    capability: "followup.deliver",
    display_name: "Deliver by Slack — stock screen",
    status: "failed",
    error: "[SLACK_002] channel not configured",
    payload_json: JSON.stringify({ channel: "slack", outcome: { trigger: "scheduled" } }),
    created_at: "2026-10-27T13:01:20.000Z",
    completed_at: "2026-10-27T13:01:25.000Z",
  }),
];

const stockOutcome: WorkflowRunOutcomeRow = {
  id: "workflow:job-main:shard-1",
  kind: "stock",
  trigger: "scheduled",
  status: "completed",
  scanned: 100,
  matched: 12,
  pdfKey: "stocks/report.pdf",
  xlsxKey: "stocks/report.xlsx",
  deliveryStates: { slack: "failed", email: "sent" },
  origin: "job-tree",
  createdAt: "2026-10-27T13:00:00.000Z",
};

describe("workflow run grouping", () => {
  it("groups a chain's jobs into one run with ordered stages", () => {
    const runs = buildWorkflowRuns({ jobs: stockChain, outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.id).toBe("chain-1");
    expect(run.workflow).toBe("Stock screening workflow");
    expect(run.stages.map((s) => s.stage)).toEqual(["generate", "serve", "deliver"]);
    expect(run.stages.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(run.stageCount).toBe(3);
    expect(run.completedStages).toBe(2);
    expect(run.failedStages).toBe(1);
    // A failed delivery makes the run failed, and names the error.
    expect(run.status).toBe("failed");
    expect(run.error).toContain("[SLACK_002]");
  });

  it("groups a job with no chain under its parent, or itself", () => {
    expect(runGroupKey(job({ job_id: "a", parent_job_id: "root" }))).toBe("root");
    expect(runGroupKey(job({ job_id: "a" }))).toBe("a");
    expect(runGroupKey(job({ job_id: "a", chain_id: "chain", parent_job_id: "root" }))).toBe("chain");
  });

  it("attaches a matching outcome by job id and by workflow:<jobId>: shard id", () => {
    const byJobId = buildWorkflowRuns({
      jobs: stockChain,
      outcomes: [{ ...stockOutcome, id: "job-main" }],
      transitions: [],
    });
    expect(byJobId).toHaveLength(1);
    expect(byJobId[0].artifacts.map((a) => a.kind)).toEqual(["pdf", "xlsx"]);
    expect(byJobId[0].deliveryStates).toEqual({ slack: "failed", email: "sent" });

    const byDeliveryId = buildWorkflowRuns({ jobs: stockChain, outcomes: [stockOutcome], transitions: [] });
    expect(byDeliveryId).toHaveLength(1);
    expect(byDeliveryId[0].source).toBe("job-chain");
  });

  it("keeps an outcome with no job twin as its own run, with no invented stages", () => {
    const runs = buildWorkflowRuns({
      jobs: [],
      outcomes: [
        {
          id: "discovery-1",
          kind: "discovery",
          trigger: "scheduled",
          status: "completed",
          scanned: 40,
          matched: 6,
          origin: "discovery",
          createdAt: "2026-10-27T12:00:00.000Z",
        },
      ],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.source).toBe("job-outcome");
    expect(run.stages).toEqual([]);
    expect(run.stageCount).toBe(0);
    expect(run.trigger).toBe("scheduled");
    expect(run.triggerDetail).toContain("autonomous producer");
    expect(run.outputs).toMatchObject({ status: "completed", scanned: 40, matched: 6 });
  });

  it("attaches stage transitions to the job stage they describe", () => {
    const transitions: WorkflowRunStageTransition[] = [
      {
        id: "sact-1",
        createdAt: "2026-10-27T13:01:30.000Z",
        summary: "Stage deliver held: awaiting Slack approval",
        chainId: "chain-1",
        jobId: "job-deliver",
        stage: "deliver",
        status: "held",
        reason: "awaiting Slack approval",
      },
    ];
    const runs = buildWorkflowRuns({
      jobs: stockChain.map((j) => (j.job_id === "job-deliver" ? { ...j, status: "completed", error: null } : j)),
      outcomes: [],
      transitions,
    });
    const deliver = runs[0].stages.find((s) => s.key === "job-deliver")!;
    expect(deliver.status).toBe("held");
    expect(deliver.reason).toBe("awaiting Slack approval");
    expect(runs[0].status).toBe("partial");
  });

  it("shows a stage transition with no job row as its own stage", () => {
    const runs = buildWorkflowRuns({
      jobs: [stockChain[0]],
      outcomes: [],
      transitions: [
        {
          id: "sact-feed",
          createdAt: "2026-10-27T12:59:00.000Z",
          summary: "Stage feed completed",
          chainId: "chain-1",
          jobId: "workflow-shard-feed",
          stage: "feed",
          status: "completed",
          reason: null,
        },
      ],
    });
    const feed = runs[0].stages.find((s) => s.recordedBy === "stage-transition")!;
    expect(feed.stage).toBe("feed");
    expect(feed.status).toBe("completed");
    expect(feed.label).toContain("Feed");
  });

  it("orders runs newest first and clamps the limit", () => {
    const older = job({ job_id: "older", chain_id: "chain-old", created_at: "2026-10-26T10:00:00.000Z", status: "completed" });
    const newer = job({ job_id: "newer", chain_id: "chain-new", created_at: "2026-10-27T10:00:00.000Z", status: "completed" });
    const runs = buildWorkflowRuns({ jobs: [older, newer], outcomes: [], transitions: [], limit: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("chain-new");
  });

  it("leaves trigger unknown when no store recorded one", () => {
    const runs = buildWorkflowRuns({
      jobs: [job({ job_id: "plain", status: "completed", payload_json: JSON.stringify({ method: "POST" }) })],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("unknown");
    expect(runs[0].triggerDetail).toMatch(/Not recorded/);
    expect(triggerLabel("unknown")).toBe("Not recorded");
  });

  it("classifies a goal-triggered job as autonomous with the goal named", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "goal-job",
          payload_json: JSON.stringify({ goalId: "goal-42", capability: "nlq" }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("autonomous");
    expect(runs[0].triggerDetail).toContain("goal-42");
  });
});

describe("workflow run summaries", () => {
  it("redacts secret-shaped keys and clips long strings", () => {
    const tokenKey = ["authorization", "Token"].join("");
    const keyName = ["api", "Key"].join("");
    const passwordName = ["pass", "word"].join("");
    const compact = compactJsonValue({
      [tokenKey]: "placeholder-value",
      [keyName]: "placeholder-value",
      note: "x".repeat(400),
      nested: { [passwordName]: "placeholder-value", keep: "yes" },
    }) as Record<string, any>;
    expect(compact[tokenKey]).toBe("[redacted]");
    expect(compact[keyName]).toBe("[redacted]");
    expect(compact.note.length).toBeLessThanOrEqual(240);
    expect(compact.nested[passwordName]).toBe("[redacted]");
    expect(compact.nested.keep).toBe("yes");
  });

  it("never returns a raw payload from a stage summary", () => {
    const redactedQueryKey = ["api", "Key"].join("");
    const summary = stageInputSummary(
      job({
        job_id: "j",
        payload_json: JSON.stringify({
          method: "POST",
          pathAndQuery: `/etrade/screen?universe=X&${redactedQueryKey}=placeholder`,
          body: JSON.stringify({ trigger: "manual", universe: "X" }),
        }),
      }),
    ) as Record<string, any>;
    expect(summary.path).toBe("/etrade/screen");
    // Only whitelisted fields are surfaced; the query is summarized, not echoed.
    expect(Object.keys(summary).sort()).toEqual(["body", "method", "path", "query"]);
    expect(summary.body).toEqual({ trigger: "manual", universe: "X" });
    expect(summary.query.universe).toBe("X");
    expect(summary.query[redactedQueryKey]).toBe("[redacted]");
  });

  it("reads a JSON-string body for both inputs and trigger", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "http-body",
          payload_json: JSON.stringify({
            method: "POST",
            pathAndQuery: "/etrade/screen",
            body: JSON.stringify({ trigger: "scheduled", universe: "NASDAQ100" }),
          }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("scheduled");
    expect(runs[0].inputs).toMatchObject({ body: { trigger: "scheduled", universe: "NASDAQ100" } });
  });

  it("returns null for a job with no result rather than an empty success", () => {
    expect(stageOutputSummary(job({ job_id: "j" }))).toBeNull();
    const withResult = stageOutputSummary(
      job({ job_id: "j", result_json: JSON.stringify({ done: true }) }),
    ) as Record<string, unknown>;
    expect(withResult.keys).toEqual(["done"]);
  });

  it("counts statuses and triggers for the header", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({ job_id: "a", status: "completed", payload_json: JSON.stringify({ trigger: "manual" }) }),
        job({ job_id: "b", status: "failed", error: "boom", payload_json: JSON.stringify({ trigger: "scheduled" }) }),
      ],
      outcomes: [],
      transitions: [],
    });
    const summary = summarizeWorkflowRuns(runs);
    expect(summary.total).toBe(2);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.byTrigger.manual).toBe(1);
    expect(summary.byTrigger.scheduled).toBe(1);
  });
});

describe("stuck runs (#3784)", () => {
  it("marks a running chain stuck when a job carries the stuck-alert claim", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "job-stuck",
          status: "running",
          started_at: "2026-11-08T15:29:00.000Z",
          stuck_alerted_at: "2026-11-08T15:59:00.000Z",
          payload_json: JSON.stringify({ trigger: "manual" }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    // "Stuck" is a display derivation on running + flagged, not a
    // stored status: the recorded status stays "running".
    expect(runs[0].status).toBe("running");
    expect(runs[0].stuck).toBe(true);
  });

  it("a running chain without the claim is not stuck", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "job-young",
          status: "running",
          started_at: "2026-11-08T15:29:00.000Z",
          payload_json: JSON.stringify({ trigger: "manual" }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].status).toBe("running");
    expect(runs[0].stuck).toBe(false);
  });

  it("a terminal chain is never stuck even when a claim stamp is present", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "job-done",
          status: "completed",
          started_at: "2026-11-08T15:29:00.000Z",
          stuck_alerted_at: "2026-11-08T15:59:00.000Z",
          payload_json: JSON.stringify({ trigger: "manual" }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].status).toBe("completed");
    expect(runs[0].stuck).toBe(false);
  });

  it("stamps trigger and schedule provenance for MCP tool runs (#3810)", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "job-mcp",
          capability: "mcp.tool",
          display_name: "MCP: get_pipeline_chain_status",
          status: "running",
          started_at: "2026-11-08T21:14:31.000Z",
          payload_json: JSON.stringify({
            toolName: "get_pipeline_chain_status",
            actingLogin: "test-trader",
            arguments: { source: "nasdaq100 pipeline" },
          }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("agent");
    expect(runs[0].triggerDetail).toBe("Agent tool call — get_pipeline_chain_status");
    expect(runs[0].triggeredBy).toBe("test-trader");
    expect(runs[0].schedule?.mechanism).toBe("manual");
    expect(runs[0].schedule?.identity).toBe("not-scheduled");
  });
});

/* ------------------------------------------------------------------ */
/* Join key (#4357): wrapper ↔ bridge ↔ engine D1 record               */
/* ------------------------------------------------------------------ */

describe("join key (#4357)", () => {
  const wrapperId = "dfbe7230-d6e5-4d2e-956f-225caafef1b1";
  const bridgeId = "screener:chat:NASDAQ100:2026-11-13T10:22:40.000Z:abcd1234";
  const workflowId = "wf-00000000-0000-0000-0000-000000000001";

  const wrapperRow = () =>
    job({
      job_id: wrapperId,
      job_kind: "main",
      capability: "mcp.tool",
      display_name: "MCP: run_stock_screen",
      status: "running",
      created_at: "2026-11-13T10:22:40.000Z",
      completed_at: null,
      started_at: "2026-11-13T10:22:40.000Z",
    });

  const bridgeRow = (overrides: Partial<WorkflowRunJobRow> = {}) =>
    job({
      job_id: bridgeId,
      job_kind: "main",
      capability: "screener.run",
      display_name: "Stock screen — NASDAQ100",
      status: "running",
      parent_job_id: wrapperId,
      created_at: "2026-11-13T10:22:41.000Z",
      completed_at: null,
      started_at: "2026-11-13T10:22:41.000Z",
      payload_json: JSON.stringify({
        bridge: "screener-run",
        userLogin: "owner",
        trigger: "manual",
        workflowId,
      }),
      ...overrides,
    });

  it("groups a wrapper + bridge pair into ONE run under the wrapper id", () => {
    const runs = buildWorkflowRuns({
      jobs: [wrapperRow(), bridgeRow()],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(wrapperId);
    expect(runs[0].stageCount).toBe(2);
    expect(runs[0].title).toBe("MCP: run_stock_screen");
    expect(runs[0].workflowId).toBe(workflowId);
  });

  it("bridge-first input order still yields the wrapper id", () => {
    const runs = buildWorkflowRuns({
      jobs: [bridgeRow(), wrapperRow()],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(wrapperId);
  });

  it("a bridge with no parent still renders as its own run", () => {
    const runs = buildWorkflowRuns({
      jobs: [bridgeRow({ parent_job_id: null })],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(bridgeId);
  });

  it("no workflow id when no job payload carries one", () => {
    const runs = buildWorkflowRuns({
      jobs: [wrapperRow()],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].workflowId).toBeNull();
  });

  it("d1RecordLinkedToJobs links an engine record to its bridge row only", () => {
    const record = buildJobRunRecord({
      system: "job-pipeline",
      jobId: bridgeId,
      operation: "job",
      started: "2026-11-13T10:22:41.000Z",
      finished: "2026-11-13T10:22:55.000Z",
      outcome: "success",
      triggeredBy: "manual",
      asyncJobId: bridgeId,
    });
    expect(d1RecordLinkedToJobs(record, [bridgeRow()])).toBe(true);
    expect(d1RecordLinkedToJobs(record, [wrapperRow()])).toBe(false);
    const unlinked = buildJobRunRecord({
      system: "job-pipeline",
      jobId: bridgeId,
      operation: "job",
      started: "2026-11-13T10:22:41.000Z",
      finished: "2026-11-13T10:22:55.000Z",
      outcome: "success",
      triggeredBy: "manual",
    });
    expect(unlinked.asyncJobId).toBeNull();
    expect(d1RecordLinkedToJobs(unlinked, [bridgeRow()])).toBe(false);
  });
});
