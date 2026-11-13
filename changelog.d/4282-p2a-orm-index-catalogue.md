### Added

- **#4282 P2a — ORM + index-schema catalogue**: the 7 shared `mas_*` tables, the 5 ORM-only tables, and the 8 executable index statements now live in `src/data/schemaComponent/ormCatalogue.ts` (22 entries); `ensureSharedTable` / `ensureAuditChainColumns` and the 4 index-schema modules delegate to it. The grep baseline shrinks 210 → 188, exactly this migration.
