/**
 * Issue #319 — typed research configuration (amendment 1).
 *
 * ONE config owner: ResearchConfigService. The spec's defaults table is the
 * fallback; overrides persist in a settings key/value store (mas_settings
 * idiom: key/value/updated_at, DELETE+INSERT). Every stage gate reads its
 * thresholds from the loaded config — nothing in the pipeline hardcodes a
 * filter. Every published report embeds the effective config snapshot.
 *
 * SDK-free. Storage is injected via ResearchSettingsStore so the agent
 * (Durable Object SQLite) and tests (in-memory) share the service.
 */

// Issue #6032 — the accepted universe set lives in the registry, not here.
import { normalizeResearchUniverseId, researchUniverseIds } from "../trading";
// Issue #5975 - the per-stage mode map and its one validator live in the job
// config, so the deployment default and the stored configuration are judged
// by the same rule.
import {
  validateResearchStageModes,
  type ResearchStageModes,
} from "../config/researchJobConfig";

export interface ResearchConfig {
  /** Minimum market cap for company screening (spec default: $5B). */
  marketCapMin: number;
  /** Maximum underlying price; null = no restriction (spec default). */
  priceCap: number | null;
  /** Screening universe id (e.g. "NASDAQ100"). */
  universe: string;
  /** ETFs evaluated separately from companies (spec default: true). */
  etfsIncluded: boolean;
  /** Maximum qualified ideas per report (spec default: 5). */
  maxIdeas: number;
  /** Option quote freshness window in seconds (configurable per spec §5). */
  quoteFreshnessSeconds: number;
  /** Underlying quote max age in seconds. */
  maxQuoteAgeSeconds: number;
  /** Maximum bid/ask spread as a fraction of mid (configurable). */
  maxSpreadPct: number;
  /** Minimum option volume (configurable activity threshold). */
  minOptionVolume: number;
  /** Minimum open interest (configurable activity threshold). */
  minOpenInterest: number;
  /** Minimum days to expiry for any leg. */
  minDte: number;
  /** Lower bound for the near-term option-chain selection band. */
  nearExpiryMinDte: number;
  /** Upper bound for the near-term option-chain selection band. */
  nearExpiryMaxDte: number;
  /** Lower bound for the long-dated option-chain selection band. */
  leapsExpiryMinDte: number;
  /** Maximum expirations to request in each chain-selection band. */
  maxExpiriesPerBand: number;
  /** Upper bound for calibrated demo chains in the near-term band. */
  calibratedNearMaxDte: number;
  /** Upper bound for calibrated demo chains in the LEAPS band. */
  calibratedLeapsMaxDte: number;
  /** DTE at/below which short legs carry assignment risk. */
  assignmentRiskDte: number;
  /**
   * Ownership-dependent strategies (cash-secured puts, covered calls)
   * require explicit permission (spec default: OFF).
   */
  ownershipStrategiesAllowed: boolean;
  /** PMCC analysis enabled for longer-term bullish theses (spec: optional). */
  pmccEnabled: boolean;
  /** Email the published report after each run (default off). */
  autoEmail: boolean;
  /** Report email recipient (empty = no email). */
  emailTo: string;
  /** Daily schedule (cron). Spec: once each trading day after market close. */
  scheduleCron: string;
  /** Pricing assumptions. */
  riskFreeRate: number;
  dividendYield: number;
  feePerContract: number;
  slippagePerContract: number;
  /** OODA loop budgets (spec §3: enforce limits on tool calls/runtime). */
  maxCandidates: number;
  maxChainsPerRun: number;
  oodaMaxIterations: number;
  /** Rules version pinned on every published idea (spec §9). */
  rulesVersion: string;
  /**
   * Issue #5975 - the per-stage execution-mode overrides the OODA job runs
   * with, persisted here instead of only in `RESEARCH_STAGE_MODES`. Empty by
   * default (every stage inherits the job mode); a stored value wins over the
   * deployment default, per stage and per axis.
   */
  stageModes: ResearchStageModes;
}

