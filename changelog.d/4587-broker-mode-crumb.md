### Changed

- Top-left crumb shows broker + mode ("Alpaca / Paper") instead of mode alone ("Paper"): the crumb subtitle renders `brokerModeLabel(selectedBrokerLabel, accountMode)`, a helper in `brokerEnvironment.ts` pinned for both modes and both brokers. (#4587)
