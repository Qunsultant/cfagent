### Fixed
- Left-nav tab links now switch the tab they point to: the shared URL-synced-tabs hook only listened for back/forward (popstate), so a left-nav click that changed only the view (e.g. Stock Hub Stocks to Run a New Screen) moved the URL but left the displayed tab unchanged. The hook now also follows the router's routechange event, which covers every hub using it.
