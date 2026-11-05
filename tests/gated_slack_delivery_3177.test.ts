/**
 * Issue #3177 (program #2218) — one gated Slack dispatch for the direct
 * publishers that bypassed the delivery funnels (#3169 remainder).
 *
 * `deliverGatedSlack` is the single dispatch every direct
 * `deliverScreenerToSlackA2A` call site routes through:
 *
 *  - With a verified run-owner login, an explicitly disabled Slack for
 *    that login's tenant is refused with the typed error and the master
 *    sender is NEVER attempted; a null gate (unbound store, no account
 *    row, resolution failure) keeps prior behavior.
 *  - Without a login (system alerts), the gate is never consulted and
 *    the send goes straight to the master sender.
 *  - The send itself always goes through the master sender
 *    (`deliverScreenerToSlack`: A2A first, direct fallback), so a site
 *    that used to send nothing when cfpay was unconfigured now falls
 *    back to direct Slack instead of dropping the delivery silently.
 *  - Channel resolution lives here: explicit channel, then
 *    SCREENER_SLACK_CHANNEL, then SLACK_CHANNEL. An undefined channel
 *    passes through untouched so the direct leg's SLACK_CHANNEL_ID
 *    fallback still applies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  channelDisabledError,
  channelGateFromConfig,
  resolveTenantChannelGate,
} from "../src/services/tenantChannelGate";
import { deliverGatedSlack } from "../src/services/gatedSlackDelivery";
import { deliverScreenerToSlack } from "../src/services/screenerSlackDelivery";
import { DEFAULT_TENANT_CHANNELS } from "../src/data/tenantChannelPorts";

const mockMaster = vi.mocked(deliverScreenerToSlack);
const mockResolveGate = vi.mocked(resolveTenantChannelGate);

vi.mock("../src/services/screenerSlackDelivery", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deliverScreenerToSlack: vi.fn(async () => ({ ok: true as const, method: "a2a" as const })),
  };
});

vi.mock("../src/services/tenantChannelGate", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveTenantChannelGate: vi.fn(async () => null),
  };
});

const env = {
  SCREENER_SLACK_CHANNEL: "C-env-screener",
  SLACK_CHANNEL: "C-env-slack",
} as unknown as Record<string, unknown>;

describe("deliverGatedSlack (#3177)", () => {
  beforeEach(() => {
    mockMaster.mockClear();
    mockResolveGate.mockClear();
    mockResolveGate.mockResolvedValue(null);
    mockMaster.mockResolvedValue({ ok: true, method: "a2a" });
  });

  it("refuses a disabled Slack with the typed error and never attempts the sender", async () => {
    mockResolveGate.mockResolvedValueOnce(
      channelGateFromConfig("tenant-a", { ...DEFAULT_TENANT_CHANNELS, slack: false }),
    );
    const result = await deliverGatedSlack(env, { userLogin: "alice", text: "t" });
    expect(result).toEqual({
      ok: false,
      error: channelDisabledError("slack", "tenant-a"),
    });
    expect(mockMaster).not.toHaveBeenCalled();
  });

  it("sends via the master sender when Slack is enabled for the tenant", async () => {
    mockResolveGate.mockResolvedValueOnce(
      channelGateFromConfig("tenant-a", { ...DEFAULT_TENANT_CHANNELS, slack: true }),
    );
    const result = await deliverGatedSlack(env, { userLogin: "alice", text: "t" });
    expect(result.ok).toBe(true);
    expect(mockMaster).toHaveBeenCalledTimes(1);
    expect(mockMaster.mock.calls[0][1]).toEqual({ text: "t", channel: "C-env-screener" });
  });

  it("keeps prior behavior on a null gate (unbound store / no account row / resolution failure)", async () => {
    mockResolveGate.mockResolvedValueOnce(null);
    const result = await deliverGatedSlack(env, { userLogin: "alice", text: "t" });
    expect(result.ok).toBe(true);
    expect(mockMaster).toHaveBeenCalledTimes(1);
  });

  it("keeps prior behavior when gate resolution itself throws", async () => {
    mockResolveGate.mockRejectedValueOnce(new Error("store down"));
    const result = await deliverGatedSlack(env, { userLogin: "alice", text: "t" });
    expect(result.ok).toBe(true);
    expect(mockMaster).toHaveBeenCalledTimes(1);
  });

  it("never consults the gate without a login (system alerts) and sends via master", async () => {
    const result = await deliverGatedSlack(env, { text: "alert" });
    expect(result.ok).toBe(true);
    expect(mockResolveGate).not.toHaveBeenCalled();
    expect(mockMaster).toHaveBeenCalledTimes(1);
  });

  it("treats a blank login as no login", async () => {
    await deliverGatedSlack(env, { userLogin: "   ", text: "alert" });
    expect(mockResolveGate).not.toHaveBeenCalled();
    expect(mockMaster).toHaveBeenCalledTimes(1);
  });

  it("resolves the channel: explicit wins, then SCREENER_SLACK_CHANNEL, then SLACK_CHANNEL", async () => {
    await deliverGatedSlack(env, { userLogin: "alice", text: "t", channel: "C-explicit" });
    expect(mockMaster.mock.calls[0][1]).toEqual({ text: "t", channel: "C-explicit" });

    await deliverGatedSlack(env, { userLogin: "alice", text: "t" });
    expect(mockMaster.mock.calls[1][1]).toEqual({ text: "t", channel: "C-env-screener" });

    await deliverGatedSlack({ SLACK_CHANNEL: "C-only-slack" }, { userLogin: "alice", text: "t" });
    expect(mockMaster.mock.calls[2][1]).toEqual({ text: "t", channel: "C-only-slack" });

    await deliverGatedSlack({}, { userLogin: "alice", text: "t" });
    expect(mockMaster.mock.calls[3][1]).toEqual({ text: "t" });
  });

  it("passes pdf and files through to the master sender", async () => {
    const pdf = { bytes: new Uint8Array([1]), fileName: "r.pdf", title: "R", comment: "c" };
    const files = [{ bytes: new Uint8Array([2]), fileName: "r.xlsx", title: "X" }];
    await deliverGatedSlack(env, { userLogin: "alice", text: "t", pdf, files });
    expect(mockMaster.mock.calls[0][1]).toEqual({
      text: "t",
      channel: "C-env-screener",
      pdf,
      files,
    });
  });

  it("propagates a master-send failure as ok:false with the sender error", async () => {
    mockMaster.mockResolvedValueOnce({ ok: false, method: "direct", error: "boom" });
    const result = await deliverGatedSlack(env, { userLogin: "alice", text: "t" });
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});
