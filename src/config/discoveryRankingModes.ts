/**
 * #1730 (parent #1717, slice (j)): discovery / ranking / weights /
 * promotion remainders (scan appendix (j) findings D1, D2, D3, D4,
 * DF, W1, W2, P1, P2, S3) — the PAYMENTS_FLOW_MODE (#1711) /
 * MARKET_DATA_* (#1727) / GOAL_COMPILE_MODE (#1729) pattern applied to
 * this domain, with one deliberate difference: this slice adds NO
 * runtime switch. Pure module: no Cloudflare imports, no I/O, no
 * network — the registry is data, and the tests in
 * tests/discovery_ranking_weights_promotion_modes_1730.test.ts
 * pin the behavior distinctions it records (port-first, cfagent
 * blueprint #1795/#1798 restated wording: cloud-native but
 * cloud-agnostic).
 *
 * WHY NO SWITCH (read before adding one): every divergent pair
 * in appendix (j) is divergent-by-design, and a switch over any
 * of them would be either a safety/governance regression, a
 * retired-flag resurrection, or a phantom switch with no single
 * call site that could honor both values. The #1729 precedent
 * governs: where a pair is divergent-by-design for safety, pin
 * it with justification rather than forcing a phantom switch.
 * Each pin below names the flip that must NOT happen and why.
 * A future slice that finds a genuine single call site with
 * both paths present must add its switch here (and grow
 * DISCOVERY_RANKING_1730_SWITCHES) with its own Red evidence —
 * it must not silently flip a pin.
 *
 * Consequences of having no switch in this slice:
 * - There is NO env var to declare (src/types.ts untouched),
 *   NO production value for the owner to set, and NO
 *   config_error event: there is no switch value that could
 *   fail closed. The scoped resolution order (run > session >
 *   user > global env > built-in) has nothing to resolve here;
 *   each pin's `defaultBehavior` IS the current public-route
 *   behavior, recorded explicitly so the owner can overturn
 *   any pin later by a deliberate decision, not by a flag.
 * - No endpoint is removed, no code path is deleted, no store
 *   is merged, no new store/engine is introduced. NEVER
 *   EITHER/OR is honored by keeping both paths in every pair.
 * - The security guard holds trivially and absolutely: no
 *   caller can configure away any enforcement through this
 *   module, because this module configures nothing. IAAA gate
 *   switches, if any are ever touched here, stay
 *   admin/platform-controlled, default fail-closed, never
 *   user/session-configurable by the gated subject.
 *
 * Switch-vs-pin table (D = discovery, W = weights, P =
 * promotion; "pinned" = divergent-by-design, both paths kept;
 * "identical" = already a single path, collapsed, no switch):
 * | pair | resolution | the flip that must NOT happen            |
 * | D1   | pinned     | selecting one discovery runner for all   |
 * |      |            | actions (different request shapes,      |
 * |      |            | stores, ranking hooks — a selector       |
 * |      |            | would need adapters, i.e. a new engine)  |
 * | D2   | identical  | re-reporting researchDiscovery as a      |
 * |      |            | second engine (it is the kernel's layer) |
 * | D3   | pinned     | one weight math for all layers (kernel   |
 * |      |            | tier-reorder vs fit multipliers vs       |
 * |      |            | pick-only points serve different outputs)|
 * | D4   | pinned     | LLM reorder in production (the #1640     |
 * |      |            | contract forbids it; the reorder lives   |
 * |      |            | ONLY in comparison arms)                 |
 * | DF   | identical  | a second fit gate (the adapter overlays  |
 * |      |            | a floor; it does not re-implement)       |
 * | W1   | pinned     | routes back to v1 (the #1257 flip retired|
 * |      |            | the routes flag; retirement is #1257's   |
 * |      |            | retirement PR, not this slice)           |
 * | W2   | pinned     | one global read mode (evaluation needs  |
 * |      |            | regime-blind shape, ranking needs        |
 * |      |            | regime-qualified keys)                   |
 * | P1   | pinned     | promote via staged (retired governance)  |
 * |      |            | or advance via challenger (strands       |
 * |      |            | in-flight drain records in another store)|
 * | P2   | pinned     | promotion evaluation via dormant (b)/(c) |
 * |      |            | (no route plumbing; governance differs)  |
 * |      |            | or merging the bundle namesake (d) in    |
 * | S3   | identical  | a second panel engine (the panel path    |
 * |      |            | delegates to the kernel)                 |
 *
 * Scan-vs-code corrections (current main governs; the scan head
 * was 23de3ce, this slice verified against main a9d16a3):
 * - discoveryExpression lives at
 *   src/trading/options/discoveryExpression.ts, not
 *   src/services/discoveryExpression.ts.
 * - UnifiedOptionsService is at
 *   src/trading/options/unifiedOptionsService.ts; its discovery
 *   action is the Phase 1 pipeline, not a discoveryService
 *   runner caller on current main. The live
 *   createDiscoveryService callers are asyncJobs.ts,
 *   mcpChatNlq.ts, and tradingIntegrations.ts (each wiring
 *   BOTH runners side-by-side).
 * - runDiscoveryMode's direct entry is now FULLY uncalled: the
 *   only reference to it anywhere in src is its own
 *   definition (researchDiscovery.ts). The scan's "only
 *   fitDiscoveryRunner references" is stale — the fit runner
 *   goes through the kernel entries, not runDiscoveryMode.
 * - v1 strategyWeights imports on current main are narrower
 *   than the scan lists: screenerResearch.ts (evaluation
 *   builder + isoWeekKey), strategyWeightsV2.ts (bounds),
 *   improvementCandidates.ts + stagedPromotion.ts (bounds
 *   and/or the v1 read for drain baselines). No live route
 *   or scheduled caller of the v1 adjustment job.
 * - The stagedPromotion retirement condition (delete when GET
 *   promotions/active is empty) is now MET: the #1257 retirement
 *   PR deleted stagedPromotion and its drain endpoints once the
 *   active list drained to empty, and the W1/P1/P2 pins below
 *   record the retired outcome. The route comment is gone with
 *   the endpoints.
 */

