/**
 * Stock Copilot RSI Mode (Governed vs Self).
 *
 * Governed mode (default): Capability improvements requiring code changes are
 * formatted as GitHub issues conforming to docs/agents/gitops.md and published
 * to GitHub for the agentic team (#ceo-aimp, #clo-arsi, etc.) to review, build, and deploy.
 *
 * Self mode: the doc's §7 pipeline (research → sandbox synthesis → backtest →
 * StrategyCard → 1-click activation). Issue #5056: the pipeline is
 * specified-only — `stockCopilotRsiCapabilities.ts` is the single statement of
 * implementation state, and `self` resolves to `governed` with a notice until
 * that registry says otherwise. The persisted setting is still read and
 * reported as `requested`, so an operator can see what was asked for.
 *
 * Stored per login in mas_settings as `stock_copilot:rsi_mode`, with
 * deployment env fallback via `STOCK_COPILOT_RSI_MODE`.
 */
import type { Env } from "../types";
import {
  isSelfRsiPipelineImplemented,
  selfRsiModeNotice,
} from "./stockCopilotRsiCapabilities";

export type StockCopilotRsiMode = "governed" | "self";

export const COPILOT_RSI_MODE_SETTING_KEY = "stock_copilot:rsi_mode";

export const DEFAULT_COPILOT_RSI_MODE: StockCopilotRsiMode = "governed";

export function isStockCopilotRsiMode(value: unknown): value is StockCopilotRsiMode {
  return value === "governed" || value === "self";
}

export function parseStockCopilotRsiMode(raw: unknown): StockCopilotRsiMode {
  if (typeof raw !== "string") return DEFAULT_COPILOT_RSI_MODE;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "self" || normalized === "autonomous" || normalized === "self-rsi") {
    return "self";
  }
  if (normalized === "governed" || normalized === "governed-rsi" || normalized === "hitl") {
    return "governed";
  }
  return DEFAULT_COPILOT_RSI_MODE;
}

/**
 * The mode as stored/requested, before the capability gate. Kept private:
 * every caller must decide through `resolveStockCopilotRsiModeState`, so a
 * specified-only mode can never be reported as the mode in effect.
 */
function resolveRequestedStockCopilotRsiMode(opts?: {
  readSettingRaw?: (key: string) => string | null;
  env?: Env;
}): StockCopilotRsiMode {
  if (opts?.readSettingRaw) {
    const rawSetting = opts.readSettingRaw(COPILOT_RSI_MODE_SETTING_KEY);
    if (rawSetting && rawSetting.trim().length > 0) {
      return parseStockCopilotRsiMode(rawSetting);
    }
  }

  const envValue = (opts?.env as unknown as Record<string, string | undefined>)?.STOCK_COPILOT_RSI_MODE;
  if (envValue && envValue.trim().length > 0) {
    return parseStockCopilotRsiMode(envValue);
  }

  return DEFAULT_COPILOT_RSI_MODE;
}

/** The mode requested, the mode in effect, and why they differ (#5056). */
export interface StockCopilotRsiModeState {
  requested: StockCopilotRsiMode;
  effective: StockCopilotRsiMode;
  /** Set when the requested mode is specified-only; null when it is honoured. */
  notice: string | null;
}

/**
 * Resolve the mode through the capability gate. A `self` request while the
 * §7 pipeline is specified-only yields `effective: "governed"` plus the one
 * notice, never a silent downgrade.
 */
export function resolveStockCopilotRsiModeState(opts?: {
  readSettingRaw?: (key: string) => string | null;
  env?: Env;
}): StockCopilotRsiModeState {
  const requested = resolveRequestedStockCopilotRsiMode(opts);
  if (requested === "self" && !isSelfRsiPipelineImplemented()) {
    return { requested, effective: "governed", notice: selfRsiModeNotice() };
  }
  return { requested, effective: requested, notice: null };
}

/** The mode in effect (what the pathways actually run). */
export function resolveStockCopilotRsiMode(opts?: {
  readSettingRaw?: (key: string) => string | null;
  env?: Env;
}): StockCopilotRsiMode {
  return resolveStockCopilotRsiModeState(opts).effective;
}
