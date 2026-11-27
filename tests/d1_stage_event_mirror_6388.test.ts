// @vitest-environment node
/**
 * Issue #6388 — the OODA dispatch writes the D1 stage-event mirror.
 *
 * The engine mirrors each terminal stage row to D1 best-effort, but only when
 * the control carries `stageEventsMirror`. The stage-control path and the read
 * path already did; the dispatch did not — so a dispatch-path run was
 * unreadable from D1 once its DO was gone (and a D1-only reader saw nothing).
 *
 * Issue #6101 (step 7): the mirror IS the writer now. The DO leg and the
 * `stageEventsMirror` dep are deleted; the dispatch carries the D1 store
 * as `stageEvents`. What this file pins now, at the control's own seam:
 *  - 6388-P01 a dispatch given a D1 carries the D1 writer on its control;
 *  - 6388-P02 a dispatch given no D1 carries no stage-events store
 *    (never a store over undefined, never a throw);
 *  - 6388-P03 a dispatch given both a DO sql and a D1 carries ONLY the
 *    D1 writer — the DO sql feeds the engine's other stores, never a
 *    stage-event store.
 *
 * The control is captured through the ONE factory (#6250) the dispatch must
 * build it through, so a regression that bypasses the factory fails here too.
 */
import { describe, expect, it, vi } from "vitest";

const { capturedDeps } = vi.hoisted(() => ({
  capturedDeps: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/services/jobPipelineControlFactory", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createJobPipelineControl: (deps: Record<string, unknown>) => {
      capturedDeps.push(deps);
      return {
        defineJob: async () => {},
        runJob: async () => ({
          state: "completed",
          completion: Promise.resolve({ state: "completed", runId: "run-6388" }),
        }),
        getJob: async () => ({
          instance: { currentRunId: "run-6388", state: "completed", lastError: null },
          stages: [],
        }),
      };
    },
  };
});

import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { dispatchResearchEngineRun } from "../src/workflows/researchScreenEngine";

const USER = "alice@example.com";

/** A D1 stand-in: chainable, never touching a real database. */
function fakeD1(): D1Database {
  const statement = {
    bind: () => statement,
    run: async () => ({ success: true }),
    all: async () => ({ results: [] }),
    first: async () => null,
    raw: async () => [],
  };
  return {
    prepare: () => statement,
    exec: async () => ({ count: 0 }),
    batch: async () => [],
  } as unknown as D1Database;
}

/** A DO sql stand-in: same chainable shape the store adapters expect. */
function fakeSql() {
  return {
    exec: (query: string, ...params: unknown[]) => {
      void query;
      void params;
      return [];
    },
  };
}

async function dispatch(extra: Record<string, unknown>) {
  capturedDeps.length = 0;
  await dispatchResearchEngineRun({
    runId: "run-6388",
    userLogin: USER,
    trigger: "manual",
    stores: createInMemoryJobPipelineStores(),
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    researchDeps: {
      runFeedStage: async () => ({ runId: "run-6388", symbols: [], quotes: [] }),
      runEnrichStage: async () => ({ runId: "run-6388", bySymbol: {} }),
    },
    execute: async () => ({ success: true }),
    ...extra,
  } as never);
  const deps = capturedDeps.at(-1);
  expect(deps).toBeTruthy();
  return deps as Record<string, unknown>;
}

describe("#6388 — the dispatch control carries the D1 stage-event writer (#6101 step 7)", () => {
  it("P01: a D1 is wired as the stage-events writer", async () => {
    const deps = await dispatch({ d1: fakeD1() });
    expect(deps.stageEvents).toBeTruthy();
    expect(typeof (deps.stageEvents as { record?: unknown }).record).toBe("function");
    expect(Object.prototype.hasOwnProperty.call(deps, "stageEventsMirror")).toBe(false);
  });

  it("P02: no D1 means no stage-events key at all — never a store over undefined", async () => {
    const deps = await dispatch({});
    expect(Object.prototype.hasOwnProperty.call(deps, "stageEvents")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(deps, "stageEventsMirror")).toBe(false);
  });

  it("P03: with both planes the control carries only the D1 writer", async () => {
    const deps = await dispatch({ sql: fakeSql(), d1: fakeD1() });
    expect(deps.stageEvents).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(deps, "stageEventsMirror")).toBe(false);
  });
});
