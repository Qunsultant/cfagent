### Added

- **A research run names its venue and mode, end to end (#5912, slices 2–3):** `POST /research/run` accepts `{ brokerId, mode }`; the selection rides the engine job's parameters onto the `analyze.ooda` stage (the stage that runs the loop), is handed to the publish entry, and reaches the provider — the run reports what it used on `ResearchReport.brokerId` / `.mode`. The OODA page gains two fields next to **Run research now** (Broker, Mode). A run that names neither takes exactly today's path: two-argument publish calls, the configured default venue, nothing recorded. #ceo-aimp
