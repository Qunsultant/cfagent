/**
 * Issue #2991 (#2770 Phase A) — the saga's capability catalog and
 * compositions. The saga is a THIN composer: ordered Block refs +
 * parameters + gates, nothing else. Leg logic lives in the leg
 * registry, gate logic in journeyGateCapability, compensation in
 * sagaCompensation, notices in sagaOutcomeNotice, disclosure in
 * sagaCompensationDisclosure — this file only catalogs them and
 * states their order and terminals.
 *
 * Leg composition (the answer to broker-vs-goal): a goal screen
 * IS a composition of stock-leg + options-leg Blocks; a broker
 * single-asset screen IS one leg Block — same legs, same stages,
 * same contracts. The stock leg's stages are the #2869 named
 * stages; the options leg's stages are the #3186 pipeline stages
 * (step 1 generalized the #2869 contract onto them, pinned to real
 * calls). Structure selection (taxonomy structures)
 * is plan-time input to the options leg, not an execution leg:
 * no strategy execution leg exists today, so the goal
 * composition refs exactly the two screen legs.
 */

import {
  defineBlock,
  type BlockComposition,
  type BlockDefinition,
} from "./blockContract";

const PROMOTION = {
  candidate: "saga capability decomposition",
  evaluation: "saga flow tests",
  promotion: "Phase A decomposition",
};

const SAGA_TERMINALS: Record<string, string> = {
  payment_not_completed: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
  screen_start_failed_credit_issued:
    "FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED",
  screen_completed: "SUCCESS_SAGA_SCREEN_COMPLETED",
  screen_failed: "FAILURE_SAGA_SCREEN_FAILED",
  journey_approved: "SUCCESS_SAGA_JOURNEY_APPROVED",
  journey_denied: "FAILURE_SAGA_JOURNEY_DENIED",
  journey_expired: "FAILURE_SAGA_JOURNEY_EXPIRED",
  screen_failed_credit_issued: "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED",
  screen_failed_refund_requested: "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED",
  trade_settled: "SUCCESS_SAGA_TRADE_SETTLED",
  trade_rejected: "FAILURE_SAGA_TRADE_REJECTED",
  trade_expired: "FAILURE_SAGA_TRADE_EXPIRED",
  trade_leg_failed: "FAILURE_SAGA_TRADE_LEG_FAILED",
  proposal_failed: "FAILURE_SAGA_PROPOSAL_FAILED",
  failed: "FAILURE_SAGA_FAILED",
};

const SCREEN_TERMINALS: Record<string, string> = {
  completed: "SUCCESS_SCREEN_COMPLETED",
  partial: "SUCCESS_SCREEN_PARTIAL_RESULTS",
  failed: "FAILURE_SCREEN_RUN_FAILED",
};

