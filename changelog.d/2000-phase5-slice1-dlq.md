### Operations

- **Dead-letter replay + depth alert (Phase 5 Slice 1)** — operator routes to list un-replayed dead-letter records and re-drive one to its source queue with its envelope id intact, backed by a new dead-letter store (migration 0033) and a threshold depth alert over the existing Slack operator channel (#2000).
