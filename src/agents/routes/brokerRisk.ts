/**
 * Issue #3324 (programme #3292): broker-neutral portfolio risk.
 *
 * Four routes, the same computations the E*TRADE routes expose (issue #34/#35/#36),
 * served for the SELECTED broker:
 *
 *   GET  /broker/portfolio-risk              aggregate report
 *   POST /broker/portfolio-risk/evaluate     current totals + a candidate's Greeks
 *   POST /broker/portfolio-risk/correlation  concentration / pairwise correlation
 *   POST /broker/portfolio-risk/size         portfolio-aware position sizing
 *
 * Why a neutral route rather than an Alpaca branch inside `/etrade/*`: the risk
 * model is the platform's, not a broker's. Its inputs are what a broker supplies
 * (book, chain Greeks, spot), so the surface reads the same three things from
 * whichever broker is selected and names that broker in the envelope.
 *
 * Honesty rules:
 *   - the catalogue decides whether the selected broker can risk-report at all,
 *     and a "no" answers `501 provider_unsupported` naming the broker BEFORE any
 *     platform is constructed;
 *   - a platform that cannot supply book + chains + spot never yields a partial
 *     report, because a report missing one broker's Greeks is a wrong number
 *     with a right-looking shape;
 *   - the report's own `excluded`/`partial` lists carry every position that could
 *     not be resolved, so coverage is visible in the response, not inferred.
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { TradingPlatformRegistry, brokerSupports, platformPortfolioRiskSource } from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { isFeatureEnabled } from "../../config/featureFlags";
import {
  computePortfolioRisk,
  evaluatePostTradeTotals,
  type CandidateGreekContribution,
} from "../../services/portfolioRisk";
import { assessPortfolioConcentration } from "../../services/portfolioConcentration";
import { sharedCorrelationService } from "../../services/correlationService";
import { sizeCandidateAgainstPortfolio, type SizingCandidate } from "../../services/positionSizing";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";
import { BROKER_PANEL_CONTRACT_FLAG } from "./brokerReads";

export interface BrokerRiskRouteContext {
  env: Env;
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
}

const UNSUPPORTED_CODE = "provider_unsupported";
const FEATURE_DISABLED_CODE = "FEATURE_DISABLED";
const UNAUTHENTICATED_CODE = "unauthenticated";
const RISK_FAILED_CODE = "BROKER_RISK_FAILED";

function unsupportedResponse(broker: string): Response {
  return Response.json(
    {
      code: UNSUPPORTED_CODE,
      broker,
      message: `Portfolio risk is not available for the selected broker (${broker}); no other broker's book, chain, or risk numbers are used in its place.`,
      retryable: false,
    },
    { status: 501 },
  );
}

function featureDisabledResponse(): Response {
  return Response.json(
    {
      code: FEATURE_DISABLED_CODE,
      feature: BROKER_PANEL_CONTRACT_FLAG,
      message: "Broker panels are disabled by feature flag. No risk report is computed and no broker data is read.",
      retryable: false,
    },
    { status: 503 },
  );
}

function unauthenticatedResponse(): Response {
  return Response.json(
    {
      code: UNAUTHENTICATED_CODE,
      message: "x-user-login is required: the risk report reads a per-user broker account.",
      retryable: false,
    },
    { status: 401 },
  );
}

function failedResponse(broker: string, reason: string): Response {
  return Response.json(
    { code: RISK_FAILED_CODE, broker, message: `The ${broker} book could not be risk-reported: ${reason}.` },
    { status: 502 },
  );
}

export async function handleBrokerRiskRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerRiskRouteContext,
): Promise<Response | null> {
  const wantsReport = path.endsWith("/broker/portfolio-risk");
  const wantsEvaluate = path.endsWith("/broker/portfolio-risk/evaluate");
  const wantsCorrelation = path.endsWith("/broker/portfolio-risk/correlation");
  const wantsSize = path.endsWith("/broker/portfolio-risk/size");
  if (!wantsReport && !wantsEvaluate && !wantsCorrelation && !wantsSize) return null;

  if (wantsReport) {
    if (request.method !== "GET") return null;
  } else if (request.method !== "POST") {
    return null;
  }

  if (!(await isFeatureEnabled(ctx.env, BROKER_PANEL_CONTRACT_FLAG))) {
    return featureDisabledResponse();
  }

  const userLogin = request.headers.get("x-user-login") || "";
  if (!userLogin) return unauthenticatedResponse();

  const broker = await resolveTenantBroker(ctx.env);
  // Declared capability first: an unsupported broker must not be constructed.
  if (!brokerSupports(broker, "portfolioRisk")) {
    return unsupportedResponse(broker);
  }

  const readSetting = (key: string) => ctx.readSettingRaw(key) ?? null;
  const environment = resolveBrokerEnvironmentFromSettings(readSetting, ctx.env);
  const platform = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, environment);
  const source = platformPortfolioRiskSource(platform);
  if (!source) {
    // The catalogue said yes but the platform cannot supply the three reads the
    // model needs (book, chain, spot). Same answer, named the same way.
    return unsupportedResponse(broker);
  }

  try {
    if (wantsEvaluate) {
      const body = (await request.json().catch(() => ({}))) as { candidate?: CandidateGreekContribution };
      if (!body.candidate) {
        return Response.json(
          { code: "invalid_request", message: "candidate Greek contribution is required." },
          { status: 400 },
        );
      }
      const current = await computePortfolioRisk(source);
      return Response.json({
        broker,
        environment,
        current,
        postTradeTotals: evaluatePostTradeTotals(current, body.candidate),
      });
    }

    if (wantsCorrelation) {
      const body = (await request.json().catch(() => ({}))) as { candidateSymbol?: string };
      const report = await computePortfolioRisk(source);
      const assessment = assessPortfolioConcentration(
        report,
        (a, b) => sharedCorrelationService.estimate(a, b),
        body.candidateSymbol,
      );
      // Same payload the E*TRADE route returns, plus the broker that produced it:
      // one client surface can read either broker without a shape branch.
      return Response.json({ broker, environment, ...assessment });
    }

    if (wantsSize) {
      const body = (await request.json().catch(() => ({}))) as { candidate?: SizingCandidate };
      if (!body.candidate?.symbol || !body.candidate?.perContract) {
        return Response.json(
          { code: "invalid_request", message: "candidate with symbol and perContract contributions is required." },
          { status: 400 },
        );
      }
      const report = await computePortfolioRisk(source);
      return Response.json({ broker, environment, ...sizeCandidateAgainstPortfolio(report, body.candidate) });
    }

    const report = await computePortfolioRisk(source);
    return Response.json({ broker, environment, ...report });
  } catch (error) {
    const reason = (error as Error)?.message || "the risk read failed";
    return failedResponse(broker, reason);
  }
}
