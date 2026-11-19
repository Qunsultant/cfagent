# Social delivery: channels, capabilities, manual vs automated — and scheduled pipelines

Issue #1077 (social posting) and the staged-scheduling capability that
layers over it. This doc states what is true on main today, what is
designed but not built, and what is deliberately not claimed. Content
is never invented: post text comes only from a human- or
NLQ-supplied brief, never from the agent.

## 1. Channels, capabilities, and delivery manner

### 1.1 Public social channels (posting)

Config: `SOCIAL_POSTING_ENABLED` (default OFF — the kill switch),
`SOCIAL_AUTONOMOUS_CHANNELS` (default `threads,x`),
`SOCIAL_APPROVAL_CHANNELS` (default `facebook,instagram,linkedin`).
The split is configurable, not hardcoded. Fail-closed rules:
a channel in both lists → approval wins; unknown channel →
approval; known channel in neither list → approval; empty
autonomous list → everything needs approval; a channel with no
token is never posted, regardless of list. Live posting additionally
requires `SOCIAL_LIVE_PUBLISHING` and an injected live transport;
production today has no live transport, so a live request fails
honestly with `no transport provided for live publish` — it is
never silently downgraded to a dry run. Without live, publishing
goes to the dry-run sink (status `dry-run-posted`, never `posted`).

| Channel | Capability | Automated | Manual |
| --- | --- | --- | --- |
| Threads | Public post (2-step publish via `graph.threads.net`) | Goal firing → draft build → publish, once enabled, tokened, and live | Brief supply; token setup; channel-list config |
| X | Public post (`api.twitter.com/2/tweets`) | Same as Threads | Same as Threads. Note: the X token-health endpoint is UNCONFIRMED (no probe is ever made for X) |
| Facebook Page | Page feed post (`graph.facebook.com/v21.0/me/feed`; must be a Page token) | Draft build + Slack approval-card delivery + catch-up sweep | Slack approve/reject → publish-on-approve; token setup |
| Instagram | Post (2-step publish) | Same as Facebook | Same as Facebook |
| LinkedIn | Post (`api.linkedin.com/v2/ugcPosts`; requires `LINKEDIN_AUTHOR_URN`, fails closed without it) | Same as Facebook | Same as Facebook |

Draft lifecycle: `draft` → `approved` → `posted` / `failed`,
plus `dry-run-posted` (dry-run only; a live sweep does NOT skip
these, so flipping live mid-day still publishes that day's
drafts). Approval standing survives a dry-run publish; rejecting
a dry-run-posted draft marks it `failed` so it never live-publishes.
One draft per date+channel, never duplicated. Unknown configured
channels produce an error entry, never a draft.

### 1.2 Slack — the approval channel (not a public posting channel)

- Automated: approval-card delivery for approval-channel drafts
  (webhook first, else bot token `chat.postMessage`; the cfpay
  `slack.post` A2A path is deliberately NOT used — text only,
  no blocks), publish-on-approve through the existing publish
  path, and the 7-prior-date catch-up sweep.
- Manual: the human approve/reject decision on the card
  (approver recorded as `slack:<userId>`; stale cards refused).
  Publish failure on approve leaves the draft `approved` with
  the error recorded; posting-disabled refuses approval outright.
- Slack delivery is idempotent via `PendingApproval.deliveredDraftId`:
  re-recording a draft never wipes the delivery mark, so a
  catch-up sweep never re-delivers a card.

### 1.3 Email — not a social delivery channel

Email delivery exists (cfpay A2A `email.send`, proven for research
delivery) but no social draft is ever delivered by email. Any
future email digest is a separate #1076 item (welcome/digest
gated on a verified contact address), not a social channel.

### 1.4 Dashboard / API — the serve surface (manual)

- Schedule goals, ticks, enable/disable, and manual goal trigger
  via `/api/schedule/*` (session-gated since #1156; any signed-in
  user, no admin gate invented).
- Brief supply and review: `POST/GET /api/social/brief`
  (session-gated).
- Approval review: `POST /api/social/approval`,
  `GET /api/social/approvals` (session-gated).
- Token presence check: `GET /api/social/token-health`
  (session-gated, presence only; validity only via an injected
  transport — production reports `unknown` by design, and the
  goal executor does NOT call it, so there is no automated
  token-health sweep today).
