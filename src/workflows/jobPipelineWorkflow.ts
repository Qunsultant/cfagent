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
import { actorGateway } from "../services/cloudflareActorGateway";
import {
  getServiceUserLogin,
  SHARED_ORCHESTRATOR_INSTANCE,
} from "../security/serviceIdentity";
import {
  createJobPipelineStoresFromD1,
  type JobPipelineStores,
} from "../data/createJobPipelinePorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../data/d1JobRunRecordAdapter";
import { createJobPipelineMessaging } from "../messaging/createJobPipelineMessaging";
import { createPipelineStepRegistry } from "../services/enrichPipelineJobs";
import { buildFeedJobRegistry } from "../services/feedJobs";
import { buildEnrichJobRegistry } from "../services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../services/analyzeJobs";
import {
  buildGenerateJobRegistry,
  createTenantAwareCanonicalReportStore,
  type PipelineGenerateReportDoor,
} from "../services/generateJobs";
import type { GenerateStepDeps } from "../services/generatePipelineJobs";
import { buildDeliverJobRegistry, createDeliverChannelSenders } from "../services/deliverJobs";
import { createFeedDatasetAdapter } from "../data/createFeedDatasetPorts";
import { createEnrichedDatasetAdapter } from "../data/createEnrichedDatasetPorts";
import { createAnalyzedDatasetPorts } from "../data/createAnalyzedDatasetPorts";
import { createGeneratedDatasetPorts } from "../data/createGeneratedDatasetPorts";
import { createDeliveryDatasetPorts } from "../data/createDeliveryDatasetPorts";
import { D1IndexListStore } from "../data/d1IndexListAdapter";
import {
  createIndexMembershipService,
  createWikipediaIndexMembershipAdapter,
} from "../trading";
import { fetchWikipediaIndexHtml } from "../services/indexListJob";
import type { JobPipelineDeps } from "../services/jobPipelineEngine";
import { JobPipelineError } from "../services/jobPipelineConfig";
import {
  runJobPipelineWorkflowFlow,
  type JobPipelineWorkflowPayload,
} from "./jobPipelineWorkflowFlow";
import type { JobRunOutcome } from "../services/jobPipelineEngine";

export type { JobPipelineWorkflowPayload } from "./jobPipelineWorkflowFlow";

