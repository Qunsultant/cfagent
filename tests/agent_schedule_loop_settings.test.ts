import { describe, expect, it } from "vitest";
import {
  AGENT_SCHEDULE_LOOP_SETTINGS_KEY,
  resolveAgentScheduleLoopSettings,
} from "../src/services/agentScheduleLoopSettings";

describe("agentic-loop owner settings", () => {
  it("resolves configured bounds and kill-switch state from the stored layer", () => {
    const raw = JSON.stringify({
      enabled: true,
      maxTurns: 4,
      maxDurationMs: 30_000,
      maxModelTokens: 2_000,
    });
    const result = resolveAgentScheduleLoopSettings(
      (key) => (key === AGENT_SCHEDULE_LOOP_SETTINGS_KEY ? raw : null),
    );
    expect(result).toEqual({
      settings: {
        enabled: true,
        maxTurns: 4,
        maxDurationMs: 30_000,
        maxModelTokens: 2_000,
      },
      issues: [],
    });
  });

  it("fails closed when settings are absent or malformed", () => {
    const absent = resolveAgentScheduleLoopSettings(() => null);
    const malformed = resolveAgentScheduleLoopSettings((key) =>
      key === AGENT_SCHEDULE_LOOP_SETTINGS_KEY
        ? JSON.stringify({
            enabled: true,
            maxTurns: 0,
            maxDurationMs: 30_000,
            maxModelTokens: 2_000,
          })
        : null,
    );
    expect(absent.settings).toBeNull();
    expect(malformed.settings).toBeNull();
    expect(malformed.issues).not.toHaveLength(0);
  });
});
