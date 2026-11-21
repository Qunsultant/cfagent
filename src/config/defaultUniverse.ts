/**
 * The configured default universe, in the screener registry's stored spelling
 * (issue #5516).
 *
 * Why this is its own leaf module rather than a member of `trading/universes`:
 * the default is read by the stock-screen planner, which several modules call
 * while an import cycle is still evaluating. A value import of the
 * `trading` barrel there makes the whole trading graph part of that cycle and
 * broke the options-screen route (caught by
 * tests/screening_schema_parity.test.ts, #5516). This module imports only the
 * externalized block and a type, so both layers can name the default without
 * an edge between them.
 *
 * The block declares canonical ids (`nasdaq100`); the screener registry keys
 * are the historical upper-case spellings (`NASDAQ100`), so the bridge is the
 * case fold, never a second table. It is registry-free on purpose: `UNIVERSES`
 * is a const that may not be initialized when a planner runs inside a cycle,
 * and reading it there is a TDZ error. `resolveUniverse` refuses an id the
 * registry does not hold, so a configured default that is not a screener
 * universe (a stored index list such as `dow`/`sp400`, or a `sector-*` list)
 * still fails by name, at the one place that indexes the registry.
 */
import { vocabularyDefaults } from "./vocabulary";
import type { UniverseId } from "../trading";

export function defaultUniverseId(): UniverseId {
  return vocabularyDefaults().universe.toUpperCase() as UniverseId;
}
