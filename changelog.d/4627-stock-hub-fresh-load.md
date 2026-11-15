### Fixed

- Fresh loads of `?tab=stock-hub&view=<tab>` and `?tab=assets-hub&view=<tab>` (including the retired `?tab=screeners` address, which redirects onto assets-hub carrying the view) now land on the tab the URL names instead of the hub default: the Trading Hub no longer passes a hardcoded initialTab when it mounts StockHub / ScreenersHub, so the shared URL-synced-tabs hook reads the view from the URL, falling back to the hub default ("stocks" / "forex") only for the bare URL. (#4627)
