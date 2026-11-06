### Observability

- **Structured logging foundation (#3515 S2):** central structured logger (`createStructuredLogger`) and the 7 mandatory §2.2 attributes (`trace_id`, `tenant_id`, `actor_id`, `agent_id`, `timestamp_iso8601`, `severity`, `component`) on the observability event schema, carried through the Analytics Engine adapter as queryable blobs. All observability-stream producers migrated; the 697 `console.*` sites are S3.
