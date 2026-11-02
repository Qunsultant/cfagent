/**
 * #1771 (parent #1717) slice A: per-orchestration status registry.
 *
 * Enable-or-decide, per orchestration, for the seven orchestrations
 * named in #1771 (scan rows F-45, F-46, F-51 partial, F-54 partial),
 * plus the two loops the issue's guard names explicitly: the
 * gated screener-to-trade loop and goal-chaining. Pure module:
 * no I/O, no network, no imports — the registry is data that
 * tests, docs, and later slices read, never a runtime switch.
 *
 * Status vocabulary (exactly one per entry):
 * - "enabled": the harness/loop exists on main and runs today.
 * - "enabled-gated": it runs today ONLY behind its existing
 *   human-approval gate; the gate is part of the enablement,
 *   not a blocker to it.
 * - "deliberately-unenabled": NOT built, with a named blocker.
 *   A blocker is a fact (a missing source, a missing owner
 *   decision), never a vague "later". Slices B/C/D of #1771
 *   flip exactly the entries they build, in their own PRs
 *   (slice B flipped swarm-consensus to enabled).
 * - "decided": the issue's deliverable for this row IS a
 *   decision (not an automation), recorded here with its
 *   terms; the builder slice (D for social digest) ships the
 *   decision's mechanism without changing the decision.
 *
 * HARD GUARD (every entry, enforced by tests):
 * tradeApprovalBypass is false for ALL entries, including the
 * enabled ones. No orchestration enabled or decided in #1771
 * bypasses the manual trade-approval gate, nor any other
 * control. A proposal-only engine (slice C rebalance) produces
 * DRAFT data for the existing approval workflow; it places,
 * previews, and submits nothing.
 *
 * Reflection (F-45/F-54, decided in this slice, not a row
 * above): REFLECTION_DECISION_1771 below. Reflection logs do
 * NOT mutate code or prompts. They stay developer-mediated:
 * src/services/reflection.ts routes findings to pending
 * strategy-review candidates under the REFLECTION pseudo-symbol
 * with quant_status "unverified", and the human gate disposes.
 * Rationale: self-mutation would bypass the change-control
 * path every other change must take — branch + PR + green
 * gate (Policy Gate included) + rebase-merge — with no
 * owner-approved guardrail design on record for an agent to
 * rewrite its own prompts or code and still be attributable.
 * Building such a mutation path without that design would be
 * the control bypass this issue forbids, not an enablement.
 */

export type OrchestrationId =
  | "portfolio-rebalancing"
  | "x402-p2p"
  | "spread-repair"
  | "cross-venue-arbitrage"
  | "swarm-consensus"
  | "volatility-darkpool-monitor"
  | "social-feed-digest"
  | "goal-chaining"
  | "screener-to-trade-loop";

export type OrchestrationStatusKind =
  | "enabled"
  | "enabled-gated"
  | "deliberately-unenabled"
  | "decided";

export interface OrchestrationStatus {
  id: OrchestrationId;
  label: string;
  status: OrchestrationStatusKind;
  /** Null unless deliberately-unenabled; then it MUST name the blocker. */
  blocker: string | null;
  /** File paths on main evidencing the status (no invented surfaces). */
  evidence: string[];
  /** Invariant: always false. See the hard guard above. */
  tradeApprovalBypass: false;
  /** Scope nuance for an enabled/decided entry (never a hidden blocker). */
  note?: string;
  /** Slice of #1771 that owns this entry's next flip, if any. */
  nextSlice: string | null;
}