export type DiscoveryRankingPinId =
  | "D1"
  | "D2"
  | "D3"
  | "D4"
  | "DF"
  | "W1"
  | "W2"
  | "P1"
  | "P2"
  | "S3";

export type DiscoveryRankingResolution = "pinned" | "identical";

export interface DiscoveryRankingPin {
  id: DiscoveryRankingPinId;
  finding: string;
  resolution: DiscoveryRankingResolution;
  /** Why this pair is pinned (or why it is already identical). */
  reason: string;
  /** The current public-route behavior, kept by this slice. */
  defaultBehavior: string;
}

/**
 * The runtime switches this slice adds: none, deliberately.
 * A future switch over any pair below must be appended here
 * with its own Red evidence and PR-body justification.
 */
export const DISCOVERY_RANKING_1730_SWITCHES: readonly string[] = [];

export const DISCOVERY_RANKING_1730_PINS: readonly DiscoveryRankingPin[] = [
  {
    id: "D1",
    finding:
      "discoveryService (scope/delta-oriented: runs, abstention stages, near-miss signals, alert dispatch, profileBias pick-only points) vs kernel fit path (fit-oriented: bidirectional name↔strategy, falsification evidence, re-gate from the same provider session, mapping that THROWS on source-less candidates).",
    resolution: "pinned",
    reason:
      "Different request shapes (DiscoveryRunRequest{symbols, scopeKey, source, caps, profileBias} vs DiscoveryModeRequest{direction, ...}), different stores (discovery setup runs vs screening activity log), different ranking hooks (profile-bias points vs v2 multipliers). The two runners are composed side-by-side (asyncJobs.ts, mcpChatNlq.ts, tradingIntegrations.ts), each serving different actions; a selector would need adapters between incompatible shapes — new-engine work the scan does not prove required, and kernel absorption is #1257's direction, not this slice's to pre-empt.",
    defaultBehavior:
      "Both runners stay wired side-by-side; discovery actions run discoveryService, fit actions run the kernel fit path. The kernel did NOT absorb discoveryService.",
  },
  {
    id: "D2",
    finding:
      "researchDiscovery as kernel source: discoverStrategiesForName / discoverNamesForStrategy called by the kernel's builders and by the fit runner as the pre-kernel step; runDiscoveryMode has no direct production caller.",
    resolution: "identical",
    reason:
      "This is a layer (discovery → kernel gate/rank → mapping), not a second discovery engine. The direct runDiscoveryMode entry is fully uncalled on current main (only its own definition references it in src) — a cleanup note, not a live race.",
    defaultBehavior:
      "Kernel builders and the fit runner keep consuming researchDiscovery; runDiscoveryMode stays uncalled and is NOT re-reported as a duplicate.",
  },
  {
    id: "D3",
    finding:
      "Three weight-application semantics over the same v2 store: kernel PassthroughWeightsRankDecorator (within-tier reorder only, no-op without a weights function, no scaling, no sign guard) vs fit-runner applyWeightsV2Ranking (bounded multipliers, non-negative-cells-only, tier-first, per-weight notes, flag-gated default OFF) vs discovery profileBias (pick-only points, recorded scores unaffected). Plus portfolioContextRanking, a fourth reorder that is a portfolio-context modifier, not a weight system.",
    resolution: "pinned",
    reason:
      "The three apply at different layers to different outputs: a kernel decorator over an already-ranked list, a fit-result re-ranking behind the #17 reviewed-config flag (screening.weightsV2Ranking, default OFF — learned weighting does not touch production ranking until a human enables it), and a pick-selection boost that must never rewrite recorded scores. One mode value cannot express 'reorder within tier' vs 'rescale scores' vs 'change only the pick' without changing reviewed-config behavior in at least one layer. portfolioContextRanking is named, not counted: it takes no weights input and demotes already-held symbols by a stable partition.",
    defaultBehavior:
      "Each layer keeps its own semantics; the fit-runner flag stays OFF unless a human enables it; profileBias stays pick-only; portfolioContextRanking stays a context modifier with its applied marker.",
  },
  {
    id: "D4",
    finding:
      "LLM overlay: rankingCore.annotateQuantRanking (#1640, order-preserving enforced contract) vs kernel LlmRankPolicy / LlmScorePolicy (reordering — documented exception: llm/hybrid arm ONLY, never alters a production ranking); llmComparison + strategyReviews are judgment INPUTS, not rankers.",
    resolution: "pinned",
    reason:
      "The exception IS the divergence, by design. A switch value that let a production ranking reorder by LLM order would violate the #1640 contract ('LLM overlay annotates, never overwrites quant ranking') that the E*TRADE options evaluate route relies on for its rankings field. The reorder lives only where it is explicitly constructed: inside a comparison arm's own list.",
    defaultBehavior:
      "Production ranking is annotate-only (same order, length, entry references; unknown-id judgments dropped; no-judgment candidates annotate null). LlmRankPolicy / LlmScorePolicy keep their comparison-only scope; llmComparison + strategyReviews keep feeding judgments, never ranking.",
  },
  {
    id: "DF",
    finding:
      "Fit gates: opportunityScanner.evaluateFitGate is the single gate logic; scannerFitGateHandler.OpportunityScannerFitHandler is a chain adapter over it; discoveryExpression.resolveDiscoveryFitGate only overlays the discovery composite floor; researchGates are different stage gates (data/contract/quote/strategy/risk/publication).",
    resolution: "identical",
    reason:
      "The adapter caps only demote (fit → no cap, borderline → watchlist cap, no_fit → rejected cap; the kernel takes the most restrictive tier) and the overlay changes one floor value; neither re-implements the gate. researchGates gate pipeline stages, not fit — checked, not a duplicate.",
    defaultBehavior:
      "One gate function, one adapter, one floor overlay; stage gates stay separate.",
  },
  {
    id: "W1",
    finding:
      "Strategy weights v1 vs v2: v1 regime-blind raw win-rate (deleted by the #1257 retirement PR — no live route or scheduled caller of the v1 adjustment job remained) vs v2 regime-conditioned after-cost decayed versioned (live: GET returns v2, POST run runs v2 only).",
    resolution: "pinned",
    reason:
      "Retirement is gated under #1257's retirement PR, not decided here — and #1257 already retired the routes flag (v2-always), so a v1/v2 route switch in this slice would resurrect a retired flag. The retirement PR unwound the live couplings in drain order: the bounds, week key, actor, and GET evaluation builder moved into strategyWeightsV2, and stagedPromotion's v1 drain reads went with the drain endpoints once the active list was empty.",
    defaultBehavior:
      "Routes stay v2-always (GET weightsSource:'v2', POST run runs v2 only); the v1 module was deleted by the #1257 retirement PR (bounds, week key, actor, and evaluation builder moved into strategyWeightsV2); v1 rows present in the store are ignored by the routes.",
  },
  {
    id: "W2",
    finding:
      "v2 reads from one store (mas_strategy_weights_v2): full map (strategy|regime keys) vs per-regime (plain strategy keys, no cross-regime leak) vs collapsed MEAN (regime-blind aggregate for legacy consumers). {bull 2.0, bear 0.25} reads as 1.125 collapsed / 2.0 bull / 0.25 bear.",
    resolution: "pinned",
    reason:
      "Documented behavior (C5, #1361/#1257), not an accident — but a contract divergence between readers that a global switch would mis-serve: the GET evaluation and candidate replay need the regime-blind shape, the reselection tick and challenger paths need regime-qualified values, and the fit runner keys the FULL map by strategy|regime so it does not leak across regimes. One read mode cannot serve all three without changing at least one caller's contract.",
    defaultBehavior:
      "Each caller keeps its documented read: full map for regime-keyed lookups, per-regime for single-regime runs, collapsed mean for legacy-shaped consumers. The collapsed mean is never presented as any single regime's evidence.",
  },
  {
    id: "P1",
    finding:
      "Promotion: champion/challenger live (promote/rollback via championChallenger, promoter = approver of record); staged retired (advancePromotion and GET /adaptation/promotions/active deleted with stagedPromotion once the in-flight list drained to empty; one record store + one GET shape remains). proposalChallengerBridge is a migration seam, not a third engine.",
    resolution: "pinned",
    reason:
      "Flipping promote to staged would resurrect retired governance (staged lacks the challenger gate's promoter-is-approver rule and frozen-set evaluation); flipping advance to challenger would have stranded in-flight drain records, which lived in the staged store with staged shapes and baselines. The module header's retirement condition governed the endgame: stagedPromotion was deleted when GET promotions/active drained to empty — a drain observation, not a flag flip.",
    defaultBehavior:
      "POST /adaptation/promotions/start, advance, and GET /adaptation/promotions/active are deleted with stagedPromotion; promote/rollback keep running championChallenger; GET /adaptation/promotions lists challenger records (tenant-scoped).",
  },
  {
    id: "P2",
    finding:
      "Candidate evaluation: (a) challenger walk-forward over a FROZEN dataset (live); (b) candidateEvaluation window replay and (c) promotionGate z-test + INFORMED human approval were deleted by the #1257 retirement PR; (d) recommendationBundle internal evaluateCandidate scenario-grid evaluation — a NAMESAKE in a different domain.",
    resolution: "pinned",
    reason:
      "(b) had no live route caller outside the drain chain and (c) had only a read reference (chainGovernance); both were deleted by the #1257 retirement PR, not wired behind a switch. (d) must NOT be merged into (a): it is a bundle-construction optimizer input (expected P&L, CVaR-25, worst P&L, P(profit)), and it is module-private, so it cannot be imported as a promotion evaluator by accident.",
    defaultBehavior:
      "Challenger frozen-set evaluation is the only promotion evaluation (split selection/holdout at ceil(half); edge = holdout challenger − champion score; pass iff edge + minEvaluated met; frozen-set quotes labelled synthetic, never a live fetch). (b)/(c) were deleted by the #1257 retirement PR; (d) stays a private bundle helper in its own domain.",
  },
  {
    id: "S3",
    finding:
      "Panel agents vs kernel: runOptionsPanelViaEngine (the engine-routed panel; runPanelPipelineRetired4068 is its frozen decomposition) / runPanelWithAgents delegate to RecommendationService.discoverPanel (kernel), then compute ranked/riskReports/bestTrade via the same three agents over the kernel-passed candidates. Defaults shared: balanced profile, 3 alternatives.",
    resolution: "identical",
    reason:
      "Delegation, not duplication: the panel body is the kernel path plus agent computation over kernel-passed candidates. The agents remain directly constructible because the no-view scheduled path constructs them once and passes them to both runPanelWithAgents and agent methods — a live seam, not dead code.",
    defaultBehavior:
      "Panel runs keep delegating to the kernel; agent classes stay constructible for the scheduled path.",
  },
];

export function discoveryRankingPin(id: DiscoveryRankingPinId): DiscoveryRankingPin | undefined {
  return DISCOVERY_RANKING_1730_PINS.find((pin) => pin.id === id);
}
