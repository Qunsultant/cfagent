# Stuck runs — detection, diagnosis, and safe intervention

Operator runbook for async job runs (screens, reports, deliveries,
and other `mas_async_jobs` work) that stay in `running` far longer
than any healthy run. Filed under issue #2567 (programme #2494).

## How a stuck run surfaces

- **Alert (the early signal).** When a job has been `running` for
  longer than the configured threshold — default **30 minutes**,
  Worker env var `STUCK_RUN_ALERT_THRESHOLD_MINUTES` (`0` disables
  the alert) — the next read of that job raises ONE operator alert
  to the Slack operator channel (the same webhook/bot delivery
  surface as the resource cap-alerts). The alert carries the job
  id, capability, display name, age, and owner (the job's session /
  login scope). Exactly one alert fires per job: the claim is a
  guarded `stuck_alerted_at` stamp on the job row, so repeated
  reads and concurrent readers cannot re-alert.
  Audit trail: `async_job.stuck_detected` (claim), then
  `async_job.stuck_alert` (delivered) or
  `async_job.stuck_alert_failed` (delivery failed — check the Slack
  webhook/bot configuration; the runbook below still applies).
- **Backstop (the late signal).** A job still `running` after
  **2 hours** is reaped by the read path itself: it is marked
  `failed` with a "stale running job reaped" error. The reap is a
  safety net, not the diagnosis — by the time it fires the run has
  been stuck for two hours.

## Diagnosis

1. **Identify the run.** From the alert (or the Jobs view): job id,
   capability, owner login, `started_at`. The job record
   (`GET /api/jobs/{id}` as the owner) shows status, stage, chain
   id, and payload.
2. **Is it actually stuck, or just slow?** Screens over the full
   index universe and report renders are the slowest healthy work;
   check the run's stage and any child jobs (same `chain_id`) —
   progress on children means the parent is waiting, not wedged.
3. **Check the platform, not just the job.** A Durable Object
   restart or deploy mid-run, a downstream provider outage
   (broker/data APIs), or a stalled workflow instance behind the
   job all present as a stuck run. If many jobs alert at once,
   treat it as a platform incident, not N stuck jobs.
4. **Check the audit trail** for the job id: claim/execute events
   show where execution stopped; a missing completion event after a
   provider call points at the provider seam.

## Safe intervention

- **Wait, when the evidence says slow-not-stuck.** If children are
  progressing or a provider is recovering, let the run finish; the
  2h reap bounds the worst case.
- **Retry the job** (Jobs view / `POST /api/jobs/{id}/retry`) once
  the root cause is cleared. Retry is duplicate-guarded; a running
  job cannot be double-executed by retrying.
- **Let the reap fire** when the run is wedged beyond recovery and
  no retry is wanted: at 2h the row fails closed with the reap
  error, which unblocks the session's queue.
- **Fail it manually only through the job surfaces** (retry/fail
  endpoints), never by editing `mas_async_jobs` rows directly —
  direct row edits bypass the guarded transitions and the audit
  trail this runbook relies on.

## What NOT to do

- Do not lower `STUCK_RUN_ALERT_THRESHOLD_MINUTES` to chase a noisy
  day; a flood of alerts means slow runs or a platform problem —
  diagnose that instead. Raise it only with a recorded reason.
- Do not treat the alert as the incident: the alert is detection.
  The incident is whatever stopped the run.
- Scope boundary: workflow instances with no async-job wrapper are
  not covered by this alert (their state is not in
  `mas_async_jobs`); screen and job runs surface through their jobs.
