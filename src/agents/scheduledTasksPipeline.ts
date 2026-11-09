/**
 * Issue #3543 (Pipeline J1 host wiring, consumed by J2 #3535) —
 * the job pipeline's host wiring on the ScheduledAgent, in the
 * scheduledTasksCopilot.ts pattern transposed: this module owns
 * the declaration, the control-plane construction, and the
 * dispatch; the class owns storage.
 *
 * Host decision (recorded on #3543): the ScheduledAgent manages
 * and controls the pipeline; the OrchestratorAgent's doors are
 * invoking surfaces over the same control plane. Concretely:
 *
 * - The control plane is built over this agent's DO SQLite (the
 *   pipeline stores' DO residency), its run records go through
 *   the platform JobRunRecordStore (the DO adapter of the same
 *   port the workflow residency serves from D1), and its status
 *   publication rides the JOB_PIPELINE_EVENTS queue substrate.
 * - getScheduledTasks() declarations are built from the control
 *   plane's registerSchedules output over a recording
 *   JobScheduleHost: each registered (job, node) becomes one
 *   Think scheduled task whose handler dispatches
 *   runJob(jobId, { trigger: "scheduled", scopePath }) — the
 *   same dispatch the UX and copilot doors make (#3514).
 * - The workflow start path dispatches a run as a
 *   JobPipelineWorkflow instance (ids-only payload — the claim-
 *   check discipline): the definition is mirrored into the
 *   workflow residency through the control plane's own defineJob
 *   first, because a workflow has no host DO to read it from.
 *
 * Identity: a scheduled firing threads the platform's named
 * service login (SERVICE_USER_LOGIN, #1185) into the per-login
 * provider wiring when configured; with none configured, the
 * per-login providers (E*TRADE, Public) refuse by name on their
 * jobs while the env-credentialed sources (Yahoo, Alpaca) fire
 * unattended. A copilot/UX dispatch threads the acting user's
 * login the same way. No identity is ever fabricated.
 */
import type { AgentContext } from "agents";
import type { SqlStorage } from "../orm";
import type {
  ThinkScheduledTasks,
  ThinkScheduledTaskContext,
} from "../actors/thinkAdapter";
import type { Env } from "../types";
import {
  getServiceUserLogin,
  SHARED_ORCHESTRATOR_INSTANCE,
} from "../security/serviceIdentity";
import { createJobPipelineStoresFromSql } from "../data/createJobPipelinePorts";
import { createJobPipelineStoresFromD1 } from "../data/createJobPipelinePorts";
import { SqlJobRunRecordStore } from "../data/doSqliteJobRunRecordAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../data/d1JobRunRecordAdapter";
import { createProviderCaptureAdapter } from "../data/createProviderCapturePorts";
import type { CaptureBlobStorage } from "../data/providerCapturePorts";
import { createFeedDatasetAdapter } from "../data/createFeedDatasetPorts";
import { createEnrichedDatasetAdapter } from "../data/createEnrichedDatasetPorts";
import { createAnalyzedDatasetPorts } from "../data/createAnalyzedDatasetPorts";
import { createGeneratedDatasetPorts } from "../data/createGeneratedDatasetPorts";
import { D1IndexListStore } from "../data/d1IndexListAdapter";
import { createJobPipelineMessaging } from "../messaging/createJobPipelineMessaging";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobDispatchResult,
  type JobScheduleHost,
  type JobStatusView,
} from "../services/jobPipelineEngine";
import { buildFeedJobRegistry, buildFeedStatus } from "../services/feedJobs";
import {
  ensureFeedPipelineJobs,
  FEED_PIPELINE_CATALOG,
  type FeedStepDeps,
} from "../services/feedPipelineJobs";
import { buildEnrichJobRegistry } from "../services/enrichJobs";
import {
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
  ENRICH_PIPELINE_CATALOG,
  type EnrichStepDeps,
} from "../services/enrichPipelineJobs";
import { buildAnalyzeJobRegistry } from "../services/analyzeJobs";
import {
  ensureAnalyzePipelineJobs,
  ANALYZE_PIPELINE_CATALOG,
  type AnalyzeStepDeps,
} from "../services/analyzePipelineJobs";
import { buildGenerateJobRegistry } from "../services/generateJobs";
import {
  ensureGeneratePipelineJobs,
  GENERATE_PIPELINE_CATALOG,
  type GenerateStepDeps,
} from "../services/generatePipelineJobs";
import { buildDeliverJobRegistry, createDeliverChannelSenders } from "../services/deliverJobs";
import {
  ensureDeliverPipelineJobs,
  DELIVER_PIPELINE_CATALOG,
  type DeliverStepDeps,
} from "../services/deliverPipelineJobs";
import { createDeliveryDatasetPorts } from "../data/createDeliveryDatasetPorts";
import { actorGateway } from "../services/cloudflareActorGateway";
import { createFeedRunSettledObserver } from "../services/feedJobOutcomes";
import type { JobOutcomeInput } from "../data/jobOutcomePorts";
import {
  buildPipelineChainRegistry,
  chainStageNodePath,
  PIPELINE_CHAIN_CODES,
  PIPELINE_CHAIN_STAGE_ORDER,
  type PipelineChainStageKind,
} from "../services/pipelineChains";
import {
  buildChainSurfaceView,
  ensureChainPipelineJobs,
  refreshChainDefinitionFromStoredStages,
  CHAIN_PIPELINE_CATALOG,
  type PipelineChainSurfaceView,
} from "../services/chainPipelineJobs";
import { createCaptureWiredFeedProvider } from "../services/feedProviderWiring";
import { fetchWikipediaIndexHtml } from "../services/indexListJob";
import {
  createIndexMembershipService,
  createWikipediaIndexMembershipAdapter,
} from "../trading";
import type { JobInstanceRecord } from "../data/jobPipelinePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/scheduledTasksPipeline",
});

