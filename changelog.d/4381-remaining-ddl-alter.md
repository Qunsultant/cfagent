### Added

- **#4282 P3 — remaining DDL + ALTER reconciliation catalogue**: the long tail of schema outside the catalogue now lives in `src/data/schemaComponent/remainderCatalogue.ts` (51 entries — 8 CREATE TABLE, 2 CREATE INDEX, 39 ALTER reconciliation entries, 1 DROP INDEX ordered entry, 1 seed-form entry); 22 files delegate to it, statement text byte-identical. The grep pin is green at zero — the parent issue's DDL acceptance is met.
