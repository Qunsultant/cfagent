# Feed jobs

**Status:** Design — build in progress (S1 landing) · 2026-11-06 ·
Traces to #3530 (sub-issue of #1069), on the #1116 platform ·
#CDO-mha7

> This doc describes the design as filed in #3530. The first build
> slice (the job contract plus the Yahoo source end-to-end) is
> landing; the remaining sources and slices follow the same contract.
> Where this doc says "a feed job does X", that is the contract the
> build is implementing, not a claim that every source does it today.

## Why feed jobs exist

The provider platform ([data-provider-platform.md](data-provider-platform.md))
captures what screening fetches, but nothing produces data on its
own schedule. Three gaps follow, all verified from code at filing:

- **No producer.** Scheduled tasks can read a stored feed snapshot
  as input (the feed seam: `src/data/feedSnapshotPorts.ts`,
  `src/services/feedSnapshotStore.ts`), and the read side reports
  "feed snapshot store not configured" honestly — but no job writes
  snapshots, and enrichment generally re-fetches live per run.
- **No job status.** The Data Providers panel shows health telemetry
  derived from captures. Nothing shows a feed job: its runs, its
  last outcome, its next scheduled run, or what it persisted.
- **No Copilot binding.** No General Copilot tool runs a feed job or
  reports its status.

## The feed-job contract

One feed job per source, behind the provider ports:

- **Dataset contract** — each job declares the elements it pulls
  (quotes at minimum), its universe, and its cadence expectations,
  against the DataProvider registry's capability assignments.
- **Persistence** — every run persists through the existing capture
  machinery (`src/data/providerCapturePorts.ts`) and writes the feed
  snapshot through the snapshot store's port. Raw + normalized,
  run-linked. No parallel store is created for feed data.
- **Local-copy reads** — enrichment and screening read the persisted
  copy for the covered elements. The copy carries provenance and a
  timestamp, and every read surface labels its age. A read never
  silently re-runs the job; a live-refetch fallback, where one
  exists, is explicit and labelled as live, never presented as the
  stored copy.
- **Scheduling** — feed jobs register in the platform scheduler like
  other jobs, and record their runs through the shared run-record
  machinery specified in [publish-stage.md](publish-stage.md) —
  sequenced with #3527 S5 rather than a second run store.
- **Status surface** — per source: last run state and outcome, rows
  persisted, data freshness, next scheduled run, recent history.
  Run results are downloadable from the same surface.
- **Copilot binding** — General Copilot tools to run a feed job for
  a named source and to report a source's feed status, so the
  natural prompt ("run the Yahoo feed job and show its status", and
  the Nasdaq-100 / E*TRADE / Alpaca equivalents) returns the same
  status the UX shows. Per-login discipline is preserved.

## In-scope sources

Yahoo, Nasdaq (Nasdaq-100 universe and quotes), E*TRADE, and Alpaca
are unconditionally in scope. Public.com is included where its
adapter's legs allow; otherwise it receives an explicit tracked
deferral, not a silent skip.

## Honest states

- **Never run** — a source with no completed run shows "never run"
  in the UX and in Copilot answers. It is a state, not an error.
- **Stale** — a persisted copy older than its cadence expectation is
  labelled with its age wherever it is served. Staleness is
  displayed, never hidden, and never papered over with a silent
  refetch.
- **Failed run** — a failed pull records the failure as the run's
  outcome (see the run-record rules in
  [publish-stage.md](publish-stage.md)); the previous good copy
  remains the served copy, labelled with its real age.

## Risks the design carries

Provider rate limits on scheduled pulls: cadence defaults are
conservative and per-source knobs come from configuration, not code.
Stored-copy staleness misread as live data: mitigated by the
mandatory age labelling above — a surface that serves the copy
without its age is a defect against this contract.
