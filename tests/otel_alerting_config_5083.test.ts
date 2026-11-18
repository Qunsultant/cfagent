/**
 * Issue #5083 (S4, observability program #5080) — the alerting
 * settings resolution (config/otel.json `alerting` section + env).
 *
 * TDD Red first: resolveOtelAlertingSettings does not exist yet,
 * so this file fails at import.
 *
 * Resolution follows the S1/S2/S3 pattern (run > session > user >
 * env > config-file > built-in safe default). First non-blank
 * level wins; an unrecognized winning value FAILS CLOSED to the
 * safe default with a coded OBS-1001 message and no fall-through.
 *
 * Settings (all config values, externalized):
 * - enabled (master): alerting on/off. Builtin safe default OFF.
 * - slackEnabled / emailEnabled: each channel individually on/off.
 *   Builtin safe default ON (when alerting itself is on, both
 *   channels deliver — the owner decision: Slack AND email, both).
 * - maxAlertsPerDay: the free-tier guard cap. Builtin 100.
 */
import { describe, it, expect } from "vitest";
import {
  OTEL_ALERTING_SETTINGS_BUILTIN,
  OTEL_FILE_CONFIG,
  resolveOtelAlertingSettings,
  type OtelScopeLevels,
} from "../src/config/otelModes";

function levels(env: unknown, file: unknown): OtelScopeLevels {
  return { env, file };
}

describe("S4 alerting settings resolution", () => {
  it("resolves from the config file when no env is set (file defaults: on, both channels, 100/day)", () => {
    const { settings, invalid } = resolveOtelAlertingSettings({
      enabled: levels(undefined, OTEL_FILE_CONFIG.alerting.enabled),
      slackEnabled: levels(undefined, OTEL_FILE_CONFIG.alerting.slackEnabled),
      emailEnabled: levels(undefined, OTEL_FILE_CONFIG.alerting.emailEnabled),
      maxAlertsPerDay: levels(undefined, OTEL_FILE_CONFIG.alerting.maxAlertsPerDay),
    });
    expect(invalid).toBe(false);
    expect(settings.enabled).toBe(true);
    expect(settings.slackEnabled).toBe(true);
    expect(settings.emailEnabled).toBe(true);
    expect(settings.maxAlertsPerDay).toBe(100);
  });

  it("env overrides the file (env wins)", () => {
    const { settings } = resolveOtelAlertingSettings({
      enabled: levels("false", true),
      slackEnabled: levels(undefined, true),
      emailEnabled: levels(undefined, true),
      maxAlertsPerDay: levels("5", 100),
    });
    expect(settings.enabled).toBe(false);
    expect(settings.maxAlertsPerDay).toBe(5);
  });

  it("an invalid enabled value fails closed to OFF (builtin) with invalid=true", () => {
    const { settings, invalid } = resolveOtelAlertingSettings({
      enabled: levels("not-a-boolean", true),
      slackEnabled: levels(undefined, true),
      emailEnabled: levels(undefined, true),
      maxAlertsPerDay: levels(undefined, 100),
    });
    expect(invalid).toBe(true);
    expect(settings.enabled).toBe(false);
  });

  it("an invalid maxAlertsPerDay fails closed to the builtin (100) with invalid=true", () => {
    const { settings, invalid } = resolveOtelAlertingSettings({
      enabled: levels(undefined, true),
      slackEnabled: levels(undefined, true),
      emailEnabled: levels(undefined, true),
      maxAlertsPerDay: levels("abc", 100),
    });
    expect(invalid).toBe(true);
    expect(settings.maxAlertsPerDay).toBe(100);
  });

  it("a negative maxAlertsPerDay is invalid and fails closed to the builtin", () => {
    const { settings, invalid } = resolveOtelAlertingSettings({
      enabled: levels(undefined, true),
      slackEnabled: levels(undefined, true),
      emailEnabled: levels(undefined, true),
      maxAlertsPerDay: levels("-1", 100),
    });
    expect(invalid).toBe(true);
    expect(settings.maxAlertsPerDay).toBe(100);
  });

  it("blank levels fall through to the builtin safe defaults (alerting OFF)", () => {
    const { settings, invalid } = resolveOtelAlertingSettings({
      enabled: levels(undefined, undefined),
      slackEnabled: levels(undefined, undefined),
      emailEnabled: levels(undefined, undefined),
      maxAlertsPerDay: levels(undefined, undefined),
    });
    expect(invalid).toBe(false);
    expect(settings).toEqual(OTEL_ALERTING_SETTINGS_BUILTIN);
    expect(settings.enabled).toBe(false);
  });

  it("run level wins over env and file (execution-owner-set, never request input)", () => {
    const { settings } = resolveOtelAlertingSettings({
      enabled: { run: "false", env: "true", file: true },
      slackEnabled: levels(undefined, true),
      emailEnabled: levels(undefined, true),
      maxAlertsPerDay: levels(undefined, 100),
    });
    expect(settings.enabled).toBe(false);
  });
});
