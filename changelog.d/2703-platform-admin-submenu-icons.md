### Added

- **Platform Admin sub-menu and tab dedicated icons (#2703):**
  - Added 8 dedicated icons to `NavIcons` and `NAV_ICON_MAP` for Platform Admin surfaces: Banners (`ads`), Tasks (`background-tasks`), ScheduledGoals (`scheduled-goals`), Provenance (`provenance`), ApiKeys (`api-keys`), DataProviders (`data-providers`), IaaaAdmin (`iaaa-admin`), and AdminAccess (`admin-access`).
  - Updated `DEFAULT_PLATFORM_ADMIN_CONFIG` and `PLATFORM_ADMIN_NAV_ITEMS` in `src/client/platformAdminConfig.ts` to assign and forward distinct `icon` keys.
  - Updated `LeftNavBar` to render the sub-menu icons in both expanded and collapsed flyout sub-menus with 14x14 scaling.
  - Updated `PlatformAdminPage` horizontal tabs to render dedicated icons alongside labels via `PLATFORM_ADMIN_TABS`.
  - Updated `PlatformAdminPanel` drawer to display dedicated icons in the section navigation list.
  - Pinned `tests/platform_admin_panel_2624.test.tsx`, `tests/left_nav_bar.test.tsx`, and ratcheted `tests/ux_bespoke_ceiling_2177.test.ts` in lockstep.

## Agent #cfo-qunso

Closes #2703

Process documentation impact: None (client UI and navigation iconography refinement).

