# S4 Survey — #1169 remainder (S3 excluded)

Read-only survey, no branches, no commits, no pushes. Base: OpenAIMP/cfagent
main `1a8f86a36565c703478e05078d6c911e85f262a1` (2026-10-28), verified by
`git show` / `git grep` at that SHA. S1 (corpus) + S2 (flag-gated serving)
are merged; the Search hub (#2120, slices 0+1) is merged and closed. S3
(fallback removal) is PROBE-GATED and OUT of this survey's scope — no
fallback work is scoped below. The S4 remainder is scoped into ordered
build slices. Cross-cutting rules applied throughout: additive-first; NO
file deletions anywhere (Policy Gate §22 check (i) is FILE-level — removing
a function from a map, editing a comment, or editing a binding line is not
a file deletion); reuse-before-build (named per slice); no fallback changes.

## Claims checked firsthand — what survived and what did not

| Brief claim | Verdict at main `1a8f86a3` |
|---|---|
| Only research-published reports are indexed; sole `indexReport` caller `researchPublish.ts` | CONFIRMED, with a correction below. `indexReport` (`src/services/reportSemanticIndex.ts:42`) has exactly one production caller: `src/agents/orchestrator/researchPublish.ts:175` (import at :170). |
| Screener/goal/options reports are not indexed | IMPRECISE — see correction. The unindexed sources are `screener`, `research_report`, `goal_screen`, `options_scanner`. `options_research` (the options-*research* path) IS indexed — it is the one indexed source. Goal reports DO exist as source `goal_screen` (via the ORM seam, not via `persistScreenerReportCanonical`). |
| MAS `searchKnowledge` defined in `mas.ts`, imported by `orchestrator.ts`, never called in `src/` | CONFIRMED. `createMAS` (`src/agents/mas.ts:25`) is imported at `src/agents/orchestrator.ts:56` and never invoked in `src/`. Tests DO call it (parity, honesty, webhook, `r2_knowledge_serving`) — test-only usage. |
| `SEARCH_AGENT` binding whose class `SearchAgent` does not exist anywhere | WRONG. See slice S4-0. The binding resolves via an export alias and is pinned in three test files. No build slice exists for this item. |
| Seeding the corpus does NOT make docs searchable (code explicitly refuses it) | CONFIRMED in substance, CORRECTED in citation. The cited file `src/services/knowledgeMemoryModes.ts` does NOT exist at main. The refusal is structural, not a comment: the upload route (`src/agents/routes/knowledgeCorpus.ts:203`) calls `putKnowledgeDoc` only — no index call, no instance push, anywhere on the path. |
| `aiSearchCache` references nonexistent `src/agents/search.ts` | CONFIRMED. Header at `src/services/aiSearchCache.ts:8`; `src/agents/` contains no `search.ts` (only `research-agent.ts`). The cache's sole `src/` importer is `mas.ts`. |
| Instance sources/provisioning are dashboard-only | CONFIRMED as far as code can show: no code path configures instance sources or writes into the instance (all three endpoint call sites are POST reads). The instance's actual state is NOT in code — dashboard-gated (slice S4-5). |

## Recommended slice order

1. **S4-1 — Vectorize index coverage** (item 1). The user-visible value:
   semantic search finally finds screener, goal, options-scan, and
   research-report rows, not just options-research rows.
2. **S4-2 — MAS `searchKnowledge` retire** (item 2). Cleans up the one
   unwired tool before anything else builds on it; migrates its S2 pins
   to the successor surface.
3. **S4-3 — `aiSearchCache` header fix** (item 5). Trivial; rides after
   S4-2 (file-disjoint from it, so it may fold into S4-2's PR if the
   parent prefers — but it is not a dependency of anything).
4. **S4-4 — Schedulable sync + export** (item 6). Needs S4-1's backfill
   function for its report leg; its bridge leg needs S4-5's answer B.
   Integrity leg is unconditional.
5. **S4-5 — Corpus→instance index bridge** (item 4). LAST and
   dashboard-gated: no build until the owner answers the five dashboard
   questions. Design only until then.
6. **S4-0 — `SEARCH_AGENT` record correction** (item 3). NO build.
   A docs correction + pin verification (below). Not a slice.

---

## S4-1 — Vectorize index coverage for screener/goal/options reports

### Design

Today `indexReport` upserts one vector per canonical report
(`reportSemanticIndex.ts:42`: id `report:<id>`, `kind: "report"`,
metadata `reportId/title/source`, `@cf/baai/bge-base-en-v1.5` embeddings
of title+text capped at 8000 chars, `VECTOR_MEMORY` binding). It never
throws and no-ops without bindings ("indexing never fails report
storage"). The module header aspires that "every stored report is
indexed" — false in practice: the only production caller is
`researchPublish.ts:175`, which indexes `options_research` rows with
text = summary + first 5 ideas, fire-and-forget (`void` + try/catch,
"Indexing never fails the run").

Canonical writes all funnel through one seam family, which is the hook
point — but the seam has a shape constraint the slice must respect.
`storeReportAtGeneration` (`src/services/scheduledReports.ts:266`) takes
`(sql, input)` and NO env, returns `{ reportId, created } | null`, never
throws, idempotent on `generationId` (redelivery returns the existing id
with `created: false`). `storeReportAtGenerationWithR2` (same contract
plus the R2 body pointer) already takes env. The ORM wrapper
`storeCanonicalReport` (`src/orm/index.ts:1003`) wraps the plain seam.

The slice: (a) thread an OPTIONAL env through `storeReportAtGeneration`
and the ORM wrapper (signature-compatible; callers that have env pass
it); (b) add a shared post-store hook, `indexCanonicalReport`, in
`reportSemanticIndex.ts`, called from both store functions whenever a
reportId is returned (mirroring `researchPublish`'s rule — redeliveries
just re-upsert the same vector id, which is idempotent); (c) per-source
text builders in the same module — `options_research`: summary + first 5
ideas, moved VERBATIM from `researchPublish` (then `researchPublish`'s
explicit call is REMOVED, not duplicated: two upserts with different
text would make last-write-wins nondeterministic); `screener`: summary +
top opportunity descriptors (symbol/structure, capped); `goal_screen`:
summary + scenario/task descriptors from the body; `options_scanner`:
summary + matched symbols/contracts (capped); `research_report`:
summary + body text extraction (capped); default: summary + title.
(d) EXCLUDE source `retention` (storage-pruning notices — ops telemetry
with no retrievable value; user may override). (e) Index all other
sources regardless of run success: the seam cannot uniformly know
success (bodies differ per source), failed runs are rare, and their text
is truthful. (f) Backfill: a session-gated, paginated backfill route
that upserts every pre-hook row (plus rows created while bindings were
absent, which `indexReport` silently no-ops on); the recurring runner
for stragglers is S4-4, which reuses this function.

What "coverage" means mechanically: every `mas_reports` row with a
covered source gets a `report:<id>` vector at write time (best-effort,
never failing the write), and every pre-existing covered row gets one
via backfill. It does NOT mean: NLQ `options_fit_discovery` rows
(`etrade_options_fit_discovery` table — not `mas_reports`, out of scope);
standalone goal screens that bypass the workflow (they persist nothing
canonical — that gap belongs to #1972, not this slice; goal rows
covered here are the `goal_screen` rows the workflow/ORM path already
writes); or the AI Search instance (a different system — no code writes
into it; see S4-5).

### Files to touch/add (verified at base)

- MODIFY `src/services/reportSemanticIndex.ts` — `indexCanonicalReport`
  helper + per-source text builders (reuse: `indexReport`, `embed`,
  `VECTOR_MEMORY`, `kind: "report"` filter).
- MODIFY `src/services/scheduledReports.ts` — optional env threading
  through `storeReportAtGeneration` (:266) + post-store hook call;
  same hook in `storeReportAtGenerationWithR2`.
- MODIFY `src/orm/index.ts` — optional env threading through
  `storeCanonicalReport` (:1003).
- MODIFY `src/agents/orchestrator/researchPublish.ts` — REMOVE the
  explicit `:175` call (migrated to the seam; text identical by
  construction — pinned, see below). No other `researchPublish`
  behavior changes.
- MODIFY (call-site env passing only, no logic): `src/agents/nlq/execution.ts`
  (:100 `options_scanner`, :131 `screener`), `src/agents/orchestrator/goalScreenDispatch.ts`
  (:97 `goal_screen`), `src/agents/orchestrator/scheduledCallbacks.ts`
  (:218 `screener`), `src/agents/routes/premium.ts` (:312
  `options_scanner`, :405), `src/services/optionsServeRecord.ts`
  (:262 `options_scanner`), `src/security/storageRetention.ts`
  (:506 `retention` — excluded, no hook), `src/agents/orchestrator.ts`
  (:1483 `recordWorkflowScreenReport` → `persistScreenerReportCanonical`,
  :2145 `storeResearchReportCanonicalAsync`), `src/agents/routes/reports.ts`
  (:469, :517 XLSX-upload canonical writes). Build step 0 audits each
  site for env availability; sites without env at call time get NO
  inline hook (covered by backfill instead) — the audit result is part
  of the slice's PR description, not a survey gap.
- ADD `tests/report_index_coverage_p1169.test.ts` (pins below).
- ADD (backfill route): extend an existing route module — recommended
  `src/agents/routes/reports.ts` (canonical-report home) — with a
  session-gated POST backfill endpoint; no new route module needed.
- NOT touched: `src/services/aiSearch.ts` (AI Search instance — different
  system), `FINANCIAL_KNOWLEDGE_BASE` / fallback (S3, probe-gated),
  `researchPublish` beyond the call migration, any existing test except
  disclosed pin updates.

### Pin tests to write

New file `tests/report_index_coverage_p1169.test.ts`, stubbed
`AI` + `VECTOR_MEMORY` (capture upserts):
1. `persistScreenerReportCanonical` (via the WithR2 seam) upserts
   `report:<id>` with `kind: "report"`, `source: "screener"`, title.
2. `storeResearchReportCanonicalAsync` upserts with
   `source: "research_report"`.
3. ORM-seam writes upsert with `source: "goal_screen"` and
   `source: "options_scanner"`.
4. `retention` rows are NOT indexed.
5. Bindings absent → store still succeeds, no vector (no-op preserved).
6. Upsert throws → store still succeeds (best-effort preserved).
7. Redelivery (same `generationId`) re-upserts the SAME vector id
   (idempotent, no duplicate).
8. Migration pin: seam-builder output for an `options_research`
   fixture EQUALS `researchPublish`'s current ideas text (proves the
   migration is behavior-preserving for the one already-indexed source).
9. Backfill route: paginated run over fixture rows upserts exactly the
   covered set, skips `retention`, and is re-runnable without
   duplicates.

### Dependencies

- R-6 decision (below) — this slice IS the new capability, not a dedup.
- S4-4 reuses the backfill function for recurring straggler runs.
- Degraded-state display for semantic results is unchanged (lexical
  fallback already exists in the semantic route); no S3 dependency.

### Decision still needed (user)

1. Approve extending Vectorize indexing to `screener`,
   `research_report`, `goal_screen`, `options_scanner` sources (the
   R-6 new-capability decision itself).
2. Confirm `retention` excluded (default) or included.
3. Confirm backfill ships in this slice as a one-off session-gated
   route (recommended yes; recurring runs are S4-4).

---

## S4-2 — MAS `searchKnowledge` retire (not instantiate)

### Design

`searchKnowledge` is a real, honest implementation — not a stub. Inside
`createMAS` (`src/agents/mas.ts:26`), its `execute` does: bounded
in-isolate TTL cache (5 min, 200 entries, success-only) → local
scheduled reports first (top 5, `searchScheduledReports`) → direct
`fetch` POST to `AI_SEARCH_ENDPOINT` (10 s abort) → on upstream failure
returns local reports honestly or an error (never a stub) → on success
merges report chunks + index chunks (≤5), flag-gated
`attachCorpusProvenance`, caches, audits. It has zero production
callers: `createMAS` is imported at `src/agents/orchestrator.ts:56`
and never invoked in `src/` (the orchestrator's turns use
`runAgentTool(ResearchAgent)`, not MAS tools). Tests call it
(`tests/actor-orchestrator-parity.test.ts:106`,
`tests/confirmation_card_honesty.test.ts:132`,
`tests/payments_webhook_settlement.test.ts:484`,
`tests/r2_knowledge_serving_p1169.test.ts:420,430,445`) — test-only
usage, which is not a consumer.

Recommendation: RETIRE, because the instantiate alternative has no
identified consumer. Wiring `createMAS` into orchestrator turns would
mean building a new agent-tool consumer for a capability the Search hub
already serves interactively (hub search-agent tab → POST
`/search/agent` → `ETradeAISearchService`). The retire costs nothing
of value, verified: (a) corpus provenance is NOT orphaned — the
service's own mapping (`src/services/aiSearch.ts`, flag-gated
`mapAiSearchChunks`) stamps `bucketKey` / `servedFileLink` /
`indexingState` from chunk keys for the hub path, line-for-line the
same three fields `attachCorpusProvenance`
(`src/services/knowledgeCorpus.ts:254`) sets for the MAS direct-fetch
path; retiring MAS removes the duplicate stamping path, not the
feature. (b) The TTL cache is optimization-only (in-isolate, 5 min);
dropping it with disclosure is acceptable, and re-adding cache to the
hub route later is a small enhancement, not a retire blocker.
(c) The local-report merge duplicates what the Reports and semantic
tabs already serve separately.

