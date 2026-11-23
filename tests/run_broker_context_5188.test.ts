/**
 * Issue #5188 — the run's broker context is resolved once, from the caller's
 * selection, the schedule's selection, or the tenant's broker (in that order),
 * and names the mode, its source, and the account.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { resolveRunBrokerContext } from "../src/services/runBrokerContext";

function env(extra: Record<string, unknown> = {}): Env {
  return { ETRADE_ENVIRONMENT: "sandbox", ...extra } as unknown as Env;
}

describe("RunBrokerContext (#5188)", () => {
  it("uses the caller's explicit broker, mode and account", async () => {
    const ctx = await resolveRunBrokerContext({
      env: env({ TENANT_BROKER_ID: "public" }),
      environment: "TEST",
      selection: { brokerId: "alpaca", mode: "live", accountId: "acct-7", source: "caller" },
    });

    expect(ctx).toEqual({
      brokerId: "alpaca",
      mode: "live",
      modeSource: "selection",
      accountId: "acct-7",
      source: "caller",
    });
  });

  it("uses the schedule's stored selection when the caller passes none", async () => {
    const ctx = await resolveRunBrokerContext({
      env: env({ TENANT_BROKER_ID: "etrade" }),
      environment: "TEST",
      selection: { brokerId: "public", source: "schedule" },
    });

    expect(ctx.brokerId).toBe("public");
    expect(ctx.source).toBe("schedule");
    // Public has no paper mode; the effective-mode resolver records the truth.
    expect(ctx.modeSource).toBeDefined();
  });

  it("accepts the tenant source claimed by the one shared resolution (#6151)", async () => {
    const ctx = await resolveRunBrokerContext({
      env: env({ TENANT_BROKER_ID: "public" }),
      environment: "TEST",
      selection: { brokerId: "alpaca", mode: "paper", source: "tenant" },
    });

    expect(ctx.brokerId).toBe("alpaca");
    expect(ctx.source).toBe("tenant");
    expect(ctx.mode).toBe("paper");
  });

  it("falls back to the tenant's broker, never to a literal", async () => {
    const ctx = await resolveRunBrokerContext({ env: env(), environment: "TEST" });

    expect(ctx.brokerId).toBe("alpaca");
    expect(ctx.source).toBe("tenant");
    expect(ctx.mode).toBe("paper");
    expect(ctx.accountId).toBeNull();
  });

  it("ignores an unknown broker id instead of guessing one", async () => {
    const ctx = await resolveRunBrokerContext({
      env: env({ TENANT_BROKER_ID: "etrade" }),
      environment: "TEST",
      selection: { brokerId: "tradier" },
    });

    expect(ctx.brokerId).toBe("etrade");
    expect(ctx.source).toBe("tenant");
  });

  it("refuses a broker that does not declare the required capability", async () => {
    await expect(
      resolveRunBrokerContext({
        env: env(),
        environment: "TEST",
        selection: { brokerId: "tastytrade" },
        requireCapability: "optionChains",
      }),
    ).rejects.toThrow(/FAILURE_BROKER_UNAVAILABLE.*tastytrade does not declare optionChains/);
  });

  it("fails closed when the mode cannot be resolved", async () => {
    await expect(
      // Public without an environment cannot infer a mode, and no explicit mode
      // is supplied: the run must not start under a guessed mode.
      resolveRunBrokerContext({
        env: env(),
        environment: undefined,
        selection: { brokerId: "public" },
      }),
    ).rejects.toThrow(/FAILURE_BROKER_UNAVAILABLE/);
  });
});
