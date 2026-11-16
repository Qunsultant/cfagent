### Changed
- Update `advancedOrders.ts` so E*TRADE `bracket` is marked `emulated` (via separate exit orders) and `oto` is marked `none`.
- Add `ETradeClient.placeBracketExits` and un-refuse `bracket-draft-v1` drafts in `ETradeTradingPlatform.executeOrder` so approved E*TRADE bracket orders place the entry order followed by separate take-profit and stop-loss exit orders (#4667).
