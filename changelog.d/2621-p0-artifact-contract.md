### Added

One options artifact contract (#2621 P0): per-format non-fatal
generation for options runs (`runOptionsArtifactFormats` records a
throwing renderer as that format's failed outcome, never propagates
it), one `assembleOptionsResult()` used by both the sync route and
the sharded serve planner via `assembleOptionsResultForServe()`,
and per-format failed handling in the shard executors/planner so a
failed PDF still ships XLSX+CSV with links only for formats that
generated. No sync/sharded runtime merge, no selection, thesis,
mode, cap, content, delivery, or scheduling change.
