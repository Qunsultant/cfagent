### Fixed

- The post-login alias step (`runWiredPostLogin`) now records the
  id-migration when it hits `ALIAS_CONFLICT` and the aliased id
  holds no live memberships. The #6182 lookup fix could only follow
  a migration record that existed; in production none did — the
  #1182 migration no-ops forever once the provider key holds a
  fresh derived-id binding, and the #1208 repair grants never wrote
  one — so a migrated login kept resolving to the retired id and
  the Users view showed only the revoked membership. The repair
  writes the retired→derived record (best-effort, never fails the
  login), reports a distinct `migration-recorded` alias status via
  the #1760 audit seam, and refuses when the aliased id holds a
  live membership (true login recycling stays for operator
  resolution). The alias itself is never re-pointed.
