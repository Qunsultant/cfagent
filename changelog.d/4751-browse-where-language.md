### Added

- **Browse SELECT on the shared where-language (#4751):** the where language gains `$or` (an array of where objects, OR-joined) and `$like` (case-insensitive LIKE) on both legs — the DO repository and the in-memory twin — and `findMany` gains a `raw` read option (storage rows unmapped). The table browser's search is now a findMany-style call instead of the facade's last inline SELECT; browse behaviour is unchanged (same rows, order, and paging, pinned by a before/after test). The facade census moves 21 → 20 exec sites.