/** The Think task-id prefix for pipeline schedule declarations. */
export const PIPELINE_TASK_ID_PREFIX = "pipeline-job:";

/** Ports the pipeline declaration receives from the class. */
export interface ScheduledTasksPipelineContext {
  env: Env;
  agentCtx: AgentContext;
  /** Composition seam (tests): a prebuilt control plane. */
  control?: JobPipelineControl;
  /** Composition seam (tests): the workflow starter. */
  startWorkflow?: (
    jobId: string,
    opts: { trigger: "manual" | "scheduled"; scopePath?: string },
  ) => Promise<{ instanceId: string }>;
}

function pipelineSql(ctx: ScheduledTasksPipelineContext): SqlStorage {
  const sql = (
    ctx.agentCtx?.storage as unknown as { sql?: SqlStorage } | undefined
  )?.sql;
  if (!sql) {
    throw new Error(
      "job_pipeline_host_unavailable: the ScheduledAgent host has no DO SQLite storage to build the pipeline stores over.",
    );
  }
  return sql;
}

function envStrings(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** The feed-step wiring for this host residency (DO storage + D1 dataset/index stores). */
export function feedStepDepsForScheduledAgent(
  ctx: ScheduledTasksPipelineContext,
  userLogin?: string,
): FeedStepDeps {
  const sql = pipelineSql(ctx);
  const capturePort = createProviderCaptureAdapter(ctx.env);
  const universeStore = ctx.env.AGENT_DB
    ? new D1IndexListStore(
        ctx.env.AGENT_DB as ConstructorParameters<typeof D1IndexListStore>[0],
      )
    : null;
  return {
    registry: buildFeedJobRegistry(envStrings(ctx.env)),
    providerFor: (def) =>
      createCaptureWiredFeedProvider(def, {
        env: ctx.env,
        sql,
        blobStorage: ctx.agentCtx.storage as unknown as CaptureBlobStorage,
        capturePort,
        ...(userLogin ? { userLogin } : {}),
      }),
    universeStore,
    datasetStore: createFeedDatasetAdapter(ctx.env),
    indexRefresh: universeStore
      ? {
          store: universeStore,
          service: createIndexMembershipService({
            wikipedia: createWikipediaIndexMembershipAdapter(fetchWikipediaIndexHtml),
            holdings: {
              getMembers: async () => {
                throw new Error(
                  "holdings fetcher not bound — the Wikipedia refresh path never calls it",
                );
              },
            },
          }),
        }
      : null,
    shardsFor: async (jobId) => {
      const stores = createJobPipelineStoresFromSql(sql);
      return (
        (await stores.definitions.getDefinition(jobId))?.config.processing
          .shards ?? []
      );
    },
    ...(userLogin ? { userLogin } : {}),
  };
}

/**
 * The enrich-step wiring for this host residency (#3536): both
 * of the enrich step's stores are D1-resident (the feed
 * stage's persisted copies and this stage's enriched copies —
 * the analyze stage's readers run in other instances), so the
 * wiring needs no DO-storage seam and the step executes fully
 * in every residency, unlike feed.pull's capture wiring.
 */
export function enrichStepDepsForScheduledAgent(
  ctx: ScheduledTasksPipelineContext,
): EnrichStepDeps {
  const sql = pipelineSql(ctx);
  return {
    registry: buildEnrichJobRegistry(envStrings(ctx.env)),
    datasetStore: createFeedDatasetAdapter(ctx.env),
    enrichedStore: createEnrichedDatasetAdapter(ctx.env),
    shardsFor: async (jobId) => {
      const stores = createJobPipelineStoresFromSql(sql);
      return (
        (await stores.definitions.getDefinition(jobId))?.config.processing
          .shards ?? []
      );
    },
  };
}

/**
 * The analyze-step wiring for this host residency (#3537): both
 * of the analyze step's stores are D1-resident (the enrich
 * stage's persisted copies and this stage's analyzed copies —
 * the generate stage's readers run in other instances), so the
 * wiring needs no DO-storage seam and the step executes fully
 * in every residency, like enrich.apply.
 */
export function analyzeStepDepsForScheduledAgent(
  ctx: ScheduledTasksPipelineContext,
): AnalyzeStepDeps {
  const sql = pipelineSql(ctx);
  return {
    registry: buildAnalyzeJobRegistry(envStrings(ctx.env)),
    enrichedStore: createEnrichedDatasetAdapter(ctx.env),
    analyzedStore: createAnalyzedDatasetPorts(ctx.env),
    shardsFor: async (jobId) => {
      const stores = createJobPipelineStoresFromSql(sql);
      return (
        (await stores.definitions.getDefinition(jobId))?.config.processing
          .shards ?? []
      );
    },
  };
}

/**
 * The generate-step wiring for this host residency (#3538):
 * both of the generate step's dataset stores are D1-resident
 * (the analyze stage's persisted copies and this stage's
 * generated copies — the deliver stage's readers run in other
 * instances), so the wiring needs no DO-storage seam and the
 * step executes fully in every residency, like analyze.apply.
 *
 * The canonical report-store seam (mas_reports) is NOT wired
 * in this residency — deliberately, on evidence: the canonical
 * seam writes into a report-owning tenant's Orchestrator DO
 * (its reads all resolve there, per-login), while this host's
 * DO is the pipeline host's own storage and pipeline runs
 * carry no report-owning tenant (scheduled/chained runs act
 * under the service identity; a copilot dispatch's login owns
 * the dispatch, not a report in this DO). Writing canonical
 * rows here would strand them where no Reports view reads.
 * Each report's canonical leg is therefore recorded not_wired
 * with its coded reason on the generated artifact — named,
 * never silent (generateJobs.ts carries the full rule).
 */
export function generateStepDepsForScheduledAgent(
  ctx: ScheduledTasksPipelineContext,
): GenerateStepDeps {
  const sql = pipelineSql(ctx);
  return {
    registry: buildGenerateJobRegistry(envStrings(ctx.env)),
    analyzedStore: createAnalyzedDatasetPorts(ctx.env),
    generatedStore: createGeneratedDatasetPorts(ctx.env),
    canonicalReportStore: null,
    shardsFor: async (jobId) => {
      const stores = createJobPipelineStoresFromSql(sql);
      return (
        (await stores.definitions.getDefinition(jobId))?.config.processing
          .shards ?? []
      );
    },
  };
}

/**
 * The deliver-step wiring for this host residency (#3539):
 * both of the deliver step's dataset stores are D1-resident
 * (the generate stage's persisted copies and this stage's
 * delivery copies — the status surfaces' readers run in other
 * instances), so the wiring needs no DO-storage seam and the
 * step executes fully in every residency, like generate.apply.
 *
 * The channel senders are built from this host's env through
 * the deliver service's own factory (deliverJobs.ts): the
 * platform's transports behind their existing seams (Slack
 * via the unified screener sender, email via cfpay / the
 * EmailSender port, webhook via the signed outbound
 * dispatch). A transport this deployment does not configure
 * is absent from the senders and named in unconfiguredReasons
 * — each affected channel records not_configured per report,
 * never a fake delivery (the canonical seam's discipline,
 * applied to channels).
 */
export function deliverStepDepsForScheduledAgent(
  ctx: ScheduledTasksPipelineContext,
): DeliverStepDeps {
  const sql = pipelineSql(ctx);
  const { senders, unconfiguredReasons } = createDeliverChannelSenders(
    ctx.env as unknown as Record<string, unknown>,
  );
  return {
    registry: buildDeliverJobRegistry(envStrings(ctx.env)),
    generatedStore: createGeneratedDatasetPorts(ctx.env),
    deliveryStore: createDeliveryDatasetPorts(ctx.env),
    senders,
    unconfiguredReasons,
    shardsFor: async (jobId) => {
      const stores = createJobPipelineStoresFromSql(sql);
      return (
        (await stores.definitions.getDefinition(jobId))?.config.processing
          .shards ?? []
      );
    },
  };
}

/**
 * Build the pipeline control plane over this host. The acting
 * login (when a dispatch carries one) threads into the per-login
 * provider wiring; scheduled firings pass the service login.
 * The step registry is THE composed registry (#3536, #3537,
 * #3538, #3539): the feed steps plus enrich.apply plus
 * analyze.apply plus generate.apply plus deliver.apply — one
 * registry, every residency.
 */
/** The Orchestrator door the feed-outcome projection writes through (#3530 slice B). */
interface OrchestratorOutcomeDoor {
  recordFeedJobOutcome(input: JobOutcomeInput): Promise<void>;
}

/**
 * The settle observer for this host's control plane (#3530 slice B):
 * a settled feed run's outcome lands in the job-outcome sink the
 * Autopilot Control Center reads. Residency: the sink is
 * per-Orchestrator-instance and the reader is the owning instance's
 * Autopilot Control, so the write doors to the shared Orchestrator
 * instance — the same addressing the tick's corpus/reports riders
 * write through — never into this host's own store (which no
 * Autopilot surface reads). The settled run's counts and status
 * come from its own feed record, read back through the same
 * dataset adapter the surface views use and matched by run id.
 * Best-effort-but-honest: the observer never throws (its failures
 * are logged in services/feedJobOutcomes), so a missing binding or
 * an unreachable instance never fails a feed run.
 */
function feedRunSettledObserverFor(ctx: ScheduledTasksPipelineContext) {
  return createFeedRunSettledObserver({
    readFeedRun: async (jobId, runId) => {
      const datasetStore = createFeedDatasetAdapter(ctx.env);
      if (!datasetStore) return null;
      const def = buildFeedJobRegistry(envStrings(ctx.env)).get(jobId);
      if (!def) return null;
      const status = await buildFeedStatus(datasetStore, def, Date.now());
      return status.lastRun?.runId === runId ? status.lastRun : null;
    },
    record: async (input) => {
      const door = actorGateway.stub<OrchestratorOutcomeDoor>(
        ctx.env.ORCHESTRATOR_AGENT,
        SHARED_ORCHESTRATOR_INSTANCE,
      );
      await door.recordFeedJobOutcome(input);
    },
  });
}

export function createScheduledAgentPipelineControl(
  ctx: ScheduledTasksPipelineContext,
  userLogin?: string,
): JobPipelineControl {
  if (ctx.control) return ctx.control;
  const sql = pipelineSql(ctx);
  const stores = createJobPipelineStoresFromSql(sql);
  const messaging = createJobPipelineMessaging(ctx.env);
  return new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new SqlJobRunRecordStore(sql)),
    runSettledObserver: feedRunSettledObserverFor(ctx),
    publisher: messaging.ports?.publisher ?? null,
    steps: createPipelineStepRegistry(
      feedStepDepsForScheduledAgent(ctx, userLogin),
      enrichStepDepsForScheduledAgent(ctx),
      analyzeStepDepsForScheduledAgent(ctx),
      generateStepDepsForScheduledAgent(ctx),
      deliverStepDepsForScheduledAgent(ctx),
    ),
    invocation: "sync",
  });
}

