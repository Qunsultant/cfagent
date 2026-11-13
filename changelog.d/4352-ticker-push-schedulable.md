### Changed

- **The ticker push is schedulable like any other job (#4348 S6c, #4352):** its row now offers **Pause / Resume** and **Edit frequency**, and both are real — a pause cancels the push and is recorded on the feed's one record (`state: paused`, `definition.paused`), so a restart, a new connection or a push never re-arms it; resume clears the pause and arms again; a cadence the operator sets is the interval the feed arms, with a 5-second floor refused by name (and a cron body refused with the honest alternative — a live feed has no cron phase).
- **Deleting a live feed is refused, naming the alternative:** a feed has no definition to delete; its record *is* its state and the agent rewrites it on the next push, so the 400 says "pause it instead of deleting it" rather than pretending a delete worked.
- The health badge (Healthy / Idle / Missed push) stays on the row: scheduling the feed does not lose the feed's own state. #autoclaw-001
