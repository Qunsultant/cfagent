/**
 * Issue #4452 (sub-issue of #4289) — the options steps in the
 * ScheduledAgent host-side registry.
 *
 * Only the workflow residency composed the options steps (#4289 wired
 * optionsStepDepsForWorkflow into createJobPipelineWorkflowDeps). The
 * host-side registry — the createPipelineStepRegistry call sites in
 * src/agents/scheduledTasksPipeline.ts — lacked them, so a job
 * dispatched from the host side (dispatchScheduledPipelineJob runs it
 * on the host control, invocation "sync") could not execute options
 * steps in the host residency: runJob failed job_step_unknown on
 * options.runRoot.
 *
 * This slice composes the options steps into the host-side registry
 * with host-side deps (definition + artifact stores over D1,
 * chain source from the host's seams, the stage-message
 * queue from env), following the screener precedent in both
 * residencies (#4192). The registration is the shared resolving one
 * (registerOptionsWorkflowSteps) — the same step names, the same
 * shared step body, the same named refusals as the workflow
 * residency. No scan-run store is bound: the #4453 decided-not-to
 * applies identically on the host — the scan-run family's home is
 * the per-login store every reader reads, not the ScheduledAgent's
 * own SQLite — and the persist stage's named degradation is the
 * contract.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createScheduledAgentPipelineControl,
  optionsStepDepsForScheduledAgent,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import { createJobPipelineStoresFromD1 } from "../src/data/createJobPipelinePorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { registerOptionsWorkflowSteps } from "../src/services/optionsPipelineJobs";
import { ETradeRestClient } from "../src/trading";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import {
  optionsStepDepsForWorkflow,
} from "../src/workflows/jobPipelineWorkflow";
import {
  OPTIONS_SCREEN_STEP,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import {
  OptionsStepPortsError,
} from "../src/workflows/optionsStepPorts";
import type { StageQueueSend } from "../src/workflows/stageQueueTransport";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { MockD1Database } from "./mock-d1";

/** The node:sqlite DO-storage double (tests/job_pipeline_3534 idiom). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function makeHostContext(env: Partial<Env> = {}) {
  const sql = new SqliteTestStorage();
  const d1 = new MockD1Database();
  const kv = new Map<string, unknown>();
  const agentCtx = {
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
    },
  };
  const ctx = {
    env: { AGENT_DB: d1 as unknown as Env["AGENT_DB"], ...env } as Env,
    agentCtx: agentCtx as unknown as ScheduledTasksPipelineContext["agentCtx"],
  } satisfies ScheduledTasksPipelineContext;
  return { ctx, d1, kv };
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
  runIdentity: { runId: "host-4452-scan" },
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

const COMPARISON_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "host-4452-comparison" },
  trigger: "manual",
  classInput: { comparisonRequest: { symbols: ["AAPL"] } },
};

describe("options steps in the ScheduledAgent host registry (#4452)", () => {
  it("optionsStepDepsForScheduledAgent binds the host stores, env, chain source, and queue — and no scan-run store", async () => {
    const { queue } = recordingQueue();
    const { ctx } = makeHostContext({ SCREENER_EVENTS: queue } as unknown as Partial<Env>);
    const deps = optionsStepDepsForScheduledAgent(ctx);
    expect(deps.env).toBe(ctx.env);
    expect(deps.queue).toBe(queue);
    // The store leg's decided-not-to (#4453), pinned for the host
    // residency too: the persist stage's named degradation is the
    // contract, not a second scan-run home.
    expect(deps.scanRunStore).toBeUndefined();
    expect(deps.chainSourceFor?.(undefined, SCAN_REQUEST)).toBeUndefined();
    expect(deps.chainSourceFor?.("tester", SCAN_REQUEST)).toBeInstanceOf(ETradeRestClient);
    // The stores are the host's own: a job defined on the host
    // control reads back through the builder's definition store,
    // and the artifact store round-trips over the same storage.
    const control = createScheduledAgentPipelineControl(ctx, "tester");
    const jobId = strategyScreenJobId("host-4452:deps:1");
    await control.defineJob(strategyScreenJobDefinition(jobId, SCAN_REQUEST, "tester"));
    expect((await deps.definitions.getDefinition(jobId))?.jobId).toBe(jobId);
    await deps.artifacts.putArtifact("engine-run-1", "probe-key", { ok: true });
    expect(await deps.artifacts.getArtifact("engine-run-1", "probe-key")).toEqual({ ok: true });
  });

  it("optionsStepDepsForScheduledAgent binds a null queue when the binding is absent", () => {
    const { ctx } = makeHostContext();
    const deps = optionsStepDepsForScheduledAgent(ctx);
    expect(deps.queue).toBeNull();
    expect(deps.scanRunStore).toBeUndefined();
  });

  it("the resolving step refuses identically through host-builder and workflow-builder deps", async () => {
    const runId = "host-4452:parity:1";
    const jobId = strategyScreenJobId(runId);
    const stepCtx = {
      jobId,
      runId: "engine-run-parity",
      nodePath: "1",
      kind: "chainFetch",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { stageId: "chainFetch" },
      input: undefined,
      now: new Date().toISOString(),
    };
    // Host side: the definition lives in the host D1 store, the
    // registration is fed the host builder's deps.
    const { ctx } = makeHostContext();
    const hostControl = createScheduledAgentPipelineControl(ctx, "tester");
    await hostControl.defineJob(strategyScreenJobDefinition(jobId, COMPARISON_REQUEST, "tester"));
    const hostRegistry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      optionsStepDepsForScheduledAgent(ctx),
    );
    const hostFailure = await hostRegistry.resolve(OPTIONS_SCREEN_STEP)(stepCtx).then(
      () => null,
      (error: unknown) => error,
    );
    // Workflow side: the same definition in the residency's stores,
    // the registration fed the workflow builder's deps.
    const stores = createInMemoryJobPipelineStores();
    const workflowControl = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: registerOptionsWorkflowSteps(
        createBuiltinStepRegistry(),
        optionsStepDepsForWorkflow({} as Env, stores),
      ),
      invocation: "workflow-shard",
    });
    await workflowControl.defineJob(strategyScreenJobDefinition(jobId, COMPARISON_REQUEST, "tester"));
    const workflowRegistry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      optionsStepDepsForWorkflow({} as Env, stores),
    );
    const workflowFailure = await workflowRegistry.resolve(OPTIONS_SCREEN_STEP)(stepCtx).then(
      () => null,
      (error: unknown) => error,
    );
    expect(hostFailure).toBeInstanceOf(OptionsStepPortsError);
    expect(workflowFailure).toBeInstanceOf(OptionsStepPortsError);
    expect((hostFailure as OptionsStepPortsError).code).toBe("stage_port_unavailable");
    expect((workflowFailure as OptionsStepPortsError).code).toBe("stage_port_unavailable");
    expect((hostFailure as Error).message).toBe((workflowFailure as Error).message);
  });

  it("a host-dispatched scan-shape job executes all eight stages in the host residency", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sent, queue } = recordingQueue();
      const { ctx, d1 } = makeHostContext({ SCREENER_EVENTS: queue } as unknown as Partial<Env>);
      const control = createScheduledAgentPipelineControl(ctx, "tester");
      const runId = "host-4452:scan:1";
      const jobId = strategyScreenJobId(runId);
      await control.defineJob(strategyScreenJobDefinition(jobId, SCAN_REQUEST, "tester"));
      const dispatch = await control.runJob(jobId, { trigger: "scheduled" });
      expect(dispatch.state).toBe("completed");
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
      const record = await new D1JobRunRecordStore(
        createD1JobRunRecordDb(d1 as never),
      ).latestByJob(jobId);
      expect(record?.outcome).toBe("success");
      const stores = createJobPipelineStoresFromD1(d1 as never);
      const keys = await stores.artifacts.listArtifactKeys(dispatch.runId);
      // The store also holds the engine's own bookkeeping keys
      // (<nodePath>/output, /stage-output, /step-0); the eight
      // stage artifacts ride beside them, keyed by options run id.
      for (const stageId of OPTIONS_PIPELINE_STAGES) {
        expect(keys).toContain(optionsArtifactKey(runId, stageId));
      }
      const shapeReport = await stores.artifacts.getArtifact(
        dispatch.runId,
        optionsArtifactKey(runId, "shapeReport"),
      );
      expect(shapeReport).toBeDefined();
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("a host-dispatched comparison-shape job refuses by name, as in the workflow residency", async () => {
    const { ctx, d1 } = makeHostContext();
    const control = createScheduledAgentPipelineControl(ctx, "tester");
    const runId = "host-4452:comparison:1";
    const jobId = strategyScreenJobId(runId);
    await control.defineJob(strategyScreenJobDefinition(jobId, COMPARISON_REQUEST, "tester"));
    const dispatch = await control.runJob(jobId, { trigger: "scheduled" });
    expect(dispatch.state).toBe("failed");
    const record = await new D1JobRunRecordStore(
      createD1JobRunRecordDb(d1 as never),
    ).latestByJob(jobId);
    expect(record?.outcome).toBe("failure");
    // The run record carries the refusal's message; the code
    // (stage_port_unavailable) lives on the thrown error, pinned
    // by the handler-parity test above.
    expect(record?.error ?? "").toMatch(/a comparison run is a single engine step/);
  });
});
