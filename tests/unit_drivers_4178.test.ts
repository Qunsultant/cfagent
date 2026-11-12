/**
 * Issue #4178 (step 1 of programme #4177, sub-issue of #3549) —
 * unit-driver conformance pin.
 *
 * The canonical flow is feed → store → enrich → store → analyze →
 * store → generate → store → serve → store → deliver. Every SHIPPED
 * registry entry in that flow must resolve to a driver (an executable
 * entry point in `src/agentic/unitDrivers.ts`), and every driver must
 * be reachable from a registry entry. Planned entries (no adapter
 * yet) are explicitly allowed to lack a driver — that is what
 * "planned" means.
 *
 * Scope boundary (the #4178 narrowing, 2026-11-11): family
 * registries for options, goal, strategy, and trading/saga/payment
 * belong to #3959 and are NOT asserted here; provider selection as
 * a stage input belongs to #3960; the store stage's async-job
 * executor disposition belongs to #3642. This pin covers the owned
 * scope only: the quotes lineage, the per-family dataset stores,
 * the provider adapters as driver bindings, and the ScheduledAgent
 * executors moved into port drivers.
 *
 * Phantom operations (qa.run_sweep, qa.supervised_fix,
 * search.opportunity_hunt) are never units — #4174 item 6.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPABILITY_REGISTRY,
  type RegistryStage,
} from "../src/agentic/capabilityRegistry";
import {
  UNIT_DRIVERS,
  UnitDriverNotFoundError,
  resolveUnitDriver,
  type UnitDriver,
} from "../src/agentic/unitDrivers";

const CANONICAL_STAGES: RegistryStage[] = [
  "feed",
  "store",
  "enrich",
  "analyze",
  "generate",
  "serve",
  "deliver",
];

const PHANTOM_IDS = [
  "qa.run_sweep",
  "qa.supervised_fix",
  "search.opportunity_hunt",
];

/**
 * A driver entry point names its executable as "module#export"
 * (routes name their handler module the same way). The export
 * must exist as a value export (function or const) in that module
 * — a type-only export is not a driver.
 */
function assertEntryPointResolves(driver: UnitDriver): void {
  const [modulePath, exportName] = driver.entryPoint.split("#");
  expect(
    modulePath,
    `${driver.capabilityId}: entry point needs a module`,
  ).toBeTruthy();
  expect(
    exportName,
    `${driver.capabilityId}: entry point needs an export name`,
  ).toBeTruthy();
  const file = resolve(process.cwd(), modulePath);
  expect(
    existsSync(file),
    `${driver.capabilityId}: driver module must exist: ${modulePath}`,
  ).toBe(true);
  const source = readFileSync(file, "utf8");
  const pattern = new RegExp(
    `(export\\s+(async\\s+)?function\\s+${exportName}\\b)` +
      `|(export\\s+const\\s+${exportName}\\s*=)` +
      `|(export\\s+class\\s+${exportName}\\b)`,
  );
  expect(
    pattern.test(source),
    `${driver.capabilityId}: driver export ${exportName} must be a value export in ${modulePath}`,
  ).toBe(true);
}

describe("unit drivers (#4178)", () => {
  it("every shipped registry entry in the canonical flow resolves to a driver", () => {
    const shipped = CAPABILITY_REGISTRY.filter(
      (e) =>
        CANONICAL_STAGES.includes(e.stage) && e.status === "shipped",
    );
    expect(shipped.length).toBeGreaterThan(0);
    for (const entry of shipped) {
      expect(
        resolveUnitDriver(entry.id),
        `${entry.id}: shipped canonical-flow entry must resolve to a driver`,
      ).toBeDefined();
    }
  });

  it("every driver is reachable from a registry entry", () => {
    const ids = new Set(CAPABILITY_REGISTRY.map((e) => e.id));
    const driverIds = UNIT_DRIVERS.map((d) => d.capabilityId);
    expect(new Set(driverIds).size).toBe(driverIds.length);
    for (const driver of UNIT_DRIVERS) {
      expect(
        ids.has(driver.capabilityId),
        `driver ${driver.capabilityId}: no registry entry carries this id`,
      ).toBe(true);
    }
  });

  it("every driver entry point resolves to an exported value", () => {
    expect(UNIT_DRIVERS.length).toBeGreaterThan(0);
    for (const driver of UNIT_DRIVERS) {
      assertEntryPointResolves(driver);
    }
  });

  it("unknown capability ids refuse by name", () => {
    expect(() => resolveUnitDriver("no-such-unit")).toThrow(
      UnitDriverNotFoundError,
    );
    expect(() => resolveUnitDriver("no-such-unit")).toThrow(
      /no-such-unit/,
    );
  });

  it("phantom operations are never registered as units", () => {
    for (const phantom of PHANTOM_IDS) {
      expect(
        CAPABILITY_REGISTRY.some((e) => e.id === phantom),
        `phantom ${phantom} must not be a registry entry`,
      ).toBe(false);
      expect(
        UNIT_DRIVERS.some((d) => d.capabilityId === phantom),
        `phantom ${phantom} must not have a driver`,
      ).toBe(false);
      expect(() => resolveUnitDriver(phantom)).toThrow(
        UnitDriverNotFoundError,
      );
    }
  });

  it("planned entries carry no driver (that is what planned means)", () => {
    const planned = CAPABILITY_REGISTRY.filter(
      (e) =>
        CANONICAL_STAGES.includes(e.stage) && e.status === "planned",
    );
    for (const entry of planned) {
      expect(
        UNIT_DRIVERS.some((d) => d.capabilityId === entry.id),
        `${entry.id}: a planned entry must not claim a driver yet`,
      ).toBe(false);
    }
  });
});
