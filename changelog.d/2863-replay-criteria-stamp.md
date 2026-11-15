### Changed
- Report replay (#2863, S3, narrowed): the workflow store stage stamps the validated criteria (the run request's filters) onto the canonical copy, so replay reads the criteria from persisted data instead of marking the criteria gap partial. No other replay behaviour changed.
