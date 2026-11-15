import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as createCommercialPorts from "../src/data/createCommercialPorts";
import * as createSubscriptionPorts from "../src/data/createSubscriptionPorts";
import {
  isTenantMismatchError,
  resolvePaidScreenAccount,
  TENANT_MISMATCH_HTTP_STATUS,
} from "../src/services/paidScreenSubmission";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { handleSagaEntryRoutes } from "../src/agents/routes/sagaEntry";
import { submitPaidStockScreenOrNull } from "../src/agents/routes/paidStockScreenSeam";
import { activateSubscription } from "../src/services/subscriptionActivation";

describe("Issue #4604 — pin tenant-mismatch HTTP status per caller", () => {
  it("pins TENANT_MISMATCH_HTTP_STATUS to 403 and detects all seam-level mismatch errors", () => {
    expect(TENANT_MISMATCH_HTTP_STATUS).toBe(403);
    expect(
      isTenantMismatchError(
        new Error("Tenant mismatch: run tenant must equal the verified account tenant."),
      ),
    ).toBe(true);
    expect(
      isTenantMismatchError("Tenant mismatch: subscription tenant must equal the verified account tenant."),
    ).toBe(true);
    expect(isTenantMismatchError(new Error("Other failure"))).toBe(false);
  });

  it("resolvePaidScreenAccount throws a Tenant mismatch error detected by isTenantMismatchError", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({ userId: "alice", tenantId: "tenant-a", tier: "Free" });
    const subscriptions = new InMemorySubscriptionAdapter();

    await expect(
      resolvePaidScreenAccount(
        { commercial, subscriptions },
        { userId: "alice", email: "alice@example.com", tenantId: "tenant-b", nowMs: Date.now() },
      ),
    ).rejects.toSatisfy((err: unknown) => isTenantMismatchError(err));
  });

  it("paidStockScreenSeam maps a Tenant mismatch throw to HTTP 403", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({ userId: "alice", tenantId: "tenant-a", tier: "Free" });
    const subscriptions = new InMemorySubscriptionAdapter();
    const cSpy = vi
      .spyOn(createCommercialPorts, "createCommercialAdapter")
      .mockReturnValue(commercial as never);
    const ceSpy = vi
      .spyOn(createCommercialPorts, "ensureCommercialSchema")
      .mockResolvedValue(undefined);
    const sSpy = vi
      .spyOn(createSubscriptionPorts, "createSubscriptionAdapter")
      .mockReturnValue(subscriptions as never);
    const seSpy = vi
      .spyOn(createSubscriptionPorts, "ensureSubscriptionSchema")
      .mockResolvedValue(undefined);

    try {
      const res = await submitPaidStockScreenOrNull({
        env: { FEATURE_FLAGS: JSON.stringify({ monetization: true }) } as never,
        userLogin: "alice",
        checkoutEmail: "alice@example.com",
        spec: {
          asyncRequested: true,
          family: "stock",
          symbols: ["AAPL"],
        } as never,
        auditType: "market_data.screener.payment_started",
        auditAgent: "research",
        audit: vi.fn(),
      });
      expect(res).not.toBeNull();
      expect(res?.status).toBe(403);
      const body = (await res?.json()) as { error?: string };
      expect(body.error).toMatch(/Tenant mismatch/);
    } finally {
      cSpy.mockRestore();
      ceSpy.mockRestore();
      sSpy.mockRestore();
      seSpy.mockRestore();
    }
  });

  it("sagaEntry maps a Tenant mismatch throw to HTTP 403", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({ userId: "alice", tenantId: "tenant-a", tier: "Free" });
    const subscriptions = new InMemorySubscriptionAdapter();
    const cSpy = vi
      .spyOn(createCommercialPorts, "createCommercialAdapter")
      .mockReturnValue(commercial as never);
    const sSpy = vi
      .spyOn(createSubscriptionPorts, "createSubscriptionAdapter")
      .mockReturnValue(subscriptions as never);

    try {
      const res = await handleSagaEntryRoutes(
        new Request("https://agent.test/api/saga/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runRequestId: "run-4604-1",
            email: "alice@example.com",
            screenerCommand: { jobId: "job-4604-1", userLogin: "alice" },
            tradeIntent: {
              kind: "stock",
              symbol: "AAPL",
              action: "buy",
              quantity: 1,
            },
          }),
        }),
        new URL("https://agent.test/api/saga/start"),
        "/api/saga/start",
        { FEATURE_FLAGS: JSON.stringify({ monetization: true }) } as never,
        "alice",
      );
      expect(res).not.toBeNull();
      expect(res?.status).toBe(403);
      const body = (await res?.json()) as { error?: string };
      expect(body.error).toMatch(/Tenant mismatch/);
    } finally {
      cSpy.mockRestore();
      sSpy.mockRestore();
    }
  });

  it("activateSubscription throws a Tenant mismatch error matched by isTenantMismatchError", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({ userId: "alice", tenantId: "tenant-a", tier: "Free" });
    const subscriptions = new InMemorySubscriptionAdapter();
    const plan = {
      id: "plan-pro",
      name: "Pro",
      active: true,
      approvalStatus: "approved",
      priceUSD: 20,
      periodDays: 30,
      includedRuns: 100,
      trialDays: 7,
    };

    await expect(
      activateSubscription({
        subs: subscriptions,
        store: commercial,
        userId: "alice",
        tenantId: "tenant-b",
        plan: plan as never,
        provider: "stripe",
        providerPaymentRef: "pay-4604-1",
        nowMs: Date.now(),
      }),
    ).rejects.toSatisfy((err: unknown) => isTenantMismatchError(err));
  });

  it("every HTTP route file referencing Tenant mismatch uses TENANT_MISMATCH_HTTP_STATUS (403)", () => {
    const routesDir = join(process.cwd(), "src", "agents", "routes");
    const files = readdirSync(routesDir).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(routesDir, file), "utf8");
      if (/Tenant mismatch|isTenantMismatchError/.test(content)) {
        if (!content.includes("TENANT_MISMATCH_HTTP_STATUS")) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
