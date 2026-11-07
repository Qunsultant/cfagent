/**
 * Effective live/paper mode for a scheduled run (issue #3655, item 4
 * as amended 2026-11-07).
 *
 * The schedule's stated environment is NOT the run's mode. For
 * Alpaca, resolveAlpacaTradingBase (src/trading/alpaca/platform.ts)
 * prioritizes an explicit env.ALPACA_TRADING_TYPE="live" pin over the
 * schedule's environment (overrideEnv="TEST"): a run can execute LIVE
 * while its schedule says paper. #3668 owns the toggle itself — this
 * module does not re-fix it. What this module does is record what
 * actually governed the run, so the run record can never claim
 * "paper" while the run executed live:
 *
 *   mode: the EFFECTIVE live/paper mode for this run.
 *   isLive: the same fact as a boolean (mode === "live"), carried
 *     explicitly so a reader never has to re-derive it.
 *   modeSource: which resolver leg produced it —
 *     "pin" (an explicit ALPACA_TRADING_TYPE deployment pin),
 *     "selection" (the tenant's schedule environment, TEST→paper /
 *       PROD→live, the catalog mapping), or
 *     "inference" (the Alpaca base URL's host, paper-api or not).
 *
 * For a non-Alpaca broker there is no pin/inference leg: the mode is
 * the catalog mapping of (broker, environment), source "selection",
 * and undefined when the environment is missing — mode is never
 * guessed from a missing environment. For Alpaca the mode is always
 * resolvable (the inference leg is the fallback), even with no
 * environment at all.
 *
 * The Alpaca resolver is imported LAZILY (dynamic import), never
 * statically: providerConnections sits on a load cycle with the
 * trading barrel, and static imports of resolver-adjacent modules
 * have bound UnifiedOptionsService to the real broker reader instead
 * of a test's vi.mock of it (see scheduledBrokerGuard.ts).
 */

import { tradingTypeFor } from "../trading";
import type { BrokerId } from "./tenantProviders";
import type { Env } from "../types";

/** Which resolver leg produced the run's effective mode. */
export type EffectiveModeSource = "pin" | "selection" | "inference";

export interface ScheduledEffectiveMode {
  /** The mode the run actually executed under. */
  mode: "live" | "paper";
  /** mode === "live", carried explicitly so the record states it twice. */
  isLive: boolean;
  /** pin | selection | inference — see the module header. */
  modeSource: EffectiveModeSource;
}

export function isEffectiveModeSource(value: unknown): value is EffectiveModeSource {
  return value === "pin" || value === "selection" || value === "inference";
}

/**
 * Resolve the effective mode for a scheduled run. Never throws: a
 * resolver failure yields undefined (the run records no mode) rather
 * than a guessed one — except the Alpaca inference leg, which always
 * resolves from the base URL.
 */
export async function resolveScheduledEffectiveMode(args: {
  env: Partial<Env>;
  brokerId: BrokerId | string;
  environment?: string;
}): Promise<ScheduledEffectiveMode | undefined> {
  const { env, brokerId, environment } = args;
  try {
    if (brokerId === "alpaca") {
      // Issue #3655: resolved through the public trading barrel, never
      // a trading-internal path (#290 boundary).
      const { resolveAlpacaTradingBase } = await import("../trading");
      const resolved = resolveAlpacaTradingBase(env as Env, environment);
      return {
        mode: resolved.isLive ? "live" : "paper",
        isLive: resolved.isLive,
        modeSource: resolved.source,
      };
    }
    if (environment !== "TEST" && environment !== "PROD") return undefined;
    const mode = tradingTypeFor(brokerId as BrokerId, environment);
    return { mode, isLive: mode === "live", modeSource: "selection" };
  } catch {
    return undefined;
  }
}
