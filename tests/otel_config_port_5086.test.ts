/**
 * Issue #5086 (S7, observability program #5080) — the one config
 * port: every OTel threshold, severity, retention, and sampling
 * value lives in config, and the runtime override store (D1)
 * lets an operator flip a switch without a redeploy.
 *
 * TDD Red first: the config port (src/config/otelConfigPort.ts)
 * does not exist yet, so this file fails at import.
 *
 * Rules the port enforces:
 *  - ONE allow-list of overridable config keys (dotted config
 *    paths). An unknown key is rejected and never written.
 *  - Values are validated by kind (boolean / exporter / level /
 *    sampling / positiveInt / nonNegativeInt / ratio / severity)
 *    with the SAME normalizers the deploy-time resolvers use.
 *    An invalid value fails closed (rejected, never written)
 *    with a coded OBS-1001 reason.
 *  - Every change is versioned (the table is append-only: one
 *    row per change, version increments), auditable (an audit
 *    event with actor + key + version + reason), and
 *    reversible (clear INSERTs a tombstone that restores the
 *    deploy-time value; the previous value rides the version
 *    history, readable via readOverrideHistory).
 *  - A missing D1 table (migration not yet applied) fails closed
 *    to empty overrides — the read never throws into the caller.
 *  - Resolution order with the runtime level: run > session >
 *    user > runtime > env > file > builtin (the runtime store
 *    replaces the deploy-time env/file source at runtime).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  cachedOtelRuntimeOverrides,
  createOtelConfigPort,
  isOtelRuntimeOverrideKey,
  otelRuntimeLevel,
  otelRuntimeOverrideKeys,
  refreshOtelRuntimeOverrideCache,
  resetOtelRuntimeOverrideCache,
  type OtelConfigD1,
  type OtelRuntimeOverrideRecord,
} from "../src/config/otelConfigPort";
import { resolveOtelAlertingSettings } from "../src/config/otelModes";

/** One D1 row of the append-only otel_config_overrides table. */
interface FakeOverrideRow {
  config_key: string;
  value_json: string | null;
  version: number;
  updated_by: string;
  updated_at_ms: number;
  reason: string;
}

/** Minimal in-memory fake D1 for the overrides table (append-only rows). */
function createFakeD1(): {
  d1: OtelConfigD1;
  rows: FakeOverrideRow[];
} {
  const rows: FakeOverrideRow[] = [];
  const d1: OtelConfigD1 = {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>(): Promise<{ results: T[] }> {
              const filtered = normalized.includes("WHERE config_key")
                ? rows.filter((r) => r.config_key === params[0])
                : rows;
              return { results: filtered.map((r) => ({ ...r })) as T[] };
            },
            async run(): Promise<unknown> {
              if (normalized.startsWith("INSERT")) {
                const [config_key, value_json, version, updated_by, updated_at_ms, reason] =
                  params as [string, string | null, number, string, number, string];
                rows.push({ config_key, value_json, version, updated_by, updated_at_ms, reason });
              }
              return {};
            },
          };
        },
      };
    },
  };
  return { d1, rows };
}

