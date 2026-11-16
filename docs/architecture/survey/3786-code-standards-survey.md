# Standards survey — input to the code-standards doc set under `docs/architecture/code/`

- **Base:** `origin/main` = `9925ead846c163e4fd2f91a8e035230e6f2481cb` (Qunsultant/cfagent).
- **Method:** read-only survey of a detached worktree at that SHA. Every rule below was read in its source document, ADR, script, or pin header at that base; counts quoted as "today" are fresh greps over `src/` at that base. No GitHub writes; nothing in the repo was modified.
- **Purpose:** the user directed that a resolver standard be created under `docs/architecture/code/`, and that the *other* standards code must follow be documented there as well. Issue #3786 (resolver consistency census + standard) already exists; its standard deliverable is pulled forward into this doc set. This survey is the harvest: what the rules are, where each one canonically lives today, and whether anything enforces it.
- **Status legend:** **ENFORCED** = a named pin / CI check / script fails when the rule is broken. **DOCUMENTED-ONLY** = stated in a repo document, no machine enforcement. **PRACTISED-UNDOCUMENTED** = the practice exists and is relied on, but no repo document states it. **GAP** = an implied standard with no home at all today.

## Proposed file map for `docs/architecture/code/` (standards set)

The existing four files in that directory (`overall-01`, `component-taxonomy-01`, `screener-01`, `aop-fit-gap-analysis`) are Oct-2026 *assessments* — descriptive audits, not standards — and stay as they are. The standards set is new files beside them:

| File | Purpose (one line) |
|---|---|
| `README.md` | Index of the standards set: the file list, the status legend, and the enforcement map (which pin/CI check stands behind which file). Also states the set's own rule: it states operational rules and *points* to canonical sources — it is not a new rule home (see Conflicts #1). |
| `01-architecture-boundaries.md` | Port-first architecture, storage topology, the #290 trading barrel, thin routers, single-source schema, reuse/one-implementation rules. |
| `02-data-access.md` | ADR 0022 operationalized: no naked SQL above the layer, the dialect ruling, transactions at the port boundary, migration rules incl. latest-ownership. |
| `03-errors-logging-config.md` | The single outcome catalog + resolver, business-vs-technical messages, structured logging (console ratchet), externalized configuration, feature-flag port. |
| `04-resolvers-and-context.md` | **The new resolver standard** (the four rules in Gaps §1) plus the context/identity resolution rules it sits beside (tenant from session, ExecutionContext discipline, derived identity). |
| `05-security-and-tenancy.md` | Server-side authorization + PDP seam, tenant isolation + negative tests, agent-authority intersection, secrets discipline, MCP tool scopes, HITL/step caps. |
| `06-client-ux-code.md` | UI primitives + design tokens only, PageShell, density, accessibility target — the code-facing subset of the UX rules. |
| `07-testing-and-pins.md` | TDD discipline, the five pin rules, the pre-merge battery, and the pin inventory (the machine-enforced list, §Pins below). |
| `08-deprecation-changelog-docs.md` | No deletions / retire-by-rename + ledger, deprecation-successor phrase, changelog/fragment, zero-touch docs merges, decisions-recorded-in-repo (§23), ADR immutability. |

9 files total (index + 8). Rules are grouped by the boundary a builder is crossing, not by which programme produced them.

---

## Rules by area

### A. Architecture boundaries & port-first

