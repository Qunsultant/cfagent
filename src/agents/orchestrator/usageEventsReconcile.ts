/**
 * Issue #3185 (bridge slice) — the sweep carrier: a one-off
 * backfill + repair pass that projects this DO instance's
 * usage_events rows into the D1 mirror through the shared
 * projector (via postUsageEventBestEffort, the ORM carrier's
 * write helper), and prunes rows past the 365d retention window
 * in this instance AND the mirror, in the same pass.
 *
 * This is the backstop for rows whose live hook missed them —
 * the synchronous recordUsageEvent sites (research run/evaluation
 * rows, which carry no env and never call the hook) project ONLY
 * through this sweep — and the backfill for legacy rows, whose
 * tenant the sweep resolves by the ladder below. It is NOT a
 * recurring cron — the operator invokes it deliberately through
 * POST /api/ops/usage-events-reconcile, once per instance (an
 * optional instance hint names the DO; no instance enumeration
 * exists, so the operator names the instance).
 *
 * Tenant ladder for a row whose write-time stamp is NULL
 * (NULL-means-unattributed, never invented):
 *  1. DETERMINISTIC — the row's detail_json.receiptId names a
 *     paid transaction (mas_transactions id tx_<receiptId>)
 *     whose tenant_id is stamped (#3182): that tenant. The
 *     payment proves the attribution.
 *  2. APPROXIMATE — the transaction's customer login (or, with
 *     no transaction, the row's own userLogin) resolves to a
 *     CURRENT account tenant via getAccount(login).tenantId.
 *     Approximate because a login whose tenant changed since the
 *     row was written stamps today's tenant — no account history
 *     is kept — and the count names it as approximate.
 *  3. NULL — no transaction, no account row, anonymous x402/MPP
 *     payer rows (x402:<payer>), legacy default* logins, and any
 *     login whose tenant cannot be resolved. Stays NULL.
 * A row that already carries a tenant projects as-is; the ladder
 * never overwrites a stamp.
 *
 * Bounds: at most `limit` rows WRITTEN per call (default 100) —
 * projections of unmirrored rows plus NULL-tenant stamps on
 * already-mirrored rows. The scan itself is oldest-first over
 * this instance's rows, skipping rows the mirror already holds
 * (by a prefetched id set), so each call makes progress and a
 * second call continues where the first stopped — a
 * restart-from-top list that stopped at `limit` examined rows
 * would never drain past the first batch. No durable cursor in
 * this slice (recorded limit).
 *
 * Prune order: the 365d prune runs BEFORE the projection, in
 * this instance and in the mirror — rows past the window are
 * never projected (they would be pruned immediately after).
 * A partial prune would misstate tenant totals, so the pass
 * reports both counts.
 *
 * Never throws for row-level failures: each row's failure is
 * collected in `errors` with its id, and the sweep continues.
 * An unbound AGENT_DB is a named `refused`, never a silent
 * zero-row pass that looks like a clean bill of health.
 */
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { resolveAccountTenantId } from "../../services/accountTenant";
import { postUsageEventBestEffort } from "../../services/usageEventProjectionPosting";
import {
  createUsageEventMirrorAdapter,
  ensureUsageEventMirrorTables,
} from "../../data/createUsageEventMirrorPorts";
import { createUsageEventProjector } from "../../data/usageEventProjection";
import { DoSqliteTransactionLedgerAdapter } from "../../data/doSqliteOrmAdapters";
import { DoSqliteUsageEventStore, USAGE_EVENTS_RETENTION_MAX_AGE_DAYS } from "../../data/doSqliteUsageEventAdapter";
import type { UsageEventDetailRow } from "../../data/canonicalReportStorePorts";
import type { SqlStorage } from "../../orm";
import type { Env } from "../../types";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/usageEventsReconcile",
});

/** The sweep's hard per-call bound. */
export const USAGE_EVENTS_RECONCILE_LIMIT = 100;

export interface UsageEventsReconcileError {
  id: string;
  error: string;
}

/** How one legacy row's tenant was resolved (never invented). */
export type BackfillTenantTier = "deterministic" | "approximate" | "unattributed";

