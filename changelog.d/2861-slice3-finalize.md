### Changed

- **Stock screener Phase 2 Slice 3 (#2861, under #2764):** one persist-then-deliver finalizer (`persistThenDeliverAll`) shared by both REST screen routes. E*TRADE sharded runs previously delivered every shard before persisting any of them; they now persist each shard before delivering it, matching the single-run path, and market-data runs keep their persist-only finalization through the same helper. No screening semantics change.
