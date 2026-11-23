### Fixed

- **Settings menu core (Qunsultant/cfagent#6147, S1):** the broker header icon now sits beside the name (`.broker-brand-title` flex-row rule in the token-only sheet; the frozen sheet is untouched); the broker picker derives from the registry, so Interactive Brokers appears visible-but-unavailable with its reason (no execution adapter yet — read-only) and selection of it is refused by name; the settings sections now read Broker, then Environment & Connection, then Data provider. Item 1's close still waits on Ceos's deployed visual UAT under a non-Alpaca broker.
