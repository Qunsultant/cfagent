/**
 * Issue #4610 (G15, sub-issue of #4608 / #2856):
 * Slack per-tenant channel mapping (store + route + delivery enforcement).
 *
 * Acceptance:
 * - A Slack delivery goes only to the run tenant's mapped channel;
 * - An unmapped tenant's delivery is refused + audited (`delivery.recipient_refused`).
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import {
  DEFAULT_TENANT_CHANNELS,
  normalizeTenantSlackChannel,
} from "../src/data/tenantChannelPorts";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { channelGateFromConfig } from "../src/services/tenantChannelGate";
import { resolveAndVerifySlackRecipientAtDelivery } from "../src/services/channelRecipientVerification";
import { deliverGatedSlack } from "../src/services/gatedSlackDelivery";
import { createFollowupDeliveryPort } from "../src/services/screenerFollowupDelivery";
import {
  deliverDiscoveryDirect,
  deliverScreeningContent,
} from "../src/services/screeningDelivery";
import {
  publishScreenerCompleted,
  publishScreenerFailed,
} from "../src/events/screenerPublishers";
import {
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import type { Env } from "../src/types";

function makeOutcome(overrides: Partial<ScreenerRunOutcome> = {}): ScreenerRunOutcome {
  return {
    kind: "stock",
    status: "completed",
    universe: "SP500",
    sector: "TECH",
    trigger: "scheduled",
    timestamp: "2026-11-15T12:00:00.000Z",
    deliveryId: "scheduled:tenant-a:TECH:2026-11-15T12:00",
    scheduleId: "sched-1",
    tenantId: "tenant-a",
    totalScanned: 25,
    matchedCount: 1,
    opportunities: [
      {
        symbol: "MSFT",
        companyName: "Microsoft Corp.",
        sector: "TECH",
        lastPrice: 420.0,
        changePercent: 1.4,
        volume: 30_000_000,
        momentumScore: 86,
        signal: "BULLISH",
      },
    ],
    ...overrides,
  };
}

describe("Issue #4610 (G15): Per-tenant Slack channel mapping — store & route", () => {
  it("validates, stores, updates, and clears per-tenant Slack channel mappings per tenant", async () => {
    expect(normalizeTenantSlackChannel("  C012345TENANTA ")).toEqual({
      ok: true,
      slackChannel: "C012345TENANTA",
    });
    expect(normalizeTenantSlackChannel(null)).toEqual({
      ok: true,
      slackChannel: null,
    });
    expect(normalizeTenantSlackChannel("")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(normalizeTenantSlackChannel("https://hooks.slack.com/services/T/B/X")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(normalizeTenantSlackChannel("xoxb-secret-token")).toEqual({
      ok: false,
      error: expect.any(String),
    });

    const store = new InMemoryTenantChannelAdapter();
    expect(await store.getTenantSlackChannel("tenant-a")).toBeNull();
    expect(await store.setTenantSlackChannel("tenant-a", "C-TENANT-A")).toBe("C-TENANT-A");
    expect(await store.getTenantSlackChannel("tenant-a")).toBe("C-TENANT-A");
    expect(await store.getTenantSlackChannel("tenant-b")).toBeNull();

    expect(await store.setTenantSlackChannel("tenant-a", null)).toBeNull();
    expect(await store.getTenantSlackChannel("tenant-a")).toBeNull();
  });

  it("exposes operator-gated /platform-channels/:id/slack-channel and /platform-channels/:id/channels mapping routes", async () => {
    const channels = new InMemoryTenantChannelAdapter();
    const directory = new InMemoryTenantDirectoryAdapter();
    directory.seedTenant("tenant-a", ["alice"]);
    directory.seedTenant("tenant-b", ["bob"]);
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = {
      env: { COMMERCIAL_STORE_OPERATORS: "op" },
      channels,
      directory,
      // #5867: audit-before-write needs a working IAAA audit store.
      auditStore: createMemoryAuditStore(),
      audit: (type: string, _agent: "orchestrator", payload: Record<string, unknown>) =>
        audits.push({ type, payload }),
    };

    const call = async (path: string, method: string, login: string | null, body?: unknown) => {
      const res = await handlePlatformChannelRoutes(
        new Request(`https://worker.test${path}`, {
          method,
          headers: {
            ...(login ? { "x-user-login": login } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        new URL(`https://worker.test${path}`),
        path,
        "sess-1",
        ctx,
      );
      return { res, body: (await res?.json().catch(() => ({}))) as Record<string, unknown> };
    };

    // Unmapped initially
    const initialGet = await call("/platform-channels/tenant-a/slack-channel", "GET", "op");
    expect(initialGet.res?.status).toBe(200);
    expect(initialGet.body).toEqual({ tenantId: "tenant-a", slackChannel: null });

    // Non-operator forbidden
    const forbidden = await call("/platform-channels/tenant-a/slack-channel", "PUT", "alice", {
      slackChannel: "C-TENANT-A",
    });
    expect(forbidden.res?.status).toBe(403);

    // Operator sets per-tenant Slack channel mapping
    const putRes = await call("/platform-channels/tenant-a/slack-channel", "PUT", "op", {
      slackChannel: "C-TENANT-A",
    });
    expect(putRes.res?.status).toBe(200);
    expect(putRes.body).toEqual({ tenantId: "tenant-a", slackChannel: "C-TENANT-A" });

    // GET /platform-channels/:id includes slackChannel when mapped
    const readTenantA = await call("/platform-channels/tenant-a", "GET", "op");
    expect(readTenantA.res?.status).toBe(200);
    expect(readTenantA.body).toEqual({
      tenantId: "tenant-a",
      channels: DEFAULT_TENANT_CHANNELS,
      slackChannel: "C-TENANT-A",
    });

    // Rejects invalid slackChannel (URL/token/empty)
    const badPut = await call("/platform-channels/tenant-a/slack-channel", "PUT", "op", {
      slackChannel: "https://hooks.slack.com/services/T/B/X",
    });
    expect(badPut.res?.status).toBe(400);

    // PATCH /platform-channels/:id/channels also accepts slackChannel
    const patchRes = await call("/platform-channels/tenant-b/channels", "PATCH", "op", {
      channels: { slack: true },
      slackChannel: "C-TENANT-B",
    });
    expect(patchRes.res?.status).toBe(200);
    expect(patchRes.body.slackChannel).toBe("C-TENANT-B");
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Issue #4610 (G15): Slack delivery goes only to the run tenant's mapped channel; unmapped tenant is refused + audited", () => {
  it("resolveAndVerifySlackRecipientAtDelivery routes to the tenant's mapped channel and refuses + audits unmapped tenants or cross-tenant channels", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const store = new InMemoryTenantChannelAdapter();
    await store.setTenantSlackChannel("tenant-a", "C-TENANT-A");

    // 1. Mapped tenant (tenant-a) overrides deployment-global fallback (C-GLOBAL) -> C-TENANT-A
    const mapped = await resolveAndVerifySlackRecipientAtDelivery({
      envFallbackChannel: "C-GLOBAL",
      run: { tenantId: "tenant-a", runId: "run-a", scheduleId: "sched-a", userLogin: "alice" },
      tenantChannelStore: store,
      layer: "followup_port.deliver",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(mapped).toEqual({ allowed: true, channel: "C-TENANT-A" });
    expect(audits).toHaveLength(0);

    // 2. Unmapped tenant (tenant-b) is refused + audited even when C-GLOBAL is set
    const unmapped = await resolveAndVerifySlackRecipientAtDelivery({
      envFallbackChannel: "C-GLOBAL",
      run: { tenantId: "tenant-b", runId: "run-b", scheduleId: "sched-b", userLogin: "bob" },
      tenantChannelStore: store,
      layer: "followup_port.deliver",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(unmapped.allowed).toBe(false);
    if (!unmapped.allowed) {
      expect(unmapped.reason).toBe("slack_tenant_channel_unmapped");
      expect(unmapped.code).toBe("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
    }
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({
      channel: "slack",
      tenantId: "tenant-b",
      runId: "run-b",
      userLogin: "bob",
      layer: "followup_port.deliver",
      reason: "slack_tenant_channel_unmapped",
    });

    // 3. Mapped tenant (tenant-a) attempting to send to tenant-b's channel is refused + audited
    const crossTenant = await resolveAndVerifySlackRecipientAtDelivery({
      requestedChannel: "C-TENANT-B",
      envFallbackChannel: "C-GLOBAL",
      run: { tenantId: "tenant-a", runId: "run-a", scheduleId: "sched-a", userLogin: "alice" },
      tenantChannelStore: store,
      layer: "followup_port.deliver",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(crossTenant.allowed).toBe(false);
    if (!crossTenant.allowed) {
      expect(crossTenant.reason).toBe("slack_channel_not_in_tenant_run");
    }
    expect(audits).toHaveLength(2);
  });

  it("followup_port.deliver, followup_port.notify, discovery_direct, screening_content, gated_slack, and publisher enforce per-tenant Slack mapping and refuse + audit unmapped tenants", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const env = {
      SCREENER_SLACK_CHANNEL: "C-DEPLOYMENT-GLOBAL",
      TENANT_SLACK_CHANNELS_JSON: JSON.stringify({
        "tenant-a": "C-TENANT-A",
      }),
    } as unknown as Env;

    // 1. FollowupDeliveryPort: unmapped tenant-b is refused + audited on deliver() and notify()
    const portB = createFollowupDeliveryPort({
      env,
      getOrm: () => undefined as never,
      getScreenerAgent: () => null as never,
      getTenantChannelGate: async () =>
        channelGateFromConfig("tenant-b", DEFAULT_TENANT_CHANNELS, null),
      audit: (type, payload) => audits.push({ type, payload }),
    });

    const deliverB = await portB.deliver({
      channel: "slack",
      userLogin: "bob",
      outcome: makeOutcome({
        tenantId: "tenant-b",
        deliveryId: "scheduled:tenant-b:TECH:2026-11-15T12:00",
      }),
      artifacts: [],
    });
    expect(deliverB.ok).toBe(false);
    expect(deliverB.error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");

    const notifyB = await portB.notify({
      channel: "slack",
      userLogin: "bob",
      text: "Screen failed",
      tenantId: "tenant-b",
      runId: "run-b",
      scheduleId: "sched-b",
    });
    expect(notifyB.ok).toBe(false);
    expect(notifyB.error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");

    // 2. ScreeningContent & DiscoveryDirect: mapped tenant-a delivers ONLY to C-TENANT-A; unmapped tenant-b is refused + audited
    const slackSends: Array<{ text: string; channel?: string }> = [];
    const gateA = channelGateFromConfig("tenant-a", DEFAULT_TENANT_CHANNELS, "C-TENANT-A");
    const gateB = channelGateFromConfig("tenant-b", DEFAULT_TENANT_CHANNELS, null);

    const contentA = await deliverScreeningContent({
      channels: ["slack"],
      subject: "Screen",
      text: "Opportunities",
      event: "screener.completed",
      senders: {
        slack: async (input) => {
          slackSends.push(input);
          return { ok: true };
        },
      },
      userLogin: "alice",
      tenantId: "tenant-a",
      runId: "run-a",
      channelGate: gateA,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(contentA).toEqual([{ channel: "slack", ok: true }]);
    expect(slackSends).toEqual([{ text: "Opportunities", channel: "C-TENANT-A" }]);

    const contentB = await deliverScreeningContent({
      channels: ["slack"],
      subject: "Screen",
      text: "Opportunities",
      event: "screener.completed",
      senders: {
        slack: async (input) => {
          slackSends.push(input);
          return { ok: true };
        },
      },
      userLogin: "bob",
      tenantId: "tenant-b",
      runId: "run-b",
      channelGate: gateB,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(contentB[0].ok).toBe(false);
    expect(contentB[0].error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
    expect(slackSends).toHaveLength(1);

    const directDeliverCalls: string[] = [];
    const directB = await deliverDiscoveryDirect({
      port: {
        deliver: async (input) => {
          directDeliverCalls.push(input.outcome.slackChannel ?? "none");
          return { ok: true };
        },
      },
      outcome: makeOutcome({
        tenantId: "tenant-b",
        slackChannel: "C-DEPLOYMENT-GLOBAL",
      }),
      config: resolveScreenerFollowupConfig(env as unknown as Record<string, unknown>),
      userLogin: "bob",
      channelGate: gateB,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(directB[0].ok).toBe(false);
    expect(directB[0].error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
    expect(directDeliverCalls).toHaveLength(0);

    // 3. deliverGatedSlack & publishers refuse + audit unmapped tenant-b when TENANT_SLACK_CHANNELS_JSON is active
    const gatedB = await deliverGatedSlack(env, {
      userLogin: "bob",
      text: "Alert",
      tenantId: "tenant-b",
      runId: "run-b",
      scheduleId: "sched-b",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(gatedB.ok).toBe(false);
    expect(gatedB.error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");

    const ormEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const orm = {
      events: {
        create: (row: { type: string; payload: Record<string, unknown> }) => {
          ormEvents.push({ type: row.type, payload: row.payload });
        },
      },
    } as never;

    await publishScreenerCompleted(
      { env, orm, userLogin: "bob" },
      {
        type: "screener.completed",
        sector: "TECH",
        universe: "SP500",
        totalScanned: 10,
        matchedCount: 0,
        opportunities: [],
        timestamp: "2026-11-15T12:00:00.000Z",
        deliveryId: "scheduled:tenant-b:TECH:2026-11-15T12:00",
        scheduleId: "sched-b",
        tenantId: "tenant-b",
      },
    );

    await publishScreenerFailed(
      { env, orm, userLogin: "bob" },
      {
        type: "screener.failed",
        sector: "TECH",
        universe: "SP500",
        error: "timeout",
        timestamp: "2026-11-15T12:00:00.000Z",
        deliveryId: "scheduled:tenant-b:TECH:2026-11-15T12:00",
        scheduleId: "sched-b",
        tenantId: "tenant-b",
      },
    );

    expect(audits.map((a) => a.payload.layer)).toEqual([
      "followup_port.deliver",
      "followup_port.notify",
      "screening_content",
      "discovery_direct",
      "gated_slack",
    ]);
    const publisherRefusals = ormEvents.filter((e) => e.type === "delivery.recipient_refused");
    expect(publisherRefusals).toHaveLength(2);
    expect(publisherRefusals[0].payload).toMatchObject({
      channel: "slack",
      layer: "publisher",
      tenantId: "tenant-b",
      reason: "slack_tenant_channel_unmapped",
    });
  });
});
