/**
 * Provider / broker agnosticism, slice 1: the broker gate delegation.
 *
 * This is a delegation, not inline dispatcher logic (thin-router pin
 * #359-17 forbids inline path conditions in routeRequest) and not a
 * condition inside the broker/watchlist handler modules (the #995
 * pin requires the route-condition inventory of etradeBroker.ts /
 * etradeOptions.ts to stay byte-identical, and both files sit
 * within ~280 bytes of the #359 50 KB ceiling).
 *
 * Position: immediately before the E*TRADE broker delegation, so
 * it intercepts exactly the paths the broker and watchlist
 * handlers would otherwise serve. /etrade/options/* paths are
 * data surfaces owned by the options handler and are NOT gated
 * by broker selection; the options feed registry wiring is
 * slice 2. When the tenant broker is not etrade, gated paths
 * return the coded FAILURE_BROKER_UNAVAILABLE response (409),
 * never an E*TRADE error and never a silent fallback. A store
 * failure fails CLOSED with a named 503 (issue #3460 slice 3):
 * the gate cannot verify the tenant's broker, so it serves
 * nothing rather than failing open to etrade. An unconfigured
 * tenant is refused with 409 NO_BROKER_CONFIGURED (issue #4431,
 * S5/N3) — the pass-through the S7 menu was to retire is retired
 * here, for the gate, instead. The #3460 S0–S12 slice menu
 * (unfiled) is the boundary: this gate states it, it does not
 * duplicate that programme's planning.
 * Returns null for every non-gated path, and the orchestrator
 * continues its sequential matching.
 */
import type { Env } from "../../types";
import {
  brokerUnavailableResponse,
  brokerStoreUnavailableResponse,
  noBrokerConfiguredResponse,
} from "../../services/tenantProviders";
import { readTenantBrokerSelection } from "../../services/providerConnections";

/** The subset of OrchestratorAgent surface the broker gate needs. */
export interface BrokerGateRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
}

export async function handleBrokerGateRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerGateRouteContext,
): Promise<Response | null> {
  if (path.includes("/etrade/") && !path.includes("/etrade/options/")) {
    const read = await readTenantBrokerSelection(ctx.env);
    if (read.status === "store_unavailable") {
      return brokerStoreUnavailableResponse();
    }
    if (read.status === "unconfigured") {
      // Issue #4431 (S5/N3): no selection stored, so the gate
      // refuses with 409 NO_BROKER_CONFIGURED instead of passing
      // the request through to the E*TRADE surface. The #3460
      // S0–S12 menu is the boundary for the rest of that
      // programme; this refusal is this slice's scope.
      return noBrokerConfiguredResponse();
    }
    if (read.brokerId !== "etrade") {
      return brokerUnavailableResponse(read.brokerId);
    }
  }
  return null;
}
