/**
 * Issue #4453 (sub-issue of #4289) — the scan-run store + stage
 * queue in the workflow residency, for the options steps.
 *
 * Two legs, two verdicts:
 *
 * QUEUE (built): the residency binds the stage-message queue from
 * env. `stageQueueSendFromEnv` is the env-built StageQueueSend the
 * issue notes did not exist; `optionsStepDepsForWorkflow` wires it,
 * so a workflow-resident options run publishes one boundary message
 * per stage through the same queue the production legs publish
 * through — the queue never drives stages (the engine + workflow
 * steps do); it carries the boundary messages downstream.
 *
 * STORE (decided-not-to, pinned here): the residency binds NO
 * scan-run store. The scan-run family is DO-resident (ADR D-0):
 * `createOptionsDiscoveryPorts` builds the DO adapter
 * unconditionally, every reader (Workflow Runs, /api/runs, Reports)
 * reads the DO store, no D1 scan table or adapter exists, and no
 * scan-save door exists on the orchestrator (only the
 * generate-report door, #3940). A D1 store in the residency would
 * be a second home no reader reads — residency scan rows invisible
 * in history. The durable record stays the stage artifact + run
 * record (already D1-backed), and the persist stage's named
 * degradation ("no scan run store bound; the stage artifact is the
 * record") is the contract, pinned by the #4291 scan E2E. What
 * would unblock a store: an owner-ruled D1 cutover (the IV-history
 * #2337 R-2 pattern: migration + adapter + reader cutover), or a
 * scan-save orchestrator door (the #3940 pattern: per-login DO
 * addressing + RPC contract + idempotency).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import {
  optionsStepDepsForWorkflow,
} from "../src/workflows/jobPipelineWorkflow";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import {
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import {
  stageQueueSendFromEnv,
  type StageQueueSend,
} from "../src/workflows/stageQueueTransport";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function targetDate(): string {
  return new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
}

const SCAN_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "residency-4453-scan" },
  trigger: "manual",
  classInput: {
    scan: {
      symbols: ["AAPL"],
      template: {
        thesis: "bullish",
        targetDate: targetDate(),
        expectedIvDirection: "unchanged",
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
        minDte: 14,
        maxDte: 60,
        contractLimit: 500,
        candidateLimit: 10,
        maxStrikesPerSide: 12,
        maxIronCondors: 100,
        maxQuoteAgeSeconds: 60,
        eventPolicy: "warn",
      },
      options: { riskProfile: "balanced" },
    },
  },
};

/** A journal that records every step name and executes the handler. */
function recordingJournal() {
  const names: string[] = [];
  return {
    names,
    step: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        names.push(name);
        return fn();
      },
    },
  };
}

function hostStepDeps(
  stores: JobPipelineStores,
  overrides: Partial<OptionsWorkflowStepDeps> = {},
): OptionsWorkflowStepDeps {
  return {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    // No chain source: the static test-chains fixture intercepts the
    // screener's fetches (the #4271 panel-helper idiom).
    chainSourceFor: () => undefined,
    ...overrides,
  };
}

function hostFlowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  deps: OptionsWorkflowStepDeps,
): JobPipelineDeps {
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), deps),
    invocation: "workflow-shard",
  };
}

function fakeStores() {
  const stores = createInMemoryJobPipelineStores();
  const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
  return { stores, runRecorder };
}

/** A recording queue binding: the SCREENER_EVENTS send seam. */
function recordingQueue() {
  const sent: unknown[] = [];
  const queue: StageQueueSend = {
    send: async (body: unknown) => {
      sent.push(body);
    },
  };
  return { sent, queue };
}

describe("scan-run store + stage queue in the workflow residency (#4453)", () => {
  it("stageQueueSendFromEnv returns the bound queue binding", () => {
    const { queue } = recordingQueue();
    const env = { SCREENER_EVENTS: queue } as unknown as Env;
    expect(stageQueueSendFromEnv(env)).toBe(queue);
  });

  it("stageQueueSendFromEnv returns null when the binding is absent", () => {
    expect(stageQueueSendFromEnv({} as Env)).toBeNull();
    expect(stageQueueSendFromEnv({ SCREENER_EVENTS: undefined } as unknown as Env)).toBeNull();
  });

  it("optionsStepDepsForWorkflow binds the queue from env, and no scan-run store", () => {
    const stores = createInMemoryJobPipelineStores();
    const { queue } = recordingQueue();
    const env = { SCREENER_EVENTS: queue } as unknown as Env;
    const deps = optionsStepDepsForWorkflow(env, stores);
    expect(deps.queue).toBe(queue);
    // The store leg's decided-not-to, pinned: the residency supplies
    // no scan-run store, so the persist stage's named degradation
    // (pinned by the #4291 scan E2E) is the contract.
    expect(deps.scanRunStore).toBeUndefined();
    // The pre-existing bindings are unchanged.
    expect(deps.definitions).toBe(stores.definitions);
    expect(deps.artifacts).toBe(stores.artifacts);
    expect(deps.env).toBe(env);
    expect(deps.chainSourceFor?.(undefined, SCAN_REQUEST)).toBeUndefined();
  });

  it("optionsStepDepsForWorkflow binds a null queue when the binding is absent", () => {
    const stores = createInMemoryJobPipelineStores();
    const deps = optionsStepDepsForWorkflow({} as Env, stores);
    expect(deps.queue).toBeNull();
    expect(deps.scanRunStore).toBeUndefined();
  });

  it("a scan-shape run through the host publishes one boundary message per stage to the queue", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const { sent, queue } = recordingQueue();
      const deps = hostFlowDeps(stores, runRecorder, hostStepDeps(stores, { queue }));
      const runId = "residency-4453:scan:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(deps);
      await control.defineJob(strategyScreenJobDefinition(jobId, SCAN_REQUEST, "tester"));
      const journal = recordingJournal();
      const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      const messages = sent as Array<{
        runId: string;
        family?: string;
        stageId: string;
        artifactKeys: string[];
        userLogin: string;
        idempotencyKey: string;
      }>;
      expect(messages.map((message) => message.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
      for (const message of messages) {
        expect(message.runId).toBe(runId);
        expect(message.family).toBe("options");
        expect(message.userLogin).toBe("tester");
        expect(message.artifactKeys.length).toBeGreaterThan(0);
        expect(message.idempotencyKey).toBe(`${runId}::options::${message.stageId}`);
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
