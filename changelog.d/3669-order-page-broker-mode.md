### Fixed

- Order page (?tab=order) now honors the selected broker and mode (#3669): the ticket shows the selected broker's name and live/paper badge, the connect notice follows the selection (E*TRADE OAuth only for E*TRADE; the Alpaca sign-in card for Alpaca), and E*TRADE's OAuth status is no longer fetched for a non-E*TRADE tenant — an Alpaca/paper tenant no longer sees a permanent "Connect your E*TRADE account" prompt. An unconfigured broker fails the order preview loud and coded (`FAILURE_BROKER_UNAVAILABLE`, 409) naming the selected broker, instead of a raw 500 string.
