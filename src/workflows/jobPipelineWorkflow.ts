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
import { PortThinkWorkflow } from "./portThinkWorkflow";
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
import {
  buildDataProviderPorts,
  type DataProviderPorts,
} from "../data/buildDataProviderPorts";
import { resolveUniverseDepsFromStageInput } from "./universeDepsResidency";
import { resolveChainSourceForRequest } from "./brokerChainSourceResidency";
import { stageQueueSendFromEnv } from "./stageQueueTransport";
import { envStrings as envStringsFromEnv } from "./envStrings";
import { createPipelineStepRegistry } from "../services/enrichPipelineJobs";
import { screenerStepDepsForWorkflow } from "../services/screenerPipelineJobs";
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
import {
  createDoorDeliverySuppressor,
  type DeliveryClaimsDoor,
} from "../services/deliveryClaimsDoor";
import type { AsyncDeliverySuppressor } from "../workflows/screenDeliverySuppression";
import { createFeedDatasetAdapter } from "../data/createFeedDatasetPorts";
import { createProviderCaptureAdapter } from "../data/createProviderCapturePorts";
import { createR2CaptureBlobStorage } from "../data/r2CaptureBlobAdapter";
import { createCaptureWiredFeedProvider } from "../services/feedProviderWiring";
import type { FeedStepDeps } from "../services/feedPipelineJobs";
import { createEnrichedDatasetAdapter } from "../data/createEnrichedDatasetPorts";
import { createAnalyzedDatasetPorts } from "../data/createAnalyzedDatasetPorts";
import { createGeneratedDatasetPorts } from "../data/createGeneratedDatasetPorts";
import { createDeliveryDatasetPorts } from "../data/createDeliveryDatasetPorts";
import { createD1IndexListDb, D1IndexListStore } from "../data/d1IndexListAdapter";
import {
  createIndexMembershipService,
  createListingsDerivedIndexMembershipAdapter,
  createWikipediaIndexMembershipAdapter,
} from "../trading";
import { fetchAllUsStockListings } from "../services/nasdaqListings";
import type { OptionsWorkflowStepDeps } from "../services/optionsPipelineJobs";
import { optionsChainStepDepsForWorkflow } from "../services/optionsChainPipelineJobs";
import { createDefaultResearchStepDeps } from "../services/researchPipelineJobs";
import { fetchWikipediaIndexHtml } from "../services/indexListJob";
import type { JobPipelineDeps } from "../services/jobPipelineEngine";
import { JobPipelineError } from "../services/jobPipelineConfig";
import {
  runJobPipelineWorkflowFlow,
  type JobPipelineWorkflowPayload,
} from "./jobPipelineWorkflowFlow";
import type { JobRunOutcome } from "../services/jobPipelineEngine";

export type { JobPipelineWorkflowPayload } from "./jobPipelineWorkflowFlow";

/** String-valued env entries (the registries' knob source) — one shared implementation, ./envStrings. */

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
    registry: buildGenerateJobRegistry(envStringsFromEnv(env)),
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

/**
 * The feed-step wiring for this workflow residency (#3941,
 * sub of #3550) — the mirror of the host's
 * feedStepDepsForScheduledAgent, so both residencies wire the
 * SAME capture construction: the provider is built by the
 * capture factory with the D1 capture port and the R2-backed
 * metadata store (the workflow residency has no DO storage,
 * so the R2 seam stands in for the host's DO-shaped store).
 * The provider refuses by name where wiring genuinely cannot
 * be built (R2 unbound, AGENT_DB unbound, no service login
 * for the per-login providers) — "workflow residency" alone
 * is no longer such a case. The Worker env rides through so
 * the sentiment job can classify in workflow residency
 * exactly as on the host.
 */
