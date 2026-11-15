/**
 * Issue #3960 — resolve the chain source from a run's broker
 * stage input, in the residency.
 *
 * The chain-source seam (`chainSourceFor`) hands the stored
 * request here; the factory decodes the run's (broker, mode)
 * descriptor and resolves the source per invocation, through the
 * trading platform registry — the existing broker-neutral seam —
 * adapting the platform through `platformChainSource`. The mode
 * rides the resolution as the environment token the platform
 * constructors accept, so each invocation fetches through the
 * broker AND mode its own run named: two runs carrying different
 * pairs resolve independently, with no shared state anywhere in
 * this module (a pure function of env + login + request).
 *
 * Runs carrying no descriptor keep the legacy construction: the
 * direct client from env + login, exactly as the residencies
 * built it before this slice. No login yields no source, as
 * before — the chain fetch then fails honestly with the
 * screener's no-source error, never a crash.
 *
 * The resolved source carries the deployment env and the mode's
 * environment token, because the screener resolves its config
 * defaults from the source's env + overrideEnv: without them a
 * pair-carrying run would resolve config for no environment at
 * all. The platform adapter's live `lastError` getter is
 * preserved by delegation (never a spread, which would snapshot
 * it at construction): the screener reads the last error after
 * each fetch, from the same instance that made the call.
 *
 * Refusals are `stage_port_unavailable` with the reason named:
 * a platform with no options data plane, or a registry failure
 * wrapped with its underlying message. A malformed descriptor
 * refuses earlier, at the resolving step's decode, with
 * `stage_request_unrecognized`. Credential absence is NOT a
 * refusal here: it surfaces at the first chain fetch through
 * the platform's own error, exactly as the legacy path behaves.
 * No logging: the error carries the reason, and the engine
 * records it on the step.
 *
 * Server-only: the two residencies' wirings import this module
 * and bind it as `chainSourceFor`; the shared rebuild receives
 * the resolved source, never the factory (the #4066 discipline,
 * same as `./universeDepsResidency` and
 * `./manualOptionsResidency`).
 */
import {
  ETradeRestClient,
  TradingPlatformRegistry,
  platformChainSource,
  type BrokerId,
  type ITradingPlatform,
  type OptionChainSource,
  type TradingEnvironment,
  type TradingType,
} from "../trading";
import type { Env } from "../types";
import {
  decodeBrokerStageInput,
  OptionsStepPortsError,
} from "./optionsStepPorts";

/** Resolve one broker's platform for one login + environment token. */
export type BrokerChainSourceResolver = (
  broker: BrokerId,
  env: Env,
  userLogin: string,
  overrideEnv: TradingEnvironment,
) => ITradingPlatform;

export interface ResolveChainSourceOpts {
  /** Injected platform resolver (tests); omitted, the trading platform registry. */
  resolvePlatform?: BrokerChainSourceResolver;
}

/**
 * The environment token a mode selects. The inverse of the
 * catalog's per-broker mapping (TEST resolves to paper, PROD to
 * live, for every broker): both brokers' environment resolvers
 * accept these tokens, and each platform interprets its token
 * through its own catalog entry.
 */
function overrideEnvForMode(mode: TradingType): TradingEnvironment {
  return mode === "live" ? "PROD" : "TEST";
}

/**
 * Resolve the chain source for one invocation. The descriptor is
 * decoded from the stored request (malformed input refuses by
 * name, with the run named); absent, the legacy direct client.
 */
export function resolveChainSourceForRequest(
  env: Env,
  args: { userLogin?: string; request: unknown; runId: string },
  opts: ResolveChainSourceOpts = {},
): OptionChainSource | undefined {
  const { userLogin, request, runId } = args;
  if (!userLogin) return undefined;
  const brokerInput = decodeBrokerStageInput(request, runId);
  if (!brokerInput) {
    return new ETradeRestClient(env, userLogin);
  }
  const overrideEnv = overrideEnvForMode(brokerInput.mode);
  const resolvePlatform =
    opts.resolvePlatform ??
    ((broker: BrokerId, resolveEnv: Env, login: string, token: TradingEnvironment) =>
      TradingPlatformRegistry.getPlatform(broker, resolveEnv, undefined, login, token));
  let adapted: OptionChainSource | null;
  try {
    adapted = platformChainSource(
      resolvePlatform(brokerInput.broker, env, userLogin, overrideEnv),
    );
  } catch (err) {
    if (err instanceof OptionsStepPortsError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${runId}: the chain source for broker "${brokerInput.broker}" in ${brokerInput.mode} mode could not be resolved — ${reason}`,
    );
  }
  if (!adapted) {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${runId}: broker "${brokerInput.broker}" in ${brokerInput.mode} mode serves no option chains in this residency — its platform exposes no options data plane; re-dispatch with a broker whose platform serves chains`,
    );
  }
  return {
    getOptionChains: adapted.getOptionChains,
    getOptionExpireDates: adapted.getOptionExpireDates,
    supportsOptionRequestBudget: adapted.supportsOptionRequestBudget,
    get lastError() {
      return adapted.lastError;
    },
    env,
    overrideEnv,
  };
}
