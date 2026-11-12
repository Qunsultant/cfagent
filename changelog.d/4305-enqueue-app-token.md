### Fixed

- **The queue call runs on the App token (#4305):** \enqueuePullRequest\ answers FORBIDDEN, \u201cResource not accessible by integration\u201d, to the workflow token (observed on #4320), so the enqueue job now mints the short-lived repository-scoped App token the old enroler used and calls the queue API with it; the labelling job keeps the workflow token. The pin asserts the token wiring. #autoclaw-001