/** Ensure the feed job definitions exist on this host's control plane. */
export async function ensureScheduledAgentFeedJobs(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
): Promise<string[]> {
  const stores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  return ensureFeedPipelineJobs(control, stores, envStrings(ctx.env));
}

/** Ensure the enrich job definitions exist on this host's control plane (#3536). */
export async function ensureScheduledAgentEnrichJobs(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
): Promise<string[]> {
  const stores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  return ensureEnrichPipelineJobs(control, stores, envStrings(ctx.env));
}

/** Ensure the analyze job definitions exist on this host's control plane (#3537). */
export async function ensureScheduledAgentAnalyzeJobs(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
): Promise<string[]> {
  const stores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  return ensureAnalyzePipelineJobs(control, stores, envStrings(ctx.env));
}

/** Ensure the generate job definitions exist on this host's control plane (#3538). */
export async function ensureScheduledAgentGenerateJobs(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
): Promise<string[]> {
  const stores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  return ensureGeneratePipelineJobs(control, stores, envStrings(ctx.env));
}

/** Ensure the deliver job definitions exist on this host's control plane (#3539). */
export async function ensureScheduledAgentDeliverJobs(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
): Promise<string[]> {
  const stores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  return ensureDeliverPipelineJobs(control, stores, envStrings(ctx.env));
}

