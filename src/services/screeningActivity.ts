/**
 * Screening activity log (issue #1162, Phase 6 of epic #1096).
 *
 * The Public-style agent activity log for the autonomous screening
 * system: one tenant-scoped, append-only feed answering "what did the
 * screening system do, when, and on whose authority?" across
 * discovery runs, strategy-bank re-selection, champion/challenger
 * promotions, weights-v2 adjustments, channel deliveries, and
 * schedule/flag control changes.
 *
 * @deprecated Superseded by src/data/screeningActivityPorts.ts
 * (port), src/data/doSqliteScreeningActivityAdapter.ts
 * (production adapter) and
 * src/data/createEvidenceSatellitePorts.ts (composition root) —
 * #1976 step 4c (#2356, ADR 0022 D-I step 4). This module is a
 * re-export shim: record/list delegate to the DO adapter over
 * the caller's sql handle, statement-for-statement identical
 * to the pre-port implementation. The unified feed's merge
 * stays here (it composes three sources, each failing
 * independently): this port's entries, the re-selection
 * proposals (step 4b's family, still served by
 * strategyBankReselection), and the port's promotion
 * read-through rows. Recording never throws (the
 * scheduledReports metering idiom): a failed activity write
 * is logged, never allowed to break the work it describes.
 */

import { DoSqliteScreeningActivityStore } from "../data/doSqliteScreeningActivityAdapter";
import type {
  RecordScreeningActivityInput,
  ScreeningActivityEntry,
  ScreeningActivityFeedItem,
  ScreeningActivitySqlExecutor,
} from "../data/screeningActivityPorts";
import { listReselectionProposals } from "./strategyBankReselection";
import { ensureChallengerTables } from "./championChallenger";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/screeningActivity",
});

export {
  SCREENING_ACTIVITY_TABLE,
  type ScreeningActivityEntry,
  type ScreeningActivityFeedItem,
  type ScreeningActivityKind,
} from "../data/screeningActivityPorts";

type SqlExec = ScreeningActivitySqlExecutor;

function store(sql: SqlExec): DoSqliteScreeningActivityStore {
  return new DoSqliteScreeningActivityStore(sql);
}

export function ensureScreeningActivityTable(sql: SqlExec): void {
  store(sql).ensureTable();
}

/**
 * Append one activity entry. Returns the entry id, or null when the
 * write failed (logged, never thrown — activity recording must not
 * break the operation it describes).
 */
export function recordScreeningActivity(
  sql: SqlExec,
  input: RecordScreeningActivityInput,
): string | null {
  return store(sql).record(input);
}

/** One tenant's recorded activity, newest first. Never throws; a broken store reads as empty. */
export function listScreeningActivity(
  sql: SqlExec,
  userLogin: string,
  limit = 100,
): ScreeningActivityEntry[] {
  return store(sql).list(userLogin, limit);
}

/**
 * The unified feed: this log's entries merged with the tenant's
 * re-selection proposals (Phase 3's transparency log) and challenger
 * promotions (Phase 5's promotion records), newest first. Each source
 * is read independently — one broken source never hides the others.
 */
export function buildScreeningActivityFeed(
  sql: SqlExec,
  userLogin: string,
  limit = 100,
): ScreeningActivityFeedItem[] {
  const capped = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
  const items: ScreeningActivityFeedItem[] = [];

  for (const entry of listScreeningActivity(sql, userLogin, capped)) {
    items.push({
      id: entry.id,
      at: entry.createdAt,
      kind: entry.kind,
      summary: entry.summary,
      source: "activity",
      detail: entry.detail ?? undefined,
    });
  }

  try {
    for (const row of listReselectionProposals(sql, userLogin, capped)) {
      const p = row.proposal;
      items.push({
        id: row.id,
        at: row.createdAt,
        kind: "reselection",
        source: "reselection",
        summary:
          `Strategy-bank re-selection (${p.regime}): ${p.activeSet.length} active ` +
          `[${p.activeSet.map((a) => a.strategy).join(", ") || "none"}] — ${p.governance} ` +
          `(${p.evaluatedCount} evaluated, cost ${p.costUnitsUsed}/${p.costCapUnits}).`,
        detail: { regime: p.regime, governance: p.governance, logEntries: p.log.length },
      });
    }
  } catch (err) {
    structuredLog.error("screening_activity.reselection_source_failed", {
      message: `[screeningActivity] reselection source failed for ${userLogin}: ${err instanceof Error ? err.message : String(err)}`,
      userLogin,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    ensureChallengerTables(sql);
    for (const r of store(sql).listPromotionRows(userLogin, capped)) {
      items.push({
        id: r.id,
        at: r.created_at,
        kind: "promotion",
        source: "promotion",
        summary:
          `Challenger ${String(r.challenger_id ?? "")} ${String(r.action ?? "")} by ${String(r.actor ?? "")}` +
          (r.reason ? ` — ${String(r.reason)}` : "") +
          (r.weights_version != null ? ` (weights v${String(r.weights_version)})` : "") +
          `.`,
        detail: { challengerId: r.challenger_id, action: r.action, actor: r.actor },
      });
    }
  } catch (err) {
    structuredLog.error("screening_activity.promotion_source_failed", {
      message: `[screeningActivity] promotion source failed for ${userLogin}: ${err instanceof Error ? err.message : String(err)}`,
      userLogin,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, capped);
}
