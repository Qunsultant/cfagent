/**
 * Issue #2809 (Phase 2 Slice 1 under #2764) — one normalized
 * StockScreenRunSpec for the two REST stock-screen routes.
 *
 * Pure Fabrication / Information Expert (GRASP): this module owns
 * the single construction of a run spec from the two steps both
 * REST routes already performed separately — admitScreenModeSelection
 * (#2530) and parseStockScreenRequest (#959) — plus the delivery
 * envelope. It introduces no new schema, no new validation, and no
 * behaviour change: the schema stays single-source in
 * src/trading/screeningSchemas.ts, imported here only through the
 * sole public surface src/trading (issue #290 trading boundary),
 * and mode admission stays in screenerWorkflowRoutes.ts. Routes
 * only stop assembling the spec by hand.
 *
 * Divergence is pinned as data, not as branching code:
 *   - E*TRADE route:  source "etrade",      deliver true,  provider
 *     the tenant-resolved provider the route passes in, delivery
 *     = the parsed envelope (the sync path publishes it via
 *     publishOrBridge).
 *   - Market-data route: source "market-data", deliver false,
 *     provider the tenant-resolved provider the route passes in,
 *     delivery = {} — the parsed envelope is deliberately NOT
 *     forwarded, exactly as today: the market-data route has no
 *     deliver step.
 *   - Goal stock leg (issue #2882): source "goal", deliver
 *     false, provider unset, universe "ALL", asyncRequested
 *     false, delivery = {}. Goal delivery and the goal
 *     provider stay owned by goal dispatch until the
 *     migration follow-up; the broker guard is retired
 *     (#2991) — a goal spec with async requested now routes
 *     like any spec, carrying goal provenance (specTrigger)
 *     through the command. "ALL" records that goal legs are not
 *     universe-scoped (the registry provider screens its
 *     listings feed) — it is not a coverage claim, and the
 *     spec is a canonical record of the leg, not an
 *     execution reroute: goal execution stays in
 *     goalDrivenScreen + goal dispatch.
 *   - Broker route (issue #4433): source "broker", deliver
 *     false, provider the tenant-resolved broker the route
 *     stamps (the route screens the broker's own quotes, so
 *     the broker names the provider), universe the resolved
 *     universe id or "symbols" for an explicit list, delivery
 *     = {} — the route has no deliver step, exactly as the
 *     market-data divergence.
 *
 * Issue #4431 (S5/N3): the provider is never hardcoded per route
 * anymore. The routes resolve the tenant's effective data-provider
 * selection and pass it as `provider`; the builder carries it onto
 * the spec verbatim. A caller that passes none leaves the spec
 * without a provider, and the planner refuses the run
 * (FAILURE_NO_SCREENING_PROVIDER) instead of screening another
 * provider's data.
 *
 * Ordering contract (preserves both routes' behaviour exactly):
 * the E*TRADE route admits the mode BEFORE its listings switch
 * and parses only after the listings branch, so it passes its
 * already-admitted modeSelection in and this builder does not
 * re-admit (a second admit on a POST body would see the mode
 * fields already stripped and lose an ND selection). The
 * market-data route passes no modeSelection and the builder
 * admits it. `rawFilters` is mutated exactly as today by
 * admitScreenModeSelection on POST (screenMode/screenIntent
 * stripped so they never leak into the filters); `async` must
 * already have been stripped by the caller, as both routes do.
 */

import { parseStockScreenRequest } from "../trading";
import type { StockScreenProvider } from "../trading";
import { normalizeJobRunTrigger, type JobRunTrigger } from "../data/jobRunRecordPorts";
import {
  admitScreenModeSelection,
  type ScreenModeSelection,
} from "./screenerWorkflowRoutes";
import type { StageChainConfig, StockScreenerFilter } from "../types";

/** The per-request delivery envelope, defined once here. */
export interface StockScreenDelivery {
  emailTo?: string;
  pushToSlack?: boolean;
  slackChannel?: string;
  webhookUrl?: string;
  generatePdf?: boolean;
}

export type StockScreenSource = "etrade" | "market-data" | "goal" | "nlq" | "mesh" | "research" | "premium" | "scheduled" | "broker";

/**
 * Issue #2908 (G1 under #2764) — the run's trigger vocabulary.
 * The workflow command's trigger stays "manual" | "scheduled"
 * (workflowPorts validation); this richer trigger is the spec's
 * provenance record and maps to the workflow trigger via
 * workflowTriggerForSpec. "research" is the research-tab
 * screener (the market-data screen route); "nlq" / "mesh"
 * are the chat / mesh-door screens, whose commands carry
 * specTrigger (workflowPorts) so the provenance survives
 * the workflow hop instead of collapsing to "manual".
 */
export type StockScreenTrigger =
  | JobRunTrigger
  | "nlq"
  | "mesh"
  | "goal"
  | "research";

/** Issue #2908 (G1) — a pattern pinned at run creation: id + version, never re-resolved downstream. */
export interface StockScreenPatternRef {
  patternId: string;
  version: string;
}

