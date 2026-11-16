# #3667 universe integration — survey (2026-11-09, main 139cc1b)

## Red-main state (stop-the-line, resolved by the owner, not by CDO)
- Red was: neutrality pin, lifecycle doc rows (CFO #3862 1 row; CDO #3864 +4 rows;
  tip e8803cc shard 4/4 + Test & Build FAILURE on push run).
- Owner (Mubasher Ahmed) fixed by NEUTRALIZING the doc text: #3868 (CFO row),
  #3872 (CDO Feed jobs row: source names -> "per configured market-data source";
  CFO row -> "no silent fallback to a single broker"). No baseline rows added.
- Pin on tip 139cc1b: 5/5 PASS locally. Push-run checks: Test & Build SUCCESS,
  shard 3/4 SUCCESS, shards 1/2/4 still in_progress at last read, zero failures.
- #3864 S15 amendment still owed (its PASS rested on the MQ short-circuit read) —
  correction comment, not a reopening; the doc content itself now differs from
  what the S15 described (owner-neutralized row text).

## Universe machinery (all pre-existing, reuse only)
- IndexId (src/trading/indexMembership.ts): dow, sp500, sp100, nasdaq100,
  russell2000, russell1000, sp400, russell3000 + 11 sector-* (19 keys).
- IndexMembershipPort (#1852): Wikipedia + ETF-holdings adapters, snapshot-dated,
  source-labelled; NO hardcoded lists anywhere (port honesty rule).
- IndexListStore (#1980): D1 / DO-SQLite / in-memory adapters (src/data/);
  refresh job is the only writer.
- Refresh (src/services/indexListJob.ts INDEX_REFRESH_INDICES):
  wikipedia group [dow, sp500, sp100, nasdaq100, sp400, +11 sectors] — LIVE path;
  holdings group [russell2000, russell1000, russell3000] — goal ships DISABLED
  (no holdings fetcher binding; the Russell stored lists are a carried item
  until the binding lands — CISO/#2962 territory, not this lane's slice).

## The workflow seam (where "integrated into the workflow" happens)
- Feed stage = the ONLY place universes are chosen: buildFeedJobRegistry
  (src/services/feedJobs.ts) registers per source x universe:
  nasdaq100 x {yahoo quotes, yahoo fundamentals, alpaca, etrade, public quotes}
  + sp100 x {yahoo quotes} (the #3535 precedent: "adding SP100 was just a
  registry definition").
- Enrich derives 1:1 from feed quotes jobs (universe inherited);
  analyze derives 1:1 from enrich. Screen reads stored lists via
  indexListConsumer.resolveStoredIndexList / screenStoredIndexList (any IndexId).
- => One universe slice = ONE Yahoo quotes registry definition (+ exported job
  id constant). Enrich + analyze + panel + Copilot + outcomes inherit it
  through the existing derivations. No new fetcher, no copied list, no new UI.

## Slice order proposed (Wikipedia family first — its stored lists refresh live)
1. sp500 — flagship gap: refreshed + stored, screenable, but no feed/enrich/
   analyze chain. Slice 1.
2. dow, 3. sp400 — same shape, one definition each.
4. Sectors x11 — one slice or per-sector per the user's one-at-a-time rule
   (discuss after slice 1).
5. Russell family — BLOCKED on the holdings fetcher binding (not CDO's to
   build unilaterally); named, not started.

## Gate notes for every slice
- Run tests/neutrality_census_3525.test.ts locally (registry code names
  providers in src/services — INTEGRATION rows exist for feedJobs.ts; a new
  job-id string is inside the same file, counts may move: verify).
- Count-sensitive pins: feed/enrich/analyze registry derivations fan out —
  grep for length/count assertions over registry lists before shipping.
- Post-merge verification reads the PUSH run deduped, never the MQ run alone.
