/**
 * Options report scope (issue #2577 follow-up) — the single resolver for
 * every axis an options screening report can vary on.
 *
 * Before this module the axes were scattered and hard-coded:
 *
 *  - `thesis` was `options.thesis || "bullish"` in the scheduled path, one
 *    value per run, and it silently excluded every strategy not tagged for
 *    it (`strategyEngine.ts` `selectedDefs`).
 *  - `allowedStrategies` came from whatever the schedule form happened to
 *    carry; `["all"]` expanded to the 74-entry registry, a three-item list
 *    produced exactly three evaluated strategies. `evaluateAllStrategies`
 *    only lifted the thesis filter — it never widened the wanted set.
 *  - the fetch band came from the thesis table (`dteWindows`, 14–60 DTE),
 *    while the catalog contains strategies whose required horizon is 365
 *    DTE — so those were reported "not evaluated" on every run.
 *  - formats and channels were fixed in the caller (PDF/XLSX/CSV to the
 *    schedule's Slack/email/webhook flags).
 *
 * The scope is data now: `config/options-reports.json` declares defaults,
 * presets, and the allowed vocabularies; a request, an env override, or a
 * preset selects among them. No code change is needed to report one,
 * some, or all of any axis.
 *
 * Precedence follows the repo's standing rule for scoped defaults:
 * request > env (`OPTIONS_REPORT_CONFIG`, `OPTIONS_REPORT_PRESET`) >
 * preset > built-in default.
 *
 * Failure posture follows the run path's rule (#1278): a bad scope never
 * fails a run. Unknown strategy ids, out-of-vocabulary theses/formats/
 * channels and malformed config JSON are dropped or ignored with a
 * structured warning, and every fallback is named so the run record can
 * explain what it actually covered.
 */

import rawConfig from "../../config/options-reports.json";
import { defaultRegistry } from "./options/strategies/catalog";
import type { StrategyRegistry } from "./options/strategies/registry";

export type ReportThesis = "bullish" | "bearish" | "range_bound" | "large_move";
export type OptionsReportFormat = "pdf" | "xlsx" | "csv";
export type OptionsReportChannel = "ui" | "slack" | "email" | "webhook" | "mcp" | "a2a";
export type OptionsReportStrategyScope = "all" | "explicit";

export interface OptionsReportChainConfig {
  /** Where the symbol set comes from: the caller's run, or a named universe. */
  source: "run" | "universe";
  universe: string | null;
  symbols: string[];
  /** 0 = every symbol the caller resolved. */
  maxSymbols: number;
  dte: {
    /** null = leave the engine's own thesis band in place (today's behavior). */
    minDte: number | null;
    maxDte: number | null;
    /**
     * When true the fetch band is widened to the registry's largest
     * catalog horizon, so long-dated strategies (LEAPS, calendars) are
     * evaluated instead of reported "not evaluated". Costs subrequests:
     * every additional expiry is one more chain fetch per symbol.
     */
    widenToCatalogHorizon: boolean;
  };
  contractLimit: number;
  maxStrikesPerSide: number;
  maxIronCondors: number;
}

export interface OptionsReportContentConfig {
  includeCoverage: boolean;
  includeNotEvaluated: boolean;
  includeThesisBreakdown: boolean;
  includeLegs: boolean;
  /** 0 = every ranked row (the full-report default). */
  candidateLimit: number;
  /** 0 = no cap. */
  maxRowsPerSection: number;
  pdfTruncateChars: number;
}

export interface OptionsReportGateConfig {
  /** Risk gate applied to every candidate (dollars). */
  maxPlannedLoss: number;
  /** Minimum reward/risk a structure must clear. */
  minRewardRisk: number;
  /** Earnings/dividend policy for the scan. */
  eventPolicy: "warn" | "exclude";
}

export interface OptionsReportScopeDefaults {
  preset: string;
  theses: ReportThesis[];
  strategies: "all" | string[];
  chains: OptionsReportChainConfig;
  formats: OptionsReportFormat[];
  channels: OptionsReportChannel[];
  gates: OptionsReportGateConfig;
  content: OptionsReportContentConfig;
}

