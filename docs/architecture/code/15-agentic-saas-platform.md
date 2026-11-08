# 15 — Agentic-SaaS platform standards

**Purpose.** The platform families an agentic SaaS must have, stated once
each: what the standard is, how the tree conforms today, and who owns the
family. Each family points at its programme home; this file is the single
statement, not a second implementation.

**Canonical sources.** The programmes named per family: #1116 (data-provider
platform), #2381/#1969 (catalogues), #1976 (data foundation), Q7 on #945
(audit rulings), #3525/#3766 (neutrality, no-fake), #2408/#2409 (idempotency
conformance), #3760 (agent schedule agency, design-stage),
`docs/architecture/security/model-prompt-registry.md`,
`src/security/storageRetention.ts` (the retention register).

**Adoption note (ruling, 2026-11-08).** Six completions that the survey
carried as proposals are **adopted as standards now**: idempotency as one
platform standard (R1), optimistic concurrency/versioning for shared
D1-resident records (R2), backup/DR (R9), license discipline (R12),
performance budgets (R13), and an eval requirement for model/prompt changes
(R7). Each is marked ADOPTED-PENDING-IMPLEMENTATION where its machinery does
not yet exist. Families whose survey proposals were *not* in the adopted six
say so explicitly.

## R1 — Idempotency and retry safety

