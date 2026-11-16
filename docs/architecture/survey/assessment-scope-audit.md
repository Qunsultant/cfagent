# Assessment-Scope Audit — what was assessed/recorded/deferred instead of built

**Commissioned:** 2026-11-01, owner question — *"how many other things are just scoped to assessment in the open/closed tasks?"*
**Method:** fresh clone of Qunsultant/cfagent @ `abfc9f9e` (2026-11-01 15:21 UTC) — every "still unbuilt" claim below was verified against that tree (grep/read), not taken from the record that created it. Issue states via the GitHub API (owner Qunsultant). Programme records: `src/agents/registry.ts`, the #2225 survey files and #2494 findings on disk in this folder, the three Think-adoption surveys and the AGNTCY survey (2026-11-01).
**Counting rule:** an item counts once even if recorded in several places. The four S17 trace breaks count as four (four separate builds in four subsystems). Screener/Research recovery counts as two (per-agent builds).

---

## (A) Assessed / deferred — build never filed

| # | Item | Source record | What's missing | Unblocks it |
|---|---|---|---|---|
| A1 | Agents SDK Skills enablement (per-class `getSkills()` override + source) | #2460 (S19) assessment, closed; registry `MESH_SKILLS_ASSESSMENT`; S14 #2417 | The build itself: zero `getSkills()` overrides in `src/`; skills aspect GAP for all 12 PortThink agents. Assessment recommended the format and parked adoption behind a "post-programme discussion" gate the lane never brought back. **Owner ordered the build 2026-11-01** (issue + first slice being filed). | Owner (decision now given) → lane builds |
| A2 | `web_search` tool | Registry tool family, status `absent` (S14 #2417; #2322 source scan) | No web_search tool exists in `src/`; recorded "as an honest gap for a later slice" — no later slice was filed | Lane (no owner gate recorded) |
| A3 | `web_fetch` tool | Registry tool family, status `absent` (S14 #2417) | No standalone web_fetch tool; BrowserAgent is the current fetch surface; no follow-up issue | Lane |
| A4 | `run_sandbox_command` → SandboxAgent class wiring | S15 census cells (#2421), recorded as "the #2253 follow-up" | The MCP command still constructs `new ETradeSandboxService` directly (`cloudflareAgentCommands.ts:141`); #2253 closed without the wiring. Capability works; the class wiring was never built | Lane |
| A5 | S17 trace break — trading-workflow-steps | Registry `MESH_TRACE_SPINE` (S17 #2428), verified `break` on current main | TradingTradeWorkflow params carry no traceparent field, so a chat trade's trace ends at the door; fix is a TradingAgent-slice params change, never filed | Lane |
| A6 | S17 trace break — payment-workflow-steps | Registry `MESH_TRACE_SPINE` (S17 #2428), verified `break` | PaymentWorkflow's internal steps record no step hops; the payment leg assembles as its start hop only | Lane |
| A7 | S17 trace break — http-route-workflow-starts | Registry `MESH_TRACE_SPINE` (S17 #2428), verified `break` | Route/scheduled workflow starters stamp no traceparent into their commands; route-started runs are untraced end to end | Lane |
| A8 | S17 trace break — channel-ingress-turns | Registry `MESH_TRACE_SPINE` (S17 #2428), verified `break` | Email/voice/NLQ-webhook paths never enter a traced turn and mint no trace at their own ingress | Lane |
| A9 | ScreenerAgent run recovery / resume | #2225 survey §(e) per-agent record; programme backlog "recovery GAPs" | No `onStart`/resume in `screener-agent.ts` (verified): agent-direct runs record in a task ledger with a concurrent-run lock — "an honest in-progress state, not a resume" | Lane |
| A10 | ResearchAgent run recovery / resume | #2225 survey §(e) per-agent record; programme backlog | No `onStart`/resume in `research-agent.ts` (verified): an interrupted run leaves no resumable record beyond ledger rows it wrote | Lane |
| A11 | Model/token metering for the chat-turn and agent-as-a-tool doors | Registry `MESH_DOOR_COST_BUDGETS` gaps (S19 #2460; doors-and-layers §7.1 named gap) | No per-turn/per-dispatch usage record exists, so no token cap can be charged on either door; metering build never filed. Depends on D6 for the gateway-side route | Owner activates AI Gateway (D6) → lane builds metering |
| A12 | Per-call usage metering + budget caps for the HTTP-routes and MCP doors | Registry `MESH_DOOR_COST_BUDGETS` (S19 #2460): both doors `accounting-only`, caps `null` | Unpriced routes and catalog commands write no usage row, so no cap can be charged; enforcement build never filed | Lane |
| A13 | Prompt documentation bulk → behind `query_platform_knowledge` | #2494 findings note (comment 6539496217; `prog-2494-findings-nvda.md` finding 1) | The system prompt still carries the platform guide that already exists in the FAQ corpus; the note's sequencing precondition (MCP client slice) has landed and the cleanup still isn't built; no separate issue | Lane |
| A14 | Cross-tenant queue view — production spot-check | #2516 follow-up (recorded when the fan-out repoint landed) | The follow-up verification was recorded and never executed; no issue | Lane |

**Category A count: 14**

---

## (B) Built but unwired — no production caller

| # | Item | Source record | What's missing | Unblocks it |
|---|---|---|---|---|
| B1 | RSI proposal pipeline → GitHub filing | S19 #2460 (pipeline + filer landed; registry S19 records) | Verified on current main: `MeshProposalPipeline` is never instantiated in `src/` and `createGitHubProposalFiler` (`meshProposalFiler.ts`) has zero production callers. Proposals can be drafted/evidence-checked in tests; nothing in production ever files one | Lane (a production caller: cron/route/door wiring slice) |
| B2 | Golden-task eval harness — production cadence driver | S18 #2439 (`MESH_G12_PROOF`; `meshGoldenTasks.ts`) | Verified: `executeGoldenTasks` has zero production callers. The 14-task harness runs only when invoked manually/in tests; no scheduled driver produces the eval cadence S19's loop was designed to read | Lane |
| B3 | Chat-turn checkout-email source for paid screens | S10 record (#2494 programme); door code `meshScreenDoor.ts` | The door's `checkoutEmail` resolver slot exists and the refusal is honest (`checkout_email_required`), but verified: no production composition supplies a resolver (`checkoutEmail:` assignment appears nowhere in `src/`), so every monetization-on chat paid screen — goal screens included — ends at the refusal | Lane (a composition slice needs a checkout-email source for a chat turn) |
| B4 | `durableFibers` checkpoint recovery | #2225 survey §3; registry tool-family record (degraded) | Verified in the registry's own current words: "checkpoints written but never read — NOT durable across eviction." The helper runs (execute_durable_twap) but its recovery half was never wired to read a checkpoint | Lane |

**Category B count: 4**

---

## (C) Dispositioned no-build — recorded reason + revisit trigger

| # | Item | Source record | Reason recorded | Revisit trigger |
|---|---|---|---|---|
| C1 | Think adoption — payment domain | Think-adoption payment survey, 2026-11-01 (on #2494, comment 6559001091) | `step.prompt()` doctrinally forbidden on money paths; all other capabilities genuine no-fits; the one candidate (agent-hosted workflows) rejected — no owning agent by design (#2014) and Think's approval payload has no `approverId` channel #2550's audit contract requires; paid path dark in production, so no surface evidence is possible | Monetization activation (first approved price + flag on), or an owner/CTO owning-agent decision |
| C2 | Think adoption — trading domain | Think-adoption trading survey, 2026-11-01 (on #2494, comment 6559035311) | Agent-hosted workflows already adopted (#2375); `waitForApproval` rejected on contract evidence (no authorizer/frozen-terms channels; rejection modelled as an error); rest no-fits | An SDK payload that carries the typed decision contract, or an owner direction to re-open |
| C3 | Think `step.prompt()` for the screener ND interpreter | Think-adoption screener survey, 2026-11-01 | Blocked twice: ScreenerScreenWorkflow has no owning agent (adoption means re-routing every start path), and `SCREENER_ND_MODE` is OFF/CISO-gated so no production evidence could be shown anyway | Owning-agent decision + CISO flag review |
| C4 | TradingAgent sessions build-out | Trading survey disposition, 2026-11-01 | Dual session stores sit behind a turn surface with zero production callers (grep-verified) — vestigial by design; explicitly NOT closed by #2566 (OrchestratorAgent turns only) | An owner/CTO decision giving TradingAgent a turn caller |
| C5 | AGNTCY Directory discovery (consumption) | AGNTCY survey, 2026-11-01 | No verified hosted directory exists to query (hub did not resolve — UNVERIFIED); self-hosting is new infra for an empty network; JS SDK Worker transport unverified | A verified hosted directory, or a concrete external-discovery need |
| C6 | AGNTCY identity alignment (W3C VC badges) | AGNTCY survey, 2026-11-01 | cfagent's `did:agent:` is a private unresolvable method with HMAC-or-unkeyed-label proofs; badges over the transitional shared token would overstate identity strength | S16 rollout completes (D1) |
| C7 | AGNTCY observability interop (hop → OTLP export) | AGNTCY survey, 2026-11-01 | S17 already shares the only hard substrate (the W3C trace id); an exporter has no consumer today and would inherit the four S17 breaks (A5–A8) | A consumer for the export exists |
| C8 | Public.com order execution | Owner direction 2026-10-27 (parked); adapter exists for data/connect only | Parked by the owner; screens cannot pick Public and no order side exists — recorded so it is never presented as implemented | Owner un-parks + Public API access/credentials |
| C9 | #1972 Phase 6 — prompt-driven workflow generation | #1972 (comment 6458246797, CEO lane) | Sequenced after Phase 5 by design: WorkflowSpec-only output, deterministic compiler, human approval gating registration, CISO review mandatory. P5 (#2000) is CTO-owned and open | P5 lands → CEO/owner sequencing (not a CAIO build) |

**Category C count: 9**

---

## (D) Owner-gated config / decision items — the owner's, not the lane's scoping

Kept separate by the commissioning instruction: these are not assessment-scoping failures; each waits on a decision or configuration act only the owner (or a named other lane) can take.

| # | Item | Source record | What's missing | Whose decision |
|---|---|---|---|---|
| D1 | S16 secrets rollout | #2225 S16; owner-deferred 2026-10-31 | 15 `A2A_TOKEN_<SURFACE>` Worker secrets + `DID_ATTESTATION_KEY` unset in production; every surface still runs on the shared transitional token. The lane's fallback-deletion slice follows the rollout | Owner (sets secrets) → lane cuts fallback deletion |
| D2 | #1546 production seed invokes | #1546 (open; code complete) | D1 AgentDB seed invokes need the owner's signed-in session; issue closes after | Owner (sign-in) |
| D3 | Price approval + monetization activation | #2547 (landed, closed); CPO gate #951/#1173 | Approval is now representable and enforced fail-closed — and no catalogue price has been approved, so the gate refuses everything, by design. Activation also needs the monetization flag | Operator/owner (approve prices; flag) |
| D4 | #1078 ExecutionContext enforcement flip | #1078 (open) | Contract landed in observe mode 2026-10-23; the observe → enforce flip is owner-sequenced and has not been directed | Owner |
| D5 | Q7 sign-off | #945 (open epic) | Decision record posted; CDO signed 2026-10-29; CISO sign-off outstanding — the programme stays half-closed | CISO lane |
| D6 | AI Gateway activation | #1741 (closed — the gateway-wrapped model path is built, `src/agents/model.ts` Layer 1) | `AI_GATEWAY_ID` not set in production, so the built wrap is inert and gateway metering is unavailable (blocks A11) | Owner (config) |
| D7 | SandboxAgent container backend | Registry agent record (S14 #2417): "a named OWNER DECISION, not a code gap" | No Cloudflare Containers configuration in `wrangler.jsonc`; `run_command` honestly returns `executed:false` until one is added and the service is constructed with the bound container | Owner (config) |
| D8 | MCP server name pick | #2494 owner resequence 2026-10-30 | The server name was never picked (options: openaimp / platform / mesh); `openaimp` stands provisionally in the single constant `OPENAIMP_MCP_SERVER_NAME` | Owner |

**Category D count: 8**

---

## Verified landed since the records were written — NOT counted

- **MCP `chain.run` execution binding** — was design/validate-only at the S-record stage; on current main `goalChainCommands.ts` implements `chain.run` as a real executing command (re-validation + leg execution). Landed.
- **Gateway-wrapped `getModel()`** — the build landed with #1741 (closed): `getWorkersAIModel` routes through AI Gateway when configured. Only activation is outstanding (D6).
- **CrossDomainSagaWorkflow entry route** — the S1 registry note ("binding exists, uncalled") is stale: `src/agents/routes/sagaEntry.ts` starts SAGA_WORKFLOW via POST /api/saga/start (#2041 S4, CDO lane). Landed.

## In flight at audit time — NOT counted

- Screener Think slice #2693 / PR #2697 (observe-only `getScheduledTasks`, in the queue path).
- AGNTCY slice 1 (local OASF record generation, building).
- Skills enablement (A1) — build ordered by the owner 2026-11-01, in preparation.

## Adjacent open survey/design issues found by the title sweep — out of the audited programmes, NOT counted

#2380 (explorer/dashboard surface survey, open), #1024 (replaceable API layer design + OpenAPI spike, open), #1935 (O3 Think-adapter spike gate, open — its programme did proceed via #1951), #911 (SessionStore sharding, trigger-gated build from the closed #789 design, open). Listed so the sweep's coverage is visible; they belong to other lanes' programmes and were not dispositioned here.

---

## Counts

- **(A) Assessed/deferred, build never filed: 14**
- **(B) Built but unwired / no production caller: 4**
- **(C) Dispositioned no-build with reason + trigger: 9**
- **(D) Owner-gated config/decision (owner's, not the lane's): 8**

**Total: 27 items sit unbuilt by lane-side scoping or disposition (A+B+C), plus 8 owner-gated items (D) that were never the lane's to scope.**
