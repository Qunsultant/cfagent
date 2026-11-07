/**
 * Screening-system feature flags (issue #1162, Phase 6 of epic #1096).
 *
 * The repo's flag idiom is `mas_settings` string keys read at the point
 * of use — the same store and fail-safe discipline as the adaptation
 * kill switch (#756, adaptationAudit.ts): safety-relevant reads fail
 * CLOSED. Concretely:
 *
 *  - Enable flags (`screening.channelsEnabled`,
 *    `screening.weightsV2Ranking`): default OFF; a read failure reads
 *    as OFF. Learned weighting stays behind this explicit switch per
 *    the #17 reviewed-config posture recorded on the
 *    /adaptation/weights route ("production consumption stays behind
 *    #17's reviewed-config rule").
 *  - Pause flag (`screening.scheduledPaused`): default not paused; a
 *    read failure reads as PAUSED — an autonomous schedule whose pause
 *    state cannot be verified does not run (kill-switch idiom).
 *  - NLQ fit discovery (`screening.nlqFitDiscovery`): an OFF-switch
 *    for an additive parser feature; default ON, only an explicit
 *    "off" disables it.
 *  - Rollout stage (`screening.rolloutStage`): internal → paper →
 *    broader. Recorded, never auto-advanced — a stage changes only
 *    through an explicit settings write (the /screening/controls
 *    route), which the activity log records with its actor.
 *
 * Readers take a `ScreeningSettingRead` function so both sql-backed
 * stores (DO SqlStorage / DatabaseORM exec) and route contexts
 * (OrchestratorAgent.readSettingRaw) drive the same code.
 *
 * Storage note (#2390, step 4g): the factories below delegate
 * to the dedicated settings port that owns mas_settings (gate
 * G-7 ruling); this module keeps the flag semantics — keys,
 * fail-safes, stage validation — and no longer issues
 * statements against the table itself.
 */

import { createSettingsPort } from "../data/createSettingsPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/screeningFlags",
});


export const SCREENING_FLAG_KEYS = {
  rolloutStage: "screening.rolloutStage",
  channelsEnabled: "screening.channelsEnabled",
  nlqFitDiscovery: "screening.nlqFitDiscovery",
  weightsV2Ranking: "screening.weightsV2Ranking",
  portfolioContext: "screening.portfolioContext",
  scheduledPaused: "screening.scheduledPaused",
} as const;

export type ScreeningSettingRead = (key: string) => string | null;
export type ScreeningSettingWrite = (key: string, value: string) => void;

export type ScreeningRolloutStage = "internal" | "paper" | "broader";
export const SCREENING_ROLLOUT_STAGES: ScreeningRolloutStage[] = [
  "internal",
  "paper",
  "broader",
];

const TRUTHY = new Set(["on", "1", "true", "yes"]);
const FALSY = new Set(["off", "0", "false", "no"]);

/**
 * The factories delegate to the dedicated settings port
 * (#2390, step 4g — the G-7 ruling): mas_settings is owned by
 * its adapter (src/data/doSqliteOrmAdapters.ts, composed via
 * createSettingsPorts). The incumbent ensure-on-every-call
 * shape is preserved through the port: each factory call runs
 * the port's ensureSchema() before the operation, exactly as
 * the retired local ensureSettingsTable did, so a read on a
 * fresh instance (no table anywhere) still returns null
 * rather than throwing. One behavioural sharpening, inherited
 * from the port: the legacy reader returned "" for a stored
 * NULL-ish value where the port returns the value or null —
 * the table's value column is NOT NULL, so no stored row can
 * distinguish the two.
 */
function settingsPortFor(sql: {
  exec: (q: string, ...a: unknown[]) => Iterable<unknown>;
}) {
  return createSettingsPort(sql);
}

/** Build a settings reader over any exec-shaped sql store (DO SqlStorage or DatabaseORM). */
export function settingReadFromSql(sql: {
  exec: (q: string, ...a: unknown[]) => Iterable<unknown>;
}): ScreeningSettingRead {
  return (key: string) => {
    const port = settingsPortFor(sql);
    port.ensureSchema();
    return port.get(key);
  };
}

/** Build a settings writer over any exec-shaped sql store (delete+insert idiom, via the port). */
export function settingWriteFromSql(sql: {
  exec: (q: string, ...a: unknown[]) => Iterable<unknown>;
}): ScreeningSettingWrite {
  return (key: string, value: string) => {
    const port = settingsPortFor(sql);
    port.ensureSchema();
    port.set(key, value);
  };
}

