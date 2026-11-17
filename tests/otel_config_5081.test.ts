/**
 * Issue #5081 (S1, observability program #5080) — OTel switch
 * resolution: the four-level on/off mechanism.
 *
 * TDD Red first: the resolver module (src/config/otelModes.ts)
 * does not exist yet, so this file fails at import.
 *
 * The four levels (owner directive, fourth scope addition):
 *  1. GLOBAL MASTER — OTEL_ENABLED / OTEL_SDK_DISABLED (the OTel
 *     standard kill switch). Master off = nothing emitted, nothing
 *     exported, no cost.
 *  2. PER-SIGNAL — OTEL_LOGS_EXPORTER / OTEL_METRICS_EXPORTER /
 *     OTEL_TRACES_EXPORTER (otlp | console | none). 'none' turns
 *     that signal off globally. S1 is logs only; the others are
 *     resolved (wired) for S2/S3.
 *  3. PER-DOMAIN — OTEL_DOMAIN_<DOMAIN>_ENABLED / config map
 *     otel.domains.<domain>.enabled. J1-J7 is ON; every other
 *     domain is OFF by default.
 *  4. PER-DOMAIN LEVEL + SAMPLING — the log level
 *     (ALL/ERROR/DEBUG/INFO/WARN/TRACE/OFF) and the sampling ratio
 *     per domain, both config values. Level OFF = that domain
 *     emits nothing.
 *
 * Resolution order (the PAYMENTS_FLOW_MODE pattern): run > session
 * > user > env > config-file > built-in safe default. The FIRST
 * non-blank level wins; an unrecognized winning value FAILS CLOSED
 * to the safe default (OFF / none / 0) with invalid=true and a
 * coded OBS-1001 message, and does NOT fall through to a lower
 * level. The run/session/user carriers are execution-owner-set,
 * never request input (the #1735 guard).
 */
import { describe, it, expect } from "vitest";
import {
  OTEL_DOMAINS,
  otelConfigErrorEvent,
  otelDomainEnabledDefault,
  otelSignalExporterDefault,
  resolveOtelDomainEnabled,
  resolveOtelDomainLevel,
  resolveOtelDomainSampling,
  resolveOtelMaster,
  resolveOtelSignalExporter,
  type OtelDomain,
} from "../src/config/otelModes";

describe("OTel master switch — resolveOtelMaster", () => {
  it("defaults to ON (SDK active) when every level is blank (file default)", () => {
    // The config file (otel.json) carries enabled=true; the
    // built-in safe fallback (no file) is OFF.
    const r = resolveOtelMaster({ file: "true" });
    expect(r.enabled).toBe(true);
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("file");
  });

  it("fails closed to OFF when no level carries a value (no file)", () => {
    const r = resolveOtelMaster({});
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("builtin");
  });

  it("env overrides the file value", () => {
    expect(resolveOtelMaster({ env: "false", file: "true" }).enabled).toBe(false);
    expect(resolveOtelMaster({ env: "false", file: "true" }).source).toBe("env");
    expect(resolveOtelMaster({ env: "true", file: "false" }).enabled).toBe(true);
  });

  it("run beats session beats user beats env", () => {
    const r = resolveOtelMaster({
      run: "false",
      session: "true",
      user: "true",
      env: "true",
      file: "true",
    });
    expect(r.enabled).toBe(false);
    expect(r.source).toBe("run");
  });

  it("an unrecognized winning value fails closed to OFF with invalid=true and no fall-through", () => {
    const r = resolveOtelMaster({ env: "maybe", file: "true" });
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("env");
    expect(r.raw).toBe("maybe");
  });

  it("accepts the boolean spellings true/1/on/enabled and false/0/off/disabled", () => {
    for (const v of ["true", "1", "on", "enabled", "TRUE", " On "]) {
      expect(resolveOtelMaster({ env: v }).enabled).toBe(true);
    }
    for (const v of ["false", "0", "off", "disabled", "FALSE", " Off "]) {
      expect(resolveOtelMaster({ env: v }).enabled).toBe(false);
    }
  });

  it("a non-string non-null value is invalid (fail-closed OFF)", () => {
    const r = resolveOtelMaster({ env: 1 as unknown as string });
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(true);
  });

  it("a blank string falls through to the next level", () => {
    expect(resolveOtelMaster({ env: "   ", file: "true" }).enabled).toBe(true);
    expect(resolveOtelMaster({ env: "   ", file: "true" }).source).toBe("file");
  });
});

