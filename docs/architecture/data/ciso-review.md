# CISO Review — Current Issues and Code vs CDO Work (No-Duplicate Check)

- **Main tip verified:** `16d39b51448ba70567b8ca0ba295f7c34ba3bc54` (2026-11-22 13:37 UTC, "Market definition refuses a goalScreen param by name (#5886)")
- **Method:** live issue states read via the GitHub connector (`issue_read` get / get_comments / get_sub_issues / get_labels) and `search_issues` for `#CISO-bhdm` (14 hits); code verified with `git grep` on `origin/main` at the tip. Memory (`~/memory/people/ciso.md`, updated 2026-11-12) was the starting point, not the evidence.
- **Scope note:** the fleet shares one GitHub account; lane attribution is by hashtag/label. `#CISO-bhdm` = CISO lane; `#CDO-mha7` = CDO lane.

## 1. CISO open-issue inventory (live states, 2026-11-22)

### The build queue — all CISO-authored, the user's directed implementation vehicle
The user directed (2026-11-22, recorded in MEMORY.md) that data-layer integrity work ships as tracked issues in this order. **Every queue item is `#CISO-bhdm`-authored.** #6112 and #6099 are building now.

| # | State | Title / what it builds |
|---|---|---|
| #6112 | OPEN, building (comment 7080786313, 2026-11-22 14:45 UTC: "In progress — payrepo") | [Bug] Audit-chain sequence collision loses entries under concurrent appends. `InMemoryAuditPolicyAdapter.appendChainEntry` (`src/data/inMemoryAuditPolicyAdapter.ts:95`) is a read-modify-write with no serialization; route fires appends fire-and-forget. Blocks #5164's Tier 1 red on the audit funnel test. |
| #6099 | OPEN, building (comment 7080364277, 2026-11-22 14:11 UTC: branch `fix/6099-jobrunrecords-projector`) | [data-foundation] Project `job_run_records` into D1 — extend the #4116 run-ledger projector (D1 migration, `projectJobRunRecord` on the shared `RunLedgerProjector`, three carriers, twin linkage). |
| #5164 | OPEN | [observability] S10 OTel backend/platform — SigNoz vs Grafana decision, hosting, paid tier, end-to-end wiring. No OTel backend exists today; logs/metrics go to Analytics Engine + R2, traces have no store. |
| #6098 | OPEN | [observability] Audit pages: state what each store holds + a UX URL for the broad operational history. Neither audit page says what its store holds. |
| #6100 | OPEN | [observability] One attribution envelope: every platform event attributable per tenant / user / session / action. Four paths, four attribution models today; canonical audit (`recordAuditEvent`) covers security decisions only. |
| #6102 | OPEN | [data-foundation] Project `mas_events` into D1 — extend the #4116 projection to the operational event log. `mas_events` is DO-SQLite only; no D1 copy exists. |
| #6103 | OPEN | [data-foundation] Run-ledger reads D1-only — remove the merged (DO) read path. `resolveLedgerReadMode` (`src/services/runLedgerReads.ts`) defaults to `"merged"`; the DO read is joined with D1 projections. |
| #6101 | OPEN | [data-foundation] Consolidate the run-ledger/event family into few D1 tables (D1-first, one canonical run record). Four DO tables + D1 projections + `usage_events`/`agent_usage_events`, same run's data in several places, linked by convention (`asyncJobId`, `runId`, payload JSON). |
| #6131 | OPEN | [#6101] Sessions + audit keys to D1 (unless proven impossible). Sessions, E*TRADE credentials, `iaaa-audit:` keys live in the SessionStore DO (`src/security/sessionStore.ts:153`). Owner directive 2026-11-22: sessions must move to D1 unless it can't be done. |