/** Ensure the composed pipeline chain definitions exist on this host's control plane (#3540). */
export async function ensureScheduledAgentChainJobs(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
): Promise<string[]> {
  const stores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  return ensureChainPipelineJobs(control, stores, envStrings(ctx.env));
}

/**
 * Ensure EVERY pipeline job definition this host manages
 * (feed + enrich + analyze + generate + deliver + the composed
 * chains, #3540) — the ensure every host entry point runs, so
 * a job family's definitions exist whichever door arrives
 * first. Chains ensure LAST: their definitions derive from
 * the stage jobs' definitions.
 */
export async function ensureScheduledAgentPipelineJobs(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
): Promise<string[]> {
  const feed = await ensureScheduledAgentFeedJobs(ctx, control);
  const enrich = await ensureScheduledAgentEnrichJobs(ctx, control);
  const analyze = await ensureScheduledAgentAnalyzeJobs(ctx, control);
  const generate = await ensureScheduledAgentGenerateJobs(ctx, control);
  const deliver = await ensureScheduledAgentDeliverJobs(ctx, control);
  const chains = await ensureScheduledAgentChainJobs(ctx, control);
  return [...feed, ...enrich, ...analyze, ...generate, ...deliver, ...chains];
}

/**
 * Re-derive one chain's definition from the stage jobs'
 * definitions AS STORED on this host (a stage job reconfigured
 * through the control plane flows into its chain), refusing by
 * name for an unknown chain (#3540). Callers ensure first.
 */
export async function refreshScheduledAgentChainDefinition(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
  jobId: string,
): Promise<void> {
  const chain = buildPipelineChainRegistry(envStrings(ctx.env)).forId(jobId);
  if (!chain) {
    throw new Error(
      `${PIPELINE_CHAIN_CODES.chainNotFound}: no pipeline chain with id "${jobId}" exists in the chain catalog.`,
    );
  }
  const stores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  await refreshChainDefinitionFromStoredStages(control, stores, chain);
}

