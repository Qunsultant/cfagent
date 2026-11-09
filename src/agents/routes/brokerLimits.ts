/**
 * Issue #3888 — the trading-limits read and change surface.
 *
 * `GET  /api/broker/limits?symbol=AAPL` — effective values + provenance
 * `POST /api/broker/limits { key, value, symbol? }` — change one value
 *
 * The route is deliberately thin: resolution, validation and the change
 * record live in `src/trading/limits.ts`, which every engine and the
 * `trading_limits` tool also read. A change is audited here, because
 * "who raised maxNotionalPerTicker from $2,000 to $5,000, and when" is
 * the caller's context — the module only knows before/after.
 */

import type { Env } from "../../types";
import {
  TRADING_LIMIT_KEYS,
  applyTradingLimitChange,
  resolveTradingLimits,
} from "../../trading";

export interface BrokerLimitRouteContext {
  env: Partial<Env>;
  readSettingRaw(key: string): string | null;
  writeSetting?(key: string, value: string): void;
  audit?(type: string, agent: string, payload: Record<string, unknown>): void;
}

export async function handleBrokerLimitRoutes(
  request: Request,
  url: URL,
  path: string,
  ctx: BrokerLimitRouteContext,
): Promise<Response | null> {
  if (!path.endsWith("/broker/limits")) return null;

  if (request.method === "GET") {
    const symbol = url.searchParams.get("symbol");
    const snapshot = resolveTradingLimits({
      symbol,
      env: ctx.env,
      readSetting: (key) => ctx.readSettingRaw(key),
    });
    return Response.json({ brokerLimits: snapshot });
  }

  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = applyTradingLimitChange({
      key: body.key,
      value: body.value,
      symbol: body.symbol === undefined || body.symbol === null ? null : String(body.symbol),
      readSetting: (key) => ctx.readSettingRaw(key),
      writeSetting: ctx.writeSetting ? (key, value) => ctx.writeSetting!(key, value) : undefined,
    });

    if (!result.ok) {
      return Response.json(
        { code: result.code, message: result.message, accepted: TRADING_LIMIT_KEYS },
        { status: result.code === "limit_write_unavailable" ? 503 : 400 },
      );
    }

    ctx.audit?.("trading.limit_changed", "trading", {
      key: result.change.key,
      symbol: result.change.symbol,
      before: result.change.before,
      after: result.change.after,
      settingKey: result.change.settingKey,
      changedAt: result.change.changedAt,
      changedBy: request.headers.get("x-user-login") ?? null,
    });

    const snapshot = resolveTradingLimits({
      symbol: result.change.symbol,
      env: ctx.env,
      readSetting: (key) => ctx.readSettingRaw(key),
    });
    return Response.json({ change: result.change, brokerLimits: snapshot });
  }

  return Response.json({ error: "Method not allowed", allow: ["GET", "POST"] }, { status: 405 });
}
