// @vitest-environment node
/**
 * Issue #4366 ([Stage visibility] UX workflow-definition + scheduling flow).
 *
 * The flow's contract: a definition spec becomes an engine job (validated,
 * owner params stamped), and the schedule that runs it goes through the
 * EXISTING alarm machinery — a unified schedule whose callback is the
 * Orchestrator's `runPipelineJobSchedule`, not a second scheduler.
 *
 * Pins:
 *  - 4366-P01 the spec builds the engine's raw config: the stage chain, the
 *    spec's mode, and the owner params on every stage.
 *  - 4366-P02 GET /api/job-definitions lists the catalogue; POST define
 *    requires a job id, refuses an unknown spec by name, and names a
 *    missing host instead of pretending.
 *  - 4366-P03 the callback is allow-listed for creation and dispatches the
 *    job by id, refusing a payload without one.
 *  - 4366-P04 the client posts the define then arms the schedule with the
 *    shared callback constant and the existing /api/schedules/create path.
 *  - 4366-P05 the host defines from the validated spec with the owner login
 *    stamped into the definition's params.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { handleJobDefinitionsRoutes } from "../src/agents/routes/jobDefinitions";
import { bindJobDefinitionParams } from "../src/services/jobDefinitionParamBinders";
import { CREATABLE_SCHEDULE_CALLBACKS } from "../src/agents/orchestrator/scheduleCallbacks";
import { JOB_DEFINITION_SCHEDULE_CALLBACK, jobIdForSpec } from "../src/config/jobDefinitionScheduling";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function kindsOf(node: any): string[] {
  const out: string[] = [];
  let current = node;
  while (current) {
    out.push(current.kind);
    current = current.children?.[0];
  }
  return out;
}

describe("4366-P01 the spec builds the engine config", () => {
  it("chains the stages, carries the mode and stamps the owner params", () => {
    const config = buildJobConfigFromSpec(jobDefinitionSpec("screener"), "job-1", {
      userLogin: "owner",
    });
    expect(config.jobId).toBe("job-1");
    expect(kindsOf(config.root)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "store",
      "serve",
      "deliver",
    ]);
    expect(config.executionMode).toEqual(
      expect.objectContaining({ concurrency: "sequential", delivery: "async" }),
    );
    const steps = (config.root as any).steps;
    expect(steps[0].params.userLogin).toBe("owner");
  });
});

describe("4366-P02 the definition routes", () => {
  it("lists the catalogue", async () => {
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions"),
      new URL("https://x/api/job-definitions"),
      "/api/job-definitions",
      {},
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.count).toBeGreaterThan(0);
    expect(body.definitions.some((d: any) => d.id === "screener")).toBe(true);
  });

  it("defines a job from a spec", async () => {
    const asked: Array<[string, string]> = [];
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions/screener/define", {
        method: "POST",
        body: JSON.stringify({ jobId: "job-1" }),
      }),
      new URL("https://x/api/job-definitions/screener/define"),
      "/api/job-definitions/screener/define",
      {
        defineJobFromSpec: async (specId, jobId) => {
          asked.push([specId, jobId]);
          return { jobId, name: "Screen", version: 1, stages: 6 };
        },
      },
    );
    expect(res!.status).toBe(200);
    expect(asked).toEqual([["screener", "job-1"]]);
  });

  it("refuses a missing job id and an unknown spec by name", async () => {
    const missing = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions/screener/define", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      new URL("https://x/api/job-definitions/screener/define"),
      "/api/job-definitions/screener/define",
      { defineJobFromSpec: async () => ({ jobId: "x", name: "x", version: 1, stages: 1 }) },
    );
    expect(missing!.status).toBe(400);
    expect(((await missing!.json()) as any).error).toContain("requires a jobId");

    const unknown = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions/nope/define", {
        method: "POST",
        body: JSON.stringify({ jobId: "job-1" }),
      }),
      new URL("https://x/api/job-definitions/nope/define"),
      "/api/job-definitions/nope/define",
      {},
    );
    expect(unknown!.status).toBe(404);
    expect(((await unknown!.json()) as any).error).toContain("No job definition spec with id");
  });

  it("names a missing host instead of pretending", async () => {
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions/screener/define", {
        method: "POST",
        body: JSON.stringify({ jobId: "job-1" }),
      }),
      new URL("https://x/api/job-definitions/screener/define"),
      "/api/job-definitions/screener/define",
      {},
    );
    expect(res!.status).toBe(503);
  });
});

describe("4366-P03 the schedule callback", () => {
  it("is allow-listed for creation through the one schedule store", () => {
    expect(JOB_DEFINITION_SCHEDULE_CALLBACK).toBe("runPipelineJobSchedule");
    expect((CREATABLE_SCHEDULE_CALLBACKS as readonly string[]).includes("runPipelineJobSchedule")).toBe(
      true,
    );
  });

  it("dispatches the job by id and refuses a payload without one", () => {
    const orchestrator = readFileSync(join(root, "src/agents/orchestrator.ts"), "utf8");
    expect(orchestrator).toContain("async runPipelineJobSchedule(payload: unknown)");
    expect(orchestrator).toContain("requires a jobId in its payload");
    expect(orchestrator).toContain("await door.runPipelineJob(jobId, { userLogin });");
  });
});

describe("4366-P04 the client flow reuses the schedule path", () => {
  it("posts define, then arms through /api/schedules/create with the shared callback", () => {
    const client = readFileSync(join(root, "src/client/WorkflowDefinitionFlow.tsx"), "utf8");
    expect(client).toContain("/api/job-definitions");
    expect(client).toContain("/define");
    expect(client).toContain("/api/schedules/create");
    expect(client).toContain("callback: JOB_DEFINITION_SCHEDULE_CALLBACK");
    expect(client).toContain("payload: { jobId }");
    expect(jobIdForSpec("screener", Date.parse("2026-11-13T00:00:00.000Z"))).toBe(
      "jobdef:screener:2026-11-13T00:00:00.000Z",
    );
  });

  it("is mounted on the Workflow Catalog page", () => {
    const page = readFileSync(join(root, "src/client/WorkflowCatalogPage.tsx"), "utf8");
    expect(page).toContain("<WorkflowDefinitionFlow />");
  });
});

describe("4366-P05 the host defines from the validated spec", () => {
  it("resolves the spec, requires a job id, and binds the run parameters", () => {
    const agent = readFileSync(join(root, "src/agents/scheduled-agent.ts"), "utf8");
    expect(agent).toContain("async definePipelineJobFromSpec(");
    expect(agent).toContain("jobDefinitionSpec(specId)");
    expect(agent).toContain("one is never invented");
    expect(agent).toContain("bindJobDefinitionParams(spec, opts?.params ?? {}, ownerLogin)");
    expect(agent).toContain("bindStageOverrides(spec, {");
    expect(agent).toContain("buildJobConfigFromSpec(spec, id, runParams, perStage)");
  });
});

describe("4366-P06 the run parameters are bound and the mutation is CSRF-safe", () => {
  it("binds universe → shards for the screener", () => {
    const bound = bindJobDefinitionParams(jobDefinitionSpec("screener"), { universe: "NASDAQ100" }, "owner");
    expect(bound.userLogin).toBe("owner");
    expect(bound.universe).toBe("NASDAQ100");
    expect(Array.isArray(bound.shards)).toBe(true);
    expect((bound.shards as Array<{ universe?: string }>)[0].universe).toBe("NASDAQ100");
  });

  it("refuses a missing required parameter and an undeclared one by name", () => {
    expect(() => bindJobDefinitionParams(jobDefinitionSpec("screener"), {}, "owner")).toThrow(
      /requires the "universe" parameter/,
    );
    expect(() =>
      bindJobDefinitionParams(jobDefinitionSpec("screener"), { universe: "NASDAQ100", nope: 1 }, "owner"),
    ).toThrow(/does not declare the parameter "nope"/);
    expect(() =>
      bindJobDefinitionParams(jobDefinitionSpec("screener"), { universe: "MARS" }, "owner"),
    ).toThrow(/unknown universe "MARS"/);
  });

  it("the route passes the parameters through, and the client sends them with CSRF", () => {
    const route = readFileSync(join(root, "src/agents/routes/jobDefinitions.ts"), "utf8");
    expect(route).toContain("ctx.defineJobFromSpec(spec.id, jobId, params, {");
    const client = readFileSync(join(root, "src/client/WorkflowDefinitionFlow.tsx"), "utf8");
    expect(client).toContain("csrfHeaders()");
    expect(client).toContain("params: paramValues");
  });
});
