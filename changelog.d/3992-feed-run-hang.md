### Fixed

- Feed Run-now hang (#3992): concurrent feed dispatches now claim the instance row atomically (a second dispatch refuses `job_already_running` instead of also executing), the feed execution deadline covers run setup as well as execution so a hung setup leg settles failed with a terminal `FEED_DEADLINE_EXCEEDED` record, the step-level universe hydration carries the refresh bound (`FEED_REFRESH_TIMEOUT`), and the ScheduledAgent feed door bounds ensure + dispatch + settle by name instead of hanging until the async executor backstop.
