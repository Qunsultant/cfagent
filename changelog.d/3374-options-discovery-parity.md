### Fixed
- Options discovery run history is scoped to the broker that produced it (#3374, programme #3292). `GET /api/etrade/options/discovery-runs` and `/:id` used to scope by login only, so an Alpaca tenant reviewed E*TRADE-produced runs as their own research. Both routes now resolve the tenant broker and answer a broker without the capability with a coded `501 provider_unsupported` naming it, before any store read.

### Changed
- `optionsDiscovery` is declared per broker in the catalogue — E*TRADE `true`, Alpaca `false`. Discovery is the one options surface whose engine is wired to a single broker (`createDiscoveryService` builds ETrade chains), so it is stated as a capability rather than routed elsewhere; the declaration flips to `true` the day a second source is wired, as `optionsScanner` did in #3327.
- The Discovery runs panel refuses before its first request and renders the named absence. E*TRADE is unchanged: same envelope, same user scoping, same store read.
