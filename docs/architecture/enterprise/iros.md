# Consolidated record — 2026-10-26 early-morning updates

One repo doc holding the updates shared across the 2026-10-26 early-morning
thread: the one-document issue/PR model, the day-trader Track 1 screens, and
the B7 catalog products section.

## How this doc is maintained

This doc **summarizes**; it does not replace the records it points at. Under
the one-document model (#1647), the single source of truth for each change
remains its owning issue's §15 completion report. Future updates append to
this doc through their own issues and PRs; a summary here never overrules
the owning issue.

## 1. One-document issue/PR model (#1647, closed)

One issue, one PR, one record. The issue holds everything; the PR body is a
pointer (summary + linked issue + checklist). The issue's §15 completion
report carries the full PR report (implementation, test evidence, change
management actuals, value and impact, risk, delivery, release, next-step
gate). Change management is required in every issue (expected field at
creation, actuals in §15).

What changed (PR #1648, merged as `b89bda9`):

- PR template thinned to summary, linked issue, full-report pointer,
  checklist.
- Issue template gains a `## User journey` field (after Outcome, before
  Scope), a Change management (expected) field, a Conformance field, an
  Agentic design field, and a consolidated §15.
- `docs/agents/gitops.md` §5/§9/§15 specs rewritten to match the live
  templates, closing pre-existing spec drift; §7 gains the One document,
  No drift, and Agentic design rules; the reuse-before-you-build pointer
  moved from the PR Implementation field to the issue completion report.
- This reversed the earlier PR-sections approach (PR Change management /
  Value sections): the requirement survived, relocated into the issue.

Conformance (per `docs/compliance`): no UX drift (primitive bypass — raw
HTML controls or inline styles instead of `src/client/components/ui/`,
raw colors outside `tokens.css`), no architecture drift (boundary bypass —
fat routers, direct SQL, schema duplication, PDP-seam bypass, parallel
implementations), no rework, no regression; reuse is mandatory.

Agentic design (per `docs/agents`): allocation is a decision, not a
default — the mandate forbids turning every service into an agent. An agent
is assigned only where judgment, uncertain planning, interpretation, or
dynamic tool selection earns its cost; deterministic rules (calculations,
risk limits, authorization, accounting, schema validation) stay in testable
code; evaluation is independent; the never-list is absolute (no permission
expansion, approval removal, spend raises, evaluation-criteria rewrites,
production config changes, deploys, unauthorized financial actions).

Verification: final head `8cb2c69`, 14/16 checks passed (2 cancelled Policy
Gate duplicates), all 3 required checks green, all 4 test shards green —
the old-head shard 2/4 failure was transient, not caused by this docs
change. Post-merge verification all Success: CI #2951, Deploy #1129 (QA 3/3
+ 1 expected A2A dispatch skip, tag `v0.1.588`), CodeQL #1738, Secret
Scanning #2409. #1647 closed with §15 gate PASS. Rollback: revert PR #1648.
Note: the "new issue and PR show the new shapes" acceptance criterion is
prospective — proven by the next issue/PR opened after merge.

## 2. Day-trader Track 1 — both screens (#1604)

Tracking: #1604 (Epic A sub-issue A1), in comments only — the body has no
day-trader mention. No separate Track 1 issue was filed; the owner directed
"do it for both" rather than filing.

The two screens:

- **Pre-market, weekdays ~8:30 ET:** overnight gaps, pre-market movers,
  breakout/momentum/reversal candidates for the day.
- **Intra-day, weekdays ~12:30 ET:** midday movers, morning breakout
  follow-through, intraday momentum/reversal candidates.

Machinery (verified on main): scheduled screens run and CAN deliver over
email (report attached), Slack, and webhook via `screenerFollowupDelivery`
(followup.deliver jobs, #1123) when the schedule payload asks
(`emailTo`, `slackChannel`, `pushToSlack`); reports are stored and served
via `scheduledReports` + R2.

Correction: the UX-creatable screen is the **market screen**
(`autonomousMarketScreen`), not the goal screen. No UI builds
`autonomousGoalScreen` schedules — the goal screen panel runs goal screens
manually on demand only. So the Track 1 screens, as creatable from the UI
today, are market screens. Goal screens specifically would need API-level
creation, not the current UX.

Env vars: the schedule inputs are NOT in env vars. Recipients
(`emailTo`/`slackChannel`) are per-schedule payload fields
(`EMAIL_TO_ALLOWED_DOMAINS` is only an allowlist, not recipients). Crons
are set at schedule creation (the strategy scan cron is a code constant,
`"35 * * * *"`; Worker crons cover only token renewal, ticks, and
retention). Identity is the saved execution context of the creating user
(`SERVICE_USER_LOGIN` `svc-background` is the service identity for
unattended service jobs, not the screen owner).

UX path: app → Screeners → Schedules panel → "+ New schedule" → Scheduled
Options Manager form → `POST /schedules/create` (session-gated, callback
allow-list). Form fields: job type market screen; universe (default
NASDAQ100) or symbols; max items; sector (default ALL); filters (min/max
price, min market cap, max P/E, trend/momentum) OR a stored preset id;
cadence (cron expression in ET, converted to UTC) or interval seconds;
notifications (Slack channel, email address, webhook URL). On success the
panel shows "Schedule created successfully! (ID: …)".

Unverified: whether stored presets named breakout/momentum/reversal exist
(the form supports a preset id generically — confirm at configuration,
otherwise custom filters apply); whether the delivered artifact carries
per-pick technicals or the thin 4-column shape (settled empirically by the
first verified fire).

Pending owner inputs: recipients, cron approval (8:30 + 12:30 ET
proposed), identity confirmation. Timing (Monday 2026-10-26): a pre-market
brief that day needed inputs before ~8:00 ET, else the first pre-market
run is Tuesday; intra-day can land the same day if configured by late
morning.

Next: create both schedules, verify the first fires (report recorded +
delivery received + content usable), record the evidence on #1604.

## 3. Products in the B7 catalog (#1645)

The B7 catalog document (patterns, runtime policies, tech stack, engines)
now also names every product to be built, in the same document:

- **A — options discovery** (to build).
- **B — stock scanner, the screener** (exists today in nascent form as the
  cfagent screener — universe providers, E*TRADE quotes, filters). The
  day-trader pre-market + intra-day scheduled briefs are a Product B
  offering (Track 1), not a fifth product.
- **C — research copilot** (to build).
- **D — institutional factory, reports for wealth managers** (the MVP;
  Release 1 scope defined by A1).

Each product carries its status, owning epic, and mapping to patterns,
stack, engines, and capabilities (capabilities per A2 #1601's capability
map — referenced, not duplicated). Gap rule: a product without an owning
issue is flagged, same rule as engines.

Boundaries: product choice itself stays owned by A1 (#1604); the catalog
records the list, it does not decide it. The catalog document itself is
written when B7 is built — the Products section today lives in #1645's
scope (issue body + comment).

## 4. Record map

- One-document model → #1647 (closed) + PR #1648 (merged `b89bda9`).
- Day-trader Track 1 screens → #1604 (open; comments `6410270072`,
  `6410349408`, `6410398209`; original Track 1 direction `6408915774`).
- B7 catalog scope, including products → #1645 (open).
- This doc → #1658.
- Standing records, unchanged here: #1595 (Epic A decisions), #1596
  (Epic B), and the IROS Google Doc (read-only evaluation source).
