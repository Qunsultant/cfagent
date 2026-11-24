# P6b (#4385) — Survey reconciliation: DO raw DML entry shape

Survey-only. No build, no GitHub writes.

- **Ruling (user, 2026-11-15 ~05:02 EST): Q1 CONFIRMED (b)** — mini-ORM Repository calls as the entry shape, with the residual named-template component. Recorded as comment 6892703417 on #4385.
- **Rulings Q2–Q5 (user, 2026-11-15 ~05:03 EST): "be consistent — use the mini-ORM wherever possible, avoid custom solutions; adjust where necessary."** Q2 ADJUSTED: extend the Repository in P6b for the recurring residual shapes (conditional update/delete + rowsWritten, INSERT OR REPLACE); templates survive only for shapes genuinely inexpressible after the extensions. Q3 re-scope confirmed (catalogue + pins + 9-file tranche, AsyncJob second). Q4: ledger + kv_store funnel both named exemptions in the pin. Q5: the 16 `doSqliteOrmAdapters.ts` statements go with P6c. Recorded as comment 6892725340 on #4385.
- **Base:** `f4b8eff794ce9b40222c017621d6b196f74396df` (tag v0.1.1800 — the P6a
  merge tip). Worktree: `~/workspace/w4282/wt-p6b-survey` (clean).
- **Phase body:** `~/workspace/w4282/phases/P6b-do-raw-dml.md` (base
  `ec614e69`). ADR: `docs/architecture/adr/data/0032-data-access-mechanism-standard.md`
  (merged 2026-11-14 via PR #4562). P6a record: `~/workspace/w4282/S15-4384.md`,
  `~/workspace/w4282/evidence-p6a/GATE-REPORT.md` + `DESIGN.md`.
- **Scan:** `evidence-p6b/scan-do-dml-f4b8eff7.txt` (P6a scan method,
  comment-stripped, quote+keyword starts — see §4).

## Recommendation — (b), with the residual disclosed

**Recommend (b): mini-ORM Repository calls as the entry shape — but not
(b)-pure.** The implementable form of (b) is:

> The DO DML catalogue is ONE surface with TWO entry kinds (the same
> pattern P6a already set: its catalogue holds builder + fragment +
> build entries): **Repository-shaped entries** (P6c's method-level
> form: operation + table + predicate) for generic CRUD, and **named
> raw templates** (the phase body's shape) for the extended operations
> the Repository cannot express. Both carry operation codes
> (`dml.do.<table>.<action>` — already supported by
> `statementCodes.ts`) and run through ONE executor with AOP logging.
> The grep pin is "zero inline raw DML outside the catalogue", satisfied
> by construction.

(b)-pure — "raw DML disappears into the ORM" — is **not literally
achievable**, and the proof is already on main: the ALREADY-MIGRATED
mini-ORM families still hold inline raw SQL for their extended
operations (see §3). (a)-pure and (c) are ruled out by the ADR's own
text (see §2). This is not a silent redefinition of (b): the residual
component is named here, measured in §4, and its shape is the phase
body's own shape — the difference from (a) is that the residual is the
exception, not the rule, and it shrinks as Repository extensions land.

## Why (a)-pure and (c) fail — ADR evidence

1. **The ADR names the target mechanism.** Decision 2: "The hand-written
   DO adapters migrate onto the mini-ORM slice by slice, or get a named
   exemption with the reason recorded in the pin." Consequences:
   "Keeping the mini-ORM unblocks #4282 P6 (DML externalization): the
   DML moves now have a known target mechanism per plane instead of
   three candidates." The DO target mechanism is the mini-ORM — not
   named templates.
2. **(a)-as-final-state is the rejected shape.** Alternatives: "Keep the
   mini-ORM, bounded to exactly the generic families, and leave the
   hand-written DO adapters as-is. Rejected in part: the mini-ORM is
   kept, but 'all agents will use it' — the hand-written adapters
   migrate onto it (or a named exemption), so the standard is one
   abstraction, not two coexisting ones." A permanent named-template
   catalogue alongside the mini-ORM is exactly two coexisting
   abstractions.
3. **(c) does the work twice.** Cataloguing 285 statements as templates
   and then deleting them as each adapter migrates is churn that
   violates the user's unification directive ("no parallel/similar/
   duplicate solutions, one solution for everything"). The template
   code, executor wiring, and pin tests for a migrated family would all
   be throwaway.
4. **The survey deferred the shape to #3260.** "The two planes need
   different catalogue entry shapes, and that shape decision belongs to
   #3260, which is still open" (SURVEY.md line 9). P6b's Requirements:
   "#3260's per-plane standard is the entry shape used (cited in the
   PR)." #3260 is now settled — the phase body's named-template
   recommendation was written under the open-ADR assumption, and the
   ADR's settlement supersedes it as the DIRECTION, while the
   template shape survives as the residual (§3).

## Why (b)-pure fails — code evidence

The Repository (`src/data/ormRepositoryCore.ts`) offers: `findMany`
(equality WHERE only, AND-joined), `findById`, `findOne`, `count`,
`create` (plain INSERT-or-throw), `update` (by-id only + re-read
verification), `upsert` (check-then-act), `delete` (by-id only,
rowsWritten-verified). It has NO conditional update with predicate, NO
conditional/bulk delete, NO INSERT OR REPLACE/IGNORE.

The already-migrated families prove the residual is real.
`src/data/doSqliteOrmAdapters.ts` holds **16 raw-DML statements
(10 write + 6 read)** in its 5 adapter classes, all behind their ports:

- retention SELECTs (messages, events, memory — `WHERE created_at < ?
  ORDER BY … LIMIT ?`),
- `DELETE FROM mas_memory` (clear) and `DELETE … WHERE session_id = ?`,
- recall reads (`LIKE` search),
- `INSERT OR REPLACE` drafts (transactions),
- four status-transition UPDATEs, including
  `WHERE id = ? OR gateway_ref = ?`.

The generic CRUD went through the Repository; the extended operations
kept inline raw SQL. The hand-written adapters' DML is the same shapes:
`claim()`'s guarded UPDATE (`AND status = 'queued'` + rowsWritten
check, `doSqliteAsyncJobAdapter.ts:187,228`), prunes
(`DELETE WHERE created_at < ?`), conditional deletes, `INSERT OR
REPLACE`, custom ordered/limited SELECTs. None of these is expressible
through the current Repository.