/** Validated settings write: the rollout stage only accepts known stages. */
export function setScreeningSetting(
  write: ScreeningSettingWrite,
  key: string,
  value: string
): void {
  if (key === SCREENING_FLAG_KEYS.rolloutStage && !isScreeningRolloutStage(value)) {
    throw new Error(
      `Invalid rollout stage "${value}" (expected one of ${SCREENING_ROLLOUT_STAGES.join(", ")}).`
    );
  }
  write(key, value);
}

export function isScreeningRolloutStage(v: unknown): v is ScreeningRolloutStage {
  return typeof v === "string" && (SCREENING_ROLLOUT_STAGES as string[]).includes(v);
}

const READ_FAILED = Symbol("screeningFlags.readFailed");

/**
 * Read one key, distinguishing the three states the fail-safes depend
 * on: a stored value, an absent key (null — the flag's default
 * applies), and a failed read (READ_FAILED — the fail-safe applies).
 */
function readSafe(
  read: ScreeningSettingRead,
  key: string
): string | null | typeof READ_FAILED {
  try {
    return read(key);
  } catch (err) {
    structuredLog.error("screeningFlags.read_failed", {
      message: `[screeningFlags] read of ${key} failed; applying the fail-safe value`,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return READ_FAILED;
  }
}

/**
 * Boolean flag read. Absent key = false (every boolean screening
 * flag's default is the inactive state). A failed read returns
 * `onError`: OFF for enable flags, ON (paused) for the pause flag.
 * An unrecognized stored value also falls back to `onError` rather
 * than guessing.
 */
function readBool(read: ScreeningSettingRead, key: string, onError: boolean): boolean {
  const raw = readSafe(read, key);
  if (raw === READ_FAILED) return onError;
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return onError;
}

/** Current rollout stage; absent/unknown/unreadable values read as the safest stage, "internal". */
export function getScreeningRolloutStage(read: ScreeningSettingRead): ScreeningRolloutStage {
  const raw = readSafe(read, SCREENING_FLAG_KEYS.rolloutStage);
  return isScreeningRolloutStage(raw) ? raw : "internal";
}

/** Push-channel delivery wiring (Slack/email/webhook) is enabled. Default OFF; read failure = OFF. */
export function isScreeningChannelsEnabled(read: ScreeningSettingRead): boolean {
  return readBool(read, SCREENING_FLAG_KEYS.channelsEnabled, false);
}

/**
 * V2 weights may influence fit-discovery ranking. Default OFF (the #17
 * reviewed-config posture); read failure = OFF.
 */
export function isWeightsV2RankingEnabled(read: ScreeningSettingRead): boolean {
  return readBool(read, SCREENING_FLAG_KEYS.weightsV2Ranking, false);
}

/**
 * Portfolio context may demote concentration-flagged names in a
 * ranking (issue #17, opt-in). Default OFF (the #17 reviewed-config
 * posture); read failure = OFF. The modifier never filters and never
 * rescores — flagged names rank below unflagged ones, nothing more.
 */
export function isPortfolioContextEnabled(read: ScreeningSettingRead): boolean {
  return readBool(read, SCREENING_FLAG_KEYS.portfolioContext, false);
}

/**
 * Scheduled autonomous screening steps are paused. Default (absent
 * key) = not paused; read failure = PAUSED (fail-closed, the
 * kill-switch idiom — a pause state that cannot be verified halts).
 */
export function isScreeningScheduledPaused(read: ScreeningSettingRead): boolean {
  return readBool(read, SCREENING_FLAG_KEYS.scheduledPaused, true);
}

/**
 * NLQ fit-discovery phrases are enabled. This is an OFF-switch for an
 * additive, honest-failing parser feature: default ON; only an explicit
 * off value disables it; an unreadable setting leaves it ON (logged).
 */
export function isNlqFitDiscoveryEnabled(read: ScreeningSettingRead): boolean {
  const raw = readSafe(read, SCREENING_FLAG_KEYS.nlqFitDiscovery);
  if (raw === READ_FAILED || raw === null) return true;
  return !FALSY.has(raw.trim().toLowerCase());
}

/** Snapshot of every screening flag, for the controls surface and the runbook checks. */
export function readScreeningControls(read: ScreeningSettingRead): {
  rolloutStage: ScreeningRolloutStage;
  channelsEnabled: boolean;
  nlqFitDiscovery: boolean;
  weightsV2Ranking: boolean;
  scheduledPaused: boolean;
} {
  return {
    rolloutStage: getScreeningRolloutStage(read),
    channelsEnabled: isScreeningChannelsEnabled(read),
    nlqFitDiscovery: isNlqFitDiscoveryEnabled(read),
    weightsV2Ranking: isWeightsV2RankingEnabled(read),
    scheduledPaused: isScreeningScheduledPaused(read),
  };
}
