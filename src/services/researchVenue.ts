/**
 * Issue #6036 — one venue resolver for every OODA research dispatch.
 *
 * Before this module the venue was resolved inside the provider: the
 * broker id was cast to `TradingPlatformId` unchecked, the mode was a
 * free string compared to one literal (`mode === "live"`, otherwise
 * paper), and the pair was never checked against the catalogue — so
 * `public` + `paper` was accepted even though that broker declares
 * `paperMode: false`, and a misspelt mode (`"Live"`, `"PROD"`, `" live "`)
 * silently ran paper while the run recorded the requested string.
 *
 * One resolver, used by every dispatch path (route, tick rider, MCP,
 * webhook), decides the run's venue:
 *
 *   resolveResearchVenue({ brokerId, mode }) →
 *     { brokerId, mode, modeSource } | throws ResearchVenueRefusal
 *
 * - `mode` is normalised (trim + lower-case) and must be `paper` or
 *   `live`; anything else refuses by name with the accepted set.
 * - The pair must exist in the catalogue (`paperMode`), so
 *   `public` + `paper` refuses naming the flag.
 * - An unknown broker refuses (never a silent fallback to another broker, #3460).
 * - There is no inline default: an unset broker/mode inherits the
 *   tenant binding default and says so in `modeSource`.
 *
 * No new registry, no new config store: `brokerCatalog`,
 * `DEFAULT_TENANT_PROVIDERS` and the existing coded-refusal convention.
 */
import {
  brokerHasPaperMode,
  isBrokerId,
  ROUTED_BROKER_IDS,
  type BrokerId,
} from "../trading";
import { DEFAULT_TENANT_PROVIDERS } from "../data/commercialPorts";

/** The accepted trade modes for a research run. One exported set, not two literals. */
export const RESEARCH_VENUE_MODES = ["paper", "live"] as const;
export type ResearchVenueMode = (typeof RESEARCH_VENUE_MODES)[number];

/** How the resolved mode came about — recorded beside the run. */
export type ResearchVenueModeSource = "explicit" | "inherited";

export interface ResearchVenue {
  brokerId: BrokerId;
  mode: ResearchVenueMode;
  modeSource: ResearchVenueModeSource;
}

export interface ResearchVenueInput {
  /** The caller's requested broker, if any. */
  brokerId?: string | null;
  /** The caller's requested mode, if any. */
  mode?: string | null;
}

/** Coded refusals — each names the requested pair and the accepted set. */
export type ResearchVenueRefusalCode =
  | "research_venue_mode_invalid"
  | "research_venue_pair_unsupported"
  | "research_venue_broker_unknown";

export class ResearchVenueRefusal extends Error {
  constructor(
    readonly code: ResearchVenueRefusalCode,
    message: string,
    readonly requested: { brokerId: string; mode: string },
  ) {
    super(message);
    this.name = "ResearchVenueRefusal";
  }
}

/**
 * Normalise a requested mode: trim + lower-case, then require membership
 * of the accepted set. `undefined` / empty means "not requested".
 */
export function normalizeResearchVenueMode(
  raw: string | null | undefined,
): ResearchVenueMode | undefined {
  if (raw == null) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return (RESEARCH_VENUE_MODES as readonly string[]).includes(normalized)
    ? (normalized as ResearchVenueMode)
    : undefined;
}

/**
 * Resolve the run's venue, or refuse by name. Total: every accepted
 * input yields a pair the provider can execute, and every rejected input
 * throws a `ResearchVenueRefusal` — never a guess, never a default that
 * the caller did not choose.
 */
export function resolveResearchVenue(input: ResearchVenueInput = {}): ResearchVenue {
  const requestedBroker = input.brokerId?.trim() ?? "";
  const requestedMode = input.mode?.trim() ?? "";

  const brokerCandidate = requestedBroker.length > 0 ? requestedBroker.toLowerCase() : undefined;
  const defaultBroker = DEFAULT_TENANT_PROVIDERS.brokerId;
  const brokerId = brokerCandidate ?? defaultBroker;
  const modeCandidate = normalizeResearchVenueMode(requestedMode);
  const effectiveMode = modeCandidate ?? "paper";

  const requested = { brokerId: requestedBroker || defaultBroker, mode: requestedMode || effectiveMode };

  if (brokerCandidate !== undefined && !isBrokerId(brokerCandidate)) {
    throw new ResearchVenueRefusal(
      "research_venue_broker_unknown",
      `[research_venue_broker_unknown] unknown broker "${requestedBroker}": registered brokers are ${ROUTED_BROKER_IDS.join(
        ", ",
      )}. An unregistered broker is refused, never substituted.`,
      requested,
    );
  }
  if (!isBrokerId(brokerId)) {
    throw new ResearchVenueRefusal(
      "research_venue_broker_unknown",
      `[research_venue_broker_unknown] the tenant's default broker "${brokerId}" is not in the catalogue.`,
      requested,
    );
  }
  if (requestedMode.length > 0 && modeCandidate === undefined) {
    throw new ResearchVenueRefusal(
      "research_venue_mode_invalid",
      `[research_venue_mode_invalid] mode "${requestedMode}" is not accepted: use one of ${RESEARCH_VENUE_MODES.join(
        ", ",
      )}.`,
      requested,
    );
  }
  if (effectiveMode === "paper" && !brokerHasPaperMode(brokerId)) {
    throw new ResearchVenueRefusal(
      "research_venue_pair_unsupported",
      `[research_venue_pair_unsupported] ${brokerId} declares paperMode: false — it has no simulated account, so the pair ${brokerId}+paper is refused rather than quoted as if supported.`,
      requested,
    );
  }

  return {
    brokerId,
    mode: effectiveMode,
    modeSource: modeCandidate === undefined ? "inherited" : "explicit",
  };
}

/** True when `error` is a venue refusal (route boundaries narrow with this). */
export function isResearchVenueRefusal(error: unknown): error is ResearchVenueRefusal {
  return error instanceof ResearchVenueRefusal;
}
