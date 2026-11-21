### Feed-family non-index universe coverage (#5956)

- TECH / ETF / LEV_ETF commands resolve and screen on the generic chain: a third
  listings-derived adapter of the #1852 port family runs the same selectors the
  bespoke feed runs over the live listings directory and stores the result as a
  snapshot-dated index list (source `listings`, 10-day table freshness budget).
- `IndexId` gains `tech | etf | lev_etf`; the refresh gains the `listings` group
  and the `index.refresh_listings` operation, catalogued and executable (forced
  trigger / operator-added goal); the built-in weekly goal entry is a follow-up
  activation, not this slice. The listings adapter is bound for real at all three
  host sites (workflow residency, scheduled-tasks pipeline, scheduled-agent
  executor).
- The 6b1 test's ETF-refusal case is retired (that coverage is this slice) and
  replaced by an unknown-universe refusal test; unknown universes still refuse
  by name before any fetch.
