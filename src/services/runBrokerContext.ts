/**
 * Issue #5188 â€” the run's broker context: broker, mode, account, and where the
 * selection came from, resolved ONCE per dispatch.
 *
 * Why this exists: a broker is a property of the RUN, not of the job. Before
 * this module, "which broker" was answered in four places (a literal in the
 * options firer, `resolveTenantBroker` in the chain path, the environment in
 * the mode resolver, and nowhere at all for the account), so a stage could
 * execute under a different broker than the surface showed â€” and the run
 * record could not prove which one it was. Incident #5181 is the visible
 * failure of that split (programme #5187).
 *
 * Contract:
 *   - resolved from (1) the caller's explicit selection, (2) the schedule's
 *     stored selection, (3) the tenant's broker â€” in that order, never a
 *     literal, never a second default;
 *   - mode is resolved for the chosen broker, with its source recorded, and
 *     is never guessed: an unresolvable mode fails closed;
 *   - a job that needs a capability the broker does not declare is refused
 *     here, by name, before any stage runs;
 *   - `accountId` is null when the broker exposes one account implicitly;
 *     slices #5189/#5190 are what let a surface pass one.
 *
 * Lives in `services/` rather than `trading/` on purpose: it reads the tenant
 * and schedule layers, and keeping it out of the barrel avoids the
 * `tenantProviders` â†” trading cycle that `channelBroker.ts` documents.
 */
import type { Env } from "../types";
import { BROKER_CATALOG, isBrokerId, type BrokerId } from "../trading";
import { codedMessage } from "../outcomes/outcomeAspects";
import { resolveTenantBroker } from "./tenantProviders";
import { resolveScheduledEffectiveMode, type EffectiveModeSource } from "./scheduledEffectiveMode";

/** A capability flag the catalogue declares per broker (e.g. `optionChains`). */
export type BrokerCapability = keyof (typeof BROKER_CATALOG)[BrokerId]["supports"];

/** What a surface may pass in; every field is optional. */
export interface RunBrokerSelection {
  /** Explicit broker (caller or schedule). An unknown id is ignored, not guessed. */
  readonly brokerId?: unknown;
  /** Explicit mode; when absent the broker's effective mode is resolved. */
  readonly mode?: unknown;
  /** Broker account the run is scoped to, when the broker exposes several. */
  readonly accountId?: unknown;
  /**
   * Who supplied the broker: the caller, or the stored schedule.
   * "tenant" is the third source, claimed by the one shared
   * resolution (#6151): it passes the cached tenant broker as
   * the selection so the broker store is read once per session.
   * The derivation below already produced "tenant" for a
   * store-resolved broker; this makes the claim type-legal.
   */
  readonly source?: "caller" | "schedule" | "tenant";
}

/** The resolved context â€” the only thing later stages should read. */
export interface RunBrokerContext {
  readonly brokerId: BrokerId;
  readonly mode: "live" | "paper";
  readonly modeSource: EffectiveModeSource;
  readonly accountId: string | null;
  readonly source: "caller" | "schedule" | "tenant";
}

export interface ResolveRunBrokerContextInput {
  readonly env: Env;
  /** The schedule's environment (TEST/PROD) used for mode inference. */
  readonly environment?: string;
  readonly selection?: RunBrokerSelection;
  /** When set, the broker must declare this capability or the run is refused. */
  readonly requireCapability?: BrokerCapability;
}

function asMode(value: unknown): "live" | "paper" | null {
  return value === "live" || value === "paper" ? value : null;
}

function asAccount(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve the run's broker context. Total over the three sources, fail-closed
 * on anything it cannot name.
 */
export async function resolveRunBrokerContext(input: ResolveRunBrokerContextInput): Promise<RunBrokerContext> {
  const selection = input.selection ?? {};
  const explicitBroker = isBrokerId(selection.brokerId) ? selection.brokerId : null;
  const brokerId = explicitBroker ?? (await resolveTenantBroker(input.env));
  const source: RunBrokerContext["source"] = explicitBroker ? selection.source ?? "caller" : "tenant";

  const explicitMode = asMode(selection.mode);
  let mode = explicitMode;
  let modeSource: EffectiveModeSource = "selection";
  if (!mode) {
    const effective = await resolveScheduledEffectiveMode({
      env: input.env,
      brokerId,
      environment: input.environment,
    });
    if (!effective) {
      throw new Error(
        codedMessage(
          "FAILURE_BROKER_UNAVAILABLE",
          `the trading mode for ${brokerId} could not be resolved (environment: ${input.environment ?? "unset"}); the run was not started`,
        ),
      );
    }
    mode = effective.mode;
    modeSource = effective.modeSource;
  }

  if (input.requireCapability) {
    const declared = BROKER_CATALOG[brokerId]?.supports?.[input.requireCapability];
    if (declared !== true) {
      throw new Error(
        codedMessage(
          "FAILURE_BROKER_UNAVAILABLE",
          `${brokerId} does not declare ${input.requireCapability}; choose a broker that does`,
        ),
      );
    }
  }

  return {
    brokerId,
    mode,
    modeSource,
    accountId: asAccount(selection.accountId),
    source,
  };
}
