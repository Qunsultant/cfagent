### Fixed

- Blank-broker schedules now resolve to the alpaca/paper default at run time (#6301): the fire-time guard resolves a pre-F3 unstamped payload from the one defaults home (stored selection → vocabulary default) instead of refusing it, so a blank schedule no longer skips forever — and never resolves to Public.com. A named refusal happens only when the account itself cannot be resolved.
- The runs ledger records the resolved broker/mode for each scheduled run (#6301): the callback outcome carries the guard's resolved binding and the recording wrapper stamps it onto the record, so the BROKER column no longer reads "—" for blank-payload runs.
- The blank-broker repair sweep re-stamps the system-owned strategy-scan baseline on the maintenance path (#6301) and finds + audits any other blank-broker schedule instead of fixing one record.
- The Schedules header, the per-payload broker label, and the research venue line now resolve through the one defaults home (#6301): no more hard-coded "E*TRADE" header on an alpaca/paper tenant and no more "unresolved" flash on reload. The E*TRADE token-renewal callback still reads "E*TRADE" as callback identity.
