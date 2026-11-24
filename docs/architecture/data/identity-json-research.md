# Identity linking (Q1), JSON integrity (Q2), no-duplication (Q3), ACID + CRUD (Q4), CISO alignment (Q5)

**Main tip:** `16d39b51448ba70567b8ca0ba295f7c34ba3bc54` — "Market definition refuses a goalScreen param by name (#5886)"
**Date:** 2026-11-22. Read-only; no issues filed, no comments posted, no code changed.
**Programme:** #6113 (data-layer normalization, parent #798). Survey: `~/workspace/wnorm/SURVEY.md` (same tip).

---

## Q1 — context via links, not repetition

### Q1.0 "Platform-id": there is no platform entity

Two senses of "platform" exist in the code, neither is a row with an id:

- **Broker platform** — `platformId: "etrade" | "alpaca" | "sandbox"` (`src/trading/agent.ts:25`), a data-provider enum carried on trading paths (`src/agents/trading-agent.ts:257+`). It names which broker a capability runs against, not an identity. It is a vocabulary value, not a link.
- **The `"platform"` tenant scope** — IAAA memberships with `tenantId === "platform"` are the platform scope, explicitly excluded from tenant resolution (`src/services/platformIdentity.ts:resolveCurrentTenant` filters `tenantId.trim() !== "platform"`). "Platform" here is a scope value, not a table.

There is no platform/deployment id column anywhere. The deployment is a single platform. **The ER model therefore has no platform table.** If the owner wants a platform row (e.g. for a future multi-deployment), that is a new-entity decision for S0 — not something the code implies today.

### Q1.1 Tenant-id: three authorities, no master table, repeated as free text

**No `tenants` table exists.** The only tenant-named tables are `agent_tenant_settings`, `agent_tenant_channels`, `agent_tenant_projection_carriers` (d1Catalogue.ts:403, :1700, :2732) — settings keyed by tenant id, not a master table. `tenantId` appears 44 times as a column in `src/data/drizzleSchema.ts`.

