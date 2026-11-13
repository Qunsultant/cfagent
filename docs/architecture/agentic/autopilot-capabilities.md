# Autopilot Capabilities — Measured Inventory

> **Status:** Measured on main `7d7a3f3` (2026-11-13). This document records what Autopilot
> actually does, surfaces, reads, and writes in the shipped code — not what it is planned
> to do. Every claim carries a file:line reference.
>
> **Owners:** OrchestratorAgent (state, evaluation, gating), RiskPolicyEngine (the policy
> envelope), AutopilotControlCenter (the page).
>
> **Related:** [`copilot-autopilot.md`](./copilot-autopilot.md) (aspirational — see
> §10 for where it diverges from this inventory), #4407 (provenance audit), #4408 (overlap),
> #4409 (sub-tabs), #4411 (monthly schedule), #4167 (nested shells), #4168 (job-outcomes
> deep link), #3273 (approvals provenance), #3275 (job-truth feed), #3121 (one-scheduler epic).

---

## 1. What Autopilot is

Autopilot is the **policy-evaluation and execution-gating layer** inside
`OrchestratorAgent`. It answers one question — *may this trade intent execute under the
written policy?* — and records the signed answer. It is **not** a trading loop, **not** a
scheduler, and **not** an order placer: it never places an order itself, never scans for
opportunities, and nothing runs it on a schedule (see §8).

The control surface is the Autopilot tab (`?tab=autopilot`), rendered by
`AutopilotControlCenter` inside the trading hub's single `PageShell`
([`src/client/components/AutopilotControlCenter.tsx`](../../../src/client/components/AutopilotControlCenter.tsx)).

---

## 2. Capabilities — the eight things Autopilot does

| # | Capability | Where | Trigger |
|---|-----------|-------|---------|
| 1 | **Evaluate a trade intent against the policy envelope** — runs the 8 RiskPolicyEngine rules in order, signs the verdict with a W3C DID attestation, records it in `mas_policy_verdicts`, writes an audit event, and tracks peak equity for later drawdown computation. | [`src/agents/orchestrator/autopilot.ts:162`](../../../src/agents/orchestrator/autopilot.ts) `evaluateAndRecordAutopilotVerdict` | "Run Policy Check" button (dry-run, see §3.1) or order execution (live, see §3.2) |
| 2 | **Gate order execution** — re-evaluates at execution time (orders/day, drawdown, and exposure may have moved since the draft was previewed). Blocks with a 409 when the verdict does not allow execution. On evaluation *failure* it refuses to execute only while Autopilot is running. | [`src/agents/routes/etradeBrokerAutopilot.ts:55`](../../../src/agents/routes/etradeBrokerAutopilot.ts) `evaluateAutopilotExecutionVerdict`, called from [`src/agents/routes/brokerOrders.ts:329`](../../../src/agents/routes/brokerOrders.ts) and [`src/agents/routes/etradeBroker.ts:507`](../../../src/agents/routes/etradeBroker.ts) | Execution of an approved draft |
| 3 | **Run / pause** — flips the `running` flag. Paused does **not** block evaluation: the `autopilot-paused` rule makes verdicts approval-required instead of allowed. Paused today means "new ideas route to approval", not "no new verdicts". | [`src/agents/routes/autopilot.ts:121`](../../../src/agents/routes/autopilot.ts) `POST /api/autopilot/state` | Page toggle (Resume/Pause) |
| 4 | **Kill switch** — emergency stop. The `kill-switch` rule is first in the envelope and blocks all new orders. Resume is refused while it is active. | [`src/agents/routes/autopilot.ts:138`](../../../src/agents/routes/autopilot.ts) `POST /api/autopilot/kill-switch` | Page button |
| 5 | **Policy limits** — max position %, cash reserve %, orders/day, drawdown alert %, universe, risk profile. Validated against `POLICY_LIMIT_BOUNDS`. Defaults: max position 10%, cash reserve 5%, orders/day 10, drawdown alert 20%, universe "Default large caps/ETFs", risk Moderate. | [`src/agents/routes/autopilot.ts:153`](../../../src/agents/routes/autopilot.ts) `POST/PUT /api/autopilot/limits`; [`src/services/riskPolicyEngine.ts:74`](../../../src/services/riskPolicyEngine.ts) | Limits form on the page |
| 6 | **Count orders today** — increments the date-scoped `ordersToday` counter (resets when `ordersDate` ≠ today, [`autopilot.ts:70`](../../../src/agents/orchestrator/autopilot.ts)). Feeds the orders-per-day rule. | [`src/agents/orchestrator/autopilot.ts:105`](../../../src/agents/orchestrator/autopilot.ts) `incrementAutopilotOrdersToday`, called at execution from [`src/agents/routes/etradeBrokerOrders.ts:260`](../../../src/agents/routes/etradeBrokerOrders.ts) | Order execution |
| 7 | **Broker balance snapshot** — best-effort balance fetch, used inside evaluation to build the account state (equity). Null when unavailable. | [`src/agents/orchestrator/autopilot.ts:111`](../../../src/agents/orchestrator/autopilot.ts) `fetchBrokerBalanceSnapshot` | Inside each evaluation |
| 8 | **Per-symbol exposure** — overlays the position notional a balance payload cannot express. | [`src/agents/orchestrator/autopilot.ts:139`](../../../src/agents/orchestrator/autopilot.ts) `openNotionalForSymbol` | Inside each evaluation |

