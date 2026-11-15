### Changed

- Queues merges into Schedules (#4574): the dead-letter queue is the sixth Schedules view (`?tab=schedules&view=dead-letter-queue`); `?tab=queues` redirects there. The Queues page's async-jobs copy is removed as covered by the Schedules background-tasks view, and its trade-approvals link goes away with the page (Approvals is the one home). The Queues page file stays, deprecated in place, per the no-deletion rule.
