/**
 * Screening request schemas — the SINGLE definition site for every
 * screening request shape in the product (issue #959, screening
 * consolidation S1 under umbrella #958).
 *
 * Before S1 each entry point parsed screening criteria its own way:
 * REST routes passed raw bodies to the engines, the NLQ port armed a
 * hardcoded legacy schedule payload ({sector:"Technology", maxItems:5})
 * and silently dropped NLQ criteria for the other callbacks, schedule
 * creation hand-rolled its validation inline in the route, and the MCP
 * scanner tool carried a private copy of the options-filter constraints.
 * Mis-shaped input was silently coerced or ignored by engine-internal
 * sanitizers, so the same criteria produced different runs depending on
 * which door they entered through.
 *
 * This module is the one place the shapes are defined:
 *
 *   - Stock screen      — StockScreenerFilter + the universe envelope
 *                         (parseStockScreenRequest / parseStockScreenerFilter)
 *   - Options screen    — OptionScreenerFilter + delivery envelope
 *                         (parseOptionsScreenRequest / parseOptionScreenerFilter)
 *   - Options scan      — UnifiedOptionsRequest (UnifiedOptionsService)
 *                         (parseUnifiedOptionsRequest) and the NLQ
 *                         OpportunityScanner template (parseScanRequestTemplate)
 *   - Options discovery — StrategyRequest (+ route envelope)
 *                         (parseStrategyRequest / parseOptionsDiscoveryRequest),
 *                         NoViewStrategyRequest (parseNoViewStrategyRequest)
 *   - Schedule payloads — autonomousMarketScreen /
 *                         autonomousOptionsAnalysis /
 *                         autonomousStrategyDiscovery criteria, validated
 *                         and assembled by buildSchedulePayload, which is
 *                         the single builder used by REST schedule
 *                         creation, the schedule trigger routes, and the
 *                         NLQ scheduling executor.
 *
 * Rules of the house (issue #959):
 *   - Strict objects: unknown keys are REJECTED with the field named.
 *     No silent coercion of mis-typed values (no string→number casts);
 *     the only defaults are the documented ones (universe NASDAQ100 at
 *     the interactive stock route, the schedule assembly defaults in
 *     buildSchedulePayload).
 *   - Identity fields (userLogin / environment / trigger) are never
 *     criteria: buildSchedulePayload stamps them from the caller's
 *     trusted context AFTER validation, exactly as the REST create
 *     route has always done.
 *   - The strategy-request validators in
 *     src/trading/options/strategyRiskAgent.ts delegate to this module
 *     and keep their historical generic messages (pinned by the
 *     discovery test suites); the field-named errors live here.
 *
 * Server-side only: client code must not import this module across the
 * issue #290 boundary — clients already carry the shapes as types.
 */
import { z } from "zod";
import type { OptionScreenerFilter, StockScreenerFilter } from "../types";
import { UNIVERSES } from "./universes";
import type {
  EventCalendarInfo,
  NoViewStrategyRequest,
  StrategyRequest,
} from "./options/strategyEngine";
import type { StrategyScreenFilter } from "./options/strategyRiskAgent";
import type { UnifiedOptionsRequest } from "./options/unifiedOptionsService";
import { defaultRegistry } from "./options/strategies/catalog";
import { MAX_SAVED_REQUESTS_PER_RUN } from "./options/discoveryRunStore";

/* ------------------------------------------------------------------ */
/* Result type + error formatting                                      */
/* ------------------------------------------------------------------ */

export type ScreeningValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function formatIssues(kind: string, error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.join(".");
    const prefix = path ? `${path}: ` : "";
    if (issue.code === "unrecognized_keys") {
      const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
      return `${prefix}unknown field(s): ${keys.join(", ")}`;
    }
    return `${prefix}${issue.message}`;
  });
  return `Invalid ${kind}: ${parts.join("; ")}`;
}

function parseWith<T>(kind: string, schema: z.ZodType<T>, input: unknown): ScreeningValidationResult<T> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: `Invalid ${kind}: expected an object.` };
  }
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: formatIssues(kind, result.error) };
}

/* ------------------------------------------------------------------ */
/* Shared field schemas                                                */
/* ------------------------------------------------------------------ */

/** Ticker rule shared with the schedule-create route's historical check. */
export const tickerSchema = z
  .string()
  .regex(/^[A-Z0-9./-]{1,16}$/i, "must be a valid ticker string");

const fin = () => z.number().finite();
const intAtLeast = (min: number) => z.number().int().min(min);
const nonEmptyString = z.string().min(1);

export const optionThesisSchema = z.enum(["bullish", "bearish", "range_bound", "large_move"]);
export const expectedIvDirectionSchema = z.enum(["rise", "unchanged", "fall"]);
export const riskProfileSchema = z.enum(["conservative", "balanced", "aggressive"]);

/** A universe name: any key of the UNIVERSES registry, or "ALL" (the
 *  sharded all-universes run at the interactive routes). Schedule
 *  creation narrows this further — see buildSchedulePayload. */
export const universeNameSchema = z
  .string()
  .refine((v) => v === "ALL" || v in UNIVERSES, "must be a known screening universe");

