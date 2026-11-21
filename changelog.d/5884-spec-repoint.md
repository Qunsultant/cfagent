### Changed

The stock screener definition now runs on the generic five-stage J pipeline: the `screener` spec (v2) is `feed.pull` → `enrich.screener` → `analyze.screener` → `generate.apply` → `screener.deliver`, with the family job ids computed per run from the command's provider (default Alpaca) instead of the six bespoke screener steps. The goal screen is untouched on its own `goalScreen` definition, the deliver node stays bespoke until the deliver flip, and the 2863 criteria stamp now rides the generated screener-report document.
