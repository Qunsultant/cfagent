# #764 P2 mas_messages retention lifecycle verification

Parent program: Qunsultant/cfagent#764. Slice issue: Qunsultant/cfagent#2928.
Verified 2026-11-02 against current main. This record verifies the
lifecycle; it does not close anything (close-out pass later, per the
2026-11-02 sequencing override).

## Policy

`src/security/storageRetention.ts` is the recorded retention decision
for every `mas_*` table. The `mas_messages` rule: PRUNE, 90 days
(`MAS_MESSAGES_RETENTION_DAYS` env, default 90 — matching the retention
the UI advertises), with `mas_events` at 365d and `mas_memory` at 365d
by `updated_at`. Financial and governance tables are KEEP with reason
(`mas_transactions`, `mas_trades`, `mas_reports`, `mas_policy_verdicts`,
RSI-loop record tables). The module header is the decision record; the
privacy registry (`src/privacy/privacyDsar.ts`) states the same 90d
rule for `mas_messages`.

## Enforcement

- Nightly `0 4 * * *` cron (`wrangler.jsonc`) → `src/server.ts`
  `scheduled()` → `POST /schedules/trigger-retention`
  (`src/agents/routes/schedules.ts`) → `runStorageRetention` against
  the Orchestrator agent's ORM.
- Oldest-first, bounded batches, per-run cap, `capped` flag when a
  backlog remains for the next run.
- The selector is strict: `created_at < cutoff` (oldest-first
  `idsCreatedBefore`, `src/data/doSqliteOrmAdapters.ts`). A row
  exactly AT the cutoff survives — pinned by the new test in this
  slice (`tests/storage-retention.test.ts`, "never deletes an
  unexpired row", mutation-checked: it fails if the selector uses
  `<=` instead of `<`).
- A window `<= 0` disables that table's prune (the messages window is
  the pass's master switch); a disabled pass prunes nothing and writes
  no audit row — pinned by the existing disabled-window test.

## Audit evidence and failure visibility

- One `STORAGE_RETENTION` `mas_events` row per run, even when nothing
  was pruned, carrying pruned counts, cutoffs, windows, caps, and the
  per-table breakdown; plus a `console.info` line per run. Pruning is
  never silent.
- The trigger route returns 500 on a retention failure; the scheduled
  dispatch logs `console.error` and skips only when the service user
  is not provisioned (the deliberate #2331 identity guard — a pass
  must not run unattended work without a verified identity).
- The run's own audit row is written after the `mas_events` prune, so
  it survives its own pass.

## Carried, not built here

- R2 archival-before-delete: an explicit follow-on. No bucket exists
  yet; the retention module names itself as the hook point, and
  retention is deliberately not blocked on archival. Rows are deleted
  directly today, and the audit row says so.
- The stale #237 checklist line ("cron to archive `mas_messages` >30d
  to R2 — OPEN") is outdated in two ways: the enforced window is 90d,
  not 30d, and the mechanism is prune, not archival. The 90d window is
  NOT changed to 30d here — it matches the advertised retention, and
  shrinking it would delete more history, not less. #237 itself is not
  edited or closed by this slice.
- Per-user-instance coverage question: the nightly sweep/snapshot
  legs run on the shared Orchestrator instance (recorded in the #1766
  doc; per-user instances are covered by PITR for those legs).
  Whether per-user `mas_messages` rows are covered by the shared pass
  is an open verification question for the close-out pass, recorded
  here rather than assumed covered.
- #237's other remainders (lint config, separate-worker option,
  cross-channel threat model, confirmation drawer + PII redaction,
  XLSX queue) belong to #237, not to this slice.
