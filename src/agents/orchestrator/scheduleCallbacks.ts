/**
 * Schedule-callback allow-lists, moved verbatim from src/agents/orchestrator.ts
 * by issue #2942 (the route dispatcher that consumed them moved with it).
 * src/agents/orchestrator.ts re-exports the public names, so the module
 * surface is unchanged.
 */
/**
 * Callbacks a caller may arm through POST /api/schedules/create (#111).
 *
 * This route is the public way to create schedules, so it accepts only
 * user-creatable jobs. Internal-only callbacks — `executeAsyncJob` (the
 * async-job plumbing) and `expireStaleOrderDraft` (order-draft expiry) —
 * are armed by the agent itself and are deliberately NOT in this list;
 * the route rejects them with HTTP 400. Only stock screening, options
 * screening, and saved-request strategy discovery (issue #126)
 * callbacks can be created through this route. NLQ scheduling (#109)
 * uses its separate agent scheduling port.
 */
export const CREATABLE_SCHEDULE_CALLBACKS = [
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
  // Consolidation C1 (issue #1201, epic #1151 R1): goal-driven
  // screens are schedulable through the one schedule store.
  "autonomousGoalScreen",
  // Issue #4366 — a job defined from the externalized definition spec is
  // schedulable through the same store; the callback runs that engine job
  // by id (the definition carries the owner params, so the payload needs
  // only the id).
  // Issue #5100 (F3 of #5094) — deliberately NOT in
  // ACCOUNT_SCOPED_SCHEDULE_CALLBACKS: a pipeline job is broker-free by
  // construction. Its stages run feed → enrich → analyze → generate →
  // deliver over market data and reports; the stage files carry no
  // broker reads, no order placement, and no broker/account params, so
  // there is no tuple to stamp and no fire-time enforcement to apply.
  "runPipelineJobSchedule",
  // Issue #6298 (#6029 (a)) — the OODA research run as a stored schedule.
  // Its own callback rather than `runPipelineJobSchedule`: the research job's
  // stage dependencies are wired only in the engine seam
  // (`runResearchAndPublish` / `dispatchResearchEngineRun`), while the
  // ScheduledAgent door registers the fail-closed defaults, so a pipeline-job
  // dispatch would stop at `FAILURE_RESEARCH_DEPS_MISSING` instead of running
  // the six stages. Not account-scoped for the same reason
  // `runPipelineJobSchedule` is not: the run resolves its venue from the tenant
  // binding at run time (`resolveResearchVenue`, #6036) and refuses an
  // unsupported pair by name — no per-schedule tuple is stamped.
  "runResearchSchedule",
] as const;

export const ACCOUNT_SCOPED_SCHEDULE_CALLBACKS = new Set<string>([
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
  "autonomousGoalScreen",
]);

export type CreatableScheduleCallback = (typeof CREATABLE_SCHEDULE_CALLBACKS)[number];

/**
 * Issue #3788 — internal-only callbacks whose orchestrator methods
 * now record their own runs (recordScheduleCallbackRun wrappers on
 * the class methods, mirroring the creatable four). Before this
 * slice, SDK firings of these four left no per-run record (the
 * #2964 carried gap): executeAsyncJob (async-job plumbing),
 * expireStaleOrderDraft (order-draft expiry), collectIvHistory (IV
 * collection), and the brokerage token-renewal callback.
 * Manual triggers of these callbacks are recorded exactly once:
 * the trigger route treats this set like the creatable set (the
 * method wrapper records; the route must not wrap them again).
 * Issue #4186 — the sixth member, `sendScheduledReminder` (the
 * NLQ-armed reminder callback, not REST-creatable): its SDK
 * firings left no per-run record until this slice wrapped its
 * method the same way.
 */
export const INTERNAL_RECORDED_SCHEDULE_CALLBACKS = [
  "executeAsyncJob",
  "expireStaleOrderDraft",
  "collectIvHistory",
  "autoRenewETradeTokens",
  // Issue #3121 #3310 — the per-stage workflow firing callback.
  "runWorkflowStage",
  // Issue #4186 — the NLQ-armed reminder callback.
  "sendScheduledReminder",
] as const;

/**
 * Issue #3788 — every callback with a per-run ledger record: the
 * set the schedule watchdog can observe (and therefore the set it
 * watches). Any callback outside this set is skipped by the
 * watchdog, counted, and named — never flagged on evidence it
 * cannot see.
 */
export const RECORDED_SCHEDULE_CALLBACKS: readonly string[] = [
  ...CREATABLE_SCHEDULE_CALLBACKS,
  ...INTERNAL_RECORDED_SCHEDULE_CALLBACKS,
];
