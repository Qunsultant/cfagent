/**
 * @deprecated Retired by #6101 step 7 (2026-11-26) — the DO SQLite
 * adapter for the job_stage_events table. The DO stage-events leg
 * stops: the D1 mirror is the writer. Superseded by
 * src/data/d1JobStageEventAdapter.ts (createD1JobStageEventStore —
 * the one stage-event writer). This file is a frozen stub: no
 * implementation, no callers, no exports. Do not add consumers.
 * Deletion needs zero consumers plus an owner decision plus a gate
 * amendment (gitops §22); recorded in
 * docs/architecture/transition/deprecations.md (#6101).
 */
export {};