- IAAA admin panel (platform-admin-gated): memberships, genesis,
  audit, and the API/MCP tabs live inside it — the same gate
  hides them all.

### 1.5 NLQ — brief intake (manual, human-authored)

- Webchat NLQ with an explicit set phrase (`set … social brief …
  to/as/:`, `use … as/:` variants) writes the brief. Deliberate
  non-match: "Use the social brief to explain X" does not set it.
- Webhook NLQ withholds the brief port (`x-nlq-source: webhook`)
  — untrusted external content never writes briefs. DECIDED
  2026-10-23 (owner): keep Slack NLQ untrusted for social brief
  writes — Slack NLQ never writes briefs.

### 1.6 What is automated today, in one list

Cron firing (`isDue`), PaymentsAgent budget check, brief read,
draft build, autonomous publish, Slack card delivery,
publish-on-approve, 7-day catch-up, dry-run sink. What is manual
today: brief supply, goal enable/trigger, approve/reject, token
setup and rotation, panel review, token-health checks.

## 2. The pipeline stages: feed / generate / store / serve / deliver

As built today, the social flow is one scheduled goal
(`daily-social-post`, cron `0 9 * * 1-5`, `America/New_York`,
shipped DISABLED, `social.publish`, budget cap 1 cent) whose
executor runs, in order: read the firing date's brief → build
one draft per enabled channel → publish due drafts (autonomous
immediately, approval-gated otherwise) → catch-up sweep. Store
and serve are not timed stages in that flow — they are layers:

- **Feed** — content intake. Today: the brief store only
  (human via `POST /api/social/brief`, NLQ explicit-set via
  webchat). No brief → early return, no drafts, full stop.
  The design intent "content from daily research/screener
  digest" is NOT wired: no digest-to-brief code exists. An
  automated digest feed is a separate content decision (which
  sources, whose voice, owner sign-off) and must never invent
  post text.
- **Generate** — `buildDailyDrafts`: one draft per enabled
  channel from the brief, per-channel formatting limits,
  stored idempotently (one draft per date+channel).
- **Store** — the durable seam between every stage:
  brief store (`social-brief:<date>`, 4000 chars), draft
  store, post ledger + idempotency, approval records — all
  SessionStore-backed via get/put/delete only.
- **Serve** — the always-on surface over those stores: the
  routes and dashboard in §1.4. Serving is continuous, not a
  timed stage; a pipeline stage never "serves" as its job.
- **Deliver** — Slack approval cards + platform publish
  (§1.1–1.2), plus the catch-up sweep.

## 3. Can scheduling be layered over the stages? Answer: half yes

### 3.1 What already exists: staging inside one job

Orchestrator jobs are multi-step workflows: each step has an
`id`, `agent`, `operation`, and `dependsOn` — a step runs only
when its dependencies are done, and independent steps run in
parallel. So a single scheduled goal CAN run a staged pipeline
if its operation is a multi-step orchestrator job. That is the
staging primitive, and it already works.

### 3.2 What does not exist: chaining between scheduled goals

ScheduledAgent goals are single-operation and independently
cron-fired: one goal → one operation → one job (or the social
goal executor for `social.publish`). There is no goal-to-goal
chaining — no `runAfter`, no `dependsOn` on goals, no
"when goal X completes, run goal Y". The only sequencing
between goals today is wall-clock (different cron times) or a
manual `triggerGoal` via the dashboard API. So "scheduled feed,
and when that completes scheduled generation, then scheduled
storage, then scheduled serving, then scheduled delivery" as
separate scheduled goals is NOT supported today.

### 3.3 The enabled design: pipeline goals (not goal chaining)

Goal chaining across ticks is rejected: it spreads one pipeline
over many goals and ticks (with */30 cron granularity, each hop
waits for the next tick), fragments budget accounting, and
scatters failure attribution. The enabled design is a **pipeline
goal**: one scheduled goal whose executor runs ordered stages
back-to-back in a single firing, reusing the orchestrator's
step semantics:

- A goal whose operation names a pipeline (e.g.
  `pipeline:social-daily`) runs through a pipeline executor,
  not the single-operation path.
- Stages are catalog operations in order. For social:
  `social.feed` → `social.generate` → `social.deliver`.
  Store is the durable seam each stage reads/writes (plus a
  pipeline-run ledger: stage → completed/skipped/failed, so a
  re-fire resumes at the first incomplete stage instead of
  redoing work). Serve stays the always-on surface in §1.4,
  not a stage.