export const SAGA_BLOCKS: BlockDefinition[] = [
  defineBlock({
    id: "payment-leg",
    kind: "leg",
    version: "1",
    port: { methods: ["startLeg", "getLegStatus"] },
    inputSchema: [
      { name: "runRequestId", type: "string", required: true },
      { name: "screenerCommand", type: "object", required: true },
    ],
    outputSchema: [
      { name: "workflowId", type: "string", required: true },
      { name: "existing", type: "boolean", required: true },
    ],
    stageContract: {
      stageIds: ["start", "poll"],
      // Terminal outputs only: "started" continues to Leg 1.
      terminalSemantics: {
        screener_failed_credit_issued:
          "FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED",
        payment_not_completed: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
      },
    },
    catalogEntries: [
      "FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED",
      "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
    ],
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "screener-leg",
    kind: "leg",
    version: "1",
    port: { methods: ["startLeg", "getLegStatus"] },
    inputSchema: [
      { name: "screenerWorkflowId", type: "string", required: true },
    ],
    outputSchema: [
      { name: "lifecycle", type: "string", required: true },
    ],
    stageContract: {
      stageIds: ["poll"],
      // Completed/ReportGenerated continue to the gate; Failed
      // compensates (credit, or refund-request for stripe).
      terminalSemantics: {
        failed_credit: "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED",
        failed_refund: "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED",
      },
    },
    catalogEntries: [
      "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED",
      "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED",
    ],
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "trade-leg",
    kind: "leg",
    version: "1",
    port: { methods: ["startLeg", "getLegStatus"] },
    inputSchema: [
      { name: "tradeIntent", type: "object", required: true },
    ],
    outputSchema: [
      { name: "status", type: "string", required: true },
      { name: "orderId", type: "string", required: false },
    ],
    stageContract: {
      stageIds: ["propose", "poll"],
      terminalSemantics: {
        settled: "SUCCESS_SAGA_TRADE_SETTLED",
        rejected: "FAILURE_SAGA_TRADE_REJECTED",
        expired: "FAILURE_SAGA_TRADE_EXPIRED",
        failed: "FAILURE_SAGA_TRADE_LEG_FAILED",
        proposal_failed: "FAILURE_SAGA_PROPOSAL_FAILED",
      },
    },
    catalogEntries: [
      "SUCCESS_SAGA_TRADE_SETTLED",
      "FAILURE_SAGA_TRADE_REJECTED",
      "FAILURE_SAGA_TRADE_EXPIRED",
      "FAILURE_SAGA_TRADE_LEG_FAILED",
      "FAILURE_SAGA_PROPOSAL_FAILED",
    ],
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "journey-gate",
    kind: "gate",
    version: "1",
    port: { methods: ["run", "withdraw"] },
    inputSchema: [
      { name: "sagaId", type: "string", required: true },
      { name: "screenerWorkflowId", type: "string", required: true },
    ],
    outputSchema: [
      { name: "kind", type: "string", required: true },
      { name: "decision", type: "object", required: false },
    ],
    stageContract: {
      stageIds: ["prompt", "decide", "withdraw"],
      terminalSemantics: {
        approved: "SUCCESS_SAGA_JOURNEY_APPROVED",
        denied: "FAILURE_SAGA_JOURNEY_DENIED",
        expired: "FAILURE_SAGA_JOURNEY_EXPIRED",
      },
    },
    catalogEntries: [
      "SUCCESS_SAGA_JOURNEY_APPROVED",
      "FAILURE_SAGA_JOURNEY_DENIED",
      "FAILURE_SAGA_JOURNEY_EXPIRED",
    ],
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "compensation",
    kind: "compensation",
    version: "1",
    port: { methods: ["compensateFailedScreen"] },
    inputSchema: [
      { name: "runRequestId", type: "string", required: true },
      { name: "rail", type: "string", required: false },
    ],
    outputSchema: [
      { name: "form", type: "string", required: true },
    ],
    stageContract: {
      stageIds: ["select-form", "issue"],
      terminalSemantics: {
        credit_issued: "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED",
        refund_requested: "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED",
      },
    },
    catalogEntries: [
      "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED",
      "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED",
    ],
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "disclosure",
    kind: "disclosure",
    version: "1",
    port: { methods: ["render"] },
    inputSchema: [{ name: "rail", type: "string", required: false }],
    outputSchema: [{ name: "text", type: "string", required: true }],
    stageContract: {
      stageIds: ["render", "attach"],
      // Wiring, not a terminal: the disclosure rides the started
      // row, so it declares no terminal semantics.
      terminalSemantics: {},
    },
    catalogEntries: ["SUCCESS_SAGA_SCREEN_COMPLETED"],
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "outcome-notice",
    kind: "notice",
    version: "1",
    port: { methods: ["build", "post"] },
    inputSchema: [
      { name: "sagaId", type: "string", required: true },
      { name: "outcomeCode", type: "string", required: true },
    ],
    outputSchema: [{ name: "receipt", type: "object", required: true }],
    stageContract: {
      stageIds: ["render", "deliver"],
      // The notice renders for every saga terminal.
      terminalSemantics: { ...SAGA_TERMINALS },
    },
    catalogEntries: Object.values(SAGA_TERMINALS),
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "stock-leg",
    kind: "leg",
    version: "1",
    port: { methods: ["plan", "screen"] },
    inputSchema: [
      { name: "universe", type: "string", required: true },
      { name: "filters", type: "object", required: true },
      { name: "trigger", type: "string", required: true },
    ],
    outputSchema: [
      { name: "hits", type: "array", required: true },
      { name: "outcome", type: "string", required: true },
    ],
    stageContract: {
      // The #2869 named stages, in order.
      stageIds: [
        "plan",
        "brokerStart",
        "acquireUniverse",
        "fetchQuotes",
        "enrich",
        "computeIndicatorsAndScores",
        "applyFilters",
        "rankAndGrade",
        "detectStandouts",
        "persistCanonicalResults",
        "analysis-done",
        "shapeReport",
        "deliver",
      ],
      terminalSemantics: { ...SCREEN_TERMINALS },
    },
    catalogEntries: Object.values(SCREEN_TERMINALS),
    promotion: PROMOTION,
  }),
  defineBlock({
    id: "options-leg",
    kind: "leg",
    version: "1",
    port: { methods: ["plan", "screen"] },
    inputSchema: [
      { name: "underlyings", type: "array", required: false },
      { name: "dteWindow", type: "object", required: false },
      { name: "spreadCap", type: "number", required: false },
      { name: "liquidityFloor", type: "object", required: false },
      { name: "structures", type: "array", required: false },
    ],
    outputSchema: [
      { name: "contracts", type: "array", required: true },
      { name: "outcome", type: "string", required: true },
    ],
    stageContract: {
      // #3186 step 1: the options stage ids are the #2869 contract
      // now (generalized by step 1), pinned to real calls in
      // tests/stage_families_3186.test.ts - no longer the Phase A
      // stock-aligned proposal.
      stageIds: [
        "plan",
        "chainFetch",
        "enrich",
        "screen",
        "risk",
        "persistCanonicalResults",
        "shapeReport",
        "deliver",
      ],
      terminalSemantics: {
        ...SCREEN_TERMINALS,
        no_contracts: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
      },
    },
    catalogEntries: [
      ...Object.values(SCREEN_TERMINALS),
      "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
    ],
    promotion: PROMOTION,
  }),
];

/** The saga: ordered Block refs + gates, nothing else. */
export const SAGA_COMPOSITION: BlockComposition = {
  id: "saga",
  refs: [
    { blockId: "payment-leg", action: "start+observe" },
    { blockId: "screener-leg", action: "observe" },
    { blockId: "journey-gate", action: "run", gateBlockId: "journey-gate" },
    { blockId: "trade-leg", action: "propose+observe" },
    { blockId: "compensation", action: "compensate" },
    { blockId: "disclosure", action: "render" },
    { blockId: "outcome-notice", action: "deliver" },
  ],
  terminals: { ...SAGA_TERMINALS },
};

/** A goal screen: stock-leg + options-leg, same legs as the broker. */
export const GOAL_SCREEN_COMPOSITION: BlockComposition = {
  id: "goal-screen",
  refs: [
    { blockId: "stock-leg", action: "screen" },
    { blockId: "options-leg", action: "screen" },
  ],
  terminals: { ...SCREEN_TERMINALS },
};

/** A broker single-asset screen: one leg Block. */
export const BROKER_SINGLE_ASSET_COMPOSITION: BlockComposition = {
  id: "broker-single-asset",
  refs: [{ blockId: "stock-leg", action: "screen" }],
  terminals: { ...SCREEN_TERMINALS },
};
