### Fixed

- Feed dispatch settle bound (#6710): the feed-run routes race the pipeline-host door dispatch against the externalized door bound and refuse `FEED_DEADLINE_EXCEEDED` by name when the host never answers; workflow dispatch status reads and starts race the remaining dispatch budget; ScheduledAgent startup legs are bounded so a hung leg cannot wedge the host startup gate.
