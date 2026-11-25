### Fixed

- **Runaway alarm loop stopped through configuration (#6482):** schedules now arm only at a monthly cadence or slower — the frequency floor defaults to 2,592,000s (30 days, fail-closed), every new schedule is created paused and only an explicit resume activates it, and a firing kill-switch halts all scheduled firings at the one choke point. The floor and kill-switch are externalized (managed settings over env carriers) and manageable from the schedules home. Agent attribution: #CTO-mbshr
