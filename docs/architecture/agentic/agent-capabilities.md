# Agent Capabilities — the single account

**This document is the one account of what the platform's agents can do:**
every invocation channel, every runtime capability, every tool, the
workflow layer, the dual-mode agentic loop, and the copilot capability
list — each with its mechanism and its truthful status.

It is linked from the Architecture and Design Document
([ADD](../ADD.md), Agentic Architecture section). ADD links and
duplicates nothing; this document is the capabilities member of that
set. Two machine-side accounts complement it and neither duplicates it:

- The **capability manifest** (issue #3489, epic #3488) — per-agent
  capability states, resolved from externalized configuration and
  surfaced in the agent registry. That is the runtime's own answer to
  "what can this agent do right now."
- The **tools inventory** (issue #3518) — every tool with its
  capabilities, the prompt the model sees, and its structured outputs,
  derived from the sources of truth. That is the tool-level account;
  this document is the capability-level account.

**Status vocabulary.** Every entry carries one: **Live** (built,
deployed, and exercised through its real surface), **Partial** (a real
part exists; the named remainder is filed), or **Filed** (a tracked
build issue exists; nothing is built yet). A filed item is never
described as built. Statuses are as of 2026-11-06; the tracking issue
beside each entry is where its current state lives.

**Governing principles** (owner doctrine, epic #3488 and issue #3514):

1. **Any copilot, any channel.** A copilot is an agent, invocable
   through any channel, and it must honor the surface that invokes it.
   A capability present on one surface and missing on another is a
   defect, filed as a sub-issue of the owning issue.
2. **The user decides, not the system.** What an agent does — which
   sessions it trades, which mode it runs, when it stops — is the
   user's choice, expressed through externalized configuration.
   Guards refuse only on safety invariants (selection mismatch,
   unapproved price, identity failure), never as unilateral policy,
   and a non-acting state is always a named, visible state.
3. **Both modes.** Every agent supports a deterministic mode (the
   fixed trajectory) and a non-deterministic mode (the agentic loop,
   §5). Neither replaces the other.
4. **No channel gets its own order path.** Trades and payments cross
   into execution only through the existing deterministic doors, with
   their approvals, from every channel and in both modes.
5. **Everything externalized (AOP).** Capabilities, modes, cadences,
   sessions, and limits are configuration, not code constants.

## 1. Invocation channels

A channel is a way to invoke an agent and receive its response. All
agents sit behind one port (`PortThink`); channels are properties of
the port, so a channel built once is a channel every agent has.

| Channel | Mechanism | Status |
|---|---|---|
| Chat | The Agents SDK chat surface on the Think turn; one chat shell for every copilot registration (issue #3454) | **Live** |
| Schedule | The SDK scheduler on the agent instance — the native surface; the Stock Copilot loop's original invocation | **Live** |
| Webhooks | `PortThink.fetch` ingress at `/webhooks/<source>`, HMAC-SHA256 over the raw body, fail-closed (503 unconfigured / 401 bad signature, body never parsed), events delivered to the agent's `onWebhook` hook; reactions broadcast via `setState` | **Live** at the port (issue #3474); production answers 503 until the operator sets the `THINK_WEBHOOK_SECRET` Worker secret |
| Slack | Slack channel ingress and tools on the orchestrator and the Slack agent | **Live**; unification across all agents is S5 under epic #3488 |
| MCP (as a door) | The platform MCP server (§4) — any MCP client invokes agent capabilities as tools | **Live** |
| A2A / agent-as-a-tool | Agents invoke agents through the mesh doors (Agent Mesh program #2225) | **Live** on a transitional shared token; per-surface secrets rollout is operator-deferred |
| Email | The SDK's email routing (`routeAgentEmail` → the agent's email handler) behind a port hook, plus a send binding | **Filed** — S2 #3490 (the Cloudflare Email Service routing rule is the operator step) |
| Voice | The SDK voice surface (`agents/voice`) behind the port | **Filed** — S3 under epic #3488 |

## 2. Runtime capabilities

Capabilities every agent class resolves through the manifest (#3489):
a capability's state is `enabled`, `disabled-by-config`,
`unavailable` (with a named reason), or `not-implemented` — resolved
from code posture and environment, and only ever *disabled* by
configuration, never faked on.

- **MCP client** — the agent connects to external MCP servers and
  calls their tools. Live on the orchestrator (issue #2496);
  port-level support for every agent is S4 under epic #3488. In
  non-deterministic mode this is how the agent calls MCP endpoints
  *by reasoning* (§5).
- **Scheduler** — schedules and interval work on the instance
  (`schedule` / `scheduleEvery`). **Live** fleet-wide.
- **State** — durable per-instance state with validated transitions
  and websocket broadcast on change (`setState`). **Live** fleet-wide.
- **Lifecycle** — lifecycle hooks and transition logging on every
  turn. The SDK substrate is present fleet-wide; uniform logging and
  surfacing is S6 under epic #3488. **Partial.**
- **WebSockets** — live state broadcast to connected clients; the
  chat panel consumes it (the settings-awareness chain, issues
  #3471–#3473, is its first copilot consumer). **Live.**
- **Observability** — every agent observes and emits its own
  behavior: turns, tool calls, refusals, lifecycle. Emission exists
  in parts (audit history, activity feeds); the uniform emission and
  surfacing contract is S15 #3499. **Partial.**

## 3. Tools

The tools an agent can wield, beyond its doors. (The per-tool account
— capabilities, prompts, structured outputs — is the tools inventory,
#3518.)

- **Workspace** — a per-agent filesystem (the Think workspace over
  durable storage; its tools merge into every turn). **Live** by
  construction on the pinned Think version; surfacing and
  configuration are S7 #3491.
- **Sandbox** — generate and run code on the fly: e.g. build a
  strategy or pattern from any source — a URL, a Google Doc — execute
  it in the sandbox, and bring the result back as a validated
  data-only artifact. **Unavailable today** (the container backend is
  not configured — an operator step), build filed as S8 #3492; its
  first consumer is strategies-from-URL, #3405.
- **Browser** — a browser agent that can sign in and act on the
  user's behalf. **Live** as its own agent; per-agent surfacing is
  S9 #3493.
- **Web fetch** — fetch and read web pages as a tool. **Live**
  (tracker A3, #2760); conformance across agents is S10 #3494.
- **Web search** — search the web as a tool. **Partial**: the tool
  exists (tracker A2, #2731) and fails loud until a provider key is
  configured; the provider decision (Brave vs SearXNG vs Cloudflare
  Web Search API) is the owner's, filed as #3501; conformance is
  S11 #3495.
- **AI Search (RAG)** — retrieval over indexed corpora — OCC, FINRA,
  platform docs — feeding the learning loop. The curated corpus is
  **Live** (#3375); report indexing runs at store time today, and
  indexing all reports as a journaled workflow stage, plus backfill,
  is S13 #3497. Agent *memory* deliberately does **not** use AI
  Search: memory needs a raw vector store with immediate, filtered,
  id-addressed recall, and stays on Vectorize (§5).
- **Payments** — agents can charge for commercialized services
  through the CBO payment gate (x402; price approval is the
  operator's act). **Live** as a gate; conformance across agents is
  S14 #3498.
- **The platform MCP server** — the platform's own MCP server exposes
  the platform's capabilities as tools to any MCP client (85 tools;
  issue #2503). Completeness — *every* capability reachable — is
  pinned by S12 #3496, which derives the expectation from the
  capability manifest rather than a second hand-maintained list.
  **Live; completeness Filed.**

## 4. Workflows

Agents act through two executors (see
[multi-turn-agentic-workflows](./multi-turn-agentic-workflows.md) —
one stage contract, two executors):

- **The turn** — the conversational/agent turn on the port:
  reasoning, tool calls, doors. Where chat, Slack, email, voice, and
  webhook invocations land.
- **Workflows** — `ThinkWorkflow` classes: multi-stage, journaled,
  resumable trajectories built from deterministic steps (`step.do`)
  with approval waits. Money and screening paths run here. A workflow
  stage's outcome is recorded on the record it processes (the
  per-report indexing outcomes, #2347, are the pattern), so a stage
  can be re-run, audited, and resumed — never silently lost.

**Scheduling** binds the two: a schedule fires a turn or a workflow
on an instance (production runs two system screen schedules hourly).
Cadence is configuration — the copilot's cadence externalization is
#3452 — and the platform's tick floor bounds how fine a configured
cadence can be; surfaces report the *effective* cadence.

## 5. The agentic loop — both modes, completely

Every agent supports two modes of operation. The mode is the user's
selection: a standing externalized setting and a per-invocation
choice on any channel.

### 5.1 Deterministic mode — the fixed trajectory

The agent calls the fixed trajectory: the workflow stages, doors, and
cycles exactly as built and tested. Same input, same path. This is
the mode money and screening run in today, and it remains fully
supported and unchanged by the existence of the other mode.

### 5.2 Non-deterministic mode — perceive, plan, execute, reflect, learn

The agent runs an agentic loop (the patterns named in ADD's Standards
Conformance: **ReAct, Reflection, Self-correction, Learning**):

1. **Perceive.** The agent assembles its situation from its tools and
   surfaces: environment state, its own records and results, the
   user's configuration, and — at loop start — its **memory**:
   distilled learnings from prior loops, retrieved by relevance.
   For a document question it perceives through AI Search (RAG over
   the OCC / FINRA / docs corpora, §3); for its own history it
   perceives through its activity and audit records.
2. **Plan.** A model reasons over the goal, the perceived state, the
   memory, and the available tools, and produces a plan: a sequence
   of intended tool calls and expected outcomes. Choosing a tool —
   including an **MCP endpoint**, the agent's own or an external
   server's — is a reasoning act, not a routing table: the planner
   sees the tools' descriptions and structured-output contracts (the
   account #3518 produces) and selects among them.
3. **Execute.** The plan's steps run through the same doors, tools,
   and guards as a deterministic invocation — same identity
   discipline (execution context, fail-closed), same approvals. A
   step's result returns to the loop; the plan may adapt. Execution
   is bounded by externalized limits (max steps, budget, timeout);
   exhausting a bound is a named refusal, never a hang.
4. **Reflect — the critic.** The loop's outputs are evaluated by a
   **critic**: a distinct evaluation pass (Reflection /
   Self-correction) that scores what was produced against the goal
   and the platform's constraints and returns a verdict — accept,
   revise (with reasons, feeding another plan step), or reject (with
   reasons). The critic executes no side effects itself. Every
   verdict is recorded, so a non-deterministic run is fully
   inspectable after the fact through the observability surface (§2).
5. **Learn.** Verdicts and outcome deltas are distilled into
   learnings — what worked, what failed, what the critic rejected and
   why — and written to the agent's **memory**: the Vectorize-backed
   memory layer, per-instance and tenancy-scoped like all agent
   state, read back at perceive time in future loops. Learnings are
   themselves queryable through every channel ("what have you
   learned?"). Learning never silently alters the deterministic
   trajectory: a learning can inform future planning, and can be
   *proposed* to the user as a configuration or strategy change the
   user applies through the ordinary surfaces — the user decides.

### 5.3 The crossing discipline

Where non-deterministic output would cross into deterministic
execution — an order, a payment, a stored configuration — it crosses
**only as a validated data-only artifact**: a structured intent
checked against the deterministic contracts (risk, sizing, selection
conformance, approvals) before anything executes. Raw model output
never reaches an order. Replay and re-execution of a recorded run
never re-call the model — the recorded artifact is what replays.
This is the platform's existing sanctioned pattern for
non-determinism (the dual-mode screener, #2530: per-run selectable,
validated criteria artifact, flag default OFF) generalized to every
agent by S17 #3517. Guards are identical in both modes; a mode change
never widens authority.

## 6. The copilot capability list

The Stock Copilot (build #3391) is the reference instantiation of
this standard: one copilot, every capability below, invocable through
**every channel in §1** and in **both modes in §5**. Its channel
uniformity is tracked by #3514; its dual-mode instantiation by #3519.

### Interrogate

- **Status now** — broker and mode, enabled sessions, pause state,
  flag state, current cycle state. Live on the panel and the status
  route (#3422); selectable changes announce themselves through the
  settings-awareness chain (#3471–#3473) instead of being discovered
  by polling; the chat door is #3513.
- **Results** — open positions with their exit plans, cycle activity
  (traded / no-trade / refused / inactive / outside-sessions /
  selection-changed, each with its reason), refusal reasons in plain
  terms, and performance (the ledger lands with #3397).

### Configure — the user's decisions, settable from any surface

- **Schedule / cadence** — when the loop runs (#3452 externalizes
  it).
- **Sessions** — which trading sessions the loop may trade: pre-market,
  regular, after-hours, EXTO overnight — or none (#3398; the platform
  wire for session orders is #3508).
- **Universe** — which symbols it watches.
- **Broker / mode** — the trading selection itself (one broker, one
  mode — paper or live — active; #3451), defaulting to Alpaca in
  Paper mode when nothing is selected.
- **Pause / resume / stop** — per instance, effective immediately,
  visible everywhere.

### Direct

- **Apply and switch patterns and strategies** — including strategies
  built from a URL or a document, generated and validated in the
  sandbox (§3) and applied as validated artifacts (#3405).
- **Evaluate without trading** — run a stock against the active
  strategies and report the verdict; no order exists.
- **Risk analysis on demand** — portfolio risk, CVaR, and position
  sizing computed interactively (the platform's risk components,
  #34 / #36 / #1361), not only inside the cycle.

### Trade

- **The pattern trading loop** — in deterministic mode, the fixed
  trajectory: signals → risk → sizing → order → paired exit plan, on
  the selected broker and mode, inside the enabled sessions. In
  non-deterministic mode, the same capabilities driven by the §5.2
  loop — perceiving, planning, executing through the same doors,
  critic-checked, learning into memory (#3519).
- **Interactive trade requests** — only through the existing
  deterministic doors with their approvals, from any channel. No
  channel gets its own order path (§0, principle 4).

### Report

- **Why-explanations** — why a cycle traded, refused, or waited, in
  the terms of the surface that asks.
- **Cycle and performance reports** — shaped for the surface: chat
  answers in conversation, voice speaks summaries, email threads,
  webhooks receive signed records, the schedule surface files them
  with the run.

## 7. Configuration and operator steps

Everything in this document that can vary is externalized
configuration (AOP, #2419): capability disablement (manifest,
#3489), modes (§5), cadences, sessions, universes, loop bounds. Two
classes of step remain the operator's, by design, and are named
wherever they gate a capability: **secrets** (e.g.
`THINK_WEBHOOK_SECRET` for the webhook channel;
`BRAVE_SEARCH_API_KEY` pending the provider decision #3501) and
**approvals** (catalogue price approval for payments; the
non-deterministic screener flag flip is CISO-gated).

## 8. Tracking map

- **Epic #3488** — the Uniform Copilot Capability Standard: S1 #3489
  (manifest, landed), S2 #3490 (email), S3 (voice), S4 (MCP client on
  the port), S5 (Slack), S6 (lifecycle), S7 #3491 (workspace), S8
  #3492 (sandbox), S9 #3493 (browser), S10 #3494 (web fetch), S11
  #3495 (web search), S12 #3496 (MCP server completeness), S13 #3497
  (AI Search RAG), S14 #3498 (payments), S15 #3499 (observability),
  S16 #3500 (AGNTCY, low priority), S17 #3517 (non-deterministic
  mode), S18 #3518 (tools inventory), and this document, #3520.
- **The Stock Copilot** — build #3391 and its sub-issues: surface
  #3422, mode selection #3451, cadence #3452, sessions #3398 (+ wire
  #3508), ledger #3397, equity bundle #3402, URL strategies #3405,
  awareness #3470–#3473, channel uniformity #3514 (chat door #3513),
  dual-mode operation #3519.
- **Foundations** — the Agent Mesh program #2225 (doors), the port
  webhook slice #3474, the dual-mode screener #2530 (the crossing
  precedent), the mesh improvement program #2494 (MCP server #2503,
  MCP client #2496, durable turns).

*Filed as issue #3520 under epic #3488. #CAIO-quns*
