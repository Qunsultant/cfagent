### Changed

- **Strategy-scan baseline is a unified-store record (#4236):** arming the hourly full-catalog scan now saves a screen record (id = alarm id, origin `strategy-scan-baseline`) in the unified store, and an already-armed baseline is adopted into the store without re-arming. The Schedules home lists it with a "System baseline" badge naming its system origin, and pause/resume work through the one management path; its runs still land in the ledger. #ceo-aimp