/** Issue #2908 (G1) — a preset resolved at run time: id + resolution timestamp. */
export interface StockScreenPresetRef {
  presetId: string;
  resolvedAt: string;
}

/** Issue #2908 (G1) — the provenance fields every path populates; all but trigger are optional because a path records only what it knows (genuinely unavailable fields stay absent, never fabricated). */
export interface StockScreenRunProvenance {
  trigger?: StockScreenTrigger;
  userLogin?: string;
  scheduleId?: string;
  jobId?: string;
  goalId?: string;
  patternRef?: StockScreenPatternRef;
  presetRef?: StockScreenPresetRef;
  /**
   * Issue #2909 (G2): run qualifications for pattern guardrails
   * with no filter field — human lines naming each guardrail
   * and stating it is not enforced. Recorded on the canonical
   * body and shown on replay; never converted into filters.
   */
  patternQualifications?: string[];
}

/**
 * The normalized run spec both REST routes execute from. `minScore`
 * is carried for compatibility (the #959 envelope field) and is
 * never forwarded into the engine filter — `filters` already
 * excludes it, as parseStockScreenRequest splits it out.
 */
export interface StockScreenRunSpec extends StockScreenRunProvenance {
  source: StockScreenSource;
  /** Issue #4431 (S5/N3): the tenant-resolved provider the routes stamp. Undefined for goal
   * (goal-owned); never a per-route hardcode. */
  provider?: StockScreenProvider;
  /** The pinned delivery divergence: E*TRADE true, market-data and goal false. */
  deliver: boolean;
  filters: StockScreenerFilter;
  universe: string;
  /**
   * Issue #6682: explicit tickers the run screens (the request's
   * symbols envelope). Present ⇒ the command carries a symbols shard
   * and the feed fetches exactly these; absent ⇒ universe-scoped.
   */
  symbols?: string[];
  minScore?: number;
  asyncRequested: boolean;
  delivery: StockScreenDelivery;
  /**
   * Issue #4280 ([One engine] #3550 S5): the stage-chain config the
   * scheduled run was armed with — carried onto the workflow command
   * so the deliver stage bridges serve + deliver with its delays.
   * Absent = the unchained immediate bridge.
   */
  stageChain?: StageChainConfig;
  screenMode?: "non-deterministic";
  screenIntent?: string;
  /** Issue #2882: goal provenance, present only on source "goal" specs. Kept as a reference, never flattened into the filter. */
  goal?: {
    goalKind: string;
    outlook: string;
    structures: string[];
  };
  /**
   * Issue #2908 (G1): the run trigger. The builder always sets
   * it (goal source -> "goal", nlq/mesh sources -> "copilot"
   * (#5053: a chat screen is a copilot dispatch), otherwise
   * "manual" unless the caller passes one); hand-built specs must
   * set it too — downstream code never re-derives it, and the UI
   * renders a missing trigger as "unknown", never as "scheduled".
   */
  trigger: StockScreenTrigger;
}

/**
 * Issue #2908 (G1): overlay provenance onto a spec without
 * re-deriving anything. Only defined values win; a path that
 * does not know a field leaves it absent rather than
 * fabricating it. Pure — used by REST (builder), scheduled,
 * NLQ, mesh, goal, and research paths alike.
 */
export function withRunProvenance(
  spec: StockScreenRunSpec,
  provenance: StockScreenRunProvenance,
): StockScreenRunSpec {
  const out: StockScreenRunSpec = { ...spec };
  if (provenance.trigger !== undefined) out.trigger = provenance.trigger;
  if (provenance.userLogin !== undefined) out.userLogin = provenance.userLogin;
  if (provenance.scheduleId !== undefined) out.scheduleId = provenance.scheduleId;
  if (provenance.jobId !== undefined) out.jobId = provenance.jobId;
  if (provenance.goalId !== undefined) out.goalId = provenance.goalId;
  if (provenance.patternRef !== undefined) out.patternRef = provenance.patternRef;
  if (provenance.presetRef !== undefined) out.presetRef = provenance.presetRef;
  if (provenance.patternQualifications !== undefined) out.patternQualifications = provenance.patternQualifications;
  return out;
}

/** Issue #2908 (G1): the workflow command trigger for a spec — the
 * five dispatch modes pass through (#5052); a source-only spec
 * trigger (nlq / mesh / goal / research) commands as manual, as
 * before. The spec's own trigger rides the command as specTrigger. */
export function workflowTriggerForSpec(spec: StockScreenRunSpec): JobRunTrigger {
  return normalizeJobRunTrigger(spec.trigger);
}

/**
 * Issue #2908 (G1): the spec fields a canonical mas_reports
 * body carries, as a spreadable object (defined fields only).
 * Canonical writers spread this instead of re-deriving
 * trigger/userLogin/refs by hand from the run result.
 */
