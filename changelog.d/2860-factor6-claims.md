### Changed

- **Factor 6 durable stage claims / checkpoints verified, audit follow-up (#2860, under #2764) #clo-arsi:**
  No code change needed — verified 2026-11-03 that the production claim
  sites are already durable: delivery suppression via the SQL-backed store
  in the one production async-jobs builder (G6 #2913), stage claims via
  the SQL-backed store in the production report helper (G8 #2869), and
  stage-runner checkpoints as a read-only projection over durable
  `mas_async_jobs` rows. The in-memory batch checkpoint tracker has no
  production caller (the durable form in production is the job's canonical
  record / workflow collation). `tests/factor6_durable_claims_2860.test.ts`
  (4 guard pins) locks that verdict: any later slice that wires the
  in-memory tracker into production, adds a second consumer caller, or
  unwires the SQL stores fails first and must answer the durability
  question in that slice.
