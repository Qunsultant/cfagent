### Workflow engine

- **Run recorder: two ledgers, surfaces merge (#3946)**: the engine's D1 job run records are now readable on Workflow Runs, ReportsPanel (`/api/runs`), and RunDetailView (`/api/runs/details`) — merged with the DO ledgers on the existing #3121 linkage and deduplicated on exact identity — while the screener keeps its DO ledgers and the engine keeps D1; an unreadable D1 ledger is named in `storeErrors`, never silently empty. Qunsultant/cfagent#3946
