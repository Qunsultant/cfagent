### Changed

- Moved 50 live Worker text vars from `wrangler.jsonc` into
  `environment.config.json` (grouped as in the survey §1.5; `WORKSPACE_ROOT`
  moves verbatim at the owner's direction — reserved for a future PortThink
  agent capability). Each moved var leaves its line in `wrangler.jsonc` as a
  comment (name + old value + where it now lives), per the owner ruling of
  2026-11-24. `CF_DEPLOY_VERSION` stays a live var (deploy-stamped).
- Re-pointed the `FeatureFlagPort` env adapter, `getEtapiConfig`, OTEL
  modes, and `readSettingRaw` at the resolved `UniversalEnvContext`;
  migrated all 86 read-site lines (65 from the Phase 1 inventory + 21
  found during implementation).
- The var-count pin now asserts the hard ≤64 cap: deployed total is
  1 text var + 40 secrets = 41 < 64 (was 51 + 40 = 91 against the
  Free-plan cap of 64). No setting changes value.