export function feedStepDepsForWorkflow(
  env: Env,
  stores: JobPipelineStores,
): FeedStepDeps {
  const db = env.AGENT_DB;
  const universeStore = new D1IndexListStore(createD1IndexListDb(db as D1Database));
  const fetchHtml = fetchWikipediaIndexHtml;
  const capturePort = createProviderCaptureAdapter(env) ?? undefined;
  const blobStorage = createR2CaptureBlobStorage(env) ?? undefined;
  return {
    registry: buildFeedJobRegistry(envStringsFromEnv(env)),
    // Issue #5823: the per-request override rides through to the
    // #3941 factory — the run's own login for the per-login
    // providers (never the host's service login) and the Yahoo
    // breaker (screener binds only). The feed step passes no
    // override, so its provider is exactly as before.
    providerFor: (def, opts) =>
      createCaptureWiredFeedProvider(def, {
        env,
        blobStorage,
        capturePort,
        userLogin: opts?.userLogin ?? getServiceUserLogin(env) ?? undefined,
        ...(opts?.yahooBreaker ? { yahooBreaker: opts.yahooBreaker } : {}),
      }),
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
        // #5956 — the listings-derived adapter (tech / etf /
        // lev_etf): bound for real, never a stub — a cold-store
        // hydration for one of those universes calls it.
        listings: createListingsDerivedIndexMembershipAdapter(
          fetchAllUsStockListings,
        ),
      }),
    },
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing
        .shards ?? [],
    userLogin: getServiceUserLogin(env) ?? undefined,
    env,
  };
}

/**
 * The deliver-step suppressor for this workflow residency
 * (#4438): the door-backed async suppressor — claims go
 * through the shared Orchestrator instance's claims door
 * into the ONE mas_delivery_claims table, so a delivery
 * suppressed once stays suppressed across a restart/retry
 * of the run in this residency too. The door resolves
 * lazily on the first claim (the adapter memoizes it), so
 * deps objects build without touching the DO namespace; an
 * unbound namespace fails the first claim closed with the
 * gateway's named error — there is no in-memory fallback
 * in production wiring.
 */
export function createWorkflowDeliveryClaimsSuppressor(
  env: Env,
): AsyncDeliverySuppressor {
  return createDoorDeliverySuppressor(() =>
    actorGateway.stub<DeliveryClaimsDoor>(
      env.ORCHESTRATOR_AGENT,
      SHARED_ORCHESTRATOR_INSTANCE,
    ),
  );
}

/** Build the flow deps from the worker environment (adapter-side only). */
export function optionsStepDepsForWorkflow(
  env: Env,
  stores: JobPipelineStores,
): OptionsWorkflowStepDeps {
  // #4473: the D1 data-provider ports, built once per deps object
  // and memoized (the build schema-ensures the platform tables;
  // the resolving steps resolve universe deps per stage step, and
  // each resolution must not re-run the build). The promise is
  // created lazily, on the first factory call, so deps objects
  // for runs carrying no universe input never touch D1.
  let portsPromise: Promise<DataProviderPorts> | undefined;
  return {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    env,
    // The chain source is the run's broker client, resolved per
    // invocation from the run's broker stage input (#3960): the
    // factory decodes the (broker, mode) descriptor from the
    // stored request and resolves through the platform registry,
    // so two runs may carry different brokers at the same time.
    // Runs carrying no input keep the legacy direct client
    // construction. Tokens resolve from KV via env + login
    // (getValidTokens), so the client is constructible in
    // workflow residency exactly as on the host. No login ⇒ no
    // source ⇒ the chain fetch fails honestly with the
    // screener's no-source error, never a crash.
    chainSourceFor: (userLogin, request, runId) =>
      resolveChainSourceForRequest(env, { userLogin, request, runId }),
    // Issue #4453: the stage-message queue, built from env — the
    // residency publishes one boundary message per stage through
    // the same queue the production legs publish through. Null
    // when the deployment binds no queue: the stages publish
    // nothing and the miss is warned, never failed. No scan-run
    // store is bound here, by decided-not-to (#4453): the
    // scan-run family lives in the per-login store every reader
    // reads, and no residency-side home exists — the persist
    // stage's named degradation is the contract.
    queue: stageQueueSendFromEnv(env),
    // #4473: the universe deps factory — the resolving steps call
    // it only when the stored request carries a universe stage
    // input. The ports build once (memoized above); the factory
    // itself resolves per invocation over those ports, with the
    // R2 capture store when REPORTS_BUCKET is bound.
    universeDepsFor: async (args) => {
      portsPromise ??= buildDataProviderPorts(env);
      return resolveUniverseDepsFromStageInput(env, args, {
        ports: await portsPromise,
      });
    },
  };
}

