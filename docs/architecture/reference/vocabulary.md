# The whole-set vocabulary (#5515)

One list per axis, one reader, one refusal language. `config/vocabulary.json`
holds the values; [`src/config/vocabulary.ts`](../../../src/config/vocabulary.ts)
validates it and answers every question a surface may ask. A new provider,
dataset, universe, sector, exchange, broker, asset or mode is **data** — one
entry — never an engine code change.

## The axes and their values today

| Axis | Values | Notes |
|---|---|---|
| `provider` | `etrade`, `public`, `yahoo`, `nasdaq`, `alpaca` | Each carries `kind: broker \| pure`. `nasdaq` is a **provider** (it serves the listings dataset) and is never a universe. |
| `dataset` | `quotes`, `optionsChains`, `screenUniverse`, `historicalBars`, `fundamentals`, `news` | The capability vocabulary: each entry carries the `capability` it delivers, and the spellings the feed path stores under are aliases (`technicals` → `historicalBars`, `sentiment` → `news`, `options-chains` → `optionsChains`, `universe` → `screenUniverse`). The provider × dataset matrix is data in the same file (#5494). |
| `universe` | `nasdaq100`, `sp100`, `sp500`, `russell2000`, `russell1000`, `russell3000`, `etf`, `lev_etf`, `all`, `dow`, `sp400` | The screener sets and the stored index lists in **one** id space. Aliases carry today's spellings (`NASDAQ100` → `nasdaq100`). `TECH` is absent. |
| `sector` | the 11 GICS `sector-*` ids | The single home for sectors **and** for sector-as-list universes: `universeValues()` derives one `sector-*` universe per sector, so a sector cannot exist in one list and be missing in the other. `TECH` = `sector-information-technology`. |
| `exchange` | `all`, `nasdaq`, `nyse`, `amex` | First-class run axis; the screen filter's four values, alias-preserving. |
| `broker` | `etrade`, `alpaca`, `public`, `tastytrade` | Carries the modes each broker offers, so `public` + `paper` refuses as a pair. |
| `asset` | `equity`, `options` | Open to forex/crypto/futures by data. |
| `mode` | `paper`, `live` | |

Defaults are externalized in the same file: `broker=alpaca`, `mode=paper`,
`asset=equity`, `universe=nasdaq100`.

## A job declares a subset

`resolveJobSubset(declared)` answers what a job actually runs against:

- A **declared** value resolves through `resolveValue`: an id or an alias in,
  the canonical id out. A bad value refuses **by name**, listing the axis's
  known values.
- An **absent** axis with an externalized default fills in that default.
- An **absent** axis without a default stays undeclared — a subset names what
  it needs, and nothing is invented. A consumer that requires an axis asks for
  it with `requireAxis`, which refuses by name (`missingDefault`).
- A broker/mode pair the broker does not offer refuses as `unsupportedPair`
  (e.g. `public` + `paper`).

## The provider × dataset matrix (#5494)

Which provider serves which dataset is DATA, in the same file:

```json
"providerDatasets": [
  { "provider": "…", "dataset": "quotes", "batch": true },
  { "provider": "…", "dataset": "optionsChains" }
]
```

One row per served pair; `batch` marks the pairs the feed pulls in one batch
call. `resolveProviderDataset(provider, dataset)` is the **one reader**:

- The provider and dataset resolve through their axes (id or alias in,
  canonical id out), so a caller may ask with the spelling it stores under.
- A served pair answers with the `capability` the dataset delivers (owned by
  the dataset entry, never restated by the matrix) and its `batch` flag.
- The `declaredDataset` on the answer is the caller's spelling, which stays the
  artifact/store key — canonicalising a lookup never renames a stored dataset.
- An **unserved pair refuses by name** with
  `REFUSAL_VOCABULARY_UNSUPPORTED_PAIR`, listing what that provider does serve.
  It never resolves to another provider that happens to serve the dataset
  (never broker-for-broker, #5515).

The feed path is its first consumer: provider selection in
`src/services/feedProviderWiring.ts` is a lookup against this matrix plus a
builder registry (how a provider is constructed in a residency), never a
`switch` on the provider id; the batch-quotes requirement is the pair's
`batch` flag, not a duck-typed method read.

## Conflations are declared, not commented

A value that used to be accepted on the wrong axis is refused with a pointer:

| Asked | Refusal | Pointer |
|---|---|---|
| `universe=TECH` | `REFUSAL_VOCABULARY_NOT_A_VALUE` | `sector=sector-information-technology` |
| `universe=nasdaq` | `REFUSAL_VOCABULARY_NOT_A_VALUE` | `provider=nasdaq` |

The message is the same sentence every surface shows — the API and a picker
never disagree about why a value is wrong.

## Refusal codes

| Code | Meaning |
|---|---|
| `REFUSAL_VOCABULARY_UNKNOWN_AXIS` | The axis does not exist. |
| `REFUSAL_VOCABULARY_UNKNOWN_VALUE` | The value is not on that axis (message lists the known ones). |
| `REFUSAL_VOCABULARY_NOT_A_VALUE` | A declared conflation: the value belongs to another axis (pointer given). |
| `REFUSAL_VOCABULARY_UNSUPPORTED_PAIR` | Broker/mode or provider/dataset combination not offered (the message names both axes). |
| `REFUSAL_VOCABULARY_MISSING_DEFAULT` | A consumer required an axis the job did not declare and no default exists. |

## Adding a value

1. Add one entry to the axis in `config/vocabulary.json` (`id`, `label`, and
1. Add one entry to the axis in `config/vocabulary.json` (`id`, `label`, and
   `aliases` if a legacy spelling must keep resolving). A dataset entry also
   declares the `capability` it delivers.
2. To make an existing provider serve a dataset, add one `providerDatasets`
   row — no code change anywhere. The feed path builds any pair whose provider
   the residency can construct; a provider the engine cannot construct yet
   resolves to a named refusal, never a substitute.
3. Run the pins: `npx vitest run tests/vocabulary_5515.test.ts
   tests/feed_provider_matrix_5494.test.ts`. A duplicate id, an alias that
   collides inside its axis, an unknown axis, a default naming a missing value,
   a conflation that shadows a real value, a matrix row naming a provider or
   dataset the axes do not hold, or the same pair twice all throw on read — the
   previous registry stays in force.
4. No component, picker, route or resolver changes — the definition route's
   pickers and the parameter binder read the registry at call time (the
   `setVocabulary` seam is the pin for that).

## A definition declares axes, a parameter names one (#5493)

`JobDefinitionSpec.axes` declares the axes a family runs on — the feed family
declares `{ dataset: "quotes", universe: "nasdaq100" }` — and is resolved
through this reader on every read. An unknown axis refuses by name, and an
unknown or conflated value refuses with the code below; the spec stores the
canonical id, never the spelling a caller happened to use.

A parameter whose value names an axis declares it (`{ name: "universe", axis:
"universe" }`), so the binder resolves it the same way: an alias binds
canonically, an unknown value refuses by name, and a conflated one refuses with
its pointer. A `multi-select` parameter declares one axis for each of its
values; a `list` carries free strings (shard keys). `universe` resolves the
sector-as-list universes too, so a feed run may name `sector-energy` without a
second list.

Refusals carry the code in the message (`REFUSAL_VOCABULARY_UNKNOWN_VALUE`,
`…_NOT_A_VALUE`, `…_UNSUPPORTED_PAIR`), so a route's 400 and a picker's
explanation say the same thing. A provider set declares `capabilityFrom:
"dataset"`: a provider that declares capabilities and lacks the dataset refuses
as a pair, while a provider the declaration projection has not learned yet (a
data-only addition) is left to the run-time registry
[Qunsultant/cfagent#5494](https://github.com/Qunsultant/cfagent/issues/5494).

## Where this is consumed

- **Chat / NLQ** — [Qunsultant/cfagent#5500](https://github.com/Qunsultant/cfagent/issues/5500), the data-provider axis from a chat turn.
- **UX pickers** — [Qunsultant/cfagent#5965](https://github.com/Qunsultant/cfagent/issues/5965), every axis picker reads this reader instead of its own list.
- **Engine consumers** — the feed path (#5494: `resolveProviderDataset`), the feed spec (#5493: `JobDefinitionSpec.axes` and axis-backed parameters, `src/config/jobDefinitionCatalog.ts` + `src/services/jobDefinitionParamBinders.ts`), the generic binder (#5496), the universe step (#5499) and the defaults change.

Until the remaining consumers land, the existing constants (`DATA_PROVIDER_IDS`,
`UNIVERSES`, `SECTOR_IDS`, the exchange filter) remain in force and the pins
prove the registry holds exactly today's values — so nothing resolves
differently while the consumers move.