/** String-valued env entries (the registries' knob source). */
function workflowEnvStrings(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * The generate-step wiring for this workflow residency
 * (#3538, #3940) — the mirror of the host's
 * generateStepDepsForScheduledAgent, so both residencies
 * wire the SAME tenant-aware leg: the canonical copy
 * writes through the orchestrator door into the
 * report-owning tenant's Orchestrator DO, never into a
 * store this residency owns. The leg resolves the tenant
 * per job (the job's configured reportOwnerLogin, else
 * this seam's bound owner — the configured service
 * identity); a job with no resolvable tenant records
 * not_wired with its coded reason.
 */
export function generateStepDepsForWorkflow(
  env: Env,
  stores: JobPipelineStores,
): GenerateStepDeps {
  return {
    registry: buildGenerateJobRegistry(workflowEnvStrings(env)),
    analyzedStore: createAnalyzedDatasetPorts(env),
    generatedStore: createGeneratedDatasetPorts(env),
    canonicalReportStore: createTenantAwareCanonicalReportStore({
      ownerLogin: getServiceUserLogin(env) ?? undefined,
      record: (input) => {
        const door = actorGateway.stub<PipelineGenerateReportDoor>(
          env.ORCHESTRATOR_AGENT,
          SHARED_ORCHESTRATOR_INSTANCE,
        );
        return door.recordPipelineGenerateReport(input);
      },
    }),
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing
        .shards ?? [],
  };
}

/** Build the flow deps from the worker environment (adapter-side only). */
export function createJobPipelineWorkflowDeps(env: Env): JobPipelineDeps {
  if (!env.AGENT_DB) {
    throw new JobPipelineError(
      "job_stores_unavailable",
      "Job pipeline workflow cannot build its stores: the AGENT_DB (D1 AgentDB) binding is not configured.",
    );
  }
  const db = env.AGENT_DB;
  const stores = createJobPipelineStoresFromD1(db);
  const runRecords = new D1JobRunRecordStore(createD1JobRunRecordDb(db));
  const messaging = createJobPipelineMessaging(env);
  const envStrings = workflowEnvStrings(env);
  const universeStore = new D1IndexListStore(
    db as ConstructorParameters<typeof D1IndexListStore>[0],
  );
  const fetchHtml = fetchWikipediaIndexHtml;
  return {
    stores,
    runRecorder: {
      recordRun: (record) => runRecords.record(record),
      listRuns: (jobId, limit) => runRecords.listByJob(jobId, limit),
      latestRun: (jobId) => runRecords.latestByJob(jobId),
    },
    publisher: messaging.ports?.publisher ?? null,
    // #3535/#3536/#3537/#3538/#3539: the workflow residency composes THE same step
    // registry as the ScheduledAgent host (one registry, every
    // residency — the composed registry includes the J1
    // built-ins, the feed steps, enrich.apply, analyze.apply,
    // generate.apply, and deliver.apply). Residency
    // rule: the dataset and index-list stores are D1 here, and
    // the universe step runs (its service is a network fetch),
    // but capture-wired PROVIDERS need a DO host's storage (the
    // capture deps' blob + SQL handles), so providerFor is
    // unwired in this residency and a feed pull dispatched here
    // refuses FEED_JOB_NOT_CONFIGURED by name rather than
    // fetching uncaptured. Feed pulls execute on the
    // ScheduledAgent host residency, which owns that wiring.
    // The enrich step's stores are both D1, so an enrich run
    // dispatched here executes fully in this residency. The
    // analyze step's stores are both D1 too (#3537), so an
    // analyze run dispatched here executes fully as well. The
    // generate step's dataset stores are both D1 (#3538), so a
    // generate run dispatched here also executes fully; its
    // canonical report-store seam (mas_reports) is wired
    // through the tenant-aware leg (#3940) — the generate
    // stage resolves the report-owning tenant per job and
    // writes the canonical copy through the orchestrator
    // door, so the row lands in the tenant's Orchestrator DO
    // in this residency too. A job with no resolvable tenant
    // records its canonical leg not_wired with its coded
    // reason on the generated artifact (generateJobs.ts
    // carries the rule).
    // The deliver step's dataset stores are both D1 too (#3539),
    // and its channel senders are env-built in this residency
    // exactly as on the host, so a deliver run dispatched here
    // also executes fully; a transport this deployment does not
    // configure records its channel not_configured per report
    // (deliverJobs.ts carries the rule).
    steps: createPipelineStepRegistry(
      {
        registry: buildFeedJobRegistry(envStrings),
        providerFor: () => undefined,
        universeStore,
        datasetStore: createFeedDatasetAdapter(env),
        indexRefresh: {
          store: universeStore,
          service: createIndexMembershipService({
            wikipedia: createWikipediaIndexMembershipAdapter(fetchHtml),
            holdings: {
              getMembers: async () => {
                throw new Error(
                  "holdings fetcher not bound — the Wikipedia refresh path never calls it",
                );
              },
            },
          }),
        },
        shardsFor: async (jobId) =>
          (await stores.definitions.getDefinition(jobId))?.config.processing
            .shards ?? [],
      },
      {
        registry: buildEnrichJobRegistry(envStrings),
        datasetStore: createFeedDatasetAdapter(env),
        enrichedStore: createEnrichedDatasetAdapter(env),
        shardsFor: async (jobId) =>
          (await stores.definitions.getDefinition(jobId))?.config.processing
            .shards ?? [],
      },
      {
        registry: buildAnalyzeJobRegistry(envStrings),
        enrichedStore: createEnrichedDatasetAdapter(env),
        analyzedStore: createAnalyzedDatasetPorts(env),
        shardsFor: async (jobId) =>
          (await stores.definitions.getDefinition(jobId))?.config.processing
            .shards ?? [],
      },
      generateStepDepsForWorkflow(env, stores),
      {
        registry: buildDeliverJobRegistry(envStrings),
        generatedStore: createGeneratedDatasetPorts(env),
        deliveryStore: createDeliveryDatasetPorts(env),
        ...createDeliverChannelSenders(env as unknown as Record<string, unknown>),
        shardsFor: async (jobId) =>
          (await stores.definitions.getDefinition(jobId))?.config.processing
            .shards ?? [],
      },
    ),
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
