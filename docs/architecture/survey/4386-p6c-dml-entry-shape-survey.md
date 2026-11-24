# P6c (#4386) — Survey reconciliation: ORM-core DML entry shape

Survey-only. No build, no GitHub writes, no commits.

- **Base:** `7d81cd93f964aefbf0d3952e93708b1d2d17539b` (tag v0.1.1820,
  2026-11-15 15:41:50 +0000). Worktree: `~/workspace/w4282/wt-p6c`
  (clean, donor node_modules symlinked).
- **Phase body:** `~/workspace/w4282/phases/P6c-orm-core-dml.md` (base
  `ec614e69`). Survey: `~/workspace/w4282/SURVEY.md` §2/§2.1/§2.2/§7.
  ADR: `docs/architecture/adr/data/0032-data-access-mechanism-standard.md`
  (merged 2026-11-14 via PR #4562 — the phase body's ADR block is
  RESOLVED, see §2).
- **Rulings honored:** Q1 (b) Repository calls are the entry shape
  (comment 6892703417 on #4385); Q2–Q5 "be consistent — use the
  mini-ORM wherever possible, avoid custom solutions; adjust where
  necessary" (comment 6892725340); Q5: the 16
  `doSqliteOrmAdapters.ts` statements go with P6c.
- **Scans:** `evidence-p6c/scan-orm-core.mjs` (adapted from the P6b
  scanner; comment-stripped quote+keyword starts, with line numbers
  preserved) → `evidence-p6c/scan-orm-core-7d81cd93.txt`;
  `evidence-p6b/scan-do-dml.mjs` re-run on current main →
  `evidence-p6c/scan-do-dml-7d81cd93.txt`.

## 1. Measured inventory on current main (7d81cd93)

### 1.1 The mini-ORM core: six modules + the shim

| Module | Lines | DML write | DML read | Notes |
|---|---|---|---|---|
| `src/data/ormRepositoryCore.ts` | 390 | 5 | 4 | the generator: 9 statement templates |
| `src/data/ormFacade.ts` | 699 | 0 | 3 | operator-surface browse/count reads |
| `src/data/ormSchema.ts` | 175 | 0 | 0 | DDL only (8 exec sites, P2a-catalogued) |
| `src/data/createOrmPorts.ts` | 96 | 0 | 0 | composition root, no SQL |
| `src/data/doSqliteOrmAdapters.ts` | 513 | 10 | 6 | **the 16 (Q5) — §1.2** |
| `src/data/inMemoryOrmAdapters.ts` | 501 | 0 | 0 | JS-Map twin, 0 exec sites |
| `src/orm/index.ts` + `src/orm/schema.ts` | 51 | 0 | 0 | §22 re-export shims |
| **Total** | **2,425** | **15** | **13** | **28 statements** |

The six modules are 2,374 lines (phase body said "~2,100" — stale,
§2). No core file has been touched since the P6b merge
(`git log c2770943..HEAD` on the six modules + `src/orm/` is empty),
so these numbers are stable.

### 1.2 The 16 `doSqliteOrmAdapters.ts` statements — enumerated

Confirmed: **10 write / 6 read**, byte-for-byte the P6b
reconciliation's count. Each is a named method on a Repository
subclass (or the direct settings adapter):

| # | Method (class / table) | Statement | Kind |
|---|---|---|---|
| 1 | `idsCreatedBefore` (Message / mas_messages) | `SELECT id … WHERE created_at < ? ORDER BY created_at ASC LIMIT ?` | read |
| 2 | `deleteBySessionId` (Message / mas_messages) | `DELETE FROM mas_messages WHERE session_id = ?` | write |
| 3 | `idsCreatedBefore` (EventLog / mas_events) | `SELECT id … WHERE created_at < ? ORDER BY created_at ASC LIMIT ?` | read |
| 4 | `clear` (Memory / mas_memory) | `DELETE FROM mas_memory` | write |
| 5 | `keysUpdatedBefore` (Memory / mas_memory) | `SELECT key … WHERE updated_at < ? ORDER BY updated_at ASC LIMIT ?` | read |
| 6 | `search` (Memory / mas_memory) | `SELECT key, value, updated_at … WHERE lower(key) LIKE ? OR lower(value) LIKE ? ORDER BY updated_at DESC LIMIT ?` | read |
| 7 | `listRecent` (Memory / mas_memory) | `SELECT key, value, updated_at … ORDER BY updated_at DESC LIMIT ?` | read |
| 8 | `replace` (Ledger / mas_transactions) | ``INSERT OR REPLACE INTO mas_transactions (<cols from map>) VALUES (…)`` (template-assembled columns) | write |
| 9 | `completeWithGateway` (Ledger) | `UPDATE mas_transactions SET status='completed', gateway_ref=?, … WHERE id = ?` | write |
| 10 | `rejectWithNote` (Ledger) | `UPDATE mas_transactions SET status='rejected', … WHERE id = ?` | write |
| 11 | `completeByIdOrGatewayRef` (Ledger) | `UPDATE mas_transactions SET status='completed', … WHERE id = ? OR gateway_ref = ?` | write |
| 12 | `completeById` (Ledger) | `UPDATE mas_transactions SET status='completed', … WHERE id = ?` | write |
| 13 | `get` (SettingsRead / mas_settings) | `SELECT value FROM mas_settings WHERE key = ?` | read |
| 14 | `set` (Settings / mas_settings) | `DELETE FROM mas_settings WHERE key = ?` | write |
| 15 | `set` (Settings / mas_settings) | `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)` | write |
| 16 | `delete` (Settings / mas_settings) | `DELETE FROM mas_settings WHERE key = ?` | write |

Split by the P6b executor's dispatch rules (§3): **12 fit the
repository form, 4 need the template form** — see DESIGN.md §2.
The 4: #4 `clear` (an unpredicated DELETE — `deleteWhere`
fail-closed refuses an empty predicate), #6 `search` (LIKE +
OR disjunction — the Repository's where language is AND-joined
equality/operators only), #8 `replace` (INSERT OR REPLACE —
no `createOrReplace` method exists; columns are template-assembled
from the map), #11 `completeByIdOrGatewayRef` (OR disjunction).
Note #8 needs the parameterized-entry form (columns as parameters)
either way — the same form §2.4 of the survey says the catalogue
needs for `orchestratorMigration.ts`'s `${table}` case.

