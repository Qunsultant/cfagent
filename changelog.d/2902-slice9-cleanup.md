### Changed

- #2902 Slice 9 (Cleanup): the Worker entrypoint's agent / Durable Object / workflow exports move to `src/server/exports.ts`, re-exported per line from `src/server.ts` (same names, same live bindings; wrangler still requires the entrypoint exports — Q3 answered yes); dead imports pruned per `tsc --noUnusedLocals` (309 bindings); `src/server.ts` 669 → 291 lines, with the size pin set to 291. No behaviour change.
