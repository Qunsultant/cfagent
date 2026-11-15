### Added
- Recorded the architectural decision that tenant creation remains a settings-row write by design (`TENANT_CREATION_MODE = "settings_row_only"` in `src/agents/routes/platformTenants.ts`, derived enumeration via `TenantDirectory`), updated `docs/architecture/business/platform-entity-capability-map.md` §7.11, and pinned the decision with tests (#4603).