Tables bound in this file: **14 distinct tables** — 13
Repository-bound (5 subclasses + 8 factories: messages, events,
memory, transactions, reports, categories, referrals, ads,
external_ads, webhook_replay_nonces, trades, watchlists,
options_chain_cache) **+ mas_settings direct** (the Settings
adapters implement their ports directly; they do not extend
Repository). The "13 tables" in the mix pin, the repositoryPorts
header, and the step-3a census is the Repository-bound count;
mas_settings is the 14th. The survey's "13 files build on it"
is this table count misread as files (§2).

### 1.3 The 12 core templates (generator + facade)

`ormRepositoryCore.ts` (9) — the Repository's own SQL generation.
Every template is table-parameterized (`${this.tableName}`) except
the chained tail read, which hard-codes `mas_events`:

| Method | Template |
|---|---|
| `findMany` (:151) | `SELECT * FROM ${table} ${where} ${orderBy} ${limit} ${offset}` |
| `findById` (:157) | `SELECT * FROM ${table} WHERE ${idField} = ? LIMIT 1` |
| `insertRecord` (:180) | ``INSERT${orIgnore ? " OR IGNORE" : ""} INTO ${table} (…) VALUES (…)`` (shared by `create` + `createOrIgnore`) |
| `updateWhere` (:236) | `UPDATE ${table} SET … ${where}` — P6b addition |
| `deleteWhere` (:276) | `DELETE FROM ${table} ${where}` — P6b addition |
| `update` (:296) | `UPDATE ${table} SET … WHERE ${idField} = ?` |
| `delete` (:327) | `DELETE FROM ${table} WHERE ${idField} = ?` |
| `count` (:343) | `SELECT COUNT(*) AS count FROM ${table} ${where}` |
| `ChainedAuditRepository.create` (:367) | `SELECT event_hash FROM mas_events ORDER BY rowid DESC LIMIT 1` (tail read; table FIXED) |

