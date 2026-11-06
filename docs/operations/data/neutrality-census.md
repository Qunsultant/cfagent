# Broker/provider neutrality census

**Status:** Survey record · 2026-11-06 · Traces to #3525 (under
#1069), owner directive 2026-11-06 · Census base: origin/main @
bd81ecd7 · #CDO-mha7

The platform is broker-neutral and provider-neutral: it is not any
one broker's system. This doc records the census that measured how
far the tree was from that position, the disposition model it used,
and the enforcement design. It is the survey record — the per-file
disposition table (942 file×term rows) lives in the #3525 issue
record, not here.

## Method

`git grep` against the origin/main tree object (so the census
reflects main exactly), case-insensitive per-term patterns for
sixteen broker/provider terms, over `src/`, `docs/`,
`wrangler.jsonc`, `README.md`, and the corpus seed manifest. Counts
are matching lines (a line with two mentions counts once), grouped
by file × term. `tests/`, `CHANGELOG.md`, and landed changelog
fragments were counted separately and excluded from the table:
tests mirror the code they test, and changelogs are historical
record by construction.

## The disposition model

Every hit is dispositioned into exactly one class:

| Disposition | Meaning | Action |
| --- | --- | --- |
| PLATFORM | Platform-layer mention: user-facing copy, platform service naming, defaults that name one provider as the platform's own, live docs presenting the platform by a provider, the corpus | **Neutralize** |
| INTEGRATION | The provider's own adapter, client, OAuth, routes, panels, config; registries whose job is enumerating providers; data-bearing identifiers (env keys, storage keys, route paths, shared type names) | Keep — behind the ports |
| HISTORICAL | Dated records: surveys, scans, plans, assessments, ADRs | Keep — a record is not live copy |
| NOT-PROVIDER | The term used in a non-provider sense ("Nasdaq" the exchange/index) | No action |
| FALSE-POSITIVE | Not a provider mention at all (SVG `<polygon>`, "fidelity" = precision, listed-company names, substring accidents) | No action |

The load-bearing judgment: **data-bearing names are integration.**
Renaming an env key, a token storage key, a route path, or a shared
type is a migration with a read-compatibility story, not a copy
edit, and no copy slice may sweep one in. Symmetrically,
provider-specific panels are integration even though they are
user-facing — an E*TRADE panel naming E*TRADE is honest; what is
platform is its *placement as a default*, which the census assigns
to the defaults slice.

## Counts

7,787 matching lines across 576 files:

| Disposition | Lines | Rows | Files |
| --- | ---: | ---: | ---: |
| PLATFORM (the neutralization target) | 1,079 | 200 | 125 |
| INTEGRATION | 5,822 | 546 | 372 |
| HISTORICAL | 565 | 96 | — |
| NOT-PROVIDER | 289 | 72 | — |
| FALSE-POSITIVE | 32 | 28 | — |

By term: etrade 5,516 · alpaca 989 · yahoo 853 · nasdaq 343 (only
54 provider-real; the rest is the exchange/index) · public.com 42 ·
fidelity 21 (1 real) · schwab 5 · ibkr 5 · polygon 6 (1 real) ·
tastytrade 3 · robinhood 2 (0 real) · tradier 1 · thinkorswim 1 ·
webull / finnhub / twelvedata 0.

## Slice plan

| Slice | Scope |
| --- | --- |
| S1 · Corpus | Neutral order-types document replaces the broker-branded seed entry; the two regulator documents ingested hash-verified; the single-company filing entry dispositioned. **Landed** (manifest, PR #3528); uploads in progress. Also completes the corpus leg of #1169's probe |
| S2 · Client copy & labels | User-facing strings in generic client surfaces (~25 files) |
| S3 · Defaults & onboarding | First-run connect flow, hub default provider, the generic order ticket's provider-typed foundations (~12 files) |
| S4 · Platform services & agent descriptions | Platform knowledge base and contract prose (3 files; the platform knowledge service is the single largest PLATFORM file) |
| S5 · Live docs | Live documentation presenting the platform by provider (~80 files) |
| S6 · Census pin | The shrink-only pin below — lands last, or it fails on the un-neutralized remainder |

One accuracy flag the census raised beyond neutrality: the landing
page (`src/client/landing.ts`) presents six brokers by name —
E*TRADE, Schwab, IBKR, Alpaca, Fidelity, and Tradier — of which
four (Schwab, IBKR, Fidelity, Tradier) have no integration in the
tree. Whether their presentation claims connected status is an
owner decision, surfaced on #3525 — not silently fixed in a copy
slice.

## The shrink-only census pin (S6 design)

In the style of the platform's existing shrink-only census pins: a
checked-in **allow-list** — seeded from this census's INTEGRATION
rows — of the files permitted to name a broker or provider. The pin
fails on any provider mention outside the allow-list, so the
neutralized state cannot silently regress: a new platform-layer
mention is a build failure, and a new integration file must be
added to the allow-list deliberately, in the open. The pin must
encode the NOT-PROVIDER distinction (an index mention is not a
provider mention) or it will false-positive on the exchange/index
sense of "Nasdaq". The allow-list only ever shrinks or is amended
by explicit, reviewed change — that asymmetry is the enforcement.