export interface OptionsReportScopeConfig {
  version: number;
  description?: string;
  defaults: OptionsReportScopeDefaults;
  presets: Record<string, Partial<Omit<OptionsReportScopeDefaults, "preset">> & { description?: string }>;
  allowed: {
    theses: ReportThesis[];
    formats: OptionsReportFormat[];
    channels: OptionsReportChannel[];
    presets: string[];
  };
}

export const OPTIONS_REPORT_CONFIG: OptionsReportScopeConfig = rawConfig as unknown as OptionsReportScopeConfig;

export interface ScopeWarning {
  /** Which axis produced the warning: theses | strategies | chains | formats | channels | config. */
  axis: string;
  /** The offending value, rendered for the run record. */
  value: string;
  message: string;
}

export interface OptionsReportScopeRequest {
  /** Preset name; falls back to env OPTIONS_REPORT_PRESET, then the config default. */
  preset?: string;
  /** A single thesis (the historical request field). Merged with `theses`. */
  thesis?: string;
  /** Explicit thesis list; wins over `thesis` when both are present. */
  theses?: string[];
  /** "all" (default), a list of registry ids/aliases, or nothing. */
  strategies?: "all" | string[];
  symbols?: string[];
  universe?: string;
  formats?: string[];
  channels?: string[];
  dte?: { minDte?: number | null; maxDte?: number | null; widenToCatalogHorizon?: boolean };
  candidateLimit?: number;
  maxSymbols?: number;
  /** Risk gates: which structures survive. Omitted = the scope's configured value. */
  maxPlannedLoss?: number;
  minRewardRisk?: number;
  /** Env-shaped overrides. `OPTIONS_REPORT_CONFIG` is a JSON patch; `OPTIONS_REPORT_PRESET` a preset name. */
  env?: { OPTIONS_REPORT_CONFIG?: string; OPTIONS_REPORT_PRESET?: string };
}

export interface OptionsReportScopeProvenance {
  preset: string;
  /** "request" when any axis came from the request, "env" when the env patch/preset did, else "builtin". */
  source: "request" | "env" | "builtin";
  /** Config keys the request overrode, for the run record. */
  requestOverrides: string[];
  /** Config keys the env patch overrode. */
  envOverrides: string[];
}

export interface ResolvedOptionsReportScope {
  preset: string;
  theses: ReportThesis[];
  strategyIds: string[];
  strategyScope: OptionsReportStrategyScope;
  /**
   * True when every wanted strategy must be judged against the chain even
   * when it conflicts with the run's thesis. True for "all"; false for an
   * explicit list, which keeps the historical thesis filter.
   */
  evaluateAllStrategies: boolean;
  unknownStrategies: string[];
  /** Wanted strategies the engine will skip under the selected theses unless evaluateAllStrategies is on. */
  thesisExcluded: string[];
  chains: OptionsReportChainConfig;
  /** Largest DTE any selected strategy needs; undefined when the registry has none. */
  catalogHorizonDte: number | undefined;
  /** Selected strategies the fetch band cannot reach (reported, never silently dropped). */
  horizonLimited: Array<{ id: string; label: string; horizonDte: number }>;
  formats: OptionsReportFormat[];
  channels: OptionsReportChannel[];
  gates: OptionsReportGateConfig;
  content: OptionsReportContentConfig;
  warnings: ScopeWarning[];
  provenance: OptionsReportScopeProvenance;
}