/**
 * One chain's end-to-end surface view on this host (#3540):
 * the chain definition is refreshed from the stored stage
 * definitions first, then the roll-up composes the chain job's
 * status view with every stage job's own status view — the
 * one query behind both surfaces' "where is the pipeline?".
 */
export async function buildScheduledAgentChainSurfaceView(
  ctx: ScheduledTasksPipelineContext,
  control: JobPipelineControl,
  jobId: string,
): Promise<PipelineChainSurfaceView> {
  const registry = buildPipelineChainRegistry(envStrings(ctx.env));
  const chain = registry.forId(jobId);
  const entry = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
  if (!chain || !entry) {
    throw new Error(
      `${PIPELINE_CHAIN_CODES.chainNotFound}: no pipeline chain with id "${jobId}" exists in the chain catalog.`,
    );
  }
  await refreshScheduledAgentChainDefinition(ctx, control, jobId);
  const stagePipelines: Record<string, JobStatusView> = {};
  for (const node of chain.nodes) {
    stagePipelines[node.jobId] = await control.getJob(node.jobId);
  }
  return buildChainSurfaceView({
    entry,
    chain,
    pipeline: await control.getJob(jobId),
    stagePipelines,
    nowMs: Date.now(),
  });
}

/**
 * The node path addressing one stage of one chain on this
 * host (#3540) — the address the uniform stage operations
 * consume. Unknown chains and unknown stage names refuse BY
 * NAME (the chain surface's coded refusals).
 */
export function pipelineChainStageNodePath(
  ctx: ScheduledTasksPipelineContext,
  jobId: string,
  stage: string,
): string {
  const chain = buildPipelineChainRegistry(envStrings(ctx.env)).forId(jobId);
  if (!chain) {
    throw new Error(
      `${PIPELINE_CHAIN_CODES.chainNotFound}: no pipeline chain with id "${jobId}" exists in the chain catalog.`,
    );
  }
  if (!(PIPELINE_CHAIN_STAGE_ORDER as readonly string[]).includes(stage)) {
    throw new Error(
      `${PIPELINE_CHAIN_CODES.stageUnknown}: pipeline chain "${jobId}" has no stage "${stage}" — its stages are ${PIPELINE_CHAIN_STAGE_ORDER.join(", ")}.`,
    );
  }
  return chainStageNodePath(chain, stage as PipelineChainStageKind);
}

/**
 * One scheduled firing: the same dispatch the doors make. The
 * firing is best-effort at the declaration boundary (a throw
 * would invite a scheduler retry double-fire); the run's own
 * record is the failure's durable surface.
 */
export async function dispatchScheduledPipelineJob(
  ctx: ScheduledTasksPipelineContext,
  jobId: string,
  scopePath: string,
): Promise<JobDispatchResult | null> {
  const serviceLogin = getServiceUserLogin(ctx.env) ?? undefined;
  const control = createScheduledAgentPipelineControl(ctx, serviceLogin);
  await ensureScheduledAgentPipelineJobs(ctx, control);
  const dispatch = await control.runJob(jobId, {
    trigger: "scheduled",
    ...(scopePath ? { scopePath } : {}),
  });
  // Async delivery is the feed jobs' default: the run proceeds on
  // the host's behalf; settle it in the background of the firing
  // so its records/events complete with the agent's lifetime.
  if (dispatch.completion) {
    void dispatch.completion.catch(() => undefined);
  }
  return dispatch;
}

/**
 * The workflow start path: dispatch a run as a JobPipelineWorkflow
 * instance. The payload is ids + trigger only (claim-check); the
 * job's definition is mirrored into the workflow (D1) residency
 * through defineJob first — configuration moves through the
 * control plane's own operation, never through the payload.
 * Refuses by name when the workflow binding is not configured.
 */
