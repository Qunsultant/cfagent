### Changed

- **Sharded-chain logging / classification, audit follow-up (#2860, under #2764) #clo-arsi:**
  The scheduled sharded chain bypasses the `runScreen` funnel, so it never
  got the funnel's structured run logging + failure classification
  (#2868). The EXISTING aspects are now wired at the chain's own join
  points (no second system, no behavior change — logging never fails a
  screen, audits and throws unchanged): submission success emits
  `screen.started` (trace_id = chainId, the correlation id the whole
  chain's rows + logs share); submission failure — rejected submit and
  missing port alike — emits `screen.failed` with the classifier's
  verdict, and the inner audit carries the same classification. Remaining
  boundary, stated plainly: in-flight job failures surface via the
  `async_job.failed` audit + job rows, NOT classified — the generic
  executor is shared runtime, so classifying there is a #2621 decision,
  not a stock slice.
