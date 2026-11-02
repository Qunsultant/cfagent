### Tenant isolation: creator-owned report confirmations (#2664)

- Report confirmations are now creator-owned: `mas_report_confirmations`
  gains `created_by` (fresh DDL + probed migration), and deciding another
  user's held delivery returns a typed 403 before any status or expiry
  read. Legacy rows fall back to the linked report's owner through the
  read port; pre-#308 orphan rows keep the pinned embedded-payload
  fallback.
- Stored-report delivery is owner-checked: delivering a report owned by
  another login returns `missing`, never the row.
