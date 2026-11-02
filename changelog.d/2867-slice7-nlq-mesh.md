### Changed

- **Stock screener Phase 2 Slice 7 (#2867, under #2764):** NLQ + mesh onto broker policies — one shard policy (`shardsForUniverse`) shared by the REST broker, the NLQ chat-screen builder, and the mesh door builder, and the NLQ direct fallback planned through the one planner. Plus (runId, destination) delivery suppression in the followup.deliver executor: a claimed pair completes as skipped instead of sending twice, a failed send releases its claim so a retry may send, and email recipients distinguish destinations. No screening semantics change.
