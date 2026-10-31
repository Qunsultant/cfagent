/**
 * Issue #992: the OrchestratorAgent class-body inventory — standing
 * gate for the #992 decomposition of src/agents/orchestrator.ts.
 *
 * #359's breakup closed at 2,802 lines; two days of feature work
 * regrew the file to 3,427 lines / 148,783 B (tip 57fedf37) because
 * nothing pinned the class body the way thin_router_inventory pins
 * the route dispatcher. #992 extracted 45 methods into eight modules
 * under src/agents/orchestrator/ (scheduleMaintenance,
 * scheduledCallbacks, nlqPorts, asyncJobs, autopilot, reportDispatch,
 * chatTurnHelpers, httpEntry). Subset 2 then extracted the
 * research-publish cluster into a ninth module (researchPublish),
 * leaving the class at 1,977 lines / 89,925 B: state/lifecycle
 * ownership, the Think lifecycle, ensureTables, the stale-task
 * sweep, autonomousOptionsAnalysis and routeRequest stay in the
 * class; the extracted clusters execute only through thin delegating
 * wrappers + the per-module context builders.
 *
 * This pin fails if:
 *  (a) orchestrator.ts grows beyond the post-refactor budget —
 *      BUDGET_LINES / BUDGET_BYTES below (the measured result plus
 *      ~5% headroom; regrowth like the post-#359 +596 lines trips it
 *      immediately);
 *  (b) execution owned by the extracted modules reappears inline in
 *      the class (the INSERT markers and store constructions below),
 *      or new schedule registrations are added inline instead of in
 *      the extracted modules (the this.schedule / this.scheduleEvery
 *      call-site counts are capped at the post-refactor counts:
 *      routeRequest's contexts, the retained arming sites, and the
 *      context builders' binding arrows);
 *  (c) any delegating wrapper disappears from the class — the SDK
 *      dispatches scheduled callbacks by method name, so every name
 *      below must stay declared on the class;
 *  (d) an extracted module loses the execution marker it owns.
 *
 * Deliberate growth updates this pin in the same change (the #359
 * pin rule); the pin's purpose is that class-body regrowth is never
 * unintentional. The one retained inline construction,
 * `new ScheduledTasksService(` for autonomousOptionsAnalysis (count
 * exactly 1), is deliberate: that method is pinned in place by
 * tests/options_latest_runs.test.ts, whose span pin asserts the
 * class-scope call form `recordOptionsRun(this.ctx.storage…`, which
 * the module-call pattern cannot reproduce. The stale-task sweep
 * pair (sweepStaleLedgerTasks / ensureStaleSweepSchedule) is
 * retained for the same reason: tests/stale-sweep-wiring.test.ts
 * asserts the class-scope form
 * `scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS…`. Both clusters stay
 * until those pins are revisited deliberately in a follow-up slice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");
const ORCH = "agents/orchestrator.ts";

/** Post-refactor budget for orchestrator.ts (result: 1,977 lines / 89,925 B).
 *  Raised deliberately in the same change (the pin rule above):
 *  consolidation C1 (#1201) adds the autonomousGoalScreen delegating
 *  wrapper + its creatable/account-scoped list entries — measured
 *  95,030 B after the addition; budget keeps ~270 B headroom.
 *  Consolidation C3 (#1277) adds the POST /jobs/:id/retry route in
 *  onRequest + the retryAsyncJob delegating wrapper (execution in
 *  orchestrator/asyncJobs.ts) and one stageChain field on the
 *  autonomousMarketScreen wrapper — measured 2,079 lines / 96,028 B
 *  after the addition; budget keeps similar headroom.
 *  Channel consolidation (#1262) adds channel wireup — measured
 *  2,079 lines / 97,953 B; budget keeps ~350 B headroom.
 *  R2 knowledge corpus S1 (#1169, supersedes PR #1510) adds the
 *  knowledgeCorpus delegating wrapper + its import — measured
 *  2,109 lines / 97,520 B after the addition (main alone, with
 *  #1495's presets, already sat at 2,093 lines); budget keeps
 *  similar headroom. This is the documented deliberate-growth
 *  update, not a weakened assertion: the pin still fails on any
 *  further unintentional regrowth.
 *  Service-path blob capture (#1661) adds two getStorage
 *  delegating accessors + comments — measured 2,124 lines /
 *  98,517 B after the addition on the pre-merge tree.
 *  Slice 2 shard jobs projection (#1676) adds the
 *  reconcileShardJobProjection delegating wrapper + its import
 *  (execution in orchestrator/shardJobReconcile.ts) — measured
 *  2,125 lines / 98,706 B after the addition (main alone already
 *  sat at 2,120 lines / 98,291 B, 9 B of headroom); budget keeps
 *  similar headroom.
 *  Feed seam (#1236) adds one binding arrow, submitAsyncJob, on
 *  the schedules route context for the feed-snapshot route (the
 *  class itself gains no logic) — combined tree measured
 *  2,126 lines / 98,774 B; BUDGET_LINES keeps #1676's 2130 and
 *  BUDGET_BYTES keeps the slice's 103_300 (measured 98_359 +
 *  ~5% headroom at slice time, the pin's convention).
 *  Slice 3 audit + reports projection (#1688) adds the
 *  seedCanonicalReports delegating wrapper + its import
 *  (execution in orchestrator/canonicalReportSeed.ts) —
 *  measured 2,143 lines / 99,642 B after the addition on the
 *  pre-#1236 tree; budget lines rise to 2150 and bytes keep
 *  Combined #1661 merge tree measured 2,148 lines / 99,936 B;
 *  budget lines keep 2150 and bytes keep 103_300, which still
 *  cover the combined tree.
 *  Knowledge + memory unification (#1723, parent #1717 slice (c))
 *  passes Worker env into the memory route call site (MEMORY_READ_MODE
 *  env level on GET /memory) — measured 2,152 lines / 100,195 B
 *  after the addition; budget lines rise to 2160, bytes keep
 *  103_300, which still cover the tree.
 *  Screener workflows (#1737) add the two PUBLIC workflow
 *  doors (recordWorkflowScreenReport +
 *  deliverWorkflowScreenOutcome) + their doc comment —
 *  measured 2,192 lines / 101,411 B on the rebased tree;
 *  budget lines rise to 2200, bytes keep 103_300.
 *  Async jobs systems unification (#1724, parent #1717 slice (d))
 *  adds the DO-entry delivery + list-envelope resolution to onRequest
 *  (HTTP_DELIVERY_MODE queue decision, JOB_LIST_ENVELOPE list branch,
 *  scoped-carrier fields, /mcp route wiring) — measured 2,278 lines
 *  / 105,064 B after the addition on the tree rebased onto #1737;
 *  budget lines rise to 2280 and bytes rise to 109_100, which still
 *  cover the tree.
 *  Agents SDK actors (#1738) migrate Orchestrator/Research/Trading
 *  from Think to Agent<Env> behind the actor port: the actor
 *  session/turn/runner wiring (getActorSession, createActorTurnRunner,
 *  getMessages/addMessages, waitUntilStable poll, abort/reset/clear
 *  for the memory-reset route, turnEpoch) + comment updates —
 *  measured on the pre-rebase tree 2,315 lines / 106,258 B; the
 *  combined tree with #1724/#1725 measures 2,401 lines /
 *  109,911 B, so budget lines rise to 2410 and bytes to 110_500.
 *  AI Gateway (#1741) wires the actor turn through the gateway
 *  port (two imports + gateway/modelTurn selection in
 *  createActorTurnRunner; the turn execution itself lives in
 *  src/gateway/, the class gains no logic) — measured 2,411
 *  lines / 110,562 B on the rebased tree, so budget lines rise
 *  to 2420 and bytes to 111_200.
 *  Observability (#1743) wires the actor turn's gateway emit
 *  to the stream sink (two imports + emit closure in
 *  createActorTurnRunner; the stream lives in src/observability/,
 *  the class gains no logic) — measured 2,420 lines / 111,043 B
 *  on the rebased tree, so budget lines rise to 2430 and bytes
 *  to 112_000.
 *  REST-REST twins (#1733, parent #1717 slice (m)) passes
 *  env into the audit-routes call (one line, the AUDIT_WRITE_MODE
 *  global-env level; the switch itself lives in
 *  src/config/restTwinsModes.ts, the class gains no logic) —
 *  measured 2,431 lines / 111,643 B after the addition, so
 *  budget lines rise to 2440 and bytes keep 112_000.
 *  Payments re-scope (#1735, parent #1717 slice (o)) adds the
 *  scopedPaymentsFlowModes carrier field + its import + the
 *  payments-routes call-site passthrough (the switch itself lives
 *  in src/config/paymentsFlowModes.ts, the class gains no logic) —
 *  measured 2,447 lines / 112,495 B after the addition, so
 *  budget lines rise to 2450 and bytes rise to 113_000.
 *  Think fleet (#1952, tracker #1951) migrates the class from
 *  Agent to PortThink: the Think turn facet + epoch-gated wrapper,
 *  the port* domain-hook renames (PortThink owns the
 *  Think-signature names), the port-transcript accessor renames
 *  (Think owns getMessages/addMessages/runTurn), and the dual-store
 *  clear — measured 2,507 lines / 115,690 B after the migration,
 *  so budget lines rise to 2520 and bytes rise to 116_500.
 *  Goal Screen workflow submission (#1996, #1972 slice 1) adds
 *  the two PUBLIC goal doors (recordWorkflowGoalScreenReport +
 *  deliverWorkflowGoalScreenOutcome) + their imports
 *  (execution in orchestrator/goalScreenDispatch.ts) — measured
 *  2,547 lines / 116,920 B after the addition, so budget lines
 *  rise to 2560 and bytes rise to 117_500.
 *  Live PaymentWorkflow assurance (#2059) mounts the new route
 *  module (one import + one call site between the payments and
 *  agentic-payments handlers; the route logic itself lives in
 *  routes/paymentAssuranceLive.ts, the class gains no logic) —
 *  measured 2,571 lines / 117,949 B after the addition, so
 *  budget lines rise to 2580 and bytes rise to 118_500.
 *  A2A door (#2223 slice 1) adds the thin handleA2A delegating
 *  method + its import (execution in
 *  orchestrator/a2aDispatch.ts; the class gains no logic beyond
 *  wiring its storage/audit/session and NLQ ports into the
 *  dispatch) — measured 2,608 lines / 119,919 B after the
 *  addition, so budget lines rise to 2620 and bytes rise
 *  to 120_500.
 *  Data foundation step 1 (#2303, #1976 step 1) wires the
 *  data-provider ports into the class (two adapter type imports
 *  + the lazy dataProviderPorts() accessor building the provider
 *  config/capture ports from env, passed into the data-provider
 *  routes; execution in src/data/) — at budget on its build
 *  base, but main's #2280 retention/resource work (ORM execQuery
 *  cursor measurement to the resource sink) regrew the class in
 *  the same window — measured 2,631 lines / 121,082 B on the
 *  merged tree, so budget lines rise to 2640 and bytes rise
 *  to 121_700.
 *  Agent Mesh S3 (#2327) makes the research-stub helper fail
 *  closed on a missing identity (the getResearchAgent guard +
 *  its comment; no new logic surface) — measured 2,646 lines /
 *  121,915 B on the merged tree (over #2303's step-1 wiring),
 *  so budget lines rise to 2660 and bytes rise to 122_500.
 *  Agent Mesh S5 (#2341) adds one field to the chat-turn helpers
 *  context — the turnUserLogin resolver the mesh doors read their
 *  acting identity through (the door logic itself lives in
 *  orchestrator/meshDoors.ts; the class gains no logic) —
 *  measured 2,650 lines / 122,177 B on the branch tree, so the
 *  budgets keep 2660 / 122_500, which still cover the tree.
 *  Agent Mesh S8 (#2369) adds two fields to the NLQ ports
 *  context — env + ensureTables, which the chat screen's
 *  workflow start and mas_reports read-back read through
 *  orchestrator/nlqPorts.ts (the class gains no logic) —
 *  measured 2,654 lines / 122,537 B on the branch tree, so
 *  budget bytes rise to 122_700; lines keep 2660.
 *  Service-user provisioning (#2331 slice 1) wires the new route
 *  module (one import + one call site after the maintenance
 *  delegation; the route logic itself lives in
 *  routes/serviceUser.ts, the class gains no logic) — measured
 *  2,663 lines / 123,052 B on the branch tree, so budget lines
 *  rise to 2670 and bytes rise to 123_200.
 *  Agent Mesh S15 (#2421) restores the class's handleA2A wiring
 *  (one import + the thin delegation to
 *  orchestrator/a2aDispatch.ts, which #2178 left caller-less;
 *  the dispatch logic itself lives in that module, the class
 *  gains no new logic surface) — measured 2,641 lines /
 *  123,727 B on the branch tree, so budget bytes rise to
 *  123_900; lines keep 2670.
 *  Agent Mesh S17 (#2428) adds the turn's mesh-trace mint (two
 *  imports + the turnTraceparent() lazy mint on the turn stash
 *  + one resolver line in each of chatTurnHelpersContext and
 *  nlqPortsContext; the recording/assembly logic lives in
 *  data/createMeshTracePorts.ts + observability/meshTrace.ts,
 *  the class gains no logic surface) — measured 2,693 lines /
 *  125,930 B on the branch tree, so budget lines rise to 2700
 *  and bytes rise to 126_100.
 *  Issue #2457 adds the admin tenant-queue delegation (import +
 *  onRequest early branch + routeRequest delegation, no logic in
 *  the class) — measured 2,714 lines / 127,049 B, so budget lines
 *  rise to 2725 and bytes rise to 127_250.
 *  Issue #2482 adds the broker environment selection resolution
 *  (import + dispatcher binding + writeSetting on both broker
 *  contexts) — measured 2,726 lines / 127,725 B, so budget lines
 *  rise to 2735 and bytes rise to 128_250.
 *  Issue #2489 adds the KV wipe delegation (import + onRequest
 *  early branch + routeRequest delegation, no logic in the class)
 *  — measured 2745 lines / 128577 B, so budget lines rise to
 *  2760 and bytes rise to 129_250.
 *  Issue #2530 adds the screener-interpretation audit door
 *  (recordWorkflowScreenInterpretationAudit — one recordAudit
 *  delegation, no logic in the class) — measured 2,784 lines /
 *  130,352 B, so budget lines rise to 2795 and bytes rise to
 *  131_250. */
