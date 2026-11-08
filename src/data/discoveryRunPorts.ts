/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — discovery-run
 * port for the options/discovery family: persistence for scheduled
 * strategy-discovery runs (issue #126, PR-E).
 *
 * ADR D-0 ruled this family DO-resident behind a port: written
 * and read by the same OrchestratorAgent host class (colocation,
 * menu property (e); save+prune leans weakly on serialization,
 * (b)). This module carries the record types, the retention
 * constants, the #103 visibility rule, and the port interface
 * ONLY (ADR 0002 R1/R2): no store client, no env binding, no
 * SQL. Adapters: doSqliteDiscoveryRunAdapter.ts (production,
 * the legacy SqlDiscoveryRunStore moved into the layer),
 * inMemoryDiscoveryRunAdapter.ts (test double). The types moved
 * here from src/trading/options/discoveryRunStore.ts, which is
 * now a re-export shim over this port and the DO adapter.
 *
 * The input-model documentation on the types below is the
 * contract's own: "saved-request" runs persist complete
 * StrategyRequests re-run verbatim (issue #126); "profile-derived"
 * runs persist the derivation per symbol — a derived target is
 * labelled DERIVED on every surface (issue #533); "no-view" runs
 * persist constraint sets only, no thesis and no target anywhere
 * (issue #534).
 *
 * TRANSACTION SEAM (ADR D-C): save() is INSERT + retention
 * prune — one unit on the DO adapter when the host supplies
 * the transaction-capable storage object; sequential over a
 * bare sql handle, exactly today's behaviour.
 */

import type { NoViewStrategyRequest, OptionThesis, StrategyRequest } from "../trading";
import type { ProfileRef } from "../trading";
import type { OptionsDataSnapshot } from "../trading";
import type { BestNoViewTradePick, BestTradePick, RankedNoViewStrategy, RankedStrategy } from "../trading";
import type { StrategyRiskReport } from "../trading";
import type { StrategyRecommendationResult } from "../trading";


/** Days a persisted discovery run is retained. 365 matches the settled
 *  discovery-run retention (user decision 2026-10-13: keep a year of
 *  runs for calibration) and the scan store's window. */
export const DISCOVERY_RUN_RETENTION_DAYS = 365;

/** Hard row cap for the discovery-run table (oldest pruned first). */
export const DISCOVERY_RUN_MAX_ROWS = 1000;

/** Cap on saved requests per run: a schedule re-runs each request
 *  against a live chain fetch, so an unbounded list would let one
 *  schedule arm an unbounded amount of broker work per fire. 25 names
 *  matches the curated-universe scale the scanner works at. */
export const MAX_SAVED_REQUESTS_PER_RUN = 25;

/** How a stored run was triggered. Scheduled fires come through the
 *  OrchestratorAgent callback; the trigger route is a manual fire of
 *  the same task and is recorded distinctly ("manual-trigger"). */
export type DiscoveryRunTrigger = "scheduled" | "manual-trigger";

/** Run-level outcome. "partial" means at least one saved request
 *  completed and at least one failed; "failed" means every request
 *  failed — such a run is surfaced as a task failure (issue #112
 *  contract), and the record exists so the failure is diagnosable,
 *  never as a success. */
export type DiscoveryRunStatus = "completed" | "partial" | "failed";

/** How a stored run's inputs were produced. "saved-request": complete
 *  StrategyRequests captured from the panel, re-run verbatim (issue
 *  #126). "profile-derived": a symbol set + Strategy Profile, targets
 *  derived per symbol at fire time (issue #533). "no-view": constraint
 *  sets only — no thesis, no target, ranked by the target-free score
 *  model (issue #534). Recorded on every run so the three can never
 *  be confused. */
export type DiscoveryInputModel = "saved-request" | "profile-derived" | "no-view";

/**
 * The full derivation of one symbol's target in a profile-derived run
 * (issue #533): everything a reader needs to see HOW the target was
 * produced — it is a derived number, not a user view, and it is shown
 * alongside the target on every surface. `targetPrice` here always
 * equals the constructed request's targetPrice.
 */
export interface DiscoveryTargetDerivation {
  source: "profile-derived";
  /** Spot: the underlying price carried by the symbol's own chain fetch. */
  spot: number;
  spotSource: "chain";
  /** Implied volatility of the most-ATM contract in the profile's DTE window. */
  atmIv: number;
  /** Expected move to the window expiry as a fraction of spot: atmIv × sqrt(windowDays/365). */
  expectedMovePct: number;
  /** Expiry of the contract the expected move was taken from — the derivation window's end. */
  windowExpiry: string;
  windowDays: number;
  /** The resolved scanner-config EM multiple for the profile's thesis. */
  emMultiple: number;
  thesis: OptionThesis;
  /** spot × (1 + emMultiple × expectedMovePct), rounded to 2dp. */
  targetPrice: number;
  profileRef: ProfileRef;
}

/**
 * One symbol's input record in a no-view run (issue #534): the
 * constraint set exactly as armed — stored verbatim so a reader can
 * always see what constrained the run and that no view did — plus the
 * mode's IV assumption. The IV direction is a declared constant of
 * the mode (decision 4 on #534: fixed to "unchanged", never
 * user-settable in v1, since a settable IV lean would be a partial
 * view), stamped here rather than left as a hidden default.
 */
export interface DiscoveryConstraintSet {
  source: "no-view";
  /** The constraint set exactly as stored on the schedule: symbol +
   *  constraints only. The type carries no thesis/target fields. */
  request: NoViewStrategyRequest;
  /** The mode's declared IV constant ("unchanged") at fire time. */
  expectedIvDirection: "unchanged";
}

/** The outcome of running (or attempting) one symbol of a discovery run. */
export interface DiscoverySymbolOutcome {
  symbol: string;
  status: "completed" | "failed" | "abstained";
  /** The request that ran for this symbol: the saved request exactly
   *  as stored (saved-request runs), or the constructed request
   *  (profile-derived runs). ABSENT for abstained outcomes — an
   *  abstention produced no request and no target. */
  request?: StrategyRequest;
  /** Profile-derived runs: how this symbol's target was derived.
   *  Present on completed/failed outcomes, and on abstentions that
   *  got far enough to compute a target before abstaining. */
  derivation?: DiscoveryTargetDerivation;
  /** No-view runs: the constraint set that produced this outcome,
   *  stored verbatim (see DiscoveryConstraintSet). Present on every
   *  no-view outcome — the mode's input record, in place of a view. */
  constraintSet?: DiscoveryConstraintSet;
  /** No-view runs only: TRUE on a completed outcome where the chain
   *  loaded but no structure cleared the stated constraints — an
   *  abstention, recorded with its gate reasons in `excluded`, an
   *  empty ranked set and a no_trade best pick. Never set on failed
   *  outcomes; the profile-derived model's abstentions use the
   *  "abstained" status instead (no chain ever ran there). */
  abstained?: boolean;
  /** Present when status is "completed": mirrors the strategies
   *  route's response shape for this symbol. */
  ranked?: RankedStrategy[];
  /** No-view runs: the ranked structures under the constraint set
   *  (score model no-view-v1), the counterpart of `ranked` for a mode
   *  whose candidates carry no target fields. Empty on a no-view
   *  abstention. */
  rankedNoView?: RankedNoViewStrategy[];
  riskReports?: StrategyRiskReport[];
  screenedOut?: Array<{ id: string; reason: string }>;
  excluded?: StrategyRecommendationResult["excluded"];
  bestTrade?: BestTradePick;
  /** No-view runs: the capped best pick (status research_only or
   *  no_trade, never "recommended"), the counterpart of `bestTrade`. */
  bestNoViewTrade?: BestNoViewTradePick;
  /** Snapshot provenance summary (screen block + data source + any
   *  validation error), without the contract list — see module doc. */
  snapshot?: {
    dataSource: OptionsDataSnapshot["dataSource"];
    screen: OptionsDataSnapshot["screen"];
    validationError?: string;
  };
  /** Consolidation #1236 (feed seam): present when this symbol ran
   *  in snapshot-input mode — which stored artifact fed generate,
   *  its asOf, and whether it was stale against the run's
   *  maxAgeSeconds. Absent on live-loaded symbols. */
  snapshotInput?: {
    artifactId: string;
    asOf: string;
    stale: boolean;
  };
  /** Present when status is "failed" or "abstained": the honest
   *  reason (pipeline throw, snapshot validation error, the recorded
   *  upstream cause, or the abstention reason) — never secret
   *  material. */
  error?: string;
}

/** The listing projection of a stored discovery run. */
/** Issue #3388: the brokers a discovery run can be produced from. */
export type DiscoveryRunBroker = "etrade" | "alpaca";

/**
 * Issue #3388: normalize a stored or legacy value. Absent or unrecognised
 * reads as `etrade` because every run written before provenance existed was
 * produced by the E*TRADE-wired engine — never as another broker's evidence.
 */
export function normalizeDiscoveryRunBroker(value: unknown): DiscoveryRunBroker {
  return value === "alpaca" ? "alpaca" : "etrade";
}

export interface DiscoveryRunSummary {
  id: string;
  createdAt: string;
  /**
   * Issue #3388: which broker's chains produced this run. Stamped inside the
   * summary (no column migration, the #3327 shape); rows written before this
   * existed were E*TRADE's — the only broker wired then — so they read as
   * `etrade` and are never served as another broker's evidence.
   */
  broker: DiscoveryRunBroker;
  /**
   * Issue #3655: live/paper mode the run executed under, from
   * (broker, environment). Absent on runs recorded before mode
   * provenance existed — never backfilled from the current selection.
   */
  mode?: "live" | "paper";
  /** Issue #3655 (effective mode): which resolver leg produced the mode — pin | selection | inference. */
  modeSource?: "pin" | "selection" | "inference";
  /** The login that owns the run (issue #103 scoping). Optional
   *  deliberately: an absent login is what makes a run "legacy" under
   *  the visibility rule. Scheduled runs are always saved WITH the
   *  schedule owner's login — identity is never invented here. */
  userLogin?: string;
  trigger: DiscoveryRunTrigger;
  /** The arming schedule's id when the caller supplied one. */
  scheduleId?: string;
  /** How the run's inputs were produced (see DiscoveryInputModel). */
  inputModel: DiscoveryInputModel;
  /** Profile-derived runs: the profile the targets were derived
   *  under, stamped with its version at fire time. */
  profileRef?: ProfileRef;
  status: DiscoveryRunStatus;
  /** Inputs that ran: saved requests (saved-request runs), constructed
   *  requests (profile-derived runs — abstained symbols contribute
   *  none), or constraint sets (no-view runs). */
  requestCount: number;
  /** Completed outcomes that produced a ranked result — no-view
   *  abstentions are completed outcomes but count separately below,
   *  never here. */
  completedCount: number;
  /** Failed outcomes only — abstentions are counted separately. */
  failedCount: number;
  abstainedCount: number;
  /** Every symbol the run attempted (constructed + abstained), in order. */
  symbols: string[];
}

/** A persisted discovery run: summary plus requests and outcomes. */
export interface StoredDiscoveryRun extends DiscoveryRunSummary {
  requests: StrategyRequest[];
  /** No-view runs: the run's constraint sets, verbatim (issue #534).
   *  Absent for the other input models. */
  constraintSets?: DiscoveryConstraintSet[];
  outcomes: DiscoverySymbolOutcome[];
}

/** What a caller hands the store to persist one execution. The store
 *  assigns the id and derives the summary counts from the outcomes. */
export interface DiscoveryRunInput {
  createdAt: string;
  trigger: DiscoveryRunTrigger;
  scheduleId?: string;
  userLogin?: string;
  /** Required — stamped verbatim onto the run. No default: a caller
   *  must name its model so a future model can never be silently
   *  stamped as an existing one. */
  inputModel: DiscoveryInputModel;
  /** Profile-derived runs: the resolved profile reference. */
  profileRef?: ProfileRef;
  requests: StrategyRequest[];
  /** No-view runs: the constraint sets that ran, verbatim (issue
   *  #534). `requests` is empty for this model — no StrategyRequest
   *  exists anywhere in it. */
  constraintSets?: DiscoveryConstraintSet[];
  outcomes: DiscoverySymbolOutcome[];
  status: DiscoveryRunStatus;
  /**
   * Issue #3388: the broker whose chains produced this run. Optional at the
   * input so callers that predate provenance still compile; absent is stamped
   * as `etrade`, which is what the E*TRADE-wired engine actually used.
   */
  broker?: DiscoveryRunBroker;
  /** Issue #3655: live/paper mode the run executed under. */
  mode?: "live" | "paper";
  /** Issue #3655 (effective mode): which resolver leg produced the mode — pin | selection | inference. */
  modeSource?: "pin" | "selection" | "inference";
}

export interface DiscoveryRunStore {
  /** Persist one execution and return the stored run. Saving also
   *  prunes (retention window + row cap, oldest first). */
  save(input: DiscoveryRunInput): Promise<StoredDiscoveryRun>;
  /** Newest-first summaries (createdAt descending, id descending on
   *  ties), paginated, filtered by the issue #103 visibility rule. */
  list(options?: { limit?: number; offset?: number; userLogin?: string; broker?: DiscoveryRunBroker }): Promise<DiscoveryRunSummary[]>;
  /** The full stored run, or null when unknown/pruned/not visible to
   *  the scope — invisibility reads exactly like absence. A run produced
   *  by another broker reads the same way (issue #3388). */
  get(id: string, options?: { userLogin?: string; broker?: DiscoveryRunBroker }): Promise<StoredDiscoveryRun | null>;
  /** Delete rows older than the retention window and rows beyond the
   *  row cap; returns how many rows were deleted. */
  prune(now: Date): Promise<number>;
}

/**
 * The per-user visibility rule (issue #103), identical to the scan
 * store's: a run saved WITH a userLogin is visible only to that
 * login; a run saved WITHOUT one is visible to every caller. An
 * unscoped caller sees only unscoped runs.
 */
export function discoveryRunVisibleToCaller(
  summary: Pick<DiscoveryRunSummary, "userLogin">,
  userLogin?: string,
): boolean {
  return summary.userLogin === undefined || summary.userLogin === null || summary.userLogin === userLogin;
}

/**
 * Minimal SQL executor matching the Durable Object SqlStorage `exec`
 * signature (the same structural shape scanRunStore.ts declares).
 */
export interface DiscoverySqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export interface DiscoveryRunStoreOptions {
  /** Id factory for new runs. Default: crypto.randomUUID(). */
  idFactory?: () => string;
  /** Retention window override (days). Default DISCOVERY_RUN_RETENTION_DAYS. */
  retentionDays?: number;
  /** Row-cap override. Default DISCOVERY_RUN_MAX_ROWS. */
  maxRows?: number;
}
