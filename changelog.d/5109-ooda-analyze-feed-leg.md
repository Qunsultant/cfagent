### Fixed

- OODA analyze step no longer fails deterministically when the feed stage ran: the analyze leg executes the research pipeline on the tenant agent with the persisted feed/enrich and reads the leg's report directly, so an engine-mode run can produce a report.
- The #6250 no-direct-pipeline-fallback rule is narrowed to the agent-turn dispatch section; the analyze leg's feed branch is the leg's primary execution, not a fallback.