### IAAA epic #945 (open) and its open sub-issues
- **#945 — OPEN** (42 comments, last activity 2026-11-16). `[EPIC] IAAA-with-Auth0 — Multi-Tenant IAAA and Fine-Grained Authorization (RSI-CISO mission)`. Owner decisions 2026-11-16: Q12 independent evaluation deferred; Q11 refreshed spec ADOPTED; service-identity framing corrected to broker-neutral (not E*TRADE-specific).
- **Q7 on #945 — STILL HALF-OPEN.** All 42 comments read via the REST API. CDO sign-off confirmed (comment 6490323689, 2026-10-29: blocking set, 365-day retention, `iaaaAudit.ts` SHA-256 hash chain). **No CISO sign-off appears in any of the 42 comments.** Until CISO signs, retention is unbuilt policy; the audit store caps at 22,000 events and refuses appends with `AUDIT_STORE_FULL` (live segment 2,000 + 10 archive segments).
- **#4988 — OPEN.** [#945 Q10] Service-login E*TRADE authorization (option 1). Owner decision 2026-11-16: service login `svc-background` holds its own broker login/token. Same-day owner correction: broker-neutral solution, not E*TRADE-specific; correction slice queued after the Q10 stream.
- **#4994 — OPEN, OWNER NOT ESTABLISHED.** [IAAA] Subscription → roles, RBAC completeness, TBAC. No `## Agent` hashtag in the body, no labels. Do not attribute to CISO without a claim check. IAAA programme under #945.
- **#5160 — OPEN, CISO, Priority High.** [iaaa] Store all IDP-provided user attributes at sign-in. Today only (issuer, subject) is stored; `SessionState` carries no email/login/token; `identityBinding.ts` derives the internal id from the normalized (issuer, subject) pair only. The full IDP attribute set is not persisted.
- **#5348 — OPEN, CISO coordination.** Money/ledger permission for the IAAA PDP (enhancement of the 17-permission table). Build lands in a CBO slice under #5343; CISO owns the policy decision + review. `PERMISSIONS` (`src/security/authorization.ts:62`) has no money/ledger permission.
- **#5349 — OPEN, CISO coordination.** System-principal binding story (G-AUD-3) for workflow-internal actors. Build lands in a CBO slice under #5343; CISO owns the story decision + review. `service:<login>` principal exists (`src/security/serviceIdentity.ts:104`) but a platform-scope member binding carries no PDP permission, and `system:` actors exist only as provenance strings.
- **#5350 — OPEN, CISO coordination.** PDP + ExecutionContext wiring seams for route handlers and the MCP role→scope adapter. Builds land in CBO slices under #5343; CISO owns the seam decisions + reviews. `authorize()` is pure policy, called by no route.
- **#5349 / #5350 full-stack sub-issues (16, all OPEN, all `lane:ciso-bhdm`):** #5359–#5366 (system-principal) and #5367–#5374 (pdp-seams), one per area FS-1–FS-8. Verified individually: FS-1/FS-4/FS-5 are N/A (no UX / no endpoint / no MCP change) on the system-principal side; **FS-6 Data layer is explicit NO-OVERLAP — #5364 "Existing membership store reused; no schema change", #5372 "N/A — PIP attributes only; no schema change"**; FS-2 AOP compliance and FS-8 release are review-gated (CISO review gates the enhancement PRs); FS-3 services enhance existing identity/dispatch and PDP/context/permission modules, no new service; FS-7 reuses `agentIdForServiceLogin`, no new agent identity; FS-4 pdp-seams (#5370) is seam A consumed by route handlers, no endpoint created; FS-5 pdp-seams (#5371) is seam B, the IAAA role→scope adapter for MCP tools.