`ormFacade.ts` (3) — operator-surface reads, also
table-parameterized (`${tbl}` / `${cleanTable}`):

| Method | Template |
|---|---|
| table-metadata listing (:407) | ``SELECT COUNT(*) AS count FROM ${tbl}`` (per-table row count) |
| browse count (:451) | ``SELECT COUNT(*) AS count FROM ${cleanTable}`` |
| browse select (:454) | ``SELECT * FROM ${cleanTable}`` (+ optional search/order/limit built below) |

Cross-check (independent rule, same result): the step-3a census
pins exact storage-exec sites — `ormRepositoryCore.ts` 9,
`doSqliteOrmAdapters.ts` 17 (16 DML + 1 DDL `ensureSchema`),
`ormFacade.ts` 19 (3 DML + DDL/PRAGMA), `ormSchema.ts` 8 (DDL),
`inMemoryOrmAdapters.ts` 0. My statement counts match the
census's exec-site counts on every file.

### 1.4 The remaining 244 — unchanged, and the P6d boundary

Re-running the P6b scanner on current main: **244 statements
(121 write / 123 read) across 37 files** (52 scanned) — identical
to P6b's post-merge count; nothing in the DO family moved since
the P6b merge. The 9 tranche files are at zero (their DML is in
the catalogue); the mix pin still asserts 244/121/123 and passes.
P6c takes the 16 → **228 across 36 files** after P6c.

P6d (route-held DML, NOT P6c): `src/agents/routes/maintenance.ts`
2 DELETEs (:413 `mas_job_outcomes_meta`, :431 `mas_events`) and
`src/agents/routes/orchestratorMigration.ts` 1 parameterized
``INSERT OR REPLACE INTO ${table} …`` (:248). Unchanged on current
main.

Follow-on DO tranches after P6c (228 statements / 36 files,
largest first): AsyncJob 26 (14W/12R — the guarded-`claim()`
proof, P6b's proposed next), ResearchStore 16, ProviderConfig 15,
CanonicalReportStore 15, GoalScenario 12, Challenger 11,
JobOutcome 10, StrategyWeights 9, StrategyPolicy 9, UnifiedSchedule
8, StockCopilotSurface 8, UserRequestQuota 7, OrmAdapters 16 → P6c
(above), plus 24 smaller files. One file to flag for the follow-on
list: `doSqlitePausedScheduleAdapter.deprecated.ts` holds 6
statements (4W/2R) — it is deprecated; the follow-on should decide
migrate vs delete under the deprecation rule, not silently migrate
it.

### 1.5 Same-scope work already landed: none

- No `dml.orm.*` codes, no ORM DML catalogue, no
  `ormDml`/`dmlOrm`/`ORM_DML` symbol anywhere in `src/` /
  `tests/` / `scripts/` on current main.
- The P6b catalogue (`doDmlCatalogue.ts` / `doDmlEntries.ts`,
  53 entries: 42 repository + 11 template) has **zero entries**
  on any ORM-core table.
- The P6b mix pin (`tests/do_dml_mechanism_mix_4385.test.ts`)
  already pins the P6c boundary: "doSqliteOrmAdapters.ts still
  has its 16 statements" (10W/6R) — the P6c build updates this
  test (16 → 0, remaining 244 → 228).
- The step-3a census (`tests/orm_step3a_census_2345.test.ts`)
  pins the exec-site counts above and the consumer boundary
  (5 originally-rewired consumer files at zero exec sites).

### 1.6 Consumers: 20 files build on the mini-ORM (not 13)

Measured by the runtime rule (calls `createOrmPorts`, wires an
adapter into a port set, instantiates a factory/adapter class, or
extends `Repository`/`InMemoryRepository`), non-test `src/`,
excluding the six core modules, the `repositoryPorts` contract,
the `src/orm` shims, and the P6a/P6b catalogue modules:

| Role | Files |
|---|---|
| Port consumers via `createOrmPorts` (4) | `src/agents/mas.ts`, `src/agents/orchestrator.ts`, `src/agents/orchestrator/chatTurnHelpers.ts`, `src/agents/orchestrator/tableSchema.ts` |
| Composition roots wiring the adapters (2) | `src/data/createSettingsPorts.ts`, `src/data/createStrategyClusterPorts.ts` |
| Direct adapter/factory users (2) | `src/data/doSqliteMarketplaceAdapter.ts` (factories + `DoAdRepository`), `src/services/adaptationAudit.ts` (`DoSqliteSettingsReadAdapter`) |
| Repository-extending dataset adapters, DDL-only exec (5) | `src/data/doSqliteAnalyzedDatasetAdapter.ts`, `doSqliteDeliveryDatasetAdapter.ts`, `doSqliteEnrichedDatasetAdapter.ts`, `doSqliteGeneratedDatasetAdapter.ts`, `doSqliteJobPipelineAdapter.ts` |
| In-memory twin dataset adapters, no SQL (7) | `src/data/inMemoryAnalyzedDatasetAdapter.ts`, `inMemoryDeliveryDatasetAdapter.ts`, `inMemoryEnrichedDatasetAdapter.ts`, `inMemoryGeneratedDatasetAdapter.ts`, `inMemoryJobPipelineAdapter.ts`, `inMemoryMarketplaceAdapter.ts`, `inMemoryOrchestratorTableAdapters.ts` |

NOT consumers (comment-only mentions or map-only borrowing):
`src/agents/orchestrator/reportDispatch.ts`,
`src/services/screeningFlags.ts`,
`src/data/doSqliteStrategyWeightsAdapter.ts` (comments only);
`src/data/d1MarketplaceAdapter.ts` imports only the shared
COLUMN_MAPs (the ADR's noted D1 surface — type-level borrowing,
not runtime consumption).

The step-3a census's CONSUMER_FILES list (5 files: `mas.ts`,
`mcps/openaimp/commands.ts`, `routes/memoryReset.ts`,
`security/storageRetention.ts`, `routes/adsRevenueReferrals.ts`)
is the originally-rewired set, pinned at zero exec sites — a
different (narrower) definition from the 20-file runtime set.
Both numbers are true under their definitions; neither is 13.
The survey's "13 files" is the Repository-bound table count
(§1.2), not a file count.

