### Fixed
- The trading hub's account-section nav follows the selected broker. It used to render E*TRADE's list for every broker, so an Alpaca tenant had two chips ("Alerts", "Watchlists") that scrolled into sections their panel does not render and two ("Transactions", "Orders") that aimed at E*TRADE anchors instead of the Alpaca panel's own order-history and activity sections, which had no ids at all.

### Changed
- `brokerSectionNav(broker)` is the one place the nav list is decided: E*TRADE keeps its six chips unchanged; Alpaca gets Positions, Order history, Activity and Portfolio Risk — the sections its panel actually renders.
- `Card` accepts an optional `id`, so a section can be a scroll target without a wrapper element or an inline style. Anchored sections carry the new `.ui-anchor` class, whose token-based `scroll-margin-top` keeps the section under the page's sticky chrome (the effect the E*TRADE panels get from an inline style).
