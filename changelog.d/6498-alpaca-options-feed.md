### Alpaca options snapshots default to the indicative feed (#6498)

- **The shared config now implements its documented default.** `buildAlpacaOptionsConfig` uses `ALPACA_OPTIONS_FEED` when set, and `indicative` (the free, no-OPRA-subscription feed) when it is unset or empty. This is the fix specified by the #6237 RCA: the snapshots request was sending no `feed` parameter, so Alpaca returned HTTP 400 and the options-chain assemble step had no evaluable symbols.
- **One point, every consumer.** The default lives in the one config builder used by the screen chain, options screener, strategy screen, goal options leg, and OODA's Alpaca live path — no per-job patch and no new options path.
- **Pinned:** absent/empty env → `indicative`; explicit `opra` wins; the snapshots request carries `feed=indicative`.
- OPRA remains an explicit owner decision (agreement + subscription + `ALPACA_OPTIONS_FEED=opra`), tracked on #6318.