describe("S7 config port (#5086)", () => {
  beforeEach(() => {
    resetOtelRuntimeOverrideCache();
  });

  it("publishes the allow-list: every threshold/severity/retention/sampling the program owns", () => {
    const keys = otelRuntimeOverrideKeys().map((k) => k.key);
    for (const key of [
      "enabled",
      "logsExporter",
      "metricsExporter",
      "tracesExporter",
      "destinations.analyticsEngine",
      "destinations.console",
      "destinations.r2",
      "domains.j1j7.enabled",
      "domains.j1j7.level",
      "domains.j1j7.samplingRatio",
      "metrics.exportIntervalMs",
      "metrics.freeTier.dailyWriteLimit",
      "metrics.health.pipelineMaxFailureRate",
      "traces.freeTier.dailyWriteLimit",
      "archive.pageSize",
      "archive.maxObjects",
      "alerting.enabled",
      "alerting.slackEnabled",
      "alerting.emailEnabled",
      "alerting.maxAlertsPerDay",
      "backend.enabled",
      "backend.requestTimeoutMs",
      "backend.serviceName",
      "backend.protocol",
      "backend.endpoint",
      "backend.instanceId",
      "catalog.OBS-1016.severity",
    ]) {
      expect(keys, `${key} must be overridable`).toContain(key);
    }
    expect(isOtelRuntimeOverrideKey("alerting.maxAlertsPerDay")).toBe(true);
    expect(isOtelRuntimeOverrideKey("totally.bogus.key")).toBe(false);
  });

  it("applies an override: versioned, audited, readable back", async () => {
    const { d1 } = createFakeD1();
    const audits: unknown[] = [];
    const port = createOtelConfigPort({
      d1,
      audit: async (input) => {
        audits.push(input);
        return true;
      },
      nowMs: () => 1_793_000_000_000,
    });
    const applied = await port.applyOverride({
      key: "alerting.maxAlertsPerDay",
      value: 50,
      actor: "admin-1",
      reason: "raise the cap for the incident",
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.record.key).toBe("alerting.maxAlertsPerDay");
      expect(applied.record.value).toBe(50);
      expect(applied.record.version).toBe(1);
      expect(applied.record.updatedBy).toBe("admin-1");
      expect(applied.record.reason).toBe("raise the cap for the incident");
    }
    const back = await port.readOverrideMap();
    expect(back["alerting.maxAlertsPerDay"]?.value).toBe(50);
    expect(audits.length).toBe(1);
  });

  it("increments the version on every change and keeps the value history", async () => {
    const { d1 } = createFakeD1();
    const audits: Array<{ action?: string; resourceId?: string }> = [];
    const port = createOtelConfigPort({
      d1,
      audit: async (input) => {
        audits.push(input as { action?: string; resourceId?: string });
        return true;
      },
      nowMs: () => 1_793_000_000_000,
    });
    await port.applyOverride({ key: "alerting.maxAlertsPerDay", value: 50, actor: "a", reason: "r1" });
    const second = await port.applyOverride({
      key: "alerting.maxAlertsPerDay",
      value: 25,
      actor: "a",
      reason: "r2",
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.record.version).toBe(2);
    // The version history carries the old and new values (the
    // audit event attributes the change: who, which key, when).
    const history = await port.readOverrideHistory("alerting.maxAlertsPerDay");
    expect(history.map((r) => r.version)).toEqual([1, 2]);
    expect(history.map((r) => r.value)).toEqual([50, 25]);
    expect(audits[1]?.action).toBe("otel.config.override.set");
    expect(audits[1]?.resourceId).toBe("alerting.maxAlertsPerDay");
  });

  it("rejects an unknown key and never writes it", async () => {
    const { d1, rows } = createFakeD1();
    const port = createOtelConfigPort({ d1, audit: async () => true });
    const result = await port.applyOverride({
      key: "totally.bogus.key",
      value: true,
      actor: "a",
      reason: "r",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown config key/);
    expect(rows.length).toBe(0);
  });

  it("rejects an invalid value and never writes it (fails closed, OBS-1001)", async () => {
    const { d1, rows } = createFakeD1();
    const audits: unknown[] = [];
    const port = createOtelConfigPort({
      d1,
      audit: async (input) => {
        audits.push(input);
        return true;
      },
    });
    const result = await port.applyOverride({
      key: "alerting.maxAlertsPerDay",
      value: -5,
      actor: "a",
      reason: "r",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/OBS-1001/);
    }
    expect(rows.length).toBe(0);
    expect(audits.length).toBe(0);
  });

  it("rejects a missing reason: a config change is always audited with a reason", async () => {
    const { d1, rows } = createFakeD1();
    const port = createOtelConfigPort({ d1, audit: async () => true });
    const result = await port.applyOverride({
      key: "alerting.enabled",
      value: false,
      actor: "a",
      reason: "   ",
    });
    expect(result.ok).toBe(false);
    expect(rows.length).toBe(0);
  });

  it("clears an override: the deploy-time value governs again, audited, history kept", async () => {
    const { d1 } = createFakeD1();
    const audits: unknown[] = [];
    const port = createOtelConfigPort({
      d1,
      audit: async (input) => {
        audits.push(input);
        return true;
      },
    });
    await port.applyOverride({ key: "alerting.enabled", value: false, actor: "a", reason: "r" });
    const cleared = await port.clearOverride({ key: "alerting.enabled", actor: "a", reason: "back" });
    expect(cleared.ok).toBe(true);
    expect((await port.readOverrideMap())["alerting.enabled"]).toBeUndefined();
    expect(audits.length).toBe(2);
    // Clear is a tombstone, not a delete: the history keeps the
    // set value, so reverting is re-applying it.
    const history = await port.readOverrideHistory("alerting.enabled");
    expect(history.map((r) => r.version)).toEqual([1, 2]);
    expect(history[0]?.value).toBe(false);
    expect(history[1]?.valueJson).toBeNull();
  });

  it("refuses to clear a key with no override set", async () => {
    const { d1 } = createFakeD1();
    const port = createOtelConfigPort({ d1, audit: async () => true });
    const cleared = await port.clearOverride({ key: "alerting.enabled", actor: "a", reason: "r" });
    expect(cleared.ok).toBe(false);
  });

  it("fails closed to empty overrides when D1 is unbound or the table is missing", async () => {
    const port = createOtelConfigPort({ d1: null, audit: async () => true });
    expect(await port.readOverrides()).toEqual([]);
    const throwing: OtelConfigD1 = {
      prepare() {
        throw new Error("no such table: otel_config_overrides");
      },
    };
    const port2 = createOtelConfigPort({ d1: throwing, audit: async () => true });
    expect(await port2.readOverrides()).toEqual([]);
  });

  it("caches overrides for sync readers and refreshes on demand", async () => {
    const { d1 } = createFakeD1();
    expect(cachedOtelRuntimeOverrides()).toEqual({});
    await refreshOtelRuntimeOverrideCache(d1, { force: true, nowMs: 1000 });
    expect(cachedOtelRuntimeOverrides()).toEqual({});
    const port = createOtelConfigPort({ d1, audit: async () => true });
    await port.applyOverride({ key: "alerting.enabled", value: false, actor: "a", reason: "r" });
    const fresh = await refreshOtelRuntimeOverrideCache(d1, { force: true, nowMs: 2000 });
    expect(fresh["alerting.enabled"]?.value).toBe(false);
    expect(cachedOtelRuntimeOverrides()["alerting.enabled"]?.value).toBe(false);
    expect(otelRuntimeLevel(fresh, "alerting.enabled")).toBe(false);
    expect(otelRuntimeLevel(fresh, "alerting.maxAlertsPerDay")).toBeUndefined();
  });

  it("resolves the runtime level between user and env (run > session > user > runtime > env > file > builtin)", () => {
    const runtime = { "alerting.maxAlertsPerDay": 50 };
    const resolved = resolveOtelAlertingSettings({
      enabled: { env: true, file: true },
      slackEnabled: { env: true, file: true },
      emailEnabled: { env: true, file: true },
      maxAlertsPerDay: {
        runtime: otelRuntimeLevel(
          { "alerting.maxAlertsPerDay": { key: "alerting.maxAlertsPerDay", value: 50, valueJson: "50", version: 1, updatedBy: "a", updatedAtMs: 1, reason: "r" } },
          "alerting.maxAlertsPerDay",
        ),
        env: 100,
        file: 100,
      },
    });
    expect(resolved.settings.maxAlertsPerDay).toBe(50);
    // And env still wins when no runtime value is set.
    const noRuntime = resolveOtelAlertingSettings({
      enabled: { env: true, file: true },
      slackEnabled: { env: true, file: true },
      emailEnabled: { env: true, file: true },
      maxAlertsPerDay: { env: 100, file: 100 },
    });
    expect(noRuntime.settings.maxAlertsPerDay).toBe(100);
  });

  it("fails a runtime value closed to the builtin with OBS-1001 and no fall-through", () => {
    const resolved = resolveOtelAlertingSettings({
      enabled: { env: true, file: true },
      slackEnabled: { env: true, file: true },
      emailEnabled: { env: true, file: true },
      // env/file say 200/300; the builtin is 100. An invalid
      // runtime value must land on the builtin, never fall
      // through to env or file.
      maxAlertsPerDay: { runtime: "not-a-number", env: 200, file: 300 },
    });
    expect(resolved.invalid).toBe(true);
    expect(resolved.settings.maxAlertsPerDay).toBe(100);
  });
});
