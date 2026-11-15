### Changed

- Platform Admin splits into two hubs: DataHub (`?tab=data-hub`) owns data providers (with Alpaca sign-in BYOK cards), data lifecycle, and parameters/export downloads; SecurityHub (`?tab=security-hub`) owns IAAA admin, users, admin access, and the user profile section. Both hubs carry their own menu, sub-menu, and URL-synced sub-tabs, and legacy `?tab=platform-admin&view=<moved>` links redirect to the new homes. Platform Admin keeps its seven remaining sections. (#4585)
