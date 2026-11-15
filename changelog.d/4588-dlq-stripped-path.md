### Fixed

- Dead-letter queue routes match the Worker-stripped path (`/ops/dlq/records`, `/ops/dlq/replay`): the Worker strips the `/api` prefix before forwarding to the DO, so the previous `/api/ops/dlq/*` match never fired and the Schedules dead-letter-queue tab failed to load with a 404. (#4588)