export async function startPipelineJobWorkflow(
  ctx: ScheduledTasksPipelineContext,
  jobId: string,
  opts: { trigger?: "manual" | "scheduled"; scopePath?: string } = {},
): Promise<{ instanceId: string }> {
  if (ctx.startWorkflow) {
    return ctx.startWorkflow(jobId, {
      trigger: opts.trigger ?? "manual",
      ...(opts.scopePath ? { scopePath: opts.scopePath } : {}),
    });
  }
  const workflow = ctx.env.JOB_PIPELINE_WORKFLOW;
  if (!workflow || typeof workflow.create !== "function") {
    throw new Error(
      "job_pipeline_workflow_not_configured: the JOB_PIPELINE_WORKFLOW binding is not configured in this deployment; the run was not dispatched.",
    );
  }
  if (!ctx.env.AGENT_DB) {
    throw new Error(
      "job_pipeline_workflow_not_configured: the AGENT_DB binding the workflow residency reads is not configured in this deployment.",
    );
  }
  // Mirror the definition into the workflow residency.
  const hostControl = createScheduledAgentPipelineControl(ctx);
  await ensureScheduledAgentPipelineJobs(ctx, hostControl);
  const hostStores = createJobPipelineStoresFromSql(pipelineSql(ctx));
  const definition = await hostStores.definitions.getDefinition(jobId);
  if (!definition) {
    throw new Error(
      `job_not_found: no pipeline job "${jobId}" is defined on the ScheduledAgent host; nothing was dispatched to the workflow.`,
    );
  }
  const d1Stores = createJobPipelineStoresFromD1(ctx.env.AGENT_DB);
  const d1Runs = new D1JobRunRecordStore(createD1JobRunRecordDb(ctx.env.AGENT_DB));
  const messaging = createJobPipelineMessaging(ctx.env);
  const workflowControl = new JobPipelineControl({
    stores: d1Stores,
    // The D1 run-record adapter is async; wrap it in the async
    // recorder seam directly (the workflow adapter's own shape).
    runRecorder: {
      recordRun: (record) => d1Runs.record(record),
      listRuns: (jobId, limit) => d1Runs.listByJob(jobId, limit),
      latestRun: (jobId) => d1Runs.latestByJob(jobId),
    },
    publisher: messaging.ports?.publisher ?? null,
    steps: createPipelineStepRegistry(
      feedStepDepsForScheduledAgent(ctx),
      enrichStepDepsForScheduledAgent(ctx),
      analyzeStepDepsForScheduledAgent(ctx),
      generateStepDepsForScheduledAgent(ctx),
      deliverStepDepsForScheduledAgent(ctx),
    ),
    invocation: "workflow-shard",
  });
  const existing = await d1Stores.definitions.getDefinition(jobId);
  if (
    !existing ||
    JSON.stringify(existing.rawConfig) !== JSON.stringify(definition.rawConfig)
  ) {
    await workflowControl.defineJob(definition.rawConfig);
  }
  const created = await workflow.create({
    params: {
      jobId,
      trigger: opts.trigger ?? "manual",
      ...(opts.scopePath ? { scopePath: opts.scopePath } : {}),
    },
  });
  return { instanceId: created.id };
}

/**
 * The getScheduledTasks() contribution for ScheduledAgent: one
 * declaration per registered (job, node) schedule, built from
 * the control plane's registerSchedules output. Re-declaring is
 * a no-op shape-wise (Think reconciles by task id + schedule).
 */
export async function declarePipelineTasks(
  ctx: ScheduledTasksPipelineContext,
): Promise<ThinkScheduledTasks> {
  // A host without DO SQLite has no pipeline stores and therefore
  // nothing to declare — the declaration reconciles on every
  // boot, so absence is a state, not a crash of the agent.
  const sql = (
    ctx.agentCtx?.storage as unknown as { sql?: SqlStorage } | undefined
  )?.sql;
  if (!sql) {
    structuredLog.warn("job_pipeline.schedule_declarations_skipped_no_storage", {
      message:
        "[job-pipeline] host has no DO SQLite storage; no pipeline schedule declarations were made.",
    });
    return {};
  }
  const control = createScheduledAgentPipelineControl(
    ctx,
    getServiceUserLogin(ctx.env) ?? undefined,
  );
  await ensureScheduledAgentPipelineJobs(ctx, control);
  const specs: Array<{
    jobId: string;
    nodePath: string;
    cron?: string;
    interval?: string;
  }> = [];
  const recordingHost: JobScheduleHost = {
    schedule: async (spec) => {
      specs.push(spec);
      return `think:${PIPELINE_TASK_ID_PREFIX}${spec.jobId}:${spec.nodePath || "root"}`;
    },
  };
  await control.registerSchedules(recordingHost);
  const tasks: ThinkScheduledTasks = {};
  for (const spec of specs) {
    const schedule = spec.cron ?? spec.interval;
    if (!schedule) continue;
    const taskId = `${PIPELINE_TASK_ID_PREFIX}${spec.jobId}${spec.nodePath ? `:${spec.nodePath}` : ""}`;
    // The Think task type is a union discriminated by schedule
    // literal form; the engine's schedule grammar produces
    // exactly those forms (cron expressions, `every …`
    // intervals) but carries them as plain strings, so the
    // narrowing happens on the whole task value here — Think
    // re-validates the schedule when it reconciles the task.
    tasks[taskId] = {
      schedule,
      handler: async (_taskCtx: ThinkScheduledTaskContext): Promise<void> => {
        await dispatchScheduledPipelineJob(ctx, spec.jobId, spec.nodePath).catch(
          () => {
            // Best-effort at the declaration boundary (see
            // dispatchScheduledPipelineJob): the run's records
            // are the failure surface; a throw here would only
            // invite a retry double-fire.
          },
        );
      },
    } as ThinkScheduledTasks[string];
  }
  return tasks;
}

/* ------------------------------------------------------------------ */
/* Queue-completion intake (the consumer's route into this host)       */
/* ------------------------------------------------------------------ */

export interface PipelineCompletionNote {
  jobId: string;
  runId: string;
  state: string;
  artifactKeys: string[];
  at: string;
}

const COMPLETIONS_KEY = "pipelineCompletions";
export const PIPELINE_COMPLETIONS_CAP = 100;

/**
 * Record one queue-routed completion on the host (the
 * JOB_PIPELINE_EVENTS consumer's first handler lands here):
 * the latest dataset references per job, capped, newest first —
 * the subscription surface downstream stages (J3 enrich) read
 * their upstream's persisted hand-off from.
 */
