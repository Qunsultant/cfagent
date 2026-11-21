/**
 * Issue #3185 (bridge slice) — the usage-events doors, moved out of
 * src/agents/orchestrator.ts per the #992 post-refactor size budget:
 * the five door methods (reconcile sweep carrier, retention prune,
 * DSAR erasure, DSAR count) plus the maintenance prune leg live
 * here as module functions taking a UsageEventsDoorsContext; the
 * class keeps thin wrappers with unchanged names and signatures.
 * Same calls, same order, same log event names/messages as the
 * inline versions. No behaviour change.
 */
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { isLoginShaped } from "../../security/serviceIdentity";
import {
  reconcileUsageEventsProjection,
  type ReconcileUsageEventsResult,
} from "./usageEventsReconcile";
import {
  DoSqliteUsageEventStore,
  USAGE_EVENTS_RETENTION_MAX_AGE_DAYS,
} from "../../data/doSqliteUsageEventAdapter";
import {
  createUsageEventMirrorAdapter,
  ensureUsageEventMirrorTables,
} from "../../data/createUsageEventMirrorPorts";
import type { Env } from "../../types";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/usageEventsDoors",
});

export interface UsageEventsResearchAgent {
  reconcileUsageEventsProjection(args: { limit?: number; sourceInstance: string }): Promise<ReconcileUsageEventsResult>;
  pruneUsageEvents(args?: { nowMs?: number }): Promise<number>;
  eraseUsageEventsData(userLogin: string): Promise<{ deleted: number; residual: number }>;
  countUsageEventsData(userLogin: string): Promise<number>;
}

export interface UsageEventsDoorsContext {
  env: Env;
  sql: unknown; // cast to SqlStorage at the use sites inside the module
  sessionKey: () => string;
  getResearchAgent: (login: string) => UsageEventsResearchAgent | null;
  ensureTables: () => void;
}

/**
 * Issue #3185 (bridge slice) — the sweep carrier's DO door: a
 * one-off backfill + repair pass projecting THIS instance's
 * usage_events rows into the D1 mirror, with the 365d prune in
 * the same pass (DO + mirror). Thin wrapper over
 * reconcileUsageEventsProjection (./orchestrator/
 * usageEventsReconcile). Invoked by the admin-gated POST
 * /api/ops/usage-events-reconcile route; never auto-run (no
 * boot, deploy, or tick path calls it). A second call
 * reconciles zero rows when everything is already current.
 * The shared_orchestrator instance has no automatic
 * maintenance driver, so its prune rides this route too.
 */
export async function reconcileUsageEvents(
  ctx: UsageEventsDoorsContext,
  args?: {
    limit?: number;
  }): Promise<ReconcileUsageEventsResult> {
  ctx.ensureTables();
  const local = await reconcileUsageEventsProjection({
    env: ctx.env,
    sql: ctx.sql as never,
    sourceInstance: ctx.sessionKey(),
    limit: args?.limit,
    nowMs: Date.now(),
  });
  // A refused local leg (AGENT_DB unbound) refuses the whole
  // call: the ResearchAgent leg would refuse for the same
  // reason, so there is nothing to fan out to.
  if (local.refused) return local;
  // Per-login instances fan out to their ResearchAgent
  // instance (research:<login>): one route call reconciles
  // BOTH split halves for that login. The shared instance has
  // no per-login research agent, so it reconciles alone.
  const login = ctx.sessionKey();
  if (!isLoginShaped(login)) return local;
  const research = ctx.getResearchAgent(login);
  if (!research) return local;
  let researchResult: ReconcileUsageEventsResult;
  try {
    researchResult = await research.reconcileUsageEventsProjection({
      limit: args?.limit,
      sourceInstance: `research:${login}`,
    });
  } catch (err) {
    local.errors.push({
      id: "<research>",
      error: err instanceof Error ? err.message : String(err),
    });
    return local;
  }
  if (researchResult.refused) {
    local.errors.push({ id: "<research>", error: researchResult.refused });
    return local;
  }
  // Merge: the mirror prune is the local leg's alone (the
  // research leg runs with pruneMirror:false), so prunedMirror
  // is not summed.
  return {
    checked: local.checked + researchResult.checked,
    reconciled: local.reconciled + researchResult.reconciled,
    alreadyCurrent: local.alreadyCurrent + researchResult.alreadyCurrent,
    tenantDeterministic: local.tenantDeterministic + researchResult.tenantDeterministic,
    tenantApproximate: local.tenantApproximate + researchResult.tenantApproximate,
    tenantUnattributed: local.tenantUnattributed + researchResult.tenantUnattributed,
    prunedDo: local.prunedDo + researchResult.prunedDo,
    prunedMirror: local.prunedMirror,
    errors: [...local.errors, ...researchResult.errors],
  };
}

/**
 * Issue #3185 (bridge slice) — the retention prune's DO door:
 * deletes THIS instance's usage_events rows older than 365d
 * and the same window from the D1 mirror, in one pass. Called
 * by the per-login maintenance path below (this instance) and
 * by the ResearchAgent leg through its own stub. Returns the
 * two counts; the mirror count is -1 when the driver reports
 * no count (unknown, never silently zero).
 */
