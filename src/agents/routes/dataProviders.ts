/**
 * Issue #1170 (E3 of epic #1116): data-provider provisioning
 * lifecycle routes, extracted-style sibling of routes/audit.ts and
 * routes/schedules.ts — invoked from OrchestratorAgent.routeRequest
 * in the sequential path.endsWith matching sequence (after the audit
 * handler). Returns a Response on match, null when no data-provider
 * path matches.
 *
 *   GET  /data-providers                              configs + routes + servability (+ per-provider capture health, E6 #1235; + feed-job status, #3530 S1)
 *   GET  /data-providers/:id                          one config + its routes
 *   GET  /data-providers/:id/feed                     feed-job status + the local-copy read (#3530 S1)
 *   POST /data-providers/:id/feed-run                 run the provider's feed job now (#3530 S1; dispatched through the pipeline host door since #3578)
 *   GET  /data-providers/:id/feed-jobs                the provider's feed jobs as pipeline jobs (#3535)
 *   POST /data-providers/:id/feed-jobs/:jobId/:action run|pause|resume|cancel|retry a feed job (#3535)
 *   POST /data-providers/:id/feed-jobs/:jobId/schedule configure a feed job's stored schedule (#3530)
 *   GET  /data-providers/:id/enrich-jobs              the provider's enrich jobs as pipeline jobs (#3536)
 *   POST /data-providers/:id/enrich-jobs/:jobId/:action run|pause|resume|cancel|retry an enrich job (#3536)
 *   GET  /data-providers/:id/analyze-jobs             the provider's analyze jobs as pipeline jobs (#3537)
 *   POST /data-providers/:id/analyze-jobs/:jobId/:action run|pause|resume|cancel|retry an analyze job (#3537)
 *   GET  /data-providers/:id/generate-jobs            the provider's generate jobs as pipeline jobs (#3538)
 *   POST /data-providers/:id/generate-jobs/:jobId/:action run|pause|resume|cancel|retry a generate job (#3538)
 *   GET  /data-providers/:id/deliver-jobs             the provider's deliver jobs as pipeline jobs (#3539)
 *   POST /data-providers/:id/deliver-jobs/:jobId/:action run|pause|resume|cancel|retry a deliver job (#3539)
 *   GET  /data-providers/:id/pipeline-chains          the provider's composed pipeline chains with their end-to-end roll-ups (#3540)
 *   POST /data-providers/:id/pipeline-chains/:jobId/:action run|pause|resume|cancel|retry a chain, or stage_pause|stage_resume|stage_cancel one of its stages (stage in the JSON body) (#3540)
 *   POST /data-providers/:id/register|configure|verify|enable|disable|deprovision
 *
 * (Paths are the DO-internal spellings: src/server.ts strips the
 * /api prefix when forwarding, so externally these are
 * /api/data-providers*.)
 *
 * SESSION GATE (#1156 mechanism): production traffic reaches this
 * DO only through src/server.ts's generic /api/ forwarder, which
 * runs requireAuth on EVERY /api/* request before forwarding and
 * sets the x-user-login header from the verified session — the
 * same gate #1156 applied to /api/schedule/*. Mutations here
 * additionally refuse to run without that verified login in the
 * route context (401, #1156's body), so a caller that somehow
 * reached the DO without a session can read nothing and change
 * nothing. The login doubles as the audit actor.
 *
 * SERVABILITY IS THE REGISTRY'S OWN RULE: the GET surface builds
 * the platform registry from the built-in adapters and reports,
 * per capability route, whether registry.resolveRoute resolves —
 * this module invents no second servability definition (epic
 * #1116: config enabled + flag on + adapter registered +
 * capability declared, enforced in registry.ts).
 *
 * VERIFY BINDING: ctx.buildVerifier supplies the real check per
 * provider. The orchestrator binds etrade (the vertical's
 * reference provider), public (#1247), and yahoo (#1317) through
 * buildDataProviderVerifier below — etrade's is the adapter's own
 * status (isConfigured defers to ETradeService.getStatus) plus the
 * P1 conformance kit over the live adapter; public's resolves the
 * record's configured credential reference to the user's stored
 * token, then runs the same kit; yahoo's is the market-data provider's own
 * isConfigured plus the same kit over the yahoo adapter. A provider
 * with no bound verifier gets an honest failure ("no adapter…"),
 * never a rubber stamp: provisioning is configuration, and a config
 * for an adapter-less id may exist but can never become
 * verified/enabled into servability.
 */

import type { SqlStorage } from "../../orm";
import type { Env } from "../../types";
import {
  AlpacaMarketDataProvider,
  YahooFinanceProvider,
} from "../../services/marketDataResearch";
import {
  createETradeDataProviderFromEnv,
  verifyETradeDataProvider,
  createPublicDataProviderFromEnv,
  verifyPublicDataProvider,
  verifyYahooDataProvider,
  verifyNasdaqDataProvider,
  verifyAlpacaDataProvider,
  createCaptureFetchOutcomeRecorder,
  createNasdaqDataProvider,
  createYahooDataProvider,
  createAlpacaDataProvider,
  DataProviderRegistry,
  DataProviderNotFoundError,
  aggregateProviderHealth,
  aggregateProviderHealthViaPort,
  listProviderConfigs,
  listCapabilityRoutes,
  getProviderConfig,
  getVerificationEvidence,
  transitionProvider,
  transitionProviderViaPort,
  ProviderLifecycleError,
  type DataProviderId,
  type ProviderConfigRecord,
  type ProviderConfigureInput,
  type ProviderLifecycleAction,
  type ProviderLifecycleAuditEvent,
  type ProviderVerifier,
  type FetchOutcomeRecorder,
} from "../../trading";
import type { ProviderConfigStore } from "../../data/providerConfigPorts";
import type { ProviderCaptureStore } from "../../data/providerCapturePorts";
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
} from "../../data/feedDatasetPorts";
import { createFeedDatasetAdapter } from "../../data/createFeedDatasetPorts";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  readFeedQuotes,
  FEED_JOB_CODES,
  type FeedJobRegistry,
  type FeedRunResult,
} from "../../services/feedJobs";
import {
  FEED_PIPELINE_CATALOG,
  type FeedJobSurfaceView,
} from "../../services/feedPipelineJobs";
import { ENRICH_JOB_CODES } from "../../services/enrichJobs";
import {
  ENRICH_PIPELINE_CATALOG,
  type EnrichJobSurfaceView,
} from "../../services/enrichPipelineJobs";
import { ANALYZE_JOB_CODES } from "../../services/analyzeJobs";
import {
  ANALYZE_PIPELINE_CATALOG,
  type AnalyzeJobSurfaceView,
} from "../../services/analyzePipelineJobs";
import { GENERATE_JOB_CODES } from "../../services/generateJobs";
import {
  GENERATE_PIPELINE_CATALOG,
  type GenerateJobSurfaceView,
} from "../../services/generatePipelineJobs";
import { DELIVER_JOB_CODES } from "../../services/deliverJobs";
import {
  DELIVER_PIPELINE_CATALOG,
  type DeliverJobSurfaceView,
} from "../../services/deliverPipelineJobs";
import { PIPELINE_CHAIN_CODES } from "../../services/pipelineChains";
import {
  CHAIN_PIPELINE_CATALOG,
  type PipelineChainSurfaceView,
} from "../../services/chainPipelineJobs";
import type { JobDefinition, JobInstanceRecord } from "../../data/jobPipelinePorts";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/dataProviders",
});

