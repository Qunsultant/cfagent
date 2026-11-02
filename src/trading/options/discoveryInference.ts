/**
 * Discovery (issue #14) — deterministic thesis inference (spec §7).
 *
 * A rule table over the slice-1 signal catalog: characterization +
 * evaluated signals in, either an inferred view (thesis, target in
 * expected-move units, DTE window, confidence, rule ID) or an
 * ABSTAIN with the near-miss signals recorded. Pure and total: every
 * input combination produces exactly one outcome, and the evaluation
 * order below IS the conflict-resolution policy.
 *
 * Honesty rules:
 *  - No silent bullish default, ever. Direction comes only from
 *    fired directional evidence (trend, breakout); an IV level alone
 *    is a near-miss, not a view.
 *  - The liquidity gate is absolute: without LIQUIDITY_OK nothing
 *    infers, however clean the other signals look.
 *  - Contradictory evidence (range + trend, up + down) abstains and
 *    names the conflict instead of letting rule order pick a winner.
 *  - The target is expressed in expected-move multiples read from
 *    the scanner config the caller passes — this module owns no
 *    numeric market assumptions of its own.
 */

import type {
  EtapiDiscoveryConfig,
  EtapiOpportunityScannerConfig,
} from "../../config/etapiConfig";
import type {
  DiscoverySignal,
  DiscoverySignalType,
  NameCharacterization,
} from "./discoverySignals";
import type { ExpectedIvDirection, OptionThesis } from "./strategyEngine";

export type DiscoveryConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface InferredThesis {
  inferred: true;
  /** Stable rule identifier — every expressed setup traces to one. */
  ruleId: string;
  thesis: OptionThesis;
  /** Volatility-normalized target: signed multiples of the name's
   *  expected move (the scanner config's targetEmMultiples). */
  targetEmMultiple: number;
  expectedIvDirection: ExpectedIvDirection;
  dteWindow: { minDte: number; maxDte: number };
  confidence: DiscoveryConfidence;
  /** Every fired signal, including the gate. */
  firedSignals: DiscoverySignalType[];
  /** The fired signals' evidence lines, joined — the setup's
   *  mandatory evidence trail. */
  rationale: string;
}

export interface InferenceAbstention {
  inferred: false;
  reason: string;
  /** Fired signals that came close but did not form a setup (the
   *  gate is not a near-miss; it is a precondition). */
  nearMissSignals: DiscoverySignalType[];
  firedSignals: DiscoverySignalType[];
}

export type ThesisInference = InferredThesis | InferenceAbstention;