const eventCalendarSchema: z.ZodType<EventCalendarInfo> = z.looseObject({
  covered: z.boolean(),
  source: z.string().optional(),
  earningsDate: z.string().nullable().optional(),
  daysToEarnings: z.number().nullable().optional(),
  exDividendDate: z.string().nullable().optional(),
  daysToExDiv: z.number().nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Stock screening (StockScreenerFilter)                               */
/* ------------------------------------------------------------------ */

export const stockScreenerFilterFields = {
  sector: nonEmptyString.optional(),
  minPrice: fin().optional(),
  maxPrice: fin().optional(),
  exchange: z.enum(["ALL", "NASDAQ", "NYSE", "AMEX"]).optional(),
  minMarketCap: fin().optional(),
  maxPeRatio: fin().optional(),
  maxRsi: fin().optional(),
  minRsi: fin().optional(),
  maxPercentB: fin().optional(),
  minPercentB: fin().optional(),
  requireSqueezeGate: z.boolean().optional(),
  requireAboveAnchoredVwap: z.boolean().optional(),
  minAtrPct: fin().optional(),
  maxAtrPct: fin().optional(),
  regimeFilter: z.enum(["UP", "DN", "RNG"]).optional(),
  minCompositeBiasScore: fin().optional(),
  gainersOnly: z.boolean().optional(),
  losersOnly: z.boolean().optional(),
  rsiFilter: z.enum(["oversold", "overbought", "neutral", "any"]).optional(),
  momentum: z.enum(["bullish_breakout", "bearish_pullback", "high_relative_volume", "any"]).optional(),
  gainersLosers: z.enum(["gainers", "losers", "active", "all", "movers"]).optional(),
  minVolume: fin().optional(),
  search: z.string().optional(),
  limit: fin().optional(),
} satisfies Record<keyof StockScreenerFilter, z.ZodType>;

export const stockScreenerFilterSchema = z.strictObject(stockScreenerFilterFields);

export function parseStockScreenerFilter(input: unknown): ScreeningValidationResult<StockScreenerFilter> {
  return parseWith("stock screener filter", stockScreenerFilterSchema, input) as ScreeningValidationResult<StockScreenerFilter>;
}

export interface StockScreenRequest {
  filters: StockScreenerFilter;
  /** Universe the screen runs over; "NASDAQ100" when the caller omitted
   *  one (the interactive routes' documented default), or "ALL" for the
   *  sharded all-universes run. */
  universe: string;
  /** Envelope field sent by ScreenersHub. Accepted for compatibility and
   *  split out of the filter; no server code reads it today (harvested
   *  in the #959 compatibility fixtures) — it is NOT an engine filter. */
  minScore?: number;
  /** Per-request email recipient for the manual route (#1941);
   *  never forwarded into the engine filter. */
  emailTo?: string;
  /** Issue #2545: the scheduled market screen's delivery envelope,
   *  carried on the manual request so a one-shot run delivers like
   *  the scheduled run — the same field names the schedule payload's
   *  deliveryFields carry (marketScreenScheduleCriteriaSchema).
   *  Envelope only, split out here; never forwarded into the engine
   *  filter. The route stamps them onto the run's follow-up outcome;
   *  pushToSlack present = the caller made an explicit delivery
   *  selection (the outcome then carries a channel allowlist). */
  pushToSlack?: boolean;
  slackChannel?: string;
  webhookUrl?: string;
  /** Issue #2545: include the run's generated report artifacts
   *  (PDF/XLSX/CSV) in deliveries. Absent/true = today's behavior
   *  (the run always generates its report; deliveries attach it);
   *  false drops the artifacts from the DELIVERY projection only —
   *  the run record and its stored report are untouched. */
  generatePdf?: boolean;
}

const stockScreenRequestSchema = z.strictObject({
  ...stockScreenerFilterFields,
  universe: universeNameSchema.optional(),
  minScore: fin().optional(),
  emailTo: z.string().optional(),
  pushToSlack: z.boolean().optional(),
  slackChannel: z.string().optional(),
  webhookUrl: z.string().optional(),
  generatePdf: z.boolean().optional(),
});

export function parseStockScreenRequest(input: unknown): ScreeningValidationResult<StockScreenRequest> {
  const parsed = parseWith("stock screen request", stockScreenRequestSchema, input);
  if (!parsed.ok) return parsed;
  const { universe, minScore, emailTo, pushToSlack, slackChannel, webhookUrl, generatePdf, ...filters } = parsed.value as Record<string, unknown>;
  return {
    ok: true,
    value: {
      filters: filters as StockScreenerFilter,
      universe: (universe as string | undefined) ?? "NASDAQ100",
      ...(minScore !== undefined ? { minScore: minScore as number } : {}),
      ...(emailTo !== undefined ? { emailTo: emailTo as string } : {}),
      ...(pushToSlack !== undefined ? { pushToSlack: pushToSlack as boolean } : {}),
      ...(slackChannel !== undefined ? { slackChannel: slackChannel as string } : {}),
      ...(webhookUrl !== undefined ? { webhookUrl: webhookUrl as string } : {}),
      ...(generatePdf !== undefined ? { generatePdf: generatePdf as boolean } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Options contract screening (OptionScreenerFilter)                   */
/* ------------------------------------------------------------------ */

/** The field schemas are exported individually because the MCP scanner
 *  tool (src/mcps/scanner/cloudflareWalletsScanner.ts) composes its public
 *  argument schema from them — one definition, no per-entry copy. Its
 *  public argument names (maxDTE/minDTE) map onto minDte/maxDte here. */
export const optionScreenerFilterFields = {
  underlyingSymbols: z.array(tickerSchema).optional(),
  maxUnderlyings: intAtLeast(1).optional(),
  sector: nonEmptyString.optional(),
  contractType: z.enum(["CALL", "PUT", "BOTH"]).optional(),
  minVolume: intAtLeast(0).optional(),
  minOpenInterest: fin().optional(),
  maxSpreadPct: fin().min(0).optional(),
  maxQuoteAgeSeconds: fin().min(0).optional(),
  minDelta: fin().optional(),
  maxDelta: fin().optional(),
  minGamma: fin().optional(),
  maxGamma: fin().optional(),
  minTheta: fin().optional(),
  maxTheta: fin().optional(),
  minVega: fin().optional(),
  maxVega: fin().optional(),
  minRho: fin().optional(),
  maxRho: fin().optional(),
  minPrice: fin().optional(),
  maxPrice: fin().optional(),
  minImpliedVolatility: fin().optional(),
  maxImpliedVolatility: fin().optional(),
  minDte: intAtLeast(0).optional(),
  maxDte: intAtLeast(0).optional(),
  expirationDteBands: z
    .array(
      z.strictObject({
        minDte: z.number().int(),
        maxDte: z.number().int(),
        maxExpirations: z.number().int().optional(),
      })
    )
    .optional(),
  moneyness: z.enum(["ITM", "OTM", "ATM", "ALL"]).optional(),
  maxStrikeDistancePct: fin().optional(),
  limit: intAtLeast(1).optional(),
  sortBy: z.enum(["volume", "spreadPct", "iv", "volumeOiRatio", "dte", "strikeDistance"]).optional(),
} satisfies Record<keyof OptionScreenerFilter, z.ZodType>;

export const optionScreenerFilterSchema = z.strictObject(optionScreenerFilterFields);

export function parseOptionScreenerFilter(input: unknown): ScreeningValidationResult<OptionScreenerFilter> {
  return parseWith("options screener filter", optionScreenerFilterSchema, input) as ScreeningValidationResult<OptionScreenerFilter>;
}

export interface OptionsScreenRequest {
  filter: OptionScreenerFilter;
  /** Delivery envelope read by the /api/trading/options/screen route
   *  (and the premium scan): NOT part of the engine filter. Boolean
   *  only — the route's historical string "false" tolerance is dropped;
   *  every harvested client surface sends a real boolean. */
  pushToSlack?: boolean;
  slackChannel?: string;
  /** Label-only envelope field the route's Slack summary falls back to;
   *  never forwarded into the engine filter. */
  universe?: string;
  /** Per-request email recipient for the manual route (#1336);
   *  never forwarded into the engine filter. */
  emailTo?: string;
}

const optionsScreenRequestSchema = z.strictObject({
  ...optionScreenerFilterFields,
  pushToSlack: z.boolean().optional(),
  slackChannel: z.string().optional(),
  universe: z.string().optional(),
  // Issue #1336: per-request email recipient for the manual route;
  // env fallback (OPTIONS_EMAIL_TO / SCREENER_EMAIL_TO) applies when absent.
  emailTo: z.string().optional(),
});

export function parseOptionsScreenRequest(input: unknown): ScreeningValidationResult<OptionsScreenRequest> {
  const parsed = parseWith("options screen request", optionsScreenRequestSchema, input);
  if (!parsed.ok) return parsed;
  const { pushToSlack, slackChannel, universe, emailTo, ...filter } = parsed.value as Record<string, unknown>;
  return {
    ok: true,
    value: {
      filter: filter as OptionScreenerFilter,
      ...(pushToSlack !== undefined ? { pushToSlack: pushToSlack as boolean } : {}),
      ...(slackChannel !== undefined ? { slackChannel: slackChannel as string } : {}),
      ...(universe !== undefined ? { universe: universe as string } : {}),
      ...(emailTo !== undefined ? { emailTo: emailTo as string } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Strategy discovery requests (StrategyRequest / NoViewStrategyRequest) */
/* ------------------------------------------------------------------ */

/** The historical generic messages. strategyRiskAgent's
 *  validateStrategyRequest / validateNoViewRequest return exactly these
 *  (pinned by the discovery suites); they are defined once, here. */
export const STRATEGY_REQUEST_INVALID_MESSAGE =
  "Invalid strategy request. Supply a thesis, target, date, risk cap, reward/risk minimum, and allowed strategies.";
export const NO_VIEW_REQUEST_INVALID_MESSAGE =
  "Invalid no-view strategy request. Supply a symbol, risk cap, reward/risk minimum, and constraints only — no thesis, target price, target date, or IV direction.";

/** View fields a no-view constraint set must never carry (issue #534). */
export const NO_VIEW_FORBIDDEN_FIELDS = ["thesis", "targetPrice", "targetDate", "expectedIvDirection"] as const;

const allowedStrategiesSchema = z
  .array(z.string())
  .min(1, "must name at least one strategy")
  .refine(
    (names) => defaultRegistry.resolveMany(names).unknown.length === 0,
    "contains a strategy name the registry cannot resolve"
  );

/** The threshold fields shared by StrategyRequest, NoViewStrategyRequest
 *  and the scan template — the rules mirror the historical hand-rolled
 *  validators in strategyRiskAgent.ts exactly. */
const strategyThresholdFields = {
  optimizationBias: fin().optional(),
  dataMode: z.enum(["live", "calibrated-demo"]).optional(),
  minDte: intAtLeast(1).optional(),
  maxDte: z.number().int().optional(),
  minVolume: intAtLeast(0).optional(),
  minOpenInterest: intAtLeast(0).optional(),
  maxSpreadPct: fin().refine((v) => v > 0, "must be greater than 0").optional(),
  maxQuoteAgeSeconds: fin().min(0).optional(),
  contractLimit: intAtLeast(1).optional(),
  candidateLimit: intAtLeast(1).optional(),
  maxStrikesPerSide: intAtLeast(1).optional(),
  maxIronCondors: intAtLeast(0).optional(),
  eventPolicy: z.enum(["warn", "exclude"]).optional(),
  eventCalendar: eventCalendarSchema.optional(),
  riskFreeRate: fin().optional(),
  dividendYield: fin().optional(),
  feesPerContract: fin().optional(),
};

function dteOrderCheck(value: { minDte?: number; maxDte?: number }, ctx: z.RefinementCtx): void {
  if (value.maxDte !== undefined && value.maxDte < (value.minDte ?? 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["maxDte"],
      message: "must be greater than or equal to minDte",
    });
  }
}

export const strategyRequestFields = {
  symbol: nonEmptyString.refine((v) => v.trim().length > 0, "must not be blank"),
  thesis: optionThesisSchema,
  targetPrice: fin(),
  targetDate: z.string(),
  expectedIvDirection: expectedIvDirectionSchema,
  maxPlannedLoss: fin(),
  minRewardRisk: fin(),
  ...strategyThresholdFields,
  allowedStrategies: allowedStrategiesSchema,
};

export const strategyRequestSchema = z
  .strictObject(strategyRequestFields)
  .superRefine(dteOrderCheck);

export function parseStrategyRequest(input: unknown): ScreeningValidationResult<StrategyRequest> {
  return parseWith("strategy request", strategyRequestSchema, input) as ScreeningValidationResult<StrategyRequest>;
}

export const noViewStrategyRequestFields = {
  symbol: nonEmptyString.refine((v) => v.trim().length > 0, "must not be blank"),
  maxPlannedLoss: fin(),
  minRewardRisk: fin(),
  minProbabilityOfProfit: fin()
    .refine((v) => v > 0 && v <= 1, "must be in (0, 1]")
    .optional(),
  riskProfile: riskProfileSchema.optional(),
  ...strategyThresholdFields,
  allowedStrategies: allowedStrategiesSchema.optional(),
};

export const noViewStrategyRequestSchema = z
  .strictObject(noViewStrategyRequestFields)
  .superRefine(dteOrderCheck);

export function parseNoViewStrategyRequest(input: unknown): ScreeningValidationResult<NoViewStrategyRequest> {
  return parseWith("no-view strategy request", noViewStrategyRequestSchema, input) as ScreeningValidationResult<NoViewStrategyRequest>;
}

/* Field-check variants backing the legacy validators in
 * strategyRiskAgent.ts. Those validators historically IGNORE keys that
 * are not StrategyRequest fields (callers such as /trading/options/
 * compare pass envelope-bearing bodies and validate the envelope
 * separately), so the checks run over the same field definitions with a
 * non-strict object. The strict schemas above are what raw entry-point
 * bodies (routes, schedule creation) are validated with. */
const strategyRequestFieldCheck = z.object(strategyRequestFields).superRefine(dteOrderCheck);
const noViewStrategyRequestFieldCheck = z.object(noViewStrategyRequestFields).superRefine(dteOrderCheck);

export function checkStrategyRequestFields(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "expected an object";
  }
  const result = strategyRequestFieldCheck.safeParse(input);
  return result.success ? null : formatIssues("strategy request", result.error);
}

export function checkNoViewRequestFields(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "expected an object";
  }
  const record = input as Record<string, unknown>;
  for (const field of NO_VIEW_FORBIDDEN_FIELDS) {
    if (record[field] !== undefined) return `${field}: view fields are not allowed in a no-view request`;
  }
  const result = noViewStrategyRequestFieldCheck.safeParse(input);
  return result.success ? null : formatIssues("no-view strategy request", result.error);
}

/* The /api/trading/options/strategies + /best-trade route body: a
 * StrategyRequest plus the route's own envelope fields, which the route
 * validates and forwards separately today. */
export const strategyScreenFilterSchema = z.strictObject({
  strategyTypes: z.array(z.string()).optional(),
  minProbabilityOfProfit: fin().optional(),
  maxNetDebit: fin().optional(),
  minNetCredit: fin().optional(),
  minTargetPnl: fin().optional(),
  minMaxProfit: fin().optional(),
  minRewardRisk: fin().optional(),
  maxProfitGreaterThanMaxLoss: z.boolean().optional(),
  maxBreakevenDistancePct: fin().optional(),
  maxLegs: fin().optional(),
  requireFresh: z.boolean().optional(),
}) satisfies z.ZodType<StrategyScreenFilter>;

export interface OptionsDiscoveryRequest {
  request: StrategyRequest;
  strategyFilter?: StrategyScreenFilter;
  riskProfile?: "conservative" | "balanced" | "aggressive";
  alternatives?: number;
}

const optionsDiscoveryRequestSchema = z
  .strictObject({
    ...strategyRequestFields,
    strategyFilter: strategyScreenFilterSchema.optional(),
    riskProfile: riskProfileSchema.optional(),
    alternatives: intAtLeast(0).optional(),
  })
  .superRefine(dteOrderCheck);

export function parseOptionsDiscoveryRequest(input: unknown): ScreeningValidationResult<OptionsDiscoveryRequest> {
  const parsed = parseWith("options discovery request", optionsDiscoveryRequestSchema, input);
  if (!parsed.ok) return parsed;
  const { strategyFilter, riskProfile, alternatives, ...request } = parsed.value as Record<string, unknown>;
  return {
    ok: true,
    value: {
      request: request as unknown as StrategyRequest,
      ...(strategyFilter !== undefined ? { strategyFilter: strategyFilter as StrategyScreenFilter } : {}),
      ...(riskProfile !== undefined ? { riskProfile: riskProfile as OptionsDiscoveryRequest["riskProfile"] } : {}),
      ...(alternatives !== undefined ? { alternatives: alternatives as number } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Unified options requests (UnifiedOptionsService)                    */
/* ------------------------------------------------------------------ */

const scanTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absolute"), price: fin() }),
  z.strictObject({ kind: z.literal("percent"), pct: fin() }),
  z.strictObject({ kind: z.literal("em"), multiple: fin() }),
]);

const scanSymbolOverrideSchema = z.strictObject({
  thesis: optionThesisSchema.optional(),
  target: scanTargetSchema.optional(),
});

export const unifiedOptionsRequestFields = {
  action: z.enum([
    "screen",
    "strategies",
    "best_trade",
    "opportunities",
    "recommend",
    "compare",
    "llm_ideas",
    "llm_evaluate",
    "config",
    "catalog",
    "discovery",
  ]),
  symbol: z.string().optional(),
  symbols: z.array(tickerSchema).optional(),
  maxSymbols: intAtLeast(1).optional(),
  thesis: optionThesisSchema.optional(),
  targetPrice: fin().optional(),
  targetDate: z.string().optional(),
  expectedIvDirection: expectedIvDirectionSchema.optional(),
  riskProfile: riskProfileSchema.optional(),
  allowedStrategies: z.array(z.string()).optional(),
  maxPlannedLoss: fin().optional(),
  minRewardRisk: fin().optional(),
  optimizationBias: fin().optional(),
  mode: z.enum(["strategy_fit", "per_name_best"]).optional(),
  perSymbol: z.record(z.string(), scanSymbolOverrideSchema).optional(),
  // Issue #16: server-populated per-name event calendars. The field
  // must be present here (optional) so this object satisfies
  // Record<keyof UnifiedOptionsRequest, ...> — its absence broke the
  // CI type check after #959. A client-supplied value is still never
  // trusted: the unified route deletes it after parsing and refetches
  // coverage server-side before the service runs.
  eventCalendarBySymbol: z.record(z.string(), eventCalendarSchema).optional(),
  statedTarget: z
    .strictObject({ price: fin(), symbol: z.string().optional() })
    .optional(),
  minDte: intAtLeast(0).optional(),
  maxDte: intAtLeast(0).optional(),
  offset: intAtLeast(0).optional(),
  profileId: z.string().optional(),
  profileName: z.string().optional(),
  filter: optionScreenerFilterSchema.optional(),
  channel: z.enum(["ui", "slack", "email", "voice", "webhook", "mcp", "chat"]).optional(),
  question: z.string().optional(),
  limit: intAtLeast(1).optional(),
  userLogin: z.string().optional(),
  overrideEnv: z.string().optional(),
  // Issue #2091: scheduled all-strategy scope (client/manual callers
  // omit it; the schema must still declare the key).
  evaluateAllStrategies: z.boolean().optional(),
} satisfies Record<keyof UnifiedOptionsRequest, z.ZodType>;

export const unifiedOptionsRequestSchema = z.strictObject(unifiedOptionsRequestFields);

export interface UnifiedOptionsRouteRequest {
  request: UnifiedOptionsRequest;
  /** Delivery envelope read by the /api/trading/options/unified route;
   *  NOT part of the service request. */
  pushToSlack?: boolean;
  slackChannel?: string;
}

const unifiedOptionsRouteRequestSchema = z.strictObject({
  ...unifiedOptionsRequestFields,
  pushToSlack: z.boolean().optional(),
  slackChannel: z.string().optional(),
});

export function parseUnifiedOptionsRequest(input: unknown): ScreeningValidationResult<UnifiedOptionsRouteRequest> {
  const parsed = parseWith("unified options request", unifiedOptionsRouteRequestSchema, input);
  if (!parsed.ok) return parsed;
  const { pushToSlack, slackChannel, ...request } = parsed.value as Record<string, unknown>;
  return {
    ok: true,
    value: {
      request: request as unknown as UnifiedOptionsRequest,
      ...(pushToSlack !== undefined ? { pushToSlack: pushToSlack as boolean } : {}),
      ...(slackChannel !== undefined ? { slackChannel: slackChannel as string } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* NLQ scan template (OpportunityScanner ScanRequestTemplate)          */
/* ------------------------------------------------------------------ */

/** The per-symbol scan template the NLQ scan path assembles and hands to
 *  OpportunityScanner: a StrategyRequest minus symbol/targetPrice (the
 *  scanner iterates symbols itself), plus the caller's stated target.
 *  Validated at the NLQ seam so a mis-shaped plan fails explicitly
 *  instead of scanning under silently-dropped fields. */
export const scanRequestTemplateFields = {
  thesis: optionThesisSchema,
  targetDate: z.string(),
  expectedIvDirection: expectedIvDirectionSchema,
  maxPlannedLoss: fin(),
  minRewardRisk: fin(),
  ...strategyThresholdFields,
  allowedStrategies: allowedStrategiesSchema,
  statedTarget: z
    .strictObject({ price: fin(), symbol: z.string().optional() })
    .optional(),
  perSymbol: z.record(z.string(), scanSymbolOverrideSchema).optional(),
};

export const scanRequestTemplateSchema = z
  .strictObject(scanRequestTemplateFields)
  .superRefine(dteOrderCheck);

export function parseScanRequestTemplate(input: unknown): ScreeningValidationResult<Record<string, unknown>> {
  return parseWith("scan request template", scanRequestTemplateSchema, input);
}

/* ------------------------------------------------------------------ */
/* Schedule payloads — the screening callbacks                         */
/* ------------------------------------------------------------------ */

export const SCREENING_SCHEDULE_CALLBACKS = [
  "autonomousMarketScreen",
  "autonomousOptionsAnalysis",
  "autonomousStrategyDiscovery",
  // Consolidation C1 (issue #1201, epic #1151 R1): the goal-driven
  // screen joins the schedule store as a first-class callback, so a
  // Phase 1 goal/scenario screen can be run from a schedule through
  // the one scheduling capability.
  "autonomousGoalScreen",
] as const;
export type ScreeningScheduleCallback = (typeof SCREENING_SCHEDULE_CALLBACKS)[number];

export interface ScheduleIdentity {
  /** Trusted login stamped from the caller's session — never criteria. */
  userLogin?: string;
  /** Trusted broker environment stamped likewise. */
  environment?: string;
  /** "scheduled" for armed schedules, "manual" for trigger-route runs. */
  trigger: "manual" | "scheduled";
}

const deliveryFields = {
  pushToSlack: z.boolean().optional(),
  slackChannel: z.string().optional(),
  emailTo: z.string().optional(),
  webhookUrl: z.string().optional(),
};

/**
 * Consolidation C3 (issue #1277, epic #1151; stage-layered
 * scheduling, #1236): per-stage timing for a scheduled run's stage
 * chain. When a market-screen schedule carries `stageChain`, the
 * run's follow-up bridge records the run as the chain's `generate`
 * stage and schedules the `serve` (report adoption) and `deliver`
 * (per-channel delivery) stages as stage jobs on the async-job
 * substrate, each delayed by its own offset from its predecessor's
 * completion. Absent = the fused immediate chain (the degenerate
 * case). Delays are whole seconds, 0..604800 (7 days).
 *
 * Only the market-screen criteria carried the field in C3: its runs
 * rode the #1123 follow-up bridge end-to-end. Consolidation C4
 * (#1329) extends it to the options, discovery, and goal criteria:
 * options chains fully in chain mode (bridge delivery replaces the
 * direct path); discovery chains carry chain identity + the serve
 * stage, with delivery staying on the run's direct path (see
 * screenerFollowups deliverViaChain) — discovery deliver-stage
 * chaining is #1236 remainder. Goal chains deliver through the chain
 * since #1236 (direct path suppressed in chain mode).
 *
 * The config type itself lives in src/types.ts (with PipelineStage)
 * and is re-exported here, where its validation lives.
 */
export type { StageChainConfig } from "../types";

const stageDelaySecondsSchema = z.number().int().min(0).max(604_800);

const stageChainFields = {
  stageChain: z
    .strictObject({
      serveDelaySeconds: stageDelaySecondsSchema.optional(),
      deliverDelaySeconds: stageDelaySecondsSchema.optional(),
    })
    .optional(),
};

/** `trigger` is part of the services' options types and the manager's
 *  payloads carry it; it is accepted as criteria and always overwritten
 *  by the identity stamp at assembly. */
const triggerField = { trigger: z.enum(["manual", "scheduled"]).optional() };

export const marketScreenScheduleCriteriaSchema = z.strictObject({
  sector: nonEmptyString.optional(),
  universe: z.string().optional(),
  symbols: z.array(z.string()).optional(),
  broadcast: z.boolean().optional(),
  filters: stockScreenerFilterSchema.optional(),
  // Issue #1499 (#940-E): a scheduled stock screen may reference a
  // stored preset by id. The id (not the criteria) is what arms the
  // schedule — the criteria resolve at RUN time, so preset edits apply
  // to future runs. Existence is NOT checked here: this builder is pure
  // validation with no store access, and a deleted preset must fail the
  // run loudly at resolution time, not at arm time.
  presetId: nonEmptyString.optional(),
  // Issue #1007: a scheduled stock screen may name its data provider
  // (the Yahoo data-source adapter inside the one pipeline). Absent =
  // the E*TRADE default every existing schedule already runs under.
  provider: z.enum(["etrade", "yahoo"]).optional(),
  // Issue #1355: a scheduled stock screen may opt into sharded
  // execution (feed → generate → store → serve → deliver as
  // async-job shards). Absent/false keeps the monolithic path.
  sharded: z.boolean().optional(),
  ...deliveryFields,
  ...stageChainFields,
  ...triggerField,
});

export const optionsAnalysisScheduleCriteriaSchema = z.strictObject({
  symbols: z.array(z.string()).optional(),
  universe: z.string().optional(),
  thesis: optionThesisSchema.optional(),
  targetDate: z.string().optional(),
  allowedStrategies: z.array(z.string()).optional(),
  riskProfile: riskProfileSchema.optional(),
  // Issue #1574: opt into durable per-symbol option-chain shards.
  // Absent/false preserves the established monolithic path.
  sharded: z.boolean().optional(),
  ...deliveryFields,
  ...stageChainFields,
  ...triggerField,
});

/** Discovery criteria are typed loosely at the zod layer on purpose:
 *  the strict object still rejects unknown keys, but the three input
 *  models' rules (and the per-request / per-constraint-set checks) run
 *  as explicit code below so the error strings stay EXACTLY the create
 *  route's historical ones, composed from the shared strategy
 *  validators — a zod type error must never pre-empt them. */
export const strategyDiscoveryScheduleCriteriaSchema = z.strictObject({
  inputModel: z.unknown().optional(),
  requests: z.unknown().optional(),
  symbols: z.unknown().optional(),
  watchlistName: z.unknown().optional(),
  profileId: z.unknown().optional(),
  constraintSets: z.unknown().optional(),
  scheduleId: z.unknown().optional(),
  /** Consolidation #1236 (discovery notifications): per-task delivery
   *  recipients. Exactly these three — NOT the full deliveryFields
   *  spread: pushToSlack is a panel checkbox artifact, not a
   *  discovery channel selector, and the strict object keeps
   *  rejecting it for discovery payloads (as before). */
  emailTo: z.string().optional(),
  slackChannel: z.string().optional(),
  webhookUrl: z.string().optional(),
  /** Consolidation #1236 (feed seam): snapshot-input mode for the
   *  run — exact artifacts per symbol, latest per symbol, or both
   *  (artifacts win per symbol). At least one of artifacts/latest
   *  is required; a snapshotInput naming neither is rejected here,
   *  not at fire time. maxAgeSeconds bounds generate-time freshness
   *  (absent ⇒ no staleness judgment). Other callbacks' strict
   *  objects reject this field. */
  snapshotInput: z.object({
    artifacts: z.record(z.string(), z.string()).optional(),
    latest: z.boolean().optional(),
    maxAgeSeconds: z.number().int().positive().optional(),
  }).refine((v) => v.artifacts !== undefined || v.latest === true, {
    message: "snapshotInput needs artifacts or latest.",
  }).optional(),
  ...stageChainFields,
  ...triggerField,
});

/**
 * The goal kinds a goal-screen schedule may name (consolidation C1,
 * issue #1201). The canonical list lives with the goal/scenario
 * engine (src/services/goalScenarioEngine.ts GOAL_KINDS); src/trading
 * cannot import src/services (the #290 boundary), so the list is
 * mirrored here and a drift pin
 * (tests/consolidation_c1_execution_path.test.ts) fails the suite if
 * the two ever disagree — the Phase 1 taxonomy-mirror idiom.
 */
export const SCREENING_GOAL_KINDS = [
  "income",
  "directional",
  "volatility_event",
  "hedge_protect",
  "repair",
  "deconcentrate",
  "iv_harvest",
  "capital_efficient_leverage",
  "cash_secured_entry",
] as const;

/** Goal-screen criteria: a goal kind (validated as explicit code
 *  below, like the discovery input models, so the error names the
 *  field) or a stored scenario id, plus optional direction / symbols
 *  / asset classes and the shared delivery fields. */
export const goalScreenScheduleCriteriaSchema = z.strictObject({
  goalKind: z.string().optional(),
  direction: z.enum(["bullish", "bearish", "volatile", "range_bound", "unknown"]).optional(),
  scenarioId: z.string().optional(),
  symbols: z.array(z.string()).optional(),
  assetClasses: z.array(z.enum(["stocks", "options"])).optional(),
  ...deliveryFields,
  ...stageChainFields,
  ...triggerField,
});

const DISCOVERY_INPUT_MODELS = ["saved-request", "profile-derived", "no-view"] as const;

function validateDiscoveryCriteria(
  criteria: Record<string, unknown>
): string | null {
  const inputModel = criteria.inputModel;
  if (
    inputModel !== undefined &&
    !(DISCOVERY_INPUT_MODELS as readonly unknown[]).includes(inputModel)
  ) {
    return `Unknown discovery inputModel '${inputModel}'. Use "saved-request", "profile-derived", or "no-view".`;
  }
  if (inputModel !== "no-view" && criteria.constraintSets !== undefined) {
    return 'payload.constraintSets belongs to the no-view discovery input model (inputModel "no-view") and cannot be combined with saved requests or a profile.';
  }
  if (inputModel === "no-view") {
    if (
      criteria.requests !== undefined ||
      criteria.symbols !== undefined ||
      criteria.watchlistName !== undefined ||
      criteria.profileId !== undefined
    ) {
      return "No-view discovery schedules carry payload.constraintSets only — requests, symbols, watchlistName and profileId belong to the other discovery input models.";
    }
    const constraintSets = criteria.constraintSets;
    if (!Array.isArray(constraintSets) || constraintSets.length === 0) {
      return "No-view discovery schedules require at least one constraint set in payload.constraintSets.";
    }
    if (constraintSets.length > MAX_SAVED_REQUESTS_PER_RUN) {
      return `No-view discovery schedules are capped at ${MAX_SAVED_REQUESTS_PER_RUN} symbols per schedule.`;
    }
    for (let i = 0; i < constraintSets.length; i++) {
      const setError = checkNoViewRequestFields(constraintSets[i]);
      if (setError !== null) {
        const symbol =
          typeof constraintSets[i]?.symbol === "string" ? constraintSets[i].symbol : "?";
        return `No-view constraint set ${i + 1} (${symbol}) is invalid: ${NO_VIEW_REQUEST_INVALID_MESSAGE}`;
      }
    }
    return null;
  }
  if (inputModel === "profile-derived") {
    const profileId = criteria.profileId;
    if (typeof profileId !== "string" || !profileId.trim()) {
      return "Profile-derived discovery schedules require payload.profileId (the Strategy Profile to derive targets under).";
    }
    const hasSymbols = criteria.symbols !== undefined;
    const hasWatchlist = criteria.watchlistName !== undefined;
    if (hasSymbols === hasWatchlist) {
      return "Profile-derived discovery schedules require exactly one symbol source: payload.symbols or payload.watchlistName.";
    }
    if (hasSymbols) {
      const derivedSymbols = criteria.symbols;
      if (!Array.isArray(derivedSymbols) || derivedSymbols.length === 0) {
        return "payload.symbols must name at least one symbol for a profile-derived discovery schedule.";
      }
      if (derivedSymbols.length > MAX_SAVED_REQUESTS_PER_RUN) {
        return `Profile-derived discovery schedules are capped at ${MAX_SAVED_REQUESTS_PER_RUN} symbols per schedule.`;
      }
      // Ticker shape itself is enforced by buildSchedulePayload's
      // generic symbols check, which runs for every callback first.
    }
    if (hasWatchlist) {
      const watchlistName = criteria.watchlistName;
      if (typeof watchlistName !== "string" || !watchlistName.trim()) {
        return "payload.watchlistName must be a non-empty watchlist name.";
      }
    }
    return null;
  }
  // saved-request (the default model)
  const savedRequests = criteria.requests;
  if (!Array.isArray(savedRequests) || savedRequests.length === 0) {
    return "Discovery schedules require at least one saved strategy request in payload.requests.";
  }
  if (savedRequests.length > MAX_SAVED_REQUESTS_PER_RUN) {
    return `Discovery schedules are capped at ${MAX_SAVED_REQUESTS_PER_RUN} saved requests per schedule.`;
  }
  for (let i = 0; i < savedRequests.length; i++) {
    const requestError = checkStrategyRequestFields(savedRequests[i]);
    if (requestError !== null) {
      const symbol =
        typeof savedRequests[i]?.symbol === "string" ? savedRequests[i].symbol : "?";
      return `Saved discovery request ${i + 1} (${symbol}) is invalid: ${STRATEGY_REQUEST_INVALID_MESSAGE}`;
    }
  }
  return null;
}

/**
 * Validate schedule criteria for one of the three screening callbacks
 * and assemble the payload the schedule will be armed (or triggered)
 * with. This is the single builder shared by the REST create route, the
 * trigger routes, and the NLQ scheduling executor — the assembly
 * semantics are the create route's historical ones:
 *
 *   - effectiveUniverse = criteria.universe, defaulting to "NASDAQ100"
 *     for autonomousOptionsAnalysis without symbols;
 *   - maxItems defaults to the effective universe's defaultMaxSymbols,
 *     else the symbol count (0 when neither exists — the discovery
 *     service ignores it; an explicit 0 is preserved: for options
 *     analysis it means "all");
 *   - identity (userLogin / environment / trigger) is stamped from the
 *     trusted caller context, never taken from the criteria;
 *   - autonomousMarketScreen WITHOUT a universe stamps no maxItems
 *     default (the market-screen service applies its own TECH-universe
 *     default at run time). The REST create route additionally requires
 *     an explicit universe for stock schedules — that is creation
 *     policy enforced by the route on top of this builder, not a
 *     property of the payload shape.
 *
 * Error strings for the shared rules are the create route's historical
 * strings, verbatim.
 */
export function buildSchedulePayload(
  callback: string,
  criteriaInput: unknown,
  identity: ScheduleIdentity,
  options?: {
    /** Creation defaults (effective-universe + maxItems stamping)
     *  apply when a schedule is ARMED — the create route and the NLQ
     *  executor. The trigger routes pass false: a manual trigger runs
     *  the caller's criteria as given (validated + identity-stamped),
     *  and the services apply their own identical defaults at run
     *  time, exactly as they did before #959. */
    applyCreationDefaults?: boolean;
  }
): ScreeningValidationResult<Record<string, unknown>> {
  const applyCreationDefaults = options?.applyCreationDefaults !== false;
  if (!(SCREENING_SCHEDULE_CALLBACKS as readonly string[]).includes(callback)) {
    return { ok: false, error: `'${callback}' is not a screening schedule callback.` };
  }
  if (criteriaInput === null || typeof criteriaInput !== "object" || Array.isArray(criteriaInput)) {
    return { ok: false, error: "payload must be an object of screening criteria." };
  }
  const criteria = criteriaInput as Record<string, unknown>;

  // Universe rules (the create route's, in its order).
  const universeValue = criteria.universe as string | undefined;
  if (universeValue !== undefined && !(universeValue in UNIVERSES)) {
    return { ok: false, error: `Unknown screening universe '${universeValue}'.` };
  }
  if (universeValue === "ALL") {
    return { ok: false, error: "Choose one specific universe for a scheduled screen." };
  }

  // Symbol shape (all three callbacks).
  const rawSymbols = criteria.symbols;
  if (
    rawSymbols !== undefined &&
    (!Array.isArray(rawSymbols) ||
      rawSymbols.some((s) => typeof s !== "string" || !/^[A-Z0-9./-]{1,16}$/i.test(s)))
  ) {
    return { ok: false, error: "symbols must be an array of valid ticker strings." };
  }

  // Per-callback criteria shape (strict; maxItems is checked separately
  // below to keep the route's rule and message).
  const { maxItems: rawMaxItems, ...criteriaSansMaxItems } = criteria;
  const shape =
    callback === "autonomousMarketScreen"
      ? marketScreenScheduleCriteriaSchema
      : callback === "autonomousOptionsAnalysis"
        ? optionsAnalysisScheduleCriteriaSchema
        : callback === "autonomousGoalScreen"
          ? goalScreenScheduleCriteriaSchema
          : strategyDiscoveryScheduleCriteriaSchema;
  const shapeResult = shape.safeParse(criteriaSansMaxItems);
  if (!shapeResult.success) {
    return { ok: false, error: formatIssues("schedule payload", shapeResult.error) };
  }
  const validated = shapeResult.data as Record<string, unknown>;

  // Discovery input-model rules (exact historical strings).
  if (callback === "autonomousStrategyDiscovery") {
    const discoveryError = validateDiscoveryCriteria(validated);
    if (discoveryError !== null) return { ok: false, error: discoveryError };
  }

  // Goal-screen rules (C1): a schedule names a goal kind or a stored
  // scenario — never neither — and the kind must be a real goal kind
  // (the drift-pinned SCREENING_GOAL_KINDS list).
  if (callback === "autonomousGoalScreen") {
    const goalKind = validated.goalKind as string | undefined;
    const scenarioId = validated.scenarioId as string | undefined;
    if (goalKind !== undefined && !(SCREENING_GOAL_KINDS as readonly string[]).includes(goalKind)) {
      return {
        ok: false,
        error: `goalKind must be one of: ${SCREENING_GOAL_KINDS.join(", ")}.`,
      };
    }
    if (goalKind === undefined && scenarioId === undefined) {
      return {
        ok: false,
        error: "goalKind is required when scenarioId is not supplied.",
      };
    }
  }

  // maxItems range (the create route's rule: whole number 0..10000;
  // non-numeric input fails the safe-integer check, as it did inline).
  if (
    rawMaxItems !== undefined &&
    (typeof rawMaxItems !== "number" ||
      !Number.isSafeInteger(rawMaxItems) ||
      rawMaxItems < 0 ||
      rawMaxItems > 10000)
  ) {
    return { ok: false, error: "maxItems must be a whole number from 0 to 10000." };
  }

  // Assembly (the create route's semantics — see the doc comment).
  const symbols = validated.symbols as string[] | undefined;
  const effectiveUniverse = !applyCreationDefaults
    ? undefined
    : universeValue ||
      (callback === "autonomousOptionsAnalysis" && (!symbols || symbols.length === 0)
        ? "NASDAQ100"
        : undefined);
  const defaultMaxItems = !applyCreationDefaults
    ? undefined
    : effectiveUniverse
      ? UNIVERSES[effectiveUniverse as keyof typeof UNIVERSES].defaultMaxSymbols
      : callback === "autonomousMarketScreen"
        ? undefined
        : callback === "autonomousGoalScreen"
          ? // C1: maxItems has no meaning for a goal screen (the
            // scenario's constraints size the run) — stamp none.
            undefined
          : symbols?.length || 0;
  const maxItems = (rawMaxItems as number | undefined) ?? defaultMaxItems;

  const payload: Record<string, unknown> = {
    ...validated,
    ...(effectiveUniverse ? { universe: effectiveUniverse } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
    ...(identity.userLogin ? { userLogin: identity.userLogin } : {}),
    ...(identity.environment ? { environment: identity.environment } : {}),
    trigger: identity.trigger,
  };
  return { ok: true, value: payload };
}

/* ------------------------------------------------------------------ */
/* Runs list query (issue #1057, consolidation S5)                     */
/* ------------------------------------------------------------------ */

/** The kind filter of GET /api/runs — the one Runs read surface over
 *  the four run stores. "all" is the unfiltered merge. */
export const runsListKindSchema = z.enum(["screener", "options_scanner", "discovery", "goal", "all"]);
export type RunsListKind = z.infer<typeof runsListKindSchema>;

/** Validate the `kind` query parameter of GET /api/runs in the S1
 *  idiom: a field-named error, no coercion — an unknown kind is a 400,
 *  never a silent "all". */
export function parseRunsListKind(input: unknown): ScreeningValidationResult<RunsListKind> {
  const result = runsListKindSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: `Invalid runs list query: kind: must be one of "screener", "options_scanner", "discovery", "goal", "all".`,
  };
}
