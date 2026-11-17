/**
 * Issue #5169 (observability program #5080) — the R2 archive
 * sub-tab: the archive list limits are config values.
 *
 * TDD Red first: the archive section
 * (src/config/otelModes.ts `resolveOtelArchiveSettings`, the
 * `archive` section of config/otel.json) does not exist yet, so
 * this file fails at import.
 *
 * Resolution follows the S2 metrics-settings pattern exactly:
 * run > session > user > env > config-file > built-in safe
 * default, one setting at a time. An unrecognized winning value
 * fails closed to that setting's built-in default with a coded
 * OBS-1001 message and no fall-through. The built-ins are the
 * LOW-VOLUME defaults: 50 objects per page, 500 max per page —
 * the list route can never return an unbounded list.
 */
import { describe, it, expect } from "vitest";
import {
  OTEL_ARCHIVE_SETTINGS_BUILTIN,
  OTEL_FILE_CONFIG,
  resolveOtelArchiveSettings,
} from "../src/config/otelModes";

describe("Otel archive settings — config file defaults", () => {
  it("the config file carries pageSize 50 and maxObjects 500", () => {
    expect(OTEL_FILE_CONFIG.archive.pageSize).toBe(50);
    expect(OTEL_FILE_CONFIG.archive.maxObjects).toBe(500);
  });

  it("the built-in safe defaults are the low-volume values", () => {
    expect(OTEL_ARCHIVE_SETTINGS_BUILTIN).toEqual({ pageSize: 50, maxObjects: 500 });
  });
});

describe("resolveOtelArchiveSettings — run > session > user > env > file > builtin", () => {
  it("resolves the file values when every other level is blank", () => {
    const r = resolveOtelArchiveSettings({
      pageSize: { file: 50 },
      maxObjects: { file: 500 },
    });
    expect(r.settings).toEqual({ pageSize: 50, maxObjects: 500 });
    expect(r.invalid).toBe(false);
  });

  it("env overrides the file value", () => {
    const r = resolveOtelArchiveSettings({
      pageSize: { env: "25", file: 50 },
      maxObjects: { env: "100", file: 500 },
    });
    expect(r.settings).toEqual({ pageSize: 25, maxObjects: 100 });
    expect(r.invalid).toBe(false);
  });

  it("fails closed to the built-in default on an invalid winning value", () => {
    const r = resolveOtelArchiveSettings({
      pageSize: { env: "all", file: 50 },
      maxObjects: { env: "-1", file: 500 },
    });
    expect(r.settings).toEqual({ pageSize: 50, maxObjects: 500 });
    expect(r.invalid).toBe(true);
  });

  it("fails closed to the built-in default when no level carries a value", () => {
    const r = resolveOtelArchiveSettings({ pageSize: {}, maxObjects: {} });
    expect(r.settings).toEqual({ pageSize: 50, maxObjects: 500 });
    expect(r.invalid).toBe(false);
  });

  it("resolves each setting independently (one invalid, one clean)", () => {
    const r = resolveOtelArchiveSettings({
      pageSize: { env: "10", file: 50 },
      maxObjects: { env: "banana", file: 500 },
    });
    expect(r.settings).toEqual({ pageSize: 10, maxObjects: 500 });
    expect(r.invalid).toBe(true);
  });
});
