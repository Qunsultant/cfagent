/**
 * Stock Copilot RSI Mode (Governed vs Self).
 *
 * Governed mode (default): Capability improvements requiring code changes are
 * formatted as GitHub issues conforming to docs/agents/gitops.md and published
 * to GitHub for the agentic team (#ceo-aimp, #clo-arsi, etc.) to review, build, and deploy.
 *
 * Self mode: Improvements are developed and backtested autonomously by the agent
 * using platform tools (SandboxAgent, BrowserAgent) upon approval, and surfaced
 * as 1-click activation cards.
 *
 * Stored per login in mas_settings as `stock_copilot:rsi_mode`, with
 * deployment env fallback via `STOCK_COPILOT_RSI_MODE`.
 */
import type { Env } from "../types";

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

export function resolveStockCopilotRsiMode(opts?: {
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

