# Research notes addendum — #4770 dispatch-modes doc, dispatch surfaces

- **Base:** `5ee1f23d008cf93e0493c7b371f4d64a3605a64d` (same as the draft)
- **Worktree:** `~/workspace/w3533/wt-docs-dispatch`
- **Revision:** adds the "Dispatch surfaces" section (agentic/chat, REST, MCP,
  service) after the nine named components, two diagram nodes (chat turn,
  /mcp) plus labeled edges, a usage-diagram SITE widening, and an NLQ bullet
  in "What does not exist". LOCAL ONLY — no GitHub writes.
- **Gap it fixes (user, 2026-11-16):** the draft covered engine/doors/workflows
  internals but not the dispatch surfaces as first-class sections. Verified
  by grep before the revision: MCP 0 mentions, NLQ 0 mentions, chat 6 passing
  mentions, 2 REST endpoint mentions.

## Agentic mode — chat, preferred (verified)

- Turn tools discovered at runtime from the platform's own openaimp MCP server
  via the Agents SDK MCP client, merged by Think under `tool_openaimp_<name>`
  keys — `src/agents/registry.ts:1335`, `src/agents/mcpAdapter.ts:11-16` (#2496).
- Turn prompt names the screen tools as THE tools — `src/agents/chatPrompt.ts:264-266`
  (`run_stock_screen` THE universe-screen tool; `run_options_strategy_screen`
  THE options-strategy-screen tool, never deflected to a UI workflow;
  `etrade_market_scan` is a raw-listings filter-scan, NOT a universe screen).
- `run_stock_screen`, Batch E #2488, mesh screen door built WITHOUT NLQ —
  `src/agents/orchestrator/meshScreenDoor.ts:2-16` (owner direction 2026-10-30:
  "just build the entire solution without NLQ... turn it off with a flag").
  No direct-ScreenerAgent fallback; unavailable workflow port = coded
  `door_unavailable`, zero runs started — meshScreenDoor.ts:40-52. Command
  source `"mesh-door"`, not `"nlq-chat"` — meshScreenDoor.ts:49-52. Imports
  NOTHING from NLQ modules — meshScreenDoor.ts:29-36.
- `run_options_strategy_screen`, Batch F #2581, mesh options-strategy door
  built WITHOUT NLQ — `src/agents/orchestrator/meshOptionsStrategyDoor.ts:2-24`.
  Calls `runOptionsStrategyAction` (same seam the NLQ `options_opportunities`
  action dispatches to), direct-return carriage, no workflow/job/read-back —
  meshOptionsStrategyDoor.ts:20-24.
- NLQ off by default in the turn: `CHAT_NLQ_MODE`, values on|off, built-in
  default "off" — `src/config/chatNlqModes.ts:15-16`. Resolution user > global
  env > built-in off; unrecognized fails closed to off — chatNlqModes.ts:38-47.
  `execute_nlq` stays registered/wired but flagged off via `TurnConfig.activeTools`
  (`chatNlqTurnGate` in meshMcpClient.ts) — registry.ts:1335.
- NLQ modules live on in `src/agents/nlq/` (execution, formatting, llmPlanning,
  orderParams, planning, schema, types), serving async `nlq.execute`, A2A, chat
  error fallback — meshScreenDoor.ts:35-36.
- Bridge: `src/agents/orchestrator/runBridge.ts` (#3787, sub-issue of #3781);
  `BridgeRunStartInput.trigger: "manual" | "scheduled"` — runBridge.ts:59;
  best-effort, never fails the run — runBridge.ts:28-33.
- G1 mesh doors / batches E–M in one place — `src/agents/registry.ts:947`
  (Batch E #2488, F #2581, G #3535, H #3536, I #3537, J #3538, K #3539,
  L #3540, M #4066; identity fail-closed; #2496 identified external callers).

## REST API endpoints (verified)

- Routes are handler functions invoked from `OrchestratorAgent.routeRequest`
  in sequential path matching; Response on match, null otherwise —
  `src/agents/routes/dataProviders.ts:3-8`. DO-internal spellings; server.ts
  strips /api prefix — dataProviders.ts:33-36. Session gate #1156: requireAuth
  on EVERY /api/* request, x-user-login from verified session; mutations refuse
  without verified login (401) — dataProviders.ts:38-44.
- dataProviders route list (method + path + purpose) — dataProviders.ts:9-28
  (feed-run #3530 S1 through pipeline host door since #3578; feed-jobs actions
  #3535; enrich #3536; analyze #3537; generate #3538; deliver #3539; chains
  #3540 incl. stage_pause/stage_resume/stage_cancel; register/configure/verify/
  enable/disable/deprovision).
- jobDefinitions: GET /api/job-definitions (catalogue), POST
  /api/job-definitions/:id/define (define from a spec; per-stage overrides
  #4466: stageParams/stageModes/stageSchedules), second half POST /api/schedules
  with callback runPipelineJobSchedule — `src/agents/routes/jobDefinitions.ts:1-13,25-45`.
- jobStatus: GET /api/jobs/:jobId/status, GET /api/jobs/:jobId/stages/:stageId
  (#4361), POST stage control (#4362) — `src/agents/routes/jobStatus.ts:1-14,21-49`;
  CONTROL_PATH matched on POST only — jobStatus.ts:80.
- sagaStatus: GET /api/saga/:sagaId/status (#2041 S4), owner-scoped 404,
  NOT flag-gated, live status best-effort — `src/agents/routes/sagaStatus.ts:1-22`.

## MCP endpoints (verified)

- Commands are IMcpToolCommand objects; #2496 dogfooding (turn consumes the exact
  MCP surface external clients consume) — `src/agents/mcpAdapter.ts:11-16`.
- /mcp route: `handlePlatformMcpRoutes`, /mcp, /api/mcp, /mcp/scanner, /mcp/scanner/*
  — `src/server/routes/platform.ts:323`, `src/server.ts:193-196`. Identity = app
  session OR per-user API key; caller-asserted x-user-id asserts nothing; no
  credential → 401 before DO access — platform.ts:324-334. Verified login threaded
  as x-user-login + x-principal-kind (session|api-key) — platform.ts:342-358.
  CSRF gate exempts token-authenticated /mcp — src/server.ts:111.
- ScheduledAgent pipeline door: `ScheduledAgentDoorStub`, "the ScheduledAgent host's
  control-plane RPC surface (#3543)" — `src/agents/orchestrator/meshDoors.ts:234-295`
  (runPipelineJob :239, runPipelineStage :254, runPipelineChain :295, pause/resume/
  cancel/retry, configurePipelineJob, per-family surface-status reads).
- Command names (all `readonly name = ` in src/mcps/openaimp/):
  - feedJobCommands.ts:40,68,93,113,241,273 — run_feed_job, get_feed_job_status,
    list_feed_jobs, manage_feed_job, get_feed_job_schedule, set_feed_job_schedule.
  - enrichJobCommands.ts:39,67,92,112 — run_enrich_job, get_enrich_job_status,
    list_enrich_jobs, manage_enrich_job.
  - analyzeJobCommands.ts:41,69,94,114 — run_analyze_job, get_analyze_job_status,
    list_analyze_jobs, manage_analyze_job.
  - generateJobCommands.ts:42,70,95,115 — run_generate_job, get_generate_job_status,
    list_generate_jobs, manage_generate_job.
  - deliverJobCommands.ts:42,70,95,115 — run_deliver_job, get_deliver_job_status,
    list_deliver_jobs, manage_deliver_job.
  - chainJobCommands.ts:51,109,135,160 — run_pipeline_chain, get_pipeline_chain_status,
    list_pipeline_chains, manage_pipeline_chain.
  - Per-stage pause/resume/cancel inside a chain run — registry.ts:947 (Batch L).
  - options_copilot_stage_control, per-stage run/rerun/stop/resume/cancel by
    (runId, stageId), 8-stage vocabulary, via optionsStageControl.ts; #4272 same
    door drives strategy runs — `src/agents/orchestrator/meshOptionsStageControlDoor.ts:1-16`.
  - Adjacent: stock_copilot_stage_control (jobStageControlCommands.ts:32),
    get_job_status / get_job_stage_status (jobStatusCommands.ts:32,53),
    set_job_execution_mode (jobExecutionModeCommands.ts:29).
- Identity: actingLogin carrier required, fail closed without one; #2496 identified
  external MCP callers via the same carrier; anonymous fail closed; A2A doors remain
  the cross-instance surface — registry.ts:947.

## Service endpoints (verified)

- `createScheduledAgentPipelineControl` defined at
  `src/agents/scheduledTasksPipeline.ts:485`; control cached on the pipeline context
  (`if (ctx.control) return ctx.control` — :488); step registry feed/enrich/analyze/
  generate/deliver/screener; feed execution bound from env (FEED_JOB_EXECUTION_MS,
  240s default, #4312) — scheduledTasksPipeline.ts:501-505.
- Doors: runPipelineJob :935, runPipelineChain :1466, runPipelineStage :963 in
  `src/agents/scheduled-agent.ts` (already in the draft's nine components).
- Callers: REST routes (dataProviders feed-run/chain actions; jobStatus control
  jobStatus.ts:80-92; scheduledCallbacks.ts:1094 runPipelineStage); MCP command
  implementations (door.runPipelineJob at meshDoors.ts:523,702,826,950,1074;
  door.runPipelineChain at :1244); orchestrator.ts:1125; UX through the routes.

## Diagrams (changed — genuine additions only)

- Relationships diagram: CHAT node (chat turn, run_stock_screen /
  run_options_strategy_screen) in the DISPATCH subgraph, edges CHAT --> SSW
  (screen door starts the screener workflow) and CHAT --> ENG labeled
  "options door: direct engine call, no job" (options door calls the engine
  seam directly, not runJob); MCP node (external /mcp callers, identified,
  token-authenticated), edge MCP --> DOORS labeled "pipeline commands via
  ScheduledAgent door".
- Usage diagram: SITE node widened to "Run now (door), clock firing, chat
  turn, or /mcp command" — the surfaces are alternative starting sites for
  the same single-dispatch trace. No other change.

## Could not verify / name-only / inferred

- `set_job_execution_mode` (jobExecutionModeCommands.ts:29): listed by name only;
  its behavior was not re-derived. The doc says so.
- The feed-run route's exact door method (runPipelineJob vs runPipelineChain):
  the route header says only "dispatched through the pipeline host door since
  #3578" (dataProviders.ts:12); the doc does not name a method for that route.
  (dataProviders.ts:223 calls runPipelineChain somewhere in the file; which
  handler it sits in was not verified.)
- REST section: "a schedule firing arrives with `scheduled` through
  runPipelineJobSchedule" — the callback name and its role are verified
  (jobDefinitions.ts:10-13); the trigger value it passes was NOT read from the
  callback itself, only inferred from the schedule-firing convention
  (scheduledTasksPipeline.ts:709 passes "scheduled"). Flagged as inferred.
- Options door "stamps no trigger": reasoned from the carriage (direct return,
  no job/record behind it — meshOptionsStrategyDoor.ts:20-24), not from a cited
  line stating it. No trigger field exists on that path in the code read.
- The doc's pre-existing "Mesh doors and the bridge" subsection (line ~497) still
  carries the short mesh-door/bridge summary; the new "Dispatch surfaces" section
  is the first-class treatment and cross-references the same files. No duplication
  was removed; the parent may judge whether to trim the older subsection.
