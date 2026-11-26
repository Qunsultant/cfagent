import {
  registerAgentConfigEntry,
  resolveAgentConfig,
  type AgentConfigIdentity,
} from "./agentConfigResolver";
import type { Env } from "../types";

export const AGENT_SCHEDULE_LOOP_SETTINGS_ENTRY = "agentScheduleLoopSettings";
export const AGENT_SCHEDULE_LOOP_SETTINGS_KEY = "agent_schedule_loop_settings";

export interface AgentScheduleLoopSettings {
  enabled: boolean;
  maxTurns: number;
  maxDurationMs: number;
  maxModelTokens: number;
}

export interface AgentScheduleLoopSettingsResolution {
  settings: AgentScheduleLoopSettings | null;
  issues: string[];
}

function parseSettings(raw: unknown): AgentScheduleLoopSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.enabled !== "boolean" ||
    !Number.isSafeInteger(value.maxTurns) ||
    (value.maxTurns as number) < 1 ||
    !Number.isSafeInteger(value.maxDurationMs) ||
    (value.maxDurationMs as number) < 1 ||
    (value.maxDurationMs as number) > 2_147_483_647 ||
    !Number.isSafeInteger(value.maxModelTokens) ||
    (value.maxModelTokens as number) < 1
  ) {
    return undefined;
  }
  return {
    enabled: value.enabled,
    maxTurns: value.maxTurns as number,
    maxDurationMs: value.maxDurationMs as number,
    maxModelTokens: value.maxModelTokens as number,
  };
}

function parseStoredSettings(raw: string | null): {
  parse:
    | { kind: "decision"; value: AgentScheduleLoopSettings; raw: string }
    | { kind: "invalid"; raw?: string }
    | { kind: "absent" };
  issues: string[];
} {
  if (raw === null) return { parse: { kind: "absent" }, issues: [] };
  try {
    const value = parseSettings(JSON.parse(raw) as unknown);
    if (value) return { parse: { kind: "decision", value, raw }, issues: [] };
  } catch {
    // The malformed value is reported below and never takes effect.
  }
  return {
    parse: { kind: "invalid", raw },
    issues: [`${AGENT_SCHEDULE_LOOP_SETTINGS_KEY}: invalid managed settings`],
  };
}

registerAgentConfigEntry<AgentScheduleLoopSettings | null>({
  id: AGENT_SCHEDULE_LOOP_SETTINGS_ENTRY,
  layers: ["stored"],
  storedKeys: (identity) =>
    identity.className === "ScheduledAgent"
      ? [AGENT_SCHEDULE_LOOP_SETTINGS_KEY]
      : [],
  parseStored: (raw) => parseStoredSettings(raw),
  codeDefault: () => null,
  formatValue: (value) => JSON.stringify(value),
  parseWriteValue: (raw) => {
    try {
      return parseSettings(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  },
  valueDomain:
    'JSON object with enabled, positive maxTurns, maxDurationMs, and maxModelTokens',
  writeStoredKey: (identity) =>
    identity.className === "ScheduledAgent"
      ? AGENT_SCHEDULE_LOOP_SETTINGS_KEY
      : null,
});

export function resolveAgentScheduleLoopSettings(
  readSettingRaw: (key: string) => string | null,
  env?: Env,
): AgentScheduleLoopSettingsResolution {
  const identity: AgentConfigIdentity = { className: "ScheduledAgent" };
  const resolution = resolveAgentConfig(
    AGENT_SCHEDULE_LOOP_SETTINGS_ENTRY,
    identity,
    { readSettingRaw, env },
  );
  return {
    settings: resolution.value as AgentScheduleLoopSettings | null,
    issues: resolution.issues,
  };
}