export async function recordPipelineCompletion(
  ctx: ScheduledTasksPipelineContext,
  note: PipelineCompletionNote,
): Promise<void> {
  const stored =
    (await ctx.agentCtx.storage.get<PipelineCompletionNote[]>(COMPLETIONS_KEY)) ??
    [];
  stored.unshift(note);
  await ctx.agentCtx.storage.put(
    COMPLETIONS_KEY,
    stored.slice(0, PIPELINE_COMPLETIONS_CAP),
  );
}

/** The recorded completions, newest first (optionally per job). */
export async function listPipelineCompletions(
  ctx: ScheduledTasksPipelineContext,
  jobId?: string,
): Promise<PipelineCompletionNote[]> {
  const stored =
    (await ctx.agentCtx.storage.get<PipelineCompletionNote[]>(COMPLETIONS_KEY)) ??
    [];
  return jobId ? stored.filter((n) => n.jobId === jobId) : stored;
}

/** The pipeline job ids this host manages (the catalog order). */
export function pipelineJobIds(): string[] {
  return FEED_PIPELINE_CATALOG.map((e) => e.jobId);
}

/** The enrich job ids this host manages (the catalog order, #3536). */
export function pipelineEnrichJobIds(): string[] {
  return ENRICH_PIPELINE_CATALOG.map((e) => e.jobId);
}

/** The analyze job ids this host manages (the catalog order, #3537). */
export function pipelineAnalyzeJobIds(): string[] {
  return ANALYZE_PIPELINE_CATALOG.map((e) => e.jobId);
}

/** The generate job ids this host manages (the catalog order, #3538). */
export function pipelineGenerateJobIds(): string[] {
  return GENERATE_PIPELINE_CATALOG.map((e) => e.jobId);
}

/** The deliver job ids this host manages (the catalog order, #3539). */
export function pipelineDeliverJobIds(): string[] {
  return DELIVER_PIPELINE_CATALOG.map((e) => e.jobId);
}

/** The composed pipeline chain ids this host manages (the catalog order, #3540). */
export function pipelineChainJobIds(): string[] {
  return CHAIN_PIPELINE_CATALOG.map((e) => e.jobId);
}

/**
 * The feed → enrich hand-off (#3536): the enrich stage is the
 * CONSUMER of the feed stage — when a feed job's completion is
 * recorded (its queue publication, routed here by the
 * JOB_PIPELINE_EVENTS consumer), the enrich job consuming that
 * feed job is dispatched on the same control plane, with the
 * service identity (a scheduled firing's identity). The enrich
 * job reads the feed run's PERSISTED dataset — the completion
 * note is the trigger, never the data channel.
 *
 * Best-effort at this boundary, like a scheduled firing: the
 * note is already recorded (the recording never depends on this
 * dispatch), a failure is logged with its code, and the enrich
 * run's own records are its failure surface. An enrich job's
 * own completion maps to no consumer (no cascade); a
 * non-completed feed state dispatches nothing.
 */