export const RESEARCH_CONFIG_DEFAULTS: ResearchConfig = {
  marketCapMin: 5_000_000_000,
  priceCap: null,
  universe: "NASDAQ100",
  etfsIncluded: true,
  maxIdeas: 5,
  quoteFreshnessSeconds: 300,
  maxQuoteAgeSeconds: 900,
  maxSpreadPct: 0.15,
  minOptionVolume: 10,
  minOpenInterest: 50,
  minDte: 7,
  nearExpiryMinDte: 30,
  nearExpiryMaxDte: 45,
  leapsExpiryMinDte: 180,
  maxExpiriesPerBand: 4,
  calibratedNearMaxDte: 120,
  calibratedLeapsMaxDte: 400,
  assignmentRiskDte: 7,
  ownershipStrategiesAllowed: false,
  pmccEnabled: true,
  autoEmail: false,
  emailTo: "",
  scheduleCron: "0 21 * * 1-5",
  riskFreeRate: 0.05,
  dividendYield: 0,
  feePerContract: 0.65,
  slippagePerContract: 0.02,
  maxCandidates: 12,
  maxChainsPerRun: 12,
  oodaMaxIterations: 40,
  rulesVersion: "1.0.0",
  stageModes: {},
};

/** Storage idiom mirrors mas_settings (key/value/updated_at, DELETE+INSERT). */
export interface ResearchSettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const RESEARCH_SETTING_PREFIX = "research.";

export type ResearchConfigKey = keyof ResearchConfig;

export interface ConfigSchemaField {
  key: ResearchConfigKey;
  label: string;
  type: "number" | "boolean" | "string" | "nullable-number" | "select";
  default: unknown;
  hint: string;
  /** Issue #6032 — a `select` field's options, fed from the one universe set. */
  options?: readonly string[];
}

/** UI-bound schema for the filter editor (amendment 2). */
export const RESEARCH_CONFIG_SCHEMA: ConfigSchemaField[] = [
  { key: "marketCapMin", label: "Min market cap ($)", type: "number", default: RESEARCH_CONFIG_DEFAULTS.marketCapMin, hint: "Spec default: $5B for companies." },
  { key: "priceCap", label: "Max underlying price ($, empty = none)", type: "nullable-number", default: RESEARCH_CONFIG_DEFAULTS.priceCap, hint: "No restriction unless configured." },
  {
    key: "universe",
    label: "Universe",
    type: "select",
    options: researchUniverseIds(),
    default: RESEARCH_CONFIG_DEFAULTS.universe,
    hint: "Screening universe — resolved from the listings directory by market-cap rank.",
  },
  { key: "etfsIncluded", label: "Include ETFs", type: "boolean", default: RESEARCH_CONFIG_DEFAULTS.etfsIncluded, hint: "ETFs evaluated separately from companies." },
  { key: "maxIdeas", label: "Max qualified ideas", type: "number", default: RESEARCH_CONFIG_DEFAULTS.maxIdeas, hint: "Spec: up to five." },
  { key: "quoteFreshnessSeconds", label: "Quote freshness (s)", type: "number", default: RESEARCH_CONFIG_DEFAULTS.quoteFreshnessSeconds, hint: "Option quote max age." },
  { key: "maxQuoteAgeSeconds", label: "Underlying quote max age (s)", type: "number", default: RESEARCH_CONFIG_DEFAULTS.maxQuoteAgeSeconds, hint: "Underlying snapshot max age." },
  { key: "maxSpreadPct", label: "Max spread (fraction of mid)", type: "number", default: RESEARCH_CONFIG_DEFAULTS.maxSpreadPct, hint: "Quote-quality gate threshold." },
  { key: "minOptionVolume", label: "Min option volume", type: "number", default: RESEARCH_CONFIG_DEFAULTS.minOptionVolume, hint: "Activity threshold." },
  { key: "minOpenInterest", label: "Min open interest", type: "number", default: RESEARCH_CONFIG_DEFAULTS.minOpenInterest, hint: "Activity threshold." },
  { key: "minDte", label: "Min DTE", type: "number", default: RESEARCH_CONFIG_DEFAULTS.minDte, hint: "Minimum days to expiry per leg." },
  { key: "nearExpiryMinDte", label: "Near-term chain min DTE", type: "number", default: RESEARCH_CONFIG_DEFAULTS.nearExpiryMinDte, hint: "Lower bound for short-dated option-chain selection." },
  { key: "nearExpiryMaxDte", label: "Near-term chain max DTE", type: "number", default: RESEARCH_CONFIG_DEFAULTS.nearExpiryMaxDte, hint: "Upper bound for short-dated option-chain selection." },
  { key: "leapsExpiryMinDte", label: "LEAPS chain min DTE", type: "number", default: RESEARCH_CONFIG_DEFAULTS.leapsExpiryMinDte, hint: "Lower bound for long-dated option-chain selection." },
  { key: "maxExpiriesPerBand", label: "Max expiries per chain band", type: "number", default: RESEARCH_CONFIG_DEFAULTS.maxExpiriesPerBand, hint: "Caps expiration requests in each option-chain band." },
  { key: "calibratedNearMaxDte", label: "Calibrated near-term max DTE", type: "number", default: RESEARCH_CONFIG_DEFAULTS.calibratedNearMaxDte, hint: "Upper bound for demo-only calibrated near-term chains." },
  { key: "calibratedLeapsMaxDte", label: "Calibrated LEAPS max DTE", type: "number", default: RESEARCH_CONFIG_DEFAULTS.calibratedLeapsMaxDte, hint: "Upper bound for demo-only calibrated LEAPS chains." },
  { key: "ownershipStrategiesAllowed", label: "Allow cash-secured puts / covered calls", type: "boolean", default: RESEARCH_CONFIG_DEFAULTS.ownershipStrategiesAllowed, hint: "Spec default OFF — requires explicit permission." },
  { key: "pmccEnabled", label: "Enable PMCC analysis", type: "boolean", default: RESEARCH_CONFIG_DEFAULTS.pmccEnabled, hint: "Spec: optional PMCC analysis." },
  { key: "autoEmail", label: "Email report after run", type: "boolean", default: RESEARCH_CONFIG_DEFAULTS.autoEmail, hint: "Off by default." },
  { key: "emailTo", label: "Report email recipient", type: "string", default: RESEARCH_CONFIG_DEFAULTS.emailTo, hint: "Empty = no email." },
  { key: "scheduleCron", label: "Daily schedule (cron)", type: "string", default: RESEARCH_CONFIG_DEFAULTS.scheduleCron, hint: "After market close, weekdays." },
  { key: "riskFreeRate", label: "Risk-free rate", type: "number", default: RESEARCH_CONFIG_DEFAULTS.riskFreeRate, hint: "Pricing assumption." },
  { key: "feePerContract", label: "Fee per contract ($)", type: "number", default: RESEARCH_CONFIG_DEFAULTS.feePerContract, hint: "Scenario economics." },
  { key: "slippagePerContract", label: "Slippage per contract ($)", type: "number", default: RESEARCH_CONFIG_DEFAULTS.slippagePerContract, hint: "Scenario economics." },
  { key: "maxCandidates", label: "Max candidates per run", type: "number", default: RESEARCH_CONFIG_DEFAULTS.maxCandidates, hint: "OODA budget." },
];

