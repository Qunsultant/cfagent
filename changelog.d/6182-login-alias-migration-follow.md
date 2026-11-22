### Fixed

- The login-alias lookup (`lookupInternalUserIdByLogin`) now follows the
  id-migration record (#1182) from the aliased id to the current derived
  id. After a login-time binding migration, the login alias still names
  the retired id (the alias layer refuses to re-point it), so every
  login-keyed reader — the Users view, the dispatch gate, tenant
  bootstrap — resolved a migrated login to the retired id and read the
  revoked memberships. The lookup now follows the migration chain (cycle
  and corrupt-record safe), so a migrated login resolves to the live
  memberships. The gate itself is unchanged: it still denies on a
  genuinely revoked or expired membership.
