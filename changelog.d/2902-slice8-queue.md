### Changed

- Server refactor Slice 8 (#2902): queue/scheduled consumers move from `src/server.ts` to `src/server/routes/queue.ts` (moves only); `ensureBreakerDurability` moves to `src/server/routes/core.ts` (contract §2.5 Core prelude). `src/server.ts` 1,404 → 669 lines. Q4 answered: one queue consumer module, ownership stays with the domain ports it calls.