export interface ReconcileUsageEventsResult {
  checked: number;
  reconciled: number;
  alreadyCurrent: number;
  /** NULL tenants filled from the stamped transaction row. */
  tenantDeterministic: number;
  /** NULL tenants filled from the current account (approximate). */
  tenantApproximate: number;
  /** Rows that stayed NULL (anonymous, no account, no transaction). */
  tenantUnattributed: number;
  /** DO rows pruned in this pass (365d window). */
  prunedDo: number;
  /** Mirror rows pruned in this pass (-1 when the driver reports no count). */
  prunedMirror: number;
  errors: UsageEventsReconcileError[];
  /** Set when the sweep refused to run (named, never silent). */
  refused?: string;
}

function receiptIdOf(row: UsageEventDetailRow): string | null {
  try {
    const detail = row.detailJson ? (JSON.parse(row.detailJson) as Record<string, unknown>) : null;
    const receiptId = detail?.receiptId;
    return typeof receiptId === "string" && receiptId.length > 0 ? receiptId : null;
  } catch {
    return null;
  }
}

/**
 * The paid transaction's tenant for one receipt, or null when the
 * transaction row is missing or its tenant is NULL (#3182 stamps
 * NULL for x402 wallet receipts and legacy rows — never invented).
 * Reads through the transaction ledger's own port (the DO
 * Repository's findById), not raw SQL — the sweep runs inside
 * the instance that holds both tables, and the census pins
 * storage-exec sites to the data layer.
 */
export function transactionTenantForReceipt(
  sql: SqlStorage,
  receiptId: string,
): { tenantId: string | null; customer: string | null } {
  const tx = new DoSqliteTransactionLedgerAdapter(sql).findById(`tx_${receiptId}`);
  if (!tx) return { tenantId: null, customer: null };
  return {
    tenantId: typeof tx.tenantId === "string" && tx.tenantId.length > 0 ? tx.tenantId : null,
    customer: typeof tx.customer === "string" && tx.customer.length > 0 ? tx.customer : null,
  };
}

/**
 * Resolve one legacy row's tenant by the ladder above. Returns
 * the tenant (or null) and the tier that produced it. A row that
 * already carries a tenant never reaches this function.
 */
export async function resolveBackfillTenant(args: {
  env: Partial<Env>;
  sql: SqlStorage;
  row: UsageEventDetailRow;
}): Promise<{ tenantId: string | null; tier: BackfillTenantTier }> {
  const receiptId = receiptIdOf(args.row);
  if (receiptId) {
    let tx: { tenantId: string | null; customer: string | null };
    try {
      tx = transactionTenantForReceipt(args.sql, receiptId);
    } catch {
      tx = { tenantId: null, customer: null };
    }
    if (tx.tenantId) return { tenantId: tx.tenantId, tier: "deterministic" };
    // No stamped transaction: fall through to the account ladder
    // on the transaction's customer login (the payment's identity),
    // or the row's own login when the transaction row is missing.
    const login = tx.customer ?? args.row.userLogin;
    const tenantId = await resolveAccountTenantId(args.env, login);
    if (tenantId) return { tenantId, tier: "approximate" };
    return { tenantId: null, tier: "unattributed" };
  }
  const tenantId = await resolveAccountTenantId(args.env, args.row.userLogin);
  if (tenantId) return { tenantId, tier: "approximate" };
  return { tenantId: null, tier: "unattributed" };
}

