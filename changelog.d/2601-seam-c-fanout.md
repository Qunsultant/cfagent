### Changed

- **Seam C: the workflow parent's shard fan-out is partitioned by the stage-runner contract (#2601, under #2528):** `runParentFlow` in `src/workflows/screenerWorkflowFlow.ts` no longer slices the shard array inline; it builds the shard units, calls `planStageFanout` at the stage cap (`maxParallelShards`, default `DEFAULT_MAX_PARALLEL_SHARDS`, bucket `analysis`), starts the returned units, and queues the deferred tail as the next round. Same batches, same order, same cap — `tests/stage_runner_seam_c_2601.test.ts` pins the 2/2/1 partition, the shared default, and that every shard still starts across rounds; `screener_workflows`, `screener_dual_mode_2530`, `trace_threading_2000`, `goal_screen_workflow_command_1996` and `mesh_g6_workflow_conformance_2409` stay green (116 tests).

### Changed (scope record)

- **#2601 remaining seams recorded as declined, with reasons (#2601):** the poll-loop replacement (reuse step 4) is a behaviour change needing its own approval and child-side event emission, and the DO-alarm narrowing (step 7) would invert the reuse-report order by landing before queue delivery (step 3) and workflow retries (step 4). Both are named in `docs/architecture/business/options-stage-runner-contract.md` §5 as the next runner steps, not silently dropped.
