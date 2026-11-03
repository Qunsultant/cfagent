### Changed
- Nav configuration externalized to `src/client/nav-config.json` (#2977): routes, sections, sub-menus, deep links, deep-link surfaces, and platform-admin items now live in one data file; `routes.ts`, `navConfig.ts`, `deepLinks.ts`, and `platformAdminConfig.ts` are thin loaders over it, with validation pins proving the data file's shape. No behavior change.