export const ORCHESTRATION_STATUS: OrchestrationStatus[] = [
  {
    id: "portfolio-rebalancing",
    label: "Autonomous portfolio rebalancing",
    status: "enabled",
    blocker: null,
    evidence: [
      "src/orchestrations/rebalanceProposals.ts",
      "tests/rebalance_proposals_1771.test.ts",
    ],
    tradeApprovalBypass: false,
    note: "Enabled ONLY as DRAFT-only drift proposals (slice C): computeRebalanceProposals sizes buy/sell quantities against target weights but places, previews, and submits nothing — execution still requires the trade-approval workflow. Autonomous execution (no human gate) is NOT enabled and is not claimed.",
    nextSlice: null,
  },
  {
    id: "x402-p2p",
    label: "Cross-agent P2P x402 micro-payments",
    status: "enabled-gated",
    blocker: null,
    evidence: [
      "src/services/agenticPayments.ts",
      "src/services/x402PaymentPath.ts",
      "src/services/x402Verifier.ts",
      "src/services/x402Networks.ts",
    ],
    tradeApprovalBypass: false,
    note: "Enabled in its testnet/simulated form only: on-chain USDC transfer verified against the chain on base-sepolia (testnet funds, no real money), simulated local-ledger proofs rejected outright by verifyPayment. Mainnet real-money P2P is NOT activated by #1771 — that is an owner decision, not a slice default.",
    nextSlice: null,
  },
  {
    id: "spread-repair",
    label: "Multi-leg spread repair engine",
    status: "deliberately-unenabled",
    blocker:
      "No multi-leg fill-state source exists on main, so a repair engine cannot know which leg broke; the existing repairProposals.ts covers single-stock underwater repair only (DRAFT proposals, #355) and is not a spread engine. Building replacement-leg selection without fill state and a live chain would fabricate legs.",
    evidence: ["src/services/repairProposals.ts"],
    tradeApprovalBypass: false,
    nextSlice: null,
  },
  {
    id: "cross-venue-arbitrage",
    label: "Cross-venue E*TRADE-vs-Alpaca arbitrage",
    status: "deliberately-unenabled",
    blocker:
      "E*TRADE Connect authorization is an owner action under #1066 (never agent-authorized, and ETRADE_OAUTH_TOKEN* values are never agent-touched); no live dual-venue pricing/fees/balance source exists on main. The catalog's arbitrage entries (box spread, jelly roll, conversion) are single-venue strategy templates, not cross-venue execution.",
    evidence: ["src/trading/options/strategies/catalog.ts"],
    tradeApprovalBypass: false,
    nextSlice: null,
  },
  {
    id: "swarm-consensus",
    label: "Multi-agent swarm cross-screener consensus",
    status: "enabled",
    blocker: null,
    evidence: [
      "src/orchestrations/swarmConsensus.ts",
      "tests/swarm_consensus_1771.test.ts",
    ],
    tradeApprovalBypass: false,
    note: "Enabled as the consensus harness only: computeSwarmConsensus produces a DRAFT set + named dissent from N named screener outputs. It places no orders and feeds no trade path — a consensus symbol is not a trade proposal.",
    nextSlice: null,
  },
  {
    id: "volatility-darkpool-monitor",
    label: "Continuous volatility / dark-pool arbitrage monitor",
    status: "deliberately-unenabled",
    blocker:
      "flowService.ts has NO trade tape by audit F17 — every flow item is a modelled estimate from chain snapshots, labelled as such — and no licensed dark-pool feed exists on main. A streaming loop over modelled snapshots would present estimates as a live monitor. Point-in-time volatility gating already exists (#1769b); the continuous monitor stays unenabled pending a real tape/feed owner decision.",
    evidence: ["src/trading/options/flows/flowService.ts"],
    tradeApprovalBypass: false,
    nextSlice: null,
  },
  {
    id: "social-feed-digest",
    label: "Social feed wiring (screener digest → brief)",
    status: "enabled",
    blocker: null,
    evidence: [
      "src/orchestrations/socialDigestFeed.ts",
      "tests/social_digest_feed_1771.test.ts",
      "src/agents/social/pipeline.ts",
      "src/agents/social/briefStore.ts",
    ],
    tradeApprovalBypass: false,
    note: "Enabled as the opt-in wiring mechanism (slice D): SOCIAL_FEED_SOURCE resolver (default brief-only), provenance-marked digest-brief builder, and human-brief-wins staging into the same brief store the pipeline feed stage already reads — so a staged digest brief flows through the unchanged #1224 pipeline, live publish still approval-gated. SCOPE LIMIT, stated not hidden: no automatic tick invocation is wired (no screener-outcome feed into the social tick exists on main); an operator or scheduled goal must call stageDigestBrief with a real screener outcome before the pipeline firing. That caller wiring is the recorded follow-up, not a claimed automation.",
    nextSlice: null,
  },
  {
    id: "goal-chaining",
    label: "Goal-to-goal chaining support",
    status: "enabled",
    blocker: null,
    evidence: [
      "src/agentic/chainFiring.ts",
      "src/agentic/chainGovernance.ts",
      "src/agents/scheduled-agent.ts",
      "src/config/goalChainModes.ts",
    ],
    tradeApprovalBypass: false,
    nextSlice: null,
  },
  {
    id: "screener-to-trade-loop",
    label: "Closed-loop screener-to-trade execution",
    status: "enabled-gated",
    blocker: null,
    evidence: [
      "src/services/screenerFollowups.ts",
      "src/agents/trading-trade-workflow.ts",
    ],
    tradeApprovalBypass: false,
    note: "Enabled ONLY in gated form: screener output feeds reports and proposals; any execution settles through the trade workflow's await-approval event (trading-trade-workflow.ts). The manual approval gate is part of the loop, not a bypass around it.",
    nextSlice: null,
  },
];

/**
 * The #1771 reflection / self-tuning decision (F-45, F-54).
 * "developer-mediated" means: reflection findings become pending
 * review candidates for a human gate; they never rewrite code or
 * prompts, and no auto-apply path is built in #1771.
 */
export interface ReflectionDecision1771 {
  decision: "developer-mediated";
  mutatesCodeOrPrompts: false;
  rationale: string;
  evidence: string[];
}

export const REFLECTION_DECISION_1771: ReflectionDecision1771 = {
  decision: "developer-mediated",
  mutatesCodeOrPrompts: false,
  rationale:
    "Reflection logs stay developer-mediated because self-mutation would bypass the branch + PR + green gate change-control path (including Policy Gate) that every other change must take, with no owner-approved guardrail design on record for an agent rewriting its own code or prompts while remaining attributable. The existing loop already preserves the human gate: reflection.ts proposes (pending candidates, quant_status unverified), the human disposes.",
  evidence: ["src/services/reflection.ts", "src/services/learnings.ts"],
};

/** Lookup helper: undefined for an unknown id (callers must not invent rows). */
export function orchestrationStatusById(
  id: string,
): OrchestrationStatus | undefined {
  return ORCHESTRATION_STATUS.find((e) => e.id === id);
}
