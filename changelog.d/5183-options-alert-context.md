### Fixed

- **Scheduled options failures now say what failed (#5183, slice of #5187):** the Slack notice carried only the universe, thesis, error and time — four identical copies of it in incident #5181, none naming the schedule, dispatch, workflow, mode or broker. `optionsFailureAlertText` (`src/services/optionsRunAlertFormat.ts`) renders one context line — `dispatch scheduled · schedule … · workflow optionsScreenWorkflow · mode live (pin) · broker … · run …` — from the same values the run resolved, with `unknown` for anything unresolved, and no token or stack trace.
