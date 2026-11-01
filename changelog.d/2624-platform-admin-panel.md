### Platform Admin side panel: admin items leave the dynamic settings menu (#2624)

- The settings dropdown (`ETradeDynamicMenu`) had grown to fourteen sections, mixing everyday controls with nine administration surfaces. The nine — Ads & Partner Banners, Background Tasks, Scheduled goals, Technical Diagnostics & Provenance, API Keys, Data Providers, IAAA Admin and the Request-admin-access action — now live in a dedicated right-hand **Platform Admin** drawer, opened from one `Platform Admin` row in the dropdown.
- The drawer's menu is externalized config (`src/client/platformAdminConfig.ts`), following the configurable-LeftNavBar idiom from #2529: sections → items with id, label, description and optional icon, so the menu is reshaped without touching the panel component.
- The dropdown keeps the signed-in user status (avatar, display name, `@login`, login provider); the request-admin-access action moved into the drawer's own "Request admin access" section.
- Behaviour of every extracted panel is unchanged — same components, same props, different host. Escape closes the drawer, a backdrop click closes it, a click inside never does, and the drawer lives outside the dropdown's open state so opening it cannot dismiss the panel.
- Bespoke ceiling raised deliberately: braces 3828 → 3845, classes 2610 → 2622 for the 12 scoped drawer classes and its media query.