const THESIS_SET: ReadonlySet<string> = new Set(["bullish", "bearish", "range_bound", "large_move"]);
const FORMAT_SET: ReadonlySet<string> = new Set(["pdf", "xlsx", "csv"]);
const CHANNEL_SET: ReadonlySet<string> = new Set(["ui", "slack", "email", "webhook", "mcp", "a2a"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge a patch over a base for the known scope keys only. */
function mergeScope(
  base: OptionsReportScopeDefaults,
  patch: Record<string, unknown> | undefined,
): OptionsReportScopeDefaults {
  if (!patch) return base;
  const chainsPatch = isRecord(patch.chains) ? patch.chains : {};
  const dtePatch = isRecord(chainsPatch.dte) ? chainsPatch.dte : {};
  const contentPatch = isRecord(patch.content) ? patch.content : {};
  const gatesPatch = isRecord(patch.gates) ? patch.gates : {};
  return {
    preset: typeof patch.preset === "string" ? patch.preset : base.preset,
    theses: Array.isArray(patch.theses) ? (patch.theses as string[]) as ReportThesis[] : base.theses,
    strategies: patchStrategies(patch.strategies) ?? base.strategies,
    chains: {
      ...base.chains,
      ...(typeof chainsPatch.source === "string" ? { source: chainsPatch.source as "run" | "universe" } : {}),
      ...(chainsPatch.universe === null || typeof chainsPatch.universe === "string"
        ? { universe: chainsPatch.universe as string | null }
        : {}),
      ...(Array.isArray(chainsPatch.symbols) ? { symbols: chainsPatch.symbols as string[] } : {}),
      ...(Number.isFinite(chainsPatch.maxSymbols) ? { maxSymbols: Number(chainsPatch.maxSymbols) } : {}),
      dte: {
        ...base.chains.dte,
        ...(dtePatch.minDte === null || Number.isFinite(dtePatch.minDte) ? { minDte: dtePatch.minDte === null ? null : Number(dtePatch.minDte) } : {}),
        ...(dtePatch.maxDte === null || Number.isFinite(dtePatch.maxDte) ? { maxDte: dtePatch.maxDte === null ? null : Number(dtePatch.maxDte) } : {}),
        ...(typeof dtePatch.widenToCatalogHorizon === "boolean"
          ? { widenToCatalogHorizon: dtePatch.widenToCatalogHorizon }
          : {}),
      },
      ...(Number.isFinite(chainsPatch.contractLimit) ? { contractLimit: Number(chainsPatch.contractLimit) } : {}),
      ...(Number.isFinite(chainsPatch.maxStrikesPerSide)
        ? { maxStrikesPerSide: Number(chainsPatch.maxStrikesPerSide) }
        : {}),
      ...(Number.isFinite(chainsPatch.maxIronCondors) ? { maxIronCondors: Number(chainsPatch.maxIronCondors) } : {}),
    },
    formats: Array.isArray(patch.formats) ? (patch.formats as string[]) as OptionsReportFormat[] : base.formats,
    channels: Array.isArray(patch.channels) ? (patch.channels as string[]) as OptionsReportChannel[] : base.channels,
    gates: {
      ...base.gates,
      ...(Number.isFinite(gatesPatch.maxPlannedLoss) ? { maxPlannedLoss: Number(gatesPatch.maxPlannedLoss) } : {}),
      ...(Number.isFinite(gatesPatch.minRewardRisk) ? { minRewardRisk: Number(gatesPatch.minRewardRisk) } : {}),
      ...(gatesPatch.eventPolicy === "warn" || gatesPatch.eventPolicy === "exclude"
        ? { eventPolicy: gatesPatch.eventPolicy }
        : {}),
    },
    content: {
      ...base.content,
      ...(typeof contentPatch.includeCoverage === "boolean" ? { includeCoverage: contentPatch.includeCoverage } : {}),
      ...(typeof contentPatch.includeNotEvaluated === "boolean"
        ? { includeNotEvaluated: contentPatch.includeNotEvaluated }
        : {}),
      ...(typeof contentPatch.includeThesisBreakdown === "boolean"
        ? { includeThesisBreakdown: contentPatch.includeThesisBreakdown }
        : {}),
      ...(typeof contentPatch.includeLegs === "boolean" ? { includeLegs: contentPatch.includeLegs } : {}),
      ...(Number.isFinite(contentPatch.candidateLimit) ? { candidateLimit: Number(contentPatch.candidateLimit) } : {}),
      ...(Number.isFinite(contentPatch.maxRowsPerSection)
        ? { maxRowsPerSection: Number(contentPatch.maxRowsPerSection) }
        : {}),
      ...(Number.isFinite(contentPatch.pdfTruncateChars)
        ? { pdfTruncateChars: Number(contentPatch.pdfTruncateChars) }
        : {}),
    },
  };
}

/** `strategies` accepts "all", a list, or nothing; anything else is not a patch. */
function patchStrategies(value: unknown): "all" | string[] | undefined {
  if (value === "all") return "all";
  if (Array.isArray(value)) return value.map(String);
  return undefined;
}

function parseEnvConfig(raw: string | undefined): { patch: Record<string, unknown> | undefined; warning?: ScopeWarning } {
  if (!raw) return { patch: undefined };
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        patch: undefined,
        warning: { axis: "config", value: "OPTIONS_REPORT_CONFIG", message: "env config is not a JSON object; ignored." },
      };
    }
    return { patch: parsed };
  } catch (error) {
    return {
      patch: undefined,
      warning: {
        axis: "config",
        value: "OPTIONS_REPORT_CONFIG",
        message: `env config is not valid JSON (${(error as Error)?.message ?? "parse error"}); ignored.`,
      },
    };
  }
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function clampInt(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.trunc(n));
}

