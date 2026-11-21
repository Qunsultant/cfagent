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
| `dataset` | `quotes`, `optionsChains`, `screenUniverse`, `historicalBars`, `fundamentals`, `news` | The capability vocabulary. The provider × dataset matrix becomes data in the consumer slice. |
| `universe` | `nasdaq100`, `sp100`, `sp500`, `russell2000`, `etf`, `lev_etf`, `all`, `dow`, `sp400` | The screener sets and the stored index lists in **one** id space. Aliases carry today's spellings (`NASDAQ100` → `nasdaq100`). `TECH` is absent. |
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
| `REFUSAL_VOCABULARY_UNSUPPORTED_PAIR` | Broker/mode (later, provider/dataset) combination not offered. |
| `REFUSAL_VOCABULARY_MISSING_DEFAULT` | A consumer required an axis the job did not declare and no default exists. |

## Adding a value

1. Add one entry to the axis in `config/vocabulary.json` (`id`, `label`, and
   `aliases` if a legacy spelling must keep resolving).
2. Run the pins: `npx vitest run tests/vocabulary_5515.test.ts`. A duplicate id,
   an alias that collides inside its axis, an unknown axis, a default naming a
   missing value, or a conflation that shadows a real value all throw on read —
   the previous registry stays in force.
3. No component, picker, route or resolver changes.

## Where this is consumed

- **Chat / NLQ** — [Qunsultant/cfagent#5500](https://github.com/Qunsultant/cfagent/issues/5500), the data-provider axis from a chat turn.
- **UX pickers** — [Qunsultant/cfagent#5965](https://github.com/Qunsultant/cfagent/issues/5965), every axis picker reads this reader instead of its own list.
- **Engine consumers** — the feed spec (#5493), capability resolution (#5494), the generic binder (#5496), the universe step (#5499) and the defaults change.

Until those land, the existing constants (`DATA_PROVIDER_IDS`, `UNIVERSES`,
`SECTOR_IDS`, the exchange filter) remain in force and the pins prove the
registry holds exactly today's values — so nothing resolves differently while
the consumers move.
