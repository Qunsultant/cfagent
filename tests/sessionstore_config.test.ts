/**
 * #6191 — every SessionStore setting externalized into
 * config/sessionstore.json, resolved by src/config/sessionStoreConfig.ts.
 *
 * Each setting: a config key, a documented default (its current value),
 * and a named error on an invalid value (fail closed to the default).
 * The config is the single place an operator tunes the SessionStore;
 * code holds no magic numbers for it.
 *
 * RED: src/config/sessionStoreConfig.ts does not exist yet.
 */
import { describe, expect, it } from "vitest";
import {
  SESSION_STORE_CONFIG,
  SESSION_STORE_CONFIG_ERRORS,
  resolveSessionStoreConfig,
} from "../src/config/sessionStoreConfig";

describe("SessionStore config resolution (#6191)", () => {
  it("the bundled config resolves to the documented defaults", () => {
    expect(SESSION_STORE_CONFIG_ERRORS).toEqual([]);
    expect(SESSION_STORE_CONFIG).toEqual({
      audit: { liveMax: 2000, segmentSize: 2000, maxSegments: 10 },
      schemaVersion: 1,
      genesis: { oneTime: false },
    });
  });

  it("an empty config resolves to all defaults with no errors", () => {
    const resolved = resolveSessionStoreConfig({});
    expect(resolved.errors).toEqual([]);
    expect(resolved.config).toEqual({
      audit: { liveMax: 2000, segmentSize: 2000, maxSegments: 10 },
      schemaVersion: 1,
      genesis: { oneTime: false },
    });
  });

  it("an undefined config resolves to all defaults with no errors", () => {
    const resolved = resolveSessionStoreConfig(undefined);
    expect(resolved.errors).toEqual([]);
    expect(resolved.config.audit.liveMax).toBe(2000);
  });

  it("a configured audit cap takes effect", () => {
    const resolved = resolveSessionStoreConfig({
      audit: { liveMax: 500, segmentSize: 100, maxSegments: 3 },
    });
    expect(resolved.errors).toEqual([]);
    expect(resolved.config.audit).toEqual({
      liveMax: 500,
      segmentSize: 100,
      maxSegments: 3,
    });
  });

  it("a configured schema version takes effect", () => {
    const resolved = resolveSessionStoreConfig({ schemaVersion: 2 });
    expect(resolved.errors).toEqual([]);
    expect(resolved.config.schemaVersion).toBe(2);
  });

  it("a configured genesis.oneTime=true takes effect", () => {
    const resolved = resolveSessionStoreConfig({ genesis: { oneTime: true } });
    expect(resolved.errors).toEqual([]);
    expect(resolved.config.genesis.oneTime).toBe(true);
  });

  it("an invalid audit cap fails closed to its default with a named error", () => {
    const resolved = resolveSessionStoreConfig({
      audit: { liveMax: 0, segmentSize: -5, maxSegments: 2.5 },
    });
    expect(resolved.config.audit).toEqual({
      liveMax: 2000,
      segmentSize: 2000,
      maxSegments: 10,
    });
    expect(resolved.errors).toHaveLength(3);
    expect(resolved.errors.join(" ")).toMatch(/audit\.liveMax/);
    expect(resolved.errors.join(" ")).toMatch(/audit\.segmentSize/);
    expect(resolved.errors.join(" ")).toMatch(/audit\.maxSegments/);
  });

  it("a non-integer audit cap fails closed to its default with a named error", () => {
    const resolved = resolveSessionStoreConfig({
      audit: { liveMax: "many" },
    });
    expect(resolved.config.audit.liveMax).toBe(2000);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toMatch(/audit\.liveMax/);
  });

  it("an invalid schema version fails closed to 1 with a named error", () => {
    const resolved = resolveSessionStoreConfig({ schemaVersion: 0 });
    expect(resolved.config.schemaVersion).toBe(1);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toMatch(/schemaVersion/);
    const nonInteger = resolveSessionStoreConfig({ schemaVersion: 1.5 });
    expect(nonInteger.config.schemaVersion).toBe(1);
    expect(nonInteger.errors).toHaveLength(1);
  });

  it("an invalid genesis.oneTime fails closed to per-identity with a named error", () => {
    const resolved = resolveSessionStoreConfig({
      genesis: { oneTime: "yes" },
    });
    expect(resolved.config.genesis.oneTime).toBe(false);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toMatch(/genesis\.oneTime/);
  });

  it("an unknown top-level key is a named error, not a silent accept", () => {
    const resolved = resolveSessionStoreConfig({ bogus: 1 });
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toMatch(/unknown sessionstore setting 'bogus'/);
    // The known settings still resolve to their defaults.
    expect(resolved.config.audit.liveMax).toBe(2000);
  });

  it("a non-object config fails closed to all defaults with a named error", () => {
    const resolved = resolveSessionStoreConfig("not-an-object");
    expect(resolved.config).toEqual({
      audit: { liveMax: 2000, segmentSize: 2000, maxSegments: 10 },
      schemaVersion: 1,
      genesis: { oneTime: false },
    });
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toMatch(/must be an object/);
  });
});
