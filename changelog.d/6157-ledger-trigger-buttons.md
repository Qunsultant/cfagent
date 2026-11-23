### Added

- **The run ledger can start its two named jobs (#6157):** an **OODA** button and an **Opportunity Hunt** button now sit on the ledger toolbar, beside Refresh. Each starts the job through the seam that already exists — OODA posts the existing manual door (`POST /api/research/run`), Opportunity Hunt uses the existing goal trigger (`POST /api/schedule/goals/:id/trigger`) — then refreshes the ledger, so the run appears as a row like any other. A refusal is reported as a refusal ("Could not start the run: …") and never as a started run. No second trigger path. #CAIO-quns
