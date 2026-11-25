/**
 * Issue #6509 — the capability names the AI/MCP surfaces steer at.
 *
 * Generic capabilities have neutral MCP tools that route through the
 * platform-selected broker. Broker-named tools remain for capabilities that
 * are genuinely one broker's own (direct execution, the Alpaca-only chain
 * read); prompts must not send a generic request to one of those.
 *
 * This module is the one map: prompts resolve through it, and the pin in
 * `tests/broker_neutral_tools_6509.test.ts` asserts every generic capability
 * has a neutral tool and that the broker-named aliases still resolve.
 */

export type BrokerGenericCapability =
  | "quote"
  | "positions"
  | "accounts"
  | "preview"
  | "orders"
  | "cancel"
  | "cancel_ticker"
  | "cancel_all";

/** Neutral MCP tool per generic capability, without the `tool_openaimp_` prefix. */
export const NEUTRAL_BROKER_TOOL_NAMES: Record<BrokerGenericCapability, string> = {
  quote: "market_data_get_quote",
  positions: "get_trading_positions",
  accounts: "get_trading_accounts",
  preview: "broker_order_preview",
  orders: "broker_orders_list",
  cancel: "broker_order_cancel",
  cancel_ticker: "broker_order_cancel_ticker",
  cancel_all: "broker_order_cancel_all",
};

/**
 * Broker-named tools whose capability is generic. Prompts translate them to
 * the neutral name above; the broker-named tool stays registered for clients
 * that already call it.
 */
export const BROKER_TOOL_TO_GENERIC_CAPABILITY: Record<string, BrokerGenericCapability> = {
  etrade_get_quote: "quote",
  alpaca_get_quote: "quote",
  public_get_quote: "quote",
  etrade_get_positions: "positions",
  alpaca_positions: "positions",
  alpaca_account: "accounts",
  public_account: "accounts",
  etrade_preview_order: "preview",
  alpaca_preview_order: "preview",
  public_preview_order: "preview",
  etrade_orders: "orders",
  alpaca_orders: "orders",
  public_orders: "orders",
  etrade_cancel_order: "cancel",
  alpaca_cancel_order: "cancel",
  alpaca_cancel_bracket_ladder: "cancel",
  alpaca_cancel_ticker: "cancel_ticker",
  public_cancel_order: "cancel",
  alpaca_cancel_all: "cancel_all",
};

/** The neutral tool for a broker-named generic tool; unknown tools pass through. */
export function neutralBrokerToolName(tool: string | null | undefined): string | null {
  if (!tool) return null;
  const capability = BROKER_TOOL_TO_GENERIC_CAPABILITY[tool];
  return capability ? NEUTRAL_BROKER_TOOL_NAMES[capability] : tool;
}

/** Prompt-facing form (`tool_openaimp_<catalog name>`). */
export function promptToolName(catalogName: string): string {
  return `tool_openaimp_${catalogName}`;
}

/** Prompt-facing neutral tool for a generic capability. */
export function neutralPromptToolName(capability: BrokerGenericCapability): string {
  return promptToolName(NEUTRAL_BROKER_TOOL_NAMES[capability]);
}
