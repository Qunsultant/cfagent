### Added
- Schedules (`?tab=schedules`) rendered as a first-class visible menu item under the Platform left-nav section with a dedicated clock/cron calendar SVG icon, active tab synchronization, and default feature flag enablement (#2709).
- Dedicated isometric sandbox container SVG icon for the `sandbox` left-nav menu, replacing the shopping cart icon (#2709).

### Fixed
- Platform Admin horizontal tabs (`PLATFORM_ADMIN_TABS`) horizontal overflow: enabled `overflow-x: auto` and `flex-shrink: 0` on `.ui-tabs` in `primitives.css` so all 8 tabs including "Admin Access" fit cleanly and scroll smoothly on all viewports without clipping (#2709).