function clampNumber(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

/**
 * Resolve the effective report scope.
 *
 * The result is pure data: callers pass `theses`/`strategyIds`/`chains.dte`
 * into the scan request, `formats`/`channels` into the generate/deliver
 * legs, and `content` into the renderers. Nothing else decides inclusion.
 */
export function resolveOptionsReportScope(
  input: OptionsReportScopeRequest = {},
  registry: StrategyRegistry = defaultRegistry,
  config: OptionsReportScopeConfig = OPTIONS_REPORT_CONFIG,
): ResolvedOptionsReportScope {
  const warnings: ScopeWarning[] = [];
  const envOverrides: string[] = [];
  const requestOverrides: string[] = [];

  const envConfig = parseEnvConfig(input.env?.OPTIONS_REPORT_CONFIG);
  if (envConfig.warning) warnings.push(envConfig.warning);
  if (envConfig.patch) envOverrides.push(...Object.keys(envConfig.patch));

  // Base: built-in defaults, then the env patch, so a preset is a named
  // layer over the deployment's own defaults.
  let base = mergeScope(config.defaults, envConfig.patch);

  const presetName =
    input.preset ??
    input.env?.OPTIONS_REPORT_PRESET ??
    (typeof envConfig.patch?.preset === "string" ? (envConfig.patch.preset as string) : base.preset);
  if (!config.allowed.presets.includes(presetName)) {
    warnings.push({
      axis: "presets",
      value: presetName,
      message: `unknown preset; using built-in defaults (known: ${config.allowed.presets.join(", ")}).`,
    });
  } else {
    const preset = config.presets[presetName];
    if (preset) base = mergeScope(base, preset as Record<string, unknown>);
  }
  const preset = config.allowed.presets.includes(presetName) ? presetName : config.defaults.preset;

  // ---- theses -------------------------------------------------------
  let thesisValues: string[] = base.theses;
  if (Array.isArray(input.theses) && input.theses.length > 0) {
    thesisValues = input.theses.map(String);
    requestOverrides.push("theses");
  } else if (typeof input.thesis === "string" && input.thesis.trim()) {
    thesisValues = [input.thesis.trim()];
    requestOverrides.push("theses");
  }
  const theses: ReportThesis[] = [];
  for (const value of thesisValues) {
    if (THESIS_SET.has(value)) {
      if (!theses.includes(value as ReportThesis)) theses.push(value as ReportThesis);
    } else {
      warnings.push({
        axis: "theses",
        value: String(value),
        message: `not a report thesis; dropped (known: ${config.allowed.theses.join(", ")}).`,
      });
    }
  }
  if (theses.length === 0) {
    theses.push(...config.defaults.theses);
    warnings.push({ axis: "theses", value: "[]", message: "no valid thesis selected; using all built-in theses." });
  }

  // ---- strategies ---------------------------------------------------
  let strategyValues: "all" | string[] = base.strategies;
  if (input.strategies !== undefined) {
    strategyValues = input.strategies;
    requestOverrides.push("strategies");
  }
  let strategyScope: OptionsReportStrategyScope;
  let strategyIds: string[];
  let unknownStrategies: string[] = [];
  if (strategyValues === "all") {
    strategyScope = "all";
    strategyIds = registry.ids();
  } else {
    const resolved = registry.resolveMany(strategyValues);
    unknownStrategies = resolved.unknown;
    strategyIds = resolved.ids;
    strategyScope = "explicit";
    if (unknownStrategies.length > 0) {
      warnings.push({
        axis: "strategies",
        value: unknownStrategies.join(", "),
        message: "unknown strategy ids/aliases; ignored — the rest of the list still runs.",
      });
    }
    if (strategyIds.length === 0) {
      strategyScope = "all";
      strategyIds = registry.ids();
      warnings.push({
        axis: "strategies",
        value: "[]",
        message: "strategy list resolved to nothing; falling back to the full registry.",
      });
    }
  }
  const evaluateAllStrategies = strategyScope === "all";
  const thesisExcluded = evaluateAllStrategies
    ? []
    : strategyIds.filter((id) => {
        const def = registry.get(id);
        return Boolean(def) && !theses.some((thesis) => def!.theses.includes(thesis));
      });

  // ---- chains -------------------------------------------------------
  const chains: OptionsReportChainConfig = {
    ...base.chains,
    symbols: unique(
      (input.symbols ?? base.chains.symbols).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean),
    ),
    universe: input.universe ?? base.chains.universe,
    maxSymbols: clampInt(input.maxSymbols ?? base.chains.maxSymbols, base.chains.maxSymbols),
    dte: {
      minDte: input.dte?.minDte === null
        ? null
        : input.dte?.minDte !== undefined
          ? clampInt(input.dte.minDte, 0)
          : base.chains.dte.minDte,
      maxDte: input.dte?.maxDte === null
        ? null
        : input.dte?.maxDte !== undefined
          ? clampInt(input.dte.maxDte, 0)
          : base.chains.dte.maxDte,
      widenToCatalogHorizon:
        input.dte?.widenToCatalogHorizon ?? base.chains.dte.widenToCatalogHorizon,
    },
    contractLimit: clampInt(base.chains.contractLimit, 10000, 1),
    maxStrikesPerSide: clampInt(base.chains.maxStrikesPerSide, 12, 1),
    maxIronCondors: clampInt(base.chains.maxIronCondors, 100),
  };
  if (input.dte || input.symbols || input.universe !== undefined || input.maxSymbols !== undefined) {
    requestOverrides.push("chains");
  }
  if (chains.dte.minDte !== null && chains.dte.maxDte !== null && chains.dte.maxDte < chains.dte.minDte) {
    warnings.push({
      axis: "chains",
      value: `${chains.dte.minDte}-${chains.dte.maxDte}`,
      message: "DTE band is inverted; the ceiling was raised to the floor.",
    });
    chains.dte.maxDte = chains.dte.minDte;
  }
  chains.source = chains.universe ? "universe" : "run";

  const horizons = strategyIds
    .map((id) => {
      const def = registry.get(id);
      if (!def) return null;
      const horizonDte = def.dataHorizonDte ?? def.requiredMaxDte ?? 0;
      return { id, label: def.label, horizonDte };
    })
    .filter((entry): entry is { id: string; label: string; horizonDte: number } => entry !== null);
  const catalogHorizonDte = horizons.length > 0 ? Math.max(...horizons.map((entry) => entry.horizonDte)) : undefined;
  if (chains.dte.widenToCatalogHorizon && catalogHorizonDte !== undefined) {
    const floor = chains.dte.minDte ?? 0;
    chains.dte.maxDte = Math.max(catalogHorizonDte, floor, chains.dte.maxDte ?? 0);
  }
  const horizonLimited = chains.dte.maxDte === null
    ? []
    : horizons
        .filter((entry) => entry.horizonDte > (chains.dte.maxDte as number))
        .sort((a, b) => a.id.localeCompare(b.id));

  // ---- formats / channels -------------------------------------------
  let formatValues = base.formats as string[];
  if (Array.isArray(input.formats) && input.formats.length > 0) {
    formatValues = input.formats.map(String);
    requestOverrides.push("formats");
  }
  const formats = unique(
    formatValues.filter((value) => {
      if (FORMAT_SET.has(value)) return true;
      warnings.push({ axis: "formats", value, message: "unknown report format; dropped." });
      return false;
    }),
  ) as OptionsReportFormat[];
  if (formats.length === 0) formats.push(...config.defaults.formats);

  let channelValues = base.channels as string[];
  if (Array.isArray(input.channels) && input.channels.length > 0) {
    channelValues = input.channels.map(String);
    requestOverrides.push("channels");
  }
  const channels = unique(
    channelValues.filter((value) => {
      if (CHANNEL_SET.has(value)) return true;
      warnings.push({ axis: "channels", value, message: "unknown delivery channel; dropped." });
      return false;
    }),
  ) as OptionsReportChannel[];
  if (channels.length === 0) channels.push(...config.defaults.channels);

  // ---- content ------------------------------------------------------
  const content: OptionsReportContentConfig = {
    ...base.content,
    candidateLimit: clampInt(input.candidateLimit ?? base.content.candidateLimit, base.content.candidateLimit),
    maxRowsPerSection: clampInt(base.content.maxRowsPerSection, 0),
    pdfTruncateChars: clampInt(base.content.pdfTruncateChars, 120, 8),
  };
  if (input.candidateLimit !== undefined) requestOverrides.push("content.candidateLimit");

  // ---- gates --------------------------------------------------------
  // The two numbers that decide which structures survive. The sharded
  // path used to hardcode 1000/1.5 and ignore the schedule entirely;
  // they are scope data now, with the same defaults so today's behavior
  // is unchanged until an operator configures them.
  const gates: OptionsReportGateConfig = {
    maxPlannedLoss: clampNumber(input.maxPlannedLoss, base.gates.maxPlannedLoss, 1),
    minRewardRisk: clampNumber(input.minRewardRisk, base.gates.minRewardRisk, 0),
    eventPolicy: base.gates.eventPolicy,
  };
  if (input.maxPlannedLoss !== undefined || input.minRewardRisk !== undefined) {
    requestOverrides.push("gates");
  }

  return {
    preset,
    theses,
    strategyIds,
    strategyScope,
    evaluateAllStrategies,
    unknownStrategies,
    thesisExcluded,
    chains,
    catalogHorizonDte,
    horizonLimited,
    formats,
    channels,
    gates,
    content,
    warnings,
    provenance: {
      preset,
      source: requestOverrides.length > 0 ? "request" : envOverrides.length > 0 ? "env" : "builtin",
      requestOverrides,
      envOverrides,
    },
  };
}

