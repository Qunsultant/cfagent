### Fixed
- Fixed **OODA Nightly Research** (`src/client/options/ResearchRunsPanel.tsx`) showing `Failed: unknown error` on **Run research now** (#5721) by switching panel requests to `apiFetch` so `202 { jobId, statusUrl }` async-job responses poll to completion instead of being treated as failed outcomes.
