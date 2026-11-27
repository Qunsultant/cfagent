// @vitest-environment node
/**
 * Issue #5052 — #3214 triggered dispatch mode (scheduler Run-now button).
 *
 * TDD red→green pins for the triggered mode end to end:
 *  - the options request schema accepts trigger "triggered" (the
 *    server-populated Run Type, #3264) and the schedule builder
 *    round-trips it for the three on-demand callbacks (market screen,
 *    options analysis, strategy discovery);
 *  - normalizeJobRunTrigger passes the five dispatch modes through
 *    and defaults anything else to "manual" (the never-invents rule);
 *  - the real screener feed step carries a "triggered" dispatch into
 *    the screen request (no collapse to "manual");
 *  - Workflow Runs renders a stamped "triggered" run, an outcome-only
 *    "triggered" run, and a canonical report carrying "triggered" —
 *    never "manual", never "unknown";
 *  - the Docs Run Type reads "triggered" for a Run-now run;
 *  - the unified options serve record stores trigger "triggered".
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildSchedulePayload,
  parseUnifiedOptionsRequest,
} from "../src/trading/screeningSchemas";
import {
  buildWorkflowRuns,
  runFromReportDocument,
  triggerLabel,
  type WorkflowRunJobRow,
  type WorkflowRunOutcomeRow,
} from "../src/services/workflowRuns";
import {
  recordUnifiedOptionsRun,
  unifiedOptionsRunRecordToStoreInput,
} from "../src/services/optionsServeRecord";
import {
  registerScreenerSteps,
  SCREENER_FEED_STEP,
} from "../src/services/screenerPipelineJobs";
import {
  createBuiltinStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import { documentRunType } from "../src/client/docsAndReports";

function job(overrides: Partial<WorkflowRunJobRow> & { job_id: string }): WorkflowRunJobRow {
  return {
    capability: "http.request",
    display_name: "Stock screen — NASDAQ100",
    status: "completed",
    created_at: "2026-11-17T12:00:00.000Z",
    completed_at: "2026-11-17T12:01:00.000Z",
    ...overrides,
  };
}

const triggeredOutcome: WorkflowRunOutcomeRow = {
  id: "workflow:orphan-run:shard-1",
  kind: "options",
  trigger: "triggered",
  status: "completed",
  scanned: 10,
  matched: 2,
  origin: "options_scanner",
  createdAt: "2026-11-17T12:00:00.000Z",
};

describe("triggered dispatch mode (#5052)", () => {
  it("the options request schema accepts trigger triggered", () => {
    const parsed = parseUnifiedOptionsRequest({
      action: "screen",
      symbols: ["NVDA"],
      trigger: "triggered",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.request.trigger).toBe("triggered");
  });

  it("the schedule builder round-trips triggered for the three on-demand callbacks", () => {
    const identity = { userLogin: "parity_user", environment: "TEST", trigger: "triggered" as const };
    const cases = [
      ["autonomousMarketScreen", { universe: "NASDAQ100" }],
      ["autonomousOptionsAnalysis", { symbols: ["NVDA"], thesis: "bullish" }],
      [
        "autonomousStrategyDiscovery",
        { inputModel: "profile-derived", profileId: "profile-1", symbols: ["NVDA", "AAPL"] },
      ],
    ] as const;
    for (const [callback, criteria] of cases) {
      const built = buildSchedulePayload(callback, criteria, identity, {
        applyCreationDefaults: false,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      expect(built.value.trigger).toBe("triggered");
    }
  });

  it("normalizeJobRunTrigger passes the five modes through and defaults anything else to manual", async () => {
    // Dynamic import: the export does not exist until the slice
    // lands, and a static import would fail the whole file to load
    // instead of failing just this pin.
    const mod = await import("../src/data/jobRunRecordPorts");
    const normalize = mod.normalizeJobRunTrigger as unknown as
      | ((value: unknown) => string)
      | undefined;
    expect(normalize).toBeDefined();
    if (!normalize) return;
    expect(normalize("triggered")).toBe("triggered");
    expect(normalize("copilot")).toBe("copilot");
    expect(normalize("autopilot")).toBe("autopilot");
    expect(normalize("scheduled")).toBe("scheduled");
    expect(normalize("manual")).toBe("manual");
    expect(normalize("bogus")).toBe("manual");
    expect(normalize(undefined)).toBe("manual");
  });

  it("the real feed step carries a triggered dispatch into the screen request", async () => {
    let capturedTrigger: unknown;
    const fakeAgent = {
      screenFeedStage: async (_runId: string, input: { request: { trigger?: unknown } }) => {
        capturedTrigger = input.request.trigger;
        return {} as never;
      },
    };
    const registry = registerScreenerSteps(createBuiltinStepRegistry(), {
      agentFor: () => fakeAgent,
    } as never);
    const feed = registry.resolve(SCREENER_FEED_STEP);
    await feed({
      runId: "job-5052",
      params: { userLogin: "alice", trigger: "triggered", symbols: [] },
      shardKey: null,
      now: "2026-11-17T12:00:00.000Z",
      input: {},
    } as unknown as JobStepContext);
    expect(capturedTrigger).toBe("triggered");
  });

  it("a job row stamped triggered renders Triggered in Workflow Runs", () => {
    const runs = buildWorkflowRuns({
      jobs: [job({ job_id: "run-now-1", trigger: "triggered" })],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("triggered");
    expect(triggerLabel("triggered")).toBe("Triggered");
  });

  it("an outcome-only triggered run renders triggered, not unknown", () => {
    const runs = buildWorkflowRuns({
      jobs: [],
      outcomes: [triggeredOutcome],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("job-outcome");
    expect(runs[0].trigger).toBe("triggered");
  });

  it("a canonical report carrying triggered renders triggered, not unknown", () => {
    const run = runFromReportDocument({
      reportId: "rep-5052",
      runId: "run-now-1",
      title: "Options analysis — Run-now",
      engineFamily: "options",
      documents: {
        reportId: "rep-5052",
        family: "options",
        pdfUrl: "/api/screening/options/report.pdf?key=o.pdf",
        pdfStatus: "generated",
        pdfError: null,
        xlsxUrl: null,
        xlsxStatus: null,
        xlsxError: null,
        csvUrl: null,
        csvStatus: null,
        csvError: null,
      },
      trigger: "triggered",
      status: "completed",
      createdAt: "2026-11-17T12:00:00.000Z",
    });
    expect(run.trigger).toBe("triggered");
  });

  it("the Docs Run Type reads triggered for a Run-now run", () => {
    expect(documentRunType({ trigger: "triggered" })).toBe("triggered");
    expect(documentRunType({ trigger: "manual" })).toBe("manual");
    expect(documentRunType({ trigger: "scheduled" })).toBe("scheduled");
    expect(documentRunType({ trigger: "goal" })).toBeNull();
  });

  it("the unified options serve record stores trigger triggered", async () => {
    const record = {
      runId: "options:2026-11-17T12:00:00.000Z",
      generationId: "options:2026-11-17T12:00:00.000Z",
      title: "Options analysis — Run-now",
      source: "options_scanner",
      summary: "triggered",
      trigger: "triggered" as const,
      userLogin: "alice",
    };
    const stored = unifiedOptionsRunRecordToStoreInput(record);
    expect((stored.body as Record<string, unknown>).trigger).toBe("triggered");
    const orm = { storeCanonicalReport: vi.fn(() => ({ reportId: "u1", created: true })) };
    const out = await recordUnifiedOptionsRun(orm as never, record);
    expect(out).toEqual({ reportId: "u1", created: true });
    const call = orm.storeCanonicalReport.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    expect(call.body.trigger).toBe("triggered");
  });
});
