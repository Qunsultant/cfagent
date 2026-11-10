### Fixed

- **The lint and coverage entry points exist again (#3926):** PR #3928 added `eslint.config.mjs`, `scripts/lint-changed.mjs` and the CI wiring, but a later dependency commit restored `package.json` from the shared checkout and dropped the three npm scripts. `npm run lint:changed`, `npm run lint:audit` and `npm run test:coverage` are back, matching what gitops §7 and issue #3926 document. No behaviour change: CI calls the script directly and the coverage step passes vitest flags directly, so the gates themselves were never affected.
