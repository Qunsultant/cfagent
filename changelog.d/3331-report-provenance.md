### Fixed

- **A screener report no longer claims E*TRADE for another broker's run (#3331, programme #3292):** `screenerProvenanceLines` hardcoded "Quotes: E*TRADE live snapshots" for every non-Yahoo run, so an Alpaca run's PDF described quotes it never read. The lines now follow `ScreenerRunResult.broker` (and `environment`, rendered as `(paper)` / `(live)` when the run recorded one), and a legacy run without provenance keeps the E*TRADE wording — because that is what produced it, not whichever broker happens to be selected now. Yahoo runs and their fallback wording are unchanged, and CSV payloads stay provenance-free.

#ceo-aimp
