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
 */
export const INTERNAL_RECORDED_SCHEDULE_CALLBACKS = [
  "executeAsyncJob",
  "expireStaleOrderDraft",
  "collectIvHistory",
  "autoRenewETradeTokens",
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