function parseStoredValue(key: ResearchConfigKey, raw: string): unknown {
  const def = RESEARCH_CONFIG_DEFAULTS[key];
  // Issue #5975 - a structured value (the stage-mode map) persists as JSON and
  // is parsed back to its object form; a corrupt value throws, so the service
  // falls closed to the defaults rather than running a half map.
  if (def !== null && typeof def === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON for ${key}: ${raw}`);
    }
  }
  if (typeof def === "boolean") {
    if (raw === "1" || raw.toLowerCase() === "true") return true;
    if (raw === "0" || raw.toLowerCase() === "false") return false;
    throw new Error(`Invalid boolean for ${key}: ${raw}`);
  }
  if (typeof def === "number" || def === null) {
    if (raw.trim() === "") return def === null ? null : def;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}: ${raw}`);
    return n;
  }
  return raw;
}

/**
 * Issue #6032 — the config validator is exported so the settings API, the
 * agent and the tests judge a universe by the same rule.
 */
export function validateResearchConfig(config: ResearchConfig): string[] {
  const errors: string[] = [];
  if (!(config.marketCapMin >= 0)) errors.push("marketCapMin must be >= 0");
  if (config.priceCap !== null && !(config.priceCap > 0)) errors.push("priceCap must be positive or null");
  if (!(config.maxIdeas >= 1 && config.maxIdeas <= 20)) errors.push("maxIdeas must be 1..20");
  if (!(config.quoteFreshnessSeconds > 0)) errors.push("quoteFreshnessSeconds must be positive");
  if (!(config.maxQuoteAgeSeconds > 0)) errors.push("maxQuoteAgeSeconds must be positive");
  if (!(config.maxSpreadPct > 0 && config.maxSpreadPct < 2)) errors.push("maxSpreadPct must be in (0, 2)");
  if (!(config.minOptionVolume >= 0)) errors.push("minOptionVolume must be >= 0");
  if (!(config.minOpenInterest >= 0)) errors.push("minOpenInterest must be >= 0");
  if (!(config.minDte >= 0)) errors.push("minDte must be >= 0");
  if (!(config.nearExpiryMinDte >= 0)) errors.push("nearExpiryMinDte must be >= 0");
  if (!(config.nearExpiryMaxDte >= config.nearExpiryMinDte)) errors.push("nearExpiryMaxDte must be >= nearExpiryMinDte");
  if (!(config.leapsExpiryMinDte > config.nearExpiryMaxDte)) errors.push("leapsExpiryMinDte must be > nearExpiryMaxDte");
  if (!(Number.isInteger(config.maxExpiriesPerBand) && config.maxExpiriesPerBand >= 1 && config.maxExpiriesPerBand <= 20)) errors.push("maxExpiriesPerBand must be an integer from 1 to 20");
  if (!(config.calibratedNearMaxDte >= config.nearExpiryMaxDte)) errors.push("calibratedNearMaxDte must be >= nearExpiryMaxDte");
  if (!(config.calibratedLeapsMaxDte >= config.leapsExpiryMinDte)) errors.push("calibratedLeapsMaxDte must be >= leapsExpiryMinDte");
  // Issue #6032 — the universe is an enum, not free text: an unknown id
  // published an empty run indistinguishable from a quiet night.
  if (!config.universe.trim()) {
    errors.push("universe must be non-empty");
  } else if (normalizeResearchUniverseId(config.universe) === null) {
    errors.push(
      `universe: "${config.universe}" is not a research universe. Accepted: ${researchUniverseIds().join(", ")}.`,
    );
  }
  if (!config.scheduleCron.trim()) errors.push("scheduleCron must be non-empty");
  if (config.emailTo && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.emailTo)) {
    errors.push("emailTo is not a valid email address");
  }
  if (!(config.riskFreeRate >= 0 && config.riskFreeRate < 1)) errors.push("riskFreeRate must be in [0, 1)");
  if (!(config.maxCandidates >= 1 && config.maxCandidates <= 100)) errors.push("maxCandidates must be 1..100");
  // Issue #5975 - the stored per-stage modes are judged by the job config's
  // validator, by name, so a typo cannot persist and silently keep the job
  // mode. `stageModes` names the carrier in the message.
  const stageModes = validateResearchStageModes(config.stageModes, "stageModes");
  errors.push(...stageModes.errors);
  return errors;
}

