### Fixed

- Voice desk follows the selected broker (#3418): the header, the welcome sentence and the transcript speaker read that broker's name ("Alpaca Voice Trading Desk"), instead of telling an Alpaca tenant they are on the E*TRADE desk. The desk name, speaker name and bot handle come from `src/trading/brokerPresentation.ts`.
- Omnichannel desk follows the selected broker (#3418): the Slack bot handle, the default email subject, the "before live … execution" sentence and the status badge all name the selected broker and its mode. `ETradeAgent` is no longer rendered for an Alpaca tenant.
- An unrecognised broker id is described as a selection ("Selected broker", "Voice Trading Desk", "TradingAgent") rather than inheriting E*TRADE's name.
