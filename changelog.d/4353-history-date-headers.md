### Changed

- **Execution history carries its date (#4348 S6d, #4353):** every audit/history row renders a date **and** a time (one formatter, `formatAuditTimestamp`); a row with no recorded instant says "not recorded" instead of showing today's date or "Invalid Date".
- **One heading row per section:** the audit trail's name, its event count and its description ("Schedule execution history") now share one heading line, and the schedules list's name, count and "Every durable schedule, one row each" do the same. The table no longer stacks a second title above itself; the section is labelled by its heading, so nothing is lost for assistive technology. #autoclaw-001
