/**
 * Issue #3169 (program #2218) — tenant channel gate + dispatch
 * enforcement.
 *
 * The gate is pure: a tenant's channel config decides, per
 * channel, whether dispatch may proceed. The two funnel
 * functions consult it when a caller supplies it:
 *
 *  - deliverScreeningContent (direct path: goal screens,
 *    bundles, research discovery): a disabled channel records a
 *    per-channel failure and its sender is NEVER attempted;
 *    other channels still send.
 *  - deliverDiscoveryDirect (scheduled direct path): same
 *    refusal, in that funnel's coded-error idiom.
 *
 * Voice is not a push channel and is never gated (its existing
 * explanation is unchanged). Copilot card and Docs have no push
 * dispatch funnel today, so no dispatch function maps them —
 * their flags are configuration only until a render/dispatch
 * funnel exists for them (named remainder, #3169 PR body).
 */
import { describe, it, expect, vi } from "vitest";
import {
  channelDisabledError,
  channelGateFromConfig,
  mapScreeningChannelToTenantChannel,
} from "../src/services/tenantChannelGate";
import {
  deliverDiscoveryDirect,
  deliverScreeningContent,
} from "../src/services/screeningDelivery";
import { resolveScreenerFollowupConfig } from "../src/services/screenerFollowups";
import type { ScreenerRunOutcome } from "../src/services/screenerFollowups";
import { DEFAULT_TENANT_CHANNELS } from "../src/data/tenantChannelPorts";

const GATE = channelGateFromConfig("tenant-a", {
  ...DEFAULT_TENANT_CHANNELS,
  slack: false,
});

describe("tenant channel gate: pure rules (#3169)", () => {
  it("permits enabled channels and refuses disabled ones", () => {
    expect(GATE.isEnabled("email")).toBe(true);
    expect(GATE.isEnabled("slack")).toBe(false);
    expect(GATE.isEnabled("webhook")).toBe(true);
    expect(GATE.isEnabled("copilot")).toBe(true);
    expect(GATE.isEnabled("docs")).toBe(true);
    expect(GATE.tenantId).toBe("tenant-a");
  });

  it("names the channel and tenant in the refusal", () => {
    expect(channelDisabledError("slack", "tenant-a")).toContain('"slack"');
    expect(channelDisabledError("slack", "tenant-a")).toContain("tenant-a");
  });

  it("maps only the push channels; voice maps to nothing", () => {
    expect(mapScreeningChannelToTenantChannel("slack")).toBe("slack");
    expect(mapScreeningChannelToTenantChannel("email")).toBe("email");
    expect(mapScreeningChannelToTenantChannel("webhook")).toBe("webhook");
    expect(mapScreeningChannelToTenantChannel("voice")).toBeNull();
  });
});

describe("tenant channel gate: deliverScreeningContent (#3169)", () => {
  it("refuses a disabled channel without attempting its sender; other channels still send", async () => {
    const slack = vi.fn(async () => ({ ok: true }));
    const email = vi.fn(async () => ({ ok: true }));
    const results = await deliverScreeningContent({
      channels: ["slack", "email"],
      subject: "s",
      text: "t",
      event: "test.event",
      emailTo: "owner@example.com",
      senders: { slack, email },
      channelGate: GATE,
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      channel: "slack",
      ok: false,
      error: channelDisabledError("slack", "tenant-a"),
    });
    expect(results[1]).toEqual({ channel: "email", ok: true });
    expect(slack).not.toHaveBeenCalled();
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("without a gate, behavior is unchanged (no refusal, sender attempted)", async () => {
    const slack = vi.fn(async () => ({ ok: true }));
    const results = await deliverScreeningContent({
      channels: ["slack"],
      subject: "s",
      text: "t",
      event: "test.event",
      senders: { slack },
    });
    expect(results).toEqual([{ channel: "slack", ok: true }]);
    expect(slack).toHaveBeenCalledTimes(1);
  });
});

describe("tenant channel gate: deliverDiscoveryDirect (#3169)", () => {
  function outcome(): ScreenerRunOutcome {
    return {
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      emailTo: "owner@example.com",
      slackChannel: "C123",
      webhookUrl: "https://example.com/hook",
    } as unknown as ScreenerRunOutcome;
  }

  it("refuses a disabled channel without calling the port; other channels still send", async () => {
    const deliver = vi.fn(async () => ({ ok: true }));
    const results = await deliverDiscoveryDirect({
      port: { deliver },
      outcome: outcome(),
      config: resolveScreenerFollowupConfig({}),
      userLogin: "alice",
      channelGate: GATE,
    });
    expect(deliver.mock.calls.map((c) => (c[0] as { channel: string }).channel)).toEqual([
      "email",
      "webhook",
    ]);
    const slackResult = results.find((r) => r.channel === "slack")!;
    expect(slackResult.ok).toBe(false);
    expect(slackResult.error).toContain("FAILURE_DELIVERY_CHANNEL_DISABLED");
    expect(slackResult.error).toContain("tenant-a");
    expect(results.find((r) => r.channel === "email")!.ok).toBe(true);
    expect(results.find((r) => r.channel === "webhook")!.ok).toBe(true);
  });
});
