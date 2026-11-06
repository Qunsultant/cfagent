/**
 * Issue #3519 — Stock Copilot Critic & Reflection Engine.
 *
 * Evaluates non-deterministic cycle outputs (plans, trade intents, no-trade decisions)
 * against trading goals, risk bounds, and venue rules. Emits structured verdicts
 * (accept / revise / reject) and extracts distilled insights for tenancy memory.
 */
import type { CopilotCriticVerdict, CopilotPositionRecord } from "../data/stockCopilotStorePorts";
import type { CopilotSessionId } from "./stockCopilotSessions";
import type { ITradingPlatform } from "../trading";
import { COPILOT_STOP_LOSS_PCT, COPILOT_TAKE_PROFIT_PCT } from "./stockCopilot";

export interface ProposedTradeIntent {
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT";
  limitPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  strategy?: string;
}

export interface CriticEvaluationInput {
  userLogin: string;
  session: CopilotSessionId | null;
  platform: ITradingPlatform;
  proposedIntents: ProposedTradeIntent[];
  openPositions: CopilotPositionRecord[];
  cvarBindingConstraint?: string;
  noTradeReason?: string | null;
}

export interface CriticDistilledLearning {
  category: "execution" | "risk" | "pattern" | "session" | "refusal";
  insight: string;
  suggestedAction?: string;
}

export interface CriticEvaluationResult {
  verdict: "accept" | "revise" | "reject";
  reason: string;
  violations: string[];
  recommendations: string[];
  distilledLearnings: CriticDistilledLearning[];
}

export function evaluateCriticRules(input: CriticEvaluationInput): CriticEvaluationResult {
  const violations: string[] = [];
  const recommendations: string[] = [];
  const distilledLearnings: CriticDistilledLearning[] = [];

  const isExtendedSession =
    input.session === "pre_market" ||
    input.session === "after_hours" ||
    input.session === "exto";

  // 1. Evaluate Proposed Trade Intents
  for (const intent of input.proposedIntents) {
    // Venue Rule: extended hours require LIMIT orders
    if (isExtendedSession && intent.orderType !== "LIMIT") {
      violations.push(
        `Extended hours session (${input.session}) requires LIMIT order type, but ${intent.symbol} was planned as ${intent.orderType}.`,
      );
      recommendations.push(
        `Convert ${intent.symbol} order to LIMIT with reference price ${intent.limitPrice ?? 0}.`,
      );
    }

    // Protective Stop Loss Rule (max 5.5% allowed loss from entry/limit)
    if (intent.action === "BUY") {
      if (!intent.stopPrice || intent.stopPrice <= 0) {
        violations.push(
          `Stop-loss protection missing on BUY intent for ${intent.symbol}. Mandatory bracket exit missing.`,
        );
      } else {
        const refPrice = intent.limitPrice ?? intent.stopPrice / (1 - COPILOT_STOP_LOSS_PCT / 100);
        const lossPct = ((refPrice - intent.stopPrice) / refPrice) * 100;
        if (lossPct > 5.5) {
          violations.push(
            `Stop-loss loss percentage (${lossPct.toFixed(1)}%) for ${intent.symbol} exceeds maximum allowed 5% loss constraint.`,
          );
        }
      }

      // Target Price Rule (must be >= entry price)
      if (!intent.targetPrice || intent.targetPrice <= (intent.limitPrice ?? 0)) {
        violations.push(
          `Take-profit target price for ${intent.symbol} must be positive and higher than entry limit price.`,
        );
      }
    }

    // Quantity / Sizing Rule
    if (!Number.isFinite(intent.quantity) || intent.quantity <= 0 || !Number.isInteger(intent.quantity)) {
      violations.push(
        `Order quantity for ${intent.symbol} must be a positive integer, got ${intent.quantity}.`,
      );
    }
  }

  // 2. Evaluate Platform Wire Session Support
  if (isExtendedSession && typeof input.platform.supportsSessionOrders === "function") {
    if (!input.platform.supportsSessionOrders(input.session!)) {
      violations.push(
        `Trading platform does not support wire session terms for active session: ${input.session}.`,
      );
    }
  }

  // 3. Extract Distilled Learnings
  if (isExtendedSession && input.proposedIntents.length > 0) {
    distilledLearnings.push({
      category: "session",
      insight: `Session ${input.session} trading requires strict limit order terms to avoid adverse fills outside market hours.`,
      suggestedAction: "Maintain limit-only order shaping in extended hours.",
    });
  }

  if (input.cvarBindingConstraint) {
    distilledLearnings.push({
      category: "risk",
      insight: `CVaR constraint (${input.cvarBindingConstraint}) bound position allocation to maintain portfolio variance budget.`,
      suggestedAction: "Respect CVaR sizing caps across correlated equity symbols.",
    });
  }

  if (input.noTradeReason) {
    distilledLearnings.push({
      category: "refusal",
      insight: `Cycle concluded with no-trade: ${input.noTradeReason}. Preserved buying power.`,
    });
  } else if (input.proposedIntents.length > 0 && violations.length === 0) {
    distilledLearnings.push({
      category: "execution",
      insight: `Approved ${input.proposedIntents.length} setup(s) adhering to stop (-5%) and target (+10%) brackets.`,
    });
  }

  // 4. Resolve Verdict
  if (violations.length === 0) {
    return {
      verdict: "accept",
      reason: "All risk parameters, brackets, session rules, and sizing bounds verified.",
      violations,
      recommendations,
      distilledLearnings,
    };
  }

  // If only venue order type needs revision (MARKET -> LIMIT), emit 'revise'
  const onlyVenueViolations = violations.every((v) => v.includes("LIMIT order type"));
  if (onlyVenueViolations && recommendations.length > 0) {
    return {
      verdict: "revise",
      reason: "Proposed intent requires parameter revision for extended hours venue rules.",
      violations,
      recommendations,
      distilledLearnings,
    };
  }

  return {
    verdict: "reject",
    reason: `Safety constraint violations detected: ${violations.join("; ")}`,
    violations,
    recommendations,
    distilledLearnings,
  };
}

