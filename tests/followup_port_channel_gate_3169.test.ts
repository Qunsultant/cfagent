/**
 * Issue #3169 (program #2218) — tenant channel gate in the
 * followup delivery port (the chain + scheduled delivery
 * funnel).
 *
 * The port refuses a tenant-disabled channel before any
 * artifact is fetched or any transport is attempted. The gate
 * resolves from the injected seam in tests; in production it
 * resolves from deps.env (commercial account row for the
 * verified login + channel store). Only the refusal path is
 * tested here — an enabled channel proceeds into the real
 * transports, which the existing delivery suites already cover.
 */
import { describe, it, expect, vi } from "vitest";
import { createFollowupDeliveryPort } from "../src/services/screenerFollowupDelivery";
import { channelGateFromConfig } from "../src/services/tenantChannelGate";
import { DEFAULT_TENANT_CHANNELS } from "../src/data/tenantChannelPorts";
import type { ScreenerRunOutcome } from "../src/services/screenerFollowups";

function outcome(): ScreenerRunOutcome {
  return {
    kind: "stock",
    trigger: "scheduled",
    success: true,
    pdfKeys: [],
  } as unknown as ScreenerRunOutcome;
}

function portWithGate(gate: ReturnType<typeof channelGateFromConfig> | null) {
  const seen: string[] = [];
  const port = createFollowupDeliveryPort({
    env: {},
    getOrm: () => ({}) as never,
    getScreenerAgent: () => ({}) as never,
    getTenantChannelGate: async (userLogin: string) => {
      seen.push(userLogin);
      return gate;
    },
  });
  return { port, seen };
}

describe("followup delivery port: tenant channel gate (#3169)", () => {
  it("deliver() refuses a disabled channel before any transport, for the delivery's login", async () => {
    const gate = channelGateFromConfig("tenant-a", {
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
      email: false,
      webhook: false,
    });
    const { port, seen } = portWithGate(gate);
    for (const channel of ["slack", "email", "webhook"] as const) {
      const r = await port.deliver({ channel, userLogin: "alice", outcome: outcome(), artifacts: [] });
      expect(r.ok).toBe(false);
      expect(r.error).toContain(`"${channel}"`);
      expect(r.error).toContain("tenant-a");
    }
    expect(seen).toEqual(["alice", "alice", "alice"]);
  });

  it("notify() refuses a disabled channel", async () => {
    const gate = channelGateFromConfig("tenant-a", {
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
    const { port } = portWithGate(gate);
    const r = await port.notify({ channel: "slack", userLogin: "alice", text: "hello" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"slack"');
    expect(r.error).toContain("tenant-a");
  });

  it("a null gate means ungated: the port proceeds past the gate (into its existing not-configured path)", async () => {
    // With no gate and no email configured, notify(email)
    // reaches the existing "not configured" error — proof the
    // gate did not refuse it.
    const { port } = portWithGate(null);
    const r = await port.notify({ channel: "email", userLogin: "alice", text: "hello" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not configured");
    expect(r.error).not.toContain("disabled for tenant");
  });
});
