/**
 * Issue #3000 — risk-analysis stage for the saga trading leg.
 *
 * Pure assessment: the stage never fetches, never approves, never
 * executes. It judges a saga trade intent against caller-supplied
 * risk limits and whatever market data the caller (or a future data
 * seam) provides, and returns an assessment the leg records and gates
 * on.
 *
 * Modes (the distinction is the design):
 * - ASSESSABLE: limits + market data present. Options intents are run
 *   through the existing no-view engine (StrategyRiskAgent): the saga
 *   carries no market view, so the view path can never run here, and
 *   no view is ever invented. An intent whose legs match an
 *   engine-validated candidate passes with its risk report; a
 *   non-matching intent FAILS CLOSED — the engine does not validate
 *   that trade, so no draft is created. Stock intents use the AVWAP
 *   guard, strict: spot must be strictly above AVWAP (equality
 *   rejects, per the AVWAP ruling).
 * - UNASSESSABLE: limits or market data missing. The stage records an
 *   explicit unassessed-with-reason assessment and the draft proceeds.
 *   Unassessed never blocks: blocking on missing inputs would break
 *   every existing saga trade, which carries no limits and no market
 *   data at the leg. The missing data seam (chain-fetch-at-leg or
 *   screen-report-read) is a named follow-up, not hidden by this
 *   module: until it lands, live sagas record unassessed-with-reason.
 *
 * A violation gates DRAFT CREATION only (no startLeg). Per-order
 * human approval downstream is unchanged — the stage approves
 * nothing, and a violation produces no child workflow at all.
 */
import { StrategyRiskAgent } from "../trading";
import type { StrategyRiskReport } from "../trading";
import type { ScreenedOptionContractItem } from "../types";
import type { SagaTradeIntent } from "./sagaTradeLeg";

/** Caller-supplied risk limits for the trade intent (entry-optional). */
export interface SagaRiskLimits {
  maxPlannedLoss: number;
  minRewardRisk: number;
}

/** Market snapshot for stock-leg assessment (future data seam). */
export interface SagaRiskMarketSnapshot {
  spot?: number;
  avwap?: number;
}

/**
 * Market data the leg can assess with. Production supplies none of
 * this today (the leg has no market-data dep) — the field exists so
 * the data seam has a home that does not change this contract.
 */
export interface SagaRiskInputs {
  contracts?: ScreenedOptionContractItem[];
  marketSnapshot?: SagaRiskMarketSnapshot;
}

export type SagaRiskAssessment =
  | {
      status: "assessed";
      kind: "options";
      candidateId: string;
      report: StrategyRiskReport;
      violation: false;
    }
  | {
      status: "assessed";
      kind: "options";
      violation: true;
      reason: string;
    }
  | {
      status: "assessed";
      kind: "stock";
      spot: number;
      avwap: number;
      violation: boolean;
    }
  | { status: "unassessed"; reason: string };

export interface SagaRiskStageInput {
  intent: SagaTradeIntent;
  limits?: SagaRiskLimits;
  contracts?: ScreenedOptionContractItem[];
  marketSnapshot?: SagaRiskMarketSnapshot;
}

type IntentLeg = {
  side: string;
  optionType: string;
  strike: number;
  expirationDate: string;
  quantity: number;
};

function readIntentLegs(intent: SagaTradeIntent): IntentLeg[] | null {
  if (!Array.isArray(intent.optionLegs)) return null;
  const legs: IntentLeg[] = [];
  for (const raw of intent.optionLegs) {
    if (typeof raw !== "object" || raw === null) return null;
    const leg = raw as Record<string, unknown>;
    const side = leg["side"];
    const optionType = leg["optionType"];
    const strike = leg["strike"];
    const expirationDate = leg["expirationDate"];
    const quantity = leg["quantity"];
    if (
      (side !== "BUY" && side !== "SELL") ||
      (optionType !== "CALL" && optionType !== "PUT") ||
      typeof strike !== "number" ||
      typeof expirationDate !== "string" ||
      typeof quantity !== "number"
    ) {
      // An underspecified leg cannot be engine-validated.
      return null;
    }
    legs.push({ side, optionType, strike, expirationDate, quantity });
  }
  return legs;
}

function legsMatch(
  intentLegs: IntentLeg[],
  candidateLegs: Array<{
    side: string;
    optionType: string;
    strike: number;
    expirationDate: string;
    quantity: number;
  }>,
): boolean {
  if (intentLegs.length === 0 || intentLegs.length !== candidateLegs.length) {
    return false;
  }
  const remaining = [...candidateLegs];
  for (const want of intentLegs) {
    const at = remaining.findIndex(
      (got) =>
        got.side === want.side &&
        got.optionType === want.optionType &&
        got.strike === want.strike &&
        got.expirationDate === want.expirationDate &&
        got.quantity === want.quantity,
    );
    if (at === -1) return false;
    remaining.splice(at, 1);
  }
  return true;
}

function assessOptions(
  intent: SagaTradeIntent,
  limits: SagaRiskLimits,
  contracts: ScreenedOptionContractItem[],
): SagaRiskAssessment {
  const agent = new StrategyRiskAgent();
  const built = agent.buildNoViewStrategies(contracts, {
    symbol: intent.symbol,
    maxPlannedLoss: limits.maxPlannedLoss,
    minRewardRisk: limits.minRewardRisk,
  });
  const intentLegs = readIntentLegs(intent);
  if (intentLegs === null) {
    return {
      status: "assessed",
      kind: "options",
      violation: true,
      reason: "intent legs do not match an engine-validated candidate",
    };
  }
  const candidate = built.candidates.find(
    (c) =>
      c.symbol === intent.symbol &&
      c.legs.every((l) => l.optionType === "CALL" || l.optionType === "PUT") &&
      legsMatch(intentLegs, c.legs),
  );
  if (!candidate) {
    return {
      status: "assessed",
      kind: "options",
      violation: true,
      reason: "intent legs do not match an engine-validated candidate",
    };
  }
  // Built candidates passed every no-view acceptance rule (max
  // planned loss, structure reward/risk, POP floor, positive payoff),
  // so a match is engine-validated by construction.
  const report = agent.riskReport(candidate, {
    maxPlannedLoss: limits.maxPlannedLoss,
  });
  return {
    status: "assessed",
    kind: "options",
    candidateId: candidate.id,
    report,
    violation: false,
  };
}

export function assessSagaTradeRisk(
  input: SagaRiskStageInput,
): SagaRiskAssessment {
  const { intent } = input;
  if (intent.kind === "options") {
    if (!input.limits) {
      return { status: "unassessed", reason: "risk limits not supplied" };
    }
    if (!input.contracts) {
      return { status: "unassessed", reason: "option contracts not available" };
    }
    return assessOptions(intent, input.limits, input.contracts);
  }
  if (intent.kind === "stock") {
    const spot = input.marketSnapshot?.spot;
    const avwap = input.marketSnapshot?.avwap;
    if (spot === undefined || avwap === undefined) {
      return { status: "unassessed", reason: "market snapshot not available" };
    }
    // Strict AVWAP gate: spot must remain strictly above AVWAP.
    return {
      status: "assessed",
      kind: "stock",
      spot,
      avwap,
      violation: !(spot > avwap),
    };
  }
  return { status: "unassessed", reason: "unsupported trade kind" };
}
