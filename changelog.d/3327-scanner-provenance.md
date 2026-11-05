### Added

- **Scan history is the selected broker's evidence (#3327, programme #3292):** the scan engine was already neutral (#3272), but a saved run did not say which broker's chains produced it, so an Alpaca history could only have been E*TRADE rows relabelled. `ScanRunSummary.broker` now records it, `save({ broker })` stamps it, and `list({ broker })` scopes reads to the selection. Provenance rides inside `summary_json`, so no column migration is needed; a run saved before this change was E*TRADE's (the only broker wired then) and reads back as `etrade` — never as another broker's run. `brokerSupports("alpaca", "optionsScanner")` is now `true`, and the client guard remains for any broker that lacks the capability (refused by name, before any request).

#ceo-aimp
