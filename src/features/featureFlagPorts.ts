/**
 * Issue #1815: Feature Flag Port (ADR 0006).
 *
 * Domain code depends ONLY on these interfaces. This module is
 * deliberately free of any Cloudflare runtime types, any provider
 * binding references, and any environment variable inspection.
 *
 * The composition root (src/features/createFeatureFlagPort.ts) wires
 * provider adapters (cloud native, environment variables, or
 * in-memory mocks) to this port; domain code never touches the adapter.
 */

export type FeatureFlag =
  | "screener"
  | "options_research"
  | "autopilot"
  | "trading_orders"
  | "voice_trading"
  | "social_publishing"
  | "nlq"
  | "payments"
  // Issue #2043: cfpay monetization gate. Default off (fail-closed).
  // Provider key "monetization": OFF = free path, ON = payment
  // workflow gate (per run-request, testnet only until gates pass).
  | "monetization"
  | "schedules"
  // Issue #1997: goal-screen workflow path. Default off (fail-closed).
  | "goal_workflow"
  | "enrichment_alpaca"
  // Issue #2049: PaymentWorkflow assurance page. Provider key
  // "payment_assurance": default ON since issue #2054 (OFF only on
  // explicit disable); ON = assurance page visible (test-only, fake
  // seams).
  | "payment_assurance"
  // Issue #2596 (Options Screener product programme, slice 1):
  // parent flag for the whole options product line. Its own parent
  // is options_research (see OPTIONS_PRODUCT_FLAG_PARENTS), so an
  // absent options_screener inherits options_research.
  | "options_screener"
  // Issue #2596: one kill-switch flag per options sub-product.
  // An explicitly OFF flag always wins; an absent flag inherits
  // options_screener (see OPTIONS_PRODUCT_FLAG_PARENTS). These are
  // rollout/kill-switch flags, not behaviour changes.
  | "options_contract_screen"
  | "options_strategy_panel"
  | "options_best_trade"
  | "options_compare"
  | "options_llm_ideas"
  | "options_llm_evaluate"
  | "options_discovery"
  | "options_scheduled"
  | "options_flows"
  | "options_iv_history";

export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  "screener",
  "options_research",
  "autopilot",
  "trading_orders",
  "voice_trading",
  "social_publishing",
  "nlq",
  "payments",
  // Issue #2043: cfpay monetization gate. Default off (fail-closed);
  // flag OFF = free path, flag ON = payment workflow gate.
  "monetization",
  "schedules",
  // Issue #1888: Alpaca enrichment selector. Default off (fail-closed)
  // means Yahoo enrichment is active; flipping this flag on selects
  // Alpaca-primary-with-Yahoo-fallback with no code change.
  "enrichment_alpaca",
  // Issue #1997: goal-screen workflow path. Default off (fail-closed);
  // flag OFF = the direct engine, flag ON = the staged goal flow.
  "goal_workflow",
  // Issue #2049: PaymentWorkflow assurance page, registered here.
  // Default is ON since issue #2054 (adapters); an explicit
  // disable still wins everywhere.
  "payment_assurance",
  // Issue #2596: options product line (parent + per-product flags).
  // Defaults are resolved by inheritance in the adapters, never here:
  // an absent flag inherits its parent, an explicit OFF always wins.
  "options_screener",
  "options_contract_screen",
  "options_strategy_panel",
  "options_best_trade",
  "options_compare",
  "options_llm_ideas",
  "options_llm_evaluate",
  "options_discovery",
  "options_scheduled",
  "options_flows",
  "options_iv_history",
] as const;

/**
 * Issue #2596: parent flag for each options product flag.
 *
 * Inheritance chain (resolved by every adapter, not by callers):
 *   per-product flag (absent) -> options_screener (absent)
 *   -> options_research -> the adapter's normal default for that flag.
 * An explicitly set per-product flag (ON or OFF) never consults its
 * parent, so an explicit OFF always wins even when the parent is ON.
 * Stock screener products need no new flag: the stock screener and
 * the strategy scanner are already gated by "screener".
 */
export const OPTIONS_PRODUCT_FLAG_PARENTS: Readonly<
  Record<string, FeatureFlag>
> = {
  options_screener: "options_research",
  options_contract_screen: "options_screener",
  options_strategy_panel: "options_screener",
  options_best_trade: "options_screener",
  options_compare: "options_screener",
  options_llm_ideas: "options_screener",
  options_llm_evaluate: "options_screener",
  options_discovery: "options_screener",
  options_scheduled: "options_screener",
  options_flows: "options_screener",
  options_iv_history: "options_screener",
} as const;

export function getOptionsProductParentFlag(
  flag: string
): FeatureFlag | null {
  return OPTIONS_PRODUCT_FLAG_PARENTS[flag] ?? null;
}

const KNOWN_FLAGS = new Set<string>(ALL_FEATURE_FLAGS);

export function isKnownFeatureFlag(flag: string): flag is FeatureFlag {
  return KNOWN_FLAGS.has(flag);
}

export interface FeatureEvaluationContext {
  userId?: string;
  userLogin?: string;
  environment?: string;
  [key: string]: unknown;
}

/**
 * Port interface for feature flag evaluation.
 * Conforms to OpenFeature provider evaluation semantics.
 */
export interface FeatureFlagPort {
  /**
   * Returns whether a named feature flag is enabled for the given context.
   * Must fail closed (return false) on unknown flags, missing config, or provider errors.
   */
  isEnabled(flag: string, context?: FeatureEvaluationContext): Promise<boolean>;

  /**
   * Evaluates all known feature flags and returns a map of flag name to boolean status.
   */
  getAllFlags(context?: FeatureEvaluationContext): Promise<Record<FeatureFlag, boolean>>;
}
