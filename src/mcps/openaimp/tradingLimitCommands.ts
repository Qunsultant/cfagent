/**
 * Issue #3888 — the `trading_limits` tool.
 *
 * The one tool the copilot (#3889) and every order engine call to learn
 * what the platform will allow: effective values, the source of each
 * value (ticker override, setting, env, or unset), and — when given
 * `apply` — the recorded change.
 *
 * Nothing here decides a limit; it resolves `src/trading/limits.ts` over
 * the caller's own settings and reports what it found. An unset limit is
 * reported as unset, never as "unlimited".
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  TRADING_LIMIT_KEYS,
  applyTradingLimitChange,
  describeAdvancedOrderTypes,
  resolveTradingLimits,
} from "../../trading";
import { createSettingsPort } from "../../data/createSettingsPorts";
import type { SettingsPort } from "../../data/settingsReadPorts";

function settingsFor(context: McpToolContext): SettingsPort | null {
  const sql = context.orm?.getSql?.();
  if (!sql) return null;
  try {
    return createSettingsPort(sql);
  } catch {
    return null;
  }
}

export class TradingLimitsCommand implements IMcpToolCommand {
  readonly name = "trading_limits";
  readonly description =
    "Report the externalized trading limits — money budget, open-order caps, ladder rung cap, daily counters, cancel-all cap and session window — with where each value came from (ticker override, setting, env, or unset), plus the order types each broker can actually place (and why one cannot). Also applies one recorded change when given `apply`. An unset limit is reported as unset, never as unlimited.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker whose overrides apply (e.g. AAPL). Omit for the account-wide limits." },
      apply: {
        type: "object",
        properties: {
          key: { type: "string", enum: [...TRADING_LIMIT_KEYS], description: "The limit to change" },
          value: {
            type: ["number", "null"],
            description: "New value; null removes the value (which makes the operation refuse with limit_not_configured)",
          },
        },
        required: ["key"],
        description: "Apply one change to the persisted configuration (audited)",
      },
    },
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).optional().describe("Ticker whose overrides apply"),
    apply: z
      .object({
        key: z.enum(TRADING_LIMIT_KEYS as unknown as [string, ...string[]]),
        value: z.union([z.number(), z.null()]).optional(),
      })
      .optional()
      .describe("Apply one change to the persisted configuration"),
  });

  async execute(
    input: { symbol?: string; apply?: { key: string; value?: number | null } },
    context: McpToolContext,
  ) {
    const settings = settingsFor(context);
    const readSetting = (key: string) => {
      if (!settings) return null;
      try {
        return settings.get(key);
      } catch {
        return null;
      }
    };

    if (input.apply) {
      if (!settings) {
        return {
          ok: false,
          code: "limit_write_unavailable",
          message: "Trading limit changes need this session's settings store, which is unavailable; nothing changed.",
        };
      }
      try {
        settings.ensureSchema();
      } catch {
        // A store that cannot create its own table cannot persist a change either.
      }
      const result = applyTradingLimitChange({
        key: input.apply.key,
        value: input.apply.value ?? null,
        symbol: input.symbol ?? null,
        readSetting,
        writeSetting: (key, value) => settings.set(key, value),
      });
      if (!result.ok) return result;
      context.audit?.("trading.limit_changed", "trading", {
        key: result.change.key,
        symbol: result.change.symbol,
        before: result.change.before,
        after: result.change.after,
        settingKey: result.change.settingKey,
        changedAt: result.change.changedAt,
        changedBy: "trading_limits",
      });
      return {
        ok: true,
        change: result.change,
        brokerLimits: resolveTradingLimits({ symbol: input.symbol, env: context.env, readSetting }),
      };
    }

    const snapshot = resolveTradingLimits({
      symbol: input.symbol,
      env: context.env,
      readSetting,
    });
    context.audit?.("trading.limits_read", "trading", {
      symbol: snapshot.symbol,
      configured: TRADING_LIMIT_KEYS.filter((key) => snapshot.limits[key].value !== null),
    });
    // Issue #3892: the same introspection surface enumerates what each broker
    // can actually place, so “can you place a trailing stop on MSFT?” is
    // answered from the registry rather than from the prompt.
    return {
      ok: true,
      brokerLimits: snapshot,
      orderTypes: {
        alpaca: describeAdvancedOrderTypes("alpaca"),
        etrade: describeAdvancedOrderTypes("etrade"),
      },
    };
  }
}
