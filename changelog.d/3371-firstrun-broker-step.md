### Fixed
- First-run step 3 (connect your brokerage) asks the selected broker. A tenant on Alpaca is no longer told "Your E*TRADE account is connected" nor offered a **Connect E*TRADE** button that redirects into E*TRADE's authorization: the step now says that Alpaca signs in with an API key pair from the Alpaca panel in the trading view, and continues. No `/api/etrade/oauth/status` request is made for a key-pair broker.

### Changed
- `firstRunBrokerStep(broker)` derives the step from the broker catalogue's credential kind, so a third broker cannot arrive without an answer. E*TRADE's step is unchanged: same status read, same connected/not-connected copy, same Connect button and redirect.
