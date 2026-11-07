/**
 * Issue #291 — TradingAgent configuration.
 *
 * The TradingAgent is provider-neutral and service-modular (owner
 * directive, 2026-10-22: configurable, pluggable, extensible, flexible).
 * Everything an operator may vary lives here as typed config with env
 * overrides — never as constants buried in the agent:
 *
 * - `enabledProviders`: provider ids the agent may resolve. A provider is
 *   usable only if it is BOTH registered in TradingPlatformRegistry AND
 *   enabled here. Onboarding a broker = register its platform + list its
 *   id here (or in TRADING_AGENT_PROVIDERS).
 * - `defaultProvider`: used when a call names no provider.
 * - `enabledServices`: the service ids (see the service registry in
 *   src/agents/trading-agent.ts) exposed through the agent's tools and
 *   A2A operations. Disabling a service removes it from every surface at
 *   once, because both are generated from the same registry + this config.
 *
 * Env overrides (comma-separated lists):
 * - TRADING_AGENT_PROVIDERS="etrade,alpaca"
 * - TRADING_AGENT_DEFAULT_PROVIDER="etrade"
 * - TRADING_AGENT_SERVICES="stock_screening,options_screening"
 */

/** Every service id the TradingAgent can offer. */
export const TRADING_AGENT_SERVICE_IDS = [
  "stock_screening",
  "options_screening",
  "stock_trading",
  "options_trading",
] as const;

export type TradingAgentServiceId = (typeof TRADING_AGENT_SERVICE_IDS)[number];

export interface TradingAgentConfig {
  enabledProviders: string[];
  defaultProvider: string;
  enabledServices: TradingAgentServiceId[];
}

export const TRADING_AGENT_CONFIG_BASELINE: TradingAgentConfig = {
  enabledProviders: ["etrade", "alpaca"],
  defaultProvider: "etrade",
  enabledServices: [...TRADING_AGENT_SERVICE_IDS],
};

function parseList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function isServiceId(value: string): value is TradingAgentServiceId {
  return (TRADING_AGENT_SERVICE_IDS as readonly string[]).includes(value);
}

/**
 * Resolve the effective config. Unknown service ids in the env override
 * are dropped (a typo must not invent a service); provider ids pass
 * through (providers are extensible — the registry is the authority on
 * whether one exists). An override that parses to an empty list falls
 * back to the baseline rather than disabling everything by accident.
 */
export function getTradingAgentConfig(
  env?: Record<string, unknown> | null,
): TradingAgentConfig {
  const e = (env ?? {}) as Record<string, unknown>;
  const providers = parseList(e.TRADING_AGENT_PROVIDERS);
  const services = parseList(e.TRADING_AGENT_SERVICES).filter(isServiceId);
  const defaultProvider =
    typeof e.TRADING_AGENT_DEFAULT_PROVIDER === "string" &&
    e.TRADING_AGENT_DEFAULT_PROVIDER.trim().length > 0
      ? e.TRADING_AGENT_DEFAULT_PROVIDER.trim().toLowerCase()
      : TRADING_AGENT_CONFIG_BASELINE.defaultProvider;
  return {
    enabledProviders:
      providers.length > 0 ? providers : [...TRADING_AGENT_CONFIG_BASELINE.enabledProviders],
    defaultProvider,
    enabledServices:
      services.length > 0 ? services : [...TRADING_AGENT_CONFIG_BASELINE.enabledServices],
  };
}

/** True when the service id is enabled in the given config. */
export function isTradingServiceEnabled(
  config: TradingAgentConfig,
  serviceId: string,
): boolean {
  return (config.enabledServices as string[]).includes(serviceId);
}
