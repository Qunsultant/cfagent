/**
 * @deprecated Retired by #6101 step 8 (2026-11-26) — the canonical
 * mas_reports seeder: it read the Orchestrator instance's mas_reports
 * rows and mirrored them into D1 agent_reports. Superseded by
 * src/data/d1AuditReportAdapter.ts (recordReport — new reports are
 * written to D1 directly at generation). The seed copied existing DO
 * rows into D1, which the replacement ruling forbids, so the seeder is
 * retired, not moved; the seed route answers 410 Gone
 * (reports-seed-retired-6101). The retired seeder resolved its
 * workspace through DEPLOYMENT_DEFAULT_WORKSPACE_ID
 * (src/config/tenantDefaults.ts); it never carried a diverging
 * workspace literal. This file is a frozen stub: no implementation,
 * no callers, no exports. Do not add consumers. Deletion needs zero
 * consumers plus an owner decision plus a gate amendment (gitops §22);
 * recorded in docs/architecture/transition/deprecations.md (#6101).
 */
export {};