Corroboration from P6c's own phase body (read for the boundary, §6):
"ORM-core DML is catalogued as method-level entries (operation + table
+ predicate), not SQL text… the catalogue owns the operation, not the
string." P6c already scoped the Repository-shaped entry kind. P6b's
catalogue reuses it for CRUD; the residual uses the template kind.

## Re-measured inventory (base f4b8eff7, P6a scan method)

| Measure | Phase body (ec614e69) | Fresh (f4b8eff7) |
|---|---|---|
| `doSqlite*` + `doSession*` + `doSchema*` files | 51 | **52** (48 + 2 + 2) |
| Raw-DML statements, all 52 (write / read) | 133 raw / 8 builder | **142 write / 155 read = 297** |
| Raw-DML statements, 48 `doSqlite*` only | — | **136 write / 149 read = 285** |
| `this.sql.exec` call sites (41 files) | — | **343** |
| Total exec sites (all 52) | — | **452** |
| Builder lines (Repository factories) | 8 | **8** (unchanged) |

Notes on the numbers:

- The survey's "133 raw" counts WRITE statements only
  (INSERT/UPDATE/DELETE/REPLACE — the P6a DESIGN.md convention; SELECT
  reads excluded). The comparable fresh number is 136 write in
  `doSqlite*` files (142 across all 52). The estate grew by 3 write
  statements since the survey base; the read surface (149) was never
  counted by the survey but is in scope — the catalogue's codes include
  `read-<table>`, and P6a catalogued reads too.
- The "8 builder" is the 8 Repository factories in
  `doSqliteOrmAdapters.ts` (categories, referrals, ads, external ads,
  webhook nonces, trades, watchlists, options-chain cache) — unchanged.
  The 5 adapter classes + `mas_settings` (direct) make 13 bound tables.
- **43 of 48 `doSqlite*` files carry raw DML.** The ADR's "41 of 48
  run hand-written SQL" counts `this.sql.exec` users (343 sites) — that
  41 includes 5 files that exec DDL only (the dataset adapters on the
  Repository + JobPipeline, whose 8 exec sites are DDL + PRAGMA).
  Seven further files execute SQL through a passed-in `SqlStorage`
  handle. Files with DML: 36 (`this.sql.exec`) + 7 (handle) = 43.
- **9 DO adapter files already use the named-constant pattern**
  (`_SQL` constants): DiscoveryAlert, DiscoveryRun, DiscoverySetup,
  Enrichment, FeedSnapshot, IndexList, IvHistory, ScanRun,
  StrategyProfile. These are the mechanical first tranche (§7).
