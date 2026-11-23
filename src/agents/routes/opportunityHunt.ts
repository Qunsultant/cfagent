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
import { createFeedDatasetAdapter } from "../../data/createFeedDatasetPorts";
import {
  buildFeedJobRegistry,
  readPersistedTechnicalsBars,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
} from "../../services/feedJobs";
import { executeOpportunityHunt } from "../../services/opportunityHunt";

export interface OpportunityHuntRouteContext {
  /** Worker env (AGENT_DB binds the feed dataset store). */
  env: unknown;
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
    const result = await executeOpportunityHunt({
      now: () => now,
      loadCloses: () => loadHuntCloses(ctx.env, now),
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0] || "opportunity_hunt_failed";
    return Response.json({ ok: false, code, error: message }, { status: 500 });
  }
}