export function specCanonicalFields(spec: StockScreenRunSpec): Record<string, unknown> {
  return {
    trigger: spec.trigger,
    ...(spec.userLogin !== undefined ? { userLogin: spec.userLogin } : {}),
    ...(spec.scheduleId !== undefined ? { scheduleId: spec.scheduleId } : {}),
    ...(spec.jobId !== undefined ? { jobId: spec.jobId } : {}),
    ...(spec.goalId !== undefined ? { goalId: spec.goalId } : {}),
    ...(spec.patternRef !== undefined ? { patternRef: spec.patternRef } : {}),
    ...(spec.presetRef !== undefined ? { presetRef: spec.presetRef } : {}),
    ...(spec.patternQualifications !== undefined ? { patternQualifications: spec.patternQualifications } : {}),
  };
}

export type BuildStockScreenRunSpecResult =
  | { ok: true; spec: StockScreenRunSpec }
  | { ok: false; error: string };

export function buildStockScreenRunSpec(args: {
  env: unknown;
  method: string;
  rawFilters: Record<string, unknown> & {
    screenMode?: unknown;
    screenIntent?: unknown;
  };
  query: URLSearchParams;
  asyncRequested: boolean;
  source: StockScreenSource;
  /** Pre-admitted mode (E*TRADE route: admitted before listings). */
  modeSelection?: ScreenModeSelection;
  /**
   * Issue #4431 (S5/N3): the tenant-resolved data provider, resolved
   * by the calling route (resolveManualScreenProviders) and carried
   * onto the spec verbatim. No per-route hardcode lives here: a
   * market-data spec no longer means "yahoo" by construction, and an
   * E*TRADE spec no longer means an unset agent default.
   */
  provider?: StockScreenProvider;
  /**
   * Issue #3922: the hosting instance's per-login settings
   * reader, forwarded to the internal mode admission when no
   * pre-admitted selection rides — the ND gate then resolves
   * through the stored layer. Absent → env-only admission.
   */
  readSettingRaw?: (key: string) => string | null;
  /** Issue #2908 (G1): provenance the route knows; trigger defaults by source (goal -> "goal", nlq/mesh -> "copilot" (#5053), else "manual"). */
  trigger?: StockScreenTrigger;
  userLogin?: string;
  scheduleId?: string;
  jobId?: string;
  goalId?: string;
  patternRef?: StockScreenPatternRef;
  presetRef?: StockScreenPresetRef;
  patternQualifications?: string[];
}): BuildStockScreenRunSpecResult {
  const modeSelection =
    args.modeSelection ??
    admitScreenModeSelection(args.env, args.method, args.rawFilters, args.query, {
      asyncRequested: args.asyncRequested,
      readSettingRaw: args.readSettingRaw,
    });
  if (!modeSelection.ok) {
    return { ok: false, error: modeSelection.error };
  }
  const parsedScreen = parseStockScreenRequest(args.rawFilters);
  if (!parsedScreen.ok) {
    return { ok: false, error: parsedScreen.error };
  }
  const { filters, universe, minScore, emailTo, pushToSlack, slackChannel, webhookUrl, generatePdf } =
    parsedScreen.value;
  // Issue #2909 (G2): the request body's pattern provenance
  // rides the spec — an explicit builder arg wins, otherwise
  // the parsed request's patternRef/qualifications (sent by
  // the New Screen form for an intact applied pattern).
  const patternRef = args.patternRef ?? parsedScreen.value.patternRef;
  const patternQualifications = args.patternQualifications ?? parsedScreen.value.patternQualifications;
  const delivery: StockScreenDelivery =
    args.source === "etrade"
      ? { emailTo, pushToSlack, slackChannel, webhookUrl, generatePdf }
      : {};
  return {
    ok: true,
    spec: {
      source: args.source,
      ...(args.provider ? { provider: args.provider } : {}),
      deliver: args.source === "etrade",
      filters,
      universe,
      ...(parsedScreen.value.symbols !== undefined ? { symbols: parsedScreen.value.symbols } : {}),
      ...(minScore !== undefined ? { minScore } : {}),
      asyncRequested: args.asyncRequested,
      delivery,
      ...(modeSelection.screenMode
        ? { screenMode: modeSelection.screenMode, screenIntent: modeSelection.screenIntent }
        : {}),
      // Issue #2908 (G1): provenance, set once here — never
      // re-derived downstream. Undefined fields stay absent.
      // Issue #5053: a chat source (nlq / mesh) is a copilot
      // dispatch — the spec trigger is "copilot", mirroring the
      // goal -> "goal" precedent. The `source` field still
      // records nlq/mesh, so no provenance is lost.
      trigger: args.trigger ?? (args.source === "goal" ? "goal" : args.source === "nlq" || args.source === "mesh" ? "copilot" : "manual"),
      ...(args.userLogin !== undefined ? { userLogin: args.userLogin } : {}),
      ...(args.scheduleId !== undefined ? { scheduleId: args.scheduleId } : {}),
      ...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
      ...(args.goalId !== undefined ? { goalId: args.goalId } : {}),
      ...(patternRef !== undefined ? { patternRef } : {}),
      ...(args.presetRef !== undefined ? { presetRef: args.presetRef } : {}),
      ...(patternQualifications !== undefined ? { patternQualifications } : {}),
    },
  };
}