**Definition.** A mutating operation that can be replayed — payment release,
job retry, recovery re-arm — is claim-then-execute: the replay is refused or
returns the original outcome, fulfilling exactly once. Long-running jobs
carry deadlines and a named partial-failure state, never a silent
half-result. The API-layer form is `09` J8.
**Status.** ADOPTED-PENDING-IMPLEMENTATION as one platform standard — at
base the rule existed only in pieces. **Owner: CDO.**
**Conformance at `9925ead8`.** Proven where money moves: the x402 release
path refuses a replayed transaction hash and fulfils only once
(`tests/x402_premium_end_to_end_2406.test.ts`, #2408); workflow recovery is
replay-safe and double-retry is refused (mesh G6 conformance, #2409);
workflow/stage idempotency keys are pervasive (624 `idempoten*` occurrences
in `src/`). API-layer adoption is baselined in `09` J8.

## R2 — Concurrency and consistency

**Definition.** One writer per actor: Durable Object residency is the
serialization point. Shared-store claims are atomic (`INSERT OR IGNORE` /
claim-then-execute) and race-tested. Cross-store atomicity is never claimed
(`14` Q3). Shared D1-resident records carry **optimistic concurrency**: a
version (or equivalent) checked on write, so a stale writer fails visibly
instead of overwriting.
**Status.** The single-writer and claim rules are DOCUMENTED (harvested in
pieces). Optimistic concurrency for shared records is
ADOPTED-PENDING-IMPLEMENTATION (adopted 2026-11-08). **Owner: CDO.**
**Conformance at `9925ead8`.** Claim races are conformance-tested on both
adapters (48/48 in the #1976 step gates, including claim races); 41
`INSERT OR IGNORE` sites at base. No versioning/ETag discipline exists for
shared D1 records at base — that absence is the baseline the adopted half
clears, on touch and by slice.

## R3 — Versioning and compatibility

**Definition.** Stored schemas are versioned and pinned: a record with the
wrong version is refused by name (the `SESSION_STORE_SCHEMA_VERSION` /
`OASF_SCHEMA_VERSION` pattern). Request and schedule payload shapes have one
definition site (`src/trading/screeningSchemas.ts`). Stored payloads follow
read-old/write-new windows: a reader accepts the previous shape for a stated
window while writers emit only the new shape. API versioning is recorded in
`09` J7 (unversioned, by decision).
**Status.** Migration discipline is ENFORCED (`02` B4); per-module schema
versions are DOCUMENTED and enforced in code per module; the read-old/
write-new rule is DOCUMENTED here as its first platform statement.
**Owner: CDO.**
**Conformance at `9925ead8`.** Per-module schema versions exist and are
enforced (e.g. `oasfRecords` refuses a mismatched `schema_version`);
versioning remains per-module invention at base, with no stored-payload
compat rule before this file.

## R4 — Auditability and evidence

**Definition.** Actions in the Q7 blocking set — trade execution/approval,
delivery claims, report store, guard decisions, token operations — **block**
when their own audit write fails. Audit is append-only and hash-chained
(`14` Q6). Job outcomes are recorded per real run only: a run that never ran
writes no row.
**Status.** DOCUMENTED — Q7 programme rulings (CDO sign-off 2026-10-29;
**the CISO half of Q7 is still outstanding**, flagged openly). Retention for
the audit/evidence class is set by the retention standard under R9.
**Owner: Q7 programme (CDO signed; CISO half outstanding).**
**Conformance at `9925ead8`.** The machinery conforms: the hash chain is
live and the outcome feeds are real-only (#3527/#3530 rule). The standard
lived as programme rulings before this file; the 365-day retention was
half-ratified and per-table windows diverged — resolved as configuration
under R9, not by this section.

## R5 — Data provenance and honesty

**Definition.** The product runs on live data only: no fabricated,
static-fallback, or synthetic output on any product surface. Anything not
real is visibly marked or honestly failing. Every served data element
carries its provenance — which provider actually served it. Platform copy
never presents one provider as the platform (`08` H7). An executed trade
exists only with a broker-issued reference (#2389).
**Status.** ENFORCED — the one family in this file with rule + enforcement +
census already in place. **Owner: CDO.**
**Conformance at `9925ead8`.** Provenance envelopes are in the data-provider
contract (#1116); the neutrality pin is ENFORCED and shrink-only (baseline
1,095 rows, `08` H7); the #3766 census found the fenced classes (fabricated
outcomes, silent fallbacks) at **zero** verified rows. This file states the
family as one platform standard; it does not create it.

## R6 — Cost and resource governance

**Definition.** Autonomous loops run under deterministic step caps
(`MAS_MAX_STEPS`, default 6, clamped 1–10) and per-step timeouts (`05` E7).
Per-tenant commercial quotas and budgets are enforced in the payments/
billing plane (`usageBillingSurface`, budget guard). Provider calls run
under shared fetch budgets (#1204).
**Status.** DOCUMENTED — the caps and meters exist per plane. **Owner: CDO.**
**Conformance at `9925ead8`.** Caps and meters conform per plane, with typed
behaviour at the cap in the payments plane. Recorded gap: no cross-plane
statement joins what is capped, what is metered, and what happens at the cap
per plane, and LLM token/cost metering has no aspect (`14` Q8). This
completion was not among the six adopted 2026-11-08; it is recorded here as
the family's open item, not silently adopted.

## R7 — Model and LLM standards

**Definition.** Agentic changes are tested for prompt-injection resistance,
structured-output validation, and model/provider failure (`07` G9); a
model's agreement is never the sole correctness oracle. Prompts and models
are registry-managed. **A model or prompt change ships with an evaluation
run against the eval substrate, and the evaluation result is part of the
change's evidence.**
**Status.** The test list is DOCUMENTED (`07` G9). The eval requirement is
ADOPTED-PENDING-IMPLEMENTATION (adopted 2026-11-08). **Owner: CDO** for the
standard; the eval is discharged by the lane making the model/prompt change.
**Conformance at `9925ead8`.** An eval substrate exists —
`src/mlsecops/evalGate.ts`, `src/data/meshEvalPorts.ts`, copilot/research
evaluation datasets. (The mesh-era finding "eval harness absent" is stale
and is not repeated as current.) At base no standard required evals per
model/prompt change, and prompt versioning discipline is doc-level only
(`docs/architecture/security/model-prompt-registry.md`).

## R8 — Agent lifecycle

**Definition.** Agent and user identity is derived, never invented (`04`
D7). Agents are reachable and conformance-tested over A2A. An agent's
authority is the intersection rule (`05` E3).
**Status.** DOCUMENTED. **Owner: CDO** (the delegation model, #3760, is
CDO-lane and design-first, review-gated).
**Conformance at `9925ead8`.** Identity and A2A conformance conform (#2223
closed; mesh conformance suites pin dispatch behaviour). Recorded gaps:
delegation/grants as revocable, enveloped, re-checked-at-firing grants (the
#3760 model) are design-stage, **not adopted** — they were not among the six
adopted 2026-11-08; agent memory/context management has mechanisms
(SessionStore) but no stated standard.

## R9 — Reliability, operations, and retention

**Definition — reliability.** `/health` (and `/api/health`) is the liveness
surface. Feature flags fail closed (`03` C8). When a provider or store is
down, a surface fails with an honest typed failure (`04` D4) — never a
silent substitution (R5). Backup/DR posture, stated honestly: durability
today is Cloudflare-managed; a restore is **verified** by drill, and until a
drill regime exists the posture is a claim, not a capability.

**Definition — retention (ruling, 2026-11-08).** Retention is one platform
policy, **externalized, configurable, and tiered**. Retention values are
configuration data in one register (per data class), never code literals.
Each class moves hot → archive → delete on its configured windows. The
audit/evidence class default lands at the Q7-ruled **365 days** (CISO half
outstanding, R4); operational/telemetry classes are shorter; financial and
run-record classes are longest. Per-tenant override applies where tenancy
requires it. The standing register is `src/security/storageRetention.ts`,
converted to carry the configured values.
**Status.** Health and fail-closed flags are DOCUMENTED/practised.
Backup/DR and the externalized tiered retention policy are
ADOPTED-PENDING-IMPLEMENTATION (adopted 2026-11-08). **Owner: CDO.**
**Conformance at `9925ead8`.** Baseline: **no backup/DR standard existed
anywhere** at base, and no restore verification exists — that is the tracked
gap the adopted standard names. Retention at base is a register of per-table
decisions with divergent windows (90-day defaults beside 365-day rulings) —
the divergence is resolved by explicit per-class configured values under
this standard, not by picking one number for all data.

## R10 — Privacy and data lifecycle

**Definition.** PII and secrets are redacted from logs (`03` C5). The tenant
has working data-subject surfaces — `/api/privacy/status`, `preferences`,
`export`, `erasure`. A leg that cannot be performed is named honestly in the
route's own response rather than claimed: no per-subject delete RPC exists
in some stores, and the route says so (the honesty rule, R5, applied to
privacy).
**Status.** DOCUMENTED. **Owner: CDO.**
**Conformance at `9925ead8`.** Export and erasure exist and are honest about
their limits. Recorded gaps: no data-residency rule exists or is claimed;
consent is preference-level, not a stated platform standard. Neither was
among the six adopted 2026-11-08.

## R11 — Time and i18n readiness (ruling, 2026-11-08)

**Definition — time.** All stored and instant values are **UTC**. Values on
the wire are **ISO 8601**. The zone is **data**: every schedule definition
and every market-facing display names its zone explicitly
(`America/New_York` for US market semantics, including midnight-ET
expiry semantics). A schedule's or display's zone is never ambient — never
inherited from the host, the runtime, or the reader.
**Definition — i18n.** **Readiness, not rollout.** User-facing strings are
externalized, and date/number display goes through `Intl` formatters, in new
and touched code — so a locale can be added without a refactor. No locale
ships now. This position is a readiness standard; it is explicitly **not**
recorded as a non-goal.
**Status.** ADOPTED-PENDING-IMPLEMENTATION — neither half had a stated
standard at base. Accessibility (WCAG 2.2 AA) is stated in `06` F6.
**Owner: CDO.**
**Conformance at `9925ead8`.** Baseline: `America/New_York` appears 50 times
across `src/` as practice, with no stated time standard before this file —
in the one domain (US markets, midnight-ET token expiry) where zone errors
are load-bearing. i18n machinery: **zero** hits in `src/` or `package.json`
at base; the product is single-locale by fact. New and touched code conforms
immediately under touch conformance.

## R12 — Dependency and supply chain

**Definition.** Dependencies are pinned to exact versions (`08` H8, the
operative pin). Updates arrive via Dependabot (npm weekly grouped, Actions
monthly; security updates as their own PRs through the standard merge gate,
#765). CodeQL and Gitleaks run as required checks. **License discipline:**
every dependency's license is recorded and compatible with the platform's
distribution terms; a dependency with an incompatible or unknown license is
not adopted. **Vulnerability response:** a critical advisory is triaged on a
stated clock and its disposition (patch, pin, replace, accept-with-record)
is recorded — Dependabot practice made explicit, with an owner.
**Status.** Pinning is ENFORCED (`08` H8); update automation and scanning
are in force. License discipline and the vulnerability-response standard are
ADOPTED-PENDING-IMPLEMENTATION (adopted 2026-11-08). **Owner: CISO** for
license discipline and vulnerability response.
**Conformance at `9925ead8`.** Baseline: pinning, Dependabot, CodeQL, and
Gitleaks conform at base. License discipline had **no rule** (the only
license statement found governs the gitleaks tool itself); vulnerability
response was Dependabot practice, not a stated standard.

## R13 — Performance budgets

**Definition.** Per-surface budgets are stated once, here, for the surfaces
where they matter: route payload caps, response-size limits, and
cold-start-sensitive path rules. A surface with a budget that exceeds it
fails or refuses visibly (the webhook pattern below), never degrades
silently. File-size budgets are the code-size half of this family and live
in `13` (P2/P4).
**Status.** ADOPTED-PENDING-IMPLEMENTATION (adopted 2026-11-08) — no
platform performance budget existed at base. **Owner: CDO.**
**Conformance at `9925ead8`.** Baseline: per-route practice only — e.g. the
messaging webhook rejects bodies over 128,000 B with a 413; report bodies
carry a stated SQLite-row cap — plus a performance *analysis* document:
measurement without a standard. The budget register is created under this
standard; surfaces conform on touch until it lands.