## 2. What the phase body got right, wrong, or stale

**Right:**
- The entry shape is method-level (operation + table + predicate),
  not SQL text, for the core's generated statements. Correct —
  and now built: P6b's catalogue already implements exactly this
  form ("repository" entries: method descriptor + column map, no
  SQL text) and its executor already dispatches all 11
  `RepositoryPort` methods (`doDmlExecutor.ts`).
- Consumers are not catalogue owners and are not rewritten. The
  direction holds for the measured 20 files.
- "5–15 files touched" fits the re-scoped P6c (§3).

**Wrong / stale:**
- **"2 raw / 3 builder lines" is stale twice over.** It is a LINE
  count from the old survey method on `ec614e69` (raw counted
  WRITE lines only; SELECT reads excluded; multi-line statements
  counted per line), and it predates P6b's Repository extensions.
  Measured on current main, the core files hold **12 statement
  templates** (9 in `ormRepositoryCore.ts` — 7 pre-P6b + 2 P6b
  additions `updateWhere`/`deleteWhere` — plus 3 facade reads),
  and the family total with the Q5 statements is **28**.
  The "3 builder" is the old Drizzle-builder count; the mini-ORM
  generates SQL via template literals, not Drizzle — there is no
  Drizzle-builder surface in this family at all.
- **"~2,100 lines"** — measured 2,374 (six modules), 2,425 with
  `src/orm/`.
- **"13 files build on it"** — the 13 is the Repository-bound
  TABLE count. Measured runtime consumers: **20 files** (§1.6).
- **Code scheme `read-<table>` / `insert-<table>` / … does not
  match the governing format.** P0's code contract
  (`statementCodes.ts`, already live) is
  `<kind>.<plane>.<table>.<action>` — four segments, and the
  `orm` plane token already exists (used by the P2a DDL catalogue:
  `schema.orm.<table>.create_table`). A two-segment
  `read-<table>` code cannot be a statement code. The governing
  scheme is `dml.orm.<table>.<action>` (or `dml.do.*` if the
  entries live in the DO catalogue — Q1).
