# Architecture and Design Document (ADD)

**Container document only.** This file holds the section structure and
links to the individual architecture docs. It duplicates nothing — it
links. Each section below links to its individual doc, or states it as
pending with its owning issue. Delivery rules live in
[gitops](../agents/gitops.md); user journeys live in
[ux-architecture](../agents/ux-architecture.md).

## UX architecture

- [UX architecture](../agents/ux-architecture.md) — user journeys,
  components, and the token architecture (CPO lane).
- Related assessments: [assessment-01](./UX/assessment-01.md),
  [design-system-01](./UX/design-system-01.md),
  [exceptions-01](./UX/exceptions-01.md).

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
- SOLID / GRASP / GoF conformance anchor is issue #488.
- Agentic patterns (ReAct, Reflection, Self-correction, Learning, Adaptive Router, Supervisor-Worker, Decentralized-Swarm, etc)
- Security Models and Protocols (IAAA, 
- Protocols (OIDC, MCP, A2A, ACP, UCP, etc)
- 15-factor methodology.
- AOP (Exception Handling, Coded Messages, Logging, Externalized Configuration, Security, Transaction Management, etc)
- AI-native (perception-and-ingress, reasoning-and-planning, goal orientation and orchestration, memory and stateful, autonomous, adaptive, self-governing and RSI, action-and-tool layer, feedback-driven)
- Cloud-native
- API-native
- Semantic Layer Standards
- Contract-First & Composability Standards
- Zero-Touch Operational Frameworks
- Distributed Data & Continuous Learning Pipelines
- CNCF Cloud Native Maturity Model
- Well-Architected Frameworks (AWS, Azure, GCP)
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
