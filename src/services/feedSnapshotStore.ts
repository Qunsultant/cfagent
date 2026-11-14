/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — RE-EXPORT
 * SHIM. The feed-snapshot store moved behind its port in the
 * data layer:
 *   - port + types + resolver: src/data/feedSnapshotPorts.ts
 *   - DO-SQLite adapter: src/data/doSqliteFeedSnapshotAdapter.ts
 *   - in-memory adapter: src/data/inMemoryFeedSnapshotAdapter.ts
 * This module re-exports the layer so every existing import
 * path and call signature is preserved (ADR 0022 §22 shim
 * rule). New code should import from src/data directly or
 * compose via src/data/createOptionsDiscoveryPorts.ts.
 *
 * ---
 *
 * (The original module documentation follows.)
 *
 * Consolidation #1236 (feed seam): the stored universe snapshot
 * artifact — one symbol's quotes + chains, with asOf + provenance,
 * tenant-scoped.
 *
 * One artifact = one symbol's OptionsDataSnapshot, stored verbatim.
 * Discovery runs are per-symbol, so the artifact is bounded, its asOf
 * is unambiguous (the snapshot's own screen.scannedAt), and a run
 * resolves one artifact per request symbol. The store follows the
 * mas_discovery_runs idiom: idempotent creation + single-line
 * statements (the MockSqlStorage lesson — multi-line column lists
 * silently no-op in the shared mock).
 */
export * from "../data/feedSnapshotPorts";
export { SqlFeedSnapshotStore } from "../data/doSqliteFeedSnapshotAdapter";
export { InMemoryFeedSnapshotStore } from "../data/inMemoryFeedSnapshotAdapter";
