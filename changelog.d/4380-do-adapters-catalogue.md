### Added

- **#4282 P2b — DO adapters catalogue**: the 48 Durable Object adapter/marker modules' schema now lives in `src/data/schemaComponent/doCatalogue.ts` (103 entries — 66 CREATE TABLE, 36 CREATE INDEX, 1 CREATE UNIQUE INDEX); all 49 files (48 adapters/markers + barrel) delegate to it, statement text byte-identical. The grep baseline shrinks 188 → 85, exactly this migration.
