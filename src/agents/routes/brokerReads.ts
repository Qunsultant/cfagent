/**
 * Issue #2853 (programme #3216, gap G2): broker-neutral account and position reads.
 *
 * The panel contract (`src/trading/brokerPanels.ts`) says which surfaces a
 * broker may render. A surface is only useful with data behind it, and until
 * this slice the only reads were `/etrade/*`: an Alpaca panel had a contract
 * and nothing to put in it.
 *
 *   GET /broker/accounts
 *   GET /broker/positions
 *
 * Same shape as the options reads (#3233): the SELECTED broker serves the
 * call, the persisted trading environment is echoed, and a capability the
 * broker does not implement is a coded 501 naming that broker — never an
 * empty list, never another broker's data.
 *
 * Gated by the `broker_panel_contract` flag (#2853): OFF wins, absent
 * inherits its parent (`options_screener`), resolved by the flag adapters.
 * A disabled surface answers `FEATURE_DISABLED` rather than silently
 * rendering an empty panel.
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { TradingPlatformRegistry, brokerSupports } from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { isFeatureEnabled } from "../../config/featureFlags";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";

/** The flag that owns this surface (#2853). */
export const BROKER_PANEL_CONTRACT_FLAG = "broker_panel_contract";

export interface BrokerReadsRouteContext {
  env: Env;
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
}

const UNSUPPORTED_CODE = "provider_unsupported";
const FEATURE_DISABLED_CODE = "FEATURE_DISABLED";

function unsupportedResponse(broker: string, capability: string): Response {
  return Response.json(
    {
      code: UNSUPPORTED_CODE,
      broker,
      message: `${capability} are not available for the selected broker (${broker}); no other broker's data is used in its place.`,
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
      message: "Broker panels are disabled by feature flag. No panel is rendered and no broker data is served.",
      retryable: false,
    },
    { status: 503 },
  );
}

export async function handleBrokerReadsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerReadsRouteContext,
): Promise<Response | null> {
  const wantsAccounts = path.endsWith("/broker/accounts");
  const wantsPositions = path.endsWith("/broker/positions");
  if (!wantsAccounts && !wantsPositions) return null;
  if (request.method !== "GET") return null;

  // Flag first: a disabled surface must not touch the broker at all.
  if (!(await isFeatureEnabled(ctx.env, BROKER_PANEL_CONTRACT_FLAG))) {
    return featureDisabledResponse();
  }

  const broker = await resolveTenantBroker(ctx.env);
  const userLogin = request.headers.get("x-user-login") || "";
  const readSetting = (key: string) => ctx.readSettingRaw(key) ?? null;
  const environment = resolveBrokerEnvironmentFromSettings(readSetting, ctx.env);

  const operation = wantsAccounts ? "accounts" : "positions";
  if (!brokerSupports(broker, operation)) {
    return unsupportedResponse(broker, wantsAccounts ? "Accounts" : "Positions");
  }

  const platform = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, environment);

  if (wantsAccounts) {
    if (typeof platform.getAccounts !== "function") {
      return unsupportedResponse(broker, "Accounts");
    }
    const result = await platform.getAccounts();
    return Response.json({ broker, environment, result });
  }

  if (typeof platform.getPositions !== "function") {
    return unsupportedResponse(broker, "Positions");
  }
  const result = await platform.getPositions();
  return Response.json({ broker, environment, result });
}
