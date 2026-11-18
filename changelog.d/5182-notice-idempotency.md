### Fixed

- **One scheduled-options failure notice per run (#5182):** incident #5181 posted the same message twice with one timestamp — the same delivery payload observed twice, not two runs (the transports are fallback-only). `claimNoticeDelivery` now keys on `(runId, rendered text)` for a five-minute window, so the identical second post is suppressed while a different run — or a retry with different text — still delivers. Best-effort per isolate; the root cause (A2A double-post vs a second execution) still wants the A2A log line recorded on the issue.