export interface DataProviderRoutesContext {
  env: Env;
  /** The host Durable Object's storage SQL (the platform stores live there). */
  sql: SqlStorage;
  /**
   * #2303 (#1976 step 1): the data-layer ports. When the host
   * supplies them (production wiring — built from env.AGENT_DB
   * by the composition roots in src/data), config reads/writes,
   * lifecycle transitions and capture health run on D1 through
   * the ports; when absent, the legacy DO-store path above is
   * used unchanged.
   */
  configPort?: ProviderConfigStore | null;
  capturePort?: ProviderCaptureStore | null;
  /**
   * The verified session login (server.ts sets x-user-login only
   * from a verified session; the orchestrator passes it through).
   * "" when absent — mutations are then refused by the gate.
   */
  userLogin: string;
  /** Single owner of audit-row inserts (issue #270), bound by the orchestrator. */
  recordAudit(
    type: string,
    agent: string,
    payload: Record<string, unknown>
  ): unknown;
  /**
   * The real verify check for a provider id; undefined = no adapter
   * wired. Optional: when the host binds none, the module default
   * (buildDataProviderVerifier — etrade, this slice's reference
   * provider) applies.
   */
  buildVerifier?(providerId: string): ProviderVerifier | undefined;
  /** #3530 S1 — feed-dataset store override (tests); undefined ⇒ built from the request env (AGENT_DB); explicit null ⇒ none. Since #3578 the store is this surface's READ side (status + the feed-run outcome read); execution wiring lives on the pipeline host. */
  feedDatasetStore?: FeedDatasetStore | null;
  /** #3535 — the pipeline host door override (tests); undefined ⇒ the ScheduledAgent stub from env; explicit null ⇒ no pipeline surface. */
  feedPipelineDoor?: FeedPipelineDoorLike | null;
}

/**
 * #3535 — the pipeline host's RPC surface as the routes consume
 * it (the ScheduledAgent's control-plane door, #3543). The
 * default construction resolves the stub from the env binding,
 * exactly as the mesh doors do.
 */
