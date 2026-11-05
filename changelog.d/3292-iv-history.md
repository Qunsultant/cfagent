### Changed

- **IV history is declared per broker (#3292 close-out):** the series is collected from E*TRADE option-chain snapshots by a scheduled job, so an Alpaca tenant had no data and no statement. `ivHistory` joins `BrokerOperation` (E*TRADE true, Alpaca false), and `IvHistoryPanel` refuses before issuing the request — naming the broker and saying that no series is synthesised in its place, because deriving one from a single snapshot would be a manufactured curve. #ceo-aimp
