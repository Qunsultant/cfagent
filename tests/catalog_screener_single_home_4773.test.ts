/**
 * Issue #4773 — the catalog screener spec is the single home of the
 * screener family's execution-mode default (Option A; discussion outcome
 * 2026-11-18, comment 6973316525, superseding the reversal ruling in
 * comment 6972517747). The catalog literal STAYS: the mode belongs in
 * the job definition, and the definition lives in the catalog.
 *
 * The pin refuses a silent divergence in four ways:
 * (1) the catalog literal is the one home — the externalized constant
 *     derives from it and agrees with it, and the env knob overlays it;
 * (2) the env override reaches a catalog-driven run through the
 *     mesh-door path (the mode the run starts with);
 * (3) a spec-defined job (scheduled / UX-defined) runs on the spec's
 *     mode — the mode must reach the engine's resolved config, not sit
 *     in a field the resolver never reads;
 * (4) a mode change patched onto a stored definition reaches the next
 *     definition version — the path `set_job_execution_mode` takes.
 *
 * The engine resolves the job-level mode from `root.executionMode`
 * ONLY (`resolveJobDefinition`, jobPipelineConfig.ts) — a top-level
 * `executionMode` on a raw job config is never read. Two writers used
 * to write that dead field: `buildJobConfigFromSpec` (the spec's mode)
 * and `setPipelineJobExecutionMode` (the `configureJob` patch). Both
 * are fixed to land the mode on the root node; the last test pins the
 * resolver contract so the dead field cannot silently come back.
 */
import { describe, expect, it } from "vitest";
import { jobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import {
  SCREENER_DEFAULT_EXECUTION_MODE,
  resolveScreenerDefaultExecutionMode,
} from "../src/config/screenerExecutionMode";
import { buildScreenerJobDefinition } from "../src/services/screenerPipelineJobs";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import {
  mergeJobConfigPatch,
  resolveJobDefinition,
} from "../src/services/jobPipelineConfig";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";

const CATALOG_MODE = {
  concurrency: "sequential",
  pacing: "batch",
  delivery: "async",
  shape: "monolith",
} as const;

// A mode that differs from the engine default where it can: delivery
// sync (not async), concurrency parallel (not sequential). Pacing and
// shape match the engine default, so the delivery/concurrency axes are
// the ones that prove the spec's mode reaches the resolved config.
const OTHER_MODE = {
  concurrency: "parallel",
  pacing: "batch",
  delivery: "sync",
  shape: "monolith",
} as const;

function command(over: Record<string, unknown> = {}) {
  return {
    jobId: "screen-4773",
    type: "run-screen" as const,
    source: "mesh-door",
    trigger: "manual" as const,
    userLogin: "owner",
    role: "parent" as const,
    shards: [{ id: "shard-1", symbol: "AAPL" }] as never,
    filters: {},
    ...over,
  } as never;
}

describe("catalog screener spec is the single execution-mode home (#4773)", () => {
  it("the catalog literal is the one home and the constant derives from it", () => {
    expect(jobDefinitionSpec("screener").executionMode).toEqual(CATALOG_MODE);
    expect(SCREENER_DEFAULT_EXECUTION_MODE).toEqual(CATALOG_MODE);
    expect(resolveScreenerDefaultExecutionMode()).toEqual(CATALOG_MODE);
  });

  it("the env override overlays the catalog default axis by axis", () => {
    const resolved = resolveScreenerDefaultExecutionMode({
      SCREENER_DEFAULT_EXECUTION_MODE: '{"delivery":"sync"}',
    });
    expect(resolved).toEqual({ ...CATALOG_MODE, delivery: "sync" });
  });

  it("the env override reaches a catalog-driven run through the mesh-door path", () => {
    const mode = resolveScreenerDefaultExecutionMode({
      SCREENER_DEFAULT_EXECUTION_MODE: '{"delivery":"sync"}',
    });
    const def = buildScreenerJobDefinition(command({ executionMode: mode })) as any;
    expect(def.root.executionMode).toEqual({ ...CATALOG_MODE, delivery: "sync" });
    const plain = buildScreenerJobDefinition(command()) as any;
    expect(plain.root.executionMode).toEqual(CATALOG_MODE);
  });

  it("a spec-defined job runs on the spec's mode, not the engine default", () => {
    const spec = { ...jobDefinitionSpec("screener"), executionMode: { ...OTHER_MODE } };
    const resolved = resolveJobDefinition(buildJobConfigFromSpec(spec, "job-4773"));
    expect(resolved.config.executionMode).toEqual(OTHER_MODE);
  });

  it("the screener spec itself resolves to the catalog literal", () => {
    const resolved = resolveJobDefinition(
      buildJobConfigFromSpec(jobDefinitionSpec("screener"), "job-4773"),
    );
    expect(resolved.config.executionMode).toEqual(CATALOG_MODE);
  });

  it("a mode change patched onto the root reaches the next definition version", () => {
    const raw = buildJobConfigFromSpec(jobDefinitionSpec("screener"), "job-4773");
    const patched = mergeJobConfigPatch(raw, { root: { executionMode: { ...OTHER_MODE } } });
    const resolved = resolveJobDefinition(patched);
    expect(resolved.config.executionMode).toEqual(OTHER_MODE);
  });

  it("a top-level executionMode patch is NOT read by the resolver", () => {
    const raw = buildJobConfigFromSpec(jobDefinitionSpec("screener"), "job-4773");
    const patched = mergeJobConfigPatch(raw, { executionMode: { ...OTHER_MODE } });
    const resolved = resolveJobDefinition(patched);
    expect(resolved.config.executionMode).toEqual(CATALOG_MODE);
  });

  it("configureJob with a root patch changes the mode the next run uses", async () => {
    // The exact path `set_job_execution_mode` takes: define the job from
    // the spec, then configureJob with the patch. Before the fix the
    // patch landed on the top level and the next run kept the old mode
    // while the tool reported appliedTo: "next-run".
    const stores = createInMemoryJobPipelineStores();
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: new JobStepRegistry(),
    });
    await control.defineJob(buildJobConfigFromSpec(jobDefinitionSpec("screener"), "job-4773"));
    const before = await control.getJob("job-4773");
    expect(before.definition.config.executionMode).toEqual(CATALOG_MODE);
    await control.configureJob("job-4773", { root: { executionMode: { ...OTHER_MODE } } });
    const after = await control.getJob("job-4773");
    expect(after.definition.config.executionMode).toEqual(OTHER_MODE);
  });
});
