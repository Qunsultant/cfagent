### Fixed

- Provider verify (`POST /data-providers/:id/verify`) now has a named, configurable deadline: the probe races a `FEED_JOB_VERIFY_MS` knob (default 120s) and settles terminally with `FEED_VERIFY_TIMEOUT` instead of sitting Running forever. Invalid knob values are refused by name. (#4304)
