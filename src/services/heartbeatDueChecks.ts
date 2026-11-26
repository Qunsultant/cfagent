/**
 * Issue #6503 — the token-renewal and retention duties' identity
 * seam: their ledger jobIds and unified-store record ids, named
 * once here beside each other.
 *
 * The heartbeat tick's due-checks that used to fire these duties
 * (issue #4234, ADR 0030) are RETIRED: the duties are real stored
 * platform-level schedules now (record ids below, monthly by
 * default, created paused), fired through their entry points
 * (`runRenewTokensEntryPoint` / `runRetentionEntryPoint` in
 * consolidatedCronEntries.ts) when the stored schedule fires — the
 * same entry points the due-checks used to call, so the ledger rows
 * they record keep the same jobIds and the Schedules home's
 * last-run joins keep working. The old Worker crons (`0 3`
 * renewal, `0 4` retention) stay OFF per #4112; the manual
 * fallbacks (POST /api/schedules/trigger-renew,
 * POST /api/schedules/trigger-retention) still exist.
 */

/**
 * The ledger jobId of the token-renewal dispatch (S1 §4: a cron
 * run's `jobId` IS its cron expression — the same value the
 * renewal entry point records, so the last-run read joins to it).
 */
export const RENEWAL_DISPATCH_CRON = "0 3 * * *";

/**
 * Issue #3121 #4239 — the unified-store record id of the token-renewal duty, named once here beside its ledger job id: the
 * record is stored under this id, so the id lives with the
 * duty's identity, not with the management module.
 */
export const TOKEN_RENEWAL_RECORD_ID = "token-renewal";

/** The ledger jobId of the retention dispatch (same S1 rule). */
export const RETENTION_DISPATCH_CRON = "0 4 * * *";

/**
 * Issue #3121 #4240 — the unified-store record id of the retention duty, named once here beside its ledger job id: the
 * record is stored under this id, so the id lives with the
 * duty's identity, not with the management module.
 */
export const RETENTION_RECORD_ID = "retention";
