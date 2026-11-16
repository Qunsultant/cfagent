> **Filed into the repo 2026-11-16** (issue #4792) — copy of `~/workspace/2380-survey-draft.md` as written on its stated base (main `d83f487`, 2026-11-02). Survey body below unchanged.

# Survey draft — cfagent issue #2380 (SURVEY ONLY, do not implement)

> Status: DRAFT for parent review. Nothing in this document has been
> published to GitHub and no code was changed. All paths are relative to
> the repo root. Base: `origin/main` at `d83f487` (2026-11-02, "feat(2868):
> AOP aspects once — failure classification and structured run logging
> at runScreen funnel"). Read from a detached worktree; no worktree
> outside this survey was modified.

## 0. What this survey was asked to settle

Issue #2380 commissions, survey-only:

1. Inventory every explorer / dashboard / research-panel surface **by
   channel** (route, owning component, data sources, audience, purpose),
   count them, and name overlaps.
2. One standard pattern per `docs/agents/ux-architecture.md`,
   `PageShell`, and the global toast standard (transient → Toast,
   persistent → inline Notice), with every surface mapped and
   deviations listed.
3. Hidden capabilities (built services / agents / endpoints / jobs with
   no UI surface) plus how each should be surfaced.
4. A merge / retire / keep proposal with successors named
   (gitops: retire in place, **no deletions**).
5. The addenda: the channel model for outcome messages (audit explorer,
   Autopilot jobs page, Slack/email receipts, UI banner, reports
   themselves, admin panel runs domain #2173 as consolidated home) and
   the principle **one outcome per job run, recorded once, rendered
   identically everywhere from the same catalog**.

## 1. Counts (all verified against the base commit)

| Thing | Count | Source |
|---|---|---|
| Routes in `src/client/routes.ts` | 37 | `routes.ts` |
| Routes with a `navEntry` (left-nav items) | 30 | navOrders 0–29, exactly one per order |
| Host-only routes (no `navEntry`, reachable by URL/menu) | 7 | `options`, `orders`, `reports`, `scanner`, `schedules`, `screeners`, `trading` |
| Left-nav menu sub-items | 28 | stock-hub 3, options-screener 12, workflow-runs 6, agents 2, sandbox 1, planned 4 (flag-gated) |
| Deep-link surface defs in `src/client/deepLinks.ts` | 14 | screeners-hub, stock-hub, options-research, platform-admin, payments, social, ads, referrals, revenue, workflows, checkout, iaaa-admin, reports-panel, risk-analysis |
| Options research surfaces (`research` param) | 10 | `src/client/options/researchSurface.ts`: discovery, strategy-panel, contracts, best-trade, compare, llm-ideas, llm-evaluate, schedules, custom, nlq |
| Options screener products | 10 | `src/client/OptionsScreenerPage.tsx`: contract-screen, strategy-panel, best-trade, compare, llm-ideas, llm-evaluate, discovery, scheduled, flows, iv-history |
| Platform admin sections | 8 | `src/client/platformAdminConfig.ts`: ads, background-tasks, scheduled-goals, provenance, api-keys, data-providers, iaaa-admin, admin-access |
| In-scope surfaces inventoried in §2 | 45 | table rows below (hubs + panels + tabs + queues; `OptionsScreenerPage` counted once, in §2c) |
| Orphaned components found (zero importers in `src/`) | 3 | `ProviderConnectivityDashboard`, `MemoryBrowser`, `StrategyReviewPanel` |
| Hidden server capabilities with no UI caller (§6) | 5 verified | DLQ ops, knowledge-file serving, premium metered endpoints, email trading agent, report export formats (partial) |

### Corrections to the inherited skeleton (verify, don't trust)

- The options research panels do **not** live directly under
  `src/client/`. `src/client/OptionsResearchPanel.tsx` and
  `src/client/LlmOptionsIdeasPanel.tsx` are one-line re-export shims;
  the real files are `src/client/options/OptionsResearchPanel.tsx`
  (1763 lines) and `src/client/options/LlmOptionsIdeasPanel.tsx`.
- `ResearchRunsPanel`, `StrategyDiscoveryPanel`, `DiscoveryRunsPanel`,
  `ScreeningActivityPanel` live in `src/client/options/`, not
  `src/client/`.
- `ProviderConnectivityDashboard` is **not** a live dashboard: it has
  zero importers and its header in `DataProvidersPanel.tsx` says
  connectivity/health metrics moved there ("from former
  ProviderConnectivityDashboard"). The file survives as an orphan.
- `ScreenersHub.tsx` is 580 lines post-#2896 (stocks tabs moved to
  `StockHub.tsx`, 951 lines); its tab union is 12 (options, forex,
  futures, commodities, bonds, scanner, iv-history, goal-screen,
  reports, schedules, review, track-record), default `options`.
- `StockHub.tsx` (`?tab=stock-hub`) has 3 tabs (stocks, new-screen,
  research); the `research` tab renders `MarketDataResearchHub`, which
  also keeps its standalone `?tab=research` home.

## 2. Inventory by channel

Audience key: **trader** = person acting on screens/trades;
**operator** = person watching runs/health; **reviewer** = person
deciding held items; **admin** = platform admin; **dev** = developer /
integrator. "Host" = the route or hub tab that renders the surface.

### 2a. Dashboards

| Surface | Host | Component | Data sources | Audience | Purpose |
|---|---|---|---|---|---|
| Calibration dashboard | ScreenersHub `track-record` tab | `src/client/CalibrationDashboard.tsx` (188 lines) | `GET /api/research/track-record/calibration` | operator | Calibration quality of the research track record |
| Enrichment dashboard | ScreenersHub `track-record` tab | `src/client/EnrichmentDashboard.tsx` (190 lines) | `GET /api/enrichment/status`, `/api/enrichment/killswitch` | operator | Enrichment provider, coverage, breaker state, killswitch, recent runs (#1888) |
| Provider connectivity dashboard | — (orphan, §6) | `src/client/ProviderConnectivityDashboard.tsx` (219 lines) | was `GET /api/etrade/oauth/status` | — | Former connectivity view; folded into `DataProvidersPanel` |

### 2b. Explorer-like

| Surface | Host | Component | Data sources | Audience | Purpose |
|---|---|---|---|---|---|
| MCP / API explorer | `?tab=endpoints` via `EndpointsTab` | `src/client/McpApiExplorer.tsx` (786 lines) | `POST /api/mcp` (tool calls) | dev | Browse + try the MCP tool catalog |
| Memory browser | — (orphan, §6) | `src/client/MemoryBrowser.tsx` (114 lines) | `GET /api/memory/search` via `src/client/memoryApi.ts` | dev/researcher | Search memory chunks by query + operation filter |
| Market data research hub | `?tab=research` AND StockHub `research` tab | `src/client/MarketDataResearchHub.tsx` (1900 lines) | `/api/market-data/*` (quote, bars, fundamentals, compare, screen, snapshot, research, providers), `/api/audit?limit=50` | trader/researcher | Quotes, bars, fundamentals, cross-provider compare, screen, research notes; also carries an audit section |
| Search hub | `?tab=search` | `src/client/search/SearchHub.tsx` (via `Chat.tsx`) | tool-search catalog (incl. `McpApiExplorer.toolSearch`, no backend) | trader/dev | Search across tools / surfaces |

### 2c. Options research family (all inside `OptionsResearchPanel` modes unless noted)

| Surface | Host | Component | Data sources | Audience | Purpose |
|---|---|---|---|---|---|
| Options research panel + host | `?tab=options` AND ScreenersHub `options` tab | `src/client/options/OptionsResearchPanel.tsx` (1763 lines) via `OptionsResearchHost.tsx` (68 lines) | `/api/trading/options/screen`, `/api/trading/options/comparison`, `/api/nlq`, `/api/chat-activity` | trader | Mode container: discovery / contracts / custom / llm-ideas / schedules / nlq (`ResearchMode`) |
| Strategy discovery | discovery mode | `src/client/options/StrategyDiscoveryPanel.tsx` (3773 lines) | `/api/trading/options/config`, `/api/schedules/create`, `/api/market-data/quote` | trader | Strategy discovery engine UI; schedules a discovery run |
| Discovery runs | discovery mode | `src/client/options/DiscoveryRunsPanel.tsx` (680 lines) | `/api/etrade/options/discovery-runs` via `src/client/discoveryApi.ts` (+ CSV export via `runExport`) | trader | Stored discovery runs, detail, export |
| Research runs | research modes | `src/client/options/ResearchRunsPanel.tsx` (464 lines) | `/api/research/latest`, `/history`, `/run`, `/evaluate`, `/settings` | researcher | Research-agent run history, settings, evaluation |
| Screening activity | research modes | `src/client/options/ScreeningActivityPanel.tsx` (183 lines) | `/api/screening/activity?limit=25`, `/api/screening/controls` | operator | Screening activity feed + controls |
| LLM options ideas | llm-ideas mode | `src/client/options/LlmOptionsIdeasPanel.tsx` (377 lines) | `/api/trading/options/llm-ideas` | trader | LLM-generated options ideas |
| Raw contracts screener | contracts mode | `src/client/options/RawContractsScreener.tsx` (679 lines) | props-driven (contracts arrive via the parent screen call) | trader | Raw contract chain screen |
| Autonomous options runs | research modes | `src/client/options/AutonomousOptionsRuns.tsx` (104 lines) | `/api/options/latest` via `src/client/optionsLatestShared.ts` (scheduler persists last 20 runs in DO storage `options:last_runs`) | trader | Latest autonomous options runs (hourly Strategy/Symbol Scanner + manual runs) |
| Options flows hub | `?tab=options-flows` | `src/client/options/flows/` (`OptionsFlowsHub` via `Chat.tsx`) | flows endpoints (not extracted — see §9) | trader | Options flow / sweep surface |
| Contract screen product | Options screener page | `src/client/OptionsScreenerPage.tsx` (340 lines) | product catalog (10 products, flag-gated) | trader | Product index; 9 cards link to catalog deep links, `scheduled` keeps hostTab `schedules` |

### 2d. Screening review / outcomes / scan

| Surface | Host | Component | Data sources | Audience | Purpose |
|---|---|---|---|---|---|
| Screening outcomes | ScreenersHub `track-record` tab | `src/client/ScreeningOutcomesPanel.tsx` (149 lines) | `GET /api/screening/outcomes` | operator | Screening outcome aggregates |
| Screening review (adaptation) | ScreenersHub `review` tab; also `workflow-runs:review` override → `?tab=screeners&view=review` | `src/client/ScreeningReviewPanel.tsx` (682 lines) | `/api/adaptation/candidates`, `/verdicts`, `/evaluations`, `/promotions`, `/weights`, `/api/screening/goals`, `/reselection-proposals` | reviewer | Adaptation candidates, verdicts, promotions, reselection proposals |
| Strategy reviews | — (orphan, §6) | `src/client/StrategyReviewPanel.tsx` (89 lines) | `/api/options/strategy-reviews`, `/decide` | reviewer | Strategy-review decisions (distinct from adaptation review — name collision, §3) |
| Scanner | ScreenersHub `scanner` tab | `src/client/ScannerPanel.tsx` (1646 lines) | `/api/trading/options/catalog` | trader | Strategy/symbol scanner matrix + rerun |
| IV history | ScreenersHub `iv-history` tab | `src/client/IvHistoryPanel.tsx` (179 lines) | `/api/etrade/options/iv-history` | trader | Implied-volatility history |
| Goal screen | ScreenersHub `goal-screen` tab AND top-level Intelligence nav item (its home per #2896) | `src/client/GoalScreenPanel.tsx` (1375 lines) | `/api/screening/goal-screen`, `/api/screening/backtest`, `/api/saga/*`, `/api/runs`, `/api/reports/:id`, `/api/payments/agentic/commercial/pricing` | trader | Goal-based screen + saga workflows |

### 2e. Reports / runs

| Surface | Host | Component | Data sources | Audience | Purpose |
|---|---|---|---|---|---|
| Reports library | ScreenersHub `reports` tab | `src/client/ReportsPanel.tsx` (334 lines) | `/api/reports?limit=100`, `/api/runs`, `/api/reports/semantic-search`; embeds `ResearchTrackRecord` (`src/client/chat/tabs/ResearchTrackRecord.tsx`) | trader/operator | Report library + semantic search + track record |
| Docs & reports | `?tab=docs` AND workflow-runs menu `docs` | `src/client/DocsAndReportsPanel.tsx` (400 lines) | `/api/runs?kind=all&limit=100`, `/api/runs/details` | operator | Docs index + run reports with detail drawer |
| Workflow runs | `?tab=workflow-runs` | `src/client/WorkflowRunsPanel.tsx` (676 lines) | `/api/workflow-runs?limit=50` | operator | Workflow run traces |
| Async jobs (Autopilot jobs page) | Autopilot surface AND admin `background-tasks` section (embedded) | `src/client/AsyncJobsPanel.tsx` (306 lines) | `/api/jobs?limit=30`, `/api/jobs/:id`, `/retry` | operator | Async job tree (the Autopilot jobs page) |
| Schedules | ScreenersHub `schedules` tab | `src/client/SchedulesPanel.tsx` (646 lines) | `/api/schedules` (+ pause/trigger/delete) | operator | Durable schedules (DO alarms via `SqlPausedScheduleStore`) |
| Run detail | StockHub `stocks` tab (selected run) | `src/client/RunDetailView.tsx` (210 lines) | props-driven (run + confirmations) | trader | Single-run detail + report confirmations |
| Screener results (unified view) | StockHub `stocks` tab + manual results | `src/client/ScreenerResultsView.tsx` (665 lines) | props-driven ("unified ScreenerResultsView", #261) | trader | Unified results table for auto + manual runs |
| Morning digest | StockHub `stocks` tab | `src/client/MorningDigest.tsx` (277 lines) | `/api/trading/reports/pending` | trader | Overnight digest; `onViewQueue` → old hub reports |
| Research track record | Inside `ReportsPanel` | `src/client/chat/tabs/ResearchTrackRecord.tsx` | research track-record data (via ReportsPanel) | operator | Track-record view embedded in the reports library |

### 2f. Approvals (one composed surface, two queues)

| Surface | Host | Component | Data sources | Audience | Purpose |
|---|---|---|---|---|---|
| Approvals | `?tab=approvals` | `src/client/ApprovalsPanel.tsx` (39 lines + queues) | composes the two queues below; no own endpoint | reviewer | Single place for every consequential action awaiting a decision (#1705) |
| Trade drafts queue | inside ApprovalsPanel | `src/client/TradingApprovalsQueue.tsx` (342 lines) | `/api/etrade/orders`, `/api/etrade/order/execute` | reviewer | HITL trade drafts, 15-min expiry (#1327) |
| Held deliveries queue | inside ApprovalsPanel | `src/client/PendingReviewQueue.tsx` (237 lines) | `/api/trading/reports/pending`, `/confirm` | reviewer | Held report deliveries (#1324) |
| — (gap, by the panel's own header) | — | — | no listable pending-decision endpoint | — | Schedule and social approvals have nothing to compose yet |

### 2g. Admin

| Surface | Host | Component | Data sources | Audience | Purpose |
|---|---|---|---|---|---|
| Platform admin (drawer) | `?tab=platform-admin` (8 sections, `view` param) | `src/client/PlatformAdminPanel.tsx` (486 lines) + `PlatformAdminPage.tsx` (267 lines) | `/api/iaaa/access-request`; sections embed other panels | admin | Section drawer: ads, background-tasks, scheduled-goals, provenance, api-keys, data-providers, iaaa-admin, admin-access |
| IAAA admin | platform-admin `iaaa-admin` section; also `iaaaTab` surface (overview, members, api, mcp, iaaa, correlations, queue) | `src/client/IaaaAdminPanel.tsx` (802 lines) | `/api/iaaa/*` via `src/client/iaaaAdminApi.ts` (overview, memberships, grant/revoke/edit, access-requests/decision, deactivate, offboard) | admin | Read-only memberships, genesis, audit, access control |
| Agents registry | `?tab=agents` | `src/client/AgentsPanel.tsx` (449 lines) | `/api/agents/registry` | admin/dev | Agent registry |
| Data providers | platform-admin `data-providers` section | `src/client/DataProvidersPanel.tsx` (548 lines) | `/api/etrade/oauth/status` | admin | Provider provisioning lifecycle + connectivity (successor of the orphaned connectivity dashboard) |
| Scheduled goals | platform-admin `scheduled-goals` section | `src/client/ScheduledGoalsPanel.tsx` | via scheduled-goals/delegation modules (endpoint set not extracted — §9) | admin | ScheduledAgent goals, ticks, add-goal form |
| Audit vault | `?tab=audit` (Chat tab) | `Chat.tsx` audit branch + `src/client/components/AuditEventCard.tsx` | `GET /api/audit?limit=30` | operator/admin | Audit event list (the audit explorer) |
| Developer & MCP | `?tab=endpoints` | `src/client/chat/tabs/EndpointsTab.tsx` → `McpApiExplorer` | `/api/mcp` | dev | Same explorer as §2b, reached via the agents menu |

### 2h. Hubs (containers, not panels)

| Hub | Host | Tabs | Notes |
|---|---|---|---|
| `StockHub` | `?tab=stock-hub` | stocks, new-screen, research | Owns stocks/new-screen/research; `onStocksLoaded`, `onPreviewTrade`, `onSendPrompt`, `onJobStateChange` |
| `ScreenersHub` | `?tab=screeners` (host route, no navEntry) | 12 (see §1) | Default `options`; also hosts planned-asset placeholder tabs (forex/futures/commodities/bonds) |
| `WorkflowsHub` | `?tab=workflows` | faq, workflows, decisioning, matrix, improvements | Guides/decisioning surface — NOT the same as the workflow-runs menu (docs/workflow-runs/workflows/reports/review/track-record), whose `review`/`track-record` subs override to ScreenersHub tabs |
| `OptionsScreenerPage` | `?tab=options-screener` | 10 products | Product index; flag-gated cards |

## 3. Overlaps, ranked

1. **Run lists (8 surfaces, ≥4 stores).** `AsyncJobsPanel`
   (`/api/jobs`, `mas_async_jobs`), `WorkflowRunsPanel`
   (`/api/workflow-runs`), `DocsAndReportsPanel` + `ReportsPanel`
   (`/api/runs`, `mas_reports`), `DiscoveryRunsPanel`
   (`/api/etrade/options/discovery-runs`), `ResearchRunsPanel`
   (`/api/research/*`), `AutonomousOptionsRuns` (`/api/options/latest`,
   DO `options:last_runs`), `RunDetailView` (single-run view). Same
   question — "what ran, what happened?" — answered eight ways from
   different stores. This is the consolidation center of gravity.
2. **Reports (3 surfaces, same sources).** `ReportsPanel`
   (`/api/reports` + `/api/runs` + semantic search),
   `DocsAndReportsPanel` (`/api/runs` + details), `ResearchTrackRecord`
   (inside ReportsPanel). A report found in one is not obviously the
   same object in another; no shared report-detail route is used by
   all three.
3. **Outcome views (4 surfaces, one domain).** `ScreeningOutcomesPanel`
   (`/api/screening/outcomes`), `ScreeningActivityPanel`
   (`/api/screening/activity`), `CalibrationDashboard`
   (`/api/research/track-record/calibration`), `ResearchTrackRecord`.
   Screening/research quality is split across activity, outcomes,
   calibration, and track-record views.
4. **Research entries (4 doors, one job).** `MarketDataResearchHub`
   (market data), `OptionsResearchPanel` discovery mode (strategies),
   `SearchHub` (tool search), Chat NLQ (`/api/nlq`, `nlq` mode).
   A user asking "research X" has four starting points with no
   cross-linking.
5. **Audit renderings (3+, different limits).** Chat audit tab
   (`/api/audit?limit=30`), `MarketDataResearchHub` audit section
   (`/api/audit?limit=50`), IAAA admin audit, admin `provenance`
   section (DID/MCP/attestation/ledger). Same audit log, different
   windows, no shared audit-detail view.
6. **Review name collision.** `ScreeningReviewPanel` (adaptation
   proposals) vs orphaned `StrategyReviewPanel` (strategy-review
   decisions) vs `ScreeningReviewPanel`'s own "review" tab. Two
   "review" concepts share a word and a menu neighborhood.
7. **Jobs vs schedules vs goals (3 control surfaces).** `AsyncJobsPanel`
   (jobs), `SchedulesPanel` (schedules), `ScheduledGoalsPanel`
   (goals). A scheduled goal produces jobs; the three surfaces do not
   link to each other by id.
8. **Approvals gap.** Schedule and social approvals have no listable
   pending-decision endpoint (stated in `ApprovalsPanel`'s own header),
   so the "every decision in one place" claim holds only for trade
   drafts + held deliveries.

## 4. Outcome channel model — one outcome, recorded once, rendered identically

### 4a. The record (what "recorded once" means here)

- Canonical report copy: `mas_reports` (DO-SQLite), read via
  `GET /api/reports` (per repo architecture notes).
- Job rows: `mas_async_jobs`, read via `GET /api/jobs`.
- Report confirmations: `mas_report_confirmations`, read via
  `/api/trading/reports/confirmations` and pending via
  `/api/trading/reports/pending`.
- Audit events: the audit log, read via `GET /api/audit`.
- A run's outcome SHOULD be one row in exactly one of these stores
  (job row for execution, report row for artifact, confirmation row
  for delivery decision), with the other channels rendering that row
  by id — not re-deriving it. **Gap found:** no shared outcome-catalog
  module exists in the client today; each channel fetches its own
  endpoint and formats independently (see §4c).

### 4b. Channels (verified present)

| Channel | Surface | What it renders today | Record it must cite |
|---|---|---|---|
| Audit explorer | Chat `?tab=audit` (`AuditEventCard` list) | Audit events, limit 30 | audit event id |
| Autopilot jobs page | `AsyncJobsPanel` (Autopilot surface + admin `background-tasks`) | Job tree, detail, retry | job id (`/api/jobs/:id`) |
| Slack receipts | `SlackAgent` (`src/agents/slackAgent.ts`) + `src/agents/social/delivery.ts` (webhook first, else `chat.postMessage` via bot token) | Delivery messages | run/job id + link back to runs domain (link-back NOT verified — §9) |
| Email receipts | Email trading agent (`src/trading/email/agent.ts`: inbound intents, HITL approval links, outbound transaction receipts) | Receipt + approval emails | run/order id + signed approval link |
| UI banner | **No dedicated job-outcome banner found.** Closest: global Toast (transient) and `flowTradeBanner` (trade-context banner prop on `StrategyDiscoveryPanel`, not a job channel) | — | — |
| Reports themselves | `ReportsPanel`, `DocsAndReportsPanel` | Stored report artifact + detail | report id (`/api/reports/:id`, `/api/runs/details`) |
| Admin runs domain (consolidated home) | Platform admin `background-tasks` section embeds `AsyncJobsPanel`; `scheduled-goals` section embeds `ScheduledGoalsPanel` | Jobs + goals in one drawer | job id, goal id |

### 4c. Per-channel rendering rules (proposed standard, to be ratified)

1. **One catalog, many renderings.** A single outcome-catalog module
   (new, client-side) maps a run/job/report id to its canonical
   record; every channel renders from that record. No channel formats
   its own copy of status, timestamps, or amounts.
2. **Every rendering carries the id + a deep link to the runs home**
   (`?tab=platform-admin&view=background-tasks` + job id once
   `AsyncJobsPanel` accepts a deep-linked job — follow-up, §9).
3. **Audit explorer is read-only projection** of the same record
   (never a second write path; writes stay `POST /api/audit/event`
   from the producing agent only).
4. **Slack/email receipts are delivery renderings, not records:**
   they must quote the run id and the runs-home link, and must never
   be the only place an outcome exists.
5. **Transient vs persistent, per the global toast standard:**
   completion pings → Toast (bottom-right, auto-dismiss); the durable
   outcome → the runs home + the report itself. No new banner
   component: the "UI banner" channel is served by Toast + runs home.
6. **Reports render the stored artifact**, never a re-computed view:
   `ReportsPanel` detail and `DocsAndReportsPanel` detail must show
   the same bytes for the same report id (today they fetch different
   endpoints — `§3` overlap 2).

## 5. Standard pattern + map + deviations

### 5a. The standard (from `docs/agents/ux-architecture.md`, PageShell, global toast)

- Build only from `src/client/components/ui/` primitives; token-only
  styling; no raw HTML controls; no hand-rolled cards/badges/modals/
  toasts; no native `alert()`/`confirm()`.
- Page-level surfaces render inside `PageShell` (+ `PageSection`);
  embedded sections inherit the host hub's chrome.
- Transient feedback → global Toast; persistent state → inline
  Notice; URL-synced tabs via `useUrlSyncedTabs` (`view` param,
  `routechange` + `popstate` — fixed by #2923).
- Server-confirmed state only; WCAG 2.2 AA.

### 5b. Measured compliance (45 surfaces)

- **Primitives:** PASS everywhere measured. Zero raw `<button>` /
  `<input>` / `<select>` / `<textarea>` literals and zero `alert()`
  calls across all 30 panel files checked (§2a–§2g components).
  Every panel imports from `components/ui`.
- **PageShell:** 5 of 30 panel files use it directly
  (`MarketDataResearchHub`, `WorkflowRunsPanel`, `AgentsPanel`,
  `ApprovalsPanel`, `WorkflowsHub`). This is **not** 25 violations:
  most panels are embedded tab sections whose host hub owns the
  shell. The standard needs the page-vs-section distinction (§5c).
- **Toast:** 2 of 30 panels use `useToast` (`StrategyDiscoveryPanel`,
  `SchedulesPanel`). The dominant pattern is inline error text /
  `Notice` (Notice present in 10 of 30). Per the global standard,
  action confirmations (run started, schedule created, decision
  recorded) should use Toast; inline Notice is correct only for
  persistent state (e.g. a failed load that stays until retried).
- **URL-synced tabs:** all hubs use `useUrlSyncedTabs` with the
  `view` param; the left-nav routechange gap is fixed (#2923) and
  pinned (`tests/use_url_synced_tabs.test.tsx`).

### 5c. Deviations (genuine, not just missing PageShell)

1. **Standalone routes rendering panels without PageShell.**
   `?tab=docs` (`DocsAndReportsPanel`), `?tab=workflow-runs`
   (`WorkflowRunsPanel` — uses PageShell, OK), `?tab=reports` host
   route, `?tab=search` (`SearchHub` — uses its own shell; verify
   PageShell adoption), `?tab=endpoints` (`EndpointsTab` wrapper).
   Rule: if the route IS the page, the page gets PageShell.
2. **Toast under-adoption.** 28 of 30 panels never toast. Action
   confirmations today are inline text that competes with content.
   Fix direction: toast on action completion in `SchedulesPanel`
   (already), `StrategyDiscoveryPanel` (already), `ScreeningReviewPanel`
   (verdicts), `ApprovalsPanel` queues (decisions), `AsyncJobsPanel`
   (retry), `DiscoveryRunsPanel` (export).
3. **Inline error text vs Notice inconsistency.** Panels without
   `Notice` render errors as bare `<p className="…-error">` text
   (e.g. `AutonomousOptionsRuns`, `MemoryBrowser`, `AsyncJobsPanel`).
   Standardize on `Notice` for persistent errors.
4. **Audit limit inconsistency.** 30 vs 50 across two audit renderings
   (§3.5) — one catalog, one default limit.
5. **Stale-param leakage in URLs.** Left-nav links preserve unrelated
   params (`checkoutTab`, `iaaaTab`, `research`) across navigations
   (observed live on `?tab=stock-hub&view=…`). Cosmetic, but the
   pattern should state which params a surface owns vs inherits.

## 6. Hidden / orphaned capabilities

"Hidden" = built and reachable (server route, agent, or scheduled job)
with no UI surface, or a component with zero importers. Verified by
grep over `src/` at the base commit; client endpoint set (286 distinct
`/api/…` strings) diffed against server-side strings, then hand-vetted
(the raw diff has placeholder-syntax false positives and was NOT
trusted blindly).

| Capability | Evidence | Surface proposal |
|---|---|---|
| DLQ operations: `GET /api/ops/dlq/records`, `POST /api/ops/dlq/replay` | `src/agents/routes/dlq.ts` (handlers take parsed inputs; newest-first records, re-drive one record) — no client caller | New `ops` section in the admin runs domain (next to `background-tasks`), or a DLQ view inside `AsyncJobsPanel`; successor: admin runs domain |
| Knowledge corpus serving: `GET /knowledge/file?key=…` (flag-gated) | `src/agents/routes/knowledgeCorpus.ts` (S2 serving route, 401/400 guards) — no UI caller | Knowledge section in `SearchHub` or a `McpApiExplorer` corpus tab; successor: `SearchHub` |
| Premium metered endpoints: `/api/premium/market-research`, `/options-scan`, `/stock-signals` | `src/agents/routes/premium.ts`; client references only in `WorkflowsHub` workflow definitions + `src/client/iaaaEndpointCatalog.ts` (`/api/premium/*`) | No new page: document in the IAAA endpoint catalog (already) and keep workflow-definition exposure; add a premium section to the admin `provenance`/metering view if metering needs eyes |
| Email trading agent | `src/trading/email/agent.ts`: inbound email intents (quotes, screener, portfolio, trade previews), HITL approval links, outbound transaction receipts | Channel is email itself; receipts must cite run/order id + runs-home link (§4c rule 2); document in the omnichannel surface, no new page |
| Slack agent + social delivery | `src/agents/slackAgent.ts`, `src/agents/social/delivery.ts` (webhook → `chat.postMessage` fallback) | Same as email: delivery renderings of the runs-home record |
| Report export formats: `/api/discovery/report.{csv,pdf,xlsx}`, `/api/research/report.{csv,pdf,xlsx}`, `/api/options/report.{csv,xlsx}`, `/api/screener/report.csv` | Server strings present; client wires CSV export via `runExport.downloadDiscoveryExport` in `DiscoveryRunsPanel`; PDF/XLSX wiring unverified (§9) | Confirm PDF/XLSX wiring; if unwired, add format buttons to `DiscoveryRunsPanel` + `ReportsPanel` detail (successor: existing export buttons, not a new surface) |
| Orphaned `MemoryBrowser` | Zero importers in `src/`; data via `/api/memory/search` | Either render it (candidate: `SearchHub` memory tab or `EndpointsTab` dev section) or retire in place with successor `SearchHub` |
| Orphaned `StrategyReviewPanel` | Zero importers in `src/`; data via `/api/options/strategy-reviews` + `/decide` | Either render it (candidate: options research `strategy-panel` surface) or retire in place with successor `ScreeningReviewPanel` — after resolving the §3.6 name collision |
| Orphaned `ProviderConnectivityDashboard` | Zero importers; folded into `DataProvidersPanel` per that file's header | Retire in place with successor `DataProvidersPanel` (already the de-facto successor; the file just needs the marker) |
| Internal-by-design agents (NOT hidden — do not surface) | `Judge` (LLM-judge gate markers, #1763), `DID` (W3C DID system, audit/provenance), `BrowserAgent` (Cloudflare browser automation), `McpAgentToolAdapter`, pipeline executor (`pipeline:social-daily` etc.), `Model` (Workers AI flagship), `TickerAgent` (tape, already surfaced) | No UI. Judge/DID stay behind audit/provenance; pipeline stays behind scheduled goals |
| Scheduled jobs with partial surfacing | Stale-ledger sweep (`sweepStaleLedgerTasks`), hourly Strategy/Symbol Scanner, autonomous options runs (`options:last_runs`), async-job executor (`executeAsyncJob`) | Scanner + autonomous runs surfaced via `AutonomousOptionsRuns`; sweep + executor visible only via `AsyncJobsPanel`/`SchedulesPanel` — acceptable; link job rows to their schedule/goal id (§7) |
| Deprecated FOSS aliases (NOT hidden, NOT a problem) | `/foss/*` mirrors `/market-data/*` per `src/agents/routes/alpaca.ts` (#1906) | Keep for compatibility; do not surface, do not remove |

## 7. Merge / retire / keep proposal (successors named; retire in place, no deletions)

| Action | Surface(s) | Successor / home | Rationale |
|---|---|---|---|
| RETIRE in place (deprecation marker, keep file) | `ProviderConnectivityDashboard.tsx` | `DataProvidersPanel` (admin `data-providers` section) | Zero importers; already folded |
| RETIRE in place OR render (decision needed) | `MemoryBrowser.tsx` | `SearchHub` (memory tab) if rendered; else retire with successor `SearchHub` | Zero importers; search-adjacent capability |
| RETIRE in place OR render (decision needed) | `StrategyReviewPanel.tsx` | `ScreeningReviewPanel` if retired (after §3.6 rename); `strategy-panel` surface if rendered | Zero importers; reviewer capability with no door |
| MERGE (one library, one detail) | `ReportsPanel` + `DocsAndReportsPanel` | `ReportsPanel` as the library; `DocsAndReportsPanel`'s docs index stays, its run-detail drawer folds into `ReportsPanel` detail | §3.2: same sources, different detail endpoints |
| MERGE (canonical runs home) | `AsyncJobsPanel` (already in admin `background-tasks`) becomes the runs home; `WorkflowRunsPanel`, `DiscoveryRunsPanel`, `ResearchRunsPanel`, `AutonomousOptionsRuns` keep domain detail but link ids to the home | Admin runs domain (`?tab=platform-admin&view=background-tasks`) | §3.1: eight run lists; one home, domain detail preserved |
| MERGE (outcome views) | `ScreeningOutcomesPanel` + `ScreeningActivityPanel` + `CalibrationDashboard` + `ResearchTrackRecord` | `track-record` tab as the quality home; activity stays as the live feed inside it | §3.3: one quality domain, four views |
| KEEP, link together | `SchedulesPanel`, `ScheduledGoalsPanel`, `AsyncJobsPanel` | Keep all three; add id links goal → jobs, schedule → jobs | §3.7: distinct control planes, missing cross-links |
| KEEP | All dashboards (calibration, enrichment), `McpApiExplorer`, `MarketDataResearchHub`, options research family, `ScannerPanel`, `IvHistoryPanel`, `GoalScreenPanel`, `SchedulesPanel`, `IaaaAdminPanel`, `AgentsPanel`, `ApprovalsPanel` composition, `SearchHub`, `EndpointsTab` | — | Distinct audiences/purposes; no merge case |
| KEEP (channel, not page) | Slack agent, email agent, DLQ replay (once surfaced), premium endpoints | Runs home (§4c) | Delivery/ops channels render the same record |
| ADD (small, no new page) | DLQ view in admin runs domain; knowledge-file section in `SearchHub`; PDF/XLSX export buttons if unwired | Admin runs domain; `SearchHub`; `DiscoveryRunsPanel`/`ReportsPanel` | §6 hidden items, surfaced inside existing homes |
| ADD (catalog module) | Outcome catalog (client-side, §4c rule 1) | New `src/client/outcomeCatalog.ts` (proposed name only) | The one-outcome principle has no code home today |

## 8. Open question: is the admin panel the IROS target architecture? — UNRESOLVED

- **What the evidence settles.** The issue's own addendum names the
  admin panel (#2173) audit + reports/runs domains plus
  unified-reports (#2289 P3) as the consolidating home. The admin
  panel today already embeds the runs home (`background-tasks` →
  `AsyncJobsPanel`) and the goals surface (`scheduled-goals`), and its
  `provenance` section covers DID/MCP/attestation/ledger. That makes
  the admin panel the *currently existing* consolidation point.
- **What is NOT settled.** Whether the admin panel **is** the IROS
  target architecture, or whether IROS is a separate reference the
  admin panel should converge toward. IROS items (#1603, #1604, #1623,
  #1629, #1632) are HELD and were not opened, read, or worked in this
  survey, so equivalence cannot be verified from the IROS side.
- **What is also missing.** No `unified-reports` surface exists in
  the codebase at the base commit (grep for `unified-reports` /
  `unifiedReports` / `UnifiedReports` across `src/` and `docs/`:
  zero hits; the only "unified" hits are the unrelated "unified
  ScreenerResultsView" #261 and a `/trading/options/unified`
  endpoint). #2289 P3 therefore names work that has not landed, not
  a surface to consolidate onto.
- **Recorded position: UNRESOLVED, with reason.** Do not assert the
  admin panel IS the IROS target. The survey's proposals use the admin
  panel as the *provisional* consolidated home because it is the only
  home that exists; if IROS later defines a different target, §7's
  successors should be re-pointed, not re-argued.

## 9. What could not be verified (gaps, not findings)

1. `OptionsFlowsHub` (`src/client/options/flows/`) endpoint set —
   not extracted; the flows surface is inventoried by host only.
2. `ScheduledGoalsPanel` endpoint set — the file makes no direct
   fetch calls; its data path runs through delegation/scheduled-goals
   modules not traced in this pass.
3. Slack/email receipt link-back: whether receipts carry a runs-home
   deep link could not be verified from the delivery modules alone
   (message templates live in agent prompts, not in the delivery code
   read here).
4. `AsyncJobsPanel` deep-link support: whether a job id can be
   deep-linked (`?tab=platform-admin&view=background-tasks&job=…`)
   is not established — §4c rule 2 depends on it.
5. `SearchHub` PageShell adoption — the hub has its own shell; whether
   it uses the `PageShell` primitive was not checked.
6. Report export PDF/XLSX wiring in the UI (CSV is wired via
   `runExport`); server strings exist for all three formats.
7. `ScreenersHub` planned-asset tabs (forex/futures/commodities/
   bonds) render placeholder content only (verified in code) — the
   Planned menu (flag `planned_asset_tabs`, default-ON, #2783) is the
   live door to the same placeholders.
8. Client endpoint census: 286 distinct `/api/…` strings under
   `src/client/`; server-side string census: 176. The diff was
   hand-vetted because template-placeholder syntax (`${…}` vs `{…}`)
   and comment/doc strings produce false positives; §6 lists only
   hand-verified items.

## 10. Suggested next step for the parent (not taken by this draft)

Publish this draft as a comment or body update on #2380 for Ceos's
review (survey-only; no code, no IROS work). Decisions needed from the
reviewer before any implementation issue is filed: (a) render vs
retire for `MemoryBrowser` and `StrategyReviewPanel`; (b) confirm the
admin panel as provisional runs home (§8 stays UNRESOLVED until IROS
unholds); (c) ratify §4c rendering rules, especially the
outcome-catalog module and the Toast-vs-Notice line for action
confirmations.