export function inferThesis(
  c: NameCharacterization,
  signals: readonly DiscoverySignal[],
  config: EtapiDiscoveryConfig,
  targetEmMultiples: EtapiOpportunityScannerConfig["targetEmMultiples"],
): ThesisInference {
  const fired = signals.filter((s) => s.fired);
  const firedTypes = fired.map((s) => s.type);
  const has = (t: DiscoverySignalType) => firedTypes.includes(t);
  const nearMisses = firedTypes.filter((t) => t !== "LIQUIDITY_OK");
  const rationale = fired.map((s) => s.evidence).join("; ");

  const abstain = (reason: string): InferenceAbstention => ({
    inferred: false,
    reason,
    nearMissSignals: nearMisses,
    firedSignals: firedTypes,
  });

  // The gate is a precondition, not a rule.
  if (!has("LIQUIDITY_OK")) {
    const gate = signals.find((s) => s.type === "LIQUIDITY_OK");
    return abstain(
      `liquidity gate not cleared for ${c.symbol}${gate ? ` — ${gate.evidence}` : ""}`,
    );
  }

  // Conflicts abstain before any rule may fire.
  if (has("RANGE_PINNED") && has("TREND_UP")) {
    return abstain(`conflicting signals for ${c.symbol}: RANGE_PINNED with TREND_UP`);
  }
  if (has("RANGE_PINNED") && has("TREND_DOWN")) {
    return abstain(`conflicting signals for ${c.symbol}: RANGE_PINNED with TREND_DOWN`);
  }
  if (has("TREND_UP") && has("TREND_DOWN")) {
    return abstain(`conflicting signals for ${c.symbol}: TREND_UP with TREND_DOWN`);
  }

  const CONFIDENCE_STEPS: DiscoveryConfidence[] = ["LOW", "MEDIUM", "HIGH"];
  const stepConfidence = (confidence: DiscoveryConfidence, delta: number): DiscoveryConfidence =>
    CONFIDENCE_STEPS[
      Math.max(0, Math.min(CONFIDENCE_STEPS.length - 1, CONFIDENCE_STEPS.indexOf(confidence) + delta))
    ];

  const infer = (
    ruleId: string,
    thesis: OptionThesis,
    expectedIvDirection: ExpectedIvDirection,
    confidence: DiscoveryConfidence,
  ): InferredThesis => ({
    inferred: true,
    ruleId,
    thesis,
    targetEmMultiple: targetEmMultiples[thesis],
    expectedIvDirection,
    dteWindow: config.dteWindows[thesis],
    // Phase 2 (#18): flow is a confidence modifier only — aligned
    // chain-derived flow steps a directional inference up, opposing
    // flow steps it down; range_bound has no direction for flow to
    // confirm, and flow can never create or veto a thesis.
    confidence: (() => {
      if (thesis === "range_bound") return confidence;
      const aligned =
        (thesis === "bullish" && has("FLOW_BULLISH")) ||
        (thesis === "bearish" && has("FLOW_BEARISH")) ||
        (thesis === "large_move" && (has("FLOW_BULLISH") || has("FLOW_BEARISH")));
      const opposed =
        (thesis === "bullish" && has("FLOW_BEARISH")) ||
        (thesis === "bearish" && has("FLOW_BULLISH"));
      return stepConfidence(confidence, aligned ? 1 : opposed ? -1 : 0);
    })(),
    firedSignals: firedTypes,
    rationale,
  });

  // Range: pinned price action; rich IV strengthens it (premium
  // structures benefit if IV also falls), cheap IV leaves it neutral.
  // §6.2 modifier (#18): a near earnings event suppresses the
  // range_bound reading — a pinned range into a print is a coil, not
  // a premium farm — UNLESS an IV signal dominates (rich IV is the
  // event trade: IV_EXPENSIVE keeps the rich-IV range rule alive).
  const rangeSuppressedByEvent = has("RANGE_PINNED") && has("EVENT_NEAR") && !has("IV_EXPENSIVE");
  if (has("RANGE_PINNED") && !rangeSuppressedByEvent) {
    return has("IV_EXPENSIVE")
      ? infer("range-pinned-rich-iv", "range_bound", "fall", "HIGH")
      : infer("range-pinned", "range_bound", "unchanged", "MEDIUM");
  }

  // Trend: aligned SMAs + return. A co-firing breakout watch raises
  // confidence (continuation evidence), nothing more.
  if (has("TREND_UP")) {
    return has("BREAKOUT_WATCH")
      ? infer("trend-up-breakout", "bullish", "unchanged", "HIGH")
      : infer("trend-up", "bullish", "unchanged", "MEDIUM");
  }
  if (has("TREND_DOWN")) {
    return infer("trend-down", "bearish", "unchanged", "MEDIUM");
  }

  // Catalyst underpriced (#18): a near event whose implied move is
  // cheap against the name's realized vol is a large-move setup —
  // the market is underpricing the one move most likely to happen.
  // Cheap IV on top raises confidence (both vol readings agree the
  // options are cheap); the move itself is the evidence either way.
  if (has("EVENT_NEAR") && has("MOVE_UNDERPRICED")) {
    return infer(
      "event-move-underpriced",
      "large_move",
      "rise",
      has("IV_CHEAP") ? "HIGH" : "MEDIUM",
    );
  }

  // Coiled spring: pressing the highs with cheap options — the one
  // large-move pattern v1 recognizes.
  if (has("BREAKOUT_WATCH") && has("IV_CHEAP")) {
    return infer("coiled-breakout-cheap-iv", "large_move", "rise", "MEDIUM");
  }

  // A watch alone is weak directional evidence — it infers, at the
  // lowest confidence, and the downstream fit gate decides whether
  // anything expressible clears the floor.
  if (has("BREAKOUT_WATCH")) {
    return infer("breakout-watch", "bullish", "unchanged", "LOW");
  }

  if (rangeSuppressedByEvent) {
    return abstain(
      `range_bound suppressed for ${c.symbol} — EVENT_NEAR (earnings in ${c.daysToEarnings}d) without a dominant IV signal; a pinned range into a print is not a range trade`,
    );
  }

  return abstain(
    nearMisses.length > 0
      ? `no setup for ${c.symbol} — fired signals do not form a view (${nearMisses.join(", ")})`
      : `no setup for ${c.symbol} — no signals fired`,
  );
}

/**
 * Volatility framework (issue #1769, parent #1717; screener-rules.md
 * §1.5). Pure functions — no fetching, no inference state.
 *
 * 25-delta skew: Skew25 = IV_put,25Δ − IV_call,25Δ. Positive skew
 * means puts trade richer than calls at 25 delta (the usual equity
 * skew); negative means calls richer. Null on non-finite IVs.
 *
 * Decision matrix — strict boundaries, stated not silent:
 *   IVR > 50 AND IV > HV → SELL_PREMIUM (options overpriced; seller edge)
 *   IVR < 25             → STAND_DOWN   (options cheap; veto short premium)
 *   otherwise            → NO_READ      (default to technical/strike gates)
 * IVR = 50, IVR = 25, and IV = HV are all NO_READ: the doc's strict
 * inequalities are the contract, and a boundary value is not evidence
 * for either side. Null when any input is non-finite or negative —
 * a decision matrix over an impossible IV/HV/IVR is not a decision.
 * IV and HV are decimals (0.25 = 25%); IVR is a 0–100 rank.
 */
export type VolDecision = "SELL_PREMIUM" | "STAND_DOWN" | "NO_READ";

export function computeSkew25(putIv25: number, callIv25: number): number | null {
  if (!Number.isFinite(putIv25) || !Number.isFinite(callIv25)) return null;
  return putIv25 - callIv25;
}

export function evaluateVolDecisionMatrix(args: {
  iv: number;
  ivr: number;
  hv: number;
}): VolDecision | null {
  const { iv, ivr, hv } = args;
  if (!Number.isFinite(iv) || !Number.isFinite(ivr) || !Number.isFinite(hv)) return null;
  if (iv < 0 || hv < 0) return null;
  if (ivr > 50 && iv > hv) return "SELL_PREMIUM";
  if (ivr < 25) return "STAND_DOWN";
  return "NO_READ";
}