### AISecOps / security programmes
- **#767 — CLOSED** (completed 2026-10-21, PR #1109). `[AISecOps] Prompt-injection defense + red-team eval set`. The programme issue itself is closed; the programme continues under #764 and #3114. Memory's "leads AISecOps (#767)" now reads as the closed P1 slice, not an open programme issue.
- **#764 — OPEN.** [RSI-InfoSec plan] Recursive self-improvement of information-security capabilities + paired user offerings (AppSecOps, DataSecOps, AISecOps, MLSecOps, AgentSecOps, DevSecOps, identity). Parent plan; last updated 2026-10-26.
- **#3114 — OPEN, CISO programme.** Agentic security management: a governed security agent for IAAA administration (RSI loop). Sub-issues: #3748 (OPEN — MCP server scoping/security, **agent `#clo-arsi`**, not CISO-built, sits under the CISO programme) and #4819 (OPEN — Slice 1: MCP tools wrapping the SecHub REST routes, reads first).
- **#237 — OPEN.** [EPIC] Assessment.md hardening backlog — B+ to production-ready. P0 items verified done in the body (NLQ SQLi safe, webhook hardening, secrets clean, rate limiting). Remaining backlog not itemized here; no CDO overlap found at epic level.
- **#1069 — OPEN.** Multi-dimensional System (user's requirement: tenants, users, memberships, workspaces, roles, principals, services, providers, connections, accounts, environments, agents, models, workflows, plans, entitlements, usage, approvals). No lane label on the issue itself.
- **#1070 — OPEN, CAIO-owned (`lane:caio-quns`).** [epic] Multi-dimensional system (#1069) — security first, remaining dimensions as follow-up. Delivery tracker, not CISO-built.
- **#907 — OPEN.** REVIEW_REQUEST: CEO-aimp proposal. CISO is an addressee/reviewer (with CTO, must confirm the authoritative RiskPolicyEngine). No build overlap; no implementation until the owner approves.
- **#879 — CLOSED** (2026-10-23). AISecOps follow-up: retrieved content interpolated into the orchestrator SYSTEM prompt (#767 path 2).

### CISO data work — closed (confirm, do not assume)
- **#3929 — OPEN parent, all work done.** [Enhancement] Yahoo as the gap-filler for broker chains. 0 comments. Sub-issues #3930 (fundamentals join, closed 2026-11-10 via PR #3939), #3931 (persisted daily bars, closed 2026-11-10), #3932 (real sentiment, closed 2026-11-12) — all CLOSED, verified. The parent was never named in a merged PR's closing keyword, so the §17 reconciler never closed it. **Open-but-done; no active work; CDO has no claim (corrected 2026-11-10).**
- **#1555 — CLOSED** (2026-10-25). Corrective: Nasdaq curated fallback + Alpaca invented quote fields.
- **#1556 — CLOSED (merged PR).** Nasdaq listings fail explicit on live failure or empty result.
- **#3875 — OPEN, residual outstanding.** [Stock Copilot] Fix FEED_UNIVERSE_MISSING on NASDAQ100 pipeline refresh. PR #3878 merged (`d4228a4`, auto-hydrate). Comment 6764502721 (2026-11-10) records the failure recurring live on the other execution path (S1 runner in `src/services/feedJobs.ts`, `runFeedJob` ~:556) → incident **#3976 (CDO-authored, OPEN, High)**. #3875 closes when #3976's fix lands — CISO waits on CDO here.
- **#3077 / #3113 / #3102 — CLOSED.** #945 Q3 (bootstrap), Q5 (session values), Q4 (step-up windows). #3152 (Q11 spec refresh), #3154 (Q6 revocation-mid-run), #3156 (Q7 tamper runbook) — all CLOSED (CEO-aimp filed, CTO implemented, CISO requirements).
- **#4811 / #3851 / #5086 — CLOSED.** CISO survey docs copied into `docs/architecture/survey/`; CISO security & trust platform products §12.2; observability S7 coded messages + externalized config.

## 2. CISO code map (verified on tip 16d39b51)

