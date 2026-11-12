/**
 * Issue #3233 slice 2 (program #3216): broker-neutral options routes.
 *
 * The options data plane existed behind the platform seam but no HTTP route
 * could reach it for a broker other than E*TRADE: `/etrade/options/*` is owned
 * by the E*TRADE options module, is excluded from the broker gate on purpose
 * ("data surfaces"), and cannot grow conditions (the #995 route inventory is
 * byte-pinned and the file sits near its 50 KB ceiling).
 *
 * So the neutral surface is additive rather than entangled:
 *
 *   GET|POST /broker/options/chains        ?symbol=…&expiryYear=…&…
 *   GET|POST /broker/options/expire-dates  ?symbol=…
 *
 * The selected broker decides which platform serves the call. A capability the
 * broker does not implement is answered with a coded 501 naming the broker —
 * never an empty list, never another broker's data, never a silent fallback.
 * The legacy /etrade/options/* paths keep working unchanged for E*TRADE.
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { TradingPlatformRegistry, brokerSupports, platformChainSource } from "../../trading";
import { getScreenerConfig } from "../../config/etapiConfig";
import { runOptionsPlainScreenViaEngine } from "../../workflows/optionsScreenEngine";
import { unauthenticatedResponse } from "./routeIdentity";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";

export interface BrokerOptionsRouteContext {
  env: Env;
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
}

/** The coded answer for "this broker cannot do that" (#3233 acceptance). */
const UNSUPPORTED_CODE = "provider_unsupported";

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

function numParam(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function handleBrokerOptionsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerOptionsRouteContext,
): Promise<Response | null> {
  const wantsChains = path.endsWith("/broker/options/chains");
  const wantsExpiries = path.endsWith("/broker/options/expire-dates");
  const wantsScreen = path.endsWith("/broker/options/screen");
  if (!wantsChains && !wantsExpiries && !wantsScreen) return null;
  if (wantsScreen && request.method !== "POST") return null;
  if (!wantsScreen && request.method !== "GET" && request.method !== "POST") return null;

  // Issue #3272: the screen resolves its own broker/environment and takes a
  // filter document, so it cannot share the single-symbol path below. The
  // screener receives an OptionChainSource, so any broker with an options
  // data plane screens on its own chains - no broker client reaches it.
  if (wantsScreen) {
    const screenBody = ((await request.json().catch(() => ({}))) as any) ?? {};
    const screenBroker = await resolveTenantBroker(ctx.env);
    const screenSettings = (key: string) => ctx.readSettingRaw(key) ?? null;
    const screenEnvironment = resolveBrokerEnvironmentFromSettings(screenSettings, ctx.env);

    if (!brokerSupports(screenBroker, "optionChains")) {
      return unsupportedResponse(screenBroker, "Option screening");
    }
    // Issue #4068: a screen that now writes a run record needs an owner —
    // fail closed with a 401 when the login header is absent, matching the
    // manual route's discipline (routeIdentity.ts: no fallback identity).
    const screenUserLogin = request.headers.get("x-user-login") || "";
    if (!screenUserLogin) {
      return unauthenticatedResponse();
    }
    const screenPlatform = TradingPlatformRegistry.getPlatform(
      screenBroker,
      ctx.env,
      ctx.getOrm(),
      screenUserLogin,
      screenEnvironment,
    );
    const source = platformChainSource(screenPlatform);
    if (!source) return unsupportedResponse(screenBroker, "Option screening");

    // Issue #4068: the broker screen runs through the one engine-routed
    // plain screen (runOptionsPlainScreenViaEngine) instead of the direct
    // screenOptionsWithSourceRetired4068 call — same screen computation, same result.
    const result = await runOptionsPlainScreenViaEngine(source, screenBody.filter ?? screenBody, screenUserLogin, getScreenerConfig(ctx.env));
    return Response.json({ broker: screenBroker, environment: screenEnvironment, result });
  }

  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
  const query = (key: string) => (body?.[key] !== undefined ? body[key] : url.searchParams.get(key));

  const symbol = String(query("symbol") ?? "").trim().toUpperCase();
  if (!symbol) {
    return Response.json(
      { code: "invalid_request", message: "symbol is required." },
      { status: 400 },
    );
  }

  const broker = await resolveTenantBroker(ctx.env);
  const userLogin = request.headers.get("x-user-login") || "";
  const readSetting = (key: string) => ctx.readSettingRaw(key) ?? null;
  const environment = resolveBrokerEnvironmentFromSettings(readSetting, ctx.env);

  if (wantsChains && !brokerSupports(broker, "optionChains")) {
    return unsupportedResponse(broker, "Option chains");
  }
  if (wantsExpiries && !brokerSupports(broker, "optionExpireDates")) {
    return unsupportedResponse(broker, "Option expiry dates");
  }

  const platform = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, environment);

  if (wantsExpiries) {
    if (typeof platform.getOptionExpireDates !== "function") {
      return unsupportedResponse(broker, "Option expiry dates");
    }
    const expiryType = query("expiryType");
    const dates = await platform.getOptionExpireDates(
      symbol,
      typeof expiryType === "string" && expiryType.trim() ? expiryType : undefined,
    );
    return Response.json({ broker, environment, symbol, dates });
  }

  if (typeof platform.getOptionChains !== "function") {
    return unsupportedResponse(broker, "Option chains");
  }
  const chainTypeRaw = String(query("chainType") ?? "").toUpperCase();
  const chainType =
    chainTypeRaw === "CALL" || chainTypeRaw === "PUT" || chainTypeRaw === "CALLPUT"
      ? (chainTypeRaw as "CALL" | "PUT" | "CALLPUT")
      : undefined;
  const chain = await platform.getOptionChains({
    symbol,
    expiryYear: numParam(query("expiryYear")),
    expiryMonth: numParam(query("expiryMonth")),
    expiryDay: numParam(query("expiryDay")),
    strikePrice: numParam(query("strikePrice")),
    noOfStrikes: numParam(query("noOfStrikes")),
    chainType,
  });

  if (!chain) {
    // Explicit absence, not an empty success: the broker answered and had
    // nothing quotable for this selection.
    return Response.json({
      broker,
      environment,
      symbol,
      chain: null,
      message: `${broker} returned no quotable contracts for this selection.`,
    });
  }
  return Response.json({ broker, environment, symbol, chain });
}
