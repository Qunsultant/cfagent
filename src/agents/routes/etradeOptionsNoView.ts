/**
 * Issue #2600: the no-view strategies branch, moved out of
 * src/agents/routes/etradeOptions.ts — that file sits 90 B under the
 * #359 50 KB ratchet on main, so the branch lives here and the
 * dispatcher keeps only the call. The #995 split rules still hold:
 * this module is not a routeRequest delegation (the inventory scan
 * only expands delegations), it performs no path matching (the
 * caller passes isBestTrade), and it constructs its own
 * ETradeService like every sibling options route (the C5 precedent
 * in the trading extraction ledger — the pin there records this
 * file, it does not hide it).
 *
 * strategyMode "no-view" routes to the EXISTING no-view path
 * (parseNoViewStrategyRequest + no-view pick) — never through the
 * viewed discovery schema with view fields attached. View fields
 * on a no-view body are a 400 naming the field (never stripped
 * silently); best-trade + no-view is a 400, because a best trade
 * is a viewed, recommended pick and a no-view pick is never
 * "recommended" and never HIGH confidence by construction. The
 * response carries candidates only — no bestTrade, no recommended
 * status.
 *
 * Returns null when the body is not a no-view body, so the caller
 * continues into the viewed flow. Returns a Response otherwise
 * (400 errors, or the candidate list).
 */

import { optionsFeedProviderStamp } from "../../services/optionsProviderContext";
import { unauthenticatedResponse } from "./routeIdentity";
import type { EtradeOptionsRouteContext } from "./etradeOptions";
import { ETradeService } from "../../services/etrade";
import {
  DynamicOptionsScreener,
  OptionsDataAgent,
  StrategyRiskAgent,
  parseNoViewStrategyRequest,
  NO_VIEW_FORBIDDEN_FIELDS,
  resolveAllowedStrategyIds,
  resolvePanelFetchBands,
  type StrategyRequest,
} from "../../trading";
import { recordStrategyScreenRun } from "../../services/optionsServeRecord";
import { resolveTenantProviders } from "../../services/tenantProviders";

export async function runNoViewStrategies(
  ctx: EtradeOptionsRouteContext,
  request: Request,
  body: Record<string, unknown> | null,
  path: string,
  isBestTrade: boolean,
): Promise<Response | null> {
  if (body?.strategyMode !== "no-view") return null;
  if (isBestTrade) {
    return Response.json({ error: "strategyMode \"no-view\" cannot produce a best trade; use POST /trading/options/strategies for a no-view candidate list." }, { status: 400 });
  }
  const raw = body;
  for (const field of NO_VIEW_FORBIDDEN_FIELDS) {
    if (raw[field] !== undefined) {
      return Response.json({ error: `${field}: view fields are not allowed in a no-view request` }, { status: 400 });
    }
  }
  const noViewBody: Record<string, unknown> = {};
  for (const key of ["symbol", "maxPlannedLoss", "minRewardRisk", "minProbabilityOfProfit", "riskProfile",
    "optimizationBias", "dataMode", "minDte", "maxDte", "minVolume", "minOpenInterest", "maxSpreadPct",
    "maxQuoteAgeSeconds", "contractLimit", "maxStrikesPerSide", "maxIronCondors", "eventPolicy",
    "allowedStrategies"] as const) {
    if (raw[key] !== undefined) noViewBody[key] = raw[key];
  }
  // candidateLimit "all" is uncapped on this path too (the
  // no-view schema only accepts a number, so it is stripped
  // here and applied as an uncapped slice below, not dropped).
  const noViewCandidateLimitAll = raw.candidateLimit === "all";
  if (typeof raw.candidateLimit === "number") noViewBody.candidateLimit = raw.candidateLimit;
  const parsedNoView = parseNoViewStrategyRequest(noViewBody);
  if (!parsedNoView.ok) {
    return Response.json({ error: parsedNoView.error }, { status: 400 });
  }
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
    const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await etrade.getUniverseDeps?.(ctx.agentCtx?.storage)));
    const noViewReq = parsedNoView.value;
    const bandedNoView = resolvePanelFetchBands(
      // The thesis/target fields are dummies for the shape only:
      // strategyMode "no-view" makes the band resolver filter by
      // wanted set alone, never by thesis.
      { ...noViewReq, thesis: "bullish", targetPrice: 0, targetDate: "", expectedIvDirection: "unchanged", strategyMode: "no-view" } as unknown as StrategyRequest,
      raw.farDated === true,
    );
    const snapshot = await dataAgent.loadSnapshot(bandedNoView.request);
    const built = new StrategyRiskAgent().buildNoViewStrategies(snapshot.contracts, noViewReq);
    const candidates = noViewCandidateLimitAll
      ? built.candidates
      : (typeof noViewReq.candidateLimit === "number" ? built.candidates.slice(0, noViewReq.candidateLimit) : built.candidates);
    const screenedOut = built.evaluations
      .filter((e) => e.status !== "accepted")
      .map((e) => ({ id: e.id, reason: e.summary || e.reasons[0]?.reason || "not accepted" }));
    recordStrategyScreenRun(ctx.getOrm(), {
      ...optionsFeedProviderStamp(await resolveTenantProviders(ctx.env)),
      userLogin,
      symbol: noViewReq.symbol,
      trigger: "manual",
      mode: "strategies",
      ranked: candidates,
      screenedOut,
      screen: snapshot.screen,
      contracts: snapshot.contracts,
      dataSource: snapshot.dataSource,
      asyncJobId: ctx.asyncJobId,
      strategyMode: "no-view",
      riskProfile: typeof raw.riskProfile === "string" ? raw.riskProfile : undefined,
      allowedStrategies: noViewReq.allowedStrategies,
      allowedStrategiesResolved: resolveAllowedStrategyIds(noViewReq.allowedStrategies ?? ["all"]).ids,
      dteMin: typeof noViewReq.minDte === "number" ? noViewReq.minDte : undefined,
      dteMax: typeof noViewReq.maxDte === "number" ? noViewReq.maxDte : undefined,
      candidateLimit: noViewCandidateLimitAll ? "all" : (typeof noViewReq.candidateLimit === "number" ? noViewReq.candidateLimit : undefined),
      farDated: typeof raw.farDated === "boolean" ? raw.farDated : undefined,
      fetchBands: bandedNoView.bands,
      horizonLimited: bandedNoView.horizonLimited.length > 0 ? bandedNoView.horizonLimited : undefined,
      submittedVia: `ui — POST ${path} (options-strategy-panel, no-view)`,
    });
    return Response.json({
      status: candidates.length > 0 ? "ranked_candidates" : "no_candidates",
      strategyMode: "no-view",
      scoreModel: built.scoreModel,
      candidates,
      evaluations: built.evaluations,
      nameLedger: built.nameLedger,
      screenedOut,
      excluded: built.excluded,
      screen: snapshot.screen,
      contracts: snapshot.contracts,
      dataSource: snapshot.dataSource,
      snapshotError: snapshot.validationError,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Options no-view pipeline failed" }, { status: 400 });
  }
}