- **File scope `src/data/orm*.ts` + `src/orm/*` misses the bulk
  of the work.** It omits `doSqliteOrmAdapters.ts` (the 16
  statements, explicitly assigned to P6c by the parent's Q5
  ruling) and is silent on `inMemoryOrmAdapters.ts` (0 SQL, but
  the twin leg — Q5).
- **"BLOCKED on #3260's ADR" is resolved.** ADR 0032 merged
  2026-11-14 via PR #4562. The entry shape is settled: Drizzle
  is the data-access standard; the mini-ORM is KEPT as the DO
  standard; the 41 hand-written DO adapters migrate ONTO the
  mini-ORM (or named exemption). P6c is unblocked.
- **Size Small is conditional.** Small fits only if Q1 resolves
  to reuse (entries in the existing DO catalogue + executor, no
  new executor, no Repository extension). A sibling catalogue +
  executor and/or a `createOrReplace` extension makes it Medium
  (compare P6b proper, Medium, at 53 entries + extensions).

**The phase body's acceptance criteria, restated against the
code:** the grep pin ("zero inline DML outside the catalogue for
the ORM-core family") needs a definition decision — the generator's
9 templates cannot be "moved into the catalogue" the way adapter
statements can, because the catalogue's repository entries dispatch
TO the Repository whose templates they are (§3, Q1b). The
conformance suite (`tests/orm_step3a_conformance_2345.test.ts`)
and the step-3a census (exact exec-site counts) must stay green,
with census updates in the same PR where exec sites move.

## 3. Re-scoped P6c (files in / files out)

**In:**
- `src/data/schemaComponent/ormDmlCatalogue.ts` +
  `ormDmlEntries.ts` (new) — ONLY if Q1 resolves to a sibling
  `orm`-plane catalogue; otherwise the entries live in
  `doDmlEntries.ts` (existing DO catalogue).
- `src/data/schemaComponent/ormDmlExecutor.ts` (new) — ONLY if Q1
  resolves to a sibling executor; otherwise reuse
  `executeDoDml` (it already dispatches every RepositoryPort
  method, including `updateWhere`/`deleteWhere`/`createOrIgnore`).
- `src/data/doSqliteOrmAdapters.ts` — the 16 statements become
  entries (12 repository-form, 4 template-form per §1.2/DESIGN.md
  §2); the methods call the executor instead of `this.sql.exec`.
- `tests/orm_dml_catalogue_4386.test.ts` (new) — pin test mirroring
  `tests/dml_do_catalogue_4385.test.ts` (zero-inline + red-team +
  coverage + per-family execution round-trips).
- `tests/do_dml_mechanism_mix_4385.test.ts` (update) — P6c
  boundary test 16 → 0; remaining inline 244 → 228 (121→111
  write, 123→117 read).
- `tests/orm_step3a_census_2345.test.ts` (update, only where exec
  sites move) — `doSqliteOrmAdapters.ts` 17 → 1 (only the DDL
  `ensureSchema` exec remains); `ormFacade.ts` 19 → 16 if its 3
  reads become entries; `ormRepositoryCore.ts` stays 9 (generator
  templates unchanged).
- `changelog.d/4386-orm-core-dml.md` (fragment, `### ` header first).

**In only if a ruling says so:**
- `src/data/ormRepositoryCore.ts` — only if Q1b resolves to
  cataloguing the generator templates (entries for the 9) or Q6
  resolves to adding `createOrReplace`.
- `src/data/ormFacade.ts` — only if Q3 puts its 3 browse/count
  reads in scope.
- `src/data/schemaComponent/statementCodes.ts` — only if a new
  code form is needed (the `orm` plane already exists; a
  parameterized-table entry form would need a validation change).

**Out (explicitly):** the 20 consumer files (no rewrites); the
remaining 36 DO files (228 statements — follow-on tranches);
the P6d route files (`maintenance.ts`, `orchestratorMigration.ts`);
DDL catalogue entries; `inMemoryOrmAdapters.ts` as a code change
(its surface stays in lockstep via the conformance twin — Q5).

**P6c/P6d boundary:** P6c owns the ORM-core family (28 statements
max: 16 adapter + 12 core templates, per Q1b/Q3). P6d owns the
route-held DML (2 maintenance DELETEs + 1 parameterized
`INSERT OR REPLACE`). The parameterized-entry form is needed by
BOTH (P6c's `replace()` `${cols}`, P6d's `${table}`) — whoever
defines it first, the other reuses it; flag as a sequencing note,
not a scope dispute.

## 4. Questions for the user

1. **Entry shape — plane and executor (the big one).** The code
   format already supports plane `orm`, the P2a DDL catalogue
   already uses it, and P6b's DO catalogue enforces plane `do`
   with the explicit rule "the two catalogues are siblings, not
   one catalogue with a looser rule". Do the ORM-core entries
   live as `dml.orm.<table>.<action>` in a NEW sibling catalogue
   (+ sibling executor), or as `dml.do.<table>.<action>` in the
   EXISTING DO catalogue reusing `executeDoDml` (which already
   dispatches all 11 RepositoryPort methods)? The DO catalogue's
   own header says it "does NOT hold" the 16 — but it doesn't say
   where they go. Reuse is the smaller slice (no new modules);
   the sibling follows the established per-plane pattern and keeps
   the `orm` plane token live for DML. Which governs under the
   unification directive — one executor for everything, or one
   catalogue per plane?
2. **Do the 9 generator templates get entries at all?** The
   catalogue's repository entries dispatch TO the Repository —
   cataloguing the Repository's own templates is circular unless
   the Repository resolves its templates by code at execution
   (the code becoming the AOP operationName). Options: (a) no
   entries — the 9 templates are the execution substrate, and the
   pin exempts the core's templates by name (they are the
   mechanism, not call-site DML); (b) 9 operation entries with
   the table as a parameter (needs the parameterized-entry form —
   the current validation forbids it: code table must equal entry
   table); (c) per-(table, operation) entries (≈100 entries for
   13 tables × 8 methods — the same template catalogued 13 times,
   which reads as the opposite of unification). I recommend (a)
   or (b), not (c). And the chained tail read is the one
   generator template with a FIXED table (`mas_events`) — it fits
   (a) or a single fixed entry either way.
