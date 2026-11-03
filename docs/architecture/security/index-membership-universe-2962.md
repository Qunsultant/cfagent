# Extended index universe (#2962)

Follow-up to #1852 (live index-membership port) and #1980
(stored snapshots + scheduled refresh). Same rules, no new
pipeline, no second membership system: snapshot-dated,
ticker-normalized, stale refused/flagged, no hardcoded member
lists, no licensed feed.

## New keys and routing

| Key | Primary adapter | Source |
| --- | --- | --- |
| `sp400` | Wikipedia | `List of S&P 400 companies` table |
| `russell3000` | Holdings (union) | IWB + IWM holdings files |
| `sector-energy` … `sector-real-estate` (11) | Wikipedia (filtered) | S&P 500 table, GICS Sector column |
| `sp400` cross-check | Holdings | MDY |
| sector cross-checks | Holdings | XLE, XLB, XLI, XLY, XLP, XLV, XLF, XLK, XLC, XLU, XLRE |

Refresh groups (`src/services/indexListJob.ts`): the Wikipedia
weekly goal (Sunday 04:00 UTC, live) gains `sp400` + the 11
sector keys; the holdings daily goal (03:00 UTC, DISABLED —
no holdings fetcher binding exists in code) gains
`russell3000`. The sector keys share one S&P 500 page fetch
per adapter instance (per-instance memo), so the weekly job
fetches 5 Wikipedia pages for 16 keys, not 16.

## S&P 400

Wikipedia `List of S&P 400 companies`, verified live
2026-11-03: columns Symbol | Security | GICS Sector | GICS
Sub-Industry | Headquarters Location | SEC filings — the
S&P 500 layout, so it shares its column indices. MDY (SPDR
S&P MidCap 400) is wired as the holdings-adapter cross-check
ticker; like every holdings file in this codebase, its live
file shape is fixture-verified through the tolerant CSV
parser, not live-verified (see the carried item below).

## Russell 3000: union construction

Russell 3000 IS Russell 1000 + Russell 2000 by definition:
the top 1,000 + the next 2,000 of the 3,000 largest US
stocks (FTSE Russell methodology summaries, verified
2026-11-03). The holdings adapter therefore serves
`russell3000` as the union of the IWB and IWM holdings
files — it is not mapped to IWV, which is the cross-check,
not the primary (`crossCheckRussell3000Union`).

Union rules, all enforced in code:

- Both legs are fetched; a failing leg fails the whole
  union — a partial union is never served.
- Dedup by normalized symbol; on an overlap the Russell
  1000 (IWB) record wins. The legs are disjoint by
  construction, so an overlap is a data anomaly, not a
  second member.
- Snapshot date = the OLDER leg's as-of date, so
  staleness is governed by the stalest leg under the
  3-day holdings budget.
- The source label names BOTH legs' as-of dates
  (`IWB as of X, IWM as of Y`) and says NOT the official
  index list, so any vintage mix is visible.

Reconstitution effect: Russell indexes reconstituted
annually in June historically (last Friday in June); FTSE
Russell announced a move to semi-annual reconstitution
from late 2026. Around any reconstitution the two legs'
files update on different days. The union rule handles
this without a special case: a mixed-vintage union is
refused as stale once the older leg exceeds the 3-day
budget, and within the budget the label exposes the mix.
Known limitation, stated not hidden: a union whose legs
are both within budget but from different vintages is
served with the mix labelled, not refused.

## Sectors: the definition

The 11 GICS sectors, named exactly as Wikipedia's GICS
Sector column writes them: Energy, Materials,
Industrials, Consumer Discretionary, Consumer Staples,
Health Care, Financials, Information Technology,
Communication Services, Utilities, Real Estate. A sector
universe = the S&P 500 members whose GICS Sector cell
maps to that sector (case-insensitive match; unmapped
cells match no sector and appear in no sector universe).
No sector list is invented and no other taxonomy is
used. The Select Sector SPDR ticker per sector (XLE,
XLB, XLI, XLY, XLP, XLV, XLF, XLK, XLC, XLU, XLRE) is
wired as the holdings-adapter cross-check key; the
cross-check is fixture-verified, and State Street's
published files are XLSX-distributed, so live SPDR shape
verification waits on the same holdings-fetcher binding
as everything else in this section.

## Staleness (unchanged from #1852)

Wikipedia family: 10-day cap. Holdings family
(including the Russell 3000 union): 3-day budget.
`requireFresh` refuses stale lists loudly;
`withStalenessFlag` labels them. Stored lists follow
the same budgets through the #1980 consumer.

## Carried items (named, never implied live)

- The holdings daily goal ships DISABLED (unchanged
  #1980 precedent): no ETF holdings-file fetcher binding
  exists in code, so `russell3000`'s stored refresh — like
  `russell2000`'s and `russell1000`'s — is not live until
  that binding lands. No production goals are created by
  this slice.
- Live holdings-file shapes (iShares IWB/IWM/IWV and
  State Street MDY/SPDR files) are fixture-verified only;
  live proof waits on the holdings fetcher binding.
- The weekly Wikipedia refresh (including `sp400` and
  the sector keys) is live on the existing Sunday 04:00
  UTC goal; its first post-merge run is the live proof
  for the new Wikipedia-family keys.
