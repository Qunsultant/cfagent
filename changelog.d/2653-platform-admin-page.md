### Added

- **Platform Admin dedicated tabbed page (#2653):** Promoted Platform Admin from an overlay drawer dialog into a dedicated full-page destination (`PlatformAdminPage.tsx`) in the main viewport (`<main className="tab-viewport">`). Implemented horizontal tab navigation (`Tabs`/`TabPanel`) covering all eight administrative sections (`ads`, `background-tasks`, `scheduled-goals`, `provenance`, `api-keys`, `data-providers`, `iaaa-admin`, and `admin-access`). Wired left-nav menus and sub-menus to navigate directly to the page with URL state persistence (`?tab=platform-admin&view=<section>`), and updated route table and navigation identity pins per §7.

## Agent #cfo-qunso

Closes #2653

Process documentation impact: None (client UI and navigation enhancement).