| # | Rule | Source | Status |
|---|---|---|---|
| A1 | Domain code depends only on port interfaces: no store-client imports, no `env.AGENT_DB` references, no SQL in domain code; the composition root wires env → adapter → ports | ADR 0002, Decision R1 ("non-negotiable"); ADR 0022 D-D | **ENFORCED** — structural tests per ADR 0002; SQL half by `tests/global_dd_census_2356.test.ts` |
| A2 | Every cross-cutting capability is port-first with ≥2 adapters (production + in-memory) and one conformance suite run unchanged against both | ADR pattern across 0003 (messaging), 0005 (actors), 0006 (flags), 0007 (retrieval), 0008 (breakers), 0010 (LLM gateway), 0011 (observability), 0012 (MCP permissions) | DOCUMENTED-ONLY — conformance suites exist per port, but no meta-pin enforces "a new port ships two adapters + a suite" |
| A3 | Storage topology: Durable Objects = authoritative per-actor store + agent runtime; D1 = queryable projection/relational layer, never the per-actor store; R2 = blobs only, never coordination, queries, or transactions | ADR 0020, Decision items 1–5 | DOCUMENTED-ONLY |
| A4 | Trading internals are reachable only through the `src/trading/index.ts` barrel (#290 boundary); no deep imports into `src/trading/**` from outside | Repo AGENTS.md / gitops §7 "No drift" item 3; reaffirmed in `docs/architecture/standards/options-gof-grasp-solid-3186.md` (GRASP/Low Coupling) | **ENFORCED** — `tests/trading-boundary.test.ts` |
| A5 | Routes stay thin: the orchestrator's `routeRequest` is an ordered dispatcher delegating to `src/agents/routes/*.ts`; no inline path-matched handler blocks, no business logic in route handlers; server entry dispatch likewise inventoried | `docs/compliance/anti-drift.md` §2 (Edge row); gitops §7 "No drift" item 3 | **ENFORCED** — `tests/thin_router_inventory.test.ts` (24 delegation calls, exact order) + `tests/server_route_inventory_2902.test.ts` (every route branch, dispatch order, auth guards) |
| A6 | Shared schema/DDL has exactly one source file; every initialization path consumes it (no dual-DDL copies) | Issue #782 pins; `src/data/ormSchema.ts` is the single source | **ENFORCED** — `tests/schema_single_source.test.ts` |
| A7 | Reuse before you build: choose in the order reuse → enhance → optimize → consolidate → extend; a parallel implementation needs explicit justification in the PR + completion report; consolidate duplicates on contact, or file the follow-up in the same PR | gitops §7, "Reuse before you build" items 1–6 | DOCUMENTED-ONLY — reviewer-enforced ("sent back, not merged"); no machine gate |
| A8 | Before building, consult the multiple-implementations catalog; do not add another parallel engine/ranker/weight system/promotion pipeline/report generator | gitops §7 "No drift" item 4; `docs/compliance/multiple-implementations.md` (the catalog) | DOCUMENTED-ONLY |
| A9 | One stage-runner contract for every screen invocation mode: one plan + checkpoint; sync/async/workflow drivers differ, decisions never do; fan-out caps are named, not silently truncated | ADR 0027, Decision items 1–2 | DOCUMENTED-ONLY — and the ADR's own status is **Proposed**, not Accepted |
| A10 | Messaging crosses ports as CloudEvents v1.0 envelopes (specversion/id/source/type/time/data + named lowercase extensions); no Queue binding types, provider options, or provider error shapes in port interfaces | ADR 0003, Decision M1 | DOCUMENTED-ONLY |

### B. Data access (ADR 0022 operationalized)

| # | Rule | Source | Status |
|---|---|---|---|
| B1 | No naked SQL above the data layer: SQL lives behind ports in named templates; the remaining above-layer sites are an exact allow-list that only shrinks; per-table writer sets are pinned for ported tables | ADR 0022 D-D ("No naked SQL above the layer, enforced by a shrink-only pin") | **ENFORCED** — `tests/global_dd_census_2356.test.ts` (3 surfaces + writer sets, shrink-only) plus the per-family step censuses (`orm_step3a_census_2345`, `strategy_cluster_step4b_census_2357`, `async_jobs_step4a_census_2358`, `orchestrator_tables_step4d_census_2359`) |
| B2 | Dialect ruling: typed Drizzle behind ports where a dialect exists (D1, Postgres); raw SQL behind ports for DO SQLite | ADR 0022 D-B | DOCUMENTED-ONLY — the census counts SQL sites but does not distinguish dialect misuse |
| B3 | Transactions are an AOP aspect at the port boundary: multi-write operations are atomic or honestly failed, never silently partial; D1 via `batch()`, never `db.transaction()` | ADR 0022 D-C | DOCUMENTED-ONLY |
| B4 | The migration registry's "latest" is owned by exactly one test (`tests/migration_registry.test.ts`); per-feature migration tests assert only their own registration (position-independent) and their own DDL/schema parity | gitops §7, pin rule 5 (#3189) | **ENFORCED** — `scripts/check-migration-pins.sh`, run in `scripts/verify-before-merge.sh` and the CI Fast gates step |
| B5 | A per-port conformance suite runs unchanged against every adapter family for that port | ADR 0002 / ADR 0022 (port-first programme) | DOCUMENTED-ONLY — suites exist per family; nothing meta-enforces coverage of a newly added adapter |

### C. Errors, messages, logging, configuration

| # | Rule | Source | Status |
|---|---|---|---|
| C1 | One outcome catalog (`src/outcomes/outcomeCatalog.json`) and one resolver module (`src/outcomes/outcomeAspects.ts`): user-facing error/success codes and messages are externalized there, never redefined or copied elsewhere | Issue #2381 (module header: "the single outcome catalog + the single resolver… there is no second resolver anywhere") | **ENFORCED** — `tests/error_catalog_r4.test.ts` + `tests/outcome_catalog_2381.test.ts` pin catalog shape and the existence of every referenced code |
| C2 | User-facing messages carry business errors, not technical errors; technical detail stays in logs | gitops §5 "Standing guardrails"; `outcomeAspects.ts` header ("Business messages go to UI and channels. Technical details go to logs only.") | DOCUMENTED-ONLY — see AOP verification §2: raw throws are uncounted by any pin |
| C3 | The outcome resolver never invents a code: unknown codes pass through unresolved; a read never fails (the resolver never throws) | `outcomeAspects.ts` header, read-time rules (#2381) | **ENFORCED** — pinned by `tests/error_catalog_r4.test.ts` (the codedMessage rendering contract) |
| C4 | Logging is structured, via the structured logger (`src/observability/structuredLogger.ts`); no NEW unstructured `console.*` in `src/` — remaining sites are per-file ceilings that only shrink, and a file that reaches zero is locked at zero | Issue #3515 (console ratchet programme) | **ENFORCED** — `tests/console_migration_ratchet_3515.test.ts` (shrink-only; 234 counted sites remaining at its batch-3 baseline; the logger is imported by 146 files today) |
| C5 | Secrets and sensitive content are redacted from logs; log payloads go through the sanitizing logging aspect | `docs/agents/tech-standards.md` §5 (agent instructions); `src/aspects/loggingAspect.ts` (`sanitizeForLog`) | DOCUMENTED-ONLY |
| C6 | Log/telemetry shape: structured JSON with trace/tenant/actor context; W3C `traceparent` propagation | `docs/architecture/standards/standards.md` §2.2; ADR 0011 (observability port envelope) | DOCUMENTED-ONLY — and stated two different ways in the two sources (see Conflicts #5) |
| C7 | Configuration is externalized: flags and knobs come from config, not literals embedded in domain files; env access goes through the config layer | Implied by the agentic-SaaS cross-cutting directive (user directive 2026-10-25, agent-side record) and `aop-fit-gap-analysis.md` §1.1.4/Q3 | **GAP** — no repo standard and no enforcement exist; see AOP verification §4 |
| C8 | Feature flags sit behind `FeatureFlagPort`; the port interface contains zero Cloudflare types, zero binding imports, zero environment variables; fallbacks fail closed | ADR 0006, Decision items 1–2 | DOCUMENTED-ONLY — governs how flags are built, not coverage (see AOP verification §3) |
| C9 | Observability sits behind one port: one event schema, key-based redaction, a never-throw sink; domain code never imports a provider SDK | ADR 0011, Decision | DOCUMENTED-ONLY |

### D. Resolvers & context (the new standard's home)

| # | Rule | Source | Status |
|---|---|---|---|
| D1 | **One resolver per question** — within one question there is exactly one resolver; other copies are deleted or reduced to delegating wrappers | Agreed with the user 2026-11-08; issue #3786 | **GAP** — no home today; this doc set is its first home (see Gaps §1) |
| D2 | **Single typed input object** — a resolver takes one typed input object (the universal-input envelope for the context family); authority-bearing fields in that input are *pointers, re-derived from their authoritative source at call time, never trusted from the bag* | Agreed with the user 2026-11-08; issue #3786 | **GAP** |
| D3 | **Sync if pure, async only for own I/O** — a resolver is sync when it is a pure derivation over data in hand, async only when it itself crosses an I/O boundary; the I/O locus (fat: does its own I/O / thin: over injected ports or input) is declared in its header | Agreed with the user 2026-11-08; verified pattern on main (all 38 async exported resolvers await real I/O) | **GAP** |
| D4 | **Fallback declared and typed, never silent substitution** — a resolver's fallback behaviour is declared in its contract and visible in its return (flag, null, or typed refusal), never a silent substitution of a default answer | Agreed with the user 2026-11-08; issue #3786 | **GAP** |
| D5 | Tenant identity is resolved server-side from the authenticated session; a client-supplied tenant identifier is not sufficient authority | `docs/agents/tech-standards.md` §6; practised via `resolveIaaaTenant` + `src/services/tenantProviders.ts` header ("never from a client value") | DOCUMENTED-ONLY |
| D6 | ExecutionContext is a validated, frozen, fail-closed contract carrying ids, never presentation data; a context crossing a boundary is re-parsed and revalidated at the point of use; client-supplied identifiers are requests to be checked, never facts | `src/security/executionContext.ts` (#1069 §8, via #1078) | DOCUMENTED-ONLY — the contract is code; no doc states it as a standard, and its observe-mode default is a code fact a reader cannot learn from docs |
| D7 | Internal user identity is derived, never invented: `v1:` + SHA-256 over (issuer, subject), trim-only normalization (no case folding, no URL canonicalization) | ADR 0001, Decision | DOCUMENTED-ONLY |

### E. Security & tenancy

| # | Rule | Source | Status |
|---|---|---|---|
| E1 | Authorization is enforced server-side, through the central PDP seam — not ad-hoc in endpoints | `docs/agents/tech-standards.md` §6 ("Enforce permissions server-side"); `docs/compliance/anti-drift.md` §1E names "bypassed PDP seams" as drift (`iaaaPdpSeam.ts`) | DOCUMENTED-ONLY — no pin forces a route's authorization through the seam |
| E2 | Tenant isolation is enforced across database, object storage, search/vector, caches, queues, agent state, conversations, artifacts, integrations, notifications, logs, and exports — and every cross-tenant access path requires negative tests | `docs/agents/tech-standards.md` §6 | DOCUMENTED-ONLY |
| E3 | An agent acts only on the intersection of user authority ∩ organization policy ∩ resource policy ∩ tool policy ∩ current approval; authorization is rechecked before consequential execution | `docs/agents/tech-standards.md` §6 ("Delegated agent authority") | DOCUMENTED-ONLY |
| E4 | Prefer established libraries over custom security mechanisms; never implement custom cryptographic algorithms; verify signatures constant-time | `docs/agents/tech-standards.md` §5; `docs/compliance/anti-drift.md` §2 (constant-time HMAC in `src/security/session.ts`) | DOCUMENTED-ONLY |
| E5 | Secrets never appear in code, logs, or URLs; secret scanning covers the full PR commit range | `docs/agents/tech-standards.md` §5–§6; repo `.gitleaks.toml` | **ENFORCED** — Gitleaks secret scan (required check, `.github/workflows/gitleaks.yml`) |
| E6 | Every MCP tool carries exactly one scope from the six-scope set (`mcp:read/write/execute/trade/payments/admin`), scoped to its most privileged action; authorization is checked at every choke point (factory, JSON-RPC path, agent-turn adapter); the tool declaration table is completeness-pinned against the live registry in both directions | ADR 0012, Decision | **ENFORCED** — completeness pin vs the live factory registry; `tests/tool_attribution_audit_1763.test.ts` additionally pins that the audit doc names every factory tool (120) and scanner tool (4) |
| E7 | High-impact/consequential actions pause for explicit human approval (HITL); autonomous loops run under deterministic step caps (`MAS_MAX_STEPS`) and per-step timeouts | `docs/architecture/standards/standards.md` §6.1/§6.4; `docs/compliance/anti-drift.md` §2 (Agentic row) | DOCUMENTED-ONLY |
| E8 | Session tokens live in SQLite Durable Objects, never in unencrypted KV | `docs/compliance/anti-drift.md` §2 ("Zero KV Security Dependency", `src/security/sessionStore.ts`) | DOCUMENTED-ONLY |

### F. Client / UX code

| # | Rule | Source | Status |
|---|---|---|---|
| F1 | UI is built only from `src/client/components/ui/` primitives — every surface, including composition-only ones, with no exemptions; no raw HTML controls with hand-rolled inline styles | Repo AGENTS.md (UX paragraph); ADR 0004 (UX token architecture — "mandatory, no exemptions"); gitops §7 "No drift" item 2 | **ENFORCED** — `tests/ui_primitives_inventory.test.ts` (fixed inventory of primitive exports) + `tests/ux_primitives_pin_negative_1772.test.ts` |
| F2 | No raw color literals outside the token sources (`tokens.css`, `designTokens.ts`); theming via `data-theme` only, theme-class selectors banned elsewhere | Issues #470/#476 (UX token programme); ADR 0004 (UX) | **ENFORCED** — `tests/ux_token_coverage_ratchet.test.ts` — the count is at **zero**: this gate is absolute, not shrink-only |
| F3 | The token mirror stays in sync: `tokens.css` ↔ `designTokens.ts` parity is generated and checked, and the client token-coverage total is 0 | `scripts/gen-design-tokens.mjs --check` (in `npm run check`); gitops §8 pre-push battery (`scripts/token-coverage.mjs` TOTAL raw = 0) | **ENFORCED** |
| F4 | Density/spacing values come from tokens (`--control-height`, `--space-*`, …), never hardcoded literals | `docs/compliance/anti-drift.md` §1A | **ENFORCED** — `tests/ux_density_ratchet_1580.test.ts` (shrink-only ratchet) |
| F5 | Left-nav pages render inside the `PageShell` primitive under the route-table navigation standard; the chat page is the one recorded deferral, by owner decision | `docs/architecture/standards/standards.md` §9.1; ADR 0021 | DOCUMENTED-ONLY |
| F6 | Accessibility target is WCAG 2.2 AA across supported journeys: semantic structure, keyboard access, visible focus, accessible names/errors, contrast, non-color status indicators | `docs/agents/tech-standards.md` §10; `docs/architecture/standards/standards.md` §9.2 | DOCUMENTED-ONLY — `tests/theme_preferences.test.ts` pins theme parity only; the axe-core CI gate proposed in anti-drift.md §3 does not exist |

### G. Testing & pins

| # | Rule | Source | Status |
|---|---|---|---|
| G1 | Behaviour changes follow TDD (define cases → Red → Green → Refactor → Verify); a bug is reproduced before it is fixed; never delete or weaken a failing test to obtain green; never mock away the behaviour under test; Red/Green evidence must be observed, never claimed unobserved | gitops §7 + "Additional rules" | DOCUMENTED-ONLY — CI enforces the green end state, not the Red step |
| G2 | Pin rule 1 — a change that alters a pinned surface updates the corresponding pin in the *same* PR; a pin updated later means the surface changed unpinned | gitops §7, "The pin rule" item 1 | DOCUMENTED-ONLY — self-revealing: non-compliance surfaces as a failing pin |
| G3 | Pin rule 2 — no PR merges while any pin fails; a pin red on `main` is a stop-the-line event, never background noise | gitops §7 pin rule item 2; §10 stop-the-line | **ENFORCED** — required CI checks in the branch ruleset (gitops §22) |
| G4 | Pin rule 3 — scope pins narrowly: a pin asserts the facts it exists to protect and no more; a false-firing pin is narrowed in the same PR that reveals it | gitops §7, pin rule item 3 | DOCUMENTED-ONLY |
| G5 | Pin rule 4 — a new shared surface (route family, token set, binding, module boundary) ships with a pin, or the PR body explicitly says why not; silence is not a waiver | gitops §7, pin rule item 4 | DOCUMENTED-ONLY |
| G6 | Pre-merge battery on a fresh base: rebase onto current `origin/main`, then `scripts/verify-before-merge.sh` (refuses a stale base; runs typecheck, the migration latest-pin lint, the full test suite, and the policy-gate regression check); never push a red battery "to let CI sort it out" | Repo AGENTS.md pre-merge checklist; gitops §8 "Before pushing" | DOCUMENTED-ONLY — the script machine-checks when run; running it is agent discipline |
| G7 | Required CI is strict typecheck + production build + the full Vitest suite (sharded); never merge over a red required check | `.github/workflows/ci.yml` (Fast gates; Tests shards); gitops §10 | **ENFORCED** — CI + ruleset-required checks |
| G8 | Migration/refactor work uses the test-parity harness: capture → compare → checklist → check → report (`npm run parity`) | ADR 0013, Decision | DOCUMENTED-ONLY |
| G9 | Agentic changes are tested for: tenant isolation, tool permissions, approval binding, budget enforcement, retry safety, interrupted execution, evidence provenance, model/provider failure, prompt-injection resistance, structured-output validation; a model's agreement is never the sole correctness oracle | gitops §7, "Agentic application requirements" | DOCUMENTED-ONLY |

### H. Deprecation, changelog, docs, dependencies

| # | Rule | Source | Status |
|---|---|---|---|
| H1 | No PR deletes a file. Retire by renaming to `*.deprecated.*` in place, adding a header note naming the successor, and recording the entry in the single deprecation ledger (`docs/architecture/transition/deprecations.md`); deprecated files are frozen (refactoring only to migrate consumers off) and gain no new imports. Sole exception: a deleted *test* file whose every test name survives in an added file (#1917) | gitops §22, no-deletion + deprecation rule (#1894, #2299); repo AGENTS.md §22 summary | **ENFORCED** — Policy Gate check (i) (`scripts/ci/policy_gate.py`); `deletion-watchdog` workflow behind it |
| H2 | A deprecation marker in `src/` or `scripts/` — specifically `@deprecated`, all-caps `DEPRECATED`, or comment-leading `Deprecated:` — must name its successor in the same file's added lines, using a gate-recognized phrase (`superseded by` / `superseded-by` / `replaced by` / `in favor of` / `use … instead`); casual prose mentioning the word is excluded | gitops §22, deprecation completeness (#1894, refined #3504) | **ENFORCED** — Policy Gate check (j) |
| H3 | Every PR carries a changelog entry: under `## [Unreleased]` in CHANGELOG.md, or a `changelog.d/<issue>-<slug>.md` fragment | gitops §22 (Policy Gate contents) | **ENFORCED** — Policy Gate check (d) |
| H4 | Docs-only PRs (files strictly inside `docs/` + root doc markdown, excluding `changelog.d/`, `src/`, `tests/`, `scripts/`, `.github/`) bypass issue-linking, lane label, hashtag, process-checklist, and changelog requirements — but never the no-deletion rule or the docs-scope rule | gitops §22, zero-touch documentation merges (#2555); repo AGENTS.md | **ENFORCED** — Policy Gate checks (d)/(e) scope logic |
| H5 | Process decisions are recorded in the repository, not in chat or agent memory: a hard-to-reverse or cross-cutting decision lands as an ADR; PR bodies carry the `Process documentation impact:` line and point at the record instead of restating it | gitops §23 | **ENFORCED** — presence only: the Policy Gate fails a PR whose body lacks the §9 line; the gate explicitly does not judge quality |
| H6 | ADRs are never deleted or rewritten; a changed decision gets a new ADR that supersedes the old one, whose Status is updated with a pointer; the deciding issue references the ADR and vice versa | `docs/architecture/adr/README.md`, "Rules" | DOCUMENTED-ONLY |
| H7 | Provider/broker neutrality in the platform layer: platform code and copy do not present one provider as the platform; provider names live in the integration layer, behind the ports | Issue #3525 (neutrality programme, closed) | **ENFORCED** — `tests/neutrality_census_3525.test.ts`, shrink-only against a recorded baseline (1,095 file×term rows / 8,533 brand-term lines; platform rows were dispositioned, the rest baselined as integration/historical/not-provider) |
| H8 | Dependency specs are pinned to exact versions — no floating `latest` tags — and `package.json` specs equal the lockfile's resolved versions | Issue #540; `docs/agents/cloudflare.md` §4–5 | **ENFORCED** — `tests/dependency-pinning.test.ts` |
| H9 | Test fixtures that must contain secret-*shaped* values are assembled from string fragments at runtime, so no secret-shaped literal ever enters git history (the scanner scans the full PR range, not the final tree) | Practised since PR #691 / #1178; recorded only in the agent-side workspace AGENTS.md | **PRACTISED-UNDOCUMENTED** — no repo document states it; the Gitleaks gate enforces the *outcome* (no secret-shaped strings) but the fragment-assembly technique has no repo home |

### Pin inventory (the machine-enforced core, for `07-testing-and-pins.md`)

| Pin / gate | Rule it enforces | Kind |
|---|---|---|
| `tests/global_dd_census_2356.test.ts` (+ step censuses 2345/2357/2358/2359) | B1 — no naked SQL above the data layer; per-table writer sets | Shrink-only (exact allow-list; any count change fails) |
| `tests/neutrality_census_3525.test.ts` | H7 — platform-layer provider neutrality | Shrink-only (baseline 1,095 rows / 8,533 lines) |
| `tests/console_migration_ratchet_3515.test.ts` | C4 — no new unstructured `console.*` | Shrink-only (per-file ceilings; 234 remaining at batch-3 baseline) |
| `tests/ux_token_coverage_ratchet.test.ts` | F2 — no raw color literals outside token sources | **Fixed at zero** (absolute) |
| `tests/ux_density_ratchet_1580.test.ts` | F4 — density literals | Shrink-only |
| `tests/migration_registry.test.ts` + `scripts/check-migration-pins.sh` | B4 — migration "latest" owned by one test | Fixed (ownership rule) |
| `tests/trading-boundary.test.ts` | A4 — #290 barrel-only trading imports | Fixed |
| `tests/thin_router_inventory.test.ts` | A5 — thin ordered dispatcher (24 delegations) | Fixed inventory |
| `tests/server_route_inventory_2902.test.ts` | A5 — every Worker route branch in dispatch order, with method/auth guards | Fixed inventory |
| `tests/schema_single_source.test.ts` | A6 — one DDL source, identical effective schema on all init paths | Fixed |
| `tests/ui_primitives_inventory.test.ts` | F1 — the `ui/` primitive export inventory | Fixed inventory |
| ADR 0012 completeness pin + `tests/tool_attribution_audit_1763.test.ts` | E6 — every MCP tool scoped + named in the audit doc (120 factory + 4 scanner) | Fixed totals (move only by same-PR pin update) |
| `tests/error_catalog_r4.test.ts` + `tests/outcome_catalog_2381.test.ts` | C1/C3 — outcome catalog shape; every referenced code exists; resolver never invents | Fixed |
| `tests/dependency-pinning.test.ts` | H8 — exact dependency specs; package.json = lockfile | Fixed |
| `scripts/ci/policy_gate.py` checks (a)–(j) | H1–H5 + linked issue / lane label / hashtag (§21/§22) | Fixed PR-level gate |
| Gitleaks (`.github/workflows/gitleaks.yml`) | E5 — no secrets in the full PR commit range | Fixed |

---

## AOP fit/gap verification — do the implied standards exist today?

Source: `docs/architecture/code/aop-fit-gap-analysis.md` (Oct-2026 assessment). Each finding re-checked at the survey base. **Headline: of the three named findings, exactly one has become a standard with enforcement since the analysis; the other two remain gap analysis only.**

1. **Error catalog vs raw throws** (analysis §1.1.3, Q1 — "PARTIALLY", 493 raw `throw new Error("…")`).
   - The catalog half has *moved since the analysis*: the catalog it cites as live (`src/errors/errorCatalog.json`, `src/aspects/errorCodes.ts` + `errorAspects.ts`) has been superseded — the JSON is now `src/errors/errorCatalog.deprecated.json` and the resolver half lives in the single outcome catalog (C1, #2381), which *is* pinned (C3).
   - The raw-throw half has **no standard and no enforcement**: no repo document sets a rule against raw throws outside catalog/outcome paths, and no pin counts them. Fresh grep at base: **1,443 lines** match `throw new Error(` in `src/` (raw grep — includes legitimate internal throws; not method-comparable to the analysis's 493 estimate, but the order of magnitude says the practice is undiminished).
   - **Verdict: standard exists for catalog use at outcome boundaries (DOCUMENTED + partly ENFORCED via C1/C3); "no raw throws" is gap-analysis only.**
2. **Console vs structured logging** (analysis §1.1.2 — "NON-UNIFORM", 388 raw console calls bypassing the aspects).
   - **Verdict: standard + enforcement EXIST today** — this is the one finding that closed. The #3515 programme made the structured logger the standard and enforces it with a shrink-only ratchet pin (C4): batch 3 left 234 counted sites, locked per file; fresh raw grep at base finds 241 `console.*` call lines in `src/` (different counting — the pin strips comments/strings — same magnitude, consistent story).
3. **Feature-flag coverage** (analysis Q2 — "NO": flags evaluated in only 16 locations; core capabilities statically wired).
   - **Verdict: gap-analysis only.** ADR 0006 standardizes *how* flags are built (C8); no rule anywhere requires a feature to be flag-gated, and no census counts flag coverage.
4. **Env access scattering / configuration externalization** (analysis §1.1.4, Q3 — "PARTIALLY EXTERNALIZED", 371 direct `env` accesses).
   - **Verdict: gap-analysis only** (rule C7 above). No repo standard routes env access through the config layer system-wide, and no pin or census counts direct accesses. Fresh rough grep at base: 171 lines matching `.env.` access patterns in `src/**/*.ts` (narrower pattern than the analysis's count — the two numbers are not comparable, and that incomparability is itself the point: nothing maintains the measurement).

---

## Conflicts & duplication — read before writing the doc set

The doc set must not become a third (or ninth) copy of anything. Where a rule already has a canonical home, the new file states the operational rule in one or two lines and **points** to the canonical source. Known collisions:

1. **"Single home for rules" vs reality (the governing conflict).** gitops §22 (#2299) declares: *"This document is the one place for all rules unless another place is justified."* In fact, normative code rules already live in gitops, `standards.md`, `tech-standards.md`, `anti-drift.md`, the ADD's link list, 27 ADRs, and dozens of pin headers. The new set's README must resolve this head-on: either §22 is amended to name `docs/architecture/code/` as the justified operational home for *code* rules (with gitops keeping delivery/process rules), or the set is explicitly an index that restates nothing. Writing full rule text into the new files without that amendment creates the exact parallel-rule-home §22 forbids.
2. **Two anti-drift documents.** `docs/compliance/anti-drift.md` (142 lines) and `docs/compliance/anti-drift-controls.md` (87 lines) cover the same thesis, the same root causes, and the same gate table in different words; `docs/compliance/multiple-implementations.md` is a third sibling (the catalog gitops §7 points at). The new set should cite anti-drift.md as the framework and multiple-implementations.md as the catalog, and not restate either.
3. **The ADR index is stale, and ADR 0004 exists twice.** Two different decisions share number 0004 (`0004-screener-workflows.md` and `0004-ux-token-architecture-no-exemptions.md`). The README index lists only the UX one under 0004 and omits 0021, 0022, 0023, and 0026 entirely — so ADR 0022, the most consequential data-access decision in the repo, is invisible from the index. The new set's `02-data-access.md` must link the ADR file directly, not the index.
4. **The AOP analysis points at a deprecated catalog.** `aop-fit-gap-analysis.md` Q1/§1.1.3 describes `src/errors/errorCatalog.json` and `src/aspects/errorCodes.ts` as the live error-catalog machinery; the JSON is now `errorCatalog.deprecated.json` and the live system is `src/outcomes/` (#2381). Any doc written from the analysis without re-checking would teach builders to build on a deprecated catalog. (The deprecated files themselves comply with H1/H2 — renamed, successor named.)
5. **The logging standard is stated three incompatible ways.** `standards.md` §2.2 (JSON logs with named fields + W3C traceparent), ADR 0011 (one observability port + envelope folding + never-throw sink), and the #3515 practice (per-module structured logger, ratchet-enforced). No document reconciles them. `03-errors-logging-config.md` should state the practised rule (C4) as the operational standard and point at ADR 0011 for the port architecture — not invent a fourth shape.
6. **The UX token/primitive rule is restated in at least six places** (`standards.md` §9.1, ADR 0004-UX, gitops §7, repo AGENTS.md, `anti-drift.md`, `docs/plans/UX/…`). They agree in substance, but each restates rather than points. `06-client-ux-code.md` should be a short operational extract with pointers, and should name ADR 0004-UX as canonical.
7. **Deprecation: AGENTS.md lags gitops §22.** Repo AGENTS.md's summary still presents the older in-place form ("keep the file, mark it deprecated, remove it from exports") as the retirement path; §22 (owner direction 2026-10-29, #2299) made rename-to-`*.deprecated.*` + ledger entry the primary form, with in-place marks valid only for marks already in the codebase. The new `08-…` file must follow §22, not the AGENTS.md summary.
8. **Stale identities and figures in the source docs.** `anti-drift.md` and the `code/` assessments target "NextGenTP / AI Search Agent (`ai-search-agent`)"; the AOP analysis cites the pre-transfer repo name and an Oct-2026 tree (625 files; `src/` holds ~1,570 files today). None of their counts may be copied into the new set as current — every figure in the new set needs a fresh measurement or a dated citation.
9. **`standards.md` and `tech-standards.md` overlap without either being operational.** `standards.md` is a benchmark survey (TOGAF/COBIT/ITIL/DAMA/CMMI) — its few code-binding lines (§9.1 tokens/PageShell, §2.2 logging) are buried in framework prose; `tech-standards.md` is an external-standards *selection policy* whose cfagent-specific code rules (§5/§6 agent instructions) are likewise a small fraction. The ADD lists both as "the standards" and anchors SOLID/GRASP/GoF conformance to issue #488 (closed 2026-11-02). The new set fills the operational gap between them; it should say so, and neither doc should be copied into it.
10. **Pin rule 1 vs pin rule 5 read as a contradiction without the carve-out.** gitops §7 rule 1's examples say adding a migration "updates the identity assertions it touches"; rule 5 carves migration-*latest* out of that. Both are in §7, but a reader skimming rule 1 alone will bump latest pins. `07-testing-and-pins.md` must state the carve-out inline with rule 1.

---

## Gaps — implied standards with no home

1. **The resolver standard (gap #1 — the reason this doc set exists).** No repo document governs resolvers at all (verified: no resolver rule in `docs/agents/` standards docs at base), while the tree holds 251 exported `resolve*` signatures / 236 distinct names with measurably inconsistent shapes (census on #3786). The four rules agreed with the user, to be written as the standard in `04-resolvers-and-context.md`:
   - **R1 — One resolver per question.** Within one question there is exactly one resolver; every other place that derives the same answer calls it, or is removed/reduced to a delegating wrapper (the `runDetails` → `outcomeAspects` precedent).
   - **R2 — Single typed input object, with the envelope trust rule.** A resolver takes one typed input object. For the context family, that object is the shared envelope (tenant, login, environment, stored selections, provenance where present). Its fields split in two: *claims* (a selected provider id, a timeframe, a requested cadence) are read directly; *authority-bearing fields* (tenant identity, entitlements, approvals) are never trusted from the bag — the envelope carries pointers ("tenant: from session", "selection: from tenant store") and the resolver re-derives the fact from its authoritative source at call time. The JSON says where to look, never what the answer is.
   - **R3 — Sync if pure; async only when the resolver does its own I/O.** Async marks exactly one thing: this function crosses an I/O boundary itself. The I/O locus is declared in the resolver's header — fat (takes `env`/ports and does its own reads) or thin (pure over an already-read input) — following the tenant pair as the reference shape: `resolveTenantProviders` (async, reads the store) → `resolveTenantProviderContext` (sync, normalizes the row).
   - **R4 — Fallback declared and typed, never silent.** Every resolver's fallback behaviour is part of its contract and visible in its return — a fell-back flag, a null, or a typed refusal — never a silent substitution of a default answer for a missing fact. (Today's five divergent semantics — fail-open-to-legacy, fail-open-with-flags, return-null, fail-closed, route-503 — are the census's disposition list, not a menu for new code.)
   - Enforcement, when it lands, belongs to #3786 (census + shrink-only pin); until then this standard is DOCUMENTED-ONLY by design and new work is held to it by review.
2. **Configuration externalization / env access** (rule C7): no standard, no census, no pin — only the AOP gap finding. A standard here would name the config layer as the single env reader and disposition the direct accesses shrink-only, on the #3515 ratchet pattern.
3. **"No raw throws" outside catalog paths:** no rule, no count. The outcome catalog governs messages at outcome boundaries; nothing governs the 1,443 raw-throw lines. If a standard is wanted, it needs the same treatment as C4: a measured baseline + shrink-only ratchet, not a prose ban.
4. **Feature-flag coverage:** ADR 0006 governs flag *construction*; nothing governs which capabilities must be flagged. The AOP Q2 finding (16 evaluation sites) has no owner and no follow-up home.
5. **Port-adapter conformance meta-rule** (A2/B5): the two-adapters + one-suite pattern is mandated inside individual ADRs but no standard states it as a rule for *new* ports, and nothing checks a new port for its in-memory adapter or suite.
6. **Secret-shaped test fixtures** (H9): a real, relied-on practice with its only record in agent-side memory. It belongs in `08-deprecation-changelog-docs.md` or `07-testing-and-pins.md` as a one-line rule next to the Gitleaks gate it serves.

---

## Counts (read off this file)

- **Rules harvested: 63** — A:10, B:5, C:9, D:7, E:8, F:6, G:9, H:9.
- **By status: ENFORCED 24 · DOCUMENTED-ONLY 33 · PRACTISED-UNDOCUMENTED 1 · GAP 5** (the four resolver rules D1–D4 + configuration externalization C7).
- Machine-enforced core: 16 pins/gates itemized in the pin inventory.
- AOP verification: 4 findings checked — 1 closed since the analysis (logging), 1 half-closed (catalog yes, raw throws no), 2 gap-only (flag coverage, env scattering).