| Area | Files (tip line numbers) | Owns |
|---|---|---|
| Index membership port | `src/trading/indexMembership.ts:196` (`IndexMembershipPort` interface), factories `:436`, `:696`, `:819`; consumers `src/services/indexListProducer.ts:22,35` | Fetching universe membership from Wikipedia / ETF holdings / listings behind one port. 19 universes in `IndexId`. |
| Index list stores | `src/data/doSqliteIndexListAdapter.ts:20-21` (`SqlIndexListStore`, DO `mas_index_lists`); `src/data/d1IndexListAdapter.ts:42` (`D1IndexListStore`, DML catalogue `dml.d1.mas_index_lists.*`); used in `src/agents/orchestrator/meshStockCopilotDoor.ts:502,807`, `scheduledTasksCopilot.ts:350`, `src/agents/routes/stockCopilot.ts:351,756`, `src/agents/scheduled-agent.ts:2491-2523` | Stored index lists; the refresh job is the only writer. Russell lists blocked on a holdings-fetcher binding that does not exist. |
| Fundamentals join (#3930) | Enrich jobs join the Yahoo fundamentals dataset (Yahoo-only join condition in `enrichJobs.ts` gone from main) | Broker enrich (Alpaca/E*TRADE/Public) + fundamentals. |
| Persisted daily bars (#3931) | Daily-bar history persisted so enrich computes RSI/MACD/ATR; UX reads persisted technicals | Technical datasets. |
| Sentiment runner (#3932) | `src/services/feedJobs.ts:1996` (`runFeedSentimentJob`), called from `src/services/feedPipelineJobs.ts:819`; shares `resolveUniverseListWithHydration` (`feedJobs.ts:900`) | Real sentiment dataset for enrich + UX. |
| Nasdaq listings fail-explicit (#1556) | `src/services/nasdaqListings.ts` (`fetchAllUsStockListings`), consumed by `meshOptionsStrategyDoor.ts:428`, `scheduled-agent.ts:2503`, `scheduledTasksPipeline.ts:260` | Throws on live failure / empty result; no curated-table substitution. |
| Auto-hydrate (#3875) | `src/services/feedPipelineJobs.ts` FEED_PULL_STEP guard + `resolveUniverseListWithHydration` (`feedJobs.ts:900`, used at `:1173`, `:1487`, `:1782`, `:2126`, `:2579`) | Missing stored universe list auto-bootstraps via refresh instead of `FEED_UNIVERSE_MISSING`. Residual: S1 runner path in `feedJobs.ts` (#3976). |
| Audit chain + Q7 | `src/security/iaaaAudit.ts:35` (`verifyChain`), `:98-100` (hash-chain event shape `previousEventHash`/`eventHash`), `:320` (`recordAuditEvent`); `src/data/inMemoryAuditPolicyAdapter.ts:95` (`appendChainEntry`, throws `audit chain sequence collision` at `:118`); `src/data/d1AuditPolicyAdapter.ts:225` (D1 implementation); port `src/data/auditPolicyPorts.ts:182`; gate `src/services/auditGate.ts:155` | Tamper-evident audit chain; the in-memory adapter is the #6112 race site. |
| Run-ledger projection (#4116 pattern) | `src/data/runLedgerPorts.ts:117` (`RunLedgerProjector` interface), `src/data/runLedgerProjection.ts:91` (factory), `src/services/runLedgerProjectionPosting.ts:70`, `src/services/runLedgerReads.ts` (`resolveLedgerReadMode`) | DO→D1 projection (queue `run-ledger.project`, direct ORM best-effort, reconcile sweep); merged-read mode is the current default. |
| Identity plane | `src/security/identityBinding.ts:138,154` (`deriveInternalUserId` from `issuer + "\0" + subject`; "No email, no login"); `src/security/serviceIdentity.ts:104` (`serviceUserInternalUserId` → `service:<login>`); `src/security/agentAccess.ts:222` (`agentIdForServiceLogin`); `src/agents/routes/serviceUser.ts` (grant/provision/revoke/status); `src/security/iaaaMembershipStore.ts` | User + service identity derivation, bindings, dispatch. |
| Sessions | `src/security/sessionStore.ts:153` (`SessionStore extends DurableObject`) — sessions, E*TRADE credentials, `iaaa-audit:` keys live here | Session storage (KV replacement, #329/#416). #6131 moves it to D1 unless proven impossible. |
| Audit/usage stores | `mas_events` referenced in `src/data/drizzleSchema.ts`, `eventLogPorts.ts`, `doSqliteOrmAdapters.ts`, `masRetentionIndexSchema.ts`; `usage_events` in `src/data/canonicalReportStorePorts.ts:199` (#584 EP-009) | Operational event log (DO-only) + metering companion. |

## 3. Duplication map — CDO item × CISO item

Classifications: DUPLICATE (same work twice — one must stand) · DEPENDENCY (CDO builds on / sequences behind CISO's code or decision) · ADJACENT (shared boundary, no overlap) · NONE.

### Verdict first: DUPLICATE — none found.
No CDO item rebuilds a CISO item. The nearest misses are sequencing dependencies (below), not duplicates. The one structural fact that prevents duplication is that **the user's directed build queue is itself CISO-authored** — #6113's slices must sequence behind or design against it, not re-implement it.

### DEPENDENCY — CDO sequences behind / builds on CISO
| CDO item | CISO item | Evidence |
|---|---|---|
| #6113 Q1 identity linking (ER model: tenants/users/sessions as master tables, FK links) | #5160 (IDP attributes), #6100 (attribution envelope), #5349 (system-principal binding), #6131 (sessions to D1) | Q1's users-table shape must match #5160 (what attributes persist at sign-in); the attribution envelope #6100 defines is the per-event tenant/user/session/action model Q1 must not re-invent; `service:` principals (#5349) are a principal kind the ER model must include; the session entity's store is #6131's decision. |
| #6113 S1/S2/S4/S5 (FK spines, join tables, derived counters) | #6101 (consolidation), #6099/#6102 (projectors) | The FK spine must be designed against the consolidated D1 tables #6101 produces and the projected tables #6099/#6102 create — not against the current fragmented family (4 DO tables + projections + usage tables). |
| #6113 S6 domain integrity | Q7 on #945 (retention) | S6 must take retention from Q7 once CISO signs; until then the 22,000-event cap is the rule and S6 must not invent a second retention rule. |
| #6113 Q3 no-duplication | #6101 / #6103 / #6099 / #6102 | These ARE the de-duplication builds for the run-ledger/event family. #6113's S4/S5 define the rules (single-write, derived projections, reconciliation) those builds execute against; it must not build a second projector or a second consolidation. Boundary: #5852 (CDO programme) owns the zero-exception one-store end state; #6101/#6103 are CISO's slices inside that direction. |
| #6113 Q4 ACID | #6112 (audit-chain race, building now) | #6112 is the concrete ACID fix for the audit chain (read-modify-write → serialized append). Q4's ACID policy (S0) cites #6112 as the instance; the fix itself is #6112's. |
| #6113 S0 policy | #6100, #6112, Q7 | S0's policy must cite #6100's envelope, #6112's serialization rule, and Q7's retention — all CISO-owned decisions. |
| #5386 one MCP server | #4819 (SecHub MCP tools) | New SecHub tools must land on the consolidated server, not a second one; #5386's design must accommodate them. |
| #3875 closure | #3976 (CDO incident) | Reversed direction: CISO's issue waits on CDO's fix for the S1-runner residual path. |

### ADJACENT — shared boundary, no overlap
| CDO item | CISO item | Boundary |
|---|---|---|
| #5386 one MCP server | #3748 (CLO-arsi, under #3114) MCP scoping/security review | Same surface (116 tools; `/mcp/scanner` second server). #3748 scopes/secures it; #5386 consolidates it. Consolidation must not pre-empt the scoping review; shared seam is the scanner server. |
| #5386 / #5387 (one MCP / one API) | #5350 PDP seams, #5348 money/ledger permission | The seams (#5370 route-handler seam, #5371 MCP role→scope adapter) and the ledger permission must be carried through the consolidated servers, not redefined by them. |
| #5427 DO-leg atomicity | #6112 audit-chain race | Mechanism vs instance: #5427 owns general DO-leg multi-write atomicity; #6112 fixes one race on the audit chain. Not a duplicate. |
| #6113 Q1 | #4988 service identity, #1069/#1070 dimensions | Service principals are a principal kind (broker-neutral per the 2026-11-16 correction); #1069/#1070 classify the identity/tenancy dimensions Q1's ER model must conform to. #1070 is CAIO-owned. |
| #5989 settings door | #6131 sessions to D1 | Shared seam: per-login state location. If sessions move to D1, the door's read path may change; the door itself stays CDO's. |
| #6113 (programme) | #764 RSI-InfoSec plan, #237 hardening backlog | Plan/epic level only. CDO's security-adjacent choices follow repo policy, not CISO code (except the #3667 index-port reuse). |
| #6113 S7 vocabularies | #6098 audit pages | #6098 states what each store holds in the UX; S7's status/state/kind vocabularies must use the same terms. |
| #6113 S8 EAV decision | #6131, #5160 | EAV settings stores vs the session store move and the user-attribute store — adjacent stores, separate decisions. |

### NONE
- **#4758** (seed-defaults externalization): no CISO item touches seed config.
- **#5989** vs #5349/#5350/#5348: the settings door reads per-login pipeline policy; no CISO item builds a settings door.
- **#5364 / #5372** (FS-6 data layer): explicit "no schema change" / "N/A" — no overlap with #6113's schema work by the CISO lane's own record.
- **#5359 / #5362 / #5363 / #5367** (FS-1/FS-4/FS-5): recorded N/A — no UX, no endpoint, no MCP change.
- **#907** (CEO proposal review): reviewer role only.
- **#3929** (open parent): work complete, no active overlap.
- **#767 / #879 / #1555 / #1556**: closed; no live overlap.
- **#4994**: ownership unestablished (no hashtag, no labels) — cannot be classified as CISO's; needs a claim check before any lane builds on it. Its subject (subscription→roles, RBAC completeness, TBAC) touches the #945 programme CDO's Q1-adjacent work must respect.

## 4. Sequencing consequences for CDO
1. **#6113 S0–S8 sequence behind the CISO queue where they share tables.** #6099 (building now) and #6102 create the D1 tables; #6101 consolidates the family; #6103 flips reads D1-only; #6131 moves sessions. S1/S2/S4/S5 designs that assume the current fragmented family will be written against tables that are about to move. S0 should record the queue as a dependency and design the FK spine against the consolidated shape.
2. **Q1's ER model needs four CISO decisions as inputs:** #5160 (user attributes), #6100 (attribution envelope), #5349 (system principals), #6131 (session store). None is CDO's to make.
3. **Q7 remains the open gate on retention.** S6 must not build retention until CISO signs; the 22,000-event cap stands.
4. **#3976 is CDO's debt to CISO:** #3875 cannot close until the S1-runner residual is fixed.
5. **#4994 needs a claim check** before anyone treats it as CISO's (or anyone's) scope.

## 5. Held comment text for #6113 (do NOT post — held per the 2026-11-22 user direction)
The #6113 comment + ADR draft are HELD; findings feed the design checks instead. When the user releases the hold, this is the text:

> ## CISO review — no duplicate work (verified 2026-11-22, main `16d39b51`)
>
> Reviewed the CISO lane's current issues and code against CDO's work. **No duplicate found.**
>
> - The directed build queue (#6112, #6099, #5164, #6098, #6100, #6102, #6103, #6101, #6131) is itself CISO-authored; #6112 and #6099 are building now. #6113's slices sequence behind it where they share tables: S1/S2/S4/S5 design against the consolidated D1 shape #6101 produces, not the current fragmented family.
> - Dependencies: Q1's ER model takes #5160 (user attributes), #6100 (attribution envelope), #5349 (system principals) and #6131 (session store) as inputs; S6 takes retention from Q7 (CISO's half still outstanding — 42 comments checked, no CISO sign-off); Q3's de-duplication is executed by #6101/#6103/#6099/#6102, not rebuilt by #6113; Q4's ACID policy cites #6112 as the audit-chain instance.
> - Adjacent only: #5386 vs #3748 (CLO MCP scoping review, shared seam `/mcp/scanner`) and vs #4819 (SecHub tools land on the consolidated server); #5427 (DO-leg atomicity mechanism) vs #6112 (one race instance).
> - Reversed dependency: #3875 (CISO) stays open on #3976 (CDO incident, S1-runner residual).
> - Explicit non-overlaps recorded by CISO: FS-6 data-layer slices #5364/#5372 — "no schema change".
> - Open question: #4994 (subscription→roles, RBAC, TBAC) carries no lane hashtag or label — ownership unestablished; claim check needed before any lane builds on it.
>
> Full inventory + code map: `~/workspace/wnorm/CISO-REVIEW.md` (main tip `16d39b51`). #CDO-mha7
