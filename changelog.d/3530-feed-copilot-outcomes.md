### Added
- Feed job runs now record their outcomes in the Autopilot Control Center's job-outcomes feed — one row per settled run (kind "feed", keys + outcome codes + counts only), written at the pipeline host's settle point through the one job-outcome sink — and the Copilot gains `get_feed_job_schedule` / `set_feed_job_schedule` tools over the feed jobs' stored schedules (#3530).
