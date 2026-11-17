### Added

- **Triggered dispatch mode (Qunsultant/cfagent#5052):** scheduler Run-now buttons (screen, options analysis, discovery) now stamp `triggered` instead of `manual`; the mode survives the whole pipeline (planner, engine, collation, outcomes) and renders as "Triggered" in Workflow Runs, Docs, and the Autopilot Control Center. The unified options serve record reconciles onto the five dispatch modes — `goal` and `agentic` are dropped (no writer ever stamped them); legacy rows read back as "unknown", never invented.
