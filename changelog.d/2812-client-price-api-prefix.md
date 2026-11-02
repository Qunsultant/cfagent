### Fixed

- **Route commercial price calls through the /api prefix** — the price UI fetched the bare `/payments` path, which the Worker never forwards to the DO, so reads and writes 404'd live while the UI silently fell back to Unknown (Qunsultant/cfagent#2812).
