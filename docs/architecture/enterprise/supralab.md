# SupraLab / SupraHub Architecture

**Status:** Architecture record, 2026-11-27. Issue: #6704.
**Governing neighbours (linked, never duplicated):** the IROS target system and its
technology needs live in [`agentic-IROS.md`](agentic-IROS.md); the execution engine
account lives in [`../agentic/j-stack-workflow-engine.md`](../agentic/j-stack-workflow-engine.md);
the one-engine job doctrine lives in [`../agentic/job-system.md`](../agentic/job-system.md).
This document owns only the SupraLab/SupraHub capability naming, the capability map,
and how the capabilities relate.

## 1. Naming hierarchy

```text
SupraLab (the company)
└── SupraHub (the platform)
    ├── SupraFlo   — workflow execution
    ├── SupraTik   — scheduling
    ├── SupraQue   — queues / events
    ├── SupraTap   — data providers, feeds, universes, feature inputs
    ├── SupraBox   — research and hypothesis work
    ├── SupraSim   — strategy evaluation and simulation
    ├── SupraKno   — reports, search, institutional memory
    ├── SupraAud   — performance evaluation and alpha-decay auditing
    ├── SupraSyn   — tool and code synthesis
    ├── SupraExe   — broker order execution
    ├── SupraCap   — capital and position allocation
    ├── SupraPre   — risk limits, circuit breakers, kill switches
    └── SupraLin   — run ledger, audit, lineage, observability
```

- **SupraLab** is the company. **SupraHub** is its platform — the boundary containing
  the thirteen capabilities above. SupraHub is not a fourteenth capability and not an
  executor.
- **SupraFlo** is the entire workflow capability: the j-stack core plus the
  residency/host/platform composition around it. **j-stack** names only the core
  inside SupraFlo (`JobPipelineControl` engine + stage runner + journal ports +
  aspects). The whole workflow capability is never called j-stack.
- These thirteen names are canonical. Alias variants (SupraHypo, SupraMem, SupraEval,
  SupraForge, SupraExec, SupraAlloc, SupraGuard, SupraTrace) are not used.

## 2. Capability definitions

| Capability | Layer | Definition | Owns | Boundary / non-goals |
|---|---|---|---|---|
| SupraFlo | Orchestration Core | Durable, controllable execution of every job family as data: define once, run in a chosen residency, pause/resume/cancel/retry/replay with one ledger | Job definitions, execution semantics, lifecycle controls, run records | Does not decide when work fires (SupraTik) or carry signals between systems (SupraQue) |
| SupraTik | Orchestration Core | Temporal scheduling: cron triggers, schedule ticks, cadence | When work starts | A dispatcher/door; executes nothing |
| SupraQue | Orchestration Core | Event-driven transport: queues, events, DLQs | Work signals in flight: triggers, stage events, delivery | Carries signals, not execution |
| SupraTap | Data & Features | Market-data ingestion and normalization: providers, feeds, universes/index lists, feature inputs | Provider data and its stored copies | Does not evaluate strategies |
| SupraBox | Research & R&D | Research and hypothesis work: reading, factor/strategy formulation, iteration | Research artifacts and hypotheses | Isolated sandbox compute is not available today |
| SupraSim | Research & R&D | Strategy evaluation and simulation before capital is risked | Evaluation results | Tick-level market replay is not available today |
| SupraKno | RSI & Evolution | Institutional memory: reports, search, stored knowledge | The searchable record | Does not judge performance (SupraAud) |
| SupraAud | RSI & Evolution | Performance evaluation and alpha-decay auditing: live vs simulated, drift detection | Audit verdicts | Does not allocate capital (SupraCap) |
| SupraSyn | RSI & Evolution | Tool and code synthesis: agents writing, testing, registering new tools/parsers/indicators | Synthesized tools | Not available as a controlled capability today |
| SupraExe | Live Execution | Broker order execution | Orders and fills | Does not size positions (SupraCap) or set risk limits (SupraPre) |
| SupraCap | Live Execution | Capital and position allocation across strategies | Allocation decisions | Does not place orders |
| SupraPre | Safety & Audit | Deterministic pre-execution and real-time risk: limits, circuit breakers, kill switches | Risk refusals, by name | Guards refuse only on safety invariants; it is not a policy engine for trading decisions |
| SupraLin | Safety & Audit | Run ledger, audit, lineage, observability | The trace from decision to record | Observes; never executes |

## 3. Relationship matrix

| Question | SupraFlo | SupraTik | SupraQue | Others |
|---|---|---|---|---|
| Who triggers work? | Accepts dispatch | Fires schedules into SupraFlo | Delivers event triggers into SupraFlo | SupraBox/SupraSim request runs through SupraFlo |
| Who executes? | Yes — the only executor | No | No | No other capability executes jobs |
| Who records? | Run ledger, checkpoints, artifacts (D1) | Schedule state | In-flight messages, DLQs | SupraKno stores reports/knowledge; SupraLin owns lineage |
| Who observes? | Emits stage events | — | Carries stage events/delivery | SupraLin observes all; SupraAud judges performance |
| Who decides when? | No | Yes (cadence) | On event arrival | SupraCap decides allocation timing within its mandate |
| What does failure look like? | Named run failure in the ledger | Missed/late tick, visible in schedule state | DLQ entry, named | SupraPre refusal by name; never silent |