export async function reconcileUsageEventsProjection(args: {
  env: Partial<Env>;
  sql: SqlStorage;
  /** The instance this sweep runs in (mirror provenance label). */
  sourceInstance: string;
  limit?: number;
  nowMs?: number;
  /**
   * Whether this leg prunes the D1 mirror (default true). The
   * OrchestratorActor's fan-out to a ResearchAgent instance
   * passes false — the orchestrator leg already pruned the
   * mirror in the same call, and a second prune would only
   * re-count zero rows.
   */
  pruneMirror?: boolean;
}): Promise<ReconcileUsageEventsResult> {
  const env = args.env;
  const nowMs = args.nowMs ?? Date.now();
  const limit = Math.min(
    Math.max(args.limit ?? USAGE_EVENTS_RECONCILE_LIMIT, 1),
    USAGE_EVENTS_RECONCILE_LIMIT,
  );
  const result: ReconcileUsageEventsResult = {
    checked: 0,
    reconciled: 0,
    alreadyCurrent: 0,
    tenantDeterministic: 0,
    tenantApproximate: 0,
    tenantUnattributed: 0,
    prunedDo: 0,
    prunedMirror: -1,
    errors: [],
  };

  const adapter = createUsageEventMirrorAdapter(env);
  if (!adapter || !(env as { AGENT_DB?: unknown }).AGENT_DB) {
    result.refused = "AGENT_DB unbound: no mirror to project into; DO rows untouched.";
    structuredLog.error("usageEvent.reconcile_refused", {
      message: "[usage-event] reconcile refused (AGENT_DB unbound).",
    });
    return result;
  }

  const store = new DoSqliteUsageEventStore(args.sql);

  // Prune first (DO + mirror, same 365d window): rows past the
  // window are never projected.
  const cutoffIso = new Date(
    nowMs - USAGE_EVENTS_RETENTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    result.prunedDo = store.pruneBefore(cutoffIso);
  } catch (err) {
    result.errors.push({
      id: "<prune-do>",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await ensureUsageEventMirrorTables(adapter);
    if (args.pruneMirror !== false) {
      result.prunedMirror = await adapter.pruneBefore(cutoffIso);
    } else {
      result.prunedMirror = 0;
    }
  } catch (err) {
    result.errors.push({
      id: "<prune-mirror>",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Oldest-first drain: prefetch the mirror's id set once, then
  // scan this instance's rows, writing at most `limit` rows (new
  // projections + NULL-tenant stamps). Already-mirrored rows are
  // skipped for projection but still get their NULL-tenant stamp
  // repair (a row projected with a NULL tenant before the
  // backfill ran). The scan stops when the write budget is spent,
  // so a second call resumes past the rows this call wrote.
  let rows: UsageEventDetailRow[];
  try {
    rows = store.listAllWithDetail();
  } catch (err) {
    result.errors.push({
      id: "<list>",
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
  let mirrorTenants: Map<string, string | null>;
  try {
    mirrorTenants = new Map(
      (await adapter.listAll()).map((r) => [r.id, r.tenantId] as const),
    );
  } catch (err) {
    result.errors.push({
      id: "<mirror-list>",
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
  const projector = createUsageEventProjector({ mirror: adapter });
  let written = 0;
  for (const row of rows) {
    if (written >= limit) break;
    result.checked++;
    try {
      const mirrorTenant = mirrorTenants.get(row.id);
      if (mirrorTenant !== undefined) {
        // Already mirrored: only the NULL-tenant stamp can still
        // apply. The DO row's own stamp wins over the ladder —
        // it is authoritative — then the ladder for a NULL row.
        result.alreadyCurrent++;
        if (mirrorTenant == null) {
          let stampTenant: string | null = row.tenantId;
          let tier: BackfillTenantTier | null = null;
          if (stampTenant == null) {
            const resolved = await resolveBackfillTenant({ env, sql: args.sql, row });
            stampTenant = resolved.tenantId;
            tier = resolved.tier;
          }
          if (stampTenant != null) {
            await projector.stampTenantIfUnattributed(row.id, stampTenant);
            mirrorTenants.set(row.id, stampTenant);
            written++;
            if (tier === "deterministic") result.tenantDeterministic++;
            else if (tier === "approximate") result.tenantApproximate++;
          } else if (tier === "unattributed") {
            result.tenantUnattributed++;
          }
        }
        continue;
      }
      let tenantId = row.tenantId;
      let tier: BackfillTenantTier | null = null;
      if (tenantId == null) {
        const resolved = await resolveBackfillTenant({ env, sql: args.sql, row });
        tenantId = resolved.tenantId;
        tier = resolved.tier;
      }
      const posted = await postUsageEventBestEffort(
        env,
        { ...row, tenantId, sourceInstance: args.sourceInstance },
        nowMs,
      );
      if (!posted.posted) {
        result.errors.push({ id: row.id, error: posted.skipped ?? "projection skipped" });
        continue;
      }
      written++;
      mirrorTenants.set(row.id, tenantId);
      if (posted.projected) result.reconciled++;
      else result.alreadyCurrent++;
      if (tier === "deterministic") result.tenantDeterministic++;
      else if (tier === "approximate") result.tenantApproximate++;
      else if (tier === "unattributed") result.tenantUnattributed++;
    } catch (err) {
      result.errors.push({
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.errors.length > 0) {
    structuredLog.error("usageEvent.reconcile_errors", {
      message: `[usage-event] reconcile finished with ${result.errors.length} row errors (${result.reconciled} projected, ${result.alreadyCurrent} already current).`,
    });
  }
  return result;
}
