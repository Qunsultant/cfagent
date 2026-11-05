/**
 * Consolidation C5 (#1361) — bundle route completion, split out of
 * etradeBroker.ts under the #995 pattern: the original keeps the
 * route condition + build prologue, and this module owns the
 * completion (mas_outcomes persistence, canonical mas_reports
 * persistence, inline delivery, response assembly). It constructs
 * no ETradeService — the route's service stays in the original —
 * so the construction ledgers are unaffected.
 */
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import { computePortfolioRisk, etradePortfolioRiskSource } from "../../services/portfolioRisk";
import { assessPortfolioConcentration } from "../../services/portfolioConcentration";
import { resolveSpyPutContract } from "../../services/hedgeProposals";
import {
  buildRecommendationBundle,
  persistBundleReport,
  type BundleCandidateInput,
  type BundleRouteCandidateBody,
  type RecommendationBundle,
} from "../../services/recommendationBundle";
import { buildScenario, type ScenarioConstraints, type ScenarioShockGrid } from "../../services/goalScenarioEngine";
import type { GoalKind } from "../../services/goalScenarioStore";
import type { FalsificationInput } from "../../services/researchFalsification";
import type { StrategyCandidate } from "../../trading";
import { sharedCorrelationService } from "../../services/correlationService";
import { resolveTenantChannelGate } from "../../services/tenantChannelGate";
import type { ETradeService } from "../../services/etrade";
import type { RepairAnalysis } from "../../services/repairProposals";
import type {
  ScreeningChannel,
  ScreeningChannelResult,
} from "../../services/screeningDelivery";

export interface BundleCompletionBody {
  persist?: boolean;
  persistReport?: boolean;
  deliver?: { channels?: ScreeningChannel[]; emailTo?: string };
}

export interface BundleRouteRequestBody extends BundleCompletionBody {
  candidate?: StrategyCandidate;
  candidates?: BundleRouteCandidateBody[];
  beta?: number | null;
  falsification?: FalsificationInput;
  goalKind?: GoalKind;
  shocks?: ScenarioShockGrid;
  constraints?: ScenarioConstraints;
  requestedContracts?: number;
  riskScore?: number;
  pickStatus?: "recommended" | "research_only" | "no_trade";
  pickConfidence?: "HIGH" | "MEDIUM" | "LOW";
}

export async function executeBundleRoute(
  ctx: EtradeBrokerRouteContext,
  etrade: ETradeService,
  body: BundleRouteRequestBody,
  candidates: BundleCandidateInput[],
  repairAnalysis: RepairAnalysis | null,
  userLogin: string,
): Promise<Response> {
  const primary = candidates[0];
  const report = await computePortfolioRisk(etradePortfolioRiskSource(etrade));
  const concentration = await assessPortfolioConcentration(
    report,
    (a, b) => sharedCorrelationService.estimate(a, b),
    primary.candidate.symbol,
  ).catch(() => null);
  const measured = (concentration?.candidateAssessment?.correlations ?? [])
    .filter((c) => c.source === "measured" && c.value !== null)
    .map((c) => c.value as number);
  const spyPut = await resolveSpyPutContract(etrade).catch(() => null);
  const scenario = buildScenario({
    goalKind: body.goalKind ?? "directional",
    portfolioRef: { kind: "real" },
    shocks: body.shocks,
    constraints: body.constraints,
  });
  const bundle = buildRecommendationBundle({
    candidates: candidates.map((c, i) => ({
      ...c,
      // The measured-correlation evidence belongs to the primary
      // candidate's concentration assessment; other candidates
      // carry no measured correlation rather than borrowing it.
      maxMeasuredCorrelation: i === 0 && measured.length ? Math.max(...measured) : null,
    })),
    report,
    scenario,
    falsification: body.falsification,
    pickStatus: body.pickStatus,
    pickConfidence: body.pickConfidence,
    concentration,
    spyPut,
    repairAnalysis,
  });
  return completeBundleRoute(ctx, {
    bundle,
    primarySymbol: primary.candidate.symbol,
    body,
    userLogin,
  });
}

/**
 * Completes a built bundle: optional persistence + delivery, then
 * the Phase 4 response shape (unchanged for existing callers —
 * extra fields appear only when their option was requested).
 */
export async function completeBundleRoute(
  ctx: EtradeBrokerRouteContext,
  args: {
    bundle: RecommendationBundle;
    primarySymbol: string;
    body: BundleCompletionBody;
    userLogin: string;
  },
): Promise<Response> {
  const { bundle, primarySymbol, body, userLogin } = args;
  let outcomeId: string | null = null;
  if (body.persist === true) {
    const { persistRecommendationBundle } = await import("../../services/recommendationBundle");
    const record = persistRecommendationBundle(ctx.getOrm(), bundle, { userLogin });
    outcomeId = record?.id ?? null;
  }
  // C5 (#1361): canonical persistence via the shared store seam
  // (never throws; null reported verbatim, never fails the build).
  const reportPersistenceRequested = body.persistReport === true;
  const reportPersistence = reportPersistenceRequested
    ? persistBundleReport(ctx.getOrm(), bundle, primarySymbol, userLogin)
    : null;
  let delivery: ScreeningChannelResult[] | null = null;
  if (Array.isArray(body.deliver?.channels) && body.deliver.channels.length > 0) {
    const { deliverScreeningContent, formatBundleDelivery, createScreeningDeliverySenders } = await import("../../services/screeningDelivery");
    const formatted = formatBundleDelivery(bundle);
    // Issue #3169: the tenant channel gate, resolved best-effort
    // (null = ungated, prior behavior — see tenantChannelGate).
    const channelGate = await resolveTenantChannelGate(ctx.env, userLogin);
    delivery = await deliverScreeningContent({
      channels: body.deliver.channels,
      subject: formatted.subject,
      text: formatted.text,
      event: "screening.bundle",
      data: { bundleId: bundle.id, decision: bundle.decision, qualification: bundle.qualification, confidence: bundle.confidence, text: formatted.text },
      emailTo: body.deliver.emailTo,
      senders: createScreeningDeliverySenders(ctx.env, ctx.getOrm(), userLogin),
      sql: ctx.getOrm(),
      userLogin,
      actor: "bundle-route",
      ...(channelGate ? { channelGate } : {}),
    });
  }
  if (outcomeId !== null || delivery !== null || reportPersistenceRequested) {
    return Response.json({
      ...bundle,
      ...(outcomeId !== null ? { persistence: { outcomeId } } : {}),
      ...(reportPersistenceRequested ? { reportPersistence } : {}),
      ...(delivery !== null ? { delivery } : {}),
    });
  }
  return Response.json(bundle);
}