### Directed edges

- SupraTik → dispatch → SupraFlo
- SupraQue → event/trigger → SupraFlo
- SupraFlo → stage events/delivery → SupraQue
- SupraTap → SupraBox / SupraSim → SupraAud → SupraCap → SupraExe
- SupraPre gates SupraExe (pre-execution and real-time risk)
- SupraLin observes every capability above

Non-edges: SupraTik never executes; SupraQue never executes. Scheduling and queues
are doors/carriers into SupraFlo, not alternative executors.

## 4. Supports today

| Capability | Status | Caveat |
|---|---|---|
| SupraFlo | Available | Feed jobs run on workflow residency since #4171 (PR #6702) |
| SupraTik | Available | — |
| SupraQue | Partial | Queues carry stage events/delivery; event-driven execution paths are not the production norm |
| SupraTap | Partial | Providers/feeds/universes live; point-in-time feature store incomplete |
| SupraBox | Partial | Research flows exist; isolated sandbox not available |
| SupraSim | Partial | Strategy evaluation exists; tick-level replay not available |
| SupraKno | Partial | Reports + search live; unified knowledge graph incomplete |
| SupraAud | Partial | Evaluation exists; continuous alpha-decay auditing incomplete |
| SupraSyn | Not available | No controlled tool/code synthesis capability |
| SupraExe | Partial | Broker execution exists (paper-first); institutional routing algorithms incomplete |
| SupraCap | Partial | Position sizing exists; dynamic multi-strategy allocation incomplete |
| SupraPre | Partial | Guards exist; full deterministic risk engine incomplete |
| SupraLin | Partial | Ledger/audit/OTel exist; end-to-end lineage incomplete |

## 5. SupraFlo execution model (summary)

The full account is [`../agentic/j-stack-workflow-engine.md`](../agentic/j-stack-workflow-engine.md);
this is the naming-level summary.

- **j-stack core:** `JobPipelineControl` (engine) + stage runner + journal ports +
  aspects (retry; observability hooks). The engine reads a job definition, walks its
  nodes, looks each node kind up in the step registry, and invokes the handler. It
  owns execution semantics; nothing else does.
- **Residency** is where a run executes: host + driver + journal + stores. Three
  implemented mappings:
  - **R1 sync-host:** ScheduledAgent Durable Object, sync driver, identity journal, D1 stores.
  - **R2 workflow:** JobPipelineWorkflow / ScreenerScreenWorkflow, workflow-shard
    driver, workflow step journal over `step.do`, D1 stores.
  - **R3 in-memory:** in-memory adapter host, sync driver, identity journal,
    in-memory stores; tests only.
- **Lifecycle** is engine-owned on every residency: run, pause, resume, cancel,
  retry, replay, rerun, restart, stop, settle. Resume continues the same run from
  its checkpoint under the pinned definition version; retry starts a new run;
  replay reproduces a past run/stage under its recorded version; restart/rewind is a
  platform rewind of a live workflow-stamped run (R1 refuses by name).
- **Directive (owner, 2026-11-27):** build residency for one host first — the
  workflow runtime (R2) — fully end-to-end to parity (definition, dispatch,
  execution, journal/checkpoints, lifecycle controls, records/ledger, observability,
  UX/API/MCP surfaces, live proof). R1/DO is low priority; no capability counts as
  done on R1 evidence.
- Jobs are not ACID transactions: at-least-once steps with claims/idempotency and
  compensation. Jobs are definable as data through the catalog/definition store (one
  definition path); workflow classes and step handlers remain code.

### Competitor-parity priorities (W1–W10, workflow-runtime first)

1. W1 determinism enforcement (#5280)
2. W2 version pinning (#5278)
3. W3 exactly-once edge (#5586)
4. W4 signals/queries (#5279)
5. W5 platform sleep/retry/rollback adoption (#5782/#5958)
6. W6 observability on every host (#5489)
7. W7 journal-as-spec (#3220/#4808)
8. W8 portability (#5277)
9. W9 UX control parity
10. W10 async-job convergence (#5769)

Each item's done test is end-to-end on R2 under the directive above.

## 6. Diagrams index

The execution-model report carries seven diagrams:

1. Component diagram — execution-model layers and components.
2. Nesting diagram — platform ⊃ workflow/agent ⊃ host ⊃ engine ⊃ runner, residency as bracket.
3. BPMN 2.0 process diagram — SupraHub (SupraLab) pool, SupraFlo/j-stack.
4. UML sequence diagram — door → host → workflow → engine → step.
5. SupraFlo capability diagram — Orchestration Core trio inside the SupraHub frame.
6. Orchestration Core relationship diagram — SupraTik/SupraQue/SupraFlo directed edges.
7. SupraHub capability map — all thirteen capabilities by layer with supports-today status.

Only diagram 7 includes all thirteen capabilities; diagrams 5–6 show the
Orchestration Core trio; diagram 3 names SupraHub/SupraLab/SupraFlo; diagrams 1, 2,
and 4 carry no Supra capability names.