export class ResearchConfigService {
  constructor(private readonly store: ResearchSettingsStore) {}

  private keyFor(key: ResearchConfigKey): string {
    return `${RESEARCH_SETTING_PREFIX}${key}`;
  }

  /** Load the effective config: stored overrides merged over spec defaults. */
  load(): ResearchConfig {
    const config: ResearchConfig = { ...RESEARCH_CONFIG_DEFAULTS };
    const errors: string[] = [];
    for (const key of Object.keys(RESEARCH_CONFIG_DEFAULTS) as ResearchConfigKey[]) {
      const raw = this.store.get(this.keyFor(key));
      if (raw === null) continue;
      try {
        (config as unknown as Record<string, unknown>)[key] = parseStoredValue(key, raw);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    const validation = validateResearchConfig(config);
    if (validation.length > 0 || errors.length > 0) {
      // Fail closed to defaults on corrupt stored config — never run with
      // an unvalidated filter set.
      return { ...RESEARCH_CONFIG_DEFAULTS };
    }
    return config;
  }

  /**
   * Save a partial patch. Returns the effective config and any errors.
   * Invalid patches are rejected atomically (nothing is written).
   */
  save(patch: Partial<ResearchConfig>): { config: ResearchConfig; errors: string[] } {
    const next: ResearchConfig = { ...this.load(), ...patch };
    const errors = validateResearchConfig(next);
    if (errors.length > 0) return { config: this.load(), errors };
    for (const key of Object.keys(patch) as ResearchConfigKey[]) {
      const value = patch[key];
      const raw =
        value === null || value === undefined
          ? ""
          : typeof value === "boolean"
            ? value
            ? "1"
            : "0"
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
      this.store.set(this.keyFor(key), raw);
    }
    return { config: next, errors: [] };
  }

  /** Deep snapshot for embedding in the published report (amendment 1). */
  snapshot(config: ResearchConfig): ResearchConfig {
    return JSON.parse(JSON.stringify(config)) as ResearchConfig;
  }
}