---

## 3. The two evaluation entry points

### 3.1 Manual: "Run Policy Check" / "Trigger Policy Evaluation"

`POST /api/autopilot/evaluate` ([`src/agents/routes/autopilot.ts:165`](../../../src/agents/routes/autopilot.ts))
requires a symbol and a positive quantity plus the `x-user-login` header. It is
**dry-run by default** (`dryRun: body.dryRun !== false`). The page exposes it twice — the
"Run Policy Check" button in the actions section
([`AutopilotControlCenter.tsx:1197-1206`](../../../src/client/components/AutopilotControlCenter.tsx))
and the "Trigger Policy Evaluation" button in the empty state (`:1300-1312`).

Neither the endpoint nor the button checks the paused state: a paused Autopilot still
records verdicts when the button is clicked. (Follow-up, not in #4407: guard the endpoint
and disable the button while paused if "paused" is meant to mean frozen.)

### 3.2 Automatic: the execution-time gate

When an approved draft executes, the gate re-evaluates (§2 #2) and records a live
(`dryRun: false`) verdict. This is the only automatic writer of verdict rows. It runs
paused or not — the `running` check only matters when the evaluation itself fails.

---

## 4. The policy envelope

`evaluatePolicy` in [`src/services/riskPolicyEngine.ts`](../../../src/services/riskPolicyEngine.ts)
evaluates **eight rules in order; the first failing rule becomes `bindingRule`**:

1. `kill-switch` — emergency stop active.
2. `autopilot-paused` — Autopilot paused; verdict requires approval rather than allowing execution.
3. `insufficient-data` — no balance / account state to evaluate against.
4. `drawdown-alert` — equity below peak by more than the drawdown-alert limit.
5. `orders-per-day` — today's order budget exhausted.
6. `max-position` — the intent would exceed the max position % of equity.
7. `cash-reserve` — the intent would breach the cash-reserve floor.
8. `outside-universe` — symbol outside the configured universe.

The verdict carries `passed`, `executionAllowed`, `requiresApproval`, `bindingRule`,
`detail`, `limits`, `projections`, and `findings`. `evaluatedAt` is an ISO string
([`riskPolicyEngine.ts:304`](../../../src/services/riskPolicyEngine.ts)). The attestation
signs it with the session secret and records the authorizer DID — the Orchestrator's DID
when running, `did:user:pending-human-authorization` when paused
([`autopilot.ts:183-190`](../../../src/agents/orchestrator/autopilot.ts)).

---

## 5. What the page surfaces

The page renders seven sections
([`AutopilotControlCenter.tsx:802-1403`](../../../src/client/components/AutopilotControlCenter.tsx)):

| Section | Source | Live or not |
|---------|--------|-------------|
| Executive performance (4 KPI cards) | "Risk Policy Engine" card: live verdict count (see §9 — the `14` fallback is fake). NAV / P&L / Drawdown: **fake** — they read the hardcoded chart constant (see §9). Cash Reserve Target: live policy limits. | Mixed — see §9 |
| Strategy Equity vs S&P 500 Benchmark | **Fake** — `CHART_TF_DATA` (see §9). The description "Real-time mark-to-market performance" is false. | Fake |
| Autopilot Status | Live state via `GET /api/autopilot` (running, kill switch, limits) + localStorage mirror (`nextgen_autopilot_running`). | Live |
| Live policy limits | Live limits via `GET /api/autopilot`, editable; localStorage mirror (`nextgen_autopilot_limits`). | Live |
| Job outcomes | `mas_job_outcomes` via `GET /api/autopilot/jobs?limit=50` (max 200). One outcome sink for stock, options, goal-screen, discovery, corpus-sync, reports-index, and feed runs, manual and scheduled (#1333, #3275). | Live |
| Recent autonomous actions | `/api/audit?limit=50` (`mas_events`) + `/api/broker/orders` (`mas_trades`). The audit log records *everything*, so rows keep flowing while Autopilot is paused. Simulated rows are merged in from localStorage (`nextgen_autopilot_actions`) and labeled simulated. | Live + simulated (labeled) |
| Policy decisions (Verdict Audit Trail) | `mas_policy_verdicts`, newest 25, via `GET /api/autopilot` (served through the verdict port, #2359). | Live |

The page fetches on mount and on the global `app-refresh` broadcast; it does not poll.
The one addressable target is Job outcomes: `?tab=autopilot&view=job-outcomes` (#4168).
The inner controls (`actionsFilter`, `chartTimeframe`) are filters, not views, and get no URL.

---

## 6. What it reads

| Read | Endpoint / store | Used for |
|------|------------------|----------|
| Autopilot state + newest 25 verdicts | `GET /api/autopilot` → OrchestratorAgent Durable Object state (`autopilot_state_v1`) + `mas_policy_verdicts` via the verdict port | Status, limits, verdict table |
| Job outcomes | `GET /api/autopilot/jobs?limit=50` → `mas_job_outcomes` | Job outcomes section |
| Audit events + broker orders | `/api/audit?limit=50` (`mas_events`) + `/api/broker/orders` (`mas_trades`) | Autonomous actions section |
| Broker balance | `fetchBrokerBalanceSnapshot` (E*TRADE / Alpaca balance fetch) | Account state inside each evaluation |
| Per-symbol open notional | `openNotionalForSymbol` (open orders / positions) | Exposure overlay inside each evaluation |
| Stored limits (fallback) | localStorage `nextgen_autopilot_limits` | Limits display before the server answers |
| Stored actions (simulated) | localStorage `nextgen_autopilot_actions` | Simulated actions merged into the live feed |

State shape (`getAutopilotState`, [`autopilot.ts:70`](../../../src/agents/orchestrator/autopilot.ts)):
`running`, `killSwitch`, `killSwitchReason`, `limits`, `ordersToday` (date-scoped),
`ordersDate`, `peakEquity`, `updatedAt`.

---

## 7. What it writes

| Write | Store | Trigger |
|-------|-------|---------|
| Policy verdict (full row: id, session, symbol, action, quantity, notional, mode, dryRun, passed, executionAllowed, requiresApproval, bindingRule, detail, limits/projections/findings JSON, signature, key id, proposer + authorizer DIDs, `createdAt = evaluatedAt`) | `mas_policy_verdicts` (Durable Object SQLite, via the verdict port) | Every evaluation — button click or order execution, paused or not |
| Audit event `autopilot.policy_verdict` | `mas_events` | Every evaluation |
| Audit events `autopilot.state_changed`, `autopilot.kill_switch`, `autopilot.limits_updated`, `autopilot.policy_check_failed` | `mas_events` | State toggle, kill switch, limits save, failed evaluation |
| Autopilot state (`autopilot_state_v1`: running, kill switch, limits, ordersToday, peakEquity, updatedAt) | OrchestratorAgent Durable Object | State toggle, kill switch, limits save, each evaluation (peak equity), each execution (orders today) |
| Orders-today counter | State (date-scoped) | Order execution |
| Peak equity | State | Each evaluation, when equity exceeds the stored peak |

---

## 8. What it does NOT do

- **No schedule.** There is no Autopilot schedule in code — verified across all five
  census mechanisms in #3759: no entry in `DEFAULT_SCHEDULES`
  ([`src/schedule.ts`](../../../src/schedule.ts)); no Autopilot trigger in
  `wrangler.jsonc` (3 triggers only: token renewal `0 3`, tick `*/30`, retention `0 4`);
  no cron/interval/setInterval in
  [`src/agents/orchestrator/autopilot.ts`](../../../src/agents/orchestrator/autopilot.ts);
  no Autopilot operation in the [`src/orchestrate.ts`](../../../src/orchestrate.ts) catalog;
  no seeded `/api/schedules` row. Evaluations run only on demand (button) and at order
  placement. The monthly schedule is sub-issue #4411 under the one-scheduler epic #3121;
  which schedule it means is still an open question for Ceos (a stored row on the
  Schedules page, the daily research tick, or a new monthly evaluation schedule).
- **No autonomous order placement.** Autopilot never places an order. Orders come from
  human-approved drafts (order-ticket preview, legacy `/api/etrade/*`, chat propose-order,
  NLQ, MCP, Slack action, trading webhooks — no scheduled job creates drafts).
- **No scanning, discovery, or research.** Those are separate scheduled jobs (research
  tick, discovery, goal-screen, pipeline jobs) whose outcomes the page *displays*; they
  are not Autopilot's work.
- **No equity-history source.** There is no time series behind the chart — see §9.

---

## 9. Known gaps (owned by issues, not by this doc)

### 9.1 Fake data on the page (#4407 — build in progress, branch `fix/4407-autopilot-provenance`)

- **The chart is hardcoded fake data** — `CHART_TF_DATA`
  ([`AutopilotControlCenter.tsx:376-430`](../../../src/client/components/AutopilotControlCenter.tsx)):
  NAV literally `$142,850.00` for all six timeframes, hand-written P&L strings,
  hand-drawn SVG paths. The legend claims "Autopilot Strategy (+20.39% Alpha)" and
  "S&P 500 Benchmark (+8.40%)" as static text (`:906-917`); the S&P dashed path is
  hardcoded (`:886-893`). No job, schedule, or workflow creates it — it is a literal in
  the client bundle, rendered on every page load. #4407 removes it: every figure comes
  from a live source or the section renders its empty state.
- **`{verdictRows.length || 14} Verdicts`** (`:837`) shows **14** with zero verdicts.
- **"✓ 100% W3C DID Signed"** (`:839-841`) is a hardcoded claim, not a computed ratio.
- **Simulated rows are real rows, labeled simulated** — dry-run evaluated verdicts
  (`:777`), simulated actions kept in localStorage and merged into the live feed
  (`:547-549`), fabricated order refs
  (`FABRICATED_ORDER_REF_PREFIXES = ["et_ref_", "et_sim_", "alp_ref_", "alp_exec_"]`,
  `:160-171`). They must stay labeled simulated, never presented as live.

### 9.2 Timestamps — three formats on one page (#4407)

Verdicts render date + time (`toLocaleString`) with the raw stored `created_at` rendered
verbatim when unparseable — that is how two rows in one table differ. Autonomous actions
render time-only; job outcomes render short date + time. #4407 fixes it to one canonical
date + time format; unparseable values render as `—` and are logged, never raw.

### 9.3 Paused does not freeze verdicts (#4407 finding)

The evaluate endpoint has no `running` check, the button is not disabled when paused,
and the execution gate records a verdict on every execution, paused or not. If a *new*
verdict appears while paused with no manual run and no execution, something is calling
the endpoint — that is a live defect. The paused guard is a separate follow-up, not part
of #4407.

### 9.4 Overlap (#4408) and sub-tabs (#4409)

#4167 fixed the double h1, but the live page still overlaps (KPI labels over the "Live
policy limits" heading; the chart curve below the limits card). Static code does not
explain it — the layout is all primitives with no absolute positioning — so the fix needs
live reproduction plus a bounding-box composition test. #4409 (Ceos's directive) turns
each panel/section/card into a sub-tab, which is expected to subsume #4408.

---

## 10. Divergence from `copilot-autopilot.md`

[`copilot-autopilot.md`](./copilot-autopilot.md) describes a **"24/7 Autonomous Autopilot
Loop"** triggered by a "Durable Object scheduled alarm / cron tick", executing "around the
clock without human intervention", guarded by "6 hard rules". None of that matches the
measured code:

| `copilot-autopilot.md` claims | Measured on main |
|---|---|
| 24/7 autonomous loop, scheduled alarm / cron tick | No loop, no schedule — §8 |
| Executes around the clock without human intervention | Never places an order — §8 |
| 6 hard rules | 8 rules — §4 |
| Copilot autonomous mode executes immediately via the placement tool | That is the chat Copilot's mode, not Autopilot's; Autopilot only evaluates and gates |

The aspirational doc needs a correction pass against this inventory. That pass is a
follow-up issue — it is **not** done in this doc, which deliberately does not edit
`copilot-autopilot.md`.

---

## 11. Provenance quick reference — who writes each row

| Row on the page | Writer | Trigger |
|---|---|---|
| Verdict rows | `evaluateAndRecordAutopilotVerdict` | "Run Policy Check" button (dry-run) or order execution (live) |
| Autonomous-action rows | Every audit writer (`mas_events`) + broker orders (`mas_trades`); simulated rows from localStorage | Any audited activity, any order |
| Job-outcome rows | Every job producer (research tick, pipeline jobs, goals, discovery) into `mas_job_outcomes` | Scheduled or manual job completion |
| Chart / NAV / P&L / Drawdown | Nobody — hardcoded literals in the client | Every page load |
| "14 Verdicts", "100% W3C DID Signed" | Nobody — hardcoded literals in the client | Every page load |

---

## 12. Source files

- [`src/agents/orchestrator/autopilot.ts`](../../../src/agents/orchestrator/autopilot.ts) — state, evaluation, balance snapshot, exposure, counters.
- [`src/agents/routes/autopilot.ts`](../../../src/agents/routes/autopilot.ts) — the six endpoints: `GET /autopilot`, `GET /autopilot/jobs`, `POST /autopilot/state`, `POST /autopilot/kill-switch`, `POST|PUT /autopilot/limits`, `POST /autopilot/evaluate`.
- [`src/services/riskPolicyEngine.ts`](../../../src/services/riskPolicyEngine.ts) — the 8-rule envelope, bounds, attestation inputs.
- [`src/agents/routes/etradeBrokerAutopilot.ts`](../../../src/agents/routes/etradeBrokerAutopilot.ts) — the execution-time gate.
- [`src/client/components/AutopilotControlCenter.tsx`](../../../src/client/components/AutopilotControlCenter.tsx) — the page: 7 sections, filters, simulated rows, the fake chart.
- [`src/schedule.ts`](../../../src/schedule.ts), `wrangler.jsonc`, [`src/orchestrate.ts`](../../../src/orchestrate.ts) — the schedule census that shows Autopilot has no schedule.
