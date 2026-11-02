# Stored index-list snapshots + scheduled refresh (#1980)

Follow-up to #1852 (live index-membership port, no storage, no
schedule, no production consumer). This slice adds the stored
side on the #1236 feed seam's idiom — not a second feed system,
not a second aggregation pipeline.

## What is stored

One artifact per (index, snapshotDate) in `mas_index_lists`:

- `index`: one of `dow`, `sp500`, `sp100`, `nasdaq100`,
  `russell2000`, `russell1000` (all six covered).
- `symbols`: the member list from the #1852 adapter that owns the
  index (Wikipedia tables for the four Wikipedia indices; ETF
  holdings files primary for Russell 2000 via IWM and Russell
  1000 via IWB, with SPY / QQQ / DIA / OEF as cross-checks).
- `source` + `sourceLabel` on every artifact. Holdings-derived
  lists are labelled holdings-derived, never official; Wikipedia
  tables carry the CC BY-SA attribution. No licensed feed, no
  hardcoded symbol lists in code, no point-in-time historical
  membership in this slice (same constraints as #1852).

## Port and adapters (port-first, conformance before consumers)

- Port: `src/data/indexListPorts.ts` (`IndexListStore`: async
  `store` + `latest`, keep-per-index prune, default 10).
- Boundary (#290): the #1852 module was previously imported
  only by its test file and was NOT on the trading barrel, so
  this slice adds `export * from "./indexMembership"` to
  `src/trading/index.ts` and imports trading ONLY through the
  barrel everywhere outside `src/trading/` (producer, job,
  consumer, data adapters, ScheduledAgent branch). No name
  collisions were introduced (verified by grep + the boundary
  test itself).
- Adapters, one conformance suite
  (`tests/index_list_snapshots_1980.test.ts`) across all three:
  `src/data/inMemoryIndexListAdapter.ts` (test double),
  `src/data/doSqliteIndexListAdapter.ts` (DO SQLite, feed-seam
  shape: CREATE TABLE IF NOT EXISTS + single-line statements),
  `src/data/d1IndexListAdapter.ts` (D1, raw prepare/bind — the
  `d1QuoteSourceAdapter` pattern, not Drizzle).
- Why a sibling store, not an extension of the feed-snapshot
  store: feed artifacts are per-(user, symbol) options snapshots;
  index lists are deployment-global per-index datasets. Keying
  them by userLogin would duplicate one shared list per user.

## Producer and job (honesty rules)

- Producer: `src/services/indexListProducer.ts`. Fetchers are
  injected through the #1852 service — the producer never
  touches the network. A failed fetch is never stored; a
  zero-member result is refused, not stored. Job results carry
  descriptors (artifact id, index, snapshotDate, source,
  memberCount), NOT symbol bytes.
- Job: `src/services/indexListJob.ts`. One artifact per index;
  all-failed throws so the job reads failed; partial completes
  with failures named. Index groups: Wikipedia
  (`dow`, `sp500`, `sp100`, `nasdaq100`) and holdings
  (`russell2000`, `russell1000`).

## Consumer (stored path alongside the live path)

- Resolver/consumer: `src/services/indexListConsumer.ts`.
  `resolveStoredIndexList` returns `{ hit, stale }` or
  `{ missing }` — a missing list is a named outcome, never a
  silent live fallback. `requireFreshStored` throws
  `StaleIndexMembershipError` on a stale list;
  `withStalenessFlagStored` labels it instead. Freshness
  budgets are the #1852 defaults (Wikipedia 10 days, holdings
  3 days) unless the caller passes `maxAgeDays`.
- `screenStoredIndexList` resolves the latest stored list,
  requires it fresh, and screens it as `opts.symbols` through
  the existing pipeline unchanged. The #1852 live path
  (`screenIndexMembers`) is untouched: no endpoint removed, no
  screener/quote/provider behavior change beyond accepting
  stored lists as input. No new HTTP route is added in this
  slice; the resolver is the route (index → latest fresh stored
  list), and a future slice can expose it over HTTP.

## Refresh goals (existing goals system, existing tick)

- `DEFAULT_SCHEDULES` (`src/schedule.ts`) gains two goals, both
  on the existing */30 tick; no new scheduler, no new wrangler
  cron triggers. Operations are catalogued in
  `src/orchestrate.ts` (`index` agent, `SCHEDULED_AGENT`
  binding) so `addGoal` accepts them, and
  `SCHEDULED_GOAL_IDS_INVENTORY`
  (`src/services/scheduleSystems.ts`) is updated with both ids.
- `index-refresh-wikipedia`: Sundays 04:00 UTC, enabled. Its
  production path in `ScheduledAgent.onCron` is live: D1 store
  via `AGENT_DB` + global fetch over the adapter's own
  Wikipedia URLs. `AGENT_DB` unbound ⇒ visible tick error,
  goal stays due (the resource-goal pattern).
- `index-refresh-holdings`: daily 03:00 UTC, ships DISABLED
  (the `daily-social-post` precedent). No ETF holdings-file
  fetcher binding exists in code — no holdings URL is
  established anywhere in the repo, and none is invented here
  — so enabling it would tick-error daily. The operator
  enables it via Settings → Scheduled goals once the holdings
  fetcher is bound (bind `fetchCsv` through
  `createIndexListRefreshExecutor` / `ScheduledAgent`
  `indexRefreshExecutor`, or wire the production branch the
  way the Wikipedia branch is wired). Forced `triggerGoal`
  exercises it before then, through an injected executor.

## Operator activation (running deployment)

`DEFAULT_SCHEDULES` seeds fresh deployments only. On the running
deployment, add both goals via Settings → Scheduled goals (or
the schedule dashboard API), enable the holdings goal only
after its fetcher is bound, and confirm the first Wikipedia
refresh lands a `mas_index_lists` row per Wikipedia index
before relying on the stored consumer. No goals are created in
production by this slice, and no production switch values are
set by it.
