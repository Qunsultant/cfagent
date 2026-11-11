# #4065: options feed — chains as a registered feed job with a persisted dataset

## Decision (a): register options-chains as a feed job

The survey's open unknown is settled on evidence: the chain source CAN
execute in workflow residency. The #3941 proof (PR #4056) constructs the
same broker clients (Alpaca env keys; E*TRADE/Public session tokens)
inside the residency from env through `createCaptureWiredFeedProvider`,
and this slice's runner builds its provider the same way, through the
same `providerFor` seam. The live client object itself never crosses a
residency boundary — the J-engine constructs deps inside the residency
from env, exactly like the feed provider. So chains are a feed job with
capture wiring and a persisted dataset, and `chainFetch` consumes it
through the dataset-backed source.

## What changed

- `src/data/feedDatasetPorts.ts`: `FeedOptionsChainRow` (one row per
  symbol: eligible expiries, one chain per eligible expiry, fetch
  errors); `chains?` on `FeedDatasetArtifact`; `feedDatasetRowCount`
  counts chain rows; `FeedDatasetUniverse` gains a `symbols` variant
  for explicit-symbol runs (an options screen's underlyings need not
  belong to any stored index list). Readers that need a stored-list
  universe (quotes / technicals / sentiment) treat a symbols-kind
  artifact as unusable, never as an index run.
- `src/services/feedJobs.ts`: three chains jobs
  (`etrade/alpaca/public-options-chains`, dataset `options-chains`,
  parameterized on the #3930 idiom; no Yahoo chains job by design);
  `runFeedOptionsChainsJob` (DTE window + per-symbol expiration cap
  mirroring the screener's fetch; provenance verified per envelope;
  a run that fetched nothing is FAILED; per-symbol failures named);
  two new codes (`FEED_PROVIDER_OPTIONS_CHAINS_UNSUPPORTED`,
  `FEED_NO_CHAINS_RETURNED`); explicit-symbol membership rule (all
  members of the stored list ⇒ index-kind subset; any non-member ⇒
  symbols-kind, used as-is, never silently filtered).
- `src/services/feedPipelineJobs.ts`: step dispatch for the
  `options-chains` dataset; the fetch window rides the step params.
- `src/services/feedOptionsChainSource.ts` (new): the dataset-backed
  `OptionChainSource` (chain→expiry matching by the chain's
  `selectedExpiry` stamp; positional fallback only on complete rows;
  unscoped requests answer the nearest expiry's chain) plus the
  `readPersistedOptionsChains` read.
- `src/services/enrichJobs.ts`: `resolveFeedInputArtifact` matches a
  symbols-kind artifact against no universe filter (an undefined
  filter still matches it).
- Registry pins + census: the thirteen tests that pin the feed-job
  registry / plane totals / per-provider lists move +3 (11→14 feed
  jobs; plane 25→28 / 46→49 / 39→42 / 18→21 / 32→35); the
  neutrality census baselines the seven identifier raises as
  INTEGRATION (the new jobs' own id/label/sourceId/alias lines)
  and neutralizes the prose brand mentions instead (neutral
  `BrokerOptionChain` / `BrokerOptionExpireDate` aliases in the
  dataset definition and the runner), so no new census row is
  created.
- `tests/feed_options_chains_4065.test.ts` (new, 23 tests): registry +
  factory honesty; runner (universe kinds, DTE window, cap, empty
  slice, missing/partial/failed, mismatch refusal); dataset-source
  `fetchChains` equivalence; the same Alpaca pull in workflow and
  host residency with identical dataset output and provenance;
  `FEED_JOB_NOT_CONFIGURED` still fires by name.

## What did NOT change

No behaviour change to enrich/screen/risk/persistCanonicalResults/
shapeReport/deliver. Composition (the feed step before `chainFetch`
in the options workflow) lands with the #3551 onboarding / #4068
routing, not this slice; direct entries keep the live source.

## Notes

- The feed job does NOT do the screener's unscoped-chain fallback
  for a symbol with no expirations: an unscoped chain would land in
  the dataset without its expiry in the row's `expiries`. Such a
  symbol is missing, named in `missingSymbols`.
- A chain naming a different expiry than requested is refused, never
  stored under the wrong expiry. A chain with no `selectedExpiry`
  stamp gets the request's expiry on a copy (the request is the
  provenance); the provider's object is never mutated.
