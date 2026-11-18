### Audit append substrate: append-only table (#3251 O1)

- The IAAA audit log's append substrate is now the `iaaa_audit_events` append-only table in the same SessionStore DO SQLite (one row per event; append = tail point-read + COUNT(*) cap check + one row insert), behind `AUDIT_PORTS_ENABLED` — the flag-ON composition writes the table, flag-OFF keeps the segment bytes.
- A table append reads a constant 3 rows and writes 1 at any fill (pinned); a segment append at full store still reads the whole store behind 11 rows.
- Migration (`audit-migrate` op, or lazy on first table append) explodes segment rows into event rows, byte-identical per event, chain order preserved; old segment rows are retained in this slice.
- The 22,000 cap is unchanged and exact on the table; cap refusal is still `AUDIT_STORE_FULL` data.
- Cutover procedure: deploy, then flip `AUDIT_PORTS_ENABLED` after the deploy settles — a stale flag-off isolate appending to segments after the first table append would fork the two views.
