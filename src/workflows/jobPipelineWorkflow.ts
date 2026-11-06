/**
 * Issue #3534 (Pipeline J1) — JobPipelineWorkflow: the workflow
 * adapter for pipeline jobs. Thin by design (mirroring
 * ScreenerScreenWorkflow / TradingTradeWorkflow): run() validates
 * the payload, builds the flow deps from the environment, and
 * delegates to runJobPipelineWorkflowFlow. Every decision lives
 * in the flow and the engine, behind fakeable interfaces — this
 * module is the only workflow-side place that names bindings.
 *
 * Residency: a workflow has no host Durable Object to borrow
 * SQLite from, so the deps build over the shared D1 AgentDB —
 * the job-pipeline stores' D1 adapter and the D1 adapter of the
 * EXISTING job-run-record port (one machinery, two residencies;
 * see src/data/d1JobRunRecordAdapter.ts). An unbound AGENT_DB
 * fails the run closed with a coded error — there is no
 * in-memory fallback in production wiring.
 *
 * Base class note: ThinkWorkflow, NOT WorkflowEntrypoint (the
 * repo's real runtime base; see screenerWorkflow.ts). The agent
 * type is intentionally `any`: no single Think agent owns
 * pipeline jobs — the control plane is host-agnostic.
 */
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import { createJobPipelineStoresFromD1 } from "../data/createJobPipelinePorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../data/d1JobRunRecordAdapter";
import { createJobPipelineMessaging } from "../messaging/createJobPipelineMessaging";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import type { JobPipelineDeps } from "../services/jobPipelineEngine";
import { JobPipelineError } from "../services/jobPipelineConfig";
import {
  runJobPipelineWorkflowFlow,
  type JobPipelineWorkflowPayload,
} from "./jobPipelineWorkflowFlow";
import type { JobRunOutcome } from "../services/jobPipelineEngine";

export type { JobPipelineWorkflowPayload } from "./jobPipelineWorkflowFlow";

/** Build the flow deps from the worker environment (adapter-side only). */
export function createJobPipelineWorkflowDeps(env: Env): JobPipelineDeps {
  if (!env.AGENT_DB) {
    throw new JobPipelineError(
      "job_stores_unavailable",
      "Job pipeline workflow cannot build its stores: the AGENT_DB (D1 AgentDB) binding is not configured.",
    );
  }
  const db = env.AGENT_DB;
  const runRecords = new D1JobRunRecordStore(createD1JobRunRecordDb(db));
  const messaging = createJobPipelineMessaging(env);
  return {
    stores: createJobPipelineStoresFromD1(db),
    runRecorder: {
      recordRun: (record) => runRecords.record(record),
      listRuns: (jobId, limit) => runRecords.listByJob(jobId, limit),
      latestRun: (jobId) => runRecords.latestByJob(jobId),
    },
    publisher: messaging.ports?.publisher ?? null,
    steps: createBuiltinStepRegistry(),
    invocation: "workflow-shard",
  };
}

export class JobPipelineWorkflow extends ThinkWorkflow<
  any,
  JobPipelineWorkflowPayload,
  DefaultProgress,
  Env
> {
  async run(
    event: WorkflowEvent<JobPipelineWorkflowPayload>,
    step: WorkflowStep,
  ): Promise<JobRunOutcome> {
    const deps = createJobPipelineWorkflowDeps(this.env);
    return runJobPipelineWorkflowFlow(deps, step, event.payload);
  }
}
