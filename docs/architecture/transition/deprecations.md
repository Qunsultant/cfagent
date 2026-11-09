# Deprecation ledger

Single ledger for rename-based deprecations (gitops.md §22). Deprecated
files are frozen: no new features, no new consumers, refactoring only
to migrate consumers off them. Deletion needs zero consumers plus an
owner decision plus a gate amendment, and is never part of a program
slice.

## 2026-10-29 — outcome catalog supersedes the error catalog (#2381)

- File: `src/errors/errorAspects.ts` → `src/errors/errorAspects.deprecated.ts`
- File: `src/errors/errorCatalog.json` → `src/errors/errorCatalog.deprecated.json`
- Date: 2026-10-29
- Reason: Issue #2381 replaces the failure-only error catalog with the
  unified outcome catalog (success + failure, outcome-encoded names
  `SUCCESS_*` / `FAILURE_*`). The old cryptic codes
  (`AUTH_*`, `SCREEN_*`, `REPORT_*`, `DELIVER_*`, `SYS_001`, `QUOTE_*`,
  `WATCHLIST_001`, `DATA_001`, `MCP_001`) are retired as emitters;
  pre-rename stored values still resolve at read time through the
  outcome catalog's `legacyAliases` map.
- Replacement: `src/outcomes/outcomeCatalog.json` +
  `src/outcomes/outcomeAspects.ts` (single catalog, single resolver).
- Consumers at deprecation: none — every importer was migrated to the
  outcome module in the same slice (emitters, P1 channel renderers,
  and the report parsers now resolve through `outcomeAspects`).
- Deletion condition: zero consumers (already met) plus an owner
  decision plus a gate amendment; deletion is outside the #2381
  program slices. Retain until the owner confirms no pre-rename
  debugging still needs the frozen originals.

## 2026-11-08 — anti-drift framework supersedes the anti-drift controls document (#3802)

- File: `docs/compliance/anti-drift-controls.md` → `docs/compliance/anti-drift-controls.deprecated.md`
- Date: 2026-11-08
- Reason: Two documents stated the same anti-drift thesis, the same active
  controls, and the same eight mandatory future controls (the standards-set
  survey under #3791 found the duplication). One subject, one home: the
  framework document is the surviving home.
- Replacement: `docs/compliance/anti-drift.md` (single anti-drift home;
  the controls document's one unique control — zero-FOUC pre-paint
  hydration — was folded into its §2 in the same slice).
- Consumers at deprecation: the standards set README
  (`docs/architecture/code/README.md`) and
  `docs/compliance/facts-n-findings-01.md` referenced the controls path;
  both were updated in the same slice. The compliance-docs pin
  (`tests/compliance_docs.test.ts`) now asserts the deprecated path.
- Deletion condition: zero consumers plus an owner decision plus a gate
  amendment; deletion is never part of a program slice.
- Archive addendum (2026-11-09, #3802): the rename above initially left a
  stale un-headered original at `docs/compliance/anti-drift-controls.md`
  (the ship script created the `.deprecated.md` copy but never removed the
  old path). On the user's direction it was moved, unchanged, to
  `docs/archive/anti-drift-controls.md` as a true rename, so the old
  compliance path no longer resolves as a live document. This entry's
  retirement record is unchanged: the frozen retirement copy remains
  `docs/compliance/anti-drift-controls.deprecated.md`.