export interface FeedPipelineDoorLike {
  listFeedJobSurfaceStatuses(): Promise<FeedJobSurfaceView[]>;
  getFeedJobSurfaceStatus(jobId: string): Promise<FeedJobSurfaceView>;
  // #3536: the enrich jobs' surface reads on the same host door.
  listEnrichJobSurfaceStatuses(): Promise<EnrichJobSurfaceView[]>;
  getEnrichJobSurfaceStatus(jobId: string): Promise<EnrichJobSurfaceView>;
  // #3537: the analyze jobs' surface reads on the same host door.
  listAnalyzeJobSurfaceStatuses(): Promise<AnalyzeJobSurfaceView[]>;
  getAnalyzeJobSurfaceStatus(jobId: string): Promise<AnalyzeJobSurfaceView>;
  // #3538: the generate jobs' surface reads on the same host door.
  listGenerateJobSurfaceStatuses(): Promise<GenerateJobSurfaceView[]>;
  getGenerateJobSurfaceStatus(jobId: string): Promise<GenerateJobSurfaceView>;
  // #3539: the deliver jobs' surface reads on the same host door.
  listDeliverJobSurfaceStatuses(): Promise<DeliverJobSurfaceView[]>;
  getDeliverJobSurfaceStatus(jobId: string): Promise<DeliverJobSurfaceView>;
  // #3540: the composed chains' surface reads + dispatches +
  // per-stage operations on the same host door.
  listPipelineChainSurfaceStatuses(): Promise<PipelineChainSurfaceView[]>;
  getPipelineChainSurfaceStatus(jobId: string): Promise<PipelineChainSurfaceView>;
  runPipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  resumePipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  retryPipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  stopPipelineChainStage(jobId: string, stage: string): Promise<JobInstanceRecord>;
  resumePipelineChainStage(
    jobId: string,
    stage: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  cancelPipelineChainStage(jobId: string, stage: string): Promise<JobInstanceRecord>;
  runPipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  pausePipelineJob(jobId: string): Promise<JobInstanceRecord>;
  resumePipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  cancelPipelineJob(jobId: string): Promise<JobInstanceRecord>;
  retryPipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  // #3530 (scheduling-config): reconfigure one job through the
  // engine (the schedule write path; returns the stored definition).
  configurePipelineJob(jobId: string, patch: unknown): Promise<JobDefinition>;
}

const LIFECYCLE_ACTIONS: readonly ProviderLifecycleAction[] = [
  "register",
  "configure",
  "verify",
  "enable",
  "disable",
  "deprovision",
];

/** The platform registry over the built-in adapters (servability probes). */
function buildPlatformRegistry(ctx: DataProviderRoutesContext): DataProviderRegistry {
  const registry = new DataProviderRegistry();
  registry.register(createETradeDataProviderFromEnv(ctx.env, ctx.userLogin));
  // #1247: the Public adapter is registered AVAILABLE — servability
  // still gates on the config store's lifecycle state, so it serves
  // nothing until an operator configures → verifies → enables it.
  registry.register(createPublicDataProviderFromEnv(ctx.env, ctx.userLogin));
  registry.register(createYahooDataProvider(new YahooFinanceProvider(ctx.env), ctx.env));
  registry.register(createAlpacaDataProvider(new AlpacaMarketDataProvider(ctx.env), ctx.env));
  registry.register(createNasdaqDataProvider());
  return registry;
}

/**
 * The orchestrator's verifier binding: etrade (the #1116 vertical's
 * reference provider), since #1247 public, since #1317 yahoo, since
 * #1368 nasdaq, and since #1385 alpaca. The etrade check is the
 * adapter's own status first — a service that reports itself
 * unconfigured fails with that reason — then the P1 conformance
 * kit against the live adapter. The public check resolves the
 * provider record's configured credential REFERENCE (the caller
 * passes it through) to the user's stored token, then runs the
 * same kit. The yahoo and alpaca checks are the market-data providers'
 * own isConfigured plus the same kit over their adapters. Any
 * other provider id returns undefined (= no adapter wired for
 * verification), and the route substitutes the honest no-adapter
 * failure.
 *
 * E7 (issue #1248): when the caller passes the platform sql, the
 * probes run through a capture-store fetch-outcome recorder — a
 * failed verify leaves a fetch_failed row under the provider
 * (visible in its health block) instead of vanishing.
 */
export function buildDataProviderVerifier(
  env: Env,
  userLogin: string,
  providerId: string,
  credentialRef?: string | null,
  sql?: SqlStorage,
  outcomeRecorderOverride?: FetchOutcomeRecorder
): ProviderVerifier | undefined {
  const outcomeRecorder =
    outcomeRecorderOverride ??
    (sql ? createCaptureFetchOutcomeRecorder(sql) : undefined);
  if (providerId === "etrade") {
    return async () => verifyETradeDataProvider(env, userLogin, { outcomeRecorder });
  }
  if (providerId === "public") {
    return async () =>
      verifyPublicDataProvider(env, userLogin, credentialRef ?? null, {
        outcomeRecorder,
      });
  }
  if (providerId === "yahoo") {
    return async () => verifyYahooDataProvider(env, { outcomeRecorder });
  }
  if (providerId === "nasdaq") {
    return async () => verifyNasdaqDataProvider({ outcomeRecorder });
  }
  if (providerId === "alpaca") {
    return async () => verifyAlpacaDataProvider(env, { outcomeRecorder });
  }
  return undefined;
}

/** The verifier used when ctx binds none for a provider: an honest failure. */
function noAdapterVerifier(providerId: string): ProviderVerifier {
  return async () => ({
    ok: false,
    summary: `no adapter is registered for provider "${providerId}" in this build; a provider without an adapter cannot be verified.`,
  });
}

function routeServability(
  registry: DataProviderRegistry,
  configs: ProviderConfigRecord[],
  routes: ReturnType<typeof listCapabilityRoutes>
) {
  return routes.map((route) => {
    try {
      const assignment = registry.resolveRoute(route.capability, configs, routes);
      return {
        capability: route.capability,
        primaryProviderId: route.primaryProviderId,
        gapFillProviderId: route.gapFillProviderId,
        minTier: route.minTier,
        resolves: true,
        resolvedPrimaryId: assignment.primary.id,
        resolvedGapFillId: assignment.gapFill?.id ?? null,
      };
    } catch (err) {
      return {
        capability: route.capability,
        primaryProviderId: route.primaryProviderId,
        gapFillProviderId: route.gapFillProviderId,
        minTier: route.minTier,
        resolves: false,
        resolvedPrimaryId: null,
        resolvedGapFillId: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

async function providerView(
  registry: DataProviderRegistry,
  record: ProviderConfigRecord,
  routeViews: ReturnType<typeof routeServability>,
  sql: SqlStorage,
  capturePort?: ProviderCaptureStore | null,
  feed?: unknown,
  feedJobs?: unknown,
  enrichJobs?: unknown,
  analyzeJobs?: unknown,
  generateJobs?: unknown,
  deliverJobs?: unknown,
  pipelineChains?: unknown
) {
  const adapter = registry.get(record.id);
  const serving = routeViews.some(
    (r) =>
      r.resolves &&
      (r.resolvedPrimaryId === record.id || r.resolvedGapFillId === record.id)
  );
  return {
    id: record.id,
    adapterKind: record.adapterKind,
    lifecycleState: record.lifecycleState,
    enabled: record.enabled,
    precedence: record.precedence,
    credentialRef: record.credentialRef,
    config: record.config,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    declaredCapabilities: adapter ? [...adapter.capabilities] : [],
    verification: getVerificationEvidence(record),
    serving,
    // E6 (#1235): health + usage metering derived from this
    // provider's stored capture records (providerHealth.ts). The
    // capture reads are tenant-scoped; captures are attributed to
    // the platform's default tenant scope ("default" —
    // captureStore's resolveRunContext), which is the scope this
    // DO's platform paths write under. A provider with no captures
    // reports status "no-data" with zeroed aggregates — never an
    // invented green.
    // #2303: when the host wires the capture port, the same
    // derivation runs over the D1 capture log through the port.
    health: capturePort
      ? await aggregateProviderHealthViaPort(capturePort, CAPTURE_TENANT_ID, record.id)
      : aggregateProviderHealth(sql, CAPTURE_TENANT_ID, record.id),
    // #3530 (S1): feed-job status for this provider's dataset —
    // the job's last run outcome, rows persisted, snapshot age,
    // and the never-run state before the first run. Null when no
    // feed job is registered for the provider.
    feed: feed ?? null,
    // #3535: every feed job for this provider as a pipeline job —
    // the merged surface views (dataset copy + pipeline state +
    // next scheduled run) the panel renders. Empty when the
    // provider has no feed jobs or the pipeline host is unbound.
    feedJobs: feedJobs ?? [],
    // #3536: every enrich job for this provider as a pipeline
    // job — the merged surface views (enriched copy + pipeline
    // state + lineage + next scheduled run). Same rule as
    // feedJobs: empty when none or the host is unbound.
    enrichJobs: enrichJobs ?? [],
    // #3537: every analyze job for this provider as a pipeline
    // job — the merged surface views (analyzed copy + pipeline
    // state + lineage + next scheduled run). Same rule.
    analyzeJobs: analyzeJobs ?? [],
    // #3538: every generate job for this provider as a pipeline
    // job — the merged surface views (generated copy + pipeline
    // state + lineage + next scheduled run). Same rule.
    generateJobs: generateJobs ?? [],
    // #3539: every deliver job for this provider as a pipeline
    // job — the merged surface views (delivery copy + pipeline
    // state + lineage + next scheduled run). Same rule.
    deliverJobs: deliverJobs ?? [],
    // #3540: every composed pipeline chain for this provider —
    // the end-to-end roll-ups (per-stage states + frontier +
    // chain run state + next scheduled run). Same rule.
    pipelineChains: pipelineChains ?? [],
  };
}

/**
 * The tenant scope capture reads use on this surface: the
 * platform's established default (captureStore.resolveRunContext
 * attributes every run without an explicit tenant to "default").
 */
const CAPTURE_TENANT_ID = "default";

/* ------------------------------------------------------------------ */
/* #3530 S1 — feed jobs: registry/wiring resolution + status view      */
/* ------------------------------------------------------------------ */

function feedRegistryFor(ctx: DataProviderRoutesContext): FeedJobRegistry {
  const knobs: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(
    ctx.env as unknown as Record<string, unknown>,
  )) {
    if (typeof value === "string") knobs[key] = value;
  }
  return buildFeedJobRegistry(knobs);
}

function feedDatasetStoreFor(
  ctx: DataProviderRoutesContext,
): FeedDatasetStore | null {
  if (ctx.feedDatasetStore !== undefined) return ctx.feedDatasetStore;
  return createFeedDatasetAdapter(ctx.env);
}

/**
 * The provider's feed block for the list/detail views: null when
 * no job is registered for the provider; a "not-configured"
 * state when no dataset store is wired; otherwise the live
 * status view (last run, rows persisted, snapshot age, the
 * never-run state before the first run).
 */
async function feedViewFor(
  ctx: DataProviderRoutesContext,
  providerId: DataProviderId,
): Promise<unknown> {
  const def = feedRegistryFor(ctx).forSource(providerId);
  if (!def) return null;
  const store = feedDatasetStoreFor(ctx);
  if (!store) {
    return {
      jobId: def.id,
      sourceId: def.sourceId,
      dataset: def.dataset,
      elements: [...def.elements],
      universeLabel: def.universe.label,
      cadenceMinutes: def.cadenceMinutes,
      staleAfterMinutes: def.staleAfterMinutes,
      state: "not-configured",
      lastRun: null,
      snapshot: null,
    };
  }
  return buildFeedStatus(store, def, Date.now());
}

/* ------------------------------------------------------------------ */
/* #3535 — the pipeline host door + the per-provider feed-jobs view    */
/* ------------------------------------------------------------------ */

function feedPipelineDoorFor(
  ctx: DataProviderRoutesContext,
): FeedPipelineDoorLike | null {
  if (ctx.feedPipelineDoor !== undefined) return ctx.feedPipelineDoor;
  const ns = ctx.env.SCHEDULED_AGENT;
  if (!ns) return null;
  return ns.get(ns.idFromName("default")) as unknown as FeedPipelineDoorLike;
}

/* ------------------------------------------------------------------ */
/* #3578 — the feed-run route's convergence onto the door above:      */
/* the outcome read + the refusal mapping onto S1's shapes            */
/* ------------------------------------------------------------------ */

/**
 * The stable code a door-side failure carries, read off either
 * the error's own `code` property (JobPipelineError / FeedJobError
 * in-process) or the leading "CODE:" prefix of its message (the
 * plain coded Errors the host door throws, and the only part an
 * RPC-crossed error guarantees). Null when the failure is uncoded.
 */
function codedErrorOf(error: unknown): string | null {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^([A-Za-z][A-Za-z0-9_]*):/);
  return match ? match[1] : null;
}

/**
 * The refusal code a SETTLED outcome's error carries. The stage
 * runner wraps a step's thrown error ("Step "feed.pull" of node
 * "root" (kind "feed") failed: <the step's coded error>"), so the
 * code is the first of this route's mapped codes appearing in the
 * message — not a prefix. Only the codes feedRunRefusalResponse
 * maps specially are extracted; anything else stays uncoded and
 * lands in the 409 shape.
 */
function outcomeRefusalCode(error: string | undefined): string | null {
  if (!error) return null;
  for (const code of ["FEED_JOB_NOT_CONFIGURED", FEED_JOB_CODES.jobNotFound]) {
    if (new RegExp(`\\b${code}\\b`).test(error)) return code;
  }
  return null;
}

/**
 * Map a door-side refusal onto the feed-run route's existing
 * refusal shapes (the S1 contract — no new shape, no new code for
 * an old condition): not-configured ⇒ the 500 FEED_JOB_NOT_CONFIGURED
 * refusal; job-not-found ⇒ the 404 FEED_JOB_NOT_FOUND; anything
 * else ⇒ the 409 FEED_JOB_ACTION_REFUSED the sibling feed-job
 * action route already answers control-plane refusals with.
 */
function feedRunRefusalResponse(code: string | null, message: string): Response {
  if (code === "FEED_JOB_NOT_CONFIGURED") {
    return Response.json(
      { error: message, code: "FEED_JOB_NOT_CONFIGURED" },
      { status: 500 },
    );
  }
  if (code === FEED_JOB_CODES.jobNotFound || code === "job_not_found") {
    return Response.json(
      { error: message, code: FEED_JOB_CODES.jobNotFound },
      { status: 404 },
    );
  }
  return Response.json(
    { error: message, code: "FEED_JOB_ACTION_REFUSED" },
    { status: 409 },
  );
}

/**
 * Rebuild the S1 run view (FeedRunResult) from the dataset
 * artifacts ONE pipeline run stored (newest first). The feed
 * step runs the #3530 service under the pipeline run id, so the
 * run's artifacts ARE its records — the route performs one read
 * of them after the door settles, never a second fetch. The
 * run's recorded outcome is its NEWEST artifact: a step retry
 * re-runs the pull under the same run id and stores a fresh
 * artifact, so earlier artifacts under the id are superseded
 * attempts, and the newest is the attempt the run settled on —
 * the same record buildFeedStatus renders as the job's lastRun.
 * Null when the run stored nothing — it settled before the pull
 * recorded an outcome, and the caller maps its coded refusal
 * instead.
 */
function feedRunViewFromArtifacts(
  runId: string,
  artifacts: FeedDatasetArtifact[],
): FeedRunResult | null {
  const newest = artifacts[0];
  if (!newest) return null;
  const run = newest.run;
  return {
    jobId: newest.jobId,
    runId,
    status: run.status,
    artifactId: newest.id,
    requested: run.requested,
    received: run.received,
    failed: run.failed,
    missingSymbols: [...run.missingSymbols],
    codedError: run.codedError,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/**
 * Every feed job for one provider, as merged surface views from
 * the pipeline host. The door is best-effort for READS: an
 * unreachable host yields an empty list (the S1 `feed` block
 * still reports the dataset state) — never a fabricated status.
 */
async function feedJobsViewFor(
  ctx: DataProviderRoutesContext,
  providerId: DataProviderId,
): Promise<FeedJobSurfaceView[]> {
  const door = feedPipelineDoorFor(ctx);
  if (!door) return [];
  try {
    const all = await door.listFeedJobSurfaceStatuses();
    return all.filter((v) => v.sourceId === providerId);
  } catch (error) {
    structuredLog.warn("data_providers.feed_jobs_status_read_failed", {
      message: `[data-providers] feed-jobs status read for "${providerId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Every enrich job for one provider, as merged surface views
 * from the pipeline host (#3536). Same best-effort read rule as
 * feedJobsViewFor: an unreachable host yields an empty list —
 * never a fabricated status.
 */
async function enrichJobsViewFor(
  ctx: DataProviderRoutesContext,
  providerId: DataProviderId,
): Promise<EnrichJobSurfaceView[]> {
  const door = feedPipelineDoorFor(ctx);
  if (!door) return [];
  try {
    const all = await door.listEnrichJobSurfaceStatuses();
    return all.filter((v) => v.sourceId === providerId);
  } catch (error) {
    structuredLog.warn("data_providers.enrich_jobs_status_read_failed", {
      message: `[data-providers] enrich-jobs status read for "${providerId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Every analyze job for one provider, as merged surface views
 * from the pipeline host (#3537). Same best-effort read rule as
 * enrichJobsViewFor: an unreachable host yields an empty list —
 * never a fabricated status.
 */
async function analyzeJobsViewFor(
  ctx: DataProviderRoutesContext,
  providerId: DataProviderId,
): Promise<AnalyzeJobSurfaceView[]> {
  const door = feedPipelineDoorFor(ctx);
  if (!door) return [];
  try {
    const all = await door.listAnalyzeJobSurfaceStatuses();
    return all.filter((v) => v.sourceId === providerId);
  } catch (error) {
    structuredLog.warn("data_providers.analyze_jobs_status_read_failed", {
      message: `[data-providers] analyze-jobs status read for "${providerId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Every generate job for one provider, as merged surface views
 * from the pipeline host (#3538). Same best-effort read rule as
 * analyzeJobsViewFor: an unreachable host yields an empty list —
 * never a fabricated status.
 */
async function generateJobsViewFor(
  ctx: DataProviderRoutesContext,
  providerId: DataProviderId,
): Promise<GenerateJobSurfaceView[]> {
  const door = feedPipelineDoorFor(ctx);
  if (!door) return [];
  try {
    const all = await door.listGenerateJobSurfaceStatuses();
    return all.filter((v) => v.sourceId === providerId);
  } catch (error) {
    structuredLog.warn("data_providers.generate_jobs_status_read_failed", {
      message: `[data-providers] generate-jobs status read for "${providerId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Every deliver job for one provider, as merged surface views
 * from the pipeline host (#3539). Same best-effort read rule as
 * generateJobsViewFor: an unreachable host yields an empty
 * list — never a fabricated status.
 */
async function deliverJobsViewFor(
  ctx: DataProviderRoutesContext,
  providerId: DataProviderId,
): Promise<DeliverJobSurfaceView[]> {
  const door = feedPipelineDoorFor(ctx);
  if (!door) return [];
  try {
    const all = await door.listDeliverJobSurfaceStatuses();
    return all.filter((v) => v.sourceId === providerId);
  } catch (error) {
    structuredLog.warn("data_providers.deliver_jobs_status_read_failed", {
      message: `[data-providers] deliver-jobs status read for "${providerId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Every composed pipeline chain for one provider, as end-to-end
 * roll-up views from the pipeline host (#3540). Same best-effort
 * read rule as deliverJobsViewFor: an unreachable host yields
 * an empty list — never a fabricated status.
 */
async function pipelineChainsViewFor(
  ctx: DataProviderRoutesContext,
  providerId: DataProviderId,
): Promise<PipelineChainSurfaceView[]> {
  const door = feedPipelineDoorFor(ctx);
  if (!door) return [];
  try {
    const all = await door.listPipelineChainSurfaceStatuses();
    return all.filter((v) => v.sourceId === providerId);
  } catch (error) {
    structuredLog.warn("data_providers.pipeline_chains_status_read_failed", {
      message: `[data-providers] pipeline-chains status read for "${providerId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function handleDataProviderRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: DataProviderRoutesContext
): Promise<Response | null> {
  void sessionId;
  const isList = path === "/data-providers" || path === "/data-providers/";
  const oneMatch = path.match(/^\/data-providers\/([^/]+)$/);
  const actionMatch = path.match(/^\/data-providers\/([^/]+)\/([a-z]+)$/);
  // #3530 S1: the feed-run action carries a hyphen, so it needs
  // its own match (the lifecycle action regex is [a-z]+ only).
  const feedRunMatch = path.match(/^\/data-providers\/([^/]+)\/feed-run$/);
  // #3535: the pipeline feed-jobs surface (list + per-job actions).
  const feedJobsMatch = path.match(/^\/data-providers\/([^/]+)\/feed-jobs$/);
  const feedJobActionMatch = path.match(
    /^\/data-providers\/([^/]+)\/feed-jobs\/([^/]+)\/([a-z]+)$/,
  );
  // #3530 (scheduling-config): the schedule route — its own match,
  // handled BEFORE the generic action match ("schedule" would
  // otherwise parse as an action name).
  const feedJobScheduleMatch = path.match(
    /^\/data-providers\/([^/]+)\/feed-jobs\/([^/]+)\/schedule$/,
  );
  // #3536: the pipeline enrich-jobs surface (list + per-job actions).
  const enrichJobsMatch = path.match(/^\/data-providers\/([^/]+)\/enrich-jobs$/);
  const enrichJobActionMatch = path.match(
    /^\/data-providers\/([^/]+)\/enrich-jobs\/([^/]+)\/([a-z]+)$/,
  );
  // #3537: the pipeline analyze-jobs surface (list + per-job actions).
  const analyzeJobsMatch = path.match(/^\/data-providers\/([^/]+)\/analyze-jobs$/);
  const analyzeJobActionMatch = path.match(
    /^\/data-providers\/([^/]+)\/analyze-jobs\/([^/]+)\/([a-z]+)$/,
  );
  // #3538: the pipeline generate-jobs surface (list + per-job actions).
  const generateJobsMatch = path.match(/^\/data-providers\/([^/]+)\/generate-jobs$/);
  const generateJobActionMatch = path.match(
    /^\/data-providers\/([^/]+)\/generate-jobs\/([^/]+)\/([a-z]+)$/,
  );
  // #3539: the pipeline deliver-jobs surface (list + per-job actions).
  const deliverJobsMatch = path.match(/^\/data-providers\/([^/]+)\/deliver-jobs$/);
  const deliverJobActionMatch = path.match(
    /^\/data-providers\/([^/]+)\/deliver-jobs\/([^/]+)\/([a-z]+)$/,
  );
  // #3540: the composed pipeline-chains surface (list + per-chain
  // actions; the stage actions carry an underscore, hence [a-z_]+).
  const pipelineChainsMatch = path.match(/^\/data-providers\/([^/]+)\/pipeline-chains$/);
  const pipelineChainActionMatch = path.match(
    /^\/data-providers\/([^/]+)\/pipeline-chains\/([^/]+)\/([a-z_]+)$/,
  );
  if (!isList && !oneMatch && !actionMatch && !feedRunMatch && !feedJobsMatch && !feedJobActionMatch && !enrichJobsMatch && !enrichJobActionMatch && !analyzeJobsMatch && !analyzeJobActionMatch && !generateJobsMatch && !generateJobActionMatch && !deliverJobsMatch && !deliverJobActionMatch && !pipelineChainsMatch && !pipelineChainActionMatch) return null;

  try {
    // ---- reads ----
    // #2303: when the host wires the config port, reads run on
    // D1 through it; otherwise the legacy DO-store reads run.
    const readConfigs = async (): Promise<ProviderConfigRecord[]> =>
      ctx.configPort
        ? ctx.configPort.listProviderConfigs()
        : listProviderConfigs(ctx.sql);
    const readRoutes = async () =>
      ctx.configPort
        ? ctx.configPort.listCapabilityRoutes()
        : listCapabilityRoutes(ctx.sql);
    const readConfig = async (id: DataProviderId) =>
      ctx.configPort
        ? ctx.configPort.getProviderConfig(id)
        : getProviderConfig(ctx.sql, id);
    if (request.method === "GET" && isList) {
      const configs = await readConfigs();
      const routes = await readRoutes();
      const registry = buildPlatformRegistry(ctx);
      const routeViews = routeServability(registry, configs, routes);
      return Response.json({
        providers: await Promise.all(
          configs.map(async (c) =>
            providerView(
              registry,
              c,
              routeViews,
              ctx.sql,
              ctx.capturePort,
              await feedViewFor(ctx, c.id),
              await feedJobsViewFor(ctx, c.id),
              await enrichJobsViewFor(ctx, c.id),
              await analyzeJobsViewFor(ctx, c.id),
              await generateJobsViewFor(ctx, c.id),
              await deliverJobsViewFor(ctx, c.id),
              await pipelineChainsViewFor(ctx, c.id),
            )
          )
        ),
        routes: routeViews,
      });
    }
    if (request.method === "GET" && oneMatch) {
      const id = decodeURIComponent(oneMatch[1]);
      const record = await readConfig(id as DataProviderId);
      if (!record) {
        return Response.json({ error: `Unknown data provider "${id}".` }, { status: 404 });
      }
      const configs = await readConfigs();
      const routes = await readRoutes();
      const registry = buildPlatformRegistry(ctx);
      const routeViews = routeServability(registry, configs, routes);
      return Response.json({
        provider: await providerView(
          registry,
          record,
          routeViews,
          ctx.sql,
          ctx.capturePort,
          await feedViewFor(ctx, record.id),
          await feedJobsViewFor(ctx, record.id),
          await enrichJobsViewFor(ctx, record.id),
          await analyzeJobsViewFor(ctx, record.id),
          await generateJobsViewFor(ctx, record.id),
          await deliverJobsViewFor(ctx, record.id),
          await pipelineChainsViewFor(ctx, record.id),
        ),
        routes: routeViews.filter(
          (r) => r.primaryProviderId === id || r.gapFillProviderId === id
        ),
      });
    }

    // #3530 S1 — the local-copy read: the persisted dataset, with
    // age + provenance. Served ONLY from the store; a read never
    // fetches (the read path has no provider in its inputs).
    if (request.method === "GET" && actionMatch && actionMatch[2] === "feed") {
      const id = decodeURIComponent(actionMatch[1]) as DataProviderId;
      const def = feedRegistryFor(ctx).forSource(id);
      if (!def) {
        return Response.json(
          {
            error: `No feed job is registered for provider "${id}".`,
            code: FEED_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      const feed = await feedViewFor(ctx, id);
      const store = feedDatasetStoreFor(ctx);
      const symbolsParam = url.searchParams.get("symbols");
      let quotes: unknown = null;
      if (store && symbolsParam !== null) {
        const maxAgeRaw = url.searchParams.get("maxAgeSeconds");
        const maxAgeSeconds =
          maxAgeRaw !== null && Number.isFinite(Number(maxAgeRaw))
            ? Number(maxAgeRaw)
            : undefined;
        quotes = await readFeedQuotes(store, {
          sourceId: def.sourceId,
          dataset: def.dataset,
          symbols: symbolsParam
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}),
          nowMs: Date.now(),
        });
      }
      return Response.json({ feed, quotes });
    }

    // #3530 S1 — run the provider's feed job now. #3578: the run
    // is dispatched through the pipeline host door (the same
    // control-plane dispatch the feed-job action route below and
    // the copilot tools make), NOT run directly from this
    // residency — a run started here is a pipeline run (pipeline
    // run id end to end, stage addressing, checkpoint, uniform
    // stage control, the standard completion → enrich chaining).
    // The door settles the run; the response's run view is then
    // rebuilt from the run's own dataset artifact(s) and the
    // feed block from the same store read as before, so the S1
    // response contract ({ run, feed }) is unchanged. A mutation:
    // same session gate as the lifecycle actions below.
    if (request.method === "POST" && feedRunMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to run a feed job." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(feedRunMatch[1]) as DataProviderId;
      const registry = feedRegistryFor(ctx);
      const def = registry.forSource(id);
      if (!def) {
        return Response.json(
          {
            error: `No feed job is registered for provider "${id}".`,
            code: FEED_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the run was refused rather than dispatched through an unwired path.",
            code: "FEED_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      const store = feedDatasetStoreFor(ctx);
      if (!store) {
        return Response.json(
          {
            error:
              "Feed-job wiring is incomplete on this host (the dataset store the run's outcome is read from is missing); the run was refused rather than dispatching a run this surface cannot report.",
            code: "FEED_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      let outcome: { jobId: string; runId: string; state: string; error?: string };
      try {
        outcome = await door.runPipelineJob(def.id, {
          userLogin: ctx.userLogin,
        });
      } catch (error) {
        // The control plane refuses by name (already running, not
        // defined on the host, an unsupported execution mode) —
        // mapped onto this route's refusal shapes, never a
        // success shape.
        return feedRunRefusalResponse(
          codedErrorOf(error),
          error instanceof Error ? error.message : String(error),
        );
      }
      const artifacts = (await store.listRuns(def.sourceId, def.dataset, 50))
        .filter((artifact) => artifact.run.runId === outcome.runId);
      const run = feedRunViewFromArtifacts(outcome.runId, artifacts);
      if (!run) {
        // The run settled without the feed service recording an
        // artifact — it failed (or was stopped) before the pull
        // recorded an outcome. Map its coded refusal onto this
        // route's shapes.
        return feedRunRefusalResponse(
          outcomeRefusalCode(outcome.error),
          outcome.error ??
            `Pipeline run ${outcome.runId} for feed job "${def.id}" settled as "${outcome.state}" before the feed pull recorded an outcome.`,
        );
      }
      ctx.recordAudit("data_provider.feed_run", "orchestrator", {
        actor: ctx.userLogin,
        providerId: id,
        jobId: def.id,
        runId: run.runId,
        status: run.status,
        requested: run.requested,
        received: run.received,
        failed: run.failed,
        codedError: run.codedError,
      });
      return Response.json({ run, feed: await buildFeedStatus(store, def, Date.now()) });
    }

    // #3535 — the provider's feed jobs as pipeline surface views
    // (the same merged views the copilot tools return).
    if (request.method === "GET" && feedJobsMatch) {
      const id = decodeURIComponent(feedJobsMatch[1]) as DataProviderId;
      return Response.json({ jobs: await feedJobsViewFor(ctx, id) });
    }

    // #3530 (scheduling-config) — configure one feed job's stored
    // schedule through the pipeline host's control plane. A
    // mutation under the SAME session discipline as the action
    // route below (verified login or 401; catalog + provider match
    // or 404; audited). The request body is the operator's shape —
    // { enabled?, intervalMinutes?, cron? } — validated typed here
    // (400 FEED_JOB_SCHEDULE_INVALID, before any door call) and
    // mapped onto the engine's native JobScheduleConfig; the patch
    // MERGES over the stored schedule the surface view reports, so
    // a disable never loses the cadence and a cadence change never
    // flips the enablement. The engine's resolution remains the
    // second gate; its refusals map through feedRunRefusalResponse.
    if (request.method === "POST" && feedJobScheduleMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to manage a feed job." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(feedJobScheduleMatch[1]) as DataProviderId;
      const jobId = decodeURIComponent(feedJobScheduleMatch[2]);
      const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
      if (!entry || entry.sourceId !== id) {
        return Response.json(
          {
            error: `No feed job "${jobId}" is registered for provider "${id}".`,
            code: FEED_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      const invalid = (message: string): Response =>
        Response.json({ error: message, code: "FEED_JOB_SCHEDULE_INVALID" }, { status: 400 });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return invalid("The schedule patch must be a JSON object.");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return invalid("The schedule patch must be a JSON object.");
      }
      const patch = body as Record<string, unknown>;
      const keys = Object.keys(patch);
      if (keys.length === 0) {
        return invalid("The schedule patch is empty — name enabled, intervalMinutes, or cron.");
      }
      for (const key of keys) {
        if (!["enabled", "intervalMinutes", "cron"].includes(key)) {
          return invalid(`Unknown schedule field "${key}".`);
        }
      }
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
        return invalid('Schedule field "enabled" must be a boolean.');
      }
      if (
        patch.intervalMinutes !== undefined &&
        (typeof patch.intervalMinutes !== "number" ||
          !Number.isInteger(patch.intervalMinutes) ||
          patch.intervalMinutes <= 0)
      ) {
        return invalid('Schedule field "intervalMinutes" must be a positive whole number of minutes.');
      }
      if (patch.cron !== undefined && (typeof patch.cron !== "string" || !patch.cron.trim())) {
        return invalid('Schedule field "cron" must be a non-empty string.');
      }
      if (patch.intervalMinutes !== undefined && patch.cron !== undefined) {
        return invalid("Name either intervalMinutes or cron, not both — a schedule carries one cadence mechanism.");
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the action was refused rather than dispatched through an unwired path.",
            code: "FEED_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      try {
        const status = await door.getFeedJobSurfaceStatus(jobId);
        const current = status.schedule;
        const interval =
          patch.intervalMinutes !== undefined
            ? `every ${patch.intervalMinutes} minutes`
            : patch.cron !== undefined
              ? null
              : (current?.interval ?? null);
        const cron =
          patch.cron !== undefined
            ? (patch.cron as string).trim()
            : patch.intervalMinutes !== undefined
              ? null
              : (current?.cron ?? null);
        const schedule = {
          enabled: (patch.enabled as boolean | undefined) ?? current?.enabled ?? true,
          ...(interval ? { interval } : {}),
          ...(cron ? { cron } : {}),
        };
        await door.configurePipelineJob(jobId, { root: { schedule } });
        const next = await door.getFeedJobSurfaceStatus(jobId);
        ctx.recordAudit("data_provider.feed_job_schedule", "orchestrator", {
          actor: ctx.userLogin,
          providerId: id,
          jobId,
          enabled: next.schedule?.enabled ?? schedule.enabled,
          interval: next.schedule?.interval ?? null,
          cron: next.schedule?.cron ?? null,
        });
        return Response.json({ jobId, schedule: next.schedule, status: next });
      } catch (error) {
        return feedRunRefusalResponse(
          codedErrorOf(error),
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // #3535 — run / pause / resume / cancel / retry one feed job
    // through the pipeline host's control plane (the ScheduledAgent
    // door). A mutation: same session gate as the other actions.
    // The control plane's own refusals surface as 409 with their
    // message — never converted into a success shape.
    if (request.method === "POST" && feedJobActionMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to manage a feed job." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(feedJobActionMatch[1]) as DataProviderId;
      const jobId = decodeURIComponent(feedJobActionMatch[2]);
      const action = feedJobActionMatch[3];
      const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
      if (!entry || entry.sourceId !== id) {
        return Response.json(
          {
            error: `No feed job "${jobId}" is registered for provider "${id}".`,
            code: FEED_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      if (!["run", "pause", "resume", "cancel", "retry"].includes(action)) {
        return Response.json(
          { error: `Unknown feed-job action "${action}".` },
          { status: 404 },
        );
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the action was refused rather than dispatched through an unwired path.",
            code: "FEED_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      try {
        const result =
          action === "run"
            ? await door.runPipelineJob(jobId, { userLogin: ctx.userLogin })
            : action === "pause"
              ? await door.pausePipelineJob(jobId)
              : action === "resume"
                ? await door.resumePipelineJob(jobId, { userLogin: ctx.userLogin })
                : action === "cancel"
                  ? await door.cancelPipelineJob(jobId)
                  : await door.retryPipelineJob(jobId, { userLogin: ctx.userLogin });
        ctx.recordAudit("data_provider.feed_job_action", "orchestrator", {
          actor: ctx.userLogin,
          providerId: id,
          jobId,
          action,
        });
        return Response.json({
          jobId,
          action,
          result,
          status: await door.getFeedJobSurfaceStatus(jobId),
        });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "FEED_JOB_ACTION_REFUSED",
          },
          { status: 409 },
        );
      }
    }

    // #3536 — the provider's enrich jobs as pipeline surface
    // views (the same merged views the copilot tools return).
    if (request.method === "GET" && enrichJobsMatch) {
      const id = decodeURIComponent(enrichJobsMatch[1]) as DataProviderId;
      return Response.json({ jobs: await enrichJobsViewFor(ctx, id) });
    }

    // #3536 — run / pause / resume / cancel / retry one enrich
    // job through the pipeline host's control plane (the same
    // door + gates as the feed-job actions above, transposed).
    if (request.method === "POST" && enrichJobActionMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to manage an enrich job." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(enrichJobActionMatch[1]) as DataProviderId;
      const jobId = decodeURIComponent(enrichJobActionMatch[2]);
      const action = enrichJobActionMatch[3];
      const entry = ENRICH_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
      if (!entry || entry.sourceId !== id) {
        return Response.json(
          {
            error: `No enrich job "${jobId}" is registered for provider "${id}".`,
            code: ENRICH_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      if (!["run", "pause", "resume", "cancel", "retry"].includes(action)) {
        return Response.json(
          { error: `Unknown enrich-job action "${action}".` },
          { status: 404 },
        );
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the action was refused rather than dispatched through an unwired path.",
            code: "ENRICH_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      try {
        const result =
          action === "run"
            ? await door.runPipelineJob(jobId, { userLogin: ctx.userLogin })
            : action === "pause"
              ? await door.pausePipelineJob(jobId)
              : action === "resume"
                ? await door.resumePipelineJob(jobId, { userLogin: ctx.userLogin })
                : action === "cancel"
                  ? await door.cancelPipelineJob(jobId)
                  : await door.retryPipelineJob(jobId, { userLogin: ctx.userLogin });
        ctx.recordAudit("data_provider.enrich_job_action", "orchestrator", {
          actor: ctx.userLogin,
          providerId: id,
          jobId,
          action,
        });
        return Response.json({
          jobId,
          action,
          result,
          status: await door.getEnrichJobSurfaceStatus(jobId),
        });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "ENRICH_JOB_ACTION_REFUSED",
          },
          { status: 409 },
        );
      }
    }

    // #3537 — the provider's analyze jobs as pipeline surface
    // views (the same merged views the copilot tools return).
    if (request.method === "GET" && analyzeJobsMatch) {
      const id = decodeURIComponent(analyzeJobsMatch[1]) as DataProviderId;
      return Response.json({ jobs: await analyzeJobsViewFor(ctx, id) });
    }

    // #3537 — run / pause / resume / cancel / retry one analyze
    // job through the pipeline host's control plane (the same
    // door + gates as the enrich-job actions above, transposed).
    if (request.method === "POST" && analyzeJobActionMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to manage an analyze job." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(analyzeJobActionMatch[1]) as DataProviderId;
      const jobId = decodeURIComponent(analyzeJobActionMatch[2]);
      const action = analyzeJobActionMatch[3];
      const entry = ANALYZE_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
      if (!entry || entry.sourceId !== id) {
        return Response.json(
          {
            error: `No analyze job "${jobId}" is registered for provider "${id}".`,
            code: ANALYZE_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      if (!["run", "pause", "resume", "cancel", "retry"].includes(action)) {
        return Response.json(
          { error: `Unknown analyze-job action "${action}".` },
          { status: 404 },
        );
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the action was refused rather than dispatched through an unwired path.",
            code: "ANALYZE_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      try {
        const result =
          action === "run"
            ? await door.runPipelineJob(jobId, { userLogin: ctx.userLogin })
            : action === "pause"
              ? await door.pausePipelineJob(jobId)
              : action === "resume"
                ? await door.resumePipelineJob(jobId, { userLogin: ctx.userLogin })
                : action === "cancel"
                  ? await door.cancelPipelineJob(jobId)
                  : await door.retryPipelineJob(jobId, { userLogin: ctx.userLogin });
        ctx.recordAudit("data_provider.analyze_job_action", "orchestrator", {
          actor: ctx.userLogin,
          providerId: id,
          jobId,
          action,
        });
        return Response.json({
          jobId,
          action,
          result,
          status: await door.getAnalyzeJobSurfaceStatus(jobId),
        });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "ANALYZE_JOB_ACTION_REFUSED",
          },
          { status: 409 },
        );
      }
    }

    // #3538 — the provider's generate jobs as pipeline surface
    // views (the same merged views the copilot tools return).
    if (request.method === "GET" && generateJobsMatch) {
      const id = decodeURIComponent(generateJobsMatch[1]) as DataProviderId;
      return Response.json({ jobs: await generateJobsViewFor(ctx, id) });
    }

    // #3538 — run / pause / resume / cancel / retry one generate
    // job through the pipeline host's control plane (the same
    // door + gates as the analyze-job actions above, transposed).
    if (request.method === "POST" && generateJobActionMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to manage a generate job." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(generateJobActionMatch[1]) as DataProviderId;
      const jobId = decodeURIComponent(generateJobActionMatch[2]);
      const action = generateJobActionMatch[3];
      const entry = GENERATE_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
      if (!entry || entry.sourceId !== id) {
        return Response.json(
          {
            error: `No generate job "${jobId}" is registered for provider "${id}".`,
            code: GENERATE_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      if (!["run", "pause", "resume", "cancel", "retry"].includes(action)) {
        return Response.json(
          { error: `Unknown generate-job action "${action}".` },
          { status: 404 },
        );
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the action was refused rather than dispatched through an unwired path.",
            code: "GENERATE_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      try {
        const result =
          action === "run"
            ? await door.runPipelineJob(jobId, { userLogin: ctx.userLogin })
            : action === "pause"
              ? await door.pausePipelineJob(jobId)
              : action === "resume"
                ? await door.resumePipelineJob(jobId, { userLogin: ctx.userLogin })
                : action === "cancel"
                  ? await door.cancelPipelineJob(jobId)
                  : await door.retryPipelineJob(jobId, { userLogin: ctx.userLogin });
        ctx.recordAudit("data_provider.generate_job_action", "orchestrator", {
          actor: ctx.userLogin,
          providerId: id,
          jobId,
          action,
        });
        return Response.json({
          jobId,
          action,
          result,
          status: await door.getGenerateJobSurfaceStatus(jobId),
        });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "GENERATE_JOB_ACTION_REFUSED",
          },
          { status: 409 },
        );
      }
    }

    // #3539 — the provider's deliver jobs as pipeline surface
    // views (the same merged views the copilot tools return).
    if (request.method === "GET" && deliverJobsMatch) {
      const id = decodeURIComponent(deliverJobsMatch[1]) as DataProviderId;
      return Response.json({ jobs: await deliverJobsViewFor(ctx, id) });
    }

    // #3539 — run / pause / resume / cancel / retry one deliver
    // job through the pipeline host's control plane (the same
    // door + gates as the generate-job actions above, transposed).
    if (request.method === "POST" && deliverJobActionMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to manage a deliver job." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(deliverJobActionMatch[1]) as DataProviderId;
      const jobId = decodeURIComponent(deliverJobActionMatch[2]);
      const action = deliverJobActionMatch[3];
      const entry = DELIVER_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
      if (!entry || entry.sourceId !== id) {
        return Response.json(
          {
            error: `No deliver job "${jobId}" is registered for provider "${id}".`,
            code: DELIVER_JOB_CODES.jobNotFound,
          },
          { status: 404 },
        );
      }
      if (!["run", "pause", "resume", "cancel", "retry"].includes(action)) {
        return Response.json(
          { error: `Unknown deliver-job action "${action}".` },
          { status: 404 },
        );
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the action was refused rather than dispatched through an unwired path.",
            code: "DELIVER_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      try {
        const result =
          action === "run"
            ? await door.runPipelineJob(jobId, { userLogin: ctx.userLogin })
            : action === "pause"
              ? await door.pausePipelineJob(jobId)
              : action === "resume"
                ? await door.resumePipelineJob(jobId, { userLogin: ctx.userLogin })
                : action === "cancel"
                  ? await door.cancelPipelineJob(jobId)
                  : await door.retryPipelineJob(jobId, { userLogin: ctx.userLogin });
        ctx.recordAudit("data_provider.deliver_job_action", "orchestrator", {
          actor: ctx.userLogin,
          providerId: id,
          jobId,
          action,
        });
        return Response.json({
          jobId,
          action,
          result,
          status: await door.getDeliverJobSurfaceStatus(jobId),
        });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "DELIVER_JOB_ACTION_REFUSED",
          },
          { status: 409 },
        );
      }
    }

    // #3540 — the provider's composed pipeline chains as
    // end-to-end roll-up views (the same views the copilot
    // tools return).
    if (request.method === "GET" && pipelineChainsMatch) {
      const id = decodeURIComponent(pipelineChainsMatch[1]) as DataProviderId;
      return Response.json({ jobs: await pipelineChainsViewFor(ctx, id) });
    }

    // #3540 — run / pause / resume / cancel / retry one composed
    // chain, or stop / resume / cancel one of its stages,
    // through the pipeline host's control plane (the same door
    // + gates as the deliver-job actions above, transposed to
    // the composition). The stage actions name their stage in
    // the JSON body ({ "stage": "deliver" }).
    if (request.method === "POST" && pipelineChainActionMatch) {
      if (!ctx.userLogin) {
        return Response.json(
          { error: "A verified session is required to manage a pipeline chain." },
          { status: 401 },
        );
      }
      const id = decodeURIComponent(pipelineChainActionMatch[1]) as DataProviderId;
      const jobId = decodeURIComponent(pipelineChainActionMatch[2]);
      const action = pipelineChainActionMatch[3];
      const entry = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
      if (!entry || entry.sourceId !== id) {
        return Response.json(
          {
            error: `No pipeline chain "${jobId}" is registered for provider "${id}".`,
            code: PIPELINE_CHAIN_CODES.chainNotFound,
          },
          { status: 404 },
        );
      }
      const CHAIN_ACTIONS = [
        "run",
        "pause",
        "resume",
        "cancel",
        "retry",
        "stage_pause",
        "stage_resume",
        "stage_cancel",
      ];
      if (!CHAIN_ACTIONS.includes(action)) {
        return Response.json(
          { error: `Unknown pipeline-chain action "${action}".` },
          { status: 404 },
        );
      }
      const door = feedPipelineDoorFor(ctx);
      if (!door) {
        return Response.json(
          {
            error:
              "The pipeline host is not bound on this deployment; the action was refused rather than dispatched through an unwired path.",
            code: PIPELINE_CHAIN_CODES.chainNotConfigured,
          },
          { status: 500 },
        );
      }
      try {
        let stage: string | undefined;
        if (action.startsWith("stage_")) {
          const body = (await request.json().catch(() => null)) as
            | Record<string, unknown>
            | null;
          stage =
            typeof body?.stage === "string" && body.stage.trim()
              ? body.stage.trim().toLowerCase()
              : undefined;
          if (!stage) {
            return Response.json(
              {
                error: `The ${action} action on pipeline chain "${jobId}" requires a stage in the request body (feed, enrich, analyze, generate, or deliver).`,
                code: "PIPELINE_CHAIN_STAGE_REQUIRED",
              },
              { status: 400 },
            );
          }
        }
        const result =
          action === "run"
            ? await door.runPipelineChain(jobId, { userLogin: ctx.userLogin })
            : action === "pause"
              ? await door.pausePipelineJob(jobId)
              : action === "resume"
                ? await door.resumePipelineChain(jobId, { userLogin: ctx.userLogin })
                : action === "cancel"
                  ? await door.cancelPipelineJob(jobId)
                  : action === "retry"
                    ? await door.retryPipelineChain(jobId, { userLogin: ctx.userLogin })
                    : action === "stage_pause"
                      ? await door.stopPipelineChainStage(jobId, stage!)
                      : action === "stage_resume"
                        ? await door.resumePipelineChainStage(jobId, stage!, {
                            userLogin: ctx.userLogin,
                          })
                        : await door.cancelPipelineChainStage(jobId, stage!);
        ctx.recordAudit("data_provider.pipeline_chain_action", "orchestrator", {
          actor: ctx.userLogin,
          providerId: id,
          jobId,
          action,
          ...(stage ? { stage } : {}),
        });
        return Response.json({
          jobId,
          action,
          ...(stage ? { stage } : {}),
          result,
          status: await door.getPipelineChainSurfaceStatus(jobId),
        });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "PIPELINE_CHAIN_ACTION_REFUSED",
          },
          { status: 409 },
        );
      }
    }

    // ---- mutations ----
    if (request.method === "POST" && actionMatch) {
      const id = decodeURIComponent(actionMatch[1]);
      const action = actionMatch[2] as ProviderLifecycleAction;
      if (!LIFECYCLE_ACTIONS.includes(action)) return null;

      // Session gate (#1156 mechanism — see the module header): the
      // login arrives only from a verified session; without it the
      // mutation is refused before any state is read or written.
      if (!ctx.userLogin) {
        return Response.json(
          { error: "Unauthorized: Please log in." },
          { status: 401 }
        );
      }

      const body = (await request.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
        return Response.json({ error: "A JSON object body is required" }, { status: 400 });
      }
      const input = (body ?? {}) as Record<string, unknown>;

      // #2303: with the config port wired, the transition runs
      // over the port (D1; configure/deprovision apply their
      // write phase as one transactional unit — see
      // lifecycle.ts). The audit sink and verifier binding are
      // the same either way.
      const transitionDeps = {
        audit: (event: ProviderLifecycleAuditEvent) => {
          ctx.recordAudit("data_provider.lifecycle", "orchestrator", {
            actor: event.actor,
            providerId: event.providerId,
            action: event.action,
            from: event.from,
            to: event.to,
            outcome: event.outcome,
            ...(event.reason ? { reason: event.reason } : {}),
            ...(event.routeTiers ? { routeTiers: event.routeTiers } : {}),
          });
        },
        verifier:
          action === "verify"
            ? (ctx.buildVerifier
                ? ctx.buildVerifier(id)
                : buildDataProviderVerifier(
                    ctx.env,
                    ctx.userLogin,
                    id,
                    // #1247: verifiers that resolve a configured
                    // credential reference (public) get the record's
                    // own reference; etrade's ignores it.
                    (ctx.configPort
                      ? await ctx.configPort.getProviderConfig(id as DataProviderId)
                      : getProviderConfig(ctx.sql, id as DataProviderId)
                    )?.credentialRef ?? null,
                    // E7 (#1248): probe outcomes are recorded
                    // against the provider's capture log.
                    ctx.sql,
                    // #2303: with the capture port wired, probe
                    // outcomes land in the D1 capture log.
                    ctx.capturePort
                      ? ctx.capturePort.createFetchOutcomeRecorder()
                      : undefined
                  )) ??
              noAdapterVerifier(id)
            : undefined,
        configure:
          action === "configure"
            ? {
                credentialRef: input.credentialRef as string | null | undefined,
                displayName: input.displayName as string | undefined,
                metadata: input.metadata as Record<string, unknown> | undefined,
                routeTiers: input.routeTiers as
                  | ProviderConfigureInput["routeTiers"]
                  | undefined,
              }
            : undefined,
        register:
          action === "register"
            ? {
                adapterKind: input.adapterKind as string | undefined,
                precedence: input.precedence as number | undefined,
                credentialRef: input.credentialRef as string | null | undefined,
                displayName: input.displayName as string | undefined,
              }
            : undefined,
      };
      const record = ctx.configPort
        ? await transitionProviderViaPort(ctx.configPort, id, action, ctx.userLogin, transitionDeps)
        : await transitionProvider(ctx.sql, id, action, ctx.userLogin, transitionDeps);
      return Response.json(
        { provider: record },
        { status: action === "register" ? 201 : 200 }
      );
    }

    return null;
  } catch (err) {
    if (err instanceof ProviderLifecycleError) {
      return Response.json(
        {
          error: err.message,
          code: err.code,
          action: err.action,
          from: err.from,
          to: err.to,
        },
        { status: err.code === "unknown_provider" ? 404 : 409 }
      );
    }
    if (err instanceof DataProviderNotFoundError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Data provider route failed",
        // Issue #2624 fix-up: a 500 must name what failed, so the panel can
        // show a diagnosable message instead of a bare status.
        code: "DATA_PROVIDER_ROUTE_FAILED",
      },
      { status: 500 }
    );
  }
}
