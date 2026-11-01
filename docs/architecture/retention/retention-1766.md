# #1766 — Data retention: universal retention, snapshot export, orphan sweep, purge-run audit

Parent: #1717 (system-wide duplicate/overlap unification program).
Builds on: #1765 (PR #2684, merged `4b37e9c6`), which created the shared
retention registry. This slice extends that registry; it does not build a
second retention mechanism.

## 1. The shared registry (universal retention)

Source of truth: `retentionRuleFor()` / `retentionRegistry()` in
`src/privacy/privacyDsar.ts`. Every table in the recorded decision
inventory (the `src/security/storageRetention.ts` header, the #635 task
ledgers, the #1701 AgentDB purge, the #2294 outcome feed, and the
research/screener stores) has exactly one rule:

- `action: "bound"` — an age window (`maxAgeDays`), plus a row cap
  (`capRows`) where one applies.
- `action: "keep"` — deliberately not pruned; `reason` is the KEEP
  justification. KEEP is a decision, not an omission.
- `enforcement` — `"enforced"` (a pass or route prunes it now),
  `"at_source"` (the writer prunes on save/submit), or `"carried"`
  (recorded but unenforced, with the blocker in `enforcementNote`).
  A carried rule prunes nothing.
- A table with no rule is never purged by default: unknown tables are
  neither silently invented nor silently deleted.

### Corrections to #1765 (evidence, not preference)

The registry is declarative today — no enforcement reads it — so these
corrections change zero runtime behavior, but every later slice builds
on this registry, so the declarations must match reality:

1. **`mas_messages` is 90d, not 30d.** #1765's registry comment claimed
   30d "matches the existing mas_messages pass". The pass defaults to
   `STORAGE_RETENTION_DEFAULT_DAYS` (90d, `src/security/storageRetention.ts`)
   and the UI advertises 90d; the env override
   (`MAS_MESSAGES_RETENTION_DAYS`) still applies. The registry now says 90d,
   and the #1765 test assertion was updated with this comment attached.
   Narrowing enforcement to 30d would change advertised behavior and is
   an owner product decision, not taken here.
2. **`screener_runs` is a logical name.** No physical table of that name
   exists in DO SQLite. Its physical stores (`mas_opportunity_scans`,
   `mas_discovery_runs`) already enforce 365d + row caps at source under
   the C4 run-store contract. The declared 30d target is carried pending
   an owner product decision to align the two.
3. **`research_runs` at 30d is carried, not enforced.** The track-record
   feed reads `research_runs` directly (`ResearchAgent.getTrackRecord`)
   and research runs write no canonical `mas_reports` row, so pruning
   would truncate track history outright. Enforcement needs a
   track-record source decision first (named follow-up, not silent debt).

### Carried rules and their blockers

- `research_runs` (30d): track-record source decision (above).
- `screener_runs` (30d logical): align with the 365d + caps physical
  enforcement, owner product decision (above).
- `usage_events` (365d, PRUNE-CLASS per #792): rows are split across two
  DOs' databases (Orchestrator + ResearchAgent), so a pass on one
  instance cannot prune the other copy, and the metering readers'
  old-row window is unconfirmed. Enforcement is deferred to its first
  production reader's window decision.

### Explicitly out of scope (per the issue)

- The Postgres adapter: DEFERRED by owner direction 2026-10-26
  ("for now do R1/sqlite"). Not filed, not built.
- Production seed invokes: tracked by open #1546 (referenced, not
  duplicated).
- `chain.run` execution binding: out of scope per ADR 0002.

## 2. Snapshot export (F-38)

Two mechanisms, in priority order for accidental-delete recovery:

1. **Cloudflare PITR (first resort, whole-DB).** SQLite-backed Durable
   Objects support point-in-time recovery to any point in the past 30
   days via bookmarks (`getCurrentBookmark()` /
   `getBookmarkForTime()` / `onNextSessionRestoreBookmark()` — see
   Cloudflare's Durable Objects SQLite storage docs). PITR restores the
   entire database, including KV data, and needs no application code.
   Reach for PITR first for any delete or corruption inside 30 days.
2. **Nightly R2 logical snapshots (this slice, per-table, portable).**
   The nightly `0 4 * * *` retention pass (`POST
   /schedules/trigger-retention`) exports this instance's tables to
   `snapshots/orchestrator/<UTC date>.json` in `REPORTS_BUCKET`
   (manifest version `retention-snapshot-v1-1766`: per-table row dumps
   capped at 5000 rows with truncation flags and SHA-256 content hashes,
   plus a manifest hash). The leg is best-effort and never fails the
   pass; when `REPORTS_BUCKET` is unbound it is skipped, not faked
   (recorded in the pass response as `snapshot.skipped`). Disable with
   `RETENTION_SNAPSHOT_ENABLED=false`; the fail-closed direction is ON,
   because a missing backup is the unsafe state.

Recovery procedure: (a) within 30 days, restore via PITR to a bookmark
before the delete; (b) beyond 30 days, or for a single table, restore
from the nightly R2 snapshots (newest snapshot containing the rows —
truncated tables are flagged in the manifest, so a partial snapshot is
never mistaken for complete); (c) re-import is a manual, reviewed step
— no automatic restore path exists, by design.

Honest boundary: the snapshot leg runs on the shared Orchestrator
instance only. Per-user agent instances are covered by PITR, not by
these legs — a per-instance snapshot would need a per-instance trigger
that does not exist today.

## 3. Orphan sweep (F-58)

Scope: **only** canonical report bodies at `reports/<reportId>.json`
in `REPORTS_BUCKET`, matched against `mas_reports.body_r2_key`.
Orphans arise exactly two ways: a crash between the R2 put and the row
insert (bodies are written before the row), and a failed R2 delete in
`deleteCanonicalReport` (whose failure path names this sweep as owner).

The nightly pass lists the `reports/` prefix (paginated, 5000-object
cap with a truncation flag), plans via the pure `planOrphanSweep()`
(`src/data/retention1766.ts`), and:

- reports every night (`orphans`, `danglingRows`, `scanned`) in the
  pass response and in a `RETENTION_ORPHAN_SWEEP` `mas_events` audit row;
- deletes orphan objects **only** when the operator sets
  `RETENTION_ORPHAN_SWEEP_DELETE` to exactly `"true"` (report-only by
  default, fail-closed);
- never deletes rows: dangling rows (a row pointing at a missing
  object) are reported only — `mas_reports` is KEEP;
- never plans on an unknown referenced set: if the `body_r2_key` read
  fails, planning is skipped entirely, because an empty referenced set
  would read every object as orphaned.

Out of scope by construction: report PDFs (keys under `stocks/` +
`options/` + `goals/` and per-run keys) and `knowledge/` corpus objects
are never listed — the sweep lists only the `reports/` prefix, so the
#1168 definition (a sweep for orphaned REPORTS must exclude knowledge/)
holds structurally. Their metadata lives in DO storage, which has
get/put but no key listing, so a bucket-side sweep cannot enumerate
their referenced set honestly.

## 4. Purge-run audit (F-58)

- Every AgentDB purge via `POST /api/retention/purge` appends a
  `retention.purge` IAAA audit event (actor = the calling platform
  admin, tenant = the resolved tenant, counts from the purge report).
  The report carries `auditOk`: `false` means the append failed and the
  run must not be reported as audited. An audit failure never hides the
  purge result itself.
- The nightly pass already audited itself (`STORAGE_RETENTION`
  `mas_events` row). The new sweep and snapshot legs write their own
  rows (`RETENTION_ORPHAN_SWEEP`, `RETENTION_SNAPSHOT`) from the same
  pass, so no leg's work is log-only.

## 5. Configuration (no production values set)

| Variable | Default | Meaning |
| --- | --- | --- |
| `RETENTION_ORPHAN_SWEEP_DELETE` | report-only | Exactly `"true"` enables orphan deletion. |
| `RETENTION_SNAPSHOT_ENABLED` | on | `"false"` disables the nightly snapshot export. |
| `MAS_MESSAGES_RETENTION_DAYS` | 90 | Pre-existing nightly pass window (unchanged). |

No new mode switch pair was needed: this slice adds capabilities, it
does not fork a divergent contract, so there is no pair to keep behind
one switch. The two env gates above are operator-controlled, fail
closed in their respective safe directions, and are never
caller-configurable (they are env-only, not request inputs).

## 6. Verification

- `tests/retention_1766.test.ts` (17 tests, TDD red-first): registry
  completeness and well-formedness, the mas_messages correction,
  carried rules with blockers, orphan planning (scope, dangling rows,
  fail-closed delete gate), snapshot manifest determinism and
  truncation flags, snapshot enablement, purge audit event shape.
- `tests/privacy_dsar_1765.test.ts` (18 tests): the mas_messages
  assertion updated 30 → 90 with the correction comment attached.
- Affected suites green: `data_foundation_slice6`,
  `schedules_routes_extraction`, `storage-retention`,
  `mas-data-retention`, `job_outcomes_retention` (108 tests total
  across the affected files), plus `tsc --noEmit`.
- Full suite + post-merge CI/Deploy verification are reported in the
  §15 completion comment on #1766, not assumed here.