3. **Scope confirmation — the 16 plus what?** The 16 adapter
   statements are settled (Q5). Is the scope the 16 only (core
   templates exempted as substrate), or 16 + the 12 core
   templates (9 generator + 3 facade reads)? And the facade's 3
   reads specifically — they are operator-surface browse/count,
   not family DML; catalogue them or exempt them as the operator
   surface?
4. **Pin design — reuse P6b's pattern?** New
   `tests/orm_dml_catalogue_4386.test.ts` mirroring the P6b pin
   test (zero-inline + red-team + coverage + round-trips), plus
   updating the mix pin (boundary 16 → 0, remaining 244 → 228)
   and the step-3a census exec-site counts where sites move.
   Confirm this is the intended pin shape, and confirm the
   family pin's rule for the core templates under Q2's answer
   (exempt-by-name vs entries).
5. **The in-memory leg.** The P6b executor constructs a DO
   `Repository`; the twin (`InMemoryRepository`, same 14 tables,
   same method surface, 0 SQL) implements the same ports in JS.
   Do P6c's entries dispatch through the port interface so both
   legs are covered, or is the pin DO-leg only with the twin
   covered by the existing step-3a conformance suites (which run
   every case on both legs)? The conformance twin already
   exercises both legs per method — is that sufficient, or does
   the executor need a leg parameter?
6. **`createOrReplace` — extend the Repository or template the
   one statement?** `replace()` (mas_transactions) is the ONLY
   INSERT OR REPLACE in the family. The Q2 direction says extend
   the Repository for recurring shapes; P6b's working test was
   "recurs in ≥3 families". One occurrence argues for templating
   it (with the parameterized `${cols}` form); the unification
   directive argues the Repository should own INSERT OR REPLACE
   as a method so no second shape exists. Which?
7. **The deprecated file in the follow-on list.**
   `doSqlitePausedScheduleAdapter.deprecated.ts` holds 6 DML
   statements in the remaining 228. Migrate it with the follow-on
   tranches, or delete it under the deprecation rule instead?
