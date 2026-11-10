/**
 * Issue #3514 — Stock Copilot Dynamic Universe and Strategy Configuration.
 *
 * Externalizes universe and strategy settings to `mas_settings` per tenancy,
 * providing presets (index-backed: NASDAQ100, SP100, SP500, DOW; symbol
 * lists: MEGA_TECH, SEMIS) and dynamic lists across all channel surfaces
 * (Chat, Schedule, MCP, Webhook). Issue #3936 made the index presets resolve
 * their stored membership instead of a hand-written subset.
 */

import type { Env } from "../types";
import type { IndexListStore } from "../data/indexListPorts";
import type { IndexId } from "../trading";
import { resolveStoredIndexList } from "./indexListConsumer";
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

/**
 * Issue #3936 — the index presets are INDEX-BACKED, not hand-written lists.
 *
 * A preset that carries an index name must resolve that index's stored
 * membership; the symbol array it also declares is a **labelled fallback**
 * for the case where no usable stored list exists, never a claim about the
 * index's members. `DOW`/`SP500` fall back to the tracking ETF rather than an
 * invented membership — a small, honest universe beats a fabricated 30/500.
 */
export const INDEX_PRESETS: Record<"NASDAQ100" | "SP100" | "SP500" | "DOW", IndexId> = {
  NASDAQ100: "nasdaq100",
  SP100: "sp100",
  SP500: "sp500",
  DOW: "dow",
};

export type IndexPresetName = keyof typeof INDEX_PRESETS;

export const INDEX_PRESET_FALLBACKS: Record<IndexPresetName, readonly string[]> = {
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
  // No curated membership exists for these, and inventing one would be worse
  // than a small honest universe: fall back to the index's tracking ETF.
  SP500: ["SPY"],
  DOW: ["DIA"],
};

/** Presets that are explicit symbol lists — they claim no index membership. */
export const SYMBOL_PRESETS: Record<string, readonly string[]> = {
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

/**
 * Every preset a caller may name. Index presets map to their labelled
 * fallback here so the synchronous parser still returns a bounded universe;
 * `resolveCopilotUniverseFull` upgrades them to the stored membership.
 */
export const PRESET_UNIVERSES: Record<string, readonly string[]> = {
  ...SYMBOL_PRESETS,
  ...INDEX_PRESET_FALLBACKS,
};

export function isIndexPreset(name: string | null | undefined): name is IndexPresetName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(INDEX_PRESETS, name);
}

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

/**
 * Issue #3899 (RC4) / #3936 — the async full resolution of the copilot
 * universe.
 *
 * The synchronous `resolveCopilotUniverse` stays the preset parser: it
 * returns the configured symbols (an index preset returns its labelled
 * fallback array), and it is never read as membership. Where a universe is
 * actually *reported* or *run*, this resolver is used:
 *
 * - an INDEX preset (`NASDAQ100`, `SP100`, `SP500`, `DOW`) whose stored list
 *   is fresh ⇒ that index's full membership (`source: "stored-index"`);
 * - stored list missing, stale, empty or unreadable ⇒ the preset's LABELLED
 *   fallback (`source: "preset-fallback"`, `reason` names the cause, `stale`
 *   and `snapshotDate` name the stored list when one was found). A missing
 *   list is a named outcome, never a silent live fallback and never a silent
 *   no-op — the cycle still runs, on the labelled fallback, and the caller
 *   records the reason;
 * - any other preset or explicit list ⇒ the configured symbols untouched
 *   (`source: "configured"`); the index store is never read, so a non-index
 *   universe cannot fail on it.
 */
export type CopilotUniverseResolutionSource =
  | "configured"
  | "stored-index"
  | "preset-fallback";

export interface CopilotUniverseResolution {
  symbols: string[];
  source: CopilotUniverseResolutionSource;
  /** The preset the configured universe names, when one applies. */
  preset: string | null;
  /** The index a preset resolves through, when one applies. */
  index: IndexId | null;
  /** True when the stored list was found but stale (fallback path). */
  stale: boolean;
  /** Snapshot date of the stored list, when one was found. */
  snapshotDate: string | null;
  /** Why the fallback was used, or why the store could not be read. */
  reason: string | null;
}

export async function resolveCopilotUniverseFull(opts?: {
  readSettingRaw?: (key: string) => string | null;
  env?: Env;
  /** The stored-list port; absent ⇒ the labelled preset fallback. */
  indexListStore?: IndexListStore | null;
}): Promise<CopilotUniverseResolution> {
  const symbols = resolveCopilotUniverse(opts);
  const preset = resolveCopilotUniversePreset(symbols);
  // Narrow once into a typed local: `preset` is `string | null`, and the record
  // lookups below need the union key, not the widened string.
  const indexPreset: IndexPresetName | null = preset && isIndexPreset(preset) ? preset : null;
  const index: IndexId | null = indexPreset ? INDEX_PRESETS[indexPreset] : null;

  if (!indexPreset || !index) {
    return {
      symbols,
      source: "configured",
      preset,
      index: null,
      stale: false,
      snapshotDate: null,
      reason: null,
    };
  }

  const label = `${indexPreset} preset (${index})`;
  const fallbackSymbols = [...INDEX_PRESET_FALLBACKS[indexPreset]];
  const fallback = (
    reason: string,
    stale = false,
    snapshotDate: string | null = null,
  ): CopilotUniverseResolution => ({
    symbols: fallbackSymbols,
    source: "preset-fallback",
    preset: indexPreset,
    index,
    stale,
    snapshotDate,
    reason,
  });

  const store = opts?.indexListStore ?? null;
  if (!store) {
    return fallback(
      `no index-list store available to resolve the stored ${index} membership — using the labelled ${label}`,
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveStoredIndexList>>;
  try {
    resolved = await resolveStoredIndexList({ store, index });
  } catch (err) {
    return fallback(
      `stored ${index} list could not be read (${err instanceof Error ? err.message : String(err)}) — using the labelled ${label}`,
    );
  }
  if (resolved.status === "missing") {
    return fallback(`${resolved.reason} — using the labelled ${label}`);
  }
  const membership = resolved.membership;
  if (resolved.stale) {
    return fallback(
      `stored ${index} list is stale (snapshot ${membership.snapshotDate}) — using the labelled ${label}`,
      true,
      membership.snapshotDate,
    );
  }
  const stored = Array.from(
    new Set(
      membership.symbols
        .map((m) => m.symbol.trim().toUpperCase())
        .filter((s) => s.length > 0),
    ),
  );
  if (stored.length === 0) {
    return fallback(
      `stored ${index} list is empty (snapshot ${membership.snapshotDate}) — using the labelled ${label}`,
      false,
      membership.snapshotDate,
    );
  }
  return {
    symbols: stored,
    source: "stored-index",
    preset: indexPreset,
    index,
    stale: false,
    snapshotDate: membership.snapshotDate,
    reason: null,
  };
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