- The survey's "14 raw lines in Ports files are exactly these
  templates" is a LINE count, not a template count: `asyncJobPorts.ts`
  holds exactly **2** named templates (`ACTIVE_JOB_PAYLOADS_SQL`,
  `LIST_RUNNING_SQL`) spanning 14 lines. The Ports pattern exists in
  exactly one Ports file.
- Boundary files (not adapter DML): `doSchemaMarker.ts` (1 write / 1
  read) + `doSchemaMigrations.ts` (2 / 1) are the migration-ledger's
  own statements; `doSessionStoreAdapter.ts` (3 / 4) is the `kv_store`
  statement funnel; `doSessionFamilyAdapter.ts` is 0 / 0 (KV-backed,
  no SQL). The session family is "stay as-is, not SQL" per the ADR —
  its funnel is a boundary case (§8, Q4).
- ORM-core family (`src/data/orm*.ts` + `src/orm/*`, 5 files): **10**
  raw-DML starts (7 in `ormRepositoryCore.ts`, 3 in `ormFacade.ts`) —
  P6c's scope, not P6b's. The phase body's "~5 lines" counts the core's
  generated-statement shapes.
- **No mechanism-mix pin exists yet**: `tests/global_dd_census_2356.test.ts`
  contains no mechanism/mix/Repository count. ADR Decision 6 says it
  lands with the first migration slice — that is P6b (see §7).

Per-file table: `evidence-p6b/scan-do-dml-f4b8eff7.txt`. Largest
surfaces: AsyncJob 26 (14 write), ResearchStore 16, ProviderConfig 15
(11 write), CanonicalReportStore 15, GoalScenario 12, Challenger 11,
IvHistory 11, JobOutcome 10, OrmAdapters 16 (→ P6c, §6).

## Scope finding: P6b cannot be one Medium slice

The phase body says "5–15 files touched" and its acceptance criterion
is "grep pin for the family goes green: zero inline raw DML outside
the catalogue for the DO family." Those two are mutually inconsistent
with the ADR's migration direction: the pin goes green only when the
LAST of the 43 DML-carrying files migrates or is exempted. The full
migration (43 files, 285 statements, plus Repository extensions where
needed) is Large across several slices, not one Medium slice.

Re-scope P6b as: **catalogue infrastructure + pins + first tranche**
(see §7), with the remaining adapters as follow-on slices (P6b-n) or a
re-scoped P6b series. The pin's rule for tranche slices:
**every DO DML statement is either a catalogue entry or a named
exemption** — exemptions shrink slice by slice, and the family pin
goes green when the exemption list empties. This needs a user ruling
(§8, Q3); the phase body's Size Medium fits the re-scoped P6b, not the
full migration.

## P6b/P6c boundary

`doSqliteOrmAdapters.ts`'s 16 extended-operation statements sit on the
boundary: the file is in P6b's file scope (`doSqlite*`) but the
statements belong to the ORM core's family adapters. **Recommend they
go with P6c**: P6c's method-level entry shape (operation + table +
predicate) fits every one of them (retention selectors, clear, recall
search, status transitions are named methods with predicates), and P6b's
tranche should be the hand-written adapters. Needs a ruling (§8, Q5)
— if the user prefers them in P6b, they go in as templates instead.

## Proposed build plan (re-scoped P6b)

**P6b proper (Size Medium):**

