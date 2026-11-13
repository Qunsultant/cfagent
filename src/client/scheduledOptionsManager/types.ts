import type { TradeOrderContext } from "../trading/tradeOrderContext";

export interface ScheduledTaskItem {
  id: string;
  type: "interval" | "cron" | "delayed" | "scheduled";
  callback: string;
  payload?: any;
  intervalSeconds?: number;
  cron?: string;
  date?: string;
  delayInSeconds?: number;
  /** Agents SDK Schedule.time: unix seconds of the next execution. */
  time?: number;
  createdAt?: string;
  nextRun?: string;
  /** Issue #273: paused jobs are merged into the list by the backend;
   *  the definition is kept in the paused store (S7: the screening
   *  section renders the badge + Resume like the generic cards do). */
  paused?: boolean;
  pausedAt?: string;
}

export interface ScheduledOptionsManagerProps {
  activeEnv?: string;
  /** Issue #1185: required — the authenticated user's login. There is
   *  no default identity to scope schedules/profiles to. */
  userLogin: string;
  /** Issue #3361: the preview hands the converted TradeOrderContext up, not the raw candidate. */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  /** S7 (one schedule UI): the hosting SchedulesPanel's tab filter —
   *  "stocks" shows only market screens, "options" shows options
   *  analysis + discovery. Absent/"all" shows every screening kind. */
  groupFilter?: "all" | "stocks" | "options";
  /** S7: bumped by the host's ONE Refresh control to ask the section
   *  to refetch everything it reads (list, latest runs, audit). The
   *  create form is opened by the section's own hero button — the
   *  page has exactly one create action (issue #2329). */
  refreshSignal?: number;
  /**
   * Issue #4331 (#4329 S2): false (the default) when the schedules home hosts
   * the one schedule list — the manager then renders its form, latest runs and
   * audit trail only.
   */
  showSchedulesSection?: boolean;
}

/**
 * The create/edit form's complete state, as consumed by the single
 * payload-construction path (scheduledOptionsManager/payloadBuilders).
 * Field-for-field the state the section component holds in useState
 * hooks — the builder takes it whole so a submitted body can be
 * reproduced (and golden-pinned) without rendering the form.
 */
export interface ScheduleFormState {
  jobType: CreatableJob;
  targetSymbols: string;
  maxItems: number;
  targetUniverse: string;
  sector: string;
  minPrice: string;
  maxPrice: string;
  minMarketCap: string;
  maxPe: string;
  trendFilter: string;
  /**
   * Issue #1499 (#940-E): id of a stored stocks preset for market-screen
   * schedules. Optional so existing form literals keep compiling; empty
   * means no preset (the custom thresholds below apply instead).
   */
  presetId?: string;
  scheduleType: ScheduleMode;
  intervalSeconds: number;
  cronExpression: string;
  delaySeconds: number;
  scheduledDate: string;
  thesis: "bullish" | "bearish" | "neutral" | "directional";
  riskProfile: "conservative" | "balanced" | "aggressive";
  /**
   * Issue #2600: options-analysis strategy-choice controls, when the
   * form sets them. Absent = server defaults (strategyMode from the
   * stored #2583 scope at fire time; farDated absent = legacy bands;
   * candidateLimit absent = the scanner's headline default).
   */
  optionsStrategyMode?: "thesis" | "all";
  optionsFarDated?: boolean;
  optionsCandidateLimit?: number | "all";
  pushToSlack: boolean;
  slackChannel: string;
  emailTo: string;
  webhookUrl: string;
  discoveryRequests: DiscoveryRequestDraft[];
  discoveryInputModel: DiscoveryInputModel;
  derivedSource: "symbols" | "watchlist";
  derivedSymbolsText: string;
  derivedWatchlistName: string;
  derivedProfileId: string;
  noViewDraft: NoViewConstraintsDraft;
  /** Broker environment stamped into options/discovery payloads. */
  environment: string;
}

/** One autonomous options-analysis run as returned by GET /api/options/latest (#223). */
export interface OptionsRunSummary {
  timestamp: string;
  success: boolean;
  trigger?: string;
  thesis?: string;
  symbols?: string[];
  withTrades?: number;
  summary?: string;
  error?: string;
}

/** Shared schedule-card metadata for user-owned stock and options jobs. */
export interface SystemJobInfo {
  label: string;
  description: string;
  triggerRoute: string;
}

/** Jobs the create form can register. Anything else stays API-only. */
export type CreatableJob = "optionsAnalysis" | "marketScreen" | "strategyDiscovery";

/**
 * One saved discovery view as edited in the create form (issue #126).
 * A discovery schedule re-runs complete StrategyRequests verbatim, so
 * the form edits the request itself; numeric fields stay strings while
 * editing and are converted by buildDiscoveryRequests on submit.
 */
export interface DiscoveryRequestDraft {
  symbol: string;
  thesis: "bullish" | "bearish" | "range_bound" | "large_move";
  targetPrice: string;
  targetDate: string;
  expectedIvDirection: "rise" | "unchanged" | "fall";
  maxPlannedLoss: string;
  minRewardRisk: string;
  /** "" omits the field (the server then applies its balanced default weights). */
  optimizationBias: string;
  dataMode: "live" | "calibrated-demo";
  /** Comma-separated registry ids; "all" is the discovery panel's own default. */
  allowedStrategies: string;
  /** "" omits the field. */
  maxDte: string;
}

export type ScheduleMode = "interval" | "cron" | "delayed" | "scheduled";

/** The three input models a discovery schedule can carry (issues
 *  #126/#533/#534): complete saved views re-run verbatim; a symbol
 *  set + Strategy Profile whose targets are derived at run time; or
 *  no-view constraint sets — symbols + constraints only, no thesis
 *  and no target anywhere. */
export type DiscoveryInputModel = "saved-request" | "profile-derived" | "no-view";

/** The no-view discovery editor's state (issue #534): one symbol
 *  list plus the constraints every symbol shares. Numeric fields
 *  stay strings while editing and are converted by
 *  buildNoViewPayload on submit. The mode has NO thesis or target
 *  fields — none exist here, none are ever sent. */
export interface NoViewConstraintsDraft {
  symbolsText: string;
  maxPlannedLoss: string;
  minRewardRisk: string;
  /** "" applies the mode's default floor (0.35) on submit. */
  minProbabilityOfProfit: string;
  /** "" omits the bound. */
  minDte: string;
  /** "" omits the bound. */
  maxDte: string;
  riskProfile: "conservative" | "balanced" | "aggressive";
}