export async function pruneUsageEvents(
  ctx: UsageEventsDoorsContext,
  args?: {
    nowMs?: number;
  }): Promise<{ prunedDo: number; prunedMirror: number }> {
  ctx.ensureTables();
  const nowMs = args?.nowMs ?? Date.now();
  const cutoffIso = new Date(
    nowMs - USAGE_EVENTS_RETENTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const store = new DoSqliteUsageEventStore(ctx.sql as never);
  const prunedDo = store.pruneBefore(cutoffIso);
  let prunedMirror = -1;
  const adapter = createUsageEventMirrorAdapter(ctx.env);
  if (adapter) {
    await ensureUsageEventMirrorTables(adapter);
    prunedMirror = await adapter.pruneBefore(cutoffIso);
  }
  return { prunedDo, prunedMirror };
}

/**
 * Issue #3185 (bridge slice) — the DSAR erasure door for
 * usage_events: deletes one login's rows from THIS instance,
 * fans out to the login's ResearchAgent instance, and deletes
 * the login's rows from the D1 mirror. Returns the deleted
 * total and the residual count (0 when the erasure is
 * complete). THROWS when any of the three legs fails, so the
 * DSAR cascade records the leg as failed instead of reporting
 * a false erasure. Anonymous x402/MPP payer rows (x402:<payer>)
 * are NOT erasable by a subject login — a different identity
 * key with no proof mapping — so a login-shaped subject never
 * matches them, and they never count in the residual.
 */
export async function eraseUsageEvents(
  ctx: UsageEventsDoorsContext,
  userLogin: string,
): Promise<{ deleted: number; residual: number }> {
  ctx.ensureTables();
  const sql = ctx.sql as never;
  const store = new DoSqliteUsageEventStore(sql);
  const deleted = store.deleteByUser(userLogin);
  const research = ctx.getResearchAgent(userLogin);
  const researchErased = research
    ? await research.eraseUsageEventsData(userLogin)
    : { deleted: 0, residual: 0 };
  const adapter = createUsageEventMirrorAdapter(ctx.env);
  let mirrorDeleted = 0;
  if (adapter) {
    await ensureUsageEventMirrorTables(adapter);
    mirrorDeleted = await adapter.deleteByUser(userLogin);
  }
  const residual =
    store.countByUser(userLogin) +
    researchErased.residual +
    (await countMirrorUsageEventsByUser(ctx, userLogin));
  return { deleted: deleted + researchErased.deleted + mirrorDeleted, residual };
}

/** Issue #3185 (bridge slice) — the DSAR count door for usage_events. */
export async function countUsageEvents(ctx: UsageEventsDoorsContext, userLogin: string): Promise<number> {
  ctx.ensureTables();
  const store = new DoSqliteUsageEventStore(ctx.sql as never);
  const research = ctx.getResearchAgent(userLogin);
  const researchCount = research ? await research.countUsageEventsData(userLogin) : 0;
  return (
    store.countByUser(userLogin) +
    researchCount +
    (await countMirrorUsageEventsByUser(ctx, userLogin))
  );
}

async function countMirrorUsageEventsByUser(ctx: UsageEventsDoorsContext, userLogin: string): Promise<number> {
  try {
    const adapter = createUsageEventMirrorAdapter(ctx.env);
    if (!adapter) return 0;
    await ensureUsageEventMirrorTables(adapter);
    return await adapter.countByUser(userLogin);
  } catch {
    return 0;
  }
}

// Issue #3185 (bridge slice): usage_events retention pruning
// rides the same maintenance path, in its own isolated legs —
// a prune failure never affects sweeps. This instance's leg
// prunes its own DO rows AND the D1 mirror in one pass; the
// ResearchAgent leg prunes that instance's rows. The
// shared_orchestrator instance has no maintenance driver, so
// its prune rides the reconcile route instead. A partial
// prune would misstate tenant totals, so the two counts land
// in the summary log below.
export async function pruneUsageEventsMaintenance(
  ctx: UsageEventsDoorsContext,
  userLogin: string,
): Promise<[number, number, number]> {
  let usageEventsPrunedDo = 0;
  let usageEventsPrunedMirror = -1;
  try {
    const pruned = await pruneUsageEvents(ctx);
    usageEventsPrunedDo = pruned.prunedDo;
    usageEventsPrunedMirror = pruned.prunedMirror;
  } catch (error) {
    structuredLog.warn("orchestrator.usage_events_retention_prune_failed", {
      message: `[OrchestratorAgent] Usage-events retention prune failed for ${userLogin}:`,
      userLogin,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let usageEventsPrunedResearch = 0;
  try {
    const research = ctx.getResearchAgent(userLogin);
    if (research) usageEventsPrunedResearch = await research.pruneUsageEvents();
  } catch (error) {
    structuredLog.warn("orchestrator.research_usage_events_retention_prune_failed", {
      message: `[OrchestratorAgent] Research usage-events retention prune failed for ${userLogin}:`,
      userLogin,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return [usageEventsPrunedDo, usageEventsPrunedMirror, usageEventsPrunedResearch];
}
