# Scan appendix (p) — docs/architecture/ mining — parent #1717

## Agent

#CISO-bhdm

Main doc: `docs/compliance/system-duplicates-scan-1717.md`. Parent issue: **#1717**
(system-wide duplicate/overlap unification program, successor to #1638).
This appendix is the follow-up the main doc promised: the mining report
(`~/workspace/tmp-issues/scan-docs-architecture.md`, read-only, no repo changes)
did not exist when the scan doc PR (#1719, merged `ba75988`) published, so the
main doc PR was not reopened for it. This appendix publishes that mining here,
with every finding mapped to the sub-issue it became — or to the reason it
became none (deferred / already-tracked / reference-only / no-slice).

Location note (owner-directed exception for this program's scan reports ONLY):
this report lives in `docs/compliance/`, not the usual
`docs/architecture/security/`. The file name carries the parent issue number.

## Scan provenance

- Repo: OpenAIMP/cfagent. HEAD scanned: `5a35582` — "docs(architecture): add
  Architecture Body of Knowledge (ABoK) & Target State Blueprint (#1716)
  #CTO-mbshr".
- Scope: every `.md` under `docs/architecture/` — **61 files** (security/ 21,
  security/assessment/ 1, business/ + business/assessment/ 5, enterprise/
  assessment/ 3, code/ 3, adr/ 3, top level 3, reference/ 2, blueprint/ 2,
  application/ 2, agentic/ 2, standards/ + standards/assessment/ 2, and 1 each
  under data/assessment/, infrastructure/, integration/, network/,
  privacy/assessment/, product/assessment/, plan/, technical/, strategy/,
  evolution/).
- Method: headings dump of all 61 files; keyword sweep for TODO / FIXME /
  "not implemented" / "partial" / "gap" / "limitation" / "follow-up" /
  "open decision" / "undecided" / "not settled" / "deliberately ungated" /
  "honest gap" / "deferred" / "not supported" / "no numeric target" /
  "observed property" / "residual" / "unverified"; targeted full reads of the
  security folder and the highest-signal docs. Claims in §A were checked
  against doc text AND code cited by the docs.
- Files whose headings + keyword sweep surfaced no explicit recorded finding:
  `blueprint/blueprint-01.md`, `blueprint/abok-target-blueprint.md` (gap section
  mined, rows F-54–F-56), `strategy/strategy-01.md`, `plan/plan-01.md`,
  `evolution/evolution-01.md`, `technical/cloudflare-01.md`,
  `reference/tabbed-browsing.md`, `adr/0001-derived-stable-identity.md` (see
  code/overall-01 concern row F-44 instead),
  `security/iaaa-admin-bootstrap-genesis.md` (incident follow-up mined, row
  F-14), `security/email-communications.md` (proposed preferences model mined,
  row F-15).

## (A) Verified IAAA claims (all six briefed claims VERIFIED; nothing failed)

| # | Claim | Verdict | Doc evidence | Code cross-check |
| --- | --- | --- | --- | --- |
| A1 | Legacy (pre-wiring) sessions stay PDP-exempt even when `IAAA_PDP_ENABLED` is set; exemption ends only at re-login | VERIFIED | authz.md §8: "Legacy (pre-wiring) sessions stay PDP-exempt even when `IAAA_PDP_ENABLED` is on: they carry no internal id, no tenant membership can be resolved for them, and denying them would lock out every session created before wiring. The exemption ends at re-login, when the session becomes wired." | `src/security/iaaaGithubEndToEnd.ts` `shouldEnforcePdp()`: "flag on AND a wired session. Flag OFF or a legacy session (no internalUserId) means the pre-change path, unchanged." Call sites in `src/server.ts` (E*TRADE start/verifier, OAuth start, `/auth/public/start`) all gate on it. |
| A2 | Revocation propagation has no numeric target — observed property only | VERIFIED | authz.md §9: "Measurable revocation propagation has no numeric target (observed property only: wired sessions re-validate on fresh reads, bounded by a 60-second isolate cache)." Repeated in substance in zero-trust.md §5.5, iaaa-github-end-to-end-defaults.md, iaaa-google-defaults.md. | authn.md §4: enforcement "touches activity (writes at most every 60 seconds)"; sessionPolicy.ts frames revocation as a store contract, with no numeric propagation constant found. |
| A3 | Obligations/advice are partial equivalents only: audit-on-decision is a record, not a condition; step-up is enforced ad hoc per gate; no obligation service, no advice channel | VERIFIED | authz.md §10 Obligations/Advice row: "Partial equivalents only. … There is no obligation service and no advice channel: the PDP returns allow/deny, and everything else is the caller's job." | `grep -rni "obligation\|advice" src/security/` returns no obligation/advice service implementation; audit store (`iaaaAuditStore.ts`) and per-gate step-up are the only counterparts. |
| A4 | The PDP is not the only gate | VERIFIED | authz.md §10 honest gaps: "The PDP is not the only gate. Legacy sessions are PDP-exempt (§8), deliberately ungated routes exist (§7), and the `/trade/approve` decision belongs to a downstream Durable Object gate." | §7 ungated list corroborated in api-security.md §2 and security-workflow.md §2/§5. |
| A5 | App-level TOTP / WebAuthn / magic links are Not implemented (no code paths exist) | VERIFIED | authn.md §7 table: "App-level TOTP / WebAuthn / magic links \| Not implemented (no code paths exist)". | `grep -rni "totp\|webauthn\|magic" src/` returns zero hits; `passkey` appears only in authn.md prose about IdP-transitive passkeys. |
| A6 | 2FA is inherited from the IdP, not implemented by the app | VERIFIED | authn.md §7: "Two-factor authentication (2FA) \| **Inherited from the IdP, not implemented by the app.** … The app never sees the second factor and cannot waive it." | Consistent with §1 provider registry (GitHub OAuth, Google OIDC only); no app-level second-factor check exists. |
| A7 | Ancillary, verified in passing: legacy sessions also idle-exempt; step-up/idle windows proposed, not settled; failed audit write does not block login | VERIFIED | authn.md §3: "Legacy sessions are exempt (they carry no activity timestamp)"; "The step-up window default is 15 minutes, which is a **proposed** value, not a settled CISO threshold"; authz.md §9: "today a failed audit write does **not** block login". | Step-up freshness constant `DEFAULT_STEP_UP_FRESHNESS_MS` in `src/security/sessionPolicy.ts` is cited by authz.md §10 as a caller-side fact, not a settled policy value. |

Scope note: production flag VALUES (`IAAA_WIRING_ENABLED`, `IAAA_PDP_ENABLED`,
`IAAA_BOOTSTRAP_ADMINS`) were not probed — the assurance review itself records
this as unverifiable from main. Flag existence and code behavior, not live
production values, are what is verified above.

## (B) Full mapping: doc → finding → sub-issue

Rows F-01–F-10 are the IAAA enforcement-gap set. Sub-issue numbers are the
amendment step's filings under #1717; every sub-issue is open, signed
#CISO-bhdm, labelled `lane:ciso-bhdm`, and carries the program standing rules
(NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run > session > user >
global env > built-in; the IAAA security guard; gitops for later slices).

| ID | Doc | Finding (one line) | Sub-issue |
| --- | --- | --- | --- |
| F-01 | security/authz.md §8 | Legacy sessions PDP-exempt until re-login; PDP not universal while any legacy session exists | #1749 (IAAA-1) |
| F-02 | security/authz.md §9 | No numeric revocation-propagation target; only an observed 60s-cache-bounded property | #1750 (IAAA-2) |
| F-03 | security/authz.md §10 | No obligation service, no advice channel; audit-on-decision is a record not a condition; step-up ad hoc per gate | #1751 (IAAA-3) |
| F-04 | security/authn.md §7 | App-level TOTP / WebAuthn / magic links not implemented; no code paths exist | #1752 (IAAA-4, product decision first) |
| F-05 | security/authn.md §7 | 2FA exists only transitively via the IdP; "supports 2FA" must say "via the IdP" | #1752 (IAAA-4, same domain as F-04; step-up ≠ 2FA clarification) |
| F-06 | security/authz.md §7 + §10 | Deliberately ungated surfaces: E*TRADE revoke, API-key deletion, `/trade/approve` (downstream DO gate), generic `/api/*` forwarder, schedule-goal mutations | #1754 (gate-coverage audit) |
| F-07 | security/authz.md §10 | Policy is TypeScript tables, not portable XACML; no policy store/editor; versioning is one string constant (`iaaa-authorization-1`) | #1755 (PDP architecture) |
| F-08 | security/authz.md §10 | PDP is an in-process library, not a service: no network boundary, endpoint, or independent deployment | #1755 (PDP architecture) |
| F-09 | security/authz.md §10 + §6 | No single gateway (several PEPs, one per surface); no attribute (PIP) service — PDP reads stores directly | #1755 (PDP architecture) |
| F-10 | security/authz.md §3 | Genesis marker is check-then-set, NOT transactional — a small documented race | #1756 (genesis race + marker hygiene) |
| F-11 | security/authz.md §9 | Step-up (15 min) and idle (30 min) windows are proposed defaults, not settled CISO values | #1757 (IAAA decisions) |
| F-12 | security/authz.md §9 | Audit retention, tamper response, and whether a failed audit write blocks wired login are undecided; today failed audit write does NOT block login | #1757 (IAAA decisions) |
| F-13 | security/iaaa-github-end-to-end-defaults.md | DO-naming cutover beyond aliases undecided (alias default; copy-cutover and dual-write remain documented options) | #1759 (login-keyed state cutover) |
| F-14 | security/iaaa-admin-bootstrap-genesis.md | Admin-grant route is a #945 completion item and the follow-up for later multi-admin needs; does not exist as a live path today | #1758 (lifecycle wiring) |
| F-15 | security/identity-lifecycle.md §2b/§2c, §5, §8 | Admin grants/approvals are module-only machinery (no route, panel action, or job calls them); panel read-only; no self-service deactivation route; deprovisioning half implemented but not wired | #1758 (lifecycle wiring) |
| F-16 | security/identity-lifecycle.md §4a, §6 | Bulk revocation cannot revoke sessions it cannot see (no session listing; caller must supply ids); offboarding misses E*TRADE tokens/API keys outside the three stores | #1758 (lifecycle wiring) |
| F-17 | security/identity-lifecycle.md §8 | User-initiated deactivation proposed path not implemented | #1758 (lifecycle wiring, same domain as F-15) |
| F-18 | security/zero-trust.md §5.3 | Audit store read-modify-write race (concurrent appends can lose events or fork the chain; verification detects, does not repair); store unbounded until a retention decision | #1760 (audit store) |
| F-19 | security/zero-trust.md §5.4 + §5.1 | Login-keyed token/DO state can orphan on rename; alias layer mitigates, cutover is open; legacy sessions also idle-exempt | #1759 (login-keyed state cutover, same domain as F-13) |
| F-20 | security/zero-trust.md §5.2 | Public surfaces exist by design, protected by "nothing sensitive here", not identity | #1754 (gate-coverage audit) |
| F-21 | security/iaaa-admin-ui.md | Panel v1 read-only (no grant/revoke/mutation endpoint); MembershipStore has no list-all API; audit store is a single tenant-mixed log read in full and filtered in memory (must not be used for per-request audit until a bounded backend exists); IAAA tab lists occurrences emitting no audit event; method/auth drift is a manual-review residual gap | #1758 (panel mutations, list-all) + #1760 (audit-event coverage, bounded backend) |
| F-22 | security/iaaa-945-assurance-review.md | DRAFT (NOT ADOPTED) assurance review: spec §2 assessment stale at main `975c3ed`; delegation `maxCost` not implemented; audit spec has no hash/tamper mechanism; revocation per-trigger table and numeric measure missing; CSRF/PKCE/nonce/JWKS/session-duration/rotation unspecified; genesis trust, linking/duplicate/email-change races, token validation, PDP enforcement surface, re-delegation/approval binding, tenant isolation, admin-UI-as-second-path, provider economics/exit all open; provider choice was presented not made (owner later decided APP-OWNED/FOSS/APP-OWNED — adoption refresh still owed) | #1757 (IAAA decisions; adoption refresh) |
| F-23 | security/iaaa-google-defaults.md | Google sessions render a `github:`-prefixed DID string in UI (display-only, factually wrong); follow-up is a provider-neutral login key + DID prefix; Google OAuth provisioning, enablement PR, production smoke test, settled thresholds, revocation target, audit decisions, §15/close decision all still owner-decided | #1759 (login-keyed state cutover) |
| F-24 | security/iaaa-provider-onboarding.md | Provider onboarding requires covering known limitations with follow-ups; failure modes listed are fail-closed by design, not gaps — recorded as the onboarding completeness obligation | #1759 (onboarding completeness; process, not a code gap) |
| F-25 | security/mcp-security.md §4 | A2A POST per-agent authentication delegates to a DO stub and is NOT verified from the entrypoint | #1763 (MCP/A2A); also referenced by open #1024 |
| F-26 | security/mcp-security.md §3, §5 | `/mcp/scanner` intentionally unauthenticated — x402 payment is the gate; any tool whose calls cannot be attributed to a session/key is a gap, not an acceptable default | #1763 (MCP/A2A) |
| F-27 | security/model-prompt-registry.md | Six prompt assemblies registered but NOT wired into the gate (optionsIdeas, optionsComparison, comparisonKernel, nlqPlanning, nlqValidation, judge); chains folding into the registry is follow-up | #1763 (MCP/A2A / prompt-gate wiring) |
| F-28 | security/api-security.md §2 | `/openapi.json` + `/api/docs` gating is a provisional spike; final `DOCS_PUBLIC_SURFACES` decision still open (#1024); WebSocket routes do not map cleanly onto framework middleware | #1768 (API/MCP consolidation); #1024 referenced, not duplicated |
| F-29 | security/security-workflow.md §2.5, §4, §5 | `default_trader` static-pair fallback means "revoked" does not yet mean "gone" until #1066 lands; a secret that can only die by redeploy is named as a gap; failed-audit-write-on-login proceeds (open CISO decision) | #1764 (workflow/service-id) for the queue/identity parts; #1066 REFERENCED (open), not re-filed; failed-audit-write decision in #1757 |
| F-30 | security/design.md §4 | Standing open-item list constraining all security docs: #945 open list, #1066, #1024 (DOCS_PUBLIC_SURFACES, A2A POST unverified, adapter dispatch-order/MCP fallback preservation), #907 kill switch as measurable objective + RiskPolicyEngine boundary (proposal, not adopted) | #1757 (IAAA decisions tracker); #945/#1066/#1024/#907 all REFERENCED (open), not re-filed |
| F-31 | security/etrade.md §6, §7 | E*TRADE token keys still keyed by login string, not internal id; renamed login can orphan the stored token (alias dual-read mitigates); `default_trader` process-wide static pair served on cache-null, no-stored-token, and post-expiry | #1759 (login-keyed token cutover); #1066 static-pair part REFERENCED, not re-filed |
| F-32 | security/workflow-security.md §4 | Poison message that always fails is retried, not dropped — queue retention and dead-letter behavior is an open gap; background/user identity indistinguishable by header alone until service-identity migration completes | #1764 (workflow/service-id) |
| F-33 | operations/runbook/service-identity.md | If `SERVICE_USER_LOGIN` is unset, scheduled/queue/payments/email/wallet/trading unattended surfaces skip, refuse+retry, or throw — fail-closed by design, but the config is an owner provisioning step, not code-complete coverage | #1764 (workflow/service-id) |
| F-34 | security/emergency-authority-register.md | Register is DRAFT, not in force: all 13 owner decisions D1–D13 PENDING (adoption; Part A triggers/scopes/reversals; durations; whether any Part B entry may EVER be pre-authorized; Part B durations + EA-11 auto-resume vs fail-closed; EA-14 recommendation-only; notification channel/delay; EA-02 binding policy; evidence-retention location/period; review cadence + lapse rule; alternate human owner; CISO-lane-only scope boundary; Part B rotation procedure/enforcement/notification tool) | #1757 (IAAA decisions; owner actions, recorded not made) |
| F-35 | security/secrets-inventory-and-rotation-policy.md | Slack bot token still lacks `files:write` scope (owner action: scope + app reinstall); pre-#1486 Alpaca key values remain in git history (history purge is a separate owner decision, not done/not claimed); `.gitleaks.toml` allowlist is path-scoped but not rule-scoped (tightening is follow-up); most rows' "Last rotated: Unknown" baseline awaits the first quarterly review | #1762 (secrets follow-ups) |
| F-36 | security/assessment/assessment-01.md SEC-005/SEC-006/SEC-007 (PARTIAL FIT) | Indirect prompt-injection defense partial (LLM Judge only — needs input sanitization on webhook/Slack text); multi-tenant isolation partial (app-level WHERE clause — omission leaks); webhook SSRF partial (format validation only — no static IP allowlist / private-range block) | #1763 (SEC-005) + #1761 (SEC-006) + #1768 (SEC-007, webhook middleware) |
| F-37 | data/assessment/assessment-01.md DATA-002/DATA-003/DATA-005/DATA-008 (PARTIAL FIT) | Manual DDL-tag migrations risk schema drift (no automated migration framework); tenancy via app WHERE clauses (same leak class as SEC-006); no centralized metadata catalog/lineage; retention pass covers only `mas_messages` >30d — `screener_runs`/`research_runs` grow unbounded | #1767 (DATA-002) + #1761 (DATA-003) + #1766 (DATA-008); DATA-005 metadata catalog/lineage carried inside #1766/#1767 scope notes — no separate slice filed (see §C) |
| F-38 | infrastructure/assessment-01.md INF-005/INF-006 (PARTIAL FIT) | No automated DO SQLite snapshot export to R2 (accidental-delete recovery is manual); SQLite DDL via raw string queries in `block_concurrency_while` (no ORM-managed migration tooling) | #1766 (INF-005) + #1767 (INF-006) |
| F-39 | integration/assessment-01.md INT-005/INT-006 (PARTIAL FIT) | No JSON-Schema validation on public REST/webhook ingress (manual property parsing); no automated PROD session preflight for background workers — scheduled options research fails when the E*TRADE session expires | #1768 (API/MCP consolidation); #1200 (preflight predecessor) is CLOSED — verify live preflight state before building that part |
| F-40 | network/assessment-01.md NET-006 (PARTIAL FIT) | No IP connection burst caps on `/ws` upgrade path (app + edge rate limiting exist, but not per-IP burst caps for WebSocket) | #1768 (API/MCP consolidation) |
| F-41 | privacy/assessment/assessment-01.md P1.1/P4.1/P5.1 + PRV-001–PRV-004/PRV-006 (PARTIAL FIT) | DSAR erasure has no automated cascade (session deletion only; OrchestratorAgent/ResearchAgent/Vectorize residuals remain); no user-facing data-export endpoint; no ADMT pre-use notice/opt-out; `Sec-GPC` header not parsed/enforced; retention pass covers only `mas_messages`, not `screener_runs`/`research_runs`/all 8 DO classes | #1765 (privacy/DSAR) + #1766 (universal retention part) |
| F-42 | standards/assessment/assessment-01.md P2 minor | Client-to-edge mTLS not implemented (relies on Cloudflare edge TLS termination) | #1768 (API/MCP consolidation; P2/minor, must not block the rest) |
| F-43 | business/assessment/assessment-01.md GAP-01, CAP-GOV-03, PROC rows | RSI feedback loop documented but experiment tracking partially manual (needs automated RSI trial ledger DO + telemetry); RSI governance capability only partially defined; several process rows carry Unverified verification levels (PROC-02/03/05/06) | #1774 (enterprise compliance) |
| F-44 | code/overall-01.md §3.4 | E*TRADE OAuth token-cache invalidation races → mid-flight AUTH_003 failures; direct endpoint invocations in `server.ts` missing `iaaaGates.ts` middleware wrapping (PDP bypasses); derived-identity collision/mapping-bug risk (adr/0001) | #1754 (PDP-bypass audit — assessment concern, NOT a verified live bypass; audit work, not a confirmed vulnerability); token-cache race + identity-collision risk carried inside #1754's audit scope |
| F-45 | code/component-taxonomy-01.md §7 | Four orchestrations partially built but unenabled/disconnected (autonomous portfolio rebalancing; cross-agent P2P x402 micro-payments with mocked Sepolia settlement; multi-leg spread repair engine; cross-venue E*TRADE-vs-Alpaca arbitrage); plan generation uses fixed prompt templates; reflection logs do not mutate agent code/prompts without developer intervention | #1771 (unenabled orchestrations) |
| F-46 | code/screener-01.md §8 | Three more unenabled/partial orchestrations: closed-loop screener-to-trade execution (blocked by manual approval gate); multi-agent swarm cross-screener consensus (needs swarm routing harness); continuous volatility/dark-pool arbitrage monitor (partial in `flowService.ts`, lacks streaming loop) | #1771 (unenabled orchestrations, same domain as F-45) |
| F-47 | application/screener.md | Partial parity: stocks via listing aggregators vs options requiring per-symbol live broker chain fetching; subrequest budget bounding + qualified partial results recommended, not yet enforced per run; missing: Seeking Alpha factor grades, AlphaSense transcript sentiment, dark-pool/institutional flow, IV percentile/rank + IV surface storage | #1770 (screener pipeline) |
| F-48 | application/api-mcp.md §Architectural Issues, Gaps & Non-Compliance 1–4 | Monolithic `handleFetch` (>1,000 lines if-else routing); OpenAPI spec drift (static builder, no runtime-route validation); MCP tools/list/call hardcode capabilities, no dynamic Zod validation, some MCP errors return HTTP 200 with error-in-result instead of JSON-RPC codes; mixed singular/plural routes + duplicated aliases; webhook signature header/mechanism inconsistency; caller-supplied `x-user-login`/`x-user-id` accepted when session auth fails/unconfigured (spoofing risk if edge middleware doesn't strip); ad-hoc throttling, not uniform middleware; quote handlers duplicate E*TRADE/Yahoo/Alpaca logic; webhook verification not unified; MCP commands duplicate REST logic | #1768 (API/MCP consolidation) for the router/validation/webhook/throttling/quote-handler remainder. The MarketDataService facade and REST→McpToolCommand items OVERLAP CLOSED #1643/#1644 — REFERENCED, not re-filed. |
| F-49 | business/current-state-rules.md + business/fit-gap-with-amuse.md | 7 partially implemented + 7 not implemented trading rules, in both docs (Bollinger Bands, Anchored VWAP, fractal pivots & Fibonacci, 6-vote composite bias score, 15-min intraday ORB breakouts not implemented; MA structure, HH/HL regime, friction/breach gates, 30-day premium yield, pre-market momentum, HV, 25-delta skew/decision matrix, portfolio sizing/heat caps, account heat cap UI-only partially implemented) | #1769 (screener/trading rules). NOTE: fractal pivots (#1654 slice 4/8) and HH/HL (#1654 slice 5/8) shipped after the scan's read — verify live state first; those rows close as done with evidence if shipped. |
| F-50 | business/system-overview.md §2.3, §9, §10 + #1151/#1173/#1200/#1204/#1209/#1236 | Discovery convergence undecided (UX discovery vs #1096 discovery are two backends answering overlapping questions — which engine survives + composition/reverse-discovery folding belongs to #1151 slices C2/C4, NOT decided); options-side fan-out never bounded (stock side fixed #495/#497/#806); #1200 no-stored-session preflight gap building; final-mile report/email gap (completed runs, no downloadable report/email, delivery hold with no "waiting" signal); email + report download impaired via #1209 delivery hold/pipeline gaps; pipeline stages fused in `runReportPipeline` (generate→store) — stages cannot be scheduled/retried/inspected separately (tracked #1236 under #1151) | #1770 (screener pipeline) for fan-out/final-mile/budget parts ONLY. Discovery convergence → open #1151 REFERENCED. Delivery impairment → open #1209 REFERENCED. Stage scheduling → CLOSED #1236 REFERENCED (verify landed state, do not rebuild). #1200 is CLOSED. |
| F-51 | agentic/social-delivery-and-scheduled-pipelines.md §3.2, §4 | Goal-to-goal chaining NOT supported today (no `runAfter`/`dependsOn` on goals; sequencing is wall-clock or manual `triggerGoal`); enabled design is pipeline goals (#1224, TDD-first, gates byte-identical); social feed digest source (screener digest → brief wiring) is an open feed decision; tasks/memory agents not used by the social pipeline today | #1771 (unenabled orchestrations) for chaining + feed wiring. Pipeline goals themselves → CLOSED #1224 REFERENCED, not re-filed. |
| F-52 | UX/assessment-01.md §3 | WCAG 2.2 AA non-compliance: target size <24px (ScannerPanel/MemoryBrowser icons); status messages without `aria-live`/`role=status` (AsyncJobsPanel polling); modals without focus trap/restore (PartnerDealsModal); HAX scope disclosure partial (no Delegation Contract preview); uncertainty single-number confidence without method breakdown; OWASP ASI-02 trades without execution-payload/fees/slippage preview; ASI-03 markdown rendering with unsafe-link/HTML-injection risk (partial) | #1773 (UX accessibility) |
| F-53 | UX/exceptions-01.md | 44 exception files bypassing UX primitives: 28 zero-primitive + 16 partial (leftover raw `<button>`/`<input>`/`<table>` etc.); remediation phased 1–4 ending in a CI enforcement pin flagging raw controls outside `src/client/components/ui/` | #1772 (UX primitives) |
| F-54 | blueprint/abok-target-blueprint.md | In-memory `ScreenerEventBus` cannot guarantee delivery across Worker instances or restarts; agents are TS classes, not autonomous state machines/actor DOs with long-term memory; prompts/tools statically compiled — no dynamic tool discovery or self-reflection primitives (blocks true RSI); scorecard gaps: no retriable event queues/circuit breakers, heavy synchronous screening loops hitting Worker limits, basic console logging (needs Analytics Engine + OpenTelemetry), underused Workflows/Queues/AI Gateway/AI Search, no fine-grained agent sandboxing, no code-modification/prompt self-tuning/automated eval loops (RSI readiness 2/9) | #1770 (event bus, observability) + #1771 (agent state machines, RSI loops, queues/circuit breakers) |
| F-55 | enterprise/assessment/comprehensive-enterprise-strategy-and-capabilities-assessment.md | Public REST API rate-limiting missing; bi-directional interactive delivery (Slack action buttons) not yet wired; SOC 2 Type II only partial (edge controls) — needs formalized access logs, zero-trust policies, vendor risk docs | #1774 (enterprise compliance) |
| F-56 | product/assessment/assessment-01.md | Commercial billing & ledger only 15% complete (85% remaining) per `src/payments/ledger.ts` assessment; §24 open decisions/approvals outstanding (see doc for the list — not enumerated here to avoid inventing line items) | #1774 (enterprise compliance) |
| F-57 | iros.md | Unverified: whether stored presets named breakout/momentum/reversal exist | #1770 (screener pipeline; VERIFY before filing build work — trivial verification item) |
| F-58 | adr/0002-data-foundation-layer.md | Postgres adapter slice deferred by owner 2026-10-26 ("for now do R1/sqlite") — program proceeds SQLite-only; reconciliation can only converge what it can see (inline outcomes never projected at completion cannot be recovered; rails list clamped to 100 rows); audit is a projection-event trail, not a second source of truth (unreconciled projection failure leaves a gap); MCP reads share projection R5 lag; retention enforcement covers only `agent_shard_jobs` (30d + 500-row cap) — all other projection tables KEEP; no orphan sweep scheduled/implemented; purge reports are not themselves audit events; per-tenant cap counts rows not jobs; production seed invokes (halt seed, canonical `mas_reports` seed) are operator steps — #1546 stays open until they land; `chain.run` execution binding explicitly out of scope (legs still report unimplemented) | #1766 (data retention: orphan sweep, purge-run audit, KEEP-table rules). Postgres adapter: DEFERRED by owner — recorded here, NOT filed as active work, NOT built without owner re-authorization. Production seed invokes → open #1546 REFERENCED. `chain.run` binding: out of scope per ADR 0002, no slice. |
| F-59 | security/iaaa-admin-bootstrap-genesis.md | Genesis repair serialization: #1208 first, #1210 rebased after — if repair landed first, the genesis marker would stay `grantedTo` the retired id (inert because the already-admin check short-circuits, but stale) | #1756 (genesis race + marker hygiene). #1208 and #1210 are both CLOSED — verify live state; if the repair landed in the #1208-first order, this portion closes as already-resolved with evidence. |
| F-60 | reference/cfpay.md | cfagent A2A gaps vs cfpay: no NL/text fallback path (acceptable for a structured competency, per the doc); error shape SHOULD-FIX — free-text `error: err.message` instead of stable tokens + existing `AGENT_ERROR_CATALOG`; consumers judge failures by token/code, not prose | #1763 (MCP/A2A: stable error tokens). NL/text fallback: acceptable per the doc — no slice. |
| F-61 | cicd-selective-testing-strategy.md | Subset-test execution on feature branches risks missing indirect failures (global state, shared schemas, unimported side effects, distant contracts) — the doc's multi-tier safety net is the mitigation, stated as a risk to be managed rather than a closed control | #1768 (API/MCP consolidation; process control — verify current adoption before filing build work for it) |
| F-62 | business/system-overview.md §4 | Two unifications never merged into each other: #958 unified legacy surfaces, #1096 unified provider/data layer — #1151 exists to merge them (same convergence as F-50, recorded here as the duplicate/overlap-program's core instance) | Open #1151 REFERENCED (the merge vehicle). NO new sub-issue filed — filing one would duplicate #1151. |
| F-63 | enterprise/assessment/screener.md + enterprise/assessment/platform-decoupling-and-native-roadmap.md | Email dispatch safely skipped (with warning) when `RESEND_API_KEY`/SMTP config missing — a silent-delivery-failure class worth a named check, not a stated gap; platform-decoupling roadmap contains no explicit gap rows surfaced by the keyword sweep (target-state narrative) | #1770 (screener pipeline: delivery-config failure visibility). Roadmap narrative: no gap rows, no slice. |

## (C) Roll-up domains → sub-issues (the 18 mining domains)

1. IAAA-ENFORCEMENT → #1749, #1750, #1751, #1752, #1754, #1755, #1756.
2. IAAA-DECISIONS → #1757.
3. IAAA-LIFECYCLE → #1758, #1759.
4. AUDIT-STORE → #1760.
5. TENANCY-ISOLATION → #1761.
6. SECRETS → #1762.
7. MCP-A2A → #1763.
8. WORKFLOW-SERVICE-ID → #1764.
9. PRIVACY-DSAR → #1765.
10. DATA-RETENTION → #1766.
11. SCHEMA-MIGRATION → #1767.
12. API-MCP-CONSOLIDATION → #1768.
13. SCREENER-TRADING-RULES → #1769.
14. SCREENER-PIPELINE → #1770.
15. ORCHESTRATION-UNENABLED → #1771.
16. UX-PRIMITIVES / UX-A11Y → #1772 / #1773.
17. ENTERPRISE-COMPLIANCE → #1774.
18. DUPLICATE-OVERLAP (program core) → open #1151 (reference only, no new filing).

Sub-rows folded without a separate slice (recorded, not lost): F-37 DATA-005
(metadata catalog/lineage) is carried inside #1766/#1767 scope notes; F-44's
token-cache race and derived-identity collision risk are carried inside #1754's
audit scope; F-60's NL/text fallback is acceptable per its own doc (no slice);
F-63's platform-decoupling roadmap has no gap rows (no slice).

## (D) Not filed as new work — with reasons (do not re-file without new evidence)

- **Owner-deferred:** F-58 Postgres adapter (owner 2026-10-26: "for now do
  R1/sqlite"). Recorded as DEFERRED, not active work.
- **Already tracked, open — referenced, not duplicated:** #945 (IAAA epic),
  #1024 (framework-adapter design + `DOCS_PUBLIC_SURFACES` + A2A POST
  verification), #1066 (E*TRADE per-user token flow; `default_trader` static
  exception removal), #1151 (holistic screening consolidation), #1209
  (delivery truth), #1546 (D1 AgentDB cross-agent query layer; production seed
  invokes), #907 (kill-switch measurable objective, proposal not adopted).
- **Already tracked, closed — referenced, verify landed state before building:**
  #1200 (PROD preflight), #1224 (pipeline goals), #1236 (stage scheduling),
  #1208/#1210 (genesis repair order), #1643 (MarketDataService facade),
  #1644 (REST→McpToolCommand).
- **No-slice items (documented, not built):** F-57 preset existence (verify
  first); F-61 selective-testing safety net (process control, verify adoption
  first); F-24 onboarding completeness is process, carried in #1759, not a code
  gap on its own; F-60 NL/text fallback (acceptable per its doc).
- **Stood-down items:** NONE. Pre-filing checks (2026-10-26) found no live
  claim branch and no open PR for any IAAA, docs-mining, or adapter slice in
  this appendix. The `feat/945-*` branches (`feat/945-authorization-pdp`,
  `feat/945-iaaa-admin-ui[-v2/-v3]`, `feat/945-iaaa-audit`, `docs/945-iaaa-spec`)
  are 2026-10-21/22 merged-era leftovers with no open PR — stale, not live
  CTO-lane work on these slices. The live `fix/1721-categories-referrals-ads`
  claim branch (the running Phase C slice (a) builder) was NOT touched. Had
  any slice been in flight, it would have stood down per branch-as-lock and
  been reported here instead of filed.

## (E) Caveats

- **Do not re-file already-tracked items blindly.** Several rows cite live
  issue numbers — this appendix records what the DOCS say, and each sub-issue
  states which cited items are references rather than its own work.
- **Assessment docs are assessments, not verified code findings.** PARTIAL FIT
  rows (F-36–F-42) and code/overall-01 concerns (F-44) are the assessors'
  judgments; code verification was done only for §A. Each affected sub-issue
  requires verifying its rows against current main before building.
- **Owner-deferred items are not active work.** Filing the Postgres adapter as
  active work would contradict the owner's 2026-10-26 direction.
- **No live production state was probed.** Flag values, second-user E*TRADE
  linking, and production PDP enablement are unverified by design.
- **No branches, issues, PRs, pushes, deletions, or edits to the repo were made
  by the mining scan itself.** The mining clone was read-only scratch.