8. **Size.** Small if Q1 resolves to reuse (no new executor, no
   Repository extension); Medium if a sibling catalogue +
   executor and/or `createOrReplace` lands. Confirm the size
   once Q1/Q6 are ruled.

#CDO-mha7

---

## Addendum — build corrections (2026-11-15, #4386 built on 7d81cd93)

The build confirmed the survey's counts and corrected four of its
statements:

1. **Census `ormFacade.ts` 19 → 17, not 16.** The survey (§1.3 /
   DESIGN sketch §5) assumed all 3 facade reads move. Only the 2
   counts move; the browse SELECT cannot be a static template or
   a repository entry (dynamic WHERE over runtime-discovered TEXT
   columns + conditional ORDER BY + interpolated LIMIT/OFFSET).
   Reported as the build's one blocker (DESIGN.md §8); the
   census pins 17.
2. **Settings `set` is `delete` + `create`, not `deleteWhere` +
   `create`.** The survey sketch (§4) named the DELETE half
   `deleteWhere`; the DELETE is by id, so the entry dispatches
   method `delete`. The DELETE+INSERT idiom is otherwise exactly
   as surveyed.
3. **The column maps moved.** The survey did not name a home for
   the maps the entries need. They moved verbatim from
   `doSqliteOrmAdapters.ts` to the new leaf module
   `src/data/ormColumnMaps.ts` — importing them from the adapters
   module would have been a load-order cycle (the entries'
   top-level array reads them before the adapters module's body
   runs; verified by the first RED run's collection failure).
   The adapters module re-exports them; no D1 file was touched.
4. **Two validation fixes the entries exposed.**
   `validateDoDmlEntry` rejected camelCase column-map keys (the
   P6b rule assumed identity maps) and had no parameterized-table
   form. Both are principled extensions, pinned by the new pin
   test (DESIGN.md §3, §5).

Counts confirmed exactly as surveyed: 16 statements (10 write /
6 read) in `doSqliteOrmAdapters.ts`; 9 generator templates + the
fixed tail read in `ormRepositoryCore.ts`; 3 facade reads;
remaining inline 244 → 228 (111 write / 117 read); catalogue
53 → 79 (64 repository + 15 template). The 8 survey questions
were answered by the user's rulings (comment 6897923641) and the
ruled design — see DESIGN.md (final).

## Addendum 2 — full-suite follow-ons (2026-11-15 ~18:10 EST)

5. **`Repository.delete` verifies with SELECTs the survey did
   not name.** Every catalogue `delete` entry dispatches the
   Repository method, which does a `findById` SELECT before
   the DELETE and — against a store reporting no `rowsWritten`
   — a second one after it (D-E.2). Three follow-on test
   updates, all pins/fakes moving with the change, none a
   weakening: the governedHalt characterization now pins the
   SELECTs in the op order (the mirror/DO ordering the test
   exists to pin is unchanged); the `enrichment_store` and
   `screener_followup_hitl` fakes learn the Repository's
   `SELECT * ... LIMIT 1` shape for `mas_settings`. Full-suite
   run 1 (before these fixes): 1,851 files / 20,832 tests /
   20,820 passed / 11 failed / 1 skipped; the 4 fixed tests
   are the characterization (2), enrichment killswitch (1),
   and screener HITL (1). **Correction after the baseline
   run:** the remaining 6 failures in run 2 (corpus sync,
   knowledge UI, publish stages S4/S5 — all "expected
   undefined to be true") were NOT pre-existing: they failed
   deterministically in the candidate tree while passing on
   the pristine baseline. Cause: the same `get()` shape
   change — those routes read the corpus marker through the
   settings adapter, and their fakes matched only the old
   `SELECT value ...` shape, so the marker read returned
   nothing and the too-soon guard never fired. Fixed the
   same way (five fake sites in four files learn the
   `SELECT *` shape); the four files pass 53/53 in
   isolation. The pristine baseline's only failure is the
   known `mesh_mcp_self_registration_2496` load flake (it
   failed in candidate run 1, passed in run 2, failed in
   the baseline). See GATE-REPORT.md for the final delta.
