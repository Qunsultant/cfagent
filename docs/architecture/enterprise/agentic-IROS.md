# Agentic IROS Architecture: validated research + technology needs

**Status:** Architecture record, 2026-11-18. Issue: #5520 (sub-issue of #5272).
**Research record:** public-source research run 2026-11-18 (11 questions, Q1–Q11); this
document is its synthesis. Every load-bearing claim below cites the public source URL
from that research. Nothing in this document is asserted beyond the research record or
a named existing repo document.
**Vocabulary:** the #5515 whole-set axes (providers, datasets, universes, sectors,
exchanges, brokers, assets). No new vocabulary is introduced here. Environment is folded
into mode (owner decision, #5515 comment 6986193742): there is no separate environment axis.
**Governing neighbours (linked, never duplicated):** the IROS target DAG and subsystem
analysis live in [`iros-system-analysis.md`](iros-system-analysis.md) (owned by #1904);
the standing ruling — one staged pipeline every screen family runs through
(`schedule → queues → feed → gather → store → serve → deliver`) — lives in
[`../business/screener-workflow.md`](../business/screener-workflow.md) §1. Copilot/autopilot
surfaces live in [`../agentic/copilot-autopilot.md`](../agentic/copilot-autopilot.md),
[`../agentic/autopilot-capabilities.md`](../agentic/autopilot-capabilities.md), and
[`../agentic/stockcopilot-RSI.md`](../agentic/stockcopilot-RSI.md). This document does not
re-argue the target DAG, and does not settle the unresolved question in
[`../survey/2380-survey-draft.md`](../survey/2380-survey-draft.md) §8 (whether the admin
panel is the IROS target architecture).

## 0. Evidence basis — read this first

- The research's confidence basis is predominantly web-search results/snippets read
  2026-11-18, plus three pages read in full text (Nasdaq Trader Symbol Directory
  Definitions, Temporal Cloud security model, Unleash AGPLv3 announcement). **No live
  browser verification was performed**, and no vendor developer portal was opened
  interactively. Findings acted on (prices, entitlements, live availability) must be
  re-verified live before use.
- License claims (§9) were mostly established from secondary comparisons citing project
  repos, plus a small number of directly-read license texts/headers/announcements. The
  verification key is carried per row: **[L]** license text/header/announcement directly
  read; **[R]** reported by a secondary comparison citing the repo (LICENSE file not
  directly opened — verify before legal reliance); **[U]** unverified/disputed. No license
  statement here is legal advice; verify the LICENSE file at the pinned version before
  distribution or commercial reliance.
- Disagreements between sources are reported as disagreements, not resolved silently.
  Unverified items are collected in §11.3. Verdict language: **VALIDATED** (confirmed in
  sources read), **PARTIALLY VALIDATED** (part confirmed, part not), **INVALIDATED**
  (the claim as stated is contradicted), **UNVERIFIED** (absence of evidence, not proof
  of absence).

## 1. Unified data model

The model: **all sources are data providers**. Universes are membership lists, brokers
are live-quote providers per asset class, complementary providers supply fundamentals /
sentiment / technicals plus delayed quotes, and classifications and venue mappings are
data published by their maintainers. Data is combined per screen where needed (§2).
The research verdicts on the model as originally stated:

| Claim | Verdict |
|---|---|
| Index lists are published as static symbol lists | **INVALIDATED as "static"**; publishers/cadences validated; free official machine-readable forms unconfirmed |
| Brokers provide live quotes via API across all listed asset classes | **PARTIALLY VALIDATED** — equities/ETFs/options yes (entitlement-gated); forex/forex-options largely unconfirmed; crypto broker-dependent |
| Complementary providers give fundamentals + sentiment + technicals + delayed quotes | **PARTIALLY VALIDATED** — Finnhub/Alpha Vantage yes; Polygon sentiment unconfirmed; Yahoo official API **invalidated** |
| Symbol→venue mapping and classifications are published, in stated forms | **VALIDATED** for Nasdaq directories + MIC; **PARTIAL** for GICS distribution form |

### 1.1 Universes are maintained lists, not static lists

**Correction to the pre-research framing:** membership lists change on scheduled
reconstitutions/rebalances and ad hoc on corporate events. A durable system must version
universes by effective date (point-in-time membership), not embed a frozen list.

| Index | Publisher / maintainer | Size | Form | Update cadence | Source |
|---|---|---|---|---|---|
| S&P 500 | S&P Dow Jones Indices | ~500 companies / 503 stocks (multiple share classes) | Factsheet (PDF); no free official full constituent CSV confirmed | Quarterly rebalances + ad-hoc changes on acquisitions/spin-offs | https://freestaffspullzone.b-cdn.net/La%20Ruta%203/SP500%20Index%20SPGlobal%20Oct%202025.pdf |
| Nasdaq-100 | Nasdaq | 100 largest non-financial Nasdaq-listed companies; 101 securities (Alphabet dual class) | Third-party/Wikipedia-derived lists visible; official list not confirmed as free download | Annual reconstitution (December) + quarterly rebalance | https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies |
| Dow Jones Industrial Average | S&P Dow Jones Indices (Averages Committee, with WSJ representation) | 30 stocks, fixed count since 1928, price-weighted | Third-party lists; official S&P DJI constituent page referenced but not opened | Committee-driven, periodic review; changes rare, announced in advance; NVDA replaced INTC and SHW replaced DOW on 2024-11-08 | https://stockmarketwatch.com/indices/dowjones/companies ; https://www.tmgmsea.com/en/academy/trading-academy/what-is-dow-jones ; https://www.quotelinks.com/dow30.html |
| Russell 2000 | FTSE Russell | ~1,958–2,000 constituents | Third-party lists | Annual reconstitution late June; **one source stated a shift to semi-annual (June/December) from 2026 — UNVERIFIED, conflicting** | https://en.wikipedia.org/wiki/Russell_2000 ; https://www.quotelinks.com/russell2000.html |

**Unverified:** whether S&P DJI / Nasdaq / FTSE Russell offer any free machine-readable
constituent feed; the visible free forms are third-party reproductions (Wikipedia, data
vendors), which carry licensing and staleness risk. The repo's stored-list vocabulary
(dow/sp500/sp100/nasdaq100/sp400 + sectors) and the universe step's nasdaq100-only
refusal are tracked separately (#5499); the point-in-time versioning requirement above
is the research-derived constraint on any universe store.

### 1.2 Broker quote coverage by asset class

✓ = confirmed in sources read; (?) = via a general feed, not separately confirmed;
✗ = not confirmed in sources read (absence of evidence, not proof of absence).

| Broker | Equities | ETFs | Equity options | ETF options | Forex | Forex options | Crypto |
|---|---|---|---|---|---|---|---|
| Alpaca | ✓ | ✓ | ✓ | (?) options feed | ✗ | ✗ | ✓ |
| Interactive Brokers | ✓ | ✓ | ✓ | (?) options generally | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Charles Schwab (Trader API) | ✓ | ✓ | ✓ chains | (?) chains | ✗ | ✗ | ✗ |
| E*TRADE / Morgan Stanley | ✓ | ✓ | ✓ chains | (?) chains | ✗ | ✗ | ✗ |
| tastytrade | ✓ | ✓ | ✓ multi-leg | (?) | ✗ | ✗ | Trading via API reported disabled 2026-06-29 "until further notice" (secondary, unverified) |
| Public | ✓ | ✓ | ✓ incl. index options | (?) | ✗ | ✗ | ✓ |

Per-broker evidence (all search-index unless noted):

- **Alpaca.** Market Data API (REST + WebSocket) for US stocks/ETFs, US options, crypto,
  news; free tier IEX-only equities real-time and indicative options feed; Algo Trader Plus
  ($99/mo in secondary summaries — unverified, verify live) for full SIP/OPRA; base
  `https://data.alpaca.markets`. No forex/forex-options API coverage confirmed.
  https://docs.alpaca.markets/docs/about-market-data-api ;
  https://docs.alpaca.markets/us/docs/trading-api-mcp
- **Interactive Brokers.** Official pricing page states free streaming non-consolidated
  Cboe One/IEX data for US stocks/ETFs, free delayed data where available, 100 free
  snapshot quotes/month, real-time requires per-exchange subscriptions, delayed typically
  10–20 minutes, and no delayed US equities quotations for IB LLC clients per regulatory
  requirements. Forex/forex-options/crypto API quote coverage was not confirmed.
  https://investors.interactivebrokers.com/en/index.php?f=14193
- **Charles Schwab Trader API.** REST + WebSocket, quotes, price history (equities/ETFs
  only for bars), option chains, Level 1/Level 2 streaming; successor to TD Ameritrade
  API; base `https://api.schwabapi.com/marketdata/v1`. Official developer.schwab.com
  pages not opened — gap. https://deepwiki.com/go-schwab/trader/4-market-data-api
- **E*TRADE / Morgan Stanley.** Official FAQ describes REST API for accounts, market data
  including quotes and option chains, equity/option order preview/placement, plus Comet
  streaming for order status. Secondary sources state real-time only after a market-data
  agreement, otherwise delayed; OAuth 1.0a. No forex/crypto via REST API confirmed.
  https://developer.etrade.com/support/frequently-asked-questions
- **tastytrade.** Official docs index lists market-data REST (`GET /market-data/by-type`,
  100-symbol batch), DXLink streaming via quote tokens, instruments/option chains,
  multi-leg orders. Sandbox quotes 15-min delayed and crypto-via-API disabled 2026-06-29
  are secondary reports needing primary verification.
  https://developer.tastytrade.com/llms.txt
- **Public.** Official page states free Trading API, real-time pricing data, historical
  data for equities/options, trading stocks/ETFs/options/index options/bonds/crypto,
  fractional and 24/5 equities. No forex confirmed. https://Public.com/api ;
  https://public.com/api/docs/templates/meta-muse

**What distinguishes live vs delayed (validated pattern across brokers):** (1) **feed
scope** — single-exchange (IEX, Cboe One) vs consolidated (SIP for equities, OPRA for
options); (2) **exchange agreements/entitlements** — per-exchange subscriptions and signed
market-data agreements; (3) **fees/tiers** — free tiers are delayed (~10–20 min, or
15 min in sandboxes) or single-exchange; full real-time consolidated data is paid;
(4) **account/regulatory status** (e.g., IBKR's no-delayed-quotes rule for IB LLC
clients). The unified model must therefore carry `feed`, `entitlement`, `delay`, and
`as-of` metadata per quote, not a boolean "live". This is a data-model requirement on
any quote record the engine stamps (§10, §11.2).

### 1.3 Complementary data providers

| Provider | Fundamentals | Sentiment | Technicals | Delayed quotes | Real-time | Notes / source |
|---|---|---|---|---|---|---|
| Yahoo Finance | Via unofficial yfinance only | Not confirmed as a product | Via yfinance history | ~15–20 min via unofficial endpoints | No official real-time API | **No official public API since 2017 discontinuation**; yfinance is an unofficial library calling internal endpoints, unguaranteed. https://www.promptcloud.com/blog/scrape-yahoo-finance/ ; https://marketxls.com/blog/yahoo-finance-api-ultimate-guide |
| Finnhub | ✓ | ✓ news sentiment (premium, US only) | ✓ technical indicators | ✓ (+ real-time trades US stocks/forex/crypto) | ✓ WebSocket trades | REST + WebSocket, 30 calls/sec cap noted. https://finnhub.io/docs/api/ |
| Polygon / Massive | ✓ (financials) | **Not confirmed** — no native sentiment product found | ✓ aggregates/indicators | Free tier delayed/EOD only | ✓ SIP at Stocks Advanced tier; OPRA authorized distributor | Rebrand Polygon.io → Massive reported 2025-10-30 (secondary). Coverage: stocks/options/indices/forex/crypto/futures; REST/WebSocket/flat files. https://www.londonstrategicedge.com/directory/fundamental-data/polygon-io-massive/ ; https://www.itechguides.com/products/massive-formerly-polygon-io/ |
| Alpha Vantage | ✓ `OVERVIEW`, `INCOME_STATEMENT`, `BALANCE_SHEET`, `CASH_FLOW` | ✓ `NEWS_SENTIMENT` | ✓ 50+ indicators | ✓ `GLOBAL_QUOTE` (delayed on free tier per secondary sources) | Not confirmed as real-time | Free tier 25 requests/day in secondary sources; forex/crypto + economic indicators. Official alphavantage.co docs not opened. https://tessl.io/registry/skills/github/fernandezbaptiste/Skrillz/alphavantage-api--alphavantage-api ; https://medium.com/coinmonks/stock-market-api-what-it-is-how-it-works-and-how-to-use-it-80b66cc9dbcc |

**Consequence for the "universe+Yahoo" pattern (§2):** Yahoo data in this stack arrives
via unofficial endpoints with no SLA, rate limits, and delay — never as an official,
guaranteed feed. Any run naming Yahoo as a source must record that provenance honestly
(provider + unofficial + delay), and must never present Yahoo data as live broker data.

### 1.4 Venue mapping and classifications

- **Nasdaq Trader Symbol Directory (read in full text, 2026-11-18).** "The symbol
  directory files are updated periodically through-out each day." Pipe-delimited text
  files (`nasdaqlisted.txt`, `otherlisted.txt`, `nasdaqtraded.txt`) with listing-exchange
  codes for other-exchange securities: A = NYSE MKT, N = NYSE, P = NYSE ARCA, Z = BATS,
  V = IEX; ETF flag (Y/N); market category (Q/G/S); plus options directories (root symbol,
  put/call, expiration, strike, underlying). File Creation Time trailer row on each file.
  No GICS field in these files was confirmed.
  https://classic.nasdaqtrader.com/Trader.aspx?id=SymbolDirDefs ;
  file URL cited in search results: https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt
  (not fetched).
- **MIC (ISO 10383).** Four-character venue codes maintained under ISO 10383; segment MIC
  vs operating MIC must both be stored (e.g., NYSE Arca ARCX / operating XNYS; Cboe BZX
  BATS / operating XCBO; XNAS Nasdaq, XNYS NYSE).
  https://docs.stretus.com/reference/markets/ ;
  https://www.theocc.com/getcontentasset/edaac932-1d30-4c31-899d-e06a5ebaf591/dfc3d011-8f63-43f6-9ed8-4b444333a1d0/encore_dds_overview_implementation.pdf ;
  https://www.quantopia.net/blog/understanding-market-identifier-codes-mic-definition-uses-and-types/ .
  Full US venue/MIC list: https://www.juliusbaer.com/fileadmin/legal/20260615-bjb-mifid-ii-execution-venue-list.pdf
- **GICS.** Maintained jointly by MSCI and S&P Dow Jones Indices, created 1999.
  11 sectors: Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples,
  Health Care, Financials, Information Technology, Communication Services, Utilities,
  Real Estate. Depth counts differ by methodology vintage: 25 industry groups /
  74 industries / 163 sub-industries (2025 methodology) vs older 24/69/158 — **version
  difference, flag in any taxonomy**. Methodology PDF (proxied URL — verify against
  msci.com):
  https://bakpao.comeasyouare.workers.dev/melissa-https-www.msci.com/indexes/documents/methodology/1_MSCI_Global_Industry_Classification_Standard_GICS_Methodology_20250220.pdf ;
  https://en.wikipedia.org/wiki/Global_Industry_Classification_Standard .
  **Unverified:** a free machine-readable per-symbol GICS assignment file; GICS data is
  commercially licensed in practice — treat as a licensed-data gap (§9).

### 1.5 Mapping to the #5515 whole-set vocabulary

The research findings map onto the #5515 axes as follows. "Repo status" is the #5515
record, not a new claim; gaps link to their owning issues.

| #5515 axis | Research finding | Repo status / gap |
|---|---|---|
| Data providers | 5 repo ids + Finnhub/Polygon/Alpha Vantage confirmed as complementary providers; Yahoo unofficial-only | Open registry unbuilt (#5515); Finnhub absent from the repo vocabulary |
| Datasets | Quotes (live/delayed, L1/L2), trades, bars, chains + Greeks, fundamentals, news + sentiment, technicals, filings, corporate actions, alt data, economic indicators | Dataset is a free string today; extensible registry unbuilt (#5515); per-quote feed/entitlement/delay/as-of metadata unbuilt (§11.2) |
| Universes | Maintained lists, versioned by effective date; no free official machine-readable form confirmed | Two vocabularies un-unified; universe step nasdaq100-only (#5499); point-in-time versioning unbuilt (§11.2) |
| Sectors | 11 GICS sectors, versioned methodology; per-symbol assignment licensed | 11 GICS sector ids exist; `TECH` = `sector-information-technology`, never a universe (#5515, #5516) |
| Exchanges | MIC venue codes (segment + operating); Nasdaq directory intraday | Filter-only enum (ALL/NASDAQ/NYSE/AMEX); first-class run axis unbuilt (#5515) |
| Brokers | 6 brokers surveyed; coverage matrix §1.2; account structures §3 | 4 broker ids + F1 tuple (broker, mode, accountType, accountId); asset NOT in the tuple; open registry unbuilt (#5515) |
| Assets | Equities, ETFs, equity/ETF/index options confirmed; forex/forex-options largely unconfirmed; crypto broker-dependent; bonds/futures per provider | Equity/options only; open asset vocabulary unbuilt (#5515) |

Rules carried from #5515 (owner decisions, recorded there): default broker alpaca/paper
for all surfaces and default universe nasdaq100, both externalized (#5516); never
substitute broker-for-broker — an unservable capability refuses by name (#5517); a job
declares any subset of the axes; undeclared refuses; absent means the externalized default.

## 2. Combination patterns

**No vendor-published Alpaca+Polygon or IBKR+fundamentals reference architecture was
found** in the searches read (gap — vendor-doc composition unconfirmed). Composition is
demonstrated publicly by community/open-source multi-agent systems and by vendor docs
that each cover one leg of the composition:

- **LangGraph + MCP orchestration** with EDGAR/OpenBB/Polygon/Tradier/yfinance + Alpaca
  paper then IBKR, approval gate via `interrupt()`:
  https://avnit.asbblog.com/2026-07-23-project-Trading-system-vibe/
- **Multi-agent system** combining Polygon, SEC, OpenFIGI, FMP, and Alpaca market data:
  https://www.moggy.cat/docs/architecture_overview.md
- **Alpaca + Polygon toolkit** (MCP server):
  https://github.com/dtony47/alpaca-mcp-server/blob/HEAD/README.md
- **QuantConnect/LEAN** as the integrated pattern: one engine, pluggable data + brokerage
  adapters, backtest→live with only a config change (§3).

**Canonical run pattern (derived from the above, each leg sourced):** (1) resolve
point-in-time universe (index list + Nasdaq directory for listing/ETF status);
(2) fan out per-symbol enrichment (fundamentals/sentiment/technicals from
Finnhub/Alpha Vantage/Polygon; filings via SEC EDGAR); (3) attach live/delayed quotes
from the broker feed with entitlement metadata; (4) screen/rank deterministically;
(5) human approval gate for orders; (6) execute via broker API; (7) append-only audit
of every input version, quote timestamp, and decision. Steps 5–7 map to the durability
and gating requirements in §7 and §10.

The two owner-directed screen patterns, stated with the research caveats:

- **Universe + Yahoo (delayed quotes).** Runs on the universe list plus Yahoo
  fundamentals/technicals and delayed quotes — via unofficial yfinance endpoints
  (§1.3), unguaranteed, ~15–20 min delayed. Valid as a delayed-data screen; the run
  record must name the delay and the unofficial source.
- **Universe + broker + Yahoo (live quotes).** The same screen with live quotes from
  the selected broker's feed (entitlement-gated, §1.2) plus Yahoo complementary data.
  The broker leg and the complementary leg are separate providers in the same run;
  each dataset records its own provider, feed, entitlement, and as-of (§1.2).
- **Options from any broker.** Same composition with the options leg: chains + Greeks
  from the selected broker (entitlement-gated, OPRA where applicable), universe from
  the maintained list, complementary data as above. Never substitute broker-for-broker
  (§1.5): if the selected broker cannot serve chains, the run refuses by name (#5517).

## 3. Asset classes + accounts

### 3.1 World-class offerings surveyed (10 named firms)

Retail API-first brokers expose self-serve APIs; institutional platforms are gated or
licensed. Fidelity has **no public retail trading API** per multiple 2026 sources.
BlackRock Aladdin was searched and **not verified** — excluded from the confirmed count.
Citadel-type hedge-fund platforms: no public API docs found. Quantopian shut down
2020-11-03; its Zipline engine lives on via community forks (Zipline-reloaded).

| Firm | Type | Market data (public docs) | Execution | Account/custody | Research | Payments / money movement | Source |
|---|---|---|---|---|---|---|---|
| Alpaca | API-first broker | Market Data API: stocks/ETFs, options, crypto, news (§1.2) | REST/WS trading, paper + live, Broker API (omnibus/end-user accounts) | Broker API accounts, funding wallet, journals | News API | ACH (Plaid), wire out via API, journals (§8) | https://docs.alpaca.markets/docs/about-market-data-api ; https://docs.alpaca.markets/us/docs/funding-accounts |
| Interactive Brokers | Global broker | Per-exchange subscriptions; free Cboe One/IEX streaming; Client Portal + TWS/Gateway + FIX | Multi-asset, algos; Autonomous Trading Oct 2026 (secondary, §7) | Custody, margin, global accounts | Trader Workstation analytics | ACH/wire funding (general; API funding specifics unverified) | https://investors.interactivebrokers.com/en/index.php?f=14193 |
| Charles Schwab | Broker / wealth | Trader API quotes, chains, L1/L2 streaming | Equities/options via Trader API | Brokerage + custody (RIA custody via Schwab Advisor Services — not separately verified) | Research via platform (API research endpoints not confirmed) | Money movement via platform (API specifics unverified) | https://deepwiki.com/go-schwab/trader/4-market-data-api |
| E*TRADE / Morgan Stanley | Broker | REST quotes, chains; Comet streaming | Equity/option preview + placement | Brokerage accounts | Platform research (API research not confirmed) | Platform funding (API specifics unverified) | https://developer.etrade.com/support/frequently-asked-questions |
| tastytrade | Options-focused broker | REST market data, DXLink streaming, chains | Multi-leg, OTO/OCO/OTOCO complex orders | Brokerage accounts | Platform research (API research not confirmed) | Platform funding (API specifics unverified) | https://developer.tastytrade.com/llms.txt |
| Public | Retail broker | Real-time pricing + historical data (equities/options) | Stocks/ETFs/options/index options/bonds/crypto, fractional, 24/5 equities | Brokerage accounts | Via API docs/templates (depth unverified) | Platform funding (API specifics unverified) | https://Public.com/api |
| Goldman Sachs (Marquee) | Investment bank | Research, trade ideation/structuring, execution, portfolio analytics, data services via web/desktop/mobile/API; GS Quant Python toolkit | Institutional execution (gated) | Prime services / agency lending; custody via institutional channels | Marquee research | Transaction Banking APIs: virtual accounts, payments, Fedwire/ACH/SWIFT | https://www.goldmansachs.com/what-we-do/ficc-and-equities/prime-services/agency-lending ; https://apis.io/providers/goldman-sachs/ . Gated, no self-serve retail API. |
| Bloomberg | Data/terminal + EMS | BPIPE real-time consolidated feed (data only); `//blp/mktdata`, `//blp/refdata` | EMSX execution management (equities/futures/options) | Via terminal/licensed integrations (custody n/a) | Terminal research/analytics | n/a (not a payments provider) | https://emsx-api-doc.readthedocs.io/en/latest/glossary.html ; https://github.com/QuantConnect/Documentation/pull/2637 . Terminal/licensed access only; official Bloomberg docs not directly read. |
| Fidelity | Broker / wealth | No public retail trading API as of Oct 2026 (multiple sources); institutional Wealthscape Integration Xchange (400+ integration points); FIX for institutions; read-only via SnapTrade/Plaid | Institutional FIX only (retail API: none confirmed) | Custody (institutional/RIA) | Platform research | Platform money movement (API: institutional only) | http://aistocktradingbots.com/blog/fidelity-api/ ; https://snaptrade.com/brokerage-integrations/fidelity-api |
| QuantConnect / LEAN | Hedge-fund-grade research platform | 400TB+ historical data, 7 asset classes; tick→daily; alternative-data add-ons | Live via 20+ brokers (IBKR, Alpaca, Schwab, TradeStation, Coinbase, Binance, Kraken, OANDA, Zerodha, FIX) | Not a broker/custodian — routes to connected brokerage | Cloud IDE, Alpha Streams marketplace, AI assistant Mia | n/a (no custody/payments) | https://www.quantt.co.uk/resources/quantopian-alternatives-guide ; https://quantbrainai.net/blog/quantconnect-review-2026-algo-trading-platform/ ; https://qisagent.com/atlas/ . LEAN Apache-2.0. |

### 3.2 Assets held in accounts at the broker

Assets are held in various accounts at the broker; the account is part of the execution
identity, not an afterthought. The repo's F1 binding tuple is
`{broker, mode, accountType, accountId}` per scope (#5515); **asset is not in the
tuple** — joining asset to the tuple is a #5515 gap. The owner-directed asset list is:
stocks, ETFs, stock-options, ETF-options, forex, forex-options, crypto. Research status
per asset: equities/ETFs/equity-options/ETF-options/index-options confirmed across the
surveyed brokers (§1.2); **forex and forex-options are largely unconfirmed via the
surveyed retail broker APIs** (Finnhub and Alpha Vantage cover forex data; broker forex
execution was not confirmed in the sources read); crypto is broker-dependent (Alpaca
and Public confirmed; Schwab/E*TRADE not confirmed; IBKR unverified; tastytrade
reported disabled, secondary). Bonds and futures appear per provider/broker coverage
(Public: bonds; Bloomberg EMSX: futures; Polygon/Massive: futures) — coverage largely
unverified beyond the named rows. The asset vocabulary must therefore be an open
registry (#5515) whose values are added only with verified coverage, never assumed.

## 4. Methodologies

OODA is one research-and-trading methodology among many — not the model. Each row states
what the methodology is and the platform capabilities it demands (data / compute /
latency / audit / determinism). Capability demands are derived from the methodology's
public description plus the §5/§9 primitives; they are design requirements, not vendor
claims. The research inventoried all 14 required families plus 4 additional approaches
(§4.14–§4.17) with rationale.

| # | Methodology | What it is | Platform demands | Public source |
|---|---|---|---|---|
| 4.1 | OODA loop | Boyd's Observe–Orient–Decide–Act; orientation is central; tempo advantage from faster, better-oriented cycles | Streaming observe; stateful orientation (context/memory); decision gates; act via idempotent execution; full cycle audit | https://en.wikipedia.org/wiki/Ooda ; https://resources.rework.com/libraries/leadership/ooda-loop |
| 4.2 | Quantitative factor models | Fama–French 3-factor (MKT-RF, SMB, HML, 1993); Carhart 4-factor (+ momentum/WML/UMD, 1997); Fama–French 5-factor (+ RMW profitability, CMA investment, 2015); 6-factor adds momentum to 5-factor; factor investing: size/value/momentum/quality/low-vol | Point-in-time fundamentals + prices; cross-sectional regression; factor-return history (e.g., French data library — not separately verified); deterministic factor construction; attribution audit | https://shishin.io/research/factor-investing ; https://www.quantt.co.uk/resources/fama-french-model-explained ; https://kevin-crotty.com/busi448/pdfs/21_multifactor_models.pdf ; https://copyprogramming.com/howto/fama-french-three-factor-model-vs-four-factor-carhart-and-five-factor-model |
| 4.3 | Statistical arbitrage / pairs trading | Market-neutral pairs; cointegration (Engle–Granger), Ornstein–Uhlenbeck spread mean-reversion, z-score entry/exit | Tick/minute bars; cointegration tests; low-latency spread monitoring; paired-order atomicity/saga; deterministic backtest | https://bookmap.com/blog/pairs-trading-a-deep-dive-into-this-market-neutral-strategy ; https://qcaml.com/part-6-algorithmic-trading/ch24-trading-strategies/index.html |
| 4.4 | Momentum / trend-following | 12-1 cross-sectional momentum (winners persist); time-series trend (moving-average/breakout) | Long price history; cross-sectional ranking; turnover/cost modelling; scheduled rebalances | https://qcaml.com/part-6-algorithmic-trading/ch24-trading-strategies/index.html ; https://shishin.io/research/factor-investing |
| 4.5 | Mean reversion | Prices revert to mean; short-horizon reversal; Bollinger/RSI-style signals | Intraday bars; volatility estimation; fast signal→order; drawdown controls | https://qcaml.com/part-6-algorithmic-trading/ch24-trading-strategies/index.html |
| 4.6 | Event-driven (earnings, news, corporate actions) | Trade catalysts: earnings, M&A/merger arbitrage, 8-K/13D/Form 4 filings, news/NLP event extraction | Real-time news + EDGAR filings; NLP event extraction; corporate-action-adjusted data; low-latency reaction; event audit trail | https://news.alfafinderusa.com/learn/guide-to-event-driven-investing-sec-catalysts/ ; https://the-algotrading-book.marketmaker.cc/chapters/05-nlp-bert/095-event-extraction-trading/ |
| 4.7 | Options frameworks | Spreads, straddles (ATM call+put), strangles (OTM call+put), iron condors (bull put + bear call spread, 4 legs), volatility/IV-rank trading, Greeks-based risk (Delta/Gamma/Theta/Vega/Rho) | OPRA chains + Greeks; multi-leg atomic orders (OTO/OCO/OTOCO); vol surface; portfolio-Greeks aggregation; expiry handling | https://www.finmarketiq.com/trading-guides/options-fundamentals ; https://optionpilot.ainvest.com/glossary ; tastytrade complex orders: https://developer.tastytrade.com/llms.txt |
| 4.8 | Portfolio construction | Markowitz (1952) mean-variance; Black–Litterman (Goldman Sachs 1990: equilibrium prior + views); risk parity (equal risk contribution); Kelly (1956, f* = μ/σ², fractional 0.25–0.5); HRP | Covariance estimation; optimizer (QP/SOCP); constraints; deterministic solves; allocation audit | https://www.hevangel.com/wyandanch-library/docs/read/portfolio-construction.html ; https://www.portfoliovisualizer.com/faq |
| 4.9 | RL / ML-driven trading | DQN/DDPG/PPO/A2C, LSTMs, sentiment integration; reported returns non-comparable across studies; QFRS reporting standard proposed | GPU training; feature stores; experiment tracking; model versioning; eval gates; reproducibility (seeds, data versions) | https://www.mdpi.com/2673-2688/7/11/470/pdf ; https://www.atlantis-press.com/article/125999560.pdf |
| 4.10 | LLM-agent research | Single/multi-agent: FinGPT, FinMem, FinAgent, FinRobot, FinCON, TradingAgents, Hedge-Agents, MarketSenseAI; fundamentals/sentiment/risk sub-tasks; 10-K analysis; ERR generation (FinRpt) | LLM orchestration + tools/MCP; RAG + vector store; memory; eval loops; **leakage-robust evaluation** (FinLake-Bench/FINSABER); human gates; cost/latency budgets | https://arxiv.org/html/2510.07920v1/ ; https://pdfs.assets.alphaxiv.org/2505.07078v5.pdf ; https://arxiv.org/pdf/2411.04788 ; https://pdfs.assets.alphaxiv.org/2511.07322v3.pdf |
| 4.11 | Alternative-data & sentiment | Satellite imagery, credit-card transactions, web scraping, social/news sentiment scores, search attention, government receivables | Alt-data ingestion pipelines; sentiment scoring; point-in-time alignment; vendor licensing; audit of data provenance | https://www.tenderalpha.com/blog/3-quantitative-strategies-based-on-alternative-data/ |
| 4.12 | Backtesting & walk-forward validation | Rolling in-sample optimize / out-of-sample test; 3:1 window ratio as starting point; walk-forward efficiency >0.5 robust; deflated Sharpe; overfitting warnings | Deterministic replay; survivorship-bias-free point-in-time data; slippage/commission models; parameter search at scale; result audit | https://www.quantengines.com/blog/backtesting-trading-strategies ; https://www.freyafinance.com/academy/backtesting/walk-forward-analysis-strategy-validation |
| 4.13 | Risk frameworks | VaR (quantile, not coherent); CVaR/Expected Shortfall (mean of tail, coherent); max drawdown; stress testing; drawdown control | Risk-factor data; scenario engine; pre-trade limits (15c3-5 pattern, §7); kill switches; risk audit trail | https://www.edgekit.pro/tutorials/risk-management ; https://www.finantrix.com/articles/10-market-risk-metrics-var-cvar-stress-loss-explained |
| 4.14 | **Additional: Market making / liquidity provision** | Quote both sides, earn spread, manage inventory; requires colocated low-latency quoting — rationale: exercises the platform's hardest latency + risk path; if the stack cannot express it, HFT-adjacent use is excluded by design | Sub-ms–ms latency; colocated/edge execution; inventory risk; quote-update streaming | *No dedicated source read — flagged unverified; rationale is architectural, not sourced.* |
| 4.15 | **Additional: Cross-asset / macro rotation** | Rotate across equities, rates, FX, commodities on macro signals; rationale: forces multi-asset data model + multi-venue execution beyond single-asset equities | Multi-asset universe; macro/economic data (Alpha Vantage indicators, FRED — FRED not separately verified); FX/futures connectivity | Partial: Alpha Vantage economic indicators per §1.3. Otherwise unverified — flag. |
| 4.16 | **Additional: Merger arbitrage (distinct event-driven sub-type)** | Long target / short acquirer through deal close; spread = deal risk; rationale: demands corporate-action + deal-status data and paired hedging distinct from generic event trading | Deal data; paired orders; borrow/hedge; event audit | Covered under §4.6 sources (M&A/merger arbitrage). |
| 4.17 | **Additional: Leakage-robust LLM evaluation** | Counterfactual/memorization-probe evaluation (FinLake-Bench, FactFin, FINSABER); rationale: without it, LLM-agent backtests are not credible (§7.3) | Frozen knowledge-cutoff discipline; counterfactual simulator; memorization probes; eval audit | https://arxiv.org/html/2510.07920v1/ ; https://pdfs.assets.alphaxiv.org/2505.07078v5.pdf |

No methodology above is built by this document. Each methodology's platform demands
feed §10; building any methodology is its own issue (out of scope here, §11.2).

## 5. Topologies

| Topology | What it is | Trading use | Trade-offs / demands | Public source |
|---|---|---|---|---|
| Linear chain | Sequential steps, each feeding the next | Screen → enrich → rank → approve → execute | Simple, auditable; no parallelism; single failure blocks chain | Six-topology framework (Chain, Route, Parallel, Orchestrate, Loop, Hierarchy): http://arxiv.cnoctave.top/pdf/2605.13850v1 (mirror URL — verify against arxiv.org) |
| DAG | Directed acyclic graph of dependent tasks | Multi-factor pipeline with shared upstream features | Parallel where independent; scheduling + lineage complexity | Same framework paper; Temporal child workflows: see fan-out row |
| Fan-out / fan-in (map/reduce) | Scatter per-symbol work, gather results | Per-symbol enrichment/screening over a universe; parameter sweep | Massive parallelism; result-size limits (cf. Inngest 32 MiB state); straggler handling; Temporal 1K×1K child-workflow pattern | https://claudeskills.club/skills/workflow-orchestration-patterns-by-wshobson |
| Saga with compensation | Sequence of local commits + compensating actions in reverse order; idempotent steps; irreversible step last | Multi-leg orders; order + payment + journal sequences | No distributed atomicity; compensation design is the hard part; audit must record compensations | https://www.kmrrohit.space/learn/system-design/durable-execution-and-sagas |
| Event-driven / streaming | React to events/streams; durable timers; signals | Quote ticks, news, filings → signals; streaming enrichment | Ordering, exactly-once effects, backpressure; needs streaming layer (§9b) | Partially covered via §10 engine docs (signals/timers) + streaming sources in §9; dedicated event-driven-workflow source not separately read — flag |
| Hierarchical / nested | Parent workflows spawn child workflows; sub-agents | Portfolio → strategy → symbol hierarchy; multi-agent research (vertical/horizontal/hybrid) | Isolation + reuse; cross-workflow visibility; parent/child failure semantics | Framework paper (Hierarchy) + multi-agent structures: https://arxiv.org/pdf/2411.04788 |
| Human-in-the-loop | Approval gates, waits, signals | Order approval, payment release, research sign-off | Waits of days–year without compute (Temporal/Cloudflare); escalation/timeout; audit of who approved what | https://docs.temporal.io/guides/reliable-document-approvals ; https://developers.cloudflare.com/agents/agent-class/run-workflows/ (`waitForApproval()`) |
| **Deployment: edge execution** | Run near exchanges/users (colocation, Workers edge) | Quote handling, pre-trade checks, inference near venue | Lowest latency; limited compute/state; speed-of-light floor (~0.8 ms round-trip per 50 miles fiber, per source); durability must be pushed to core | https://uat-hr.digitalrealty.com/resources/blog/transaction-latency ; https://hfrtai.com/knowledge/how_does_aiops_trading_latency_actually_perform_in_2026_and_what_infrastructure_changes_are_required_to_keep_sub-millisecond_decision_loops_stable.php |
| **Deployment: regional** | Single-region core + edge ingress | Default durable core (workflows, Postgres, audit) | Strong consistency + durability; cross-region latency for distant users/venues | Same deployment sources; hybrid edge-inference + centralized-training pattern therein |
| **Deployment: multi-region** | Active/active or active/passive across regions | Resilience; global users; venue proximity | Resilience vs latency/consistency trade-off; replication lag; failover complexity; cost | Same deployment sources (multi-region resilience vs latency trade-off) |

## 6. Consolidated taxonomy

**Axes** (methodologies × topologies × technologies × data). Values are from public
sources cited in §1/§3/§4/§5/§9; unverified values are flagged. The data axis below is
the PUBLIC value list; the repo's #5515 axes (§1.5) are the subset the engine declares
today, and the difference between the two lists is the registry gap, not a second
vocabulary.

- **Axis 1 — Methodologies:** §4.1–§4.17 (OODA; factor models; stat-arb/pairs;
  momentum/trend; mean reversion; event-driven; options frameworks; portfolio
  construction; RL/ML; LLM-agent research; alternative-data/sentiment;
  backtesting/walk-forward; risk; + market making, cross-asset/macro rotation, merger
  arbitrage, leakage-robust evaluation).
- **Axis 2 — Topologies:** §5 (linear chain; DAG; fan-out/fan-in; saga/compensation;
  event-driven/streaming; hierarchical/nested; human-in-the-loop; deployment: edge /
  regional / multi-region).
- **Axis 3 — Technologies:** durable orchestration (Temporal, DBOS, Restate, Inngest,
  Cloudflare Workflows/Agents/Think, Step Functions); streaming (Kafka, Redpanda, NATS,
  Pulsar); data (PostgreSQL, SQLite/libSQL, DuckDB, ClickHouse, Redis/Valkey/Dragonfly,
  pgvector/Qdrant/Milvus/Chroma, Drizzle); agent frameworks (LangGraph, CrewAI, Mastra,
  AutoGen/Microsoft Agent Framework, Cloudflare Agents SDK); observability
  (OpenTelemetry, Prometheus, Grafana, Loki, Tempo); auth/secrets (Ory, Keycloak,
  OpenBao/Vault); flags/config (OpenFeature/flagd, Flagship, Unleash); quant (vectorbt,
  Backtrader, Zipline-reloaded, QuantLib, LEAN, NautilusTrader, TA-Lib); broker clients
  (alpaca-py, ib_async/ibapi, schwab-py, pyetrade/community wrappers, ccxt). Licenses
  and verdicts in §9.
- **Axis 4 — Data:**
  - **Providers:** brokers (Alpaca, IBKR, Schwab, E*TRADE, tastytrade, Public);
    complementary (Yahoo/yfinance unofficial, Finnhub, Polygon/Massive, Alpha Vantage);
    index publishers (S&P DJI, Nasdaq, FTSE Russell); classification (MSCI + S&P DJI
    GICS); venue directories (Nasdaq Trader); identifiers (ISO 10383 MIC, FIGI/OpenFIGI
    — OpenFIGI mentioned in a §2 source, not separately verified).
  - **Datasets:** quotes (live/delayed, L1/L2), trades, bars/aggregates, option chains +
    Greeks, fundamentals (statements, overview), news + sentiment, technicals/indicators,
    filings (EDGAR), corporate actions, alternative data, economic indicators.
  - **Universes:** S&P 500, Nasdaq-100, Dow Jones Industrial Average (30), Russell 2000
    (and Russell 1000/3000 — mentioned in the research mission, not separately verified),
    custom screens.
  - **Sectors (GICS 11):** Energy, Materials, Industrials, Consumer Discretionary,
    Consumer Staples, Health Care, Financials, Information Technology, Communication
    Services, Utilities, Real Estate.
  - **Exchanges/venues (US, MIC):** NYSE XNYS, Nasdaq XNAS (segments XNMS/XNGS), NYSE
    Arca ARCX, NYSE American XASE, Cboe BZX BATS, Cboe BYX BATY, Cboe EDGX, IEX IEXG,
    MEMX MEMX, Nasdaq BX XBOS, Nasdaq PHLX XPHL/XPHO, Nasdaq PSX XPSX, NYSE Chicago
    XCHI, NYSE National XCIS, MIAX Pearl EPRL, LTSE LTSE, OTC XOTC/OOTC; options venues:
    Nasdaq ISE XISX, GEMX GMNI, MRX MCRY, NOM XNDQ, BX Options XBXO, NYSE Arca Options,
    NYSE American Options. Source: https://www.juliusbaer.com/fileadmin/legal/20260615-bjb-mifid-ii-execution-venue-list.pdf ;
    https://docs.stretus.com/reference/markets/
  - **Brokers:** as §1.2/§3.
  - **Assets:** equities, ETFs, equity options, ETF options, index options, forex, forex
    options, crypto, bonds, futures, mutual funds (per provider/broker coverage; forex
    options and futures coverage largely unverified — see §1.2).
  - **Order types (FIX OrdType 40):** 1 Market, 2 Limit, 3 Stop, 4 Stop-Limit, 5
    Market-on-Close, J Market-if-Touched; + trailing stop / trailing stop-limit (ExecInst
    TRAILSTOPPEG), iceberg/reserve (MaxFloor), post-only, pegged, take-profit, OCO
    (one-cancels-other), OSO (one-sends-other), OTO/OTOCO (tastytrade complex orders),
    MOO/MOC via TimeInForce. TimeInForce: Day, GTC, GTD, IOC, FOK, GFD, At-the-Open/Close.
    Sources: https://futures-media.stonex.com/gfapi/html/133e2886-5411-44b7-b781-2311a45ab540.htm ;
    https://dev.cube.exchange/what-is/supported-order-types ;
    https://www.deutsche-boerse.com/resource/blob/5595126/b1b642626be9f49efd06f6c59b0cbb6e/data/OpenDay2026%20Slide-SpA%20Xetra%20-%20final.pdf

## 7. Research → trading: copilots, autopilot, RSI/ASI

### 7.1 Copilot vs autopilot

Copilot = human-in-the-loop: the agent proposes, the human reviews/approves (IBKR's
prior "Review & Approve" mode; Temporal `waitForApproval`-style gates; LangGraph
`interrupt()`). Autopilot = the agent acts without per-order approval within pre-set
bounds. The repo's copilot/autopilot surfaces, risk envelope, and chat control are
specified in [`../agentic/copilot-autopilot.md`](../agentic/copilot-autopilot.md) and
[`../agentic/autopilot-capabilities.md`](../agentic/autopilot-capabilities.md); this
section records only what the public research adds: the October 2026 market reports
and the regulatory framing. **All October-2026 autopilot reports below are secondary
sources; primary broker pages were not opened — verify before relying on any parameter.**

- **IBKR Autonomous Trading (reported Oct 2026; launch date conflicts: Oct 15 vs Oct 21,
  2026 — unresolved).** ~3,000 invited clients; MCP connector; dedicated AI Partition
  (up to 10% equity; $1,000 min / $25,000 max in one source); prior Review & Approve
  mode requiring ≥10 trades ≥$100 in two weeks; eligible stocks/equity options;
  market/limit/stop/stop-limit day orders only; no margin/short/fractional/penny stocks.
  Sources: https://www.gaiiinstitute.com/interactive-brokers-autonomous-trading/ ;
  https://aistocktradingbots.com/blog/ibkr-autonomous-ai-trading/
- **Robinhood Agents** (approvals optional except crypto in CA/CT/NY; separate agentic
  account) and **Coinbase for Agents**, mentioned in:
  https://www.trade2spike.com/ai-in-action/interactive-brokers-autonomous-trading-ai-orders-without-approval-coinbase-agents-perps-robinhood-approvals-off
  Primary pages not opened.
- **Guardrails/audit pattern (public):** partitioned capital, order-type/asset
  allowlists, day-only orders, no leverage/short, pre-trade limits, kill switches,
  immutable decision logs. FINRA's 2026 report on AI-agent risks (autonomy without
  validation, action tracking, guardrails) cited second-hand in
  https://blog.traderspost.io/article/ai-agents-agentic-trading-traderspost — primary
  FINRA report not opened.

### 7.2 Regulatory framing (secondary summaries — flag)

Primary SEC/FINRA pages were **not** opened; treat the regulatory summaries as
secondary. SEC Rule 15c3-5 (Market Access Rule, 2010): broker-dealers must maintain
pre-trade risk controls for all orders, manual or automated, under direct/exclusive
control, with annual CEO certification. FINRA Rule 3110 supervision; Regulatory Notice
15-09: algorithm lifecycle, testing, kill switches; Series 57 registration for algorithm
designers. CAT (Consolidated Audit Trail) as the audit-trail regime. Sources:
https://legalclarity.org/algorithmic-trading-laws-key-cases-and-systemic-risk/ ;
http://umatechnology.org/automated-trading-vs-human-traders-responsibilities-risks-and-oversight-in-u-s-securities-markets/

### 7.3 RSI/ASI framing — grounded

- **What RSI/ASI means in the literature:** Recursive self-improvement = an AI improving
  its own ability to improve itself, compounding toward an "intelligence explosion";
  I.J. Good (1965) "ultraintelligent machine"; Yudkowsky coined RSI/seed AI;
  Bostrom/Omohundro instrumental goals. Wikipedia (as read 2026-11-18) calls RSI
  **hypothetical**, with RSI-related projects ongoing in 2026 but human work still
  needed. Sources: https://en.wikipedia.org/wiki/Recursive_self-improvement ;
  https://aiwiki.ai/wiki/recursive_self-improvement ;
  https://lilianweng.github.io/posts/2026-07-04-harness/
- **What EXISTS (narrow analogues, not RSI):** AlphaZero self-play; neural architecture
  search; AlphaEvolve; Darwin Gödel Machine; STaR (self-taught reasoner);
  evaluator-optimizer / reflection loops (Anthropic "Building effective agents," Dec
  2024); Self-Refine/Reflexion; OpenAI self-evolving agents cookbook with eval gates,
  LLM-as-judge, retry caps (target 0.8, max_retry 10 in example). Sources:
  https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining ;
  https://www.justmalhar.com/blog/evaluator-optimizer-pattern/
- **What is SPECULATIVE:** autonomous recursive self-improvement of a trading/research
  system without human oversight; ASI applied to markets. No public source in this
  research demonstrates either.
- **Trading-specific counter-evidence (must temper any RSI claim in trading):** LLM
  financial agents show a "profit mirage" — back-tested returns evaporate past the
  model's knowledge window due to information leakage; FinLake-Bench proposed as
  leakage-robust evaluation; FactFin counterfactual framework. Source:
  https://arxiv.org/html/2510.07920v1/ . FINSABER (KDD '26) reassessment: LLM advantages
  reported over short/narrow evals do not survive longer, broader robustness evaluation.
  Source: https://pdfs.assets.alphaxiv.org/2505.07078v5.pdf . Huang et al. on limits of
  intrinsic self-correction (cited in prior research; primary paper not re-opened — flag).
- **Grounded stack implication:** build eval loops, versioned prompts/models,
  leakage-robust backtests, and human gates — label anything beyond that as
  research/speculation, never as a shipped capability. The repo's RSI framing (governed
  vs self-RSI, dual modes, sandbox synthesis) lives in
  [`../agentic/stockcopilot-RSI.md`](../agentic/stockcopilot-RSI.md) and the autonomous
  subsystem in [`iros-system-analysis.md`](iros-system-analysis.md) §4.4; this section
  does not re-decide either.

## 8. Payments: rails and gating patterns

- **Broker money movement (Alpaca, official docs via search).** Three rails: **ACH**
  (incoming + outgoing, Plaid processor token, name-match check); **wire** (outgoing only
  via API; incoming pushed by sending bank with FFC instruction; SWIFT for
  international); **funding wallet** (v1beta, multi-currency). Relationships must be
  APPROVED before a wire transfer progresses. Journals move cash/securities between
  accounts in one omnibus. Sources: https://docs.alpaca.markets/us/docs/funding-accounts ;
  https://docs.alpaca.markets/us/reference/createtransferforaccount
- **Goldman Sachs Transaction Banking APIs** (institutional): virtual accounts, payments,
  Fedwire/ACH/SWIFT — see §3.1.
- **Approval / gating patterns (public, 2026 sources).** Maker-checker / four-eyes:
  agent prepares, approver 1 reviews the exact beneficiary/amount/evidence (not an agent
  summary), approver 2 (separate login/role) releases only the version approver 1 saw,
  system records proposal + evidence + both approvers + timestamps; the agent is never
  an approver. Dual approval is an internal control / bank-portal setting, **not** a
  Nacha mandate (per Zamp's check of Nacha pages — verify against rule text before
  asserting). Thresholds: dual approval required at/above a dollar threshold when another
  approver exists; bypassed below threshold or with no second approver; template
  creation/updates, ACH/wire initiation, and recurring-series payments trigger approval;
  out-of-band authentication for initiator-approved payments. Policy gates separate
  intent formation from authorization and settlement; agents act only within a pre-approved
  mandate (supplier, amount, cumulative spend, rail, timing); exceptions stop for human
  review; policy changes sit outside agent control; logs live in a system the agent
  cannot change. Sources: https://www.zamp.ai/blogs/four-eyes-approval-ai-agents-payments ;
  https://bcpartners-llc.com/dual-approval-segregation-of-duties-b2b-payments-controls/ ;
  https://www.itechguides.com/autonomous-b2b-payment-agents-configure-controls-before-they-pay/
  (a fourth cited source was a signed/expiring URL — content may expire; not relied on
  here).
- **Gap:** payment-approval workflows inside retail broker APIs beyond Alpaca funding
  relationships were not researched; no broker was found exposing a generic "approve
  this payment" API in the sources read. Related repo work (not re-verified here):
  the CBO payment series (#2547–#2551); this document does not re-specify it.

## 9. FOSS technology table

License verification key: **[L]** = license text/header/announcement directly read;
**[R]** = reported by secondary comparison citing the repo (LICENSE file not directly
opened — verify before legal reliance); **[U]** = unverified/disputed. See §0.

| Capability | FOSS technology | License | Maturity | Runtime fit (Workers/workerd vs server/container) | Verdict |
|---|---|---|---|---|---|
| **(a) Durable orchestration** | Temporal (server + SDKs) | MIT [R] | Mature, battle-tested | **Server/container** (cluster + workers); not edge-native | **ADOPT** as durable core (self-host) or Temporal Cloud (proprietary managed service) |
| | DBOS Transact (Python/TS library) | MIT [R] | Growing; Postgres-native | **Server/container** (needs Postgres; SQLite mode exists) | **ADOPT** if Postgres-centric; Conductor (hosted) is proprietary |
| | Restate (server) | **BSL 1.1** → Apache-2.0 after 4 yrs; forbids public Restate Platform Service [L: license text in search results from https://raw.githubusercontent.com/restatedev/restate/main/LICENSE ] | Growing; single binary, embedded RocksDB | **Server/container** | **ADAPT with counsel** — source-available, not FOSS; SDKs MIT [R] |
| | Inngest (server/CLI) | **SSPL** → Apache-2.0 after 3 yrs [R]; SDKs Apache-2.0 [R] | Mature (hosted); self-host less common | Serverless-friendly SDKs; server is **server/container** | **ADAPT** — source-available server; adopt SDKs + hosted, or accept SSPL |
| | Cloudflare Workflows engine | **Proprietary hosted service** [R] | GA (hosted) | **Edge (Workers) only** | **GAP (no FOSS equivalent of the hosted engine)**; adopt as proprietary edge layer if on Cloudflare |
| | Cloudflare Agents SDK + Think (`agents`, `@cloudflare/think`) | MIT [R] (Agents SDK per https://cloudparts.dev/technologies/agents-sdk/ ; Think license **not separately verified [U]**) | Pre-1.0, fast-moving (0.28 reported); Think durable submissions added May 2026 | **Edge (Workers/Durable Objects) only** | **ADAPT** — MIT code, platform-locked runtime; verify Think license from repo |
| | workerd runtime | Apache-2.0 [L: https://blog.cloudflare.com/workerd-open-source-workers-runtime/ ; header in https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp ] | Mature | The edge runtime itself; **not a secure sandbox** per Cloudflare | **ADOPT** for local/dev/edge-compatible runtime |
| | workers-sdk / wrangler / miniflare | MIT OR Apache-2.0 [R] | Mature | Dev tooling | **ADOPT** |
| | AWS Step Functions | **Proprietary** (AWS service; no FOSS engine) | Mature | AWS only | **GAP** — no FOSS equivalent; adopt only if AWS-native |
| **(b) Streaming/messaging** | Apache Kafka | Apache-2.0 [R] | Mature | **Server/container** (JVM, ZooKeeper/KRaft) | **ADOPT** for high-throughput streams |
| | Redpanda (core) | **BSL 1.1** → Apache-2.0 after 4 yrs [R]; enterprise features under Redpanda Community License [R] | Mature | **Server/container** | **ADAPT with counsel** — source-available |
| | NATS | Apache-2.0 [R] | Mature | **Server/container** (single binary, light) | **ADOPT** for low-latency messaging |
| | Apache Pulsar | Apache-2.0 [R] | Mature | **Server/container** (heavier ops) | **ADOPT** if multi-tenancy/geo-replication needed |
| **(c) Data layer** | PostgreSQL | PostgreSQL License (permissive) [R] | Mature | **Server/container** (or managed); reachable from Workers via HTTP drivers | **ADOPT** as system of record |
| | SQLite | Public domain [R] | Mature | Embedded; Workers via D1/Durable Object SQLite | **ADOPT** for embedded/edge state |
| | libSQL / Turso | MIT [R] (https://github.com/bread04/databricks-challenge-/blob/HEAD/.toolkit/03-backend/docs/repos.md reports libSQL MIT, Turso MIT) | Production (libSQL); Turso DB beta per same source | Edge-replicated SQLite; Workers-friendly via HTTP | **ADOPT/ADAPT** for edge SQLite |
| | DuckDB | MIT [R] | Mature | **Server/container** (analytical, embedded; Wasm builds exist — fit unverified) | **ADOPT** for analytics/backtest compute |
| | ClickHouse | Apache-2.0 [R] | Mature | **Server/container** | **ADOPT** for tick/columnar analytics |
| | Redis | **Tri-license RSALv2/SSPLv1/AGPLv3** (8.0+; only AGPLv3 OSI-approved); 7.2 last BSD line [R] | Mature | **Server/container** | **ADAPT/AVOID as FOSS** — use Valkey instead |
| | Valkey | BSD-3-Clause [R] | Growing (Redis fork) | **Server/container** | **ADOPT** as Redis-compatible FOSS cache/queue |
| | Dragonfly | **BSL 1.1** [R] | Growing | **Server/container** | **ADAPT with counsel** — source-available |
| | pgvector | PostgreSQL License [R] (https://resources.rework.com/tools/ai-data-infra/best-vector-databases-2026 ; http://13k.eu/en/apis/vector-database-comparison/ ) | Mature (0.8.7, Oct 2026) | Postgres extension — **server/container** | **ADOPT** if already on Postgres, up to a few M vectors |
| | Qdrant | Apache-2.0 [R] (same sources) | Mature (1.19.2, Oct 2026) | **Server/container** (single binary → distributed) | **ADOPT** for dedicated vector search |
| | Milvus | Apache-2.0 [R] | Mature (3.0, Jul 2026, LF AI & Data) | **Server/container** (K8s at scale) | **ADOPT** for billion-scale vectors |
| | Chroma | Apache-2.0 [R] | Mature for prototyping/small RAG | Embedded/server — **server/container** | **ADOPT** for dev/small RAG only |
| | Weaviate (core) | BSD-3-Clause [R]; Enterprise features need key from 1.40 | Mature | **Server/container** | **ADAPT** (open-core) |
| | Drizzle ORM | **Apache-2.0 [R, disputed]** — npm/GitHub API + Prisma comparison say Apache-2.0 (`drizzle-orm`), MIT (`drizzle-kit`); two 2026 comparisons say MIT. Majority + registry evidence favors Apache-2.0; **verify LICENSE file** | 0.45.x, 1.0 in RC (2026); no stable 1.0 yet | **Edge-native**: Workers/D1/Turso/Neon, ~7.4 kB gz, zero deps | **ADOPT** for TypeScript edge/server data access, pinned version |
| **(d) Agent frameworks** | LangGraph | MIT [R] | Mature | **Server/container** (Python/JS; checkpointers need DB) | **ADOPT** for graph agents; pair with Temporal/DBOS for durability |
| | CrewAI | MIT [R] | Mature/growing | **Server/container** | **ADOPT/ADAPT** for role-based crews |
| | Mastra | Apache-2.0 except `ee/` (Enterprise Edition License 2.0, "not open source") [R] | Growing | **Server/container** (Node) | **ADAPT** — open-core; avoid `ee/` |
| | AutoGen | MIT code / CC-BY-4.0 docs [R]; **archived by Microsoft**; successor Microsoft Agent Framework (MIT [R]) | Archived → migrate | **Server/container** | **DO NOT ADOPT AutoGen**; evaluate Microsoft Agent Framework |
| | Cloudflare Agents SDK | MIT [R] (see (a)) | Pre-1.0 | **Edge only** | **ADAPT** (platform-locked) |
| **(e) Observability** | OpenTelemetry (API/SDK/Collector) | Apache-2.0 [L: headers + https://github.com/open-telemetry/opentelemetry-collector-contrib ] | Mature, CNCF | SDKs edge-capable; Collector **server/container** | **ADOPT** |
| | Prometheus | Apache-2.0 [R] | Mature | **Server/container** | **ADOPT** |
| | Grafana / Loki / Tempo / Mimir / Pyroscope | **AGPL-3.0** since Apr 2021 [R] | Mature | **Server/container** | **ADAPT with counsel** — AGPL; Alloy (agent) Apache-2.0 [R] |
| **(f) Auth/identity/secrets** | Keycloak | Apache-2.0 [R] | Mature | **Server/container** | **ADOPT** for IdP |
| | Ory (Hydra/Kratos etc.) | Apache-2.0 [R] | Mature | **Server/container** | **ADOPT** for cloud-native identity |
| | OpenBao (Vault fork, Linux Foundation) | MPL-2.0 [R] | Growing | **Server/container** | **ADOPT** for secrets |
| | HashiCorp Vault | **BSL 1.1** since 2023 [R] | Mature | **Server/container** | **ADAPT/AVOID as FOSS** — prefer OpenBao |
| **(g) Flags/config** | OpenFeature (+ flagd) | Apache-2.0 [R] (CNCF) | Mature (standard); flagd growing | SDKs edge-capable; flagd **server/container** | **ADOPT** as the vendor-neutral flag standard |
| | Flagship (Cloudflare) | **Proprietary hosted service**; OpenFeature-compatible SDKs; public beta 2026-05-26 [R: https://developers.cloudflare.com/changelog/26/ ] | Beta | **Edge-native** (KV + Durable Objects, sub-ms eval, no outbound calls) | **ADOPT if on Cloudflare**; **GAP: no FOSS Flagship** — use OpenFeature/flagd elsewhere |
| | Unleash | **AGPLv3 from v8.0.0** (source + npm package); official Docker images remain **Apache-2.0**; SDKs permissive [L: https://www.getunleash.io/blog/unleash-moving-to-agplv3 fetched 2026-11-18] | Mature (v8.2.0, Sep 2026); OSS Edge EOL 2026-12-31 | **Server/container** (+ Postgres 15+) | **ADAPT** — run unmodified Docker image (Apache-2.0) or accept AGPLv3; do not fork as SaaS without counsel |
| **(h) Quant/backtesting** | vectorbt | Apache-2.0 **+ Commons Clause** (not OSI-open; no resale as service) [R]; PRO paid | Mature | **Server/container** (Python/Numba) | **ADAPT with counsel** — not FOSS under OSI definition |
| | Backtrader | GPL-3.0 [R]; stale upstream (~2020–2023) | Stale | **Server/container** | **AVOID for new work** (GPL + stale); migrate |
| | Zipline-reloaded | Apache-2.0 [R] | Community-maintained | **Server/container** | **ADOPT** for Quantopian-style equities/futures backtests |
| | QuantLib | BSD-3-Clause [R] | Mature | **Server/container** (C++/Python) | **ADOPT** for pricing/Greeks |
| | LEAN (QuantConnect) | Apache-2.0 [R] | Mature, actively developed | **Server/container** (C#/.NET + Python) | **ADOPT** as research→live engine |
| | NautilusTrader | LGPL-3.0 [R] | Growing | **Server/container** (Rust/Python) | **ADAPT** (LGPL obligations) |
| | TA-Lib | BSD-2 [R] | Mature | **Server/container** | **ADOPT** for indicators |
| **(i) Broker/market-data clients** | alpaca-py (official) | Apache-2.0 [L: https://raw.githubusercontent.com/alpacahq/alpaca-py/master/CONTRIBUTING.md ; PyPI classifier per https://github.com/stelioselmandollani/secondorder/blob/HEAD/recon/06-alpaca-py.md ] | Mature (0.44.0, Aug 2026); 1.5k stars; 1.83M PyPI installs/mo | Python **server/container** (also JS/Go/.NET/Java official SDKs, Apache-2.0 [R]) | **ADOPT** |
| | ib_async (community, replaces ib_insync) | BSD-2-Clause [R] | Maintained (1,750 stars; ib_insync retired after author's death 2024) | **Server/container**; requires TWS/Gateway running | **ADOPT** for IBKR socket API; not official/affiliated |
| | IBKR official `ibapi` | License **not verified [U]** — not confirmed in sources read | Official, maintained by IBKR | **Server/container** + TWS/Gateway | **VERIFY license from IBKR distribution before use** |
| | ibind (IBKR Client Portal REST/WS) | Apache-2.0 [R] | Community, maintained | **Server/container** | **ADOPT/ADAPT** for REST-style IBKR access |
| | schwab-py (community) | MIT [R] | Community | **Server/container** | **ADOPT/ADAPT**; verify against current Schwab Trader API |
| | E*TRADE clients | **Mixed/community wrappers; painful OAuth 1.0a** [R]; pyetrade license **not verified [U]** | Community, fragmented | **Server/container** | **GAP: no verified official FOSS E*TRADE client** — build/adapt wrapper, verify license |
| | ccxt (crypto exchanges) | MIT [R] | Mature (43.8k stars) | **Server/container** | **ADOPT** for crypto venues; does not cover equities/options |
| | yfinance (unofficial Yahoo) | Apache-2.0 [R] | Maintained; unofficial endpoints | **Server/container** | **ADAPT with caution** — no SLA, rate-limited, delayed (see §1.3) |
| **(j) Q8-driven extras** | Feature store / experiment tracking | **No single FOSS standard verified [U]** — Feast (Apache-2.0) / MLflow (Apache-2.0) commonly cited but **not verified in this research** | — | Server/container | **GAP/VERIFY** — research before adopting |
| | Options pricing / vol surface | QuantLib (above) | — | Server/container | **ADOPT** QuantLib; OPRA data itself is licensed (gap) |
| | Eval harness (LLM agents) | Open-source eval frameworks exist but **none verified in this research [U]** | — | Server/container | **GAP/VERIFY** — FinLake-Bench/FINSABER are benchmarks, not a shipped harness |
| | FIX engine | QuickFIX/J etc. commonly cited but **not verified in this research [U]** | — | Server/container | **GAP/VERIFY** |

**Explicit NO-FOSS gaps (name them):** (1) consolidated real-time market data (SIP/OPRA
feeds + exchange entitlements); (2) exchange/venue connectivity and matching;
(3) broker custody, accounts, and execution itself; (4) index membership + GICS
licensing (S&P DJI / MSCI / FTSE Russell / Nasdaq); (5) Cloudflare Workflows engine,
Temporal Cloud, AWS Step Functions hosted control planes; (6) Flagship hosted flag
service; (7) official E*TRADE FOSS client (verified); (8) licensed fundamentals/sentiment
datasets as such (the *clients* may be FOSS; the *data* is not). FOSS covers
orchestration, streaming, storage, agents, observability, auth, flags, and quant
libraries — it does not cover market-data or execution entitlements.

## 10. Technology needs for the j-stack

### 10.1 What the best stack needs (from the engine comparison)

Temporal is the most battle-tested durable engine (deterministic replay, append-only
Event History, 51,200-event / 50 MB limit, mTLS/API-key security, SOC 2 Type 2 —
security model read in full text: https://docs.temporal.io/evaluate/cloud/security).
DBOS (Postgres-native, MIT library), Restate (journal + Virtual Objects, BSL), Inngest
(step memoization, serverless), Cloudflare Workflows/Agents (edge, Durable Objects,
proprietary engine), and AWS Step Functions (Standard exactly-once, 1-year, IAM-native)
each trade determinism, scale, and hosting model differently. **No single engine gives
true exactly-once side effects without idempotent activities/idempotency keys — that is
a stack property, not an engine property.** Comparison sources:
https://docs.temporal.io/guides/reliable-document-approvals ;
https://temporal.io/blog/10-reasons-your-ciso-will-love-temporal-cloud ;
https://www.dbos.dev/ ; https://www.inngest.com/docs/durable-execution/primitives/step-run ;
https://www.anchorterminal.com/compare/inngest-vs-temporal ;
https://www.spheron.network/blog/ai-agent-workflow-orchestration-temporal-inngest-restate-gpu-cloud/ ;
https://developers.cloudflare.com/agents/concepts/workflows/ ;
https://developers.cloudflare.com/agents/agent-class/run-workflows/ ;
https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html ;
https://github.com/swarmproof/awesome-agent-reliability/blob/HEAD/README.md
("Temporal for battle-tested scale; DBOS if you already run PostgreSQL; Restate for a
light journal-based runtime; Inngest for event-driven serverless flow control").
Engine comparison detail (durability, exactly-once, determinism, audit, replay, scale,
security) is in the research record; scale limits carried here: Temporal 51,200 events /
50 MB per workflow; Inngest 4 MiB step results, 32 MiB total run state, 1,000
steps/function, step up to 2 hours; Step Functions Standard 2,000 executions/sec,
Express 100,000/sec, 25,000-event history limit, 90-day retention (secondary);
Cloudflare Agents 30s CPU per request/message/task (secondary); Restate/Cloudflare
security models and DBOS/Inngest security details were not researched — gaps.

The stack needs, derived from the comparison: (1) durable execution with replayable
history as the audit trail; (2) idempotency keys + exactly-once *effect* enforcement at
every external side effect (order, payment) — no engine alone provides this;
(3) deterministic core for research/backtest reproducibility, with non-deterministic
LLM/tool calls isolated behind journaled steps; (4) long-lived human-in-the-loop waits
(days–year) without compute burn; (5) client-side payload encryption + mTLS/scoped
credentials + RBAC + exportable audit logs; (6) saga/compensation primitives for
multi-leg orders and money movement; (7) scale headroom above the tightest limit
(event/history caps) via child workflows / continue-as-new / sharding.

### 10.2 Consolidated technology-needs list

1. **Durable orchestration core:** Temporal (self-hosted MIT) or DBOS (Postgres-native)
   as primary; Restate/Inngest as source-available alternatives; Cloudflare Workflows
   only as an edge complement. Idempotency-key enforcement at every side effect.
2. **Agent layer:** LangGraph (or Cloudflare Agents SDK/Think on the edge) + MCP tool
   servers (Alpaca MCP, Public MCP) + OpenTelemetry tracing; eval loops with
   leakage-robust benchmarks; human-approval gates as first-class workflow primitives.
3. **Streaming:** NATS (low-latency) and/or Kafka (throughput) for quotes/news/filings;
   Redpanda/Pulsar as alternatives with license review.
4. **Data layer:** PostgreSQL (+ pgvector) as system of record; ClickHouse/DuckDB for
   tick analytics and backtests; Valkey for cache/queues; SQLite/libSQL/D1 for edge
   state; Drizzle ORM for TypeScript access; Qdrant/Milvus if dedicated vector search
   outgrows pgvector.
5. **Market-data integration:** versioned universe store (point-in-time membership);
   Nasdaq symbol-directory ingestion (intraday); broker clients (alpaca-py,
   ib_async/ibind, schwab-py) + complementary providers (Finnhub, Polygon/Massive,
   Alpha Vantage) with per-quote feed/entitlement/delay metadata; licensed GICS/index
   data via vendor agreement (no FOSS substitute).
6. **Execution & risk:** broker execution adapters with saga/compensation for multi-leg
   orders; pre-trade risk controls (15c3-5 pattern), kill switches, partitioned capital,
   order-type/asset allowlists; QuantLib + LEAN/Zipline for pricing/backtesting.
7. **Payments:** ACH/wire adapters (Alpaca funding model); maker-checker/four-eyes
   approval workflows with thresholds; immutable payment audit log outside agent control;
   policy gate separating intent/authorization/settlement.
8. **Security & compliance:** mTLS/scoped API keys, RBAC, client-side payload encryption,
   SAML SSO, secrets via OpenBao, SOC 2-aligned audit export (Temporal model); CAT-style
   decision audit trail.
9. **Observability:** OpenTelemetry + Prometheus + Grafana stack (AGPL review) or Alloy
   + Tempo/Loki with counsel sign-off.
10. **Flags/config:** OpenFeature/flagd as standard; Flagship on Cloudflare; Unleash via
    unmodified Docker image only.
11. **Deployment:** regional durable core + edge execution (Workers/workerd) for
    latency-sensitive paths + multi-region resilience planning; colocated execution only
    if market-making (§4.14) is in scope.

**Reconciliation note:** this list is the research record's greenfield view. The j-stack
already has a Cloudflare-native durable core (the one workflow engine, DO/D1 residency,
and the #5272 gap programme); this document does not re-decide that core. Where the list
names a technology the stack already has behind a port (durable orchestration,
observability, flags), the need is read as "the port's contract must cover this", and
where it names something absent (streaming layer, saga primitives, eval harness,
versioned universe store), the need is a gap (§11.2) for its own issue — never a
parallel build.

## 11. What exists, what is missing, what is unverified

### 11.1 What exists

Statuses below are **as stated in the named existing documents** (dated assessments, not
re-verified in this research) and the #5515/#5272 records. Nothing here is a fresh
code claim.

- **IROS target architecture + DAG + remediation plan (P1–P4):** defined in
  [`iros-system-analysis.md`](iros-system-analysis.md) (approved assessment; target:
  cloud-native, AI-native, cloud-agnostic, autonomous multi-agent + RSI); programme
  #1904 (open) owns the target DAG.
- **Subsystem states per that analysis (§3):** ingestion, quant execution, workflows,
  queues, schedulers, data foundation **Built**; job subsystem **Built (Partial)**;
  orchestrators/swarm **Needs Refactoring**; monolithic router handlers **Needs
  Decomposition**; autonomous self-fixing engine **Needs Enhancement**; multi-agent swarm
  negotiator **Needs To Be Built**; in-memory event bus **Retained, with its adapter**.
- **Deterministic execution engine:** 100% deterministic, AI-free quant layer (Black-Scholes
  / binomial pricing, Greeks, technicals, CVaR, position sizing) per
  [`iros-system-analysis.md`](iros-system-analysis.md) §4.3.
- **Autonomous/RSI loop design:** four feedback loops (outcome tracking → telemetry &
  eval → calibration & repair → auto-fix) per §4.4; governed-vs-self RSI, dual modes,
  and sandbox synthesis per [`../agentic/stockcopilot-RSI.md`](../agentic/stockcopilot-RSI.md).
- **Copilot/autopilot surfaces:** HITL vs 24/7 autonomous execution, deterministic risk
  policy envelope (six hard guardrails), DID attestation, chat control per
  [`../agentic/copilot-autopilot.md`](../agentic/copilot-autopilot.md); measured
  capability inventory per [`../agentic/autopilot-capabilities.md`](../agentic/autopilot-capabilities.md).
- **One staged pipeline ruling:** `schedule → queues → feed → gather → store → serve →
  deliver` per [`../business/screener-workflow.md`](../business/screener-workflow.md) §1.
- **Whole-set vocabulary:** defined in #5515 (axes, open registries, defaults,
  no-substitution rule, environment folded into mode). Definition only — the registries
  themselves are unbuilt (§11.2).
- **Engine-gap programme:** filed under #5272 (G1–G10, #5488–#5497, plus #5499, #5515–#5517).
- **Vendor capabilities that exist externally** (per §3.1): self-serve broker APIs
  (Alpaca, IBKR, Schwab, E*TRADE, tastytrade, Public), complementary providers
  (Finnhub, Polygon/Massive, Alpha Vantage), index/venue/classification publishers,
  and the FOSS technologies in §9 marked ADOPT.

### 11.2 What is missing

Each item links to its owning issue where one is known from the records read for
this document (#5515, #5520, the research record). Items marked "filing candidate"
have no owning issue named in those records — they are candidates for the parent to
file after a §5 existing-issues search, not builds started here, and "no issue
coverage found in this research" means only that: no §5 search was run for them
while writing this document.

- **Open registries per #5515 axis** (providers, datasets, universes, sectors, exchanges,
  brokers, assets): #5515 (definition filed; build unsequenced).
- **Defaults:** alpaca/paper broker + nasdaq100 universe everywhere, externalized; TECH
  never a universe: #5516.
- **No-substitution rule:** retire the #4014 broker fallback; unservable capability
  refuses by name: #5517.
- **Universe step serves all indices** (today nasdaq100-only refusal): #5499.
- **Chat/NLQ selection of the data-provider axis:** #5500 (owner decision: build vs
  operator-only by design).
- **Engine gaps G1–G10:** run-context trace seam, observer wiring, policy resolution,
  run-record stamping, audit-ledger coverage, feed spec, capability-registry resolution,
  declared source sets, generic binder, journaled inputs: #5488–#5497.
- **Versioned universe store** (point-in-time membership, effective-dated): required by
  §1.1; no issue coverage found in this research — candidate.
- **Per-quote feed/entitlement/delay/as-of metadata** on quote records: required by
  §1.2; no issue coverage found in this research — candidate.
- **Nasdaq symbol-directory ingestion** (intraday): required by §1.4/§10.2 item 5; no
  issue coverage found in this research — candidate.
- **Finnhub provider** (absent from the repo vocabulary): #5515 notes registry-readiness;
  no build issue — candidate.
- **Forex / forex-options / crypto / futures asset coverage:** largely unconfirmed via
  surveyed broker APIs (§1.2, §3.2); no build issue — candidate, gated on coverage
  verification.
- **Saga/compensation primitives** for multi-leg orders and money movement: required by
  §5/§10.1 item 6; no issue coverage found in this research — candidate.
- **Streaming layer** (quotes/news/filings): required by §5/§10.2 item 3; no issue
  coverage found in this research — candidate.
- **Eval harness for LLM agents** (leakage-robust, §4.17/§7.3): no verified FOSS pick
  (§9j); no issue coverage found in this research — candidate.
- **Feature store / experiment tracking, FIX engine:** no verified FOSS pick (§9j); no
  issue coverage found in this research — candidates.
- **Methodology builds** (§4.1–§4.17): none built by this document; each methodology is
  its own future issue, sequenced by the owner.
- **Licensed-data agreements** (GICS/index membership, SIP/OPRA entitlements): no FOSS
  substitute exists (§9); procurement/licensing, not a build.
- **E*TRADE FOSS client:** no verified official client (§9i); build/adapt wrapper is a
  candidate, gated on license verification.

### 11.3 What is unverified

Carried from the research record's "Could not verify" section. None of these may be
asserted as fact until re-verified live against the named primary source.

1. Russell reconstitution frequency: annual (June) vs semi-annual from 2026 — sources
   conflict; verify with FTSE Russell.
2. IBKR Autonomous Trading launch date (Oct 15 vs Oct 21, 2026) and all autopilot
   parameters — secondary sources only; primary IBKR pages not opened.
3. Robinhood Agents / Coinbase for Agents details — secondary only.
4. SEC Rule 15c3-5 / FINRA 3110 / Notice 15-09 / CAT summaries — secondary only;
   primary SEC/FINRA pages not opened. FINRA 2026 AI-agent report — cited second-hand.
5. GICS sub-industry counts (163 vs 158) — methodology-vintage difference; verify
   against current MSCI methodology on msci.com (proxied PDF URL used in the research).
6. Free official machine-readable constituent lists (S&P 500, Nasdaq-100, Russell) and
   per-symbol GICS file — not confirmed; likely licensed.
7. Schwab Trader API official docs, Alpha Vantage official docs, Restate official docs,
   Bloomberg official docs — not opened.
8. Forex/forex-options/crypto quote coverage for IBKR, Schwab, E*TRADE via API — not
   confirmed in sources read.
9. tastytrade crypto-via-API disabled (2026-06-29) and sandbox delay — secondary only.
10. Polygon→Massive rebrand date/details and Polygon sentiment product — secondary only;
    sentiment unconfirmed.
11. Alpaca Algo Trader Plus $99/mo pricing — secondary summaries only; verify live.
12. Most §9 licenses — reported by secondary comparisons, LICENSE files not directly
    opened (exceptions flagged [L]). Drizzle ORM license disputed (Apache-2.0 vs MIT).
    Cloudflare Think license unverified. IBKR `ibapi` and pyetrade licenses unverified.
    DBOS/Inngest/Restate security models, Cloudflare/Step Functions security details —
    not researched.
13. BlackRock Aladdin, Citadel-type platforms, additional wealth firms — no confirmable
    public detail obtained.
14. Vendor-published Alpaca+Polygon / IBKR+fundamentals reference architectures — none
    found; may not exist publicly.
15. Event-driven/streaming workflow dedicated source; market-making and cross-asset
    methodology dedicated sources — not read; flagged in §4/§5.
16. Feature-store / experiment-tracking / FIX-engine / LLM-eval-harness FOSS picks —
    not verified in this research.
17. No live browser verification was performed for any price, availability, or
    entitlement claim.

## Sources

Grouped by section; URLs copied verbatim from the research record. All were read as
web-search results (`index`) on 2026-11-18 unless marked `fetched` (full page text read
2026-11-18 17:29 UTC).

- **§1:** https://freestaffspullzone.b-cdn.net/La%20Ruta%203/SP500%20Index%20SPGlobal%20Oct%202025.pdf ;
  https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies ;
  https://en.wikipedia.org/wiki/Russell_2000 ;
  https://www.quotelinks.com/russell2000.html ;
  https://stockmarketwatch.com/indices/dowjones/companies ;
  https://btechworld.com/dow-jones-industrial-average-companies/ ;
  https://www.tmgmsea.com/en/academy/trading-academy/what-is-dow-jones ;
  https://investsnips.com/dow-jones-companies-list/ ;
  https://www.quotelinks.com/dow30.html ;
  https://docs.alpaca.markets/docs/about-market-data-api ;
  https://docs.alpaca.markets/us/docs/trading-api-mcp ;
  https://investors.interactivebrokers.com/en/index.php?f=14193 ;
  https://deepwiki.com/go-schwab/trader/4-market-data-api ;
  https://developer.etrade.com/support/frequently-asked-questions ;
  https://developer.tastytrade.com/llms.txt ;
  https://Public.com/api ;
  https://public.com/api/docs/templates/meta-muse ;
  https://www.promptcloud.com/blog/scrape-yahoo-finance/ ;
  https://marketxls.com/blog/yahoo-finance-api-ultimate-guide ;
  https://finnhub.io/docs/api/ ;
  https://www.londonstrategicedge.com/directory/fundamental-data/polygon-io-massive/ ;
  https://www.itechguides.com/products/massive-formerly-polygon-io/ ;
  https://tessl.io/registry/skills/github/fernandezbaptiste/Skrillz/alphavantage-api--alphavantage-api ;
  https://medium.com/coinmonks/stock-market-api-what-it-is-how-it-works-and-how-to-use-it-80b66cc9dbcc ;
  https://classic.nasdaqtrader.com/Trader.aspx?id=SymbolDirDefs (fetched) ;
  https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt ;
  https://bakpao.comeasyouare.workers.dev/melissa-https-www.msci.com/indexes/documents/methodology/1_MSCI_Global_Industry_Classification_Standard_GICS_Methodology_20250220.pdf ;
  https://en.wikipedia.org/wiki/Global_Industry_Classification_Standard ;
  https://docs.stretus.com/reference/markets/ ;
  https://www.quantopia.net/blog/understanding-market-identifier-codes-mic-definition-uses-and-types/ ;
  https://www.juliusbaer.com/fileadmin/legal/20260615-bjb-mifid-ii-execution-venue-list.pdf ;
  https://www.theocc.com/getcontentasset/edaac932-1d30-4c31-899d-e06a5ebaf591/dfc3d011-8f63-43f6-9ed8-4b444333a1d0/encore_dds_overview_implementation.pdf
- **§2:** https://avnit.asbblog.com/2026-07-23-project-Trading-system-vibe/ ;
  https://www.moggy.cat/docs/architecture_overview.md ;
  https://github.com/dtony47/alpaca-mcp-server/blob/HEAD/README.md
- **§3:** https://www.goldmansachs.com/what-we-do/ficc-and-equities/prime-services/agency-lending ;
  https://apis.io/providers/goldman-sachs/ ;
  https://emsx-api-doc.readthedocs.io/en/latest/glossary.html ;
  https://github.com/QuantConnect/Documentation/pull/2637 ;
  http://aistocktradingbots.com/blog/fidelity-api/ ;
  https://snaptrade.com/brokerage-integrations/fidelity-api ;
  https://www.quantt.co.uk/resources/quantopian-alternatives-guide ;
  https://quantbrainai.net/blog/quantconnect-review-2026-algo-trading-platform/ ;
  https://qisagent.com/atlas/
- **§4:** https://en.wikipedia.org/wiki/Ooda ;
  https://resources.rework.com/libraries/leadership/ooda-loop ;
  https://shishin.io/research/factor-investing ;
  https://www.quantt.co.uk/resources/fama-french-model-explained ;
  https://kevin-crotty.com/busi448/pdfs/21_multifactor_models.pdf ;
  https://copyprogramming.com/howto/fama-french-three-factor-model-vs-four-factor-carhart-and-five-factor-model ;
  https://qcaml.com/part-6-algorithmic-trading/ch24-trading-strategies/index.html ;
  https://bookmap.com/blog/pairs-trading-a-deep-dive-into-this-market-neutral-strategy ;
  https://news.alfafinderusa.com/learn/guide-to-event-driven-investing-sec-catalysts/ ;
  https://the-algotrading-book.marketmaker.cc/chapters/05-nlp-bert/095-event-extraction-trading/ ;
  https://www.finmarketiq.com/trading-guides/options-fundamentals ;
  https://optionpilot.ainvest.com/glossary ;
  https://www.hevangel.com/wyandanch-library/docs/read/portfolio-construction.html ;
  https://www.portfoliovisualizer.com/faq ;
  https://www.mdpi.com/2673-2688/7/11/470/pdf ;
  https://www.atlantis-press.com/article/125999560.pdf ;
  https://www.tenderalpha.com/blog/3-quantitative-strategies-based-on-alternative-data/ ;
  https://www.quantengines.com/blog/backtesting-trading-strategies ;
  https://www.freyafinance.com/academy/backtesting/walk-forward-analysis-strategy-validation ;
  https://www.edgekit.pro/tutorials/risk-management ;
  https://www.finantrix.com/articles/10-market-risk-metrics-var-cvar-stress-loss-explained ;
  https://arxiv.org/html/2510.07920v1/ ;
  https://pdfs.assets.alphaxiv.org/2505.07078v5.pdf ;
  https://arxiv.org/pdf/2411.04788 ;
  https://pdfs.assets.alphaxiv.org/2511.07322v3.pdf
- **§5:** https://www.kmrrohit.space/learn/system-design/durable-execution-and-sagas ;
  https://claudeskills.club/skills/workflow-orchestration-patterns-by-wshobson ;
  http://arxiv.cnoctave.top/pdf/2605.13850v1 ;
  https://uat-hr.digitalrealty.com/resources/blog/transaction-latency ;
  https://hfrtai.com/knowledge/how_does_aiops_trading_latency_actually_perform_in_2026_and_what_infrastructure_changes_are_required_to_keep_sub-millisecond_decision_loops_stable.php ;
  https://docs.temporal.io/guides/reliable-document-approvals ;
  https://developers.cloudflare.com/agents/agent-class/run-workflows/
- **§6:** https://futures-media.stonex.com/gfapi/html/133e2886-5411-44b7-b781-2311a45ab540.htm ;
  https://dev.cube.exchange/what-is/supported-order-types ;
  https://www.deutsche-boerse.com/resource/blob/5595126/b1b642626be9f49efd06f6c59b0cbb6e/data/OpenDay2026%20Slide-SpA%20Xetra%20-%20final.pdf
- **§7:** https://www.gaiiinstitute.com/interactive-brokers-autonomous-trading/ ;
  https://aistocktradingbots.com/blog/ibkr-autonomous-ai-trading/ ;
  https://www.trade2spike.com/ai-in-action/interactive-brokers-autonomous-trading-ai-orders-without-approval-coinbase-agents-perps-robinhood-approvals-off ;
  https://blog.traderspost.io/article/ai-agents-agentic-trading-traderspost ;
  https://legalclarity.org/algorithmic-trading-laws-key-cases-and-systemic-risk/ ;
  http://umatechnology.org/automated-trading-vs-human-traders-responsibilities-risks-and-oversight-in-u-s-securities-markets/ ;
  https://en.wikipedia.org/wiki/Recursive_self-improvement ;
  https://aiwiki.ai/wiki/recursive_self-improvement ;
  https://lilianweng.github.io/posts/2026-07-04-harness/ ;
  https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining ;
  https://www.justmalhar.com/blog/evaluator-optimizer-pattern/
- **§8:** https://docs.alpaca.markets/us/docs/funding-accounts ;
  https://docs.alpaca.markets/us/reference/createtransferforaccount ;
  https://www.zamp.ai/blogs/four-eyes-approval-ai-agents-payments ;
  https://bcpartners-llc.com/dual-approval-segregation-of-duties-b2b-payments-controls/ ;
  https://www.itechguides.com/autonomous-b2b-payment-agents-configure-controls-before-they-pay/
- **§9/§10:** https://docs.temporal.io/evaluate/cloud/security (fetched) ;
  https://temporal.io/blog/10-reasons-your-ciso-will-love-temporal-cloud ;
  https://www.dbos.dev/ ;
  https://www.inngest.com/docs/durable-execution/primitives/step-run ;
  https://www.anchorterminal.com/compare/inngest-vs-temporal ;
  https://www.spheron.network/blog/ai-agent-workflow-orchestration-temporal-inngest-restate-gpu-cloud/ ;
  https://developers.cloudflare.com/agents/concepts/workflows/ ;
  https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html ;
  https://github.com/swarmproof/awesome-agent-reliability/blob/HEAD/README.md ;
  https://raw.githubusercontent.com/restatedev/restate/main/LICENSE ;
  https://cloudparts.dev/technologies/agents-sdk/ ;
  https://blog.cloudflare.com/workerd-open-source-workers-runtime/ ;
  https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp ;
  https://github.com/open-telemetry/opentelemetry-collector-contrib ;
  https://www.getunleash.io/blog/unleash-moving-to-agplv3 (fetched) ;
  https://developers.cloudflare.com/changelog/26/ ;
  https://raw.githubusercontent.com/alpacahq/alpaca-py/master/CONTRIBUTING.md ;
  https://resources.rework.com/tools/ai-data-infra/best-vector-databases-2026 ;
  http://13k.eu/en/apis/vector-database-comparison/ ;
  https://github.com/bread04/databricks-challenge-/blob/HEAD/.toolkit/03-backend/docs/repos.md
