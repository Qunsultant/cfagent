### Changed
- Top-menu sub-menus (#2996): in top layout, entries with sub-menus now render a dropdown (ui Menu primitive) sourced from the left-nav config with the sidebar's feature-flag gating, instead of a flat button that hid the sub-menus. Menu-only parents (Orders, Sandbox) get their own strip entries that toggle without navigating. Entries without sub-menus keep their flat-button behavior.