export function createJobPipelineWorkflowDeps(env: Env): JobPipelineDeps {
  if (!env.AGENT_DB) {
    throw new JobPipelineError(
      "job_stores_unavailable",
      "Job pipeline workflow cannot build its stores: the AGENT_DB (D1 AgentDB) binding is not configured.",
    );
  }
  const db = env.AGENT_DB;
  const stores = createJobPipelineStoresFromD1(db);
  // Issue #5823: the feed deps are built once and shared — the feed
  // steps run through them, and the screener steps bind their
  // quote/history deps over the same #3941 provider construction.
  const feedDeps = feedStepDepsForWorkflow(env, stores);
  const runRecords = new D1JobRunRecordStore(createD1JobRunRecordDb(db));
  const messaging = createJobPipelineMessaging(env);
  const envStrings = envStringsFromEnv(env);
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
    // the universe step runs (its service is a network fetch).
    // The feed step is wired in this residency too (#3941): its
    // provider is built by the capture factory with the D1
    // capture port and the R2-backed metadata store — the same
    // capture construction the host uses, minus the DO sql
    // handle this residency does not have — so a feed pull
    // dispatched here executes exactly as on the host. Where
    // wiring genuinely cannot be built (R2 unbound, AGENT_DB
    // unbound, no service login for the per-login providers)
    // the step still refuses FEED_JOB_NOT_CONFIGURED by name
    // rather than fetching uncaptured.
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
    // (deliverJobs.ts carries the rule). The screener steps
    // compose here too (#4190, wired in #4192; #5823): their
    // quote/history deps are bound over the #3941 provider from
    // the feed deps, so a screener job dispatched here executes
    // fully in this residency. The
    // options steps compose here too (#4289): the resolving
    // registration reads the dispatch request back out of the
    // stored definition and rebuilds the stage ports per
    // invocation, over the artifact-store stage storage — so an
    // options job dispatched here executes durably, with the
    // workflow step as the engine's journal.
    steps: createPipelineStepRegistry(
      feedDeps,
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
        // Duplicate-delivery suppression, re-homed (#3943)
        // through the durable claims door (#4438): the
        // workflow residency has no DO SQLite of its own,
        // so the suppressor claims through the shared
        // Orchestrator instance's door into the ONE
        // mas_delivery_claims table — the delivery-store
        // resume check is no longer the only durable
        // cross-run guard. The door resolves lazily on
        // the first claim; an unbound namespace fails
        // that claim closed, never a silent send.
        suppressor: createWorkflowDeliveryClaimsSuppressor(env),
        shardsFor: async (jobId) =>
          (await stores.definitions.getDefinition(jobId))?.config.processing
            .shards ?? [],
      },
      // Issue #4190 (#3550 S1, wired in #4192; #5823): the screener steps
      // compose here too — their quote/history deps are bound over the
      // #3941 provider from the feed deps, not at stage time.
      screenerStepDepsForWorkflow(env, feedDeps),
      // Issue #4289: the options steps compose here too — the
      // resolving registration, over the D1 definition + artifact
      // stores, so an options job dispatched here executes durably.
      optionsStepDepsForWorkflow(env, stores),
      // Issue #4780: the options-chain steps compose here too — the
      // chain job's six steps, resolved per invocation from the chain
      // on the stored definition, so a chain dispatched here executes
      // durably, with the workflow step as the engine's journal.
      optionsChainStepDepsForWorkflow(env),
      // Issue #5237: research steps (`analyze.ooda` and `evaluate.apply`) compose
      // into the shared registry in the workflow residency.
      createDefaultResearchStepDeps(),
    ),
    invocation: "workflow-shard",
    // Issue #4782 S3 — the policy resolves from this env (the
    // platform-default layer); the engine reads nothing itself.
    env: envStrings,
  };
}

export class JobPipelineWorkflow extends PortThinkWorkflow<
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
    // Issue #4454 — the workflow instance id is the replay
    // proof: stable across replays of this instance, distinct
    // across instances, so a replayed flow can prove it
    // dispatched the still-running run it resumes.
    return runJobPipelineWorkflowFlow(deps, step, event.payload, {
      workflowInstanceId: event.instanceId,
    });
  }
}
