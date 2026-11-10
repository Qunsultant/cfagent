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
 *     unset (the ScreenerAgent default), delivery = the parsed
 *     envelope (the sync path publishes it via publishOrBridge).
 *   - Market-data route: source "market-data", deliver false,
 *     provider "yahoo", delivery = {} — the parsed envelope is
 *     deliberately NOT forwarded, exactly as today: the
 *     market-data route has no deliver step.
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
import {
  admitScreenModeSelection,
  type ScreenModeSelection,
} from "./screenerWorkflowRoutes";
import type { StockScreenerFilter } from "../types";

/** The per-request delivery envelope, defined once here. */
export interface StockScreenDelivery {
  emailTo?: string;
  pushToSlack?: boolean;
  slackChannel?: string;
  webhookUrl?: string;
  generatePdf?: boolean;
}

export type StockScreenSource = "etrade" | "market-data" | "goal" | "nlq" | "mesh" | "research";

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
  | "manual"
  | "scheduled"
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
  /** Undefined for E*TRADE (agent default) and goal (goal-owned); "yahoo" for market-data. */
  provider?: "yahoo";
  /** The pinned delivery divergence: E*TRADE true, market-data and goal false. */
  deliver: boolean;
  filters: StockScreenerFilter;
  universe: string;
  minScore?: number;
  asyncRequested: boolean;
  delivery: StockScreenDelivery;
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
   * it (goal source -> "goal", otherwise "manual" unless the
   * caller passes one); hand-built specs must set it too —
   * downstream code never re-derives it, and the UI renders
   * a missing trigger as "unknown", never as "scheduled".
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

/** Issue #2908 (G1): the workflow command trigger for a spec — "scheduled" only for scheduled specs, "manual" otherwise (workflowPorts admits nothing else). The spec's own trigger rides the command as specTrigger. */
export function workflowTriggerForSpec(spec: StockScreenRunSpec): "manual" | "scheduled" {
  return spec.trigger === "scheduled" ? "scheduled" : "manual";
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
   * Issue #3922: the hosting instance's per-login settings
   * reader, forwarded to the internal mode admission when no
   * pre-admitted selection rides — the ND gate then resolves
   * through the stored layer. Absent → env-only admission.
   */
  readSettingRaw?: (key: string) => string | null;
  /** Issue #2908 (G1): provenance the route knows; trigger defaults by source (goal -> "goal", else "manual"). */
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
      ...(args.source === "market-data" ? { provider: "yahoo" as const } : {}),
      deliver: args.source === "etrade",
      filters,
      universe,
      ...(minScore !== undefined ? { minScore } : {}),
      asyncRequested: args.asyncRequested,
      delivery,
      ...(modeSelection.screenMode
        ? { screenMode: modeSelection.screenMode, screenIntent: modeSelection.screenIntent }
        : {}),
      // Issue #2908 (G1): provenance, set once here — never
      // re-derived downstream. Undefined fields stay absent.
      trigger: args.trigger ?? (args.source === "goal" ? "goal" : "manual"),
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
