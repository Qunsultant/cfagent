### Changed

- **Left-navigation collapse visibility, chevron fixes, execution/marketing regrouping, and unique icons (#2698):**
  - High-contrast sidebar collapse icon: pinned dimensions to 26x26 min with zero-padding override, `color: var(--color-text-primary)`, `stroke: var(--color-text-primary)` with `stroke-width: 2.5`, guaranteeing high-contrast visibility across all themes.
  - Submenu chevron layout protection: reinforced `.submenu-toggle-btn` with `flex-shrink: 0`, `min-width: 28px`, and constrained `.sidebar-nav-item` with `min-width: 0; overflow: hidden;` so wide titles and badges cannot push or clip the chevron.
  - Execution menu regrouping: moved Voice (`voice`) and Omnichannel (`omnichannel`) into Trading/Execution category (`navOrder: 4, 5`).
  - Navigation order refinement: placed Options Screener (`options-screener`, `navOrder: 7`) directly below Stock Screener (`screeners`, `navOrder: 6`), and Chat (`chat`, `navOrder: 8`) directly beneath Goal Screen.
  - New Marketing top-level section: created dedicated Marketing section hosting Referrals (`referrals`), Ad Campaigns (`ads`), and Social Media Engine (`social`).
  - Platform menu refinement: nested API Endpoints (`endpoints`) as a sub-menu under Agent Mesh Registry (`agents`), and positioned Workflows & FAQ (`workflows`) as the final item in the Platform menu (`navOrder: 22`).
  - 100% unique iconography: added distinct SVGs for Contracts, StrategyScan, Flows, Volatility, Goal, Reports, Review, and TrackRecord; ensured all 28 route entries and sub-menus have unique, descriptive icons.
  - Pinned all route derivation, route table, unique icons, configurable navigation, and left nav component tests in lockstep.

## Agent #cfo-qunso

Closes #2698

Process documentation impact: None (client navigation and UI styling refinement).