Retire touches, exactly (a function inside `mas.ts`, not a file — so
§22's file rule is not engaged at all):
1. `src/agents/mas.ts` — `@deprecated` comment on the
   `searchKnowledge` tool definition naming the successor (Search hub
   search-agent tab via POST `/search/agent`); remove `searchKnowledge`
   from the returned tools map (:423). `createMAS` itself stays
   exported (tests import it; the other five tools in the map are a
   separate, factory-wide question — flagged below, NOT in this slice).
2. `src/agents/orchestrator.ts:56` — remove the dead `createMAS`
   import (zero call sites; removal is behavior-neutral).
3. Migrate the S2 pins that call `mas.searchKnowledge`
   (`tests/r2_knowledge_serving_p1169.test.ts`, MAS-based provenance
   assertions) to the successor surface (hub route + service mapping),
   with test-name preservation per the #1917 allowance where a test
   file's tests move. No test FILE is deleted. Adapted tests are
   disclosed in the PR body with justification (the pins move because
   their subject is retired, not because they failed).

NOT in this slice: retiring the other five tools in the `createMAS`
map (`draftPayment`, `createTaskDraft`, `confirmDraft`, `rememberFact`,
`recallFacts`) — they share the same unwired fate, but scoping them
here would balloon the slice. Flagged as a follow-up question for the
user (leave them vs. scope a factory-wide retire).

### Files to touch/add

- MODIFY `src/agents/mas.ts` (deprecation comment + map removal).
- MODIFY `src/agents/orchestrator.ts` (import removal only).
- MODIFY `tests/r2_knowledge_serving_p1169.test.ts` (pin migration,
  disclosed). Possibly MODIFY the other three test files ONLY if they
  assert on `searchKnowledge`'s presence in the map (build verifies).
- ADD `tests/mas_searchknowledge_retire_p1169.test.ts` — pins: the
  tools map no longer contains `searchKnowledge`; the deprecation
  comment names the successor; `createMAS` is not imported by
  `src/agents/orchestrator.ts` (source-assertion pin, repo practice).
- NOT touched: `src/services/aiSearch.ts` (fallback — S3),
  `src/services/aiSearchCache.ts` (its reader goes away; the module
  itself stays — cache is generic, see S4-3's note), hub files.

### Pin tests to write

As above, plus: hub agent route still returns service-native chunks
with service-mapped provenance when the flag is on (existing hub pins
cover the route; the retire slice adds the negative pin that MAS is
not a production path — the orchestrator-import source assertion).

### Dependencies

- S3's degraded-state contract does NOT block this slice (the retire
  removes a path, it does not define a display state). Post-S3, the
  hub tab's display is revisited under S3's contract (see
  cross-cutting note) — not here.
- S2 pins migration is the slice's main cost; budget for it.

### Decision still needed (user)

Approve retiring MAS `searchKnowledge` (successor: hub search-agent
tab via POST `/search/agent`), with cache + local-report merge dropped
with disclosure (no adoption). Separately: leave the other five
`createMAS` tools alone, or scope a factory-wide retire follow-up?

---

## S4-0 — `SEARCH_AGENT`: no build (claim corrected)

The brief's premise is wrong, verified at main:

- `wrangler.jsonc:48` binds `SEARCH_AGENT` → `class_name:
  "SearchAgent"`; `src/server.ts:216` exports `OrchestratorAgent as
  SearchAgent`; v1 migration (`wrangler.jsonc:75`) creates
  `SearchAgent`; v9 (`:90`) creates `OrchestratorAgent` — the #1387
  comment explains why both exist (the Agents SDK resolves
  `ctx.exports` by the parent's `constructor.name`, so the alias
  cannot satisfy it; the alias stays for the live orchestrator address
  and stored state).
- The binding is LIVE, not dangling: `src/server.ts:3750-3751`
  (`scheduled()` addresses the shared Orchestrator instance via
  `env.SEARCH_AGENT.idFromName`), and the chat/export path serves
  through it.
- The alias is PINNED in three test files:
  `tests/dead-agent-classes.test.ts:35`,
  `tests/orchestrator-actor-cutover.test.ts:229`,
  `tests/orchestrator_root_namespace_1387.test.ts:62,72`.
- The activation survey's "class does not exist" came from a literal
  `class SearchAgent` grep, which misses an export alias. The survey's
  claim (and this brief's) should be corrected in the record, not
  built upon.

Recommendation: NEITHER resolve NOR remove. Removing the binding
would break production (`scheduled()` cron dispatch + the live
orchestrator address). Implementing a separate `SearchAgent` class
would invent a second agent with no role distinct from
`OrchestratorAgent` and no spec. The only action is a docs correction
to the activation survey's claim (rides the next docs-touching PR, or
a one-line correction — not a build slice). If the user wants a
SEPARATE SearchAgent agent someday, that is a new programme needing a
spec first (role distinct from OrchestratorAgent? state owned? who
calls it? lifecycle?) — not recommended, not scoped.

### Decision still needed

None for S4 (correction only). A new-programme decision only if the
user insists on a separate SearchAgent agent — not recommended.

---

## S4-3 — `aiSearchCache` header fix

### Design

One stale comment. `src/services/aiSearchCache.ts:8` says "both agent
search surfaces (`src/agents/mas.ts` `searchKnowledge`,
`src/agents/search.ts` `SearchAgent`) read through it."
`src/agents/search.ts` does not exist at main (only
`research-agent.ts` matches "search" in `src/agents/`), and the
cache's sole `src/` importer is `mas.ts` (`:9` import, `:34` use;
definition at `aiSearchCache.ts:104`). The SearchAgent surface
(`OrchestratorAgent`, see S4-0) does not import the cache at all, so
the clause is false even under the alias reading. The header predates
the Think cutover (#686) and actor port (#1738), which removed or
renamed the old `search.ts` without updating it.

Fix: rewrite the header sentence to name the single actual reader —
`src/agents/mas.ts` `searchKnowledge` (inside `createMAS`) — and drop
the `search.ts`/`SearchAgent` clause. No behavior change (comment
only). Note the interaction with S4-2: after the retire, the cache's
production reader is gone (tests remain); the module itself stays —
it is generic TTL-cache infrastructure, and deleting the FILE would
trip §22. If S4-2 lands first, this slice's header should say the
cache is currently test-only / awaiting a future reader rather than
naming a retired reader — sequence the wording accordingly (S4-3
after S4-2, as ordered).

### Files to touch/add

- MODIFY `src/services/aiSearchCache.ts` (header comment only).
- MODIFY `tests/ai-search-cache.test.ts` (additive pin registration):
  assert the module's source contains no reference to
  `src/agents/search.ts` and names `mas.ts` `searchKnowledge` (or,
  post-S4-2, the updated wording) — a source-assertion pin, consistent
  with repo practice (cf. slice-0 mount pin).

### Dependencies

None. No user decision needed (trivial fix; wording follows S4-2).

---

## S4-4 — Schedulable corpus sync + downloadable export

### Design

Two halves: a scheduled sync (the job) and downloads (the artifacts).
Both reuse existing seams; neither needs a new cron trigger — and that
is a hard constraint, not a preference. `wrangler.jsonc:109-121`
declares THREE triggers (`0 3 * * *`, `*/30 * * *`, `0 4 * * *`), and
its comment records the account at the Workers Free trigger ceiling
(error 10072 if a further trigger is added) with the research run
deliberately riding the `*/30` tick instead. So the sync rides the
`*/30` tick: `src/server.ts` `scheduled()` dispatches on the tick,
guarded by the proven `researchScheduleGuard` pattern
(`src/services/researchScheduleGuard.ts`: durable last-fired marker in
`mas_settings`, idempotent across ticks and isolates). Recommended
cadence: weekly (marker key `corpus_sync_last_run`; user may set
another cadence — the guard is date-based, so any cadence is a small
change).

What syncs (three payloads, one unconditional):
1. INTEGRITY (unconditional, the core): manifest/DO-records → bucket
   bytes. Reuse `verifySeedManifest` (`src/services/knowledgeCorpus.ts:307`)
   plus a DO-record scan (SQL over the `knowledge:` namespace — the
   corpus module has get/put only and NO list API, header :41 — so
   enumeration is a SQL scan of DO records, plus R2 `bucket.list` on
   the `knowledge/` prefix for extras). Report: `{ ok, missing[],
   mismatched[], extra[], checkedAt }` — missing = DO record with no
   bucket bytes, mismatched = bytes whose recomputed hash differs from
   the recorded hash (the module already refuses to serve those),
   extra = bucket keys with no DO record. Hash-verify all (corpus is
   small — seed docs; note the cost bound in the PR).
2. REPORT BACKFILL (conditional on S4-1): re-run S4-1's backfill
   function for `mas_reports` rows still lacking vectors — rows created
   while bindings were absent (silent no-op) and rows from any call
   site the S4-1 audit left env-less. Idempotent upserts make re-runs
   safe; the sync marker bounds each run to rows since the last run.
3. BRIDGE BACKFILL (conditional on S4-5 answer B only): push
   not-yet-pushed DO records to the instance ingestion endpoint. If
   S4-5 answers A or C, this leg does not exist.

What exports (both downloadable, both JSON of native shapes):
1. Integrity/manifest report JSON: new session-gated GET route on the
   existing corpus route module (`src/agents/routes/knowledgeCorpus.ts`
   — add `GET /knowledge/integrity`, reusing `verifySeedManifest` +
   the DO scan; session gate mirroring `GET /knowledge/file`). The
   client downloads it as a file (Blob download from the route
   response). This is the audit artifact.
2. Hub tab results export (client-only, no backend): a Download button
   per tab in `src/client/search/tabs/*` exporting that tab's CURRENT
   results as JSON (native shapes preserved). No shared-results
   plumbing (tabs own their results state; hub-level export would need
   lifted state — a refactor for no gain). CSV is NOT added in this
   slice (JSON satisfies "downloadable result set"; CSV only if the
   user asks — the tools catalog is the one naturally tabular tab).

UI surface, stated honestly against the delivery standard:
- Schedulable: MET (tick + guard; no new cron trigger).
- Downloadable: MET (integrity JSON via route + tab results JSON via
  buttons).
- Results in UI: PARTIAL. Tab exports surface in the hub (built).
  The integrity report has NO panel — DEFERRED with reason: no corpus
  admin UI exists (the corpus was deliberately storage-only, no
  listing API); building a panel is its own slice; the route +
  downloadable JSON covers audit until then. Explicitly NOT written
  as a `mas_reports` row: that would pollute report taxonomy (a sync
  notice appearing in Reports as a "report" is a worse lie than no
  panel) and tangle with the #1168 sweep semantics.

### Files to touch/add

- MODIFY `src/server.ts` `scheduled()` — dispatch the corpus sync on
  the `*/30` tick behind the guard (reuse `researchScheduleGuard`
  pattern with a new marker key; do NOT add a cron trigger to
  `wrangler.jsonc`).
- ADD sync module (recommended `src/services/corpusSync.ts`): guard
  check, DO-record scan, `verifySeedManifest` reuse, bucket listing,
  hash verification, report assembly; report-backfill + bridge-backfill
  legs as conditional branches reusing S4-1's backfill function and
  S4-5's push function respectively.
- MODIFY `src/agents/routes/knowledgeCorpus.ts` — add session-gated
  `GET /knowledge/integrity` (report JSON).
- MODIFY `src/client/search/tabs/*` (6 files, one button each) —
  Download-current-results as JSON. No hub chrome changes needed.
- ADD `tests/corpus_sync_p1169.test.ts` — pins: guard fires once per
  cadence window (marker respected); missing/mismatched/extra
  classification (fixture DO records + stubbed bucket); hash-mismatch
  rows reported, never served; backfill legs skipped when their
  gating slice is absent (S4-1 function missing → report leg no-op;
  S4-5 answer not-B → bridge leg no-op); integrity route 401 without
  session; tab export serializes current results (client pin).
- NOT touched: `wrangler.jsonc` crons (ceiling), fallback (S3),
  `mas_reports` taxonomy (no sync rows), hub chrome.

### Dependencies

- S4-1 (backfill function) for the report leg; S4-5 answer B for the
  bridge leg. Integrity leg + tab exports have no dependencies and
  could ship first if the parent splits the slice — but the slice is
  ordered after S4-1 so the report leg is real, not stubbed.

### Decision still needed (user)

1. Confirm weekly integrity cadence (default) or set another.
2. Approve per-tab JSON export (no CSV in this slice).
3. Confirm deferring the integrity panel UI (vs. building a corpus
   admin panel now — a separate slice if wanted).
4. Conditional legs need no decision now (they ride S4-1/S4-5).

---

## S4-5 — Corpus→instance index bridge (dashboard-gated — design only until answers land)

### Design

Current state, verified: seeding writes R2 bytes + a DO metadata
record and NOTHING else. The upload route
(`src/agents/routes/knowledgeCorpus.ts:203`) calls `putKnowledgeDoc`
only. No code path submits anything to the AI Search instance (all
three endpoint call sites are POST reads), no code configures instance
sources, and the corpus module has no list API (header :41) — so even
enumerating the corpus for a push needs a DO-record SQL scan (as in
S4-4) or the seed manifest. The instance's state — provisioned or
not, what it indexes, whether its sources can point at R2, whether
it exposes ingestion — is NOT in code and must NOT be assumed.

The five dashboard answers that determine the design (owner):
1. Is the instance provisioned, and does its endpoint match the
   deployed `AI_SEARCH_ENDPOINT`?
2. Can its sources be configured (dashboard) to the R2 `screener`
   bucket's `knowledge/` prefix — yes, no, or only other source types?
3. What does it currently index, if anything (empty? docs? reports?)?
4. Does it expose an ingestion API (endpoint, auth method, payload
   shape, idempotency key, rate limits) — or only dashboard-configured
   sources?
5. What chunking/embedding does it apply (does the served chunk shape
   match S2's mapping assumptions — the probe answers this)?

Bridge sketches under each plausible answer:
- **A — sources ARE configurable to R2 `knowledge/`.** NO code bridge.
  The owner adds the source in the dashboard; cfagent's work is probe
  verification only (a query returns a corpus doc with bucket-key
  provenance + served-file link — already the probe gate's bar). Any
  "source health" indicator is a later UI nicety, not a bridge.
- **B — sources are NOT configurable, but an ingestion API exists.**
  Code bridge: on `putKnowledgeDoc` success, push the doc (bytes or
  text + metadata: title, category, sourceUrl, bucketKey) to the
  ingestion endpoint, keyed idempotently by bucket key (or content
  hash — decided once the API's idempotency is known). Failure
  contract (mirroring `indexReport`): push failure NEVER fails the
  upload — log + leave for the S4-4 bridge-backfill leg to retry.
  Backfill: DO-record scan → push each unpushed record (S4-4 leg).
  Unknowns until the API is known: endpoint, auth, payload shape,
  chunking ownership (instance-side vs. cfagent-side), rate limits —
  all residuals until answer 4 lands.
- **C — NEITHER configurable sources NOR an ingestion API.** NO bridge
  is possible via code, and none must be faked (e.g., presenting
  catalog or Vectorize results as instance results would be a
  fabrication). The corpus stays served-only (`GET /knowledge/file`
  links, hash-verified) and searchable only through whatever the
  instance's dashboard sources already are. The honest alternative —
  indexing corpus files into Vectorize (a DIFFERENT system from the
  instance, reusing S4-1's machinery) so the corpus is searchable via
  the semantic path — is a separate decision, NOT the bridge, and is
  named here only so it is not mistaken for one.

### Files to touch/add (answer B only; A and C touch no code)

- MODIFY `src/services/knowledgeCorpus.ts` — post-put push hook
  (best-effort, after successful `putKnowledgeDoc` only).
- ADD `src/services/corpusBridge.ts` — ingestion client (endpoint,
  auth, payload, idempotency) + backfill enumeration (DO-record scan,
  shared with S4-4).
- MODIFY `src/agents/routes/knowledgeCorpus.ts` — wire the hook into
  the upload path (no change to the session gate or hash rules).
- ADD `tests/corpus_bridge_p1169.test.ts` — pins: push on successful
  put with idempotency key; push failure does not fail the put
  (record marked unpushed for S4-4 retry); backfill pushes exactly the
  unpushed set; no push when the bridge is unconfigured (explicit
  no-op, logged).

### Dependencies

- Dashboard answers 1–5 (owner) — the slice CANNOT build before them.
- S4-4's DO-scan + retry machinery for backfill (order S4-4 before
  S4-5 also for this reason).
- Probe gate: the probe's chunk-shape findings constrain the mapping
  (S2's mapping is probe-dependent by its own header).

### Decision still needed (owner + user)

- Owner: answers 1–5 above.
- User (only if answer C): accept no-bridge (corpus served-only), or
  commission Vectorize-corpus-indexing as a separate slice (different
  system, separate decision — not scoped here).

---

## Cross-cutting notes

### Degraded-state display rides S3's contract (sequenced, not S4)

S4's `ai_search` display work does NOT define the degraded state — S3
does (per the recorded S3 §22 clarification: S3's positive
implementation IS the honest degraded-state contract on both
surfaces). What the hub tab does today — render `provider` honestly
per result set and disclose the `semantic_cache` fallback — is the
pre-S3 display. AFTER S3 lands its contract (shapes, error codes,
unconfigured vs. empty vs. failed distinctions), the hub's
search-agent tab gets a follow-up touch to render that contract
(exactly: show the degraded state, never a stub). That touch is NOT
in these S4 slices; sequencing it after S3 is deliberate, not an
oversight. S4 slices must not invent display states S3 will define.

### Reuse table (reuse-before-build, per slice)

| Slice | Existing component reused | Honestly new |
|---|---|---|
| S4-1 | `indexReport` + `embed` + `VECTOR_MEMORY` (`reportSemanticIndex.ts`); `storeReportAtGeneration[WithR2]` seam; `mas_reports` canonical row | Per-source text builders; seam env threading; backfill route |
| S4-2 | Hub search-agent tab + POST `/search/agent` (successor surface); service-mapped provenance (`aiSearch.ts`) | Deprecation comment; pin migration |
| S4-0 | — (no build) | Docs correction only |
| S4-3 | `aiSearchCache` module itself (unchanged behavior) | Header wording; one pin |
| S4-4 | `verifySeedManifest`; `researchScheduleGuard` pattern; `*/30` tick dispatch; `GET /knowledge/file` session-gate pattern; S4-1 backfill fn; S4-5 push fn (conditional) | Sync module; `GET /knowledge/integrity`; per-tab Download buttons |
| S4-5 (B) | `putKnowledgeDoc` post-put hook point; DO-record scan (S4-4); `servedFileLinkFor`/`parseKnowledgeBucketKey` | Ingestion client; backfill enumeration |

### What is NOT in S4 (guardrails)

- No fallback changes (S3, probe-gated). No file deletions (all
  slices: zero `D` in their diffs — the retire removes a tool from a
  map, the header fix edits a comment, the bridge/config work edits
  lines or adds files).
- No AI Search instance writes except S4-5 answer B (the only slice
  that ever pushes to the instance, and only on a confirmed API).
- No `mas_reports` rows for sync reports (taxonomy pollution — see
  S4-4). No new wrangler cron triggers (account ceiling — see S4-4).
- No changes to the working `options_research` index path except the
  behavior-preserving migration to the seam hook (S4-1, pinned).

### Residuals (not verifiable from code — with what verifies each)

1. Instance provisioned? Sources? Current index contents? Ingestion
   API? → Owner dashboard answers + live probe (S4-5 gate).
2. Live bucket contents today (does `knowledge/` hold anything? The
   seed never uploaded — nothing is written until the seed runs, but
   only a bucket check proves it) → seed hash-check step / S4-4
   integrity run.
3. Live Vectorize contents (which report ids actually hold vectors —
   no admin query route exists) → S4-1 backfill report (rows it had
   to upsert vs. rows already present is not directly observable;
   the backfill is idempotent, so exact prior state is not required
   — the residual is observability, not correctness).
4. `optionsServeRecord.ts:66` call site's `source` value (the other
   options-serve site is confirmed `options_scanner` at :262) →
   build-time seam enumeration (S4-1 step 0).
5. Env availability at each ORM call site (NLQ execution, goal
   dispatch, scheduled callbacks, premium routes, retention service,
   options-serve deps) → S4-1 build audit step 0; env-less sites fall
   back to backfill coverage (stated in the slice).
6. Whether MAS-attach and service-mapping diverge on any chunk shape
   (both set the same three fields from the same key by code reading;
   live chunk shapes are probe-dependent per S2's own header) →
   flag-on live probe with a corpus doc in the index.
7. `researchPublish` ideas-text migration byte-identity → S4-1
   migration pin (fixture report, seam output == current output).
8. Corpus size growth (hash-verifying ALL bytes on every sync run)
   → S4-4 PR notes the bound; if the corpus grows large, the sync
   switches to sampled verification (a stated follow-up, not a
   blocker — the corpus is seed docs today).
