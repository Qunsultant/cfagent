### Changed

- **Autopilot cycles record the broker context they ran (#5191, slice 5 of #5187):** the stock-copilot cycle audit now carries `broker` and `mode`, beside the outcome, so a replay or retry can be compared with what actually executed. Triggered Run-now runs already inherit the schedule's stored target (the trigger route forwards the payload, and #5189's fields flow through `RunBrokerContext`), so a triggered options run and its alert name the same broker the schedule chose.