export async function dispatchEnrichAfterFeedCompletion(
  ctx: ScheduledTasksPipelineContext,
  note: PipelineCompletionNote,
): Promise<void> {
  if (note.state !== "completed") return;
  const enrichDef = buildEnrichJobRegistry(envStrings(ctx.env)).forFeedJob(
    note.jobId,
  );
  if (!enrichDef) return;
  try {
    const serviceLogin = getServiceUserLogin(ctx.env) ?? undefined;
    const control = createScheduledAgentPipelineControl(ctx, serviceLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const dispatch = await control.runJob(enrichDef.id, {
      trigger: "scheduled",
    });
    if (dispatch.completion) {
      void dispatch.completion.catch(() => undefined);
    }
  } catch (err) {
    structuredLog.warn("enrich_dispatch_after_feed_completion_failed", {
      message: `[job-pipeline] enrich dispatch after feed completion failed for "${enrichDef.id}" (feed job "${note.jobId}"): ${err instanceof Error ? err.message : String(err)}`,
      feedJobId: note.jobId,
      enrichJobId: enrichDef.id,
    });
  }
}

/**
 * The enrich → analyze hand-off (#3537): the analyze stage is
 * the CONSUMER of the enrich stage — when an enrich job's
 * completion is recorded (its queue publication, routed here
 * by the JOB_PIPELINE_EVENTS consumer alongside the feed
 * hand-off), the analyze job consuming that enrich job is
 * dispatched on the same control plane, with the service
 * identity. The analyze job reads the enrich run's PERSISTED
 * dataset — the completion note is the trigger, never the
 * data channel.
 *
 * Best-effort at this boundary, exactly like the feed hand-off:
 * the note is already recorded, a failure is logged with its
 * code, and the analyze run's own records are its failure
 * surface. An analyze job's own completion maps to the generate
 * hand-off below (dispatchGenerateAfterAnalyzeCompletion), and
 * a non-completed enrich state dispatches nothing.
 */
export async function dispatchAnalyzeAfterEnrichCompletion(
  ctx: ScheduledTasksPipelineContext,
  note: PipelineCompletionNote,
): Promise<void> {
  if (note.state !== "completed") return;
  const analyzeDef = buildAnalyzeJobRegistry(envStrings(ctx.env)).forEnrichJob(
    note.jobId,
  );
  if (!analyzeDef) return;
  try {
    const serviceLogin = getServiceUserLogin(ctx.env) ?? undefined;
    const control = createScheduledAgentPipelineControl(ctx, serviceLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const dispatch = await control.runJob(analyzeDef.id, {
      trigger: "scheduled",
    });
    if (dispatch.completion) {
      void dispatch.completion.catch(() => undefined);
    }
  } catch (err) {
    structuredLog.warn("analyze_dispatch_after_enrich_completion_failed", {
      message: `[job-pipeline] analyze dispatch after enrich completion failed for "${analyzeDef.id}" (enrich job "${note.jobId}"): ${err instanceof Error ? err.message : String(err)}`,
      enrichJobId: note.jobId,
      analyzeJobId: analyzeDef.id,
    });
  }
}

/**
 * The analyze → generate hand-off (#3538): the generate stage
 * is the CONSUMER of the analyze stage — when an analyze job's
 * completion is recorded (its queue publication, routed here
 * by the JOB_PIPELINE_EVENTS consumer alongside the earlier
 * hand-offs), the generate job consuming that analyze job is
 * dispatched on the same control plane, with the service
 * identity. The generate job reads the analyze run's PERSISTED
 * dataset — the completion note is the trigger, never the
 * data channel.
 *
 * Best-effort at this boundary, exactly like the earlier
 * hand-offs: the note is already recorded, a failure is logged
 * with its code, and the generate run's own records are its
 * failure surface. A generate job's own completion maps to
 * the deliver hand-off below (dispatchDeliverAfterGenerateCompletion),
 * and a non-completed analyze state dispatches nothing.
 */
export async function dispatchGenerateAfterAnalyzeCompletion(
  ctx: ScheduledTasksPipelineContext,
  note: PipelineCompletionNote,
): Promise<void> {
  if (note.state !== "completed") return;
  const generateDef = buildGenerateJobRegistry(envStrings(ctx.env)).forAnalyzeJob(
    note.jobId,
  );
  if (!generateDef) return;
  try {
    const serviceLogin = getServiceUserLogin(ctx.env) ?? undefined;
    const control = createScheduledAgentPipelineControl(ctx, serviceLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const dispatch = await control.runJob(generateDef.id, {
      trigger: "scheduled",
    });
    if (dispatch.completion) {
      void dispatch.completion.catch(() => undefined);
    }
  } catch (err) {
    structuredLog.warn("generate_dispatch_after_analyze_completion_failed", {
      message: `[job-pipeline] generate dispatch after analyze completion failed for "${generateDef.id}" (analyze job "${note.jobId}"): ${err instanceof Error ? err.message : String(err)}`,
      analyzeJobId: note.jobId,
      generateJobId: generateDef.id,
    });
  }
}

/**
 * The generate → deliver hand-off (#3539): the deliver stage
 * is the CONSUMER of the generate stage — when a generate
 * job's completion is recorded (its queue publication, routed
 * here by the JOB_PIPELINE_EVENTS consumer alongside the
 * earlier hand-offs), the deliver job consuming that generate
 * job is dispatched on the same control plane, with the
 * service identity. The deliver job reads the generate run's
 * PERSISTED dataset — the completion note is the trigger,
 * never the data channel.
 *
 * Best-effort at this boundary, exactly like the earlier
 * hand-offs: the note is already recorded, a failure is logged
 * with its code, and the deliver run's own records are its
 * failure surface. Deliver is the END OF THE CHAIN: a deliver
 * job's own completion maps to no consumer, and a
 * non-completed generate state dispatches nothing.
 */
export async function dispatchDeliverAfterGenerateCompletion(
  ctx: ScheduledTasksPipelineContext,
  note: PipelineCompletionNote,
): Promise<void> {
  if (note.state !== "completed") return;
  const deliverDef = buildDeliverJobRegistry(envStrings(ctx.env)).forGenerateJob(
    note.jobId,
  );
  if (!deliverDef) return;
  try {
    const serviceLogin = getServiceUserLogin(ctx.env) ?? undefined;
    const control = createScheduledAgentPipelineControl(ctx, serviceLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const dispatch = await control.runJob(deliverDef.id, {
      trigger: "scheduled",
    });
    if (dispatch.completion) {
      void dispatch.completion.catch(() => undefined);
    }
  } catch (err) {
    structuredLog.warn("deliver_dispatch_after_generate_completion_failed", {
      message: `[job-pipeline] deliver dispatch after generate completion failed for "${deliverDef.id}" (generate job "${note.jobId}"): ${err instanceof Error ? err.message : String(err)}`,
      generateJobId: note.jobId,
      deliverJobId: deliverDef.id,
    });
  }
}

export type { JobStatusView, JobInstanceRecord, PipelineChainSurfaceView };
