### Platform Admin is a left-nav item with its own sub-menu (#2624 follow-up)

- The administration surfaces are no longer a button inside the settings dropdown: the left navigation now carries a **PLATFORM ADMIN** group with a `Platform Admin` item and the eight sub-items (Ads & Partner Banners, Background Tasks, Scheduled goals, Technical Diagnostics & Provenance, API Keys, Data Providers, IAAA Admin, Request admin access) — the same expand/collapse shape as Screeners.
- Sub-item ids are `platform-admin:<section>`; the nav shell maps them to a drawer section instead of a route, so selecting a sub-item opens the Platform Admin panel at that section. The parent item opens it at the first section.
- The drawer is owned by `NavigationMenu`, not the settings menu, so the destination works on every page — the previous placement inside the settings dropdown is why clicking it looked like it went nowhere when settings was closed or unmounted.
- `PlatformAdminPanel` is now self-contained: ad-banner preferences come from `adBannerConfig` (localStorage with an optional controlled override) and the request-admin-access action posts the same endpoint the settings menu used. No props are required beyond `open`/`onClose`.
- The settings dropdown keeps the signed-in user card (avatar, name, @login, login provider) and nothing else from the admin block.
- Pins updated: `configurable_left_nav` expects five sections (four route groups + the Platform Admin group) and the matching category list.
