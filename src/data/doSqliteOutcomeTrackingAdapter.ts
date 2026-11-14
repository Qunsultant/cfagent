/**
 * Issue #2356 (#1976 step 4c) — the DO-SQLite implementation
 * of the outcome-tracking port: the legacy src/services/
 * outcomeTracking.ts, moved into the data layer
 * statement-for-statement. The mas_outcomes side of the join
 * goes through the goal/scenario port (constructor-injected),
 * exactly as the legacy module went through
 * goalScenarioStore's listOutcomes. The service module is
 * now a re-export shim over this adapter and
 * outcomeTrackingPorts.
 */
import type { GoalScenarioStore } from "./goalScenarioPorts";
import {
  OUTCOME_TRACKING_TABLE,
  summarizeTrackingEvents,
  type OutcomeTrackingSqlExecutor,
  type OutcomeTrackingStore,
  type OutcomeTrackingSummary,
  type OutcomesPathEntry,
  type RecordOutcomeTerminalInput,
  type StartOutcomeTrackingInput,
  type TrackingEvent,
} from "./outcomeTrackingPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";
import type { TrackRecord } from "../services/researchTrackRecord";

export class DoSqliteOutcomeTrackingStore implements OutcomeTrackingStore {
  constructor(
    private readonly sql: OutcomeTrackingSqlExecutor,
    private readonly goals: GoalScenarioStore,
  ) {}

  ensureTable(): void {
    this.sql.exec(doTableSql("mas_outcome_tracking"));
  }

  private readEvents(userLogin: string): TrackingEvent[] {
    this.ensureTable();
    const rows = Array.from(
      this.sql.exec(
        `SELECT event_json FROM ${OUTCOME_TRACKING_TABLE} WHERE user_login = ? ORDER BY seq ASC`,
        userLogin
      )
    ) as any[];
    return rows.map((r) => JSON.parse(String(r.event_json)) as TrackingEvent);
  }

  private appendEvent(userLogin: string, event: TrackingEvent): void {
    this.ensureTable();
    this.sql.exec(
      `INSERT INTO ${OUTCOME_TRACKING_TABLE} (id, user_login, recommendation_ref, seq, event_kind, event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      `ot-${userLogin}-${event.recommendationRef}-${event.seq}`,
      userLogin,
      event.recommendationRef,
      event.seq,
      event.kind,
      JSON.stringify(event),
      event.at
    );
  }

  private summaryFor(
    userLogin: string,
    recommendationRef: string,
  ): OutcomeTrackingSummary | null {
    const events = this.readEvents(userLogin).filter(
      (e) => e.recommendationRef === recommendationRef
    );
    return summarizeTrackingEvents(events);
  }

  start(userLogin: string, input: StartOutcomeTrackingInput): OutcomeTrackingSummary | null {
    const existing = this.summaryFor(userLogin, input.recommendationRef);
    if (existing) return existing;

    const outcome = this.goals.listOutcomes(userLogin).find(
      (o) => o.recommendationRef === input.recommendationRef
    );
    if (!outcome) return null;

    const now = input.now ?? new Date();
    const provenance = {
      screenRunRef: input.screenRunRef ?? outcome.screenRunRef ?? null,
      goalId: input.goalId ?? outcome.goalId ?? null,
      scenarioId: input.scenarioId ?? outcome.scenarioId ?? null,
      weightsVersion: input.weightsVersion ?? null,
      evalSetVersion: input.evalSetVersion ?? null,
      expiryDate: input.expiryDate ?? null,
    };
    const seq = this.readEvents(userLogin).length + 1;
    this.appendEvent(userLogin, {
      seq,
      recommendationRef: input.recommendationRef,
      kind: "tracked",
      at: now.toISOString(),
      provenance,
    });
    return this.summaryFor(userLogin, input.recommendationRef);
  }

  recordTerminal(
    userLogin: string,
    recommendationRef: string,
    input: RecordOutcomeTerminalInput,
  ): { appended: boolean; reason?: string } {
    const summary = this.summaryFor(userLogin, recommendationRef);
    if (!summary) return { appended: false, reason: "recommendation is not tracked" };
    if (summary.status !== "open") {
      return {
        appended: false,
        reason: `already terminal (${summary.status}); the first terminal record stands`,
      };
    }
    const now = input.now ?? new Date();
    const seq = this.readEvents(userLogin).length + 1;
    this.appendEvent(userLogin, {
      seq,
      recommendationRef,
      kind: input.kind,
      at: now.toISOString(),
      pnlAfterCost: input.pnlAfterCost ?? null,
      notes: input.notes,
    });
    return { appended: true };
  }

  list(userLogin: string): OutcomeTrackingSummary[] {
    const events = this.readEvents(userLogin);
    const byRef = new Map<string, TrackingEvent[]>();
    for (const e of events) {
      const list = byRef.get(e.recommendationRef) ?? [];
      list.push(e);
      byRef.set(e.recommendationRef, list);
    }
    const out: OutcomeTrackingSummary[] = [];
    for (const list of byRef.values()) {
      const s = summarizeTrackingEvents(list);
      if (s) out.push(s);
    }
    return out.sort((a, b) => (a.trackedAt < b.trackedAt ? 1 : -1));
  }

  expireDue(
    userLogin: string,
    input: { now: Date; finalPnlByRef: Record<string, number> },
  ): { expired: string[]; awaitingPrice: string[] } {
    const expired: string[] = [];
    const awaitingPrice: string[] = [];
    const nowIso = input.now.toISOString();
    for (const summary of this.list(userLogin)) {
      if (summary.status !== "open") continue;
      const expiry = summary.provenance.expiryDate;
      if (!expiry || expiry > nowIso.slice(0, 10)) continue;
      const pnl = input.finalPnlByRef[summary.recommendationRef];
      if (typeof pnl !== "number") {
        awaitingPrice.push(summary.recommendationRef);
        continue;
      }
      const res = this.recordTerminal(userLogin, summary.recommendationRef, {
        kind: "expired",
        pnlAfterCost: pnl,
        now: input.now,
      });
      if (res.appended) expired.push(summary.recommendationRef);
    }
    return { expired, awaitingPrice };
  }

  buildPath(userLogin: string, track: TrackRecord): OutcomesPathEntry[] {
    const tracking = new Map(
      this.list(userLogin).map((s) => [s.recommendationRef, s])
    );
    return this.goals.listOutcomes(userLogin).map((outcome) => ({
      outcome,
      tracking: outcome.recommendationRef
        ? (tracking.get(outcome.recommendationRef) ?? null)
        : null,
      trackIdeas: outcome.screenRunRef
        ? track.ideas.filter((i) => i.runId === outcome.screenRunRef)
        : [],
    }));
  }
}
