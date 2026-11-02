### Added

- **Swarm cross-screener consensus harness (#1771 slice B, parent #1717):** pure `src/orchestrations/swarmConsensus.ts` (`computeSwarmConsensus`) turns N named screener outputs into a DRAFT consensus set (majority + minSources, deterministic order) with dissent named, never silently dropped; duplicate source names and empty source lists throw. Registry entry `swarm-consensus` flipped to enabled; the harness places no orders and feeds no trade path.
