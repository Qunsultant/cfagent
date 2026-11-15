/**
 * Issue #4622 — per-payer quota on the premium options-scan and
 * market-research routes.
 *
 * Stock-signals already charged the #2842 per-user request quota; the other
 * two premium routes had none, so one funded payer could loop them with only
 * a per-call payment in the way. These tests pin the reused gate (no second
 * counter), the per-payer partition, the fail-closed posture and the shared
 * refusal contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  PREMIUM_QUOTA_KINDS,
  premiumQuotaGate,
  premiumQuotaRefusalBody,
} from "../src/services/premiumQuota";
import { createInMemoryUserRequestQuotaPort } from "../src/data/createUserRequestQuotaPorts";
import { quotaConsumptionVerdict } from "../src/security/userRequestQuota";
import type { UserRequestQuotaPort } from "../src/data/userRequestQuotaPorts";

const POLICY = { enabled: true, daily: 2, weekly: 10, monthly: 20 };
const NOW = Date.parse("2026-11-15T12:00:00.000Z");

function gate(
  overrides: Partial<Parameters<typeof premiumQuotaGate>[0]> = {},
): ReturnType<typeof premiumQuotaGate> {
  return premiumQuotaGate({
    port: createInMemoryUserRequestQuotaPort(),
    policy: POLICY,
    tenantId: "tenant-a",
    userLogin: "payer-a",
    kind: PREMIUM_QUOTA_KINDS.optionsScan,
    runId: crypto.randomUUID(),
    nowMs: NOW,
    ...overrides,
  });
}

describe("premium kinds consume the one quota (#4622)", () => {
  it("enumerates both premium routes as consuming kinds", () => {
    expect(quotaConsumptionVerdict(PREMIUM_QUOTA_KINDS.optionsScan).verdict).toBe("consumes");
    expect(quotaConsumptionVerdict(PREMIUM_QUOTA_KINDS.marketResearch).verdict).toBe("consumes");
  });

  it("leaves non-premium kinds as they were", () => {
    expect(quotaConsumptionVerdict("report-read").verdict).toBe("no-charge");
    expect(quotaConsumptionVerdict("chat").verdict).toBe("no-charge");
  });

  it("reuses the #2842 gate rather than a second counter", () => {
    const src = readFileSync("src/services/premiumQuota.ts", "utf8");
    expect(src).toContain("checkAndChargeUserRequestQuota");
    expect(src).not.toContain("INSERT INTO");
  });
});

describe("per-payer enforcement (#4622)", () => {
  it("charges a payer up to the daily limit, then refuses", () => {
    const port = createInMemoryUserRequestQuotaPort();
    const run = () => gate({ port });
    expect(run().ok).toBe(true);
    expect(run().ok).toBe(true);
    const third = run();
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.code).toBe("QUOTA_EXCEEDED");
    expect(third.details?.window).toBe("daily");
    expect(third.details?.limit).toBe(2);
  });

  it("keeps two payers' pools independent", () => {
    const port = createInMemoryUserRequestQuotaPort();
    // Payer A exhausts the daily limit…
    gate({ port, userLogin: "payer-a" });
    gate({ port, userLogin: "payer-a" });
    expect(gate({ port, userLogin: "payer-a" }).ok).toBe(false);
    // …and payer B still has its own budget.
    const b = gate({ port, userLogin: "payer-b" });
    expect(b.ok).toBe(true);
    expect(b.ok && b.usage.daily).toBe(1);
  });

  it("separates tenants of one login", () => {
    const port = createInMemoryUserRequestQuotaPort();
    gate({ port, tenantId: "tenant-a", userLogin: "shared" });
    gate({ port, tenantId: "tenant-a", userLogin: "shared" });
    expect(gate({ port, tenantId: "tenant-a", userLogin: "shared" }).ok).toBe(false);
    // The same login under another tenant has its own pool.
    expect(gate({ port, tenantId: "tenant-b", userLogin: "shared" }).ok).toBe(true);
  });

  it("charges market-research against the same payer pool", () => {
    const port = createInMemoryUserRequestQuotaPort();
    gate({ port, kind: PREMIUM_QUOTA_KINDS.optionsScan });
    gate({ port, kind: PREMIUM_QUOTA_KINDS.marketResearch });
    const third = gate({ port, kind: PREMIUM_QUOTA_KINDS.marketResearch });
    expect(third.ok).toBe(false);
  });

  it("does nothing when the deployment disables the quota", () => {
    const outcome = gate({ policy: { enabled: false, daily: 1, weekly: 1, monthly: 1 } });
    expect(outcome).toEqual({ ok: true, charged: false, usage: {} });
  });

  it("fails closed when the quota port throws", () => {
    const broken: UserRequestQuotaPort = {
      ensureSchema: () => {},
      probe: () => {
        throw new Error("store down");
      },
      chargeWindow: () => {
        throw new Error("store down");
      },
      usage: () => {
        throw new Error("store down");
      },
    } as unknown as UserRequestQuotaPort;
    const outcome = gate({ port: broken });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("QUOTA_UNAVAILABLE");
  });
});

describe("the refusal contract is the one stock-signals already uses (#4622)", () => {
  it("carries limit, usage, window and reset on an exceeded refusal", () => {
    const port = createInMemoryUserRequestQuotaPort();
    gate({ port });
    gate({ port });
    const refused = gate({ port });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const body = premiumQuotaRefusalBody(refused);
    expect(body.error).toBe("Request quota exceeded.");
    expect(body.retryable).toBe(true);
    expect(body.limit).toBe(2);
    expect(body.usage).toBe(2);
    expect(body.window).toBe("daily");
    expect(body.resetAt).toBeTruthy();
    expect(body.resetAtMs).toBeGreaterThan(NOW);
  });

  it("says unavailable without inventing limits when the store is down", () => {
    const body = premiumQuotaRefusalBody({ ok: false, code: "QUOTA_UNAVAILABLE", reason: "store down" });
    expect(body.error).toBe("Request quota unavailable.");
    expect(body.retryable).toBe(true);
    expect(body.limit).toBeNull();
    expect(body.usage).toBeNull();
  });
});

describe("both premium routes charge before they run (#4622)", () => {
  const src = readFileSync("src/agents/routes/premium.ts", "utf8");

  it("options-scan and market-research both call the gate", () => {
    expect(src).toContain("PREMIUM_QUOTA_KINDS.optionsScan");
    expect(src).toContain("PREMIUM_QUOTA_KINDS.marketResearch");
    expect((src.match(/chargePremiumQuota\(\{/g) ?? []).length).toBe(2);
  });

  it("the gate sits before the work each branch performs", () => {
    const scanGate = src.indexOf("PREMIUM_QUOTA_KINDS.optionsScan");
    const scanWork = src.indexOf("new UnifiedOptionsService");
    expect(scanGate).toBeGreaterThan(-1);
    if (scanWork > -1) expect(scanGate).toBeLessThan(scanWork);

    const researchGate = src.indexOf("PREMIUM_QUOTA_KINDS.marketResearch");
    const researchWork = src.indexOf("new MarketDataResearchService");
    expect(researchGate).toBeGreaterThan(-1);
    expect(researchGate).toBeLessThan(researchWork);
  });
});