const BUDGET_LINES = 2795;
const BUDGET_BYTES = 131_250;

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

const DELEGATED_METHODS = [
  // scheduleMaintenance
  "getScreenerExecutionContext",
  "migrateLegacyScreenSchedules",
  "removeUnownedBaselineSchedules",
  "ensureStrategyScanSchedule",
  // scheduledCallbacks
  "autoRenewETradeTokens",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
  "collectIvHistory",
  "expireStaleOrderDraft",
  "sendScheduledReminder",
  // nlqPorts
  "nlqSchedulingPort",
  "nlqStockScreenPort",
  // asyncJobs
  "submitAsyncJob",
  "recoverQueuedAsyncJobs",
  "getAsyncJob",
  "listAsyncJobs",
  "executeAsyncJob",
  // autopilot
  "marketDateKey",
  "readAutopilotStateRaw",
  "getAutopilotState",
  "writeAutopilotState",
  "incrementAutopilotOrdersToday",
  "fetchBrokerBalanceSnapshot",
  "openNotionalForSymbol",
  "evaluateAndRecordAutopilotVerdict",
  // reportDispatch
  "readSettingRaw",
  "writeSetting",
  "getReportDispatchHitl",
  "setReportDispatchHitl",
  "createReportConfirmation",
  "getReportConfirmation",
  "decideReportConfirmation",
  "storeResearchReportCanonicalAsync",
  "confirmationDeliveryMeta",
  "deliverStoredReportEmail",
  "deliverStoredReportWebhook",
  "persistScreenerReportCanonical",
  "sendReportEmail",
  "sendReportWebhook",
  // chatTurnHelpers
  "extractMessageText",
  "createTurnTools",
  "deriveTurn",
  "assembleGrounding",
  // httpEntry
  "logChatActivity",
  "enqueueHttpRequest",
  // researchPublish
  "runResearchAndPublish",
  "deliverResearchReport",
  "sendResearchSummaryEmail",
];

