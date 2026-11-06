/**
 * Issue #3519 — Stock Copilot Execution Mode (Deterministic vs Agentic).
 *
 * Deterministic mode (default): the fixed pattern loop, doors, and cycles.
 * Agentic / Non-deterministic mode: the perceive-plan-critic-execute-learn loop.
 *
 * Stored per login in mas_settings as `stock_copilot:execution_mode`, with
 * deployment env fallback via `STOCK_COPILOT_EXECUTION_MODE`.
 */
import type { CopilotExecutionMode } from "../data/stockCopilotStorePorts";
import type { Env } from "../types";

export const COPILOT_EXECUTION_MODE_SETTING_KEY = "stock_copilot:execution_mode";

export const DEFAULT_COPILOT_EXECUTION_MODE: CopilotExecutionMode = "deterministic";

export function isCopilotExecutionMode(value: unknown): value is CopilotExecutionMode {
  return value === "deterministic" || value === "agentic";
}

export function parseCopilotExecutionMode(raw: unknown): CopilotExecutionMode {
  if (typeof raw !== "string") return DEFAULT_COPILOT_EXECUTION_MODE;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "agentic" || normalized === "non_deterministic" || normalized === "nd") {
    return "agentic";
  }
  if (normalized === "deterministic" || normalized === "fixed") {
    return "deterministic";
  }
  return DEFAULT_COPILOT_EXECUTION_MODE;
}

export function resolveCopilotExecutionMode(opts?: {
  readSettingRaw?: (key: string) => string | null;
  env?: Env;
}): CopilotExecutionMode {
  if (opts?.readSettingRaw) {
    const rawSetting = opts.readSettingRaw(COPILOT_EXECUTION_MODE_SETTING_KEY);
    if (rawSetting && rawSetting.trim().length > 0) {
      return parseCopilotExecutionMode(rawSetting);
    }
  }

  const envValue = (opts?.env as Record<string, string | undefined>)?.STOCK_COPILOT_EXECUTION_MODE;
  if (envValue && envValue.trim().length > 0) {
    return parseCopilotExecutionMode(envValue);
  }

  return DEFAULT_COPILOT_EXECUTION_MODE;
}
