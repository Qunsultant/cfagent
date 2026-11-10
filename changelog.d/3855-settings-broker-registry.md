### Changed

- Settings broker list is registry-driven (#3855): the Broker menu renders the broker list derived from `BROKER_CATALOG` instead of its own hard-coded two-entry list, so registering a broker (catalog entry + presentation) surfaces it in settings with no settings-UI edit, and unregistering one removes it. The per-broker connect section now switches on the broker's credential kind (key-pair vs OAuth) instead of its id, and mode words/badges come from `brokerPresentation` everywhere in the menu. E*TRADE and Alpaca behaviour is unchanged.
