### Fixed

- The settings menu names the selected broker from `brokerPresentation` instead of a local ternary whose fallback was `"E*TRADE"` (#3419). That fallback is how the menu kept saying E*TRADE after a broker switch.
- The environment line reads the broker's own mode word (#3419): E*TRADE's test side stays "Paper sandbox", Alpaca's becomes "Paper trading". `modeWord` joins `modeBadge` in the presentation module, so the noun and the badge cannot drift apart.
- Removed the dead `selectedBroker` binding left behind by the label change (#3419).

### Verified (no code change needed)

- Exactly one environment is active per broker: both Paper/Live buttons derive their `active` class from the single `isLive` value that comes from `useBrokerEnvironment()`, and the server stores one environment per tenant. The new suite pins that structure so a second "mode list" cannot be introduced later.
