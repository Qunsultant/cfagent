/**
 * Issue #3514 — Stock Copilot Dynamic Universe and Strategy Configuration.
 *
 * Externalizes universe and strategy settings to `mas_settings` per tenancy,
 * providing presets (NASDAQ100, SP100, MEGA_TECH, SEMIS) and dynamic lists
 * across all channel surfaces (Chat, Schedule, MCP, Webhook).
 */

import type { Env } from "../types";
import {
  SANDBOX_STRATEGY_IDS,
  type SandboxStrategyId,
} from "./patternSignals";

export const COPILOT_UNIVERSE_SETTING_KEY = "stock_copilot:universe";
export const COPILOT_STRATEGIES_SETTING_KEY = "stock_copilot:strategies";

export const DEFAULT_COPILOT_UNIVERSE: readonly string[] = [
  "SPY",
  "QQQ",
  "AAPL",
  "MSFT",
  "NVDA",
];

export const DEFAULT_COPILOT_STRATEGIES: readonly SandboxStrategyId[] = [
  "sma_crossover",
  "mean_reversion",
];

export const PRESET_UNIVERSES: Record<string, readonly string[]> = {
  NASDAQ100: [
    "QQQ",
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "META",
    "GOOGL",
    "TSLA",
    "AVGO",
    "COST",
    "AMD",
    "NFLX",
  ],
  SP100: [
    "SPY",
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "GOOGL",
    "META",
    "BRK.B",
    "LLY",
    "JPM",
    "V",
    "UNH",
  ],
  MEGA_TECH: [
    "AAPL",
    "MSFT",
    "GOOGL",
    "AMZN",
    "NVDA",
    "META",
    "TSLA",
  ],
  SEMIS: [
    "NVDA",
    "AMD",
    "AVGO",
    "TSM",
    "QCOM",
    "INTC",
    "MU",
    "ARM",
  ],
};

function normalizePresetKey(key: string): string {
  return key.trim().toUpperCase().replace(/[-_\s]/g, "");
}

export function parseUniverseInput(input: string | readonly string[]): string[] {
  if (Array.isArray(input)) {
    const list = input
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    return list.length > 0 ? Array.from(new Set(list)) : [...DEFAULT_COPILOT_UNIVERSE];
  }

  if (typeof input !== "string" || input.trim().length === 0) {
    return [...DEFAULT_COPILOT_UNIVERSE];
  }

  const raw = input.trim();

  // Check JSON array
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parseUniverseInput(parsed);
      }
    } catch {
      // Fall through to comma-separated
    }
  }

  // Check preset name
  const normKey = normalizePresetKey(raw);
  for (const [presetName, presetSymbols] of Object.entries(PRESET_UNIVERSES)) {
    if (normalizePresetKey(presetName) === normKey) {
      return [...presetSymbols];
    }
  }

  // Comma or whitespace separated list
  const symbols = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  return symbols.length > 0 ? Array.from(new Set(symbols)) : [...DEFAULT_COPILOT_UNIVERSE];
}

export function parseStrategiesInput(
  input: string | readonly string[],
): SandboxStrategyId[] {
  if (Array.isArray(input)) {
    const valid = input.filter((id): id is SandboxStrategyId =>
      (SANDBOX_STRATEGY_IDS as readonly string[]).includes(id),
    );
    return valid.length > 0 ? Array.from(new Set(valid)) : [...DEFAULT_COPILOT_STRATEGIES];
  }

  if (typeof input !== "string" || input.trim().length === 0) {
    return [...DEFAULT_COPILOT_STRATEGIES];
  }

  const raw = input.trim();

  if (raw.toLowerCase() === "all" || raw === "*") {
    return [...SANDBOX_STRATEGY_IDS];
  }

  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parseStrategiesInput(parsed);
      }
    } catch {
      // Fall through
    }
  }

  const tokens = raw
    .toLowerCase()
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter((t): t is SandboxStrategyId =>
      (SANDBOX_STRATEGY_IDS as readonly string[]).includes(t),
    );

  return tokens.length > 0 ? Array.from(new Set(tokens)) : [...DEFAULT_COPILOT_STRATEGIES];
}

export function resolveCopilotUniverse(opts?: {
  readSettingRaw?: (key: string) => string | null;
  env?: Env;
}): string[] {
  if (opts?.readSettingRaw) {
    const rawSetting = opts.readSettingRaw(COPILOT_UNIVERSE_SETTING_KEY);
    if (rawSetting && rawSetting.trim().length > 0) {
      return parseUniverseInput(rawSetting);
    }
  }

  const envRaw = (opts?.env as unknown as Record<string, string | undefined>)?.STOCK_COPILOT_UNIVERSE;
  if (envRaw && envRaw.trim().length > 0) {
    return parseUniverseInput(envRaw);
  }

  return [...DEFAULT_COPILOT_UNIVERSE];
}

export function resolveCopilotUniversePreset(universe: readonly string[]): string | null {
  const normalized = universe.map((s) => s.trim().toUpperCase());
  for (const [presetName, presetSymbols] of Object.entries(PRESET_UNIVERSES)) {
    if (
      normalized.length === presetSymbols.length &&
      normalized.every((sym, idx) => sym === presetSymbols[idx])
    ) {
      return presetName;
    }
  }
  if (
    normalized.length === DEFAULT_COPILOT_UNIVERSE.length &&
    normalized.every((sym, idx) => sym === DEFAULT_COPILOT_UNIVERSE[idx])
  ) {
    return "DEFAULT";
  }
  return null;
}

export function resolveCopilotStrategies(opts?: {
  readSettingRaw?: (key: string) => string | null;
  env?: Env;
}): SandboxStrategyId[] {
  if (opts?.readSettingRaw) {
    const rawSetting = opts.readSettingRaw(COPILOT_STRATEGIES_SETTING_KEY);
    if (rawSetting && rawSetting.trim().length > 0) {
      return parseStrategiesInput(rawSetting);
    }
  }

  const envRaw = (opts?.env as unknown as Record<string, string | undefined>)?.STOCK_COPILOT_STRATEGIES;
  if (envRaw && envRaw.trim().length > 0) {
    return parseStrategiesInput(envRaw);
  }

  return [...DEFAULT_COPILOT_STRATEGIES];
}
