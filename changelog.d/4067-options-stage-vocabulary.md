### Options stage vocabulary (#4067)

- The options family's addressable vocabulary is pinned: the 8 execution stages (plan, chainFetch, enrich, screen, risk, persistCanonicalResults, shapeReport, deliver) are what the control plane addresses by (runId, stageId); feed, store and serve are presentation only (deliver is the one id shared with execution stage 8). The catalog partitions the 8 under the 4 display stages, and stageMessage() refuses the display-only ids for the options family.
- Per-format legs: a failed report format (PDF/XLSX/CSV) is partial + marked — the shapeReport stage records "partial" and the failed format's status + error ride the canonical row — and never strands the formats that generated.
- Stale stage mappings corrected in stageRuntimeIds.ts and the stage-family pins: persistCanonicalResults writes mas_reports via recordUnifiedOptionsRun (not the scan-run store mas_opportunity_scans); shapeReport/deliver map to the caller-supplied manual-entry functions.
- #3072's disposition is decided: superseded by #3551 (its share of #3069 is absorbed there); the close comment is drafted with the slice and the close itself follows the merge.
