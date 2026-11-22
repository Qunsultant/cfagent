// Issue #354 — pure fire/no-fire decision for folding the daily options
// research run into the "*/30" scheduled tick.
//
// Context: the account is at the Workers Free ceiling of 5 cron triggers
// per account (error 10072), so the dedicated "0 21 * * 1-5" trigger cannot
// exist and its server.ts branch is dead code. The daily run therefore rides
// the "*/30" tick, and must fire exactly once per weekday, at/after 21:00
// UTC (17:00 ET after market close).
//
// The "already fired today" input comes from durable state — the
// orchestrator's mas_settings row (survives across ticks AND isolates;
// an in-memory flag alone would not). This module stays pure (no SDK
// imports) so the decision is unit-testable without the Worker harness.
// All date/time math is in UTC, matching how cron triggers fire.

import {
  DEFAULT_RESEARCH_JOB_CONFIG,
  type ResearchJobConfig,
} from "../config/researchJobConfig";

/**
 * Issue #6030 — the one declaration of the fire hour is the research
 * job config (`scheduleUtcHour`, overridable by
 * `RESEARCH_SCHEDULE_UTC_HOUR`). This module reads it; it must never
 * carry a second literal of its own.
 */
export type ResearchFireHourConfig = Pick<ResearchJobConfig, "scheduleUtcHour">;

/**
 * Durable marker key for the last day the scheduled research run fired,
 * stored in the orchestrator's mas_settings (YYYY-MM-DD, UTC).
 */
export const RESEARCH_SCHEDULED_LAST_RUN_KEY = "research_scheduled_last_run";

/**
 * Issue #3121 #4241 — the unified-store record id of the nightly
 * research run, named once here beside its firing rule: the record
 * is derived from this duty, so the id lives with the duty's
 * identity, not with the management module. It doubles as the
 * ledger jobId the run's rows join on (scheduleIdToLedgerJobId
 * returns the record id itself — no cron mapping like token
 * renewal / retention, whose ledger jobIds are their dispatch
 * crons).
 */
export const NIGHTLY_RESEARCH_RECORD_ID = "nightly-research";

/**
 * Issue #3121 #4241 — the nightly research run's cadence as a cron,
 * DERIVED from the same config the fire decision reads (issue #6030:
 * the hour is one fact, so the record and the firing guard cannot
 * disagree about the cadence when `RESEARCH_SCHEDULE_UTC_HOUR` moves).
 * The unified-store record reads this function, never a re-literalized
 * hour. No Worker cron exists for it (the 5-trigger ceiling, #354)
 * and none is added here — the run rides the every-30-minute tick.
 */
export function nightlyResearchDispatchCron(
  config: ResearchFireHourConfig = DEFAULT_RESEARCH_JOB_CONFIG
): string {
  return `0 ${config.scheduleUtcHour} * * 1-5`;
}

/**
 * YYYY-MM-DD date key for a moment, in UTC. Used both for the durable
 * last-fired marker and for comparing "already fired today".
 */
export function researchTickDateKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type ResearchTickDecision =
  | { fire: true; dateKey: string }
  | {
      fire: false;
      dateKey: string;
      reason: "weekend" | "too-early" | "already-fired";
    };

/**
 * Decide whether the scheduled research run should fire at `now`, given the
 * durable last-fired date key (null when no scheduled run has fired yet).
 *
 * Fires exactly once per weekday (Mon-Fri UTC), only on ticks at/after
 * the configured `scheduleUtcHour` (default 21:00 UTC). The caller owns
 * persistence: on fire it must write `dateKey` to the durable marker
 * (mas_settings) so later ticks the same day see "already-fired".
 *
 * Issue #6030 — the hour comes from the one config
 * (`resolveResearchJobConfig(env).scheduleUtcHour`), the same value
 * `isWithinResearchGuardWindow` reads, so the fire decision and the
 * guard window move together when the env is set.
 */
export function shouldFireResearchTick(
  now: Date,
  lastFiredDateKey: string | null,
  config: ResearchFireHourConfig = DEFAULT_RESEARCH_JOB_CONFIG
): ResearchTickDecision {
  const dateKey = researchTickDateKey(now);
  const dow = now.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  if (dow === 0 || dow === 6) return { fire: false, dateKey, reason: "weekend" };
  if (now.getUTCHours() < config.scheduleUtcHour)
    return { fire: false, dateKey, reason: "too-early" };
  if (lastFiredDateKey === dateKey)
    return { fire: false, dateKey, reason: "already-fired" };
  return { fire: true, dateKey };
}