**Where a tenant id comes from** (`src/services/platformIdentity.ts`, #2219/#4600/#4602):

1. **Commercial account row** (`agent_commercial_accounts`, D1: `id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, tier, credits_usd, included_runs, updated_at_ms` — d1Catalogue.ts:388-395). The account row is the billing tenant. `resolveAccountTenantId` (`src/services/accountTenant.ts`) reads `getAccount(login).tenantId`; a missing row stamps NULL, never a fallback.
2. **IAAA tenant memberships** — one login can hold many; `resolveCurrentTenant` orders account > earliest active membership > `null` (never the env default silently). Memberships live in the SessionStore DO bucket (`iaaa-membership:` keys, `src/data/sessionPorts.ts`), not in SQL.
3. **Env default** (`IAAA_TENANT_ID` / `"primary"`) — never a silent fallback in `resolveCurrentTenant`.

When a login has no account row, the personal scope is the synthetic `login:<login>` id (`LOGIN_TENANT_PREFIX`, `toLoginTenantId`, platformIdentity.ts:59-70; real tenant creation rejects that prefix so a login string can never collide with a real tenant id).

**Where it is stored today:** as free text on nearly every table (`tenantId` columns, no FK, no reference target). Where it is derived at read time: the usage-events meter stamps the account tenant at write (`accountTenant.ts` header, #3185/#3182 rule); the #4965 open fix (CLO-arsi, under #4935) found chain/schedule projection rows stamping the deployment-default tenant instead of the owning tenant (`projectSynthesized`, `src/agents/scheduled-agent.ts:2756-2775`, resolves via the `resolveIaaaTenant` fallback).

### Q1.2 User-id vs user-login: two different keys, split by family

**The stable user id is derived, never minted.** `src/security/identityBinding.ts` (header, #945/#1182): the internal user id is a version-prefixed SHA-256 derived from the normalized (issuer, subject) pair. A minted id depended on one stored record surviving in one store; the derived id survives any store loss — the next login re-derives the same id. Email and display login are NOT inputs to any function in the module: an email change can never create a new identity or transfer an account. The binding store (`IdentityBindingStore`: `getByProvider`, `getByUserAndIssuer`, `put`, `removeByUserAndIssuer`) holds the (issuer, subject) → internal-id mapping; production construction is `iaaaLogin.createKvBindingStore` / `createWiredBindingStore`, over the SessionStore DO bucket (`iaaa-binding:` keys).

**The two keys in the tables** (`src/data/drizzleSchema.ts`, counted):

- `userId` (internal derived id), 11 columns — the **billing/commerce family**: `agent_credit_claims`, `agent_paid_submissions`, `agent_refunds`, `agent_subscriptions`, `agent_bundle_purchases`, `agent_bundle_entitlements`, `agent_billing_customers` (PK), `agent_notification_preferences` (PK), `agent_digest_sends`, `agent_digest_subscriber_emails` (PK), `agent_version_moves`.
- `userLogin` (display login), 12 columns — the **profile/quota/usage family**: `agent_reports`, `agent_onboarding_state` (PK), `agent_user_profiles` (PK), `agent_profile_idempotency_keys`, `agent_free_run_counts`, `agent_approved_free_quota_counts`, `agent_cfpay_channel_purchases`, `agent_top_up_drafts`, `agent_runs_pack_drafts`, `agent_data_captures`, `agent_usage_events`.

There is no mapping table between the two keys in the data layer. The mapping lives in the identity plane: the session record carries both (`SessionData.githubLogin` + `SessionData.internalUserId`, `src/types.ts:1100-1130`), and the binding store maps (issuer, subject) → internal id.

**Trap found:** `agent_referrals.userLogin` maps to a column literally named `session_id` (`drizzleSchema.ts:1552`: `userLogin: text("session_id").notNull()`). The column holds a user login, not a session id. Any ER work must rename it (S6) or it will mislead every future reader.

### Q1.3 Session-id: KV-shaped, not a SQL table

Sessions live in the **SessionStore DO**, bucket `"sessions"`, inside the `kv_store` table — bare-UUID session keys alongside `iaaa-binding:`, `iaaa-membership:`, `iaaa-access-request:` keys (`src/data/sessionPorts.ts` header, #2433/#1976 step 5b). The session record (`SessionData`, `src/types.ts:1100`) carries `githubLogin`, `githubAvatar`, `githubName`, `createdAt`, `firstCreatedAt` (30-day hard cap), and — when IAAA wiring is on — `internalUserId`, `providerIssuer`, `providerSubject`, `authTimeMs`, `lastActivityMs`, `sessionVersion`. Absolute-expiry TTL is port contract (§3.6): consumers re-check expiry on read.

`session_id` as a SQL column appears only in: `agent_native_ledger_rows.session_id` (drizzleSchema.ts:870), `agent_async_jobs.session_id` (:1932), `mas_async_jobs.session_id` (doCatalogue.ts:320, :629) — plus Stripe checkout session ids (`stripe_session_id`, `checkout_session_id`), which are **payment sessions, not login sessions**, and must not be confused with them.

**Consequence for the ER model:** sessions stay KV-shaped. Their shape is a UUID-keyed record with TTL semantics — the port contract already defines it. The link is `session_id → SessionStore lookup`, not a SQL FK. A relational `sessions` master table would mean moving sessions into SQL; nothing in the code asks for that, and the TTL/expiry contract is KV-native.

### Q1.4 Job-id / run-id

- **Job-id is client-supplied, never invented.** The define route requires `jobId` in the body and refuses without one (`src/agents/routes/jobDefinitions.ts`: "Defining the … job requires a jobId in the body — one is never invented"). `job_pipeline_definitions.jobId` is the TEXT PK — it already IS the jobs master table. The link is `job_id → job_pipeline_definitions.job_id` (unenforced today; S1/S2 add the FK).
- **Run-id is split by type.** `job_run_records.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (d1Catalogue.ts:1895-1896), while every other run reference is TEXT (`job_pipeline_artifacts.run_id`, `job_pipeline_instances.current_run_id`, `agent_async_jobs.job_id`, `agent_reports.linked_job_run_id` — TEXT pointing at an INTEGER PK). Runs are generated per run (engine `newRunId` dep); the integer-vs-text split is the S0/S6 domain decision.

### Q1.5 Proposed ER model

**Master / reference tables (the link targets):**

| Entity | Master table | Key | Home | Status |
|---|---|---|---|---|
| Tenant | `tenants` (new, D1) | `tenant_id` (TEXT PK) | D1 | **To create (S6)** — fed by the identity plane: one row per tenant id that appears anywhere; the commercial-account row and IAAA memberships remain the write sources. S0 must first rule the boundary: master table in the data layer vs "identity plane owns the master; data layer references by key only, key format pinned". |
| User | `users` (new, D1) | `internal_user_id` (TEXT PK, the derived SHA-256 id) | D1 | **To create (S6)** — `user_login` becomes an attribute, not a key (a login change must never re-key a user — identityBinding.ts proves why). The billing family already keys by it; the profile/quota family migrates from `user_login`. |
| Session | SessionStore DO, bucket `"sessions"` | UUID key | DO KV | **Stays KV** — no SQL table. Link is lookup, not FK. |
| Job | `job_pipeline_definitions` (exists) | `job_id` (TEXT PK) | D1 + DO mirror (see Q3) | **Exists** — link `job_id → definitions.job_id` via FK (S1/S2). |
| Run | `job_run_records` (exists) | `id` — **type to unify in S0/S6** | D1 (+ DO twin, #5852) | **Exists, split** — INTEGER PK vs TEXT references; unify the domain, then FK the references. |
| Platform | — | — | — | **No table.** Provider enum + `"platform"` scope value only (Q1.0). |

**Linking rule:** a row carries the FK column for the context it belongs to (tenant, user, job, run) and resolves everything else through the link — it must NOT repeat the linked entity's attributes. Concretely: `tenant_id → tenants.tenant_id`, `user_id → users.internal_user_id`, `job_id → job_pipeline_definitions.job_id`, `run_id → job_run_records.id` (after unification), `session_id → SessionStore lookup`. The per-request identity (login + internal id + tenant) is resolved once per request from the session and stamped on the row's FK columns at write time; it is never re-derived by string matching at read time.

**What stops being repeated:** the tenant/user/job/run text on every table becomes FK columns; the `login:<login>` synthetic tenant id remains a *value* (it is a valid tenant id by the #4602 rule), not a second key; `user_login` stops being a PK anywhere (it is an attribute of `users`).

**What stays denormalized (with evidence, not assumed):**
- The read-path columns (F5: `job_*_datasets.status`/`rows_persisted`, `job_delivery_datasets.input_artifact_id`, `agent_credit_claims.family`) — each comment names the read it serves; they stay, recorded as accepted in S0.
- Frozen snapshots (F6) — the snapshot IS the audit fact; normalizing it would destroy immutability.
- The twin link `agent_reports.linked_job_run_id` — heuristic (generation id + run window, only when unambiguous); it stays a nullable link, never a hard FK, until the twin stores collapse (#5852).

**Slice mapping:** S0 (policy: identity authority + tenant-resolution rule + run-id domain + user-key rule + platform-no-table decision); S6 (domain integrity: create `tenants`/`users` or record the boundary, unify run-id, rename the `agent_referrals.session_id` column, fix stale defaults); S1/S2 (FKs from the link columns); S7 (vocabularies + PK gap — not identity).

---

## Q2 — data integrity with JSON

### Q2.0 The store enforces nothing about JSON

Verified: **zero `json_valid` / `JSON_VALID` occurrences in `src/`**; **zero JSON CHECK constraints**; the only CHECK in the whole system is the singleton-row guard (`id INTEGER PRIMARY KEY CHECK (id = 1)`, d1Catalogue.ts:1236). The DDL pin/harness (`tests/schema_component_*`) pins catalogue statements byte-for-byte — a `json_valid` CHECK is addable, but none exists. JSON integrity today is entirely application-side, at the boundary or not at all.

### Q2.1 Per-family: write path, read path, validation, failure mode

| JSON column family | Write path (validation) | Read path (validation) | On corrupt / shape-invalid JSON |
|---|---|---|---|
| **Job definitions** `job_pipeline_definitions.definition_json` (+ versions) | Define route builds from the spec (`jobDefinitionSpecBuilder` + binders); per-field readers refuse invalid values by name → 400 (`jobDefinitions.ts`: `readStageTimeouts`, `readStageMaxParallel`, `readStageRetryBuckets`, `readStageProcessing`); `resolveNode` hand-validates every field, throwing `JobPipelineError` (`jobPipelineConfig.ts:95-207`). No Zod anywhere in the job-pipeline services; no validation in the adapter. | `JSON.parse(...) as JobDefinition` — bare parse + `as` cast, no validation, no try/catch in the adapter (`d1JobPipelineAdapter.ts:183,192,200`). | Corrupt JSON **throws to the caller** (a run-start read fails the run). Well-formed-but-invalid JSON passes the cast and fails later at `resolveNode` (run start). |
| **Checkpoints** `job_pipeline_instances.checkpoint_json` / `stage_checkpoint_json` / `stage_desired_json` | `JSON.stringify` of the in-memory checkpoint (`d1JobPipelineAdapter.ts:88-90`). No schema, no validation. | Bare `JSON.parse(...) as …` (`:110-117`), no try/catch. | Corrupt checkpoint **throws to the caller** (run resume fails). |
| **Artifacts** `job_*_datasets.artifact_json` (5 tables) | `JSON.stringify(artifact)` (`d1EnrichedDatasetAdapter.ts:106`). No validation. | Bare `JSON.parse(...) as EnrichedDatasetArtifact` (`:126,145,152`); `latestUsable` additionally checks `isUsableEnrichedArtifact` (shape check, not schema). | Corrupt artifact **throws to the caller**. |
| **Mesh evidence** `agent_mesh_eval_results.facts_json` / `failures_json` | `JSON.stringify` (`d1MeshEvalAdapter.ts:96-101`). No validation. | `parseFacts` / `parseStringArray` — try/catch, **silent fallback to `{}` / `[]`** (`:38-55`). | Corrupt evidence is **silently dropped** (empty facts/failures). |
| **JSON arrays of FKs** `member_product_ids`, `falsifying_outcome_ids_json`, `members_json`, `target_version_ids_json` | `JSON.stringify` of the caller's array (e.g. `d1ProductBundleAdapter.ts:163`). No membership validation (no check the ids exist). | `JSON.parse` in try/catch, filter to strings, **silent fallback to `[]`** (`d1ProductBundleAdapter.ts:72-77`). | Corrupt array → **empty membership, silently**. A non-existent member id is indistinguishable from a removed one. |
| **Snapshots** `agent_calibration_decisions.snapshot_json`, referral-code terms | `JSON.stringify` of the frozen terms. No validation (the snapshot is the fact). | Bare parse + cast (same pattern as definitions). | Corrupt snapshot throws; shape is not re-validated (by design — it is frozen). |
| **Settings EAV** `mas_settings.value` (raw string), `agent_billing_policy.value_json`, `otel_config_overrides.value_json` | `mas_settings`: plain string write at the port (`createSettingsPort`); **only the 22 `pipeline.*` keys have per-key validation** (`validatePipelinePolicySetting`, `pipelinePolicy.ts:397`, enforced at the panel POST route, `pipelinePolicySettings.ts:48` — the only caller). All other keys are unvalidated strings. `otel_config_overrides`: raw `d1.prepare` INSERT (`otelConfigOverridesStore.ts:78`), no validation. | `readSettingRaw` catches errors → `null` (`reportDispatch.ts:81-90`). `otel` read returns raw rows; on read failure → `[]` (fail-closed to empty overrides, `:58-70`). | An invalid `pipeline.*` value is refused at write (by name). Any other key accepts any string; a corrupt JSON value in `value_json` is discovered only by its consumer, if at all. |
| **Billing policy** `agent_billing_policy.value_json` | `JSON.stringify(value ?? null)` (`d1JobPipelineAdapter.ts:262` — the billing-policy writer in the same adapter family). No schema. | `JSON.parse(...) as unknown` (`:281`) — cast only. | Corrupt value throws to the caller. |

**The only `safeJsonParse` in the codebase** is `src/workflows/researchDataPorts.ts:81` (research run-report/evaluation JSON) — try/catch returning `unknown`. Everything else is either bare `JSON.parse + as`-cast (throws) or try/catch-with-silent-empty-fallback (drops).

### Q2.2 Verdict

JSON integrity today is **boundary validation or nothing**: definitions are validated at the define boundary by hand-written validators (not a schema, not at the store); the 22 `pipeline.*` settings keys are validated per-key at one write route; everything else is `JSON.stringify` on write and `JSON.parse` + `as`-cast on read. Corrupt JSON either throws the read (definitions, checkpoints, artifacts, snapshots, billing policy) or is silently dropped to empty (mesh evidence, JSON arrays of FKs). No JSON column can be invalid *at the store* — the store accepts any string — and no JSON column's shape is enforced on read. The two failure modes are both honest in their own way (throw vs empty), but neither is a guarantee: a silently-emptied membership list and a thrown run-resume are both data-integrity failures the store never sees.

### Q2.3 What the programme should add, per slice

- **S0 (policy):** the JSON-integrity rule — which families get a `json_valid()` CHECK (cheap, store-enforced: "is it JSON at all"), which get a typed port validator (shape), and which stay opaque (frozen snapshots, genuinely opaque config). Decide the failure mode per family (throw vs empty) and record it; the silent-empty fallback must become a named, logged event, not a bare `catch {}`.
- **S4 (join tables):** the JSON arrays of FKs disappear into join tables with FKs both ways — that is the integrity fix for the worst family (a non-existent member id becomes un-storable).
- **S8 (EAV decision):** rule the settings stores — per-key typed validators for every key family (extending the `pipeline.*` pattern), or typed columns; the EAV keep-vs-type decision is S8's.
- **Not #6113:** the `otel_config_overrides` raw-`d1.prepare` INSERT is inline DML — externalizing it is #5858's scope; #6113 adds the shape validation, #5858 moves the statement.

---

## Q3 — data integrity and no duplication, across DOs and D1 and within each

### Q3.0 The duplication families, verified on the tip

| # | Same fact, two places | Canonical | Derived / mirror | What keeps them consistent today | What breaks on divergence |
|---|---|---|---|---|---|
| D1 | **Reports:** DO `mas_reports` ↔ D1 `agent_reports` | `mas_reports` (DO, per-login instance; #5040 H-3, pin `tests/one_store_per_family_5040.test.ts:18`) | `agent_reports` (D1 projection, versioned, LWW) | **One shared projector** (`src/data/runLedgerProjection.ts`, #4116): the ONE D1 writer; three carriers (queue, ORM, sweep) call the same function. Reports: read-before-write, skip when the latest version is current, else version+1. Twin link stamped only when exactly one candidate matches (generation id + run window); ambiguous → null. | Stale projection reads (a report visible in D1 that the DO no longer has, or vice versa); twin link null on ambiguity (honest, but the D1 row is unlinked). |
| D2 | **Async jobs:** DO `mas_async_jobs` ↔ D1 `agent_async_jobs` | `mas_async_jobs` (DO) | `agent_async_jobs` (D1 projection) | Same projector: conditional upsert (replay no-op, stale never overwrites newer, newer lands). | Same as D1. |
| D3 | **Usage events:** DO `usage_events` ↔ D1 `agent_usage_events` | `usage_events` (DO, "the DO table stays authoritative", drizzleSchema.ts:1968) | `agent_usage_events` (D1, "the ONE queryable tenant surface across the split DOs") | Live hook (`recordUsageEvent`) + **one-off sweep** (`usageEventsReconcile.ts`, operator-invoked, per-instance, 100 rows/call, 365d prune in the same pass). Some sites project ONLY through the sweep. | Unmirrored rows (the mirror under-counts tenant usage); tenant ladder is approximate for NULL-tenant rows (today's tenant stamped, no account history). |
| D4 | **Job definitions:** ScheduledAgent host DO (`pipelineSql`) ↔ D1 (workflow residency) | Host DO (`pipelineSql`, `scheduledTasksPipeline.ts:199-207`) | D1 mirror for workflow residency | **Mirror-on-dispatch** (`scheduledTasksPipeline.ts:893-950`): read the definition from the host DO, compare `rawConfig` JSON with the D1 copy, re-`defineJob` into D1 when missing or different. | A definition edited on the host after dispatch is stale in D1 until the next dispatch; a workflow run reads the stale mirror. (Define goes through the host door — `definePipelineJobFromSpecViaDoor`, orchestrator.ts:3444 — so the DO copy is the write source.) |
| D5 | **Shard jobs:** DO `mas_async_jobs` (terminal, with chain id) ↔ D1 `agent_shard_jobs` | `mas_async_jobs` (DO) | `agent_shard_jobs` (D1) | `shardJobReconcile` (orchestrator): converges terminal rows with a chain id; bounded to the most recent 100 rows; queued/running rows skipped. | Rows past the 100-row window never converge; a chain's history is incomplete in D1. |
| D6 | **Datasets:** D1 `job_*_datasets` ↔ DO `job_*_datasets` (5 families) | Per #5040/#5852: D1 is the default run-ledger store; the DO leg is the exception | The other plane's copy | Same projector/carrier pattern as D1/D2 for the run-ledger family; dataset rows are written per-residency. | Same as D1/D2, plus the residency question (which plane's copy a read should trust). |
| D7 | **Marketplace mirrors:** D1 `agent_categories` / `agent_referrals` / `agent_ads` / `agent_external_ads` ↔ DO `mas_*` | Per #5040 roles | Column-for-column mirrors ("so the same records flow over both residencies", drizzleSchema.ts:1538) | Dual-write at the seam (the mirror is written alongside the canonical). | The two copies drift when one write path is missed; no reconciler named for this family. |
| D8 | **Run ledger:** D1 `job_run_records` ↔ DO `job_run_records` | D1 is the default run-ledger store (ruled, #5852); DO leg is the exception | DO copy | #5852's move inventory (44 movable DO uses). | Two ledgers disagree on run history until the DO leg moves. |
| D9 | **Within D1:** read-path denormalized columns (F5) + derived counters (F7) | The source row | The denormalized/counter column on the same row | Application code maintains them; no store rule. | Counters drift from the rows they count (no reconciliation pin today); denormalized `status`/`rows_persisted` can disagree with `artifact_json`. |
| D10 | **Within DO:** the same table in many per-login DO instances | Each instance's own rows (owner discipline) | — | Owner scoping (`reportOwnerOf` refuses owner-less writes; per-login instance holds only its login's rows). | Not duplication — sharding by owner. The risk is the opposite: a row written to the wrong instance is invisible to its owner. |

**Survey cross-check:** the survey's F4 twin/projection pairs all hold on the tip (verified: reports, async jobs, usage events, datasets, marketplace mirrors, job-pipeline family). One survey drift found: the #5040 pin test is `tests/one_store_per_family_5040.test.ts`, not `tests/canonical_stores_5040.test.ts` (that path does not exist on main).

### Q3.1 What keeps copies consistent today — the honest summary

- **Write-time fan-out through ONE projector function** for the run-ledger family (reports, async jobs) — three carriers, same code, LWW / conditional-upsert rules. This is the strongest consistency in the system.
- **One-off operator sweeps as backstop** for reports/async jobs (`runLedgerReconcile.ts`, POST `/api/ops/run-ledger-reconcile`, per-instance, 100 rows/call) and usage events (`usageEventsReconcile.ts`). They are NOT recurring crons (deliberate: #4112 schedules-off, operator invokes). Anything the live carriers miss waits for an operator.
- **Mirror-on-dispatch** for job definitions (compare-and-redefine at workflow dispatch).
- **Nothing** for marketplace mirrors (dual-write, no reconciler named) and for deletes (see below).
- **Deletes do not cascade anywhere.** Two same-named delete functions exist and each deletes one half: `scheduledReports.deleteCanonicalReport` (DO row + R2 object, `scheduledReports.ts:1214-1275`) and `auditReportProjection.deleteCanonicalReport` (D1 projection row, platform-admin gated, `auditReportProjection.ts:297-316`). No caller coupling the two was found. A canonical delete through the scheduledReports path strands the D1 projection row; a projection delete leaves the DO row + R2 object. The orphan sweep owns stranded R2 objects (named follow-up), not stranded projection rows.

### Q3.2 What the programme should add, and what belongs elsewhere

- **#6113 (this programme):** the projection-consistency rule in S0 (one projector per family, carriers named, sweep cadence named, delete coupling required — a canonical delete must delete both halves in one scope or record the stranded half); the FK spine (S1/S2) makes the link columns real FKs where the target exists (twin links stay nullable/heuristic); S5 (derived counters: compute-at-read or reconciliation pin — the within-D1 duplication fix); the final census (S8) re-runs the orphan/divergence checks.
- **#5852 (twin-store elimination — NOT #6113):** collapsing the twin stores themselves (44 movable DO uses). #6113 adds constraints *within* each store and the projection-consistency rule; it must not assume a single home until a #5852 move lands, and FK work on a twin table sequences after/around that table's move.
- **#4961–#4965 (CLO-arsi, under #4935 — NOT CISO's, see Q5):** open fixes from the #4935 cross-store consistency audit (ADR 0033) that #6113 must link, not duplicate: #4961 (F-1: gate d1-only read mode on the synchronous ORM projection carrier); #4963 (F-3: atomic stale-guard for the report projector's version bump under concurrent carriers — the read-then-write race in `projectReport`); #4965 (F-5: thread the owning tenant into chain/schedule projection instead of the deployment default — the Q1 tenant gap, in projection form). #6113's S0 should name these as dependencies; their landing changes what S1/S2 must enforce.
- **#5427 (DO-leg atomicity):** the atomic stale-guard (#4963) and any multi-write projection atomicity belong with #5427's mechanism decision, not #6113's DDL.

---

## Q4 — ACID compliance + CRUD in the ORM layer

### Q4.0 Atomicity today, per plane

**The transaction discipline exists — as an aspect no production code uses yet.** `src/aspects/transactionAspect.ts` (#2288, ADR 0022 D-C) states the contract (D-C.3): the writes in one wrapped call are applied atomically, or the call fails honestly; a store that cannot honour the scope refuses BEFORE any write runs (`DATA_TX_CANNOT_HONOUR`); cross-store atomicity is NOT claimed — a unit spans exactly one backend. Proof status, stated in the module: exercised only by the proof pins in `tests/transaction_proof_2288.test.ts`; **no production surface consumes it yet; D-I step 1 is the first planned consumer.**

**D1 leg** (`D1BatchTransactionBackend`): D1's atomic primitive is `batch()` — statements are prepared and BUFFERED while the wrapped call runs, then applied by ONE `batch()` call on success; on throw the buffer is discarded and nothing was ever sent. Write-only: a statement's result cannot be read inside the unit. **`db.transaction()` is never used** (sequential BEGIN/COMMIT, not atomic — migrationRunner header, ADR 0002). That prohibition is repeated in the header of nearly every D1 adapter (`d1CommercialAdapter`, `d1JournalAdapter`, `d1NativeLedgerAdapter`, `d1RefundAdapter`, `d1SubscriptionAdapter`, `d1ProposalLedgerAdapter`, …) and pinned: `d1RetryPolicy.ts:76-77` — "The helper never calls `db.transaction()` (sequential BEGIN/COMMIT, not atomic — forbidden by the #4937 pin)".

**DO leg** (`DoSqlTransactionBackend`): the unit runs inside `storage.transactionSync` — synchronous, so the wrapped call MUST be synchronous; an async wrapped call is refused with `TX_CANNOT_HONOUR` from inside the closure, which rolls the transaction back. The one real `storage.transaction` call site in production is `src/agents/screener-agent.ts:857` (a single-DO transaction).

**Where atomicity is NOT available, the code says so honestly:**
- The schema-recreate route (`src/agents/routes/maintenance.ts:153`): "The DO leg claims no atomicity: the aspect's DO backend refuses async work and the executor is async, so a failed run leaves the steps that already ran in place — the report says so."
- `doSqliteAsyncJobAdapter.ts:18`: claim-by-check (`!== 1` meant not claimed). "No transaction wrap."
- `doSqliteDiscoveryAlertAdapter.ts:11`: "no transaction wrap: its units are single statements."
- The DO DML path (`doDmlExecutor.ts`) is sync by design with no transaction or batching — a multi-statement DO write failing midway leaves partial state. That is **#5427's scope** (verified live: open, "DO-leg multi-write atomicity + per-statement audit events"; mechanism decided in the build: batching, compensating design, or recorded stay-non-atomic with honest failure).

**Multi-write paths, atomic or not (verified):**
| Path | Atomic? | Evidence |
|---|---|---|
| D1 adapter writes via the transaction aspect (batch unit) | Yes — when used; **no production surface uses it yet** | transactionAspect.ts proof status |
| D1 `db.transaction()` anywhere | N/A — never used, forbidden by pin | adapter headers; d1RetryPolicy.ts:76-77 |
| DO single-object `storage.transaction` / `transactionSync` | Yes, per-object | screener-agent.ts:857; transactionAspect DO leg |
| DO multi-statement DML (`doDmlExecutor`) | **No** — partial state on mid-write failure | #5427 problem statement (verified on main `3123db1d`) |
| DO schema-recreate route | **No** — honest partial report | maintenance.ts:153 |
| Cross-store (DO + D1 in one unit) | **Not claimed** — refused with `TX_CANNOT_HONOUR` | transactionAspect.ts contract |
| Report fan-out (R2 + Vectorize + AI Search + DO INSERT) | **No** — deliberately not a transaction candidate (#2347: its only SQL write is one already-atomic INSERT; the R2/Vectorize/AI Search legs cannot join a DO transaction); fan-out outcome recorded on the row | canonicalReportStorePorts.ts header |
| Bundle-entitlement purchase batch | Atomic-by-construction claim in the comment ("written in the SAME atomic batch as the purchase row", drizzleSchema.ts:723) — the batch is the D1 batch primitive, not `db.transaction()` | drizzleSchema.ts:723 |

### Q4.1 Consistency / isolation / durability — what the store gives vs what the code assumes

- **Consistency:** the store gives PK/UNIQUE enforcement only (and barely that — see the survey). All other consistency (FKs, CHECKs, vocabularies) is application-side or absent. The code assumes nothing stronger — no adapter relies on a constraint the store does not have, because none exist to rely on. That is the gap, not a violation.
- **Isolation:** D1 batch units are write-only and buffered (no read-your-writes inside a unit — the contract says so). DO `transactionSync` is per-object serializable within the object. Cross-object and cross-store reads have no isolation guarantee in code; the run-ledger projector's read-before-write (latest version, then version+1) is a race under concurrent carriers — that is exactly #4963 (F-3, open, CLO-arsi).
- **Durability:** D1 and DO SQLite are durable stores; the code does not assume more (no fsync claims in the data layer). The one durability-adjacent gap is the audit chain: audit events are append-only with a hash chain (`iaaaAudit.ts`, `verifyChain` + `previousEventHash`/`eventHash`), but retention is a Q7 policy decision (see Q5) — the store caps and refuses new appends with `AUDIT_STORE_FULL` (auditLogStoreImpl.ts:139) rather than deleting evidence.

### Q4.2 CRUD in the ORM layer — what exists, what is missing

**The standards (ADR 0032 / #3260, verified):** Drizzle is the D1 standard, the mini-ORM is the DO standard. The port layer (adapters + the DML catalogue from #4282) is the write path for most tables. But "CRUD" means all four operations, and the layer is not complete:

- **Reads are universal; creates/updates are the norm; deletes are the gap.** The clearest case: **job definitions have no delete operation at all** — no `deleteDefinition`/`deleteJob` in `jobPipelinePorts.ts`, `d1JobPipelineAdapter.ts`, or `doSqliteJobPipelineAdapter.ts` (verified by grep). Definitions are append-only in practice (upsert + append-only version history, #5865). Report rows have deletes on both planes (see Q3.1) but uncoupled. Audit events are append-only **by design** (hash-chained; deletion would break tamper-evidence — not a gap).
- **Bypass paths (raw SQL / inline DML):** **232 non-exempt inline DML literals** in production code (#5858, verified live — 248 total, 16 named exemptions; `sql.exec` sites: 489 in `src/` across 80 files). The OTEL override store writes via raw `d1.prepare` INSERT (`otelConfigOverridesStore.ts:78`). These bypass the catalogue — that is **#5858's scope** (externalize all remaining inline DML platform-wide), not #6113's.
- **The DDL/DML externalization programme (#4282) is done for the catalogue; its P5 follow-on #5427 owns the DO-leg atomicity + per-statement audit events.** #6113 must not claim either scope.

### Q4.3 What the programme should add, per slice

- **S0 (policy):** the CRUD census — per table, which of C/R/U/D exists through the port layer and which is missing or bypassed (raw SQL/inline DML). The census is S0's job because the slices need the list; the enforcement (port-only writes) is #5858's scope, and the atomicity mechanism is #5427's. S0 also records the transaction-discipline adoption point: the aspect exists and is proven — S0 rules when production surfaces start consuming it (D-I step 1 was the planned first consumer).
- **S5 (derived counters):** counter maintenance is a multi-write (row + counter) with no atomicity today — the keep-with-pin decision must name its atomicity (or its honest-failure mode).
- **S6 (domain integrity):** the tenant/user reference-table writes are multi-row (master row + link) — same atomicity question, same answer: aspect unit or honest failure, decided in S0.
- **Not #6113:** DO-leg multi-write atomicity + per-statement audit events (**#5427**, open); inline-DML externalization (**#5858**, open, 232 literals); the report-projector atomic stale-guard (**#4963**, open, CLO-arsi). #6113 links them as dependencies and sequences after/around them.

---

## Q5 — align with CISO work

### Q5.0 What was checked (live, not memory alone)

- `~/memory/people/ciso.md` (updated 2026-11-12) + memory search for CISO data work.
- Live issue state via the connector (2026-11-22): #767, #3929, #3930, #3931, #3932, #945 (comments), #4935, #4961–#4965.
- Issue COMMENTS checked for lane claims before attributing scope (the #606 duplicate lesson).

### Q5.1 Live state — and two corrections to the brief

| Item | Live state | Note |
|---|---|---|
| #767 AISecOps programme | **CLOSED**, 4 comments, **no sub-issues** | The programme issue is closed; the lane programme continues, but there is no open AISecOps data-integrity issue to align against. No overlap with #6113. |
| #3929 (Yahoo gap-filler) | **OPEN parent, 0 comments**; slices #3930/#3931/#3932 all **CLOSED** | CISO-authored, completed 2026-11-10–12. The parent stays open (never closed). No overlap with #6113 — the joins are done. |
| #945 IAAA epic (Q7) | **OPEN**, 42 comments | CDO signed its Q7 half 2026-10-29 (comment 6490323689). **CISO's half: no sign-off found in the 30 comments returned** (2026-10-21–23, pagination cut the later 12); per the 2026-11-12 record it is still outstanding. Q7 stays open. See Q5.2. |
| #4961–#4965 | **OPEN, parent #4935 (CLOSED)** | **CORRECTION: these are CLO-arsi's, not CISO's** — agent tag `#clo-arsi` on each, parent #4935 "Cross-store consistency contract" (ADR 0033 audit findings F-1/F-3/F-5…). The brief's attribution to CISO was wrong. They overlap #6113 directly (see Q5.2) and must be linked, not duplicated, and not re-attributed. |
| #907 RiskPolicyEngine | Open (per memory; not re-read live) | CISO + CTO must confirm the authoritative RiskPolicyEngine before implementation. No #6113 overlap — the engine is not a data-layer table. |

### Q5.2 Overlaps, dependencies, and what needs a CISO ruling

**Q1 (identity linking) — overlaps CISO's ground. CDO-owned DDL, CISO-ruled identity.**
- The identity plane (IAAA epic #945) is CISO's programme ground: the CISO lane authored the IAAA implementation plan (comment 6317406199, 2026-10-21) and the epic's sequencing. The `users`/`tenants` master-table decision touches that plane: the internal user id derivation (identityBinding.ts) and the tenant-resolution authorities (#4600/#4602) are already ruled, but **creating `users`/`tenants` tables in the data layer is a new write source for identity data and needs a CISO review** — specifically: does the data layer minting rows for identities violate the "derived, never minted" rule (#1182), and who owns the write (identity plane feeding the tables, never the data layer minting them)? That review is a joint review point at S0, not a CDO-only decision.
- The Q7 gate (retention 365 days, audit-chain tamper-evidence) is the other CISO dependency: audit retention is Q7 policy, half-ratified, awaiting CISO's half. **#6113 must not decide retention or audit pruning** — the audit store's cap-and-refuse behavior (`AUDIT_STORE_FULL`) is the interim rule until Q7 closes. If S0/S8 needs a retention statement, it records "per Q7 when ratified" and links #945.
- What is CDO-owned: the FK columns, the reference-table DDL, the tenant/user linking rule, the run-id unification. What needs CISO input: the master-table write-source decision + any identity-data retention. **Open question (no ruling invented):** whether the data layer may hold a `users` master table at all, or whether the boundary is "identity plane owns the master; data layer references by key only, key format pinned" — that is the S0 decision, and it needs the CISO review before S6 builds.

**Q2 (JSON integrity) — no CISO overlap found.** No CISO-owned JSON-validation or schema work exists in the checked issues. The pipeline.* per-key validation and the hand-written definition validators are CDO-owned. No CISO ruling needed. (AISecOps #767 is prompt-injection defense for inbound content — closed, and unrelated to stored-JSON validation.)

**Q3 (no duplication) — overlaps CLO-arsi's #4961–#4965, not CISO's.** #4963 (atomic stale-guard, F-3) and #4965 (tenant threading, F-5) are the two open fixes on #6113's exact ground. **#6113 must link them as dependencies and sequence after/around them; it must not re-file their scope.** Coordination: S0 names #4961/#4963/#4965 as dependencies; if #4963 lands first, S1/S2 inherit its atomic guard; if #6113 lands first, its projector work must not conflict with the guard's shape. The #4935 audit (ADR 0033) is the shared decision home for the cross-store consistency contract — #6113 works within it, as it works within #5040's canonical roles.

**Q4 (ACID/CRUD) — overlaps CISO's audit ground via Q7, and #5427/#5858 (CDO).** Per-statement audit events (#5427's second half) are audit-chain events — the audit chain's tamper-evidence is Q7 ground, but the *mechanism* (calling the audit funnel per statement) is #5427's CDO scope; no CISO ruling is needed for the mechanism, only for retention (Q7, above). The transaction aspect's adoption (D-I step 1) is CDO-owned.

**What must not duplicate:** AISecOps #767 (closed, no overlap); #3929 joins (closed, no overlap); #4961–#4965 (CLO's, link don't duplicate); #5427 (DO atomicity + audit events); #5858 (inline DML); #5852 (twin elimination); #5040 canonical roles (decided, don't re-decide).

**Coordination the programme needs:**
1. **S0 joint review point with CISO** on the identity master-table decision (Q1) — before S6 builds.
2. **Dependency links** on #6113 to #4961/#4963/#4965 (CLO), #5427, #5858, #5852, #945 (Q7, for retention only).
3. **No new CISO-owned issue** is filed by this programme; if the S0 review surfaces a CISO decision, it is recorded on #6113 (or #945 for Q7) and the CISO lane is asked, not assigned.

---

## Survey cross-checks (task §4)

- **No `tenants`/`users` master table — HOLDS** on the tip (no such CREATE TABLE; only `agent_tenant_settings`/`agent_tenant_channels`/`agent_tenant_projection_carriers` keyed by tenant id).
- **Identity in the security plane — HOLDS** (identityBinding.ts derives the internal id; platformIdentity.ts resolves the tenant; SessionStore DO holds sessions/bindings/memberships).
- **Encoded composite keys — HOLDS** (`jobPipelinePorts.ts:59` `\u0001` verified directly; definition-version `jobId:version` and price-catalogue `cat-…` per the survey's cited lines).
- **Drift found:** the #5040 pin test is `tests/one_store_per_family_5040.test.ts`, not `tests/canonical_stores_5040.test.ts` (that path does not exist on main).
- **Drift found (survey already noted):** the DO catalogue header says 69 tables; the recount is 70.
- **New finding:** `agent_referrals.userLogin` maps to a column literally named `session_id` (`drizzleSchema.ts:1552`) — a naming trap for the ER work.
- **New finding:** `createJobPipelineStoresFromDo` has zero callers on the tip — dead constructor; the DO side uses `createJobPipelineStoresFromSql(pipelineSql(ctx))`.
