/**
 * Issue #1170 (E3 of epic #1116): data-provider provisioning
 * lifecycle routes, extracted-style sibling of routes/audit.ts and
 * routes/schedules.ts — invoked from OrchestratorAgent.routeRequest
 * in the sequential path.endsWith matching sequence (after the audit
 * handler). Returns a Response on match, null when no data-provider
 * path matches.
 *
 *   GET  /data-providers                              configs + routes + servability (+ per-provider capture health, E6 #1235)
 *   GET  /data-providers/:id                          one config + its routes
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
  capturePort?: ProviderCaptureStore | null
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
  };
}

/**
 * The tenant scope capture reads use on this surface: the
 * platform's established default (captureStore.resolveRunContext
 * attributes every run without an explicit tenant to "default").
 */
const CAPTURE_TENANT_ID = "default";

export async function handleDataProviderRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: DataProviderRoutesContext
): Promise<Response | null> {
  void url;
  void sessionId;
  const isList = path === "/data-providers" || path === "/data-providers/";
  const oneMatch = path.match(/^\/data-providers\/([^/]+)$/);
  const actionMatch = path.match(/^\/data-providers\/([^/]+)\/([a-z]+)$/);
  if (!isList && !oneMatch && !actionMatch) return null;

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
          configs.map((c) =>
            providerView(registry, c, routeViews, ctx.sql, ctx.capturePort)
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
        provider: await providerView(registry, record, routeViews, ctx.sql, ctx.capturePort),
        routes: routeViews.filter(
          (r) => r.primaryProviderId === id || r.gapFillProviderId === id
        ),
      });
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
