### Changed

- **Stock screener Phase 2 Slice 6 (#2866, under #2764):** sharded scheduled runs are planned through the one planner and submitted through the broker's async branch (planFeedStart + the mas_async_jobs shardSubmit port, reused as-is), with the adopted shard-failure rule pinned: a failed or timed-out shard marks the run qualified-partial, never silently dropped and never a whole-run failure while any shard completed; all shards failed fails honestly.
