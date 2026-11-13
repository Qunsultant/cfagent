// @vitest-environment node
/**
 * Issue #4361 ([Stage visibility] chat stage read) — job-status and
 * sub-job-status endpoints plus their MCP mirrors.
 *
 * Pins:
 *  - 4361-P01 the report: job status + one sub-job per stage, each with the
 *    recorded start/end/duration (nulls stay null).
 *  - 4361-P02 sub-job addressing: by stage id, by kind, by node path; an
 *    unknown or ambiguous address refuses and names the stages.
 *  - 4361-P03 GET /api/jobs/:id/status returns the roll-up; an unknown job
 *    refuses by name (404) and a door outage is a 503, not a pretend 404.
 *  - 4361-P04 GET /api/jobs/:id/stages/:stage returns one sub-job; an
 *    unknown stage refuses with the stages that exist.
 *  - 4361-P05 the MCP tools mirror the endpoints, read the same source, and
 *    are registered + permission-gated; get_async_job is untouched.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobDefinition, JobInstanceRecord } from "../src/data/jobPipelinePorts";
import type { JobStageView, JobStatusView } from "../src/services/jobPipelineEngine";
import { JobRunRecord } from "../src/data/jobRunRecordPorts";
import {
  buildJobStatusReport,
  resolveSubJob,
} from "../src/services/jobStageStatus";
import { handleJobStatusRoutes, jobStatusPayload } from "../src/agents/routes/jobStatus";
import {
  GetJobStageStatusCommand,
  GetJobStatusCommand,
} from "../src/mcps/openaimp/jobStatusCommands";

const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const STAGES = ["feed", "enrich", "analyze", "store", "serve", "deliver"] as const;

function stageView(kind: string, index: number): JobStageView {
  const startedAt = iso(T0 + index * 10_000);
  const endedAt = iso(T0 + index * 10_000 + 5_000);
  return {
    stageId: index === 0 ? "job:root" : `job:${index - 1}`,
    nodePath: index === 0 ? "" : String(index - 1),
    kind,
    startedAt,
    endedAt,
    durationMs: 5_000,
    units: [
      {
        unitId: "run-1",
        status: "completed",
        attempt: 1,
        startedAt,
        endedAt,
      },
    ],
  };
}

function view(over: Partial<JobStatusView> = {}): JobStatusView {
  const definition = {
    jobId: "screen-4361",
    name: "Screen 4361",
    root: { kind: "feed", steps: [] },
    rawConfig: {},
    config: {},
    version: 1,
    updatedAt: iso(T0),
  } as unknown as JobDefinition;
  const instance = {
    jobId: "screen-4361",
    state: "idle",
    desiredState: "none",
    currentRunId: "run-1",
    runStartedAt: iso(T0),
    runTrigger: "manual",
    runScheduleId: null,
    runAsyncJobId: "screen-4361",
    checkpoint: null,
    stageCheckpoint: { runId: "run-1", units: [] },
    stageDesired: null,
    lastError: null,
    updatedAt: iso(T0),
  } as unknown as JobInstanceRecord;
  const latestRun = {
    system: "job-pipeline",
    jobId: "screen-4361",
    operation: "feed",
    started: iso(T0),
    finished: iso(T0 + 60_000),
    outcome: "success",
    triggeredBy: "manual",
    workflowId: "run-1",
  } as unknown as JobRunRecord;
  return {
    definition,
    instance,
    latestRun,
    history: [latestRun],
    stages: STAGES.map((kind, i) => stageView(kind, i)),
    ...over,
  };
}

function fakeEnv(v: JobStatusView | null, opts: { throwMessage?: string } = {}) {
  return {
    SCHEDULED_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({
        getPipelineJobStatus: async () => {
          if (opts.throwMessage) throw new Error(opts.throwMessage);
          return v;
        },
      }),
    },
  };
}

describe("4361-P01 the report carries the job and its sub-jobs", () => {
  it("maps the job verb, window and six stage entries", () => {
    const report = buildJobStatusReport("screen-4361", view());
    expect(report.status).toBe("completed");
    expect(report.startedAt).toBe(iso(T0));
    expect(report.endedAt).toBe(iso(T0 + 60_000));
    expect(report.durationMs).toBe(60_000);
    expect(report.runId).toBe("run-1");
    expect(report.subJobs.map((s) => s.kind)).toEqual([...STAGES]);
    expect(report.subJobs[0].startedAt).toBe(iso(T0));
    expect(report.subJobs[0].durationMs).toBe(5_000);
    expect(report.subJobs.every((s) => s.status === "completed")).toBe(true);
  });

  it("keeps an unrecorded window null instead of inventing one", () => {
    const report = buildJobStatusReport(
      "screen-4361",
      view({ latestRun: undefined, history: [], stages: [] }),
    );
    expect(report.startedAt).toBe(iso(T0));
    expect(report.endedAt).toBeNull();
    expect(report.durationMs).toBeNull();
    expect(report.subJobs).toEqual([]);
  });

  it("reads a running job as running", () => {
    const running = view();
    running.stages = running.stages.map((s) => ({
      ...s,
      endedAt: null,
      durationMs: null,
      units: s.units.map((u) => ({ ...u, status: "running" as const, endedAt: undefined })),
    }));
    const report = buildJobStatusReport("screen-4361", {
      ...running,
      latestRun: undefined,
      instance: { ...running.instance!, state: "running" },
    });
    expect(report.status).toBe("running");
    expect(report.subJobs[0].status).toBe("running");
    expect(report.subJobs[0].endedAt).toBeNull();
  });
});

describe("4361-P02 sub-job addressing", () => {
  it("resolves by stage id, kind, and node path", () => {
    const report = buildJobStatusReport("screen-4361", view());
    expect(resolveSubJob(report, "job:root").ok).toBe(true);
    expect(resolveSubJob(report, "feed").ok).toBe(true);
    expect(resolveSubJob(report, "0").ok).toBe(true);
  });

  it("refuses an unknown stage with the stages that exist", () => {
    const report = buildJobStatusReport("screen-4361", view());
    const resolved = resolveSubJob(report, "publish");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("publish");
      expect(resolved.reason).toContain("job:root");
    }
  });
});

describe("4361-P03 the whole-job endpoint", () => {
  it("returns the roll-up", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4361/status"),
      new URL("https://x/api/jobs/screen-4361/status"),
      "/api/jobs/screen-4361/status",
      { readJobStatus: async () => view() },
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.jobId).toBe("screen-4361");
    expect(body.subJobCount).toBe(6);
    expect(body.subJobs[0].stageId).toBe("job:root");
    expect(body).toEqual(jobStatusPayload(buildJobStatusReport("screen-4361", view())));
  });

  it("refuses an unknown job by name", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/nope/status"),
      new URL("https://x/api/jobs/nope/status"),
      "/api/jobs/nope/status",
      { readJobStatus: async () => null },
    );
    expect(res!.status).toBe(404);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("nope");
  });

  it("reports a door outage as 503, never as not-found", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4361/status"),
      new URL("https://x/api/jobs/screen-4361/status"),
      "/api/jobs/screen-4361/status",
      {
        readJobStatus: async () => {
          throw new Error("ScheduledAgent door is unavailable");
        },
      },
    );
    expect(res!.status).toBe(503);
    expect(((await res!.json()) as any).error).toContain("unavailable");
  });

  it("ignores paths that are not status reads", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/00000000-0000-4000-8000-000000000000"),
      new URL("https://x/api/jobs/00000000-0000-4000-8000-000000000000"),
      "/api/jobs/00000000-0000-4000-8000-000000000000",
      { readJobStatus: async () => null },
    );
    expect(res).toBeNull();
  });
});

describe("4361-P04 the single-sub-job endpoint", () => {
  it("returns one stage", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4361/stages/feed"),
      new URL("https://x/api/jobs/screen-4361/stages/feed"),
      "/api/jobs/screen-4361/stages/feed",
      { readJobStatus: async () => view() },
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.jobId).toBe("screen-4361");
    expect(body.kind).toBe("feed");
    expect(body.status).toBe("completed");
    expect(body.durationMs).toBe(5_000);
  });

  it("refuses an unknown stage with the stages that exist", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4361/stages/publish"),
      new URL("https://x/api/jobs/screen-4361/stages/publish"),
      "/api/jobs/screen-4361/stages/publish",
      { readJobStatus: async () => view() },
    );
    expect(res!.status).toBe(404);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("publish");
    expect(body.error).toContain("job:root");
  });

  it("decodes a stage id that carries a colon", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4361/stages/job%3Aroot"),
      new URL("https://x/api/jobs/screen-4361/stages/job%3Aroot"),
      "/api/jobs/screen-4361/stages/job%3Aroot",
      { readJobStatus: async () => view() },
    );
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).stageId).toBe("job:root");
  });
});

describe("4361-P05 the MCP mirror", () => {
  it("returns the same payload as REST from the same source", async () => {
    const context = { env: fakeEnv(view()) } as any;
    const job = await new GetJobStatusCommand().execute({ jobId: "screen-4361" }, context);
    expect(job).toEqual(jobStatusPayload(buildJobStatusReport("screen-4361", view())));
    const stage = await new GetJobStageStatusCommand().execute(
      { jobId: "screen-4361", stageId: "feed" },
      context,
    );
    expect((stage as any).stageId).toBe("job:root");
    expect((stage as any).status).toBe("completed");
  });

  it("refuses an unknown job and an unknown stage by name", async () => {
    const missing = { env: fakeEnv(null) } as any;
    await expect(new GetJobStatusCommand().execute({ jobId: "nope" }, missing)).rejects.toThrow(
      /No job with id "nope"/,
    );
    const found = { env: fakeEnv(view()) } as any;
    await expect(
      new GetJobStageStatusCommand().execute({ jobId: "screen-4361", stageId: "publish" }, found),
    ).rejects.toThrow(/publish/);
  });

  it("is registered, synchronous and permission-gated; get_async_job is untouched", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "..");
    const commands = readFileSync(join(root, "src/mcps/openaimp/commands.ts"), "utf8");
    expect(commands).toContain("new GetJobStatusCommand()");
    expect(commands).toContain("new GetJobStageStatusCommand()");
    const perms = readFileSync(join(root, "src/mcps/openaimp/mcpPermissionPorts.ts"), "utf8");
    expect(perms).toContain("get_job_status: \"mcp:read\"");
    expect(perms).toContain("get_job_stage_status: \"mcp:read\"");
    const modes = readFileSync(join(root, "src/config/asyncJobModes.ts"), "utf8");
    expect(modes).toContain("\"get_job_status\"");
    expect(modes).toContain("\"get_job_stage_status\"");
    // get_async_job keeps its verbatim passthrough shape (the issue's regression rule).
    const legacy = commands.slice(commands.indexOf("class GetAsyncJobCommand"));
    expect(legacy.slice(0, 1500)).toContain("return job;");
  });
});
