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
const HISTORY_FAILED_CODE = "BROKER_ORDER_HISTORY_FAILED";
const ACTIVITY_FAILED_CODE = "BROKER_ACTIVITY_FAILED";
const WATCHLISTS_FAILED_CODE = "BROKER_WATCHLISTS_FAILED";
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
  // Issue #3359: account history. `/broker/orders` is the stored-draft route
  // (brokerOrders.ts); these two are reads of the BROKER's own records and are
  // deliberately distinct paths so a draft can never be mistaken for an order
  // at the venue.
  const wantsOrderHistory = path.endsWith("/broker/orders/history");
  const wantsActivity = path.endsWith("/broker/activities");
  // Issue #3434: the broker's own saved lists. Declared per broker, like every
  // other read, so a broker without them answers by name instead of an empty table.
  const wantsWatchlists = path.endsWith("/broker/watchlists");
  if (!wantsAccounts && !wantsPositions && !wantsStatus && !wantsQuote && !wantsOrderHistory && !wantsActivity && !wantsWatchlists)
    return null;
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

  // Issue #3359: history is a declared capability, like every other read.
  if (wantsOrderHistory && !brokerSupports(broker, "orderHistory")) {
    return unsupportedResponse(broker, "Order history");
  }
  if (wantsActivity && !brokerSupports(broker, "accountActivity")) {
    return unsupportedResponse(broker, "Account activity");
  }
  if (wantsWatchlists && !brokerSupports(broker, "watchlists")) {
    return unsupportedResponse(broker, "Watchlists");
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

  // Issue #3359: the broker's own order history. An unconfigured or failed read
  // is a named failure — an empty list would read as "no orders", which is a
  // different fact entirely.
  if (wantsOrderHistory) {
    if (typeof platform.getOrderHistory !== "function") {
      return unsupportedResponse(broker, "Order history");
    }
    const statusParam = String(url.searchParams.get("status") ?? "open").trim().toLowerCase();
    const status = statusParam === "closed" || statusParam === "all" ? statusParam : "open";
    try {
      const orders = await platform.getOrderHistory(status);
      return Response.json({ broker, environment, status, orders });
    } catch (error) {
      const reason = (error as Error)?.message || "the order-history read failed";
      return Response.json(
        {
          code: HISTORY_FAILED_CODE,
          broker,
          message: `The selected broker (${broker}) could not list its orders: ${reason}.`,
          retryable: true,
        },
        { status: 502 },
      );
    }
  }

  // Issue #3359: the broker's own account activity, in its own vocabulary.
  if (wantsActivity) {
    if (typeof platform.getAccountActivity !== "function") {
      return unsupportedResponse(broker, "Account activity");
    }
    const activityType = String(url.searchParams.get("type") ?? "").trim();
    try {
      const activities = await platform.getAccountActivity(activityType || undefined);
      return Response.json({ broker, environment, activities });
    } catch (error) {
      const reason = (error as Error)?.message || "the activity read failed";
      return Response.json(
        {
          code: ACTIVITY_FAILED_CODE,
          broker,
          message: `The selected broker (${broker}) could not list account activity: ${reason}.`,
          retryable: true,
        },
        { status: 502 },
      );
    }
  }

  // Issue #3434: the broker's own watchlists. A failed read is a named failure;
  // an empty array would read as "you saved nothing", which is a different fact.
  if (wantsWatchlists) {
    if (typeof platform.getWatchlists !== "function") {
      return unsupportedResponse(broker, "Watchlists");
    }
    try {
      const watchlists = await platform.getWatchlists();
      return Response.json({ broker, environment, watchlists });
    } catch (error) {
      const reason = (error as Error)?.message || "the watchlist read failed";
      return Response.json(
        {
          code: WATCHLISTS_FAILED_CODE,
          broker,
          message: `The selected broker (${broker}) could not list its watchlists: ${reason}.`,
          retryable: true,
        },
        { status: 502 },
      );
    }
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
