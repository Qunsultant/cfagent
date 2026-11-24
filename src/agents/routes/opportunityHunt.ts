/**
 * Issue 6273 — Opportunity Hunt on-demand run (UX surface).
 *
 * POST /opportunity-hunt/run runs the hunt synchronously and returns the
 * full result (setups per symbol/strategy, scanned/skipped counts, asOf),
 * so the Stock Hub sub-tab can show the hunt's output instead of only
 * the one-line ledger descriptor the scheduled goal records.
 *
 * Reuse, not a new hunt: the run is `executeOpportunityHunt` over the
 * same persisted technicals bars the scheduled-agent handler reads
 * (same feed job, same stale rule, same named failures — a missing or
 * stale artifact fails as opportunity_hunt_no_bars, never an empty
 * "success"). The evaluator, the strategies, and the schedule are
 * untouched; this file only composes the existing loader blocks into a
 * run seam, exactly as the handler composes them. The loader wiring is
 * deliberately duplicated here rather than extracted: the handler is
 * frozen for this slice, so a shared loader is a follow-up, not part
 * of this change.
 *
 * Note: server.ts strips the /api prefix before forwarding, so the DO
 * sees /opportunity-hunt/run.
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { TradingPlatformRegistry, brokerSupports } from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { isFeatureEnabled } from "../../config/featureFlags";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";
import { BROKER_PANEL_CONTRACT_FLAG } from "./brokerReads";
import { createFeedDatasetAdapter } from "../../data/createFeedDatasetPorts";
import {
  buildFeedJobRegistry,
  readPersistedTechnicalsBars,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
} from "../../services/feedJobs";
import {
  executeOpportunityHunt,
  type OpportunityHuntHoldingsStatus,
} from "../../services/opportunityHunt";

export interface OpportunityHuntRouteContext {
  /** Worker env (AGENT_DB binds the feed dataset store). */
  env: unknown;
  /** Issue 6406 — the holdings read reuses the broker-reads blocks, so the route needs the same two. */
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
}

/**
 * Issue 6406 — the tenant's holdings for the exit evaluation, from the
 * tenant's selected broker (never a named broker, never a silent fallback).
 *
 * This is the broker-reads route's own composition (`brokerReads.ts`),
 * reused verbatim: the `broker_panel_contract` flag gates the read, the
 * tenant's broker serves it, a broker without the positions capability is
 * refused by name, and a failed read is a coded reason. Any of those
 * states returns an empty holdings map with the reason attached — the
 * hunt then runs flat (entries only) and the panel states the reason,
 * instead of silently dropping exits or failing a working entry hunt.
 * Only long equity positions with a known cost basis feed the evaluator:
 * options and shorts are not the hunt's long-only universe, and an
 * unknown cost basis is not an entry price.
 */
export async function loadHuntHoldings(
  request: Request,
  ctx: OpportunityHuntRouteContext,
): Promise<{
  holdings: ReadonlyMap<string, number>;
  status: OpportunityHuntHoldingsStatus;
}> {
  const unavailable = (
    reason: string,
    broker?: string,
  ): {
    holdings: ReadonlyMap<string, number>;
    status: OpportunityHuntHoldingsStatus;
  } => ({
    holdings: new Map<string, number>(),
    status: {
      available: false,
      ...(broker ? { broker } : {}),
      reason,
    },
  });
  try {
    if (!(await isFeatureEnabled(ctx.env as Env, BROKER_PANEL_CONTRACT_FLAG))) {
      return unavailable(
        "FEATURE_DISABLED: the broker positions read is disabled",
      );
    }
    const broker = await resolveTenantBroker(ctx.env);
    if (!brokerSupports(broker, "positions")) {
      return unavailable(
        `provider_unsupported: ${broker} does not expose positions`,
        broker,
      );
    }
    const userLogin = request.headers.get("x-user-login") || "";
    const environment = resolveBrokerEnvironmentFromSettings(
      (key) => ctx.readSettingRaw(key) ?? null,
      ctx.env as Partial<Env>,
    );
    const platform = TradingPlatformRegistry.getPlatform(
      broker,
      ctx.env as Env,
      ctx.getOrm(),
      userLogin,
      environment,
    );
    if (typeof platform.getPositions !== "function") {
      return unavailable(
        `BROKER_CAPABILITY_NOT_IMPLEMENTED: ${broker} positions`,
        broker,
      );
    }
    const { positions } = await platform.getPositions();
    const holdings = new Map<string, number>();
    for (const position of positions ?? []) {
      if (position.securityType === "OPTN") continue;
      if (position.positionType === "SHORT") continue;
      if (position.costBasisKnown === false) continue;
      const entry = Number(position.pricePaid);
      if (!Number.isFinite(entry) || entry <= 0) continue;
      holdings.set(String(position.symbol).toUpperCase(), entry);
    }
    return { holdings, status: { available: true, broker } };
  } catch (err) {
    return unavailable(
      `BROKER_POSITIONS_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Load the hunt's closes from the persisted technicals bars — the same
 * loader the scheduled-agent hunt handler uses, composed from the same
 * blocks. An unbound store is a configuration state, not an empty
 * universe; a missing or stale artifact yields no closes, and the
 * execute step names that failure (opportunity_hunt_no_bars).
 */
async function loadHuntCloses(
  env: unknown,
  now: Date,
): Promise<ReadonlyMap<string, readonly number[]>> {
  const envStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    env as unknown as Record<string, unknown>,
  )) {
    if (typeof value === "string") envStrings[key] = value;
  }
  const technicalsDef = buildFeedJobRegistry(envStrings).get(
    YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
  );
  const store = createFeedDatasetAdapter(env as { AGENT_DB?: unknown });
  if (!store) {
    throw new Error(
      "opportunity_hunt_store_unbound: AGENT_DB is not bound on this host",
    );
  }
  const persisted = await readPersistedTechnicalsBars(store, {
    ...(technicalsDef
      ? { maxAgeSeconds: technicalsDef.staleAfterMinutes * 60 }
      : {}),
    nowMs: now.getTime(),
  });
  const closes = new Map<string, number[]>();
  if (!persisted || persisted.stale) return closes;
  for (const [symbol, bars] of persisted.barsBySymbol) {
    const series = bars
      .map((bar) => bar.close)
      .filter((close) => Number.isFinite(close));
    if (series.length > 0) closes.set(symbol, series);
  }
  return closes;
}

export async function handleOpportunityHuntRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: OpportunityHuntRouteContext,
): Promise<Response | null> {
  // Issue 6273: on-demand hunt run for the Stock Hub sub-tab.
  if (!(path.endsWith("/opportunity-hunt/run") && request.method === "POST")) {
    return null;
  }
  try {
    const now = new Date();
    // Issue 6406 — the tenant's holdings ride into the evaluation so exit
    // signals can fire; an unavailable holdings read degrades to entries
    // only with the reason attached, never a silent drop or a failed hunt.
    const { holdings, status: holdingsStatus } = await loadHuntHoldings(
      request,
      ctx,
    );
    const result = await executeOpportunityHunt({
      now: () => now,
      loadCloses: () => loadHuntCloses(ctx.env, now),
      holdings,
      holdingsStatus,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0] || "opportunity_hunt_failed";
    return Response.json({ ok: false, code, error: message }, { status: 500 });
  }
}
