/**
 * Issue #1806 & #1815: Feature Flags Facade & Route Matcher.
 *
 * Exposes the feature flag system and route-matching utilities.
 * Evaluation delegates to the domain FeatureFlagPort architecture in `src/features/`.
 */

import type { Env } from "../types";
import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  getOptionsProductParentFlag,
  isKnownFeatureFlag,
  OPTIONS_PRODUCT_FLAG_PARENTS,
} from "../features/featureFlagPorts";
import { createFeatureFlagPort } from "../features/createFeatureFlagPort";

export {
  ALL_FEATURE_FLAGS,
  OPTIONS_PRODUCT_FLAG_PARENTS,
  getOptionsProductParentFlag,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
};
export { createFeatureFlagPort } from "../features/createFeatureFlagPort";
export { CfFlagshipAdapter } from "../features/cfFlagshipAdapter";
export { EnvFeatureFlagAdapter } from "../features/envFeatureFlagAdapter";
export { InMemoryFeatureFlagAdapter } from "../features/inMemoryFeatureFlagAdapter";

/**
 * Evaluates whether a feature flag is enabled using the FeatureFlagPort composition root.
 */
export async function isFeatureEnabled(
  env: Env | Partial<Env> | Record<string, unknown> | undefined | null,
  flag: string,
  context?: FeatureEvaluationContext
): Promise<boolean> {
  const port = createFeatureFlagPort(env);
  return port.isEnabled(flag, context);
}

/**
 * Returns a dictionary of all known feature flags and their current evaluated states.
 */
export async function getAllFeatureFlags(
  env: Env | Partial<Env> | Record<string, unknown> | undefined | null,
  context?: FeatureEvaluationContext
): Promise<Record<FeatureFlag, boolean>> {
  const port = createFeatureFlagPort(env);
  return port.getAllFlags(context);
}

/**
 * Creates a standard JSON 404 response for a disabled feature route.
 */
export function createFeatureDisabledResponse(
  feature: FeatureFlag | string,
  status = 404
): Response {
  return Response.json(
    {
      error: `Feature '${feature}' is disabled.`,
      code: "FEATURE_DISABLED",
      feature,
    },
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Maps a request URL pathname to its owning FeatureFlag, if any.
 * Returns null if the route is not product-gated (e.g. auth, static, health).
 */
export function matchFeatureForRoute(pathname: string): FeatureFlag | null {
  const p = pathname.toLowerCase();

  // Issue #2596: per-product options routes, matched BEFORE the
  // generic screener / options_research blocks below. Order matters:
  // a specific product prefix must win over the generic prefix that
  // also matches it, and a disabled product route returns 404
  // FEATURE_DISABLED via the server gate — never a silent
  // fall-through to another product. Prefixes cover both the
  // advertised /api spelling and the handler's /trading spelling.
  // LLM evaluate has no distinct route: its modal calls
  // /api/trading/options/llm-ideas, so that route is gated by
  // options_llm_ideas, and options_llm_evaluate gates the modal
  // itself client-side (LlmStrategyEvalModal) — see the catalogue
  // in tests/options_product_slice1.test.ts and programme.md.
  if (p.startsWith("/api/options/flows") || p.startsWith("/api/trading/options/flows")) {
    return "options_flows";
  }
  if (
    p.startsWith("/api/trading/options/strategies") ||
    p.startsWith("/trading/options/strategies") ||
    p.startsWith("/api/etrade/options/strategy") ||
    p.startsWith("/trading/options/recommend")
  ) {
    return "options_strategy_panel";
  }
  if (
    p.startsWith("/api/trading/options/best-trade") ||
    p.startsWith("/trading/options/best-trade")
  ) {
    return "options_best_trade";
  }
  if (
    p.startsWith("/api/trading/options/compare") ||
    p.startsWith("/trading/options/compare") ||
    p.startsWith("/api/trading/options/comparison") ||
    p.startsWith("/trading/options/comparison")
  ) {
    return "options_compare";
  }
  if (
    p.startsWith("/api/trading/options/llm-ideas") ||
    p.startsWith("/trading/options/llm-ideas")
  ) {
    return "options_llm_ideas";
  }
  if (
    p.startsWith("/api/etrade/options/discovery-runs") ||
    p.startsWith("/etrade/options/discovery-runs") ||
    p.startsWith("/api/options/discovery-runs")
  ) {
    return "options_discovery";
  }
  if (
    p.startsWith("/api/etrade/options/iv-history") ||
    p.startsWith("/etrade/options/iv-history") ||
    p.startsWith("/api/options/iv-history")
  ) {
    return "options_iv_history";
  }
  if (
    p.startsWith("/api/options/screen") ||
    p.startsWith("/api/options/evaluate") ||
    p.startsWith("/api/options/profiles") ||
    p.startsWith("/api/options/runs") ||
    p.startsWith("/api/options/export") ||
    p.startsWith("/api/trading/options/screen") ||
    p.startsWith("/trading/options/screen")
  ) {
    return "options_contract_screen";
  }
  // Options scheduled runs have no distinct server route: they ride
  // the schedules surface (gated by "schedules") and the options
  // run routes above. options_scheduled is therefore a client-side
  // page/nav gate in slice 1, with its own server route as a later
  // slice's work — it is registered, never silently mapped here to
  // another product's route.

  // Screener pipeline (E*TRADE & market-data screeners, presets, and runs)
  if (
    p.startsWith("/api/screener") ||
    p.startsWith("/screener") ||
    p.startsWith("/api/etrade/screen") ||
    p.startsWith("/api/market-data/screen") ||
    p.startsWith("/api/market-data/compare") ||
    // #1906: deprecated aliases still route to the same handlers, so they
    // stay feature-gated identically; use canonical prefixes instead.
    // Alias removal is a follow-up.
    p.startsWith("/api/foss/screen") ||
    p.startsWith("/api/foss/compare")
  ) {
    return "screener";
  }

  // Options research & flows (generic options routes not matched above)
  if (
    p.startsWith("/api/trading/options") ||
    p.startsWith("/trading/options") ||
    p.startsWith("/api/research") ||
    p.startsWith("/research")
  ) {
    return "options_research";
  }

  // Trading orders (tickets, preview, execution)
  if (
    p.startsWith("/api/trading/orders") ||
    p.startsWith("/api/etrade/orders") ||
    p.startsWith("/api/trading/preview") ||
    p.startsWith("/api/trading/execute")
  ) {
    return "trading_orders";
  }

  // Voice trading desk
  if (p.startsWith("/api/trading/voice") || p.startsWith("/api/voice")) {
    return "voice_trading";
  }

  // Autopilot control
  if (p.startsWith("/api/autopilot") || p.startsWith("/api/trading/autopilot")) {
    return "autopilot";
  }

  // Social publishing
  if (p.startsWith("/api/social") || p.startsWith("/social")) {
    return "social_publishing";
  }

  // Natural Language Queries (NLQ)
  if (
    p.startsWith("/api/trading/nlq") ||
    p.startsWith("/api/nlq") ||
    p.startsWith("/nlq")
  ) {
    return "nlq";
  }

  // Payments & billing
  if (
    p.startsWith("/api/premium") ||
    p.startsWith("/api/payments") ||
    p.startsWith("/checkout/sandbox")
  ) {
    return "payments";
  }

  // Schedules
  if (p.startsWith("/api/schedule") || p.startsWith("/api/schedules")) {
    return "schedules";
  }

  return null;
}