describe("OTel per-signal exporter — resolveOtelSignalExporter", () => {
  it("logs defaults to otlp (the live signal in S1) from the file", () => {
    const r = resolveOtelSignalExporter("logs", { file: "otlp" });
    expect(r.exporter).toBe("otlp");
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("file");
  });

  it("metrics and traces default to none (S2/S3 not built yet)", () => {
    expect(otelSignalExporterDefault("metrics")).toBe("none");
    expect(otelSignalExporterDefault("traces")).toBe("none");
    expect(otelSignalExporterDefault("logs")).toBe("otlp");
  });

  it("fails closed to none when no level carries a value", () => {
    const r = resolveOtelSignalExporter("logs", {});
    expect(r.exporter).toBe("none");
    expect(r.source).toBe("builtin");
  });

  it("accepts otlp, console, none (case-insensitive) and the otlp-http alias", () => {
    expect(resolveOtelSignalExporter("logs", { env: "CONSOLE" }).exporter).toBe("console");
    expect(resolveOtelSignalExporter("logs", { env: "none" }).exporter).toBe("none");
    expect(resolveOtelSignalExporter("logs", { env: "otlp-http" }).exporter).toBe("otlp");
  });

  it("an unrecognized value fails closed to none with invalid=true", () => {
    const r = resolveOtelSignalExporter("logs", { env: "kafka", file: "otlp" });
    expect(r.exporter).toBe("none");
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("env");
  });

  it("env overrides file; run overrides env", () => {
    expect(
      resolveOtelSignalExporter("logs", { run: "none", env: "otlp", file: "otlp" }).exporter,
    ).toBe("none");
  });
});

describe("OTel per-domain switch — resolveOtelDomainEnabled", () => {
  it("j1j7 is ON by default; every other domain is OFF by default", () => {
    expect(otelDomainEnabledDefault("j1j7")).toBe(true);
    const others = OTEL_DOMAINS.filter((d) => d !== "j1j7");
    expect(others.length).toBeGreaterThan(0);
    for (const d of others) expect(otelDomainEnabledDefault(d)).toBe(false);
  });

  it("the domain list covers the named domains", () => {
    const expected: OtelDomain[] = [
      "j1j7",
      "stock-copilot",
      "iaaa",
      "mcp-a2a",
      "scheduler",
      "payments",
      "market-data",
      "platform",
    ];
    for (const d of expected) expect(OTEL_DOMAINS).toContain(d);
  });

  it("resolves from the file level when env is blank", () => {
    const r = resolveOtelDomainEnabled("j1j7", { file: "true" });
    expect(r.enabled).toBe(true);
    expect(r.source).toBe("file");
    const off = resolveOtelDomainEnabled("payments", { file: "false" });
    expect(off.enabled).toBe(false);
  });

  it("fails closed to OFF on an unrecognized value, with no fall-through", () => {
    const r = resolveOtelDomainEnabled("j1j7", { env: "yes-please", file: "true" });
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("env");
  });

  it("env can turn a default-OFF domain on, and a default-ON domain off", () => {
    expect(resolveOtelDomainEnabled("payments", { env: "true", file: "false" }).enabled).toBe(true);
    expect(resolveOtelDomainEnabled("j1j7", { env: "false", file: "true" }).enabled).toBe(false);
  });
});

describe("OTel per-domain level — resolveOtelDomainLevel", () => {
  it("accepts the full level vocabulary (case-insensitive)", () => {
    for (const v of ["ALL", "ERROR", "DEBUG", "INFO", "WARN", "TRACE", "OFF"]) {
      expect(resolveOtelDomainLevel("j1j7", { env: v.toLowerCase() }).level).toBe(v);
      expect(resolveOtelDomainLevel("j1j7", { env: v.toLowerCase() }).invalid).toBe(false);
    }
  });

  it("fails closed to OFF on an unrecognized level", () => {
    const r = resolveOtelDomainLevel("j1j7", { env: "VERBOSE", file: "INFO" });
    expect(r.level).toBe("OFF");
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("env");
  });

  it("falls back to the file level, then to OFF (builtin)", () => {
    expect(resolveOtelDomainLevel("j1j7", { file: "INFO" }).level).toBe("INFO");
    expect(resolveOtelDomainLevel("j1j7", {}).level).toBe("OFF");
    expect(resolveOtelDomainLevel("j1j7", {}).source).toBe("builtin");
  });
});

describe("OTel per-domain sampling — resolveOtelDomainSampling", () => {
  it("accepts a ratio in [0, 1] as a string or number", () => {
    expect(resolveOtelDomainSampling("j1j7", { env: "0.5" }).ratio).toBe(0.5);
    expect(resolveOtelDomainSampling("j1j7", { env: 1 }).ratio).toBe(1);
    expect(resolveOtelDomainSampling("j1j7", { env: "0" }).ratio).toBe(0);
  });

  it("fails closed to 0 on a non-numeric or out-of-range ratio", () => {
    for (const v of ["half", "1.5", "-0.1", "NaN", "Infinity"]) {
      const r = resolveOtelDomainSampling("j1j7", { env: v, file: "1" });
      expect(r.ratio).toBe(0);
      expect(r.invalid).toBe(true);
      expect(r.source).toBe("env");
    }
  });

  it("falls back to the file level, then to 0 (builtin)", () => {
    expect(resolveOtelDomainSampling("j1j7", { file: "1" }).ratio).toBe(1);
    expect(resolveOtelDomainSampling("j1j7", {}).ratio).toBe(0);
  });
});

describe("OTel coded config error", () => {
  it("names the coded event for a failed-closed switch", () => {
    expect(otelConfigErrorEvent()).toBe("otel.config.invalid");
  });
});
