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
 *   GET /broker/status
 *   GET /broker/quote?symbol=…
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
const STATUS_FAILED_CODE = "BROKER_STATUS_FAILED";
const QUOTE_FAILED_CODE = "BROKER_QUOTE_FAILED";
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
  const wantsStatus = path.endsWith("/broker/status");
  const wantsQuote = path.endsWith("/broker/quote");
  if (!wantsAccounts && !wantsPositions && !wantsStatus && !wantsQuote) return null;
  if (request.method !== "GET") return null;

  // Flag first: a disabled surface must not touch the broker at all.
  if (!(await isFeatureEnabled(ctx.env, BROKER_PANEL_CONTRACT_FLAG))) {
    return featureDisabledResponse();
  }

  const broker = await resolveTenantBroker(ctx.env);
  const userLogin = request.headers.get("x-user-login") || "";
  const readSetting = (key: string) => ctx.readSettingRaw(key) ?? null;
  const environment = resolveBrokerEnvironmentFromSettings(readSetting, ctx.env);

  // Status and quote do not share the accounts/positions capability gate.
  if (wantsAccounts || wantsPositions) {
    const operation = wantsAccounts ? "accounts" : "positions";
    if (!brokerSupports(broker, operation)) {
      return unsupportedResponse(broker, wantsAccounts ? "Accounts" : "Positions");
    }
  }

  // Issue #3293: validate the quote request before constructing the broker,
  // so a refusal never instantiates a platform it cannot use.
  let quoteSymbol = "";
  if (wantsQuote) {
    quoteSymbol = String(url.searchParams.get("symbol") ?? "").trim().toUpperCase();
    if (!quoteSymbol) {
      return Response.json({ code: "invalid_request", message: "symbol is required." }, { status: 400 });
    }
    if (!brokerSupports(broker, "quote")) {
      return unsupportedResponse(broker, "Quotes");
    }
  }

  const platform = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, environment);

  if (wantsAccounts) {
    if (typeof platform.getAccounts !== "function") {
      return unsupportedResponse(broker, "Accounts");
    }
    const result = await platform.getAccounts();
    return Response.json({ broker, environment, result });
  }

  if (wantsPositions) {
    if (typeof platform.getPositions !== "function") {
      return unsupportedResponse(broker, "Positions");
    }
    const result = await platform.getPositions();
    return Response.json({ broker, environment, result });
  }

  // Shared by the two reads below; placed after the position branch so the
  // route inventory keeps its file order (accounts, positions, status, quote).
  if (wantsStatus) {
    try {
      const status = await platform.getStatus();
      return Response.json({ broker, environment, status });
    } catch (error) {
      const reason = (error as Error)?.message || "the status read failed";
      return Response.json(
        { code: STATUS_FAILED_CODE, broker, message: `The selected broker (${broker}) could not report its status: ${reason}.` },
        { status: 502 },
      );
    }
  }

  try {
    const quote = await platform.getQuote(quoteSymbol);
    return Response.json({ broker, environment, symbol: quoteSymbol, quote });
  } catch (error) {
    const reason = (error as Error)?.message || "the quote read failed";
    return Response.json(
      { code: QUOTE_FAILED_CODE, broker, symbol: quoteSymbol, message: `The selected broker (${broker}) could not quote ${quoteSymbol}: ${reason}.` },
      { status: 502 },
    );
  }
}
