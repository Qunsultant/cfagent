# Poll-202 rows-read lens (slice 2.10, #2665)

Answers the doc follow-up at `docs/architecture/business/screener-workflow.md`
§8 item 12 — "Poll-202 rows-read design: interval × isolate churn ×
per-request auth reads under the #1819 lens" — with numbers derived from
code on main `260569a0`, not estimates. Cadences cited here are pinned by
tests (`tests/phase5_coo_gate_2665.test.ts` for the apiFetch bound,
`tests/polling_config_2419.test.ts` for the goalTrack defaults); if a
cadence changes, its pin fails and this note must be revised with it.

This note does NOT decide headroom. It hands numbers to slice 2.11 (#2666),
which owns the #1819 headroom decision (paid plan vs read reduction).

## The meters (why the lens is per-meter, not per-request)

- **SessionStore DO rows reads** — the constrained meter (#1819: free tier
  5M rows read/day; one SessionStore instance holds every bucket).
  `requireAuth` runs per `/api/*` request with one backing-store read each
  (`src/server.ts`), behind an in-isolate cache (60s positive / 10s negative
  TTL, 2000 entries). The cache does NOT bound totals across short-lived
  isolates: worst case, every poll spends one SessionStore read.
- **DO requests** — Workers Free plan 100k/day. Every poll that reaches the
  OrchestratorAgent DO spends one (the Worker fallback forwards `/api/` to
  the DO, `src/server.ts:4493`).
- **Orchestrator DO SQLite reads** — the job-row read itself
  (`mas_async_jobs` via `createAsyncJobPorts` over the DO's
  `ctx.agentCtx.storage.sql`). A different DO from SessionStore, so a
  different rows-read pool — but still DO-metered, not D1.
- **D1 reads** — a separate meter. `/api/jobs/history` reads the AgentDB
  projection ONLY, never the DO (`src/server.ts:2085` comment).

## Poll paths and their worst cases

### 1. apiFetch 202-poll — up to 124 polls per job

`src/client/apiFetch.ts`: a 202 answer carries `{ jobId, statusUrl }`;
the client polls `statusUrl` (`/api/jobs/{uuid}`) with delay 500ms, ×1.5,
capped at 5000ms, deadline 10 minutes. Delays: 500, 750, 1125, 1688,
2532, 3798, then 5000ms caps. Cumulative 11393ms + 117×5000ms = 596393ms
< 600000ms; one more sleep+fetch lands past the deadline → **124 polls**.

Per poll: 1 SessionStore auth read + 1 DO dispatch + 1 Orchestrator DO
SQLite job-row read (`onRequest` `/api/jobs/{uuid}` → `getAsyncJob`).
Worst-case SessionStore cost per 202-job: **~124 reads** (uncached across
isolates). The 408 answer at the deadline is terminal for the client loop;
the job continues in the background and is reachable via Reports.

### 2. Goal staged-run track — up to 300 polls per run

`src/client/GoalScreenPanel.tsx` `trackStagedRun` with
`POLLING_CONFIG_DEFAULTS` (`src/client/pollingConfig.ts`):
`goalTrackPollMs` 2000ms, `goalTrackDeadlineMs` 600000ms, absolute from
the ORIGINAL submit (a resumed loop gets no fresh 10 minutes) → **≤300
polls per staged run**. Same per-poll read shape as (1) via `statusUrl`.

Mitigations already in the loop: hidden tabs spend zero requests (the
loop re-sleeps while hidden), and the global auto-refresh switch gates
fetches too (OFF → sleep without fetching, deadline unchanged).

### 3. Goal saga poll — 30s while polling

`GoalScreenPanel.tsx` polls `started.statusUrl` (`/api/saga/{id}/status`)
every 30s while `phase === "polling"`. Per poll: 1 SessionStore auth read
(`src/server.ts:836` wiring runs `requireAuth`) + saga audit rows via the
route's audit seam + a D1 projection read ONLY in the pre-audit window
(zero audit rows matched, `src/agents/routes/sagaStatus.ts`).

Note (Unverified, never quoted as a number): the saga-audit store's meter
assignment is not stated here — the audit seam, not SessionStore, serves
those rows, so they do not spend the constrained SessionStore quota.
Confirm the audit store's meter before quoting saga-poll totals.

### 4. /api/jobs/history — D1 only

`requireAuth` (1 SessionStore read) + one D1 projection read. No DO
job-store read. The cheapest poll in the family, meter-wise.

## What the lens says (and does not say)

- The 202-poll and goalTrack loops are per-request / per-run bounded, not
  per-tab indefinite — the #329 disaster (an idle tab's 4s `/api/jobs`
  poll spending ~24.5k req/day, fixed by visibility-aware polling in
  `src/client/polling.ts`) does not recur through these loops. But each
  open staged-run track still spends up to 300 SessionStore reads, and
  each 202-job up to 124 — multiplied by concurrent runs/tabs, this is
  the term 2.11 must size against the 5M/day SessionStore quota.
- Isolate churn is the multiplier the in-isolate cache cannot tame: a
  long-lived isolate serving many polls of one session pays ~1 auth read
  per 60s; fresh isolates per poll pay 1 per poll. The worst case above
  assumes the latter.
- Nothing here changes a cadence. Lowering `goalTrackPollMs`, the apiFetch
  cap, or the saga 30s interval is a 2.11 (or owner) decision with UX
  cost — slower tracking feedback — and must be taken with the headroom
  numbers, not inside this lens note.
