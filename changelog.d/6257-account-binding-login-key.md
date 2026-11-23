### Fixed

- **Account bindings keyed by login, not DO id (#6257):** the HTTP binding route now keys bindings by the verified login (`x-user-login`) instead of the Orchestrator DO instance id, so login-keyed readers (schedules, orders, autopilot, copilot, NLQ, research) see Settings-written bindings; existing DO-id-keyed entries are copied to the login key on first access (login-keyed entries win on conflict; legacy entries left in place), so already-saved bindings keep working with no manual re-save. #CAIO-quns
