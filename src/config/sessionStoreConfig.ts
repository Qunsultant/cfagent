/**
 * SessionStore settings — the single source of truth (#6191).
 *
 * Every value the SessionStore (Durable Object) enforces lives in
 * `config/sessionstore.json`; no module hardcodes a SessionStore
 * tuning. Change the JSON to change behavior, then update the pins
 * in the tests that quote the value. Follows the #5880 precedent
 * (`src/config/jobCatalogue.ts`) and the `config/session-limits.json`
 * pattern: the file lives in config, this module validates it on
 * every read, and an invalid value fails closed to its documented
 * default with a NAMED error (never to an open grant, never silent).
 *
 * Settings (defaults = the values hardcoded before #6191):
 * - `audit.liveMax` (2000): hard ceiling for the live audit segment.
 *   A client may request SMALLER caps but never larger ones — the
 *   bound is enforcement, not a caller preference.
 * - `audit.segmentSize` (2000): hard ceiling for one archive segment.
 * - `audit.maxSegments` (10): hard ceiling for the archive segment count.
 * - `schemaVersion` (1): the kv_store schema generation marker
 *   (ADR 0022 D-A.4). Discipline, unchanged by externalizing it:
 *   bump ONLY alongside a kv_store schema change under
 *   runDoSchemaMigration — the config key moves the value, it does
 *   not relax the discipline.
 * - `genesis.oneTime` (false): whether genesis is global-once (true,
 *   the pre-#6191 behaviour: one marker per tenant, the first
 *   platform-listed identity wins and every later one is refused)
 *   or per-identity (false, the default: each platform-listed
 *   identity claims its own marker, and a revoked-then-relisted
 *   identity can claim again). An operator overrides it by changing
 *   config and redeploying — no code change.
 *
 * NOT in this file (named so nothing is left unaccounted for):
 * - Session TTLs/expiry durations: already externalized in
 *   `config/session-limits.json` (`SESSION_LIMITS`). The DO honours
 *   the ttl its client sends; it holds no TTL default.
 * - Field-length limits (`MAX_FIELD_LENGTH = 512`): an IAAA
 *   input-validation constant, not a SessionStore setting — the DO
 *   has no field-length check. Consolidating it is a separate slice.
 * - Policy (enforcement, not tuning): the audit-append/list
 *   namespace+key restriction, the list restriction, the `consume`
 *   replay guard, the expired-read delete. These stay as code.
 */
import raw from "../../config/sessionstore.json";

export interface SessionStoreConfig {
  /** Hard ceilings for the audit bound (see module doc). */
  audit: {
    liveMax: number;
    segmentSize: number;
    maxSegments: number;
  };
  /** kv_store schema generation marker (ADR 0022 D-A.4). */
  schemaVersion: number;
  /** Genesis mode. */
  genesis: {
    /** true = global-once (legacy); false = per-identity (default). */
    oneTime: boolean;
  };
}

export const SESSION_STORE_CONFIG_DEFAULTS: SessionStoreConfig = {
  audit: { liveMax: 2000, segmentSize: 2000, maxSegments: 10 },
  schemaVersion: 1,
  genesis: { oneTime: false },
};

const KNOWN_TOP_LEVEL_KEYS = ["audit", "schemaVersion", "genesis"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePositiveInteger(
  value: unknown,
  key: string,
  fallback: number,
  errors: string[],
): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  errors.push(
    `sessionstore.config.invalid: ${key} must be a positive integer (got ${JSON.stringify(value)}); using default ${fallback}`,
  );
  return fallback;
}

/**
 * Pure resolution of a SessionStore config value. Unknown keys are
 * named errors (never silently accepted); every invalid value fails
 * closed to its documented default with a named error.
 */
export function resolveSessionStoreConfig(raw: unknown): {
  config: SessionStoreConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const config: SessionStoreConfig = {
    audit: { ...SESSION_STORE_CONFIG_DEFAULTS.audit },
    schemaVersion: SESSION_STORE_CONFIG_DEFAULTS.schemaVersion,
    genesis: { ...SESSION_STORE_CONFIG_DEFAULTS.genesis },
  };
  if (raw === undefined) return { config, errors };
  if (!isRecord(raw)) {
    errors.push(
      "sessionstore.config.invalid: sessionstore config must be an object; using all defaults",
    );
    return { config, errors };
  }
  for (const key of Object.keys(raw)) {
    if (!(KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      errors.push(
        `sessionstore.config.invalid: unknown sessionstore setting '${key}'; ignoring it`,
      );
    }
  }
  const audit = raw["audit"];
  if (audit !== undefined) {
    if (!isRecord(audit)) {
      errors.push(
        "sessionstore.config.invalid: audit must be an object; using audit defaults",
      );
    } else {
      if (audit["liveMax"] !== undefined) {
        config.audit.liveMax = resolvePositiveInteger(
          audit["liveMax"],
          "audit.liveMax",
          SESSION_STORE_CONFIG_DEFAULTS.audit.liveMax,
          errors,
        );
      }
      if (audit["segmentSize"] !== undefined) {
        config.audit.segmentSize = resolvePositiveInteger(
          audit["segmentSize"],
          "audit.segmentSize",
          SESSION_STORE_CONFIG_DEFAULTS.audit.segmentSize,
          errors,
        );
      }
      if (audit["maxSegments"] !== undefined) {
        config.audit.maxSegments = resolvePositiveInteger(
          audit["maxSegments"],
          "audit.maxSegments",
          SESSION_STORE_CONFIG_DEFAULTS.audit.maxSegments,
          errors,
        );
      }
    }
  }
  if (raw["schemaVersion"] !== undefined) {
    config.schemaVersion = resolvePositiveInteger(
      raw["schemaVersion"],
      "schemaVersion",
      SESSION_STORE_CONFIG_DEFAULTS.schemaVersion,
      errors,
    );
  }
  const genesis = raw["genesis"];
  if (genesis !== undefined) {
    if (!isRecord(genesis)) {
      errors.push(
        "sessionstore.config.invalid: genesis must be an object; using genesis defaults",
      );
    } else if (genesis["oneTime"] !== undefined) {
      if (typeof genesis["oneTime"] === "boolean") {
        config.genesis.oneTime = genesis["oneTime"];
      } else {
        errors.push(
          `sessionstore.config.invalid: genesis.oneTime must be a boolean (got ${JSON.stringify(genesis["oneTime"])}); using default false (per-identity)`,
        );
      }
    }
  }
  return { config, errors };
}

const resolved = resolveSessionStoreConfig(raw);

/** The resolved SessionStore config (bundled config/sessionstore.json). */
export const SESSION_STORE_CONFIG: SessionStoreConfig = resolved.config;

/** Named errors from resolving the bundled config (empty when valid). */
export const SESSION_STORE_CONFIG_ERRORS: string[] = resolved.errors;
