/**
 * Issue #2991 (#2770 Phase A) — risk module: INVENTORY ONLY.
 *
 * No asset class is onboarded here, "onboarded" is not defined
 * here, and portfolio composition is not built here — those
 * questions are open with Venus and gate the risk portion, not
 * this decomposition. What this module records: the per-class
 * signals that exist today, and where the single-port module will
 * sit (one port, per-asset-class assessors behind it — the same
 * registry-behind-one-port shape as the planner port).
 *
 * Portfolio backends (aggregates #34, hedge drafts #54,
 * correlation flags #35, portfolio-aware sizing #36,
 * recommendation bundles #1135) are composer inputs, NOT an
 * engine — portfolio risk COMPOSES from asset-class assessments.
 */

export type RiskAssessorStatus = "present" | "thin" | "absent";

export interface RiskClassInventory {
  assetClass: string;
  status: RiskAssessorStatus;
  /** Signals the class has today (empty when absent). */
  signals: string[];
  /** Assessor module name, or null when none exists. */
  assessor: string | null;
  notes: string;
}

export const RISK_INVENTORY: RiskClassInventory[] = [
  {
    assetClass: "options",
    status: "present",
    signals: [
      "maxLoss",
      "maxProfit",
      "breakevens",
      "probabilityOfProfit",
      "netGreeks",
      "budgetUsedPct",
    ],
    assessor: "StrategyRiskAgent",
    notes:
      "StrategyRiskReport: caller-supplied maxPlannedLoss/minRewardRisk, never defaulted (decision D3 on #533).",
  },
  {
    assetClass: "stocks",
    status: "thin",
    signals: ["technicals", "AVWAP guard", "STOCK legs inside multi-leg structures"],
    assessor: null,
    notes: "No standalone equity assessor; stock risk rides technicals, the AVWAP guard, and multi-leg structures.",
  },
  {
    assetClass: "bonds",
    status: "absent",
    signals: [],
    assessor: null,
    notes: "No assessor. A bonds plan Block and assessor are named follow-ups.",
  },
  {
    assetClass: "forex",
    status: "absent",
    signals: [],
    assessor: null,
    notes: "No assessor. A forex plan Block and assessor are named follow-ups.",
  },
  {
    assetClass: "futures",
    status: "absent",
    signals: [],
    assessor: null,
    notes: "No assessor. A futures plan Block and assessor are named follow-ups.",
  },
  {
    assetClass: "commodities",
    status: "absent",
    signals: [],
    assessor: null,
    notes: "No assessor. A commodities plan Block and assessor are named follow-ups.",
  },
];

/** Where the single-port risk module will sit (proposed, not built). */
export const RISK_MODULE_SEAT = {
  path: "src/workflows/blocks/riskModule.ts (proposed)",
  port: "RiskPort",
  notes:
    "One port, per-asset-class assessor Blocks behind it; portfolio risk composes from asset-class assessments.",
};

/** The port's report shape (types only): the StrategyRiskReport fields. */
export const RISK_PORT_SHAPE = {
  input: ["assetClass", "position", "maxPlannedLoss", "minRewardRisk"],
  output: [
    "maxLoss",
    "maxProfit",
    "breakevens",
    "probabilityOfProfit",
    "netGreeks",
    "budgetUsedPct",
  ],
};
