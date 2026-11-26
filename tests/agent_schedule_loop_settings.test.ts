import { describe, expect, it } from "vitest";
import {
  AGENT_SCHEDULE_LOOP_SETTINGS_ENTRY,
  AGENT_SCHEDULE_LOOP_SETTINGS_KEY,
} from "../src/services/agentScheduleLoopSettings";
import { resolveAgentConfig } from "../src/services/agentConfigResolver";

describe("agentic-loop owner settings", () => {
  it("resolves configured bounds and kill-switch state from the stored layer", () => {
    const raw = JSON.stringify({
      enabled: true,
      maxTurns: 4,
      maxDurationMs: 30_000,
      maxModelTokens: 2_000,
    });
    const result = resolveAgentConfig(
      AGENT_SCHEDULE_LOOP_SETTINGS_ENTRY,
      { className: "ScheduledAgent" },
      {
        readSettingRaw: (key) =>
          key === AGENT_SCHEDULE_LOOP_SETTINGS_KEY ? raw : null,
      },
    );
    expect(result.value).toEqual({
      enabled: true,
      maxTurns: 4,
      maxDurationMs: 30_000,
      maxModelTokens: 2_000,
    });
    expect(result.issues).toEqual([]);
  });

  it("fails closed when settings are absent or malformed", () => {
    const identity = { className: "ScheduledAgent" };
    const absent = resolveAgentConfig(AGENT_SCHEDULE_LOOP_SETTINGS_ENTRY, identity, {
      readSettingRaw: () => null,
    });
    const malformed = resolveAgentConfig(
      AGENT_SCHEDULE_LOOP_SETTINGS_ENTRY,
      identity,
      {
        readSettingRaw: (key) =>
          key === AGENT_SCHEDULE_LOOP_SETTINGS_KEY
            ? JSON.stringify({
                enabled: true,
                maxTurns: 0,
                maxDurationMs: 30_000,
                maxModelTokens: 2_000,
              })
            : null,
      },
    );
    expect(absent.value).toBeNull();
    expect(malformed.value).toBeNull();
    expect(malformed.issues).not.toHaveLength(0);
  });
});
