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
 *   POST /data-providers/:id/feed-run                 run the provider's feed job now (#3530 S1)
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
import type {
  CaptureBlobStorage,
  ProviderCaptureStore,
} from "../../data/providerCapturePorts";
import type { FeedDatasetStore } from "../../data/feedDatasetPorts";
import { createFeedDatasetAdapter } from "../../data/createFeedDatasetPorts";
import type { IndexListStore } from "../../data/indexListPorts";
import { D1IndexListStore } from "../../data/d1IndexListAdapter";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  readFeedQuotes,
  runFeedJob,
  FEED_JOB_CODES,
  type FeedJobDefinition,
  type FeedJobRegistry,
} from "../../services/feedJobs";
import type { DataProvider } from "../../trading";


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
  /**
   * #3530 S1 — the local-copy blob store for the default
   * capture-wired feed providers (the orchestrator's storage; the
   * same wiring screening's fetches use). Absent ⇒ feed runs
   * report FEED_JOB_NOT_CONFIGURED rather than fetching uncaptured.
   */
  blobStorage?: CaptureBlobStorage;
  /** #3530 S1 — feed-dataset store override (tests); undefined ⇒ built from the request env (AGENT_DB); explicit null ⇒ none. */
  feedDatasetStore?: FeedDatasetStore | null;
  /** #3530 S1 — index-list store override for feed universes (tests); undefined ⇒ built from AGENT_DB; null ⇒ none. */
  feedUniverseStore?: IndexListStore | null;
  /** #3530 S1 — feed provider override (tests); undefined ⇒ the default capture-wired adapter for the job's source. */
  feedProviderFor?(def: FeedJobDefinition): DataProvider | undefined;
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
  feed?: unknown
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

function feedUniverseStoreFor(
  ctx: DataProviderRoutesContext,
): IndexListStore | null {
  if (ctx.feedUniverseStore !== undefined) return ctx.feedUniverseStore;
  return ctx.env.AGENT_DB
    ? new D1IndexListStore(
        ctx.env.AGENT_DB as ConstructorParameters<typeof D1IndexListStore>[0],
      )
    : null;
}

/**
 * The default capture-wired provider for a feed job — built with
 * the same capture deps screening's fetches use, so the job's
 * captures land in the capture log through the very same write
 * path. S1 wired Yahoo; S2 adds E*TRADE (constructed from env +
 * the verified session login — the service resolves THAT login's
 * stored token, so an absent/expired token is the run's honest
 * failure, never a borrowed identity) and Alpaca (the same
 * construction buildPlatformRegistry uses). Undefined when the
 * source has no default wiring or the blob store the capture
 * machinery needs is absent — a run then refuses
 * FEED_JOB_NOT_CONFIGURED rather than fetching uncaptured.
 */
function defaultFeedProvider(
  ctx: DataProviderRoutesContext,
  def: FeedJobDefinition,
): DataProvider | undefined {
  if (!ctx.blobStorage) return undefined;
  const capture = {
    sql: ctx.sql,
    blobStorage: ctx.blobStorage,
    env: ctx.env,
    capturePort: ctx.capturePort,
  };
  switch (def.sourceId) {
    case "yahoo":
      return createYahooDataProvider(
        new YahooFinanceProvider(ctx.env),
        ctx.env,
        { capture },
      );
    case "etrade":
      return createETradeDataProviderFromEnv(ctx.env, ctx.userLogin, {
        capture,
      });
    case "alpaca":
      return createAlpacaDataProvider(
        new AlpacaMarketDataProvider(ctx.env),
        ctx.env,
        { capture },
      );
    default:
      return undefined;
  }
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
  if (!isList && !oneMatch && !actionMatch && !feedRunMatch) return null;

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

    // #3530 S1 — run the provider's feed job now. A mutation:
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
      const store = feedDatasetStoreFor(ctx);
      const universeStore = feedUniverseStoreFor(ctx);
      const provider = ctx.feedProviderFor
        ? ctx.feedProviderFor(def)
        : defaultFeedProvider(ctx, def);
      if (!store || !universeStore || !provider) {
        return Response.json(
          {
            error:
              "Feed-job wiring is incomplete on this host (dataset store, universe store, or provider missing); the run was refused rather than fetching through an unwired path.",
            code: "FEED_JOB_NOT_CONFIGURED",
          },
          { status: 500 },
        );
      }
      const run = await runFeedJob(
        registry,
        { provider, universeStore, datasetStore: store },
        def.id,
        { trigger: "manual", userLogin: ctx.userLogin },
      );
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
