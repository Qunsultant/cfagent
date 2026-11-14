/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — RE-EXPORT
 * SHIM. The scan-run store moved behind its port in the data
 * layer:
 *   - port + types + visibility rule: src/data/scanRunPorts.ts
 *   - DO-SQLite adapter: src/data/doSqliteScanRunAdapter.ts
 *   - in-memory adapter: src/data/inMemoryScanRunAdapter.ts
 * This module re-exports the layer so every existing import
 * path and call signature is preserved (ADR 0022 §22 shim
 * rule — no file is deleted; new code should import from
 * src/data directly or compose via
 * src/data/createOptionsDiscoveryPorts.ts).
 *
 * ---
 *
 * (The original module documentation follows, preserved for
 * the store's history.)
 *
 * Opportunity-scan run store (issue #27).
 *
 * Every executed opportunity scan is persisted so a later screen (the
 * Strategy tab) can list recent runs and reload one — the reload is
 * what lets the discovery consumers read the same honest record the
 * runner produced, including partial-coverage markers and zero-result
 * runs. This store is the run-record seam for that flow.
 *
 * Two implementations of ScanRunStore live behind the port:
 * SqlScanRunStore over Durable Object SQLite — the
 * OrchestratorAgent calls this.ensureTable via its own table creation
 * for mas_policy_verdicts, and its storage handle
 * reaches the same SQLite database — and an in-memory implementation
 * with identical semantics, for tests and for contexts with no
 * Durable Object storage handle.
 *
 * Retention: 365 days by generated_at, capped at 1000 rows, enforced
 * on the write path (ADR 0016 / discovery retention decision). The
 * retention clock is the run's own generatedAt: pruning runs relative
 * to the newest run being saved, so a backfilled/replayed run prunes
 * against its own timestamp rather than the wall clock.
 *
 * Visibility (issue #103): a run saved with a userLogin is visible
 * only to that login; a run saved without one (legacy rows, written
 * before per-user scoping) is visible to every caller. The rule is
 * enforced in the SQL list statement itself and in get(): an
 * invisible run reads as absent, never as an error, so run ids are
 * not an existence oracle across users.
 */
export * from "../../data/scanRunPorts";
export { SqlScanRunStore } from "../../data/doSqliteScanRunAdapter";
export { InMemoryScanRunStore } from "../../data/inMemoryScanRunAdapter";
