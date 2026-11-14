### Changed

- Auto-merge enrollment now dedupes the head's check rollup by check name before judging green, so a cancelled duplicate run (API-created PRs run a gating workflow twice on one head) can no longer block an otherwise green PR (#4501).
