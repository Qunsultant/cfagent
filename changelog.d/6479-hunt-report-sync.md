### The hunt report page and PDF read one view model (#6479)

- **One content source.** `buildOpportunityHuntReportModel(result)` now produces the report's summary headline, counts narrative, holdings/no-setups notes, table cells, per-symbol section text, chart selections, and methodology. The page's `OpportunityHuntReportView` and the PDF's `renderOpportunityHuntPdf(model)` both render that model; `generateOpportunityHuntPdf(result)` is the thin build-then-render wrapper.
- **The page shows the counts section too.** The "How the counts add up" explanation the PDF already carried is now on the page, character-identical, along with the same methodology and timestamp wording.
- **A pin makes divergence fail.** The sync suite renders both surfaces from one sentinel model whose strings the underlying result never contained: a renderer that re-derives content fails. A second pin runs a production-shaped result through both real entry points and compares the shared strings.
- A legacy `result.summary` field can no longer make one surface disagree: the model recomputes the headline from the run's counts.