describe("orchestrator class inventory (#992 standing gate)", () => {
  it("keeps orchestrator.ts within the post-refactor size budget", () => {
    const text = src(ORCH);
    const lineCount =
      text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    expect(lineCount).toBeLessThanOrEqual(BUDGET_LINES);
    const byteCount = Buffer.byteLength(text.replace(/\r\n/g, "\n"), "utf8");
    expect(byteCount).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("keeps extracted execution out of the class body", () => {
    const text = src(ORCH);
    for (const marker of [
      "INSERT INTO mas_async_jobs",
      "INSERT INTO mas_policy_verdicts",
      "INSERT INTO mas_report_confirmations",
      "INSERT INTO mas_autopilot",
      "INSERT INTO mas_settings",
      "new SqlDiscoveryRunStore(",
      "new SqlIvHistoryStore(",
    ]) {
      expect(count(text, marker), marker).toBe(0);
    }
    // Deliberate retention: autonomousOptionsAnalysis only (see header).
    expect(count(text, "new ScheduledTasksService(")).toBe(1);
  });

  it("caps inline schedule registrations at the post-refactor counts", () => {
    const text = src(ORCH);
    expect(count(text, "this.schedule(")).toBeLessThanOrEqual(6);
    expect(count(text, "this.scheduleEvery(")).toBeLessThanOrEqual(3);
  });

  it("keeps every delegated method declared on the class", () => {
    const text = src(ORCH);
    for (const name of DELEGATED_METHODS) {
      const declared = new RegExp(
        `^  (private )?(async )?${name}\\(`,
        "m",
      ).test(text);
      expect(declared, name).toBe(true);
    }
  });

  it("keeps the extracted modules present with their execution markers", () => {
    // #2388 exception (owner-authorized 2026-10-30, #2331 comment
    // 6515869065): asyncJobs.ts serves its table through the
    // async-job ports (createAsyncJobPorts) instead of holding the
    // INSERT statements — the same ports pattern as the #2359 pin
    // updates below; the statements live in
    // src/data/doSqliteAsyncJobAdapter.ts. This is an exception
    // change to a #992 shared-gate expectation, not slice work.
    expect(src("agents/orchestrator/asyncJobs.ts")).toContain(
      "createAsyncJobPorts",
    );
    // #2359 (#1976 step 4d) pin update: the extracted modules
    // now serve their tables through the data layer's
    // orchestrator-table ports instead of holding the INSERT
    // statements — the markers' intent (these modules own
    // their tables' composition for the class) is unchanged;
    // the statements moved behind the ports (same pattern as
    // the #2358 update above).
    expect(src("agents/orchestrator/autopilot.ts")).toContain(
      "createOrchestratorTablePorts(",
    );
    expect(src("agents/orchestrator/autopilot.ts")).toContain(
      ".verdicts",
    );
    expect(src("agents/orchestrator/reportDispatch.ts")).toContain(
      "createOrchestratorTablePorts(",
    );
    expect(src("agents/orchestrator/reportDispatch.ts")).toContain(
      ".confirmations",
    );
    // #2337 (#1976 step 2) pin update: the extracted module now
    // composes the discovery-run / IV stores through the data
    // layer's composition root instead of constructing the SQL
    // stores directly — the marker's intent (this module owns
    // the store composition for its callbacks) is unchanged;
    // the construction form moved behind the ports.
    expect(src("agents/orchestrator/scheduledCallbacks.ts")).toContain(
      "createOptionsDiscoveryPorts(",
    );
    expect(src("agents/orchestrator/scheduledCallbacks.ts")).toContain(
      ".discoveryRuns",
    );
    expect(src("agents/orchestrator/scheduledCallbacks.ts")).toContain(
      ".ivHistory",
    );
    expect(src("agents/orchestrator/researchPublish.ts")).toContain(
      "storeReportAtGeneration(",
    );
  });
});
