/**
 * Issue #1888: enrichment run store + dedicated killswitch storage.
 *
 * Runs persist in the orchestrator's storage SQL (the same idiom as
 * the feed-snapshot store: idempotent creation + single-line
 * statements), keyed by job + stage so stage-persisted output is
 * addressable and resumable. The killswitch lives in the existing
 * settings table under its own key — the same table the global
 * #756 halt reads, a different key, so either switch stops this
 * loop and neither aliases the other.
 *
 * State-write safety: the killswitch write is authoritative and
 * throws on failure; the audit call is best-effort (a failed audit
 * must never block an operator stop — it is logged, and the state
 * still changed). Reads fail closed to halted.
 */

import {
  summarizeEnrichmentQuality,
  type EnrichmentKillswitchState,
  type EnrichmentQualitySummary,
  type EnrichmentRunRecord,
  type EnrichmentRunStore,
} from "./enrichmentPorts";

// Issue #2337 (#1976 step 2): SqlEnrichmentStore moved behind
// its existing port into the data layer
// (src/data/doSqliteEnrichmentAdapter.ts) — adapter move only;
// this module keeps the in-memory adapter and re-exports the
// SQL class + its executor/audit types so every existing
// import path is preserved.
export {
  SqlEnrichmentStore,
  type EnrichmentAuditFn,
  type EnrichmentSqlExecutor,
} from "../data/doSqliteEnrichmentAdapter";

/** In-memory store for tests and non-durable callers. */
export class InMemoryEnrichmentStore implements EnrichmentRunStore {
  private runs: EnrichmentRunRecord[] = [];
  private killswitch: EnrichmentKillswitchState = "clear";
  /** When true, reads throw → fail-closed to halted. Test seam. */
  unreadable = false;
  auditCalls: Array<{ type: string; agent: string; payload: Record<string, unknown> }> = [];

  recordRun(run: EnrichmentRunRecord): void {
    this.runs.push(run);
  }

  listRuns(limit = 20): EnrichmentRunRecord[] {
    return [...this.runs].reverse().slice(0, limit);
  }

  getRun(id: string): EnrichmentRunRecord | null {
    return this.runs.find((r) => r.id === id) ?? null;
  }

  qualitySummary(limit = 200): EnrichmentQualitySummary {
    return summarizeEnrichmentQuality(this.listRuns(limit));
  }

  getKillswitchState(): EnrichmentKillswitchState {
    if (this.unreadable) return "halted";
    return this.killswitch;
  }

  setKillswitch(
    state: EnrichmentKillswitchState,
    setBy: string,
    reason: string,
  ): EnrichmentKillswitchState {
    this.killswitch = state;
    this.auditCalls.push({
      type: "enrichment.killswitch",
      agent: "enrichment",
      payload: { state, setBy, reason },
    });
    return state;
  }
}