- Stage failure stops the pipeline: later stages never run on
  a failed earlier stage ("when that completes" means success).
  A skipped stage (notably feed with no brief → `noBrief`)
  ends the run as skipped, not failed, and never invents
  content to fill the gap.
- One budget check covers the whole pipeline; one tick entry
  records it. Manual `triggerGoal` runs the pipeline the same
  way as a cron firing. All existing gates are unchanged
  inside the deliver stage: posting kill switch, live flag,
  token presence, approval standing, dry-run semantics.
- Feed stage v1 reads the firing date's brief from the brief
  store (human/NLQ-supplied). Automated digest feed is a later
  stage implementation behind its own content-source decision,
  not part of the pipeline-goal build.

Implementation issue: #1224 (pipeline goals; linked from
#1077). It must be TDD-first, must not change single-operation
goal behavior, and must keep the social executor's gates
byte-identical in the deliver stage.

## 4. Alignment with the agent card

Fetched from `https://agent.openaimp.com/.well-known/agent-card.json`
(2026-10-23). The card lists six A2A agents. How this solution
aligns with and leverages each:

| Agent (card capabilities) | How the solution uses it today | Leverage / gap |
| --- | --- | --- |
| orchestrator (planning, supervision, parallel-execution; ops `search.query`, `payments.draft`, `tasks.create`, `memory.remember`, `nlq.execute`) | ScheduledAgent creates orchestrator jobs for due goals; orchestrator step `dependsOn` is the staging primitive §3.1 reuses | Pipeline executor mirrors this step model for scheduled pipelines |
| search (web-search, opportunity-hunt; `search.query`, `search.opportunity_hunt`) | Feed research: the `opportunity-hunt` goal is scheduled daily 07:00 and executes its hunt at firing (#3652, `src/services/opportunityHunt.ts`) | Digest content source for social feed (§2) — design intent, not wired |
| payments (payment-draft, payment-process, budget-check; `payments.draft`) | Every scheduled goal is budget-gated via PaymentsAgent `budgetCheck` before work; social posting spends nothing (1-cent cap, not a charge) | Pay-per-use tiers (x402/USDC) are the #1076 model, separate from posting |
| tasks (task-create, task-list, task-update; `tasks.create`) | Not used by the social pipeline today | Proposed: record pipeline stage runs as tasks so stage completion is trackable through the card |
| memory (remember, recall; `memory.remember`) | Not used by the social pipeline today (durable stores instead) | Proposed: recall past briefs/drafts through the memory agent |
| trading (stock/options screening, approval-gated trading; `trading.screen_*`, `trading.trade_*`) | Screener is the intended digest feed source; its approval-gated trading pattern is the model social HITL approval mirrors | Screener digest → brief wiring is the open feed decision (§2) |

Honest boundaries, not claims:

- ScheduledAgent, social publishing, token-health, and the
  IAAA panel are NOT on the A2A card. They are internal
  capabilities, reached via the dashboard API and the operation
  catalog — not via A2A. The card's `social.publish` absence is
  real: `social.publish` is an internal operation, not an A2A
  operation.
- Inbound A2A dispatch requires `A2A_API_TOKEN`, which is not
  configured in production — so no external agent can drive
  this pipeline via A2A today. That is an owner decision
  (#1097), not something to assume.
- Nothing on the card posts to a public social channel. The
  card's agents feed, gate, track, and remember around the
  pipeline; the public delivery itself is the internal social
  publisher, behind the HITL and fail-closed rules in §1.

## 5. Status (as of writing)

- Channels, gates, dry-run/live semantics, Slack delivery,
  catch-up, token-health route: built and merged (Phases 4–5b,
  slices 1–3, #1156, #1160, #1171).
- Live activation: blocked on owner inputs (platform tokens,
  accounts/pages, voice, posting time/weekdays) and a live
  transport. Default without them: no live post.
- Pipeline goals (staged scheduling): designed in §3.3,
  implementation tracked in its own issue linked from #1077.
- Automated digest feed: open content decision (§2), not built.
- Webhook NLQ trust for brief writes: DECIDED 2026-10-23 (owner):
  keep untrusted.
