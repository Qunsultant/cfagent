/**
 * Provider/broker slice 2 (issue #2598): the options feed gate delegation.
 *
 * This is a delegation, not inline dispatcher logic (thin-router pin
 * #359-17 forbids inline path conditions in routeRequest) and not a
 * condition inside the options handler module (the #995 pin keeps
 * src/agents/routes/etradeOptions.ts under the 50 KB target — it sits
 * 57 bytes under it on main — and anchors its route conditions and
 * ETradeService construction sites there, so the gate lives here and
 * the handler module is untouched by this slice).
 *
 * Position: immediately before the E*TRADE options delegation, so it
 * intercepts exactly the live-chain options paths the options handler
 * would otherwise serve with its E*TRADE feed. Stored-run reads
 * (scans, discovery-runs, profiles, latest, IV history, strategy
 * reviews), the static catalog, and config are NOT gated: they read
 * no live chain. When the tenant's selected data provider does not
 * declare the optionsChains capability (yahoo, alpaca, nasdaq, or an
 * unknown id), gated paths return the coded
 * FAILURE_DATA_PROVIDER_UNAVAILABLE response through the single
 * outcome resolver (catalog httpStatus), never an E*TRADE chain under
 * another provider's name and never invented data — in particular no
 * Yahoo options chains. A store failure fails open to etrade
 * (resolveTenantProviders), so a store outage never takes down the
 * feed that worked before. Returns null for every non-gated path, and
 * the orchestrator continues its sequential matching.
 *
 * Broker surfaces need no second gate here: slice 1's broker gate
 * already intercepts /etrade/ broker and watchlist paths, and
 * AccountPanels / the trading hub already render the coded broker
 * notice client-side. This gate covers the data-provider side only.
 * The feed itself is still E*TRADE-backed for etrade/public
 * selections (public's registry adapter is not yet the screener's
 * feed); swapping the feed onto a registry-resolved adapter is a
 * later slice, because it would change strategy selection/content.
 */

import type { Env } from "../../types";
import { resolveTenantProviders } from "../../services/tenantProviders";
import { dataCapabilityUnavailable } from "../../services/optionsProviderContext";
import { codedMessage, getOutcome } from "../../outcomes/outcomeAspects";

/**
 * Pure gate decision: null when the selected provider serves live
 * options chains, otherwise the coded unavailable response. Kept
 * separate from the handler so tests pin the decision without a D1
 * store; the handler only resolves the tenant's selections and
 * delegates here.
 */
export function optionsFeedGateResponse(providers: {
  dataProviderId: string;
  brokerId: string;
}): Response | null {
  const unavailable = dataCapabilityUnavailable(providers.dataProviderId, "optionsChains");
  if (!unavailable) return null;
  const entry = getOutcome(unavailable.code);
  return Response.json(
    {
      code: unavailable.code,
      message: codedMessage(
        unavailable.code,
        `Selected data provider ${unavailable.providerId} does not provide options chains.`,
      ),
      retryable: entry?.retryable ?? true,
      selectedDataProvider: unavailable.providerId,
      capability: unavailable.capability,
    },
    { status: entry?.httpStatus ?? 502 },
  );
}

/** The subset of OrchestratorAgent surface the options feed gate needs. */
export interface OptionsProviderGateRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
}

export async function handleOptionsProviderGateRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: OptionsProviderGateRouteContext,
): Promise<Response | null> {
  const gated =
    (path.endsWith("/etrade/options/chains") && request.method === "GET") ||
    (path.endsWith("/etrade/options/expire-dates") && request.method === "GET") ||
    (path.endsWith("/etrade/options/strategy") && request.method === "POST") ||
    (path.endsWith("/trading/options/recommend") && request.method === "POST") ||
    (path.endsWith("/trading/options/llm-ideas") && request.method === "POST") ||
    (path.endsWith("/trading/options/compare") && request.method === "POST") ||
    (path.endsWith("/trading/options/comparison") && request.method === "POST") ||
    (path.endsWith("/trading/options/strategies") && request.method === "POST") ||
    (path.endsWith("/trading/options/best-trade") && request.method === "POST") ||
    path.endsWith("/trading/options/screen") ||
    path.endsWith("/trading/options/unified");
  if (!gated) return null;
  const providers = await resolveTenantProviders(ctx.env);
  return optionsFeedGateResponse(providers);
}
