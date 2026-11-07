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
 * tenant still passes through to the E*TRADE surface — the S7
 * menu makes selection explicit and retires that default.
 * Returns null for every non-gated path, and the orchestrator
 * continues its sequential matching.
 */
import type { Env } from "../../types";
import {
  brokerUnavailableResponse,
  brokerStoreUnavailableResponse,
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
      // Issue #3460 slice 3 boundary: no selection stored yet, so the
      // E*TRADE surface serves as before. The S7 menu retires this
      // default by making selection explicit; the gate never invents
      // a broker, it only passes the request through.
      return null;
    }
    if (read.brokerId !== "etrade") {
      return brokerUnavailableResponse(read.brokerId);
    }
  }
  return null;
}