1. **Catalogue infrastructure** in `src/data/schemaComponent/`
   (sibling to P6a's `dmlCatalogue.ts` / `dmlExecutor.ts` /
   `dmlEntries.ts`, or a second entry kind in the same catalogue —
   the build decides, following the existing component idiom):
   - DO catalogue with the two entry kinds: Repository-shaped
     (operation + table + predicate, P6c's form) and named raw
     templates (statement text + params).
   - Executor: fail-closed code lookup (`UNKNOWN_CODE` on unknown),
     `withAspects({ operationName: code })` on every execution
     (reusing P6a's `dmlExecutor.ts` idiom), typed
     `SchemaComponentError` on failure. No raw-SQL entry point — a
     statement without a code cannot execute.
   - Codes: `dml.do.<table>.<action>` (already supported by
     `statementCodes.ts`'s pattern — P6a anticipated the DO plane).
2. **Mechanism-mix pin** (ADR Decision 6): extend
   `tests/global_dd_census_2356.test.ts` or a sibling — counts the
   mechanism mix per family (Repository-bound / catalogued-template /
   exempted), so re-divergence fails CI. Lands here because this is
   the first DO migration slice.
3. **Pin test** (mirror of `tests/dml_d1_catalogue_4384.test.ts`):
   grep pins (no inline raw-DML strings in the tranche files;
   comment-stripped scan), red-team (unknown code throws;
   duplicate code rejected; tampered catalogue fails closed),
   coverage (every migrated operation has an entry; every entry's
   code parses).
4. **First tranche — the 9 already-templated files** (53 statements:
   21 write / 32 read): DiscoveryAlert, DiscoveryRun,
   DiscoverySetup, Enrichment, FeedSnapshot, IndexList, IvHistory,
   ScanRun, StrategyProfile. Their SQL is already named constants;
   moving the constants into the catalogue + wiring codes is
   mechanical and proves the template kind. Conformance suites for
   these families stay green unmodified (a suite that must change is
   a finding to stop and report, per the ADR).
5. **Characterization**: DML behaviour before vs after per adapter —
   identical results via the existing conformance idiom.

**Acceptance mapping (phase body → re-scoped P6b):**

- Grep pin green → for the tranche files + the catalogue surface;
  family-wide green is the series goal, tracked by the mix pin's
  shrinking exemption list.
- Conformance suites green → async jobs (2358), orchestrator tables
  (2359), payments (2360), agent private stores (2361), ORM (2345),
  evidence satellites (2356), data-provider ports (2303), options
  discovery (2337), retrieval, settings (2390) — the suites covering
  the tranche families, unmodified.
- Red-team pin holds → the pin test's sabotage cases.
- "#3260's per-plane standard is the entry shape used (cited in the
  PR)" → ADR 0032 Decisions 2+3 cited; the PR discloses this
  reconciliation and the residual-template component.
- Guarded DML keeps its cursor checks → the template kind carries
  the predicate verbatim + the `rowsWritten` check at the call site;
  the first guarded-update case is AsyncJob's `claim()` — see below.

**Follow-on slices (proposed order, user to confirm):** AsyncJob next
(26 statements — the hard case: guarded `claim()` UPDATEs + cursor
checks; proves the template kind for guarded updates), then
ProviderConfig (15), ResearchStore (16), CanonicalReportStore (15),
GoalScenario (12), Challenger (11), JobOutcome (10), and the remainder
by size. Remaining after tranche 1 + P6c's 16: 216 statements across
33 files.

**Files to touch (P6b proper):** 3 new catalogue modules + pin test +
the 9 tranche files + the mix-pin test file + `statementCodes.ts` /
`catalogueTypes.ts` only if the DO entry kind needs a new kind token
(the `dml` kind + `do` plane already exist — likely no change).

## Open questions needing the user's ruling

1. **Confirm (b) with the residual-template component** (vs (a)-pure)?
   The ADR's text and the already-migrated families' evidence point
   here, but it re-scopes #4385's entry shape — the user's call.
2. **Repository extensions in scope for P6b?** (e.g. `updateWhere` /
   `deleteWhere` with predicate + `rowsWritten` return.) Recommend:
   keep the residual templated in P6b; extend the Repository only when
   a shape recurs in ≥3 families, decided from tranche evidence —
   extending the ORM core is a design change that should not ride
   along silently.
3. **Re-scope P6b to catalogue + pins + first tranche**, with the
   remaining adapters as follow-on slices and the pin rule
   "catalogued-or-exempted"? And confirm the tranche order
   (9 templated files first, AsyncJob second as the guarded-update
   proof).
4. **Boundary cases:** `doSchema*` ledger DML — exempt as the
   migration runner's own statements (like D1's `_migrations` ledger)?
   `doSessionStoreAdapter.ts` kv_store funnel — catalogue its 7
   statements as templates, or exempt as the funnel?
5. **P6b/P6c boundary:** `doSqliteOrmAdapters.ts`'s 16 statements —
   with P6c (recommended, method-level entries) or with P6b's first
   tranche (as templates)?

## Appendix — per-file statement counts (f4b8eff7)

Full table: `evidence-p6b/scan-do-dml-f4b8eff7.txt` (write / read per
file, P6a scan method). Summary: 52 files, 142 write / 155 read.
The 9-file first tranche (53 statements) is marked in §7; the 5
DDL-only files (AnalyzedDataset, DeliveryDataset, EnrichedDataset,
GeneratedDataset, JobPipelineAdapter) hold no DML and are already on
the Repository.

#CDO-mha7