export interface ThesisRunPlan {
  thesis: ReportThesis;
  /** Strategies judged as thesis-aligned; informational — the engine's set is `strategyIds`. */
  alignedStrategyIds: string[];
  fetchBand: { minDte: number | null; maxDte: number | null };
}

/**
 * One execution per thesis. The scan is thesis-scoped (scoring orients to
 * the thesis), so "all theses" means N executions, each reporting its own
 * ranking; the merged report keeps them side by side instead of
 * pretending one score answers four views.
 */
export function thesisRunPlan(
  scope: ResolvedOptionsReportScope,
  registry: StrategyRegistry = defaultRegistry,
): ThesisRunPlan[] {
  return scope.theses.map((thesis) => ({
    thesis,
    alignedStrategyIds: scope.strategyIds.filter((id) => registry.get(id)?.theses.includes(thesis)),
    fetchBand: { minDte: scope.chains.dte.minDte, maxDte: scope.chains.dte.maxDte },
  }));
}

/**
 * Human-readable one-liner stamped into reports and audit rows, so a run
 * record says what it covered without a reader reconstructing the config.
 */
export function describeReportScope(scope: ResolvedOptionsReportScope): string {
  const strategies =
    scope.strategyScope === "all"
      ? `all ${scope.strategyIds.length} strategies`
      : `${scope.strategyIds.length} selected strategies`;
  const chains = scope.chains.universe
    ? `universe ${scope.chains.universe}`
    : scope.chains.symbols.length === 0
      ? "run symbol set"
      : scope.chains.symbols.length <= 5
        ? scope.chains.symbols.join(",")
        : `${scope.chains.symbols.length} symbols`;
  const band = scope.chains.dte.maxDte === null && scope.chains.dte.minDte === null
    ? "engine DTE band"
    : `DTE ${scope.chains.dte.minDte ?? "auto"}–${scope.chains.dte.maxDte ?? "auto"}`;
  const limited = scope.horizonLimited.length > 0
    ? `; ${scope.horizonLimited.length} need expiries beyond ${scope.chains.dte.maxDte} DTE`
    : "";
  return `${scope.preset}: ${scope.theses.join("/")} x ${strategies} x ${chains} (${band}${limited}) -> ${scope.formats.join("+")} via ${scope.channels.join("+")}`;
}

/** A scope with no request: the deployment's own defaults + env overrides. */
export function defaultOptionsReportScope(
  env?: OptionsReportScopeRequest["env"],
): ResolvedOptionsReportScope {
  return resolveOptionsReportScope({ env });
}
