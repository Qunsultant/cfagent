/**
 * Issue #4624 — tenant-scoped delivery identities.
 *
 * The bug: a scheduled delivery's identity was `${trigger}:${universe}:${minute}`,
 * so two tenants of one login firing the same trigger + universe in the same
 * minute produced one identity, and the second tenant's delivery was
 * suppressed as a duplicate in `mas_delivery_claims`.
 *
 * These tests prove the tenant now separates them, that the retry semantics
 * each shape wants still hold, and that the source sites use the one module.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  UNRESOLVED_DELIVERY_TENANT,
  deliveryIdentityIsTenantScoped,
  manualDeliveryIdentity,
  scheduledDeliveryIdentity,
} from "../src/services/deliveryIdentity";
import { createDeliverySuppressor } from "../src/workflows/screenDeliverySuppression";

const MINUTE = "2026-11-15T12:34:56.789Z";

describe("scheduled delivery identity (#4624)", () => {
  it("separates two tenants of one login in the same trigger + universe + minute", () => {
    const a = scheduledDeliveryIdentity({
      tenantId: "tenant-a",
      trigger: "scheduled",
      universe: "SP500",
      timestamp: MINUTE,
    });
    const b = scheduledDeliveryIdentity({
      tenantId: "tenant-b",
      trigger: "scheduled",
      universe: "SP500",
      timestamp: MINUTE,
    });
    expect(a).not.toBe(b);
    expect(a).toBe("scheduled:tenant-a:SP500:2026-11-15T12:34");
    expect(b).toBe("scheduled:tenant-b:SP500:2026-11-15T12:34");
  });

  it("keeps one identity per run: same tenant, trigger, universe and minute", () => {
    const first = scheduledDeliveryIdentity({
      tenantId: "tenant-a",
      trigger: "scheduled",
      universe: "SP500",
      timestamp: MINUTE,
    });
    const second = scheduledDeliveryIdentity({
      tenantId: "tenant-a",
      trigger: "scheduled",
      universe: "SP500",
      timestamp: "2026-11-15T12:34:02.001Z",
    });
    // Same minute → same identity, so a re-submitted deliver job still suppresses.
    expect(first).toBe(second);
  });

  it("names an unresolvable tenant honestly instead of guessing one", () => {
    const id = scheduledDeliveryIdentity({
      tenantId: null,
      trigger: "scheduled",
      universe: "TECH",
      timestamp: MINUTE,
    });
    expect(id).toBe(`scheduled:${UNRESOLVED_DELIVERY_TENANT}:TECH:2026-11-15T12:34`);
    expect(deliveryIdentityIsTenantScoped(id)).toBe(false);
  });

  it("both tenants' deliveries claim — the second is not suppressed as a duplicate", () => {
    // The real suppressor, in-memory store: exactly the path the executor uses.
    const suppressor = createDeliverySuppressor();
    const identityFor = (tenantId: string) =>
      scheduledDeliveryIdentity({
        tenantId,
        trigger: "scheduled",
        universe: "SP500",
        timestamp: MINUTE,
      });

    expect(suppressor.tryClaim(identityFor("tenant-a"), "slack")).toBe(true);
    expect(suppressor.tryClaim(identityFor("tenant-b"), "slack")).toBe(true);

    // Same tenant again in the same minute is still a duplicate.
    expect(suppressor.tryClaim(identityFor("tenant-a"), "slack")).toBe(false);
    // And the destinations stay independent per tenant.
    expect(suppressor.tryClaim(identityFor("tenant-a"), "email:ops@example.com")).toBe(true);
  });

  it("regression: the pre-fix shape really did collide", () => {
    // The old builder, reproduced verbatim, proves the test above is not vacuous.
    const legacy = (universe: string) => `scheduled:${universe}:${MINUTE.slice(0, 16)}`;
    expect(legacy("SP500")).toBe(legacy("SP500"));
    const suppressor = createDeliverySuppressor();
    expect(suppressor.tryClaim(legacy("SP500"), "slack")).toBe(true);
    expect(suppressor.tryClaim(legacy("SP500"), "slack")).toBe(false);
  });
});

describe("manual delivery identity (#4624)", () => {
  it("keeps the per-run full-resolution timestamp, so two runs never share an id", () => {
    expect(manualDeliveryIdentity({ timestamp: MINUTE, universe: "TECH" })).toBe(
      "manual:2026-11-15T12:34:56.789Z:TECH",
    );
    const first = manualDeliveryIdentity({ timestamp: MINUTE, universe: "TECH" });
    const second = manualDeliveryIdentity({ timestamp: "2026-11-15T12:34:56.790Z", universe: "TECH" });
    expect(first).not.toBe(second);
  });

  it("still dedupes a retry of the same run", () => {
    const suppressor = createDeliverySuppressor();
    const id = manualDeliveryIdentity({ timestamp: MINUTE, universe: "TECH" });
    expect(suppressor.tryClaim(id, "slack")).toBe(true);
    expect(suppressor.tryClaim(id, "slack")).toBe(false);
  });

  it("counts as tenant-scoped by construction (a manual run is one user's run)", () => {
    expect(deliveryIdentityIsTenantScoped(manualDeliveryIdentity({ timestamp: MINUTE, universe: "TECH" }))).toBe(true);
    expect(deliveryIdentityIsTenantScoped("workflow:job-1")).toBe(true);
  });
});

describe("the identity has one home (#4624)", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("scheduledTasks builds both scheduled identities through the module", () => {
    const src = read("src/services/scheduledTasks.ts");
    expect(src).toContain("scheduledDeliveryIdentity({");
    // Neither the completed nor the failed site may keep the old shape.
    expect(src).not.toContain("deliveryId: `${options.trigger");
    const sites = src.match(/deliveryId: scheduledDeliveryIdentity\(/g) ?? [];
    expect(sites).toHaveLength(2);
  });

  it("the manual publishers build through the module", () => {
    const publish = read("src/agents/routes/etradeBrokerPublish.ts");
    expect(publish).not.toContain("`manual:${result.timestamp}");
    expect((publish.match(/manualDeliveryIdentity\(/g) ?? []).length).toBe(2);

    const screen = read("src/agents/routes/etradeBrokerScreen.ts");
    expect(screen).not.toContain("`manual:${(enriched");
    expect(screen).toContain("manualDeliveryIdentity({");
  });

  it("the scheduled path resolves the tenant before the run, so failures carry it too", () => {
    const src = read("src/services/scheduledTasks.ts");
    expect(src).toContain("deliveryTenantId = await this.resolveDeliveryTenant(userLogin);");
    expect(src).toContain("private async resolveDeliveryTenant(");
    // The resolution must sit before the paid branch (which can throw early).
    const resolveAt = src.indexOf("deliveryTenantId = await this.resolveDeliveryTenant");
    const paidAt = src.indexOf('if (effectiveTrigger === "scheduled") {');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(paidAt);
  });
});
