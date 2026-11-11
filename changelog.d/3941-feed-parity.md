### Workflow engine

- **Feed parity in workflow residency (#3941)**: feed pulls now execute in the workflow residency exactly as on the ScheduledAgent host — the engine's provider is built by the capture factory with the D1 capture port and the R2-backed metadata store, so the same provider ports, capture wiring, and persisted dataset hand-off apply in either residency; the provider still refuses `FEED_JOB_NOT_CONFIGURED` by name where wiring genuinely cannot be built (R2 unbound, AGENT_DB unbound, no service login for the per-login providers). Qunsultant/cfagent#3941
