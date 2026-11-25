# Architecture and Design Document (ADD)

**Container document only.** This file holds the section structure and
links to the individual architecture docs. It duplicates nothing — it
links. Each section below links to its individual doc, or states it as
pending with its owning issue. Delivery rules live in
[gitops](../agents/gitops.md); user journeys live in
[ux-architecture](../UX/ux-architecture.md).

**Technology, cloud, and vendor agnostic.** No section of this
document prescribes a specific vendor, cloud, or framework as the
architecture. Where a linked doc names a specific technology, it is
one deployment option behind a port/adapter seam — never the
architecture itself. Decisions are recorded as portable principles
(ports/adapters, one security model, one implementation per rule); a
named product is a compliant implementation of a principle,
replaceable without rewriting the architecture. The packaging
decision is in [Packaging and deployment](#packaging-and-deployment).

## UX architecture

- [UX architecture](../UX/ux-architecture.md) — user journeys,
  components, and the token architecture (CPO lane).
- Related assessments: [assessment-01](../archive/assessment-01.md),
  [design-system-01](../archive/design-system-01.md),
  [exceptions-01](../archive/exceptions-01.md).

## Application architecture

- [Screener](./application/screener.md) and
  [API / MCP](./application/api-mcp.md) (CPO lane).
- A consolidated `application.md` is pending as follow-up under this
  parent issue (#1449); until it lands, the two docs above are the
  application architecture of record.

## Agentic architecture

- [Agentic Target Architecture](../agents/agentic-architecture.md)
  (CAIO lane, issue #576, tracked by #571, both closed) — the agentic
  target architecture of record: re-baselined runtime, Phase 2 slice,
  gate record.
- Related material in [agentic/](./agentic/):
  [doors-and-layers](./agentic/doors-and-layers.md) (invocation model —
  channels, turns, doors, agents — Agent Mesh program #2225, landed via
  #2256),
  [agents-sdk-conformance-matrix](./agentic/agents-sdk-conformance-matrix.md)
  (fleet conformance, goal G7 round 1, landed via #2339),
  [think-or-DO](./agentic/think-or-DO.md) (Think vs DO, placed for
  #1926),
  [multi-turn-agentic-workflows](./agentic/multi-turn-agentic-workflows.md)
  (one stage contract, two executors; design note for #3069 R9),
  [agents-workflows-schedules-queues-platforms-lifecycle](./agentic/agents-workflows-schedules-queues-platforms-lifecycle.md)
  (the target architecture for agents, workflows, schedules,
  queues, platforms and lifecycle, and its current state; the
  2026-11-09 discussion recorded on #3842, doc filed as #3844),
  [agent-as-a-service](./agentic/agent-as-a-service.md),
  [social-delivery-and-scheduled-pipelines](./agentic/social-delivery-and-scheduled-pipelines.md)
  (social posting #1077 and staged scheduling).
- [agent-capabilities](./agentic/agent-capabilities.md) — the single
  account of agent capabilities: invocation channels, runtime
  capabilities, tools, workflows, the dual-mode agentic loop
  (deterministic and non-deterministic), and the copilot capability
  list, each with its status and tracking issue (#3520).
- Open program: Agentic UX (#3082, CPO lane) — the UI surface layer
  (AG-UI, A2UI, A2A, UCP, ACP-commerce), evaluated under #3142. A
  consolidated agentic-UX doc lands under #3082.
- AI-agent orchestration with guardrails.
- OWASP Top 10 for LLMs
- Responsible AI Frameworks (NIST AI RMF)

## Integration architecture

- **Pending — no owner established.** Integration architecture stays on
  this parent issue (#1449) until a lane claims it; no owner is
  assigned by guess.
- Related assessment: [assessment-01](./integration/assessment-01.md).

## Data architecture

- **Pending — owning issue #1451 (CDO lane).** The consolidated
  `data.md` lands under #1451.
- Related assessment: [assessment-01](./data/assessment/assessment-01.md).

## Security architecture

- **Pending consolidated doc — owning issue #1450 (CISO lane).** The
  consolidated `security.md` lands under #1450.
- Related material already on main (links, not the consolidated doc):
  [zero-trust](./security/zero-trust.md),
  [authn](./security/authn.md), [authz](./security/authz.md),
  [api-security](./security/api-security.md), and the remaining docs
  under [security/](./security/) (session store, secrets inventory,
  workflow security, IAAA assurance).

## Infrastructure architecture

- [Infrastructure](./infrastructure/infrastructure.md) (CTO lane,
  issue #1453, closed).
- Related assessment: [assessment-01](./infrastructure/assessment-01.md).

## Packaging and deployment

- The solution is packaged as containers, one per architectural
  layer, and runs on Cloudflare Workers AND in Docker (multi-cloud,
  cloud-agnostic). No new Cloudflare-proprietary API surface is
  introduced in the new layer; the store behind a port is what makes
  the Docker shape possible.
- Layers and their code homes: services (`src/services/`), API
  (`src/server/routes/` + `src/agents/routes/`), MCPs (`src/mcps/`),
  frontend (`src/client/`, React), backend (`src/server/` + the Worker
  entry `src/server.ts`), middleware (the IAAA/Hono middleware chain
  — there is no middleware directory; the layer is the chain, not a
  folder), data layer (`src/data/`, ports/adapters).
- Decisions: [ADR 0034](./adr/0034-cbo-api-layer.md) (CBO lane, #5343),
  D11 portability rule — per-piece verdicts (Hono, zod, jose,
  chanfana, Drizzle, MCP SDK compliant; API Shield optional edge
  adapter only; `@cloudflare/workers-oauth-provider` out for the
  shared-server role). One API server (#5387) and one MCP server
  (#5386), one security model (IAAA).
- Canonical endpoints ([ADR 0034](./adr/0034-cbo-api-layer.md) D12):
  the one MCP server is served at `https://mcp.openaimp.com/mcp`
  and the one API server is served at `https://api.openaimp.com/api`.
  DNS/route setup is part of the one-server build scope.
- Container shape owner: #5277 (J-stack portability, CAIO lane, under
  #5272) — Dockerfile + compose running the Worker under workerd; CI
  runs the engine suite against it. This document records the
  decision; it does not design the containers.

## Networking architecture

- **Pending — owning issue #1454 (COO lane).** The consolidated
  `networking.md` lands under #1454.
- Related assessment: [assessment-01](./network/assessment-01.md).

## Product architecture

- [Product architecture](../agents/product-architecture.md) (CPO lane).
- Related assessment: [assessment-01](./product/assessment/assessment-01.md).

## Standards conformance

- [Standards](./standards/standards.md) and
  [tech-standards](../agents/tech-standards.md).
- [Technology stack](../technology/tech-stack.md) — every technology
  in use, the decided pieces, and the FOSS-first must-use rule.
- SOLID / GRASP / GoF conformance anchor is issue #488.
- Agentic patterns (ReAct, Reflection, Self-correction, Learning, Adaptive Router, Supervisor-Worker, Decentralized-Swarm, etc)
- Security Models and Protocols (IAAA)
- Protocols (OIDC, MCP, A2A, ACP, UCP, etc)
- 15-factor methodology.
- AOP (Exception Handling, Coded Messages, Logging, Externalized Configuration, Security, Transaction Management, etc)
- AI-native (perception-and-ingress, reasoning-and-planning, goal orientation and orchestration, memory and stateful, autonomous, adaptive, self-governing and RSI, action-and-tool layer, feedback-driven)
- Cloud-native and cloud-agnostic (portable across clouds and local containers)
- API-native
- Semantic Layer Standards
- Contract-First & Composability Standards
- Zero-Touch Operational Frameworks
- Distributed Data & Continuous Learning Pipelines
- CNCF Cloud Native Maturity Model
- Well-Architected Frameworks (cloud-neutral; the AWS, Azure, and GCP frameworks are assessment references, not the architecture)
- OpenTelemetry & Cloud-Native Observability Standards
- TOGAF, COBIT, ITIL
- Ilities (Agility, RASUI, FURPS, RASR, ACID, RAMS)

## Diagrams

- Related: [blueprint-01](./blueprint/blueprint-01.md),
  [ABOK target blueprint](./blueprint/abok-target-blueprint.md),
  [design assessment-02](./design/assessment-02.md).
- A consolidated diagrams doc (system flow, component relationships)
  is pending under this parent issue (#1449); no owner is assigned by
  guess.

## Changelog

Every change to this container or to any doc it links gets a changelog
entry here, newest first:

- 2026-11-25 — Application architecture: the one universal env context
  defined — `UniversalEnvContext` (`src/config/environment.ts`),
  resolved once per request by the one universal resolver
  `resolveUniversalContext`, which calls `resolveEnvironmentConfig`
  (so the core values are unchanged) and adds the platform / tenant /
  user / environment dimensions plus a per-setting resolution source,
  reusing the OTEL source vocabulary (`run | session | user | runtime |
  env | file | builtin`). The one cascade for all config is now
  recorded: run > session > user > runtime > env > file > built-in
  safe default — the `environment.ts` cascade comment is corrected
  from its 3-level statement to this 7-level statement. The
  tenant-override home (runtime level) stays an open owner decision;
  no read site changes in this slice. Survey decomposition:
  [target-state counts §2](./survey/target-state-counts.md) and
  [per-domain end state, D1 (Config)](./survey/per-domain-end-state.md)
  (issue #6540).
- 2026-11-18 — Packaging and deployment: canonical endpoints named —
  the one MCP server at https://mcp.openaimp.com/mcp and the one API
  server at https://api.openaimp.com/api (ADR 0034 D12) (issue #5411).
- 2026-11-18 — Standards conformance: technology stack linked —
  [tech-stack](../technology/tech-stack.md) (issue #5404).
- 2026-11-18 — Technology, cloud, and vendor-agnostic principle
  stated; packaging and deployment section added — the solution is
  containerized per architectural layer (services, API, MCPs,
  frontend, backend, middleware, data layer), runnable on Cloudflare
  Workers and in Docker (multi-cloud, cloud-agnostic) — decisions in
  [ADR 0034](./adr/0034-cbo-api-layer.md) (D11), container shape owned
  by #5277 (issue #5399).
- 2026-11-09 — Agentic architecture: agents, workflows, schedules,
  queues, platforms and lifecycle target architecture added —
  [agents-workflows-schedules-queues-platforms-lifecycle](./agentic/agents-workflows-schedules-queues-platforms-lifecycle.md)
  (discussion and governing tracker #3842, doc issue #3844).
- 2026-11-06 — Agentic architecture: agent capabilities account
  added — [agent-capabilities](./agentic/agent-capabilities.md)
  (issue #3520).
- 2026-11-05 — Agentic architecture section added: links the Agentic
  Target Architecture (#576, tracked by #571) and the six docs under
  agentic/, and records the open Agentic UX program (#3082, evaluated
  under #3142).
- 2026-10-28 — Container created (#1449): ten sections, links only,
  pending states for integration, data, security, networking,
  consolidated application doc, and diagrams; 15-factor flagged as
  awaiting its owner's definition.
