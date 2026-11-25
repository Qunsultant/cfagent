/**
 * Issue #4611 (G21, sub of #4608) — Webhook recipient URL binding:
 * per-tenant/per-schedule URL + run check at send time.
 *
 * Acceptance:
 * - A webhook fires ONLY to the URL bound to its `tenant + schedule + run`;
 *   HMAC-SHA256 signing in `ETradeWebhookService.dispatchOutboundWebhook`
 *   remains transport-integrity only.
 * - Any mismatched URL (wrong URL, wrong tenant, wrong scheduleId, wrong runId,
 *   or unmapped tenant/schedule when bindings are active) is refused with
 *   `FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED` and audited (`delivery.recipient_refused`)
 *   at the refusing layer (`executor.deliver`, `executor.notify`,
 *   `followup_port.deliver`, `followup_port.notify`, `discovery_direct`,
 *   `screening_content`, `publisher`, and `webhook_service`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryTenantChannelAdapter,
} from "../src/data/inMemoryTenantChannelAdapter";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  normalizeTenantWebhookUrl,
  DEFAULT_TENANT_CHANNELS,
} from "../src/data/tenantChannelPorts";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { channelGateFromConfig } from "../src/services/tenantChannelGate";
import {
  resolveAndVerifyWebhookRecipientAtDelivery,
  type ChannelRecipientAuditPayload,
} from "../src/services/channelRecipientVerification";
import { ETradeWebhookService } from "../src/services/tradingWebhooks";
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
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";

function makeOutcome(overrides: Partial<ScreenerRunOutcome> = {}): ScreenerRunOutcome {
  return {
    kind: "stock",
    status: "completed",
    timestamp: "2026-11-15T12:00:00.000Z",
    universe: "TECH",
    sector: "ALL",
    trigger: "scheduled",
    totalScanned: 25,
    matchedCount: 2,
    opportunities: [
      {
        symbol: "NVDA",
        companyName: "NVIDIA",
        signal: "BULLISH",
        momentumScore: 88,
        lastPrice: 140,
        changePercent: 2.5,
      },
    ],
    deliveryId: "run-4611",
    scheduleId: "sched-morning",
    tenantId: "tenant-alpha",
    ...overrides,
  };
}

describe("Webhook recipient URL binding: per-tenant/per-schedule URL + run check (#4611 / G21)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("validates and stores per-tenant and per-schedule webhook URL bindings via TenantChannelStore and /platform-channels/:id/webhook-url", async () => {
    expect(normalizeTenantWebhookUrl("https://hooks.alpha.example.com/screen")).toEqual({
      ok: true,
      webhookUrl: "https://hooks.alpha.example.com/screen",
    });
    expect(normalizeTenantWebhookUrl(null)).toEqual({ ok: true, webhookUrl: null });
    expect(normalizeTenantWebhookUrl("")).toMatchObject({ ok: false });
    expect(normalizeTenantWebhookUrl("http://127.0.0.1:8080/hook")).toMatchObject({ ok: false });
    expect(normalizeTenantWebhookUrl("http://169.254.169.254/latest")).toMatchObject({ ok: false });

    const channels = new InMemoryTenantChannelAdapter();
    const directory = new InMemoryTenantDirectoryAdapter();
    directory.seedTenant("tenant-alpha", ["alice"]);
    directory.seedTenant("tenant-beta", ["bob"]);

    const ctx = {
      env: { COMMERCIAL_STORE_OPERATORS: "op" },
      channels,
      directory,
      // #5867: audit-before-write needs a working IAAA audit store.
      auditStore: createMemoryAuditStore(),
      operators: { listOperators: async () => [] },
    };

    const callRoute = async (path: string, method: string, body?: unknown) => {
      const url = new URL(`https://worker.test${path}`);
      const res = await handlePlatformChannelRoutes(
        new Request(url.toString(), {
          method,
          headers: {
            "x-user-login": "op",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        url,
        url.pathname,
        "sess-1",
        ctx as never,
      );
      return {
        status: res?.status,
        json: (await res?.json().catch(() => ({}))) as Record<string, unknown>,
      };
    };

    // Unbound initially
    const initial = await callRoute("/platform-channels/tenant-alpha/webhook-url", "GET");
    expect(initial.status).toBe(200);
    expect(initial.json).toEqual({ tenantId: "tenant-alpha", webhookUrl: null });

    // Bind tenant default webhook URL
    const setDefault = await callRoute("/platform-channels/tenant-alpha/webhook-url", "PUT", {
      webhookUrl: "https://hooks.alpha.example.com/default",
    });
    expect(setDefault.status).toBe(200);
    expect(setDefault.json).toEqual({
      tenantId: "tenant-alpha",
      webhookUrl: "https://hooks.alpha.example.com/default",
    });

    // Bind per-schedule webhook URL for sched-morning
    const setSchedule = await callRoute("/platform-channels/tenant-alpha/webhook-url", "PUT", {
      scheduleId: "sched-morning",
      webhookUrl: "https://hooks.alpha.example.com/sched-morning",
    });
    expect(setSchedule.status).toBe(200);
    expect(setSchedule.json).toEqual({
      tenantId: "tenant-alpha",
      scheduleId: "sched-morning",
      webhookUrl: "https://hooks.alpha.example.com/sched-morning",
    });

    // Read schedule-specific vs default URL
    const readSched = await callRoute(
      "/platform-channels/tenant-alpha/webhook-url?scheduleId=sched-morning",
      "GET",
    );
    expect(readSched.json.webhookUrl).toBe("https://hooks.alpha.example.com/sched-morning");

    const readOtherSched = await callRoute(
      "/platform-channels/tenant-alpha/webhook-url?scheduleId=sched-evening",
      "GET",
    );
    expect(readOtherSched.json.webhookUrl).toBe("https://hooks.alpha.example.com/default");

    // SSRF target rejected with 400
    const badUrl = await callRoute("/platform-channels/tenant-alpha/webhook-url", "PUT", {
      webhookUrl: "http://localhost:3000/internal",
    });
    expect(badUrl.status).toBe(400);
  });

  it("resolveAndVerifyWebhookRecipientAtDelivery binds to tenant+schedule+run and refuses+audits any URL, schedule, run, or tenant mismatch", async () => {
    const store = new InMemoryTenantChannelAdapter();
    await store.setTenantWebhookUrl(
      "tenant-alpha",
      "https://hooks.alpha.example.com/sched-morning",
      "sched-morning",
    );

    const audits: ChannelRecipientAuditPayload[] = [];
    // 1. Matching tenant + schedule + run succeeds and resolves the bound URL (ignoring deployment-global fallback)
    const okRes = await resolveAndVerifyWebhookRecipientAtDelivery({
      envFallbackUrl: "https://global.example.com/shared-hook",
      run: {
        tenantId: "tenant-alpha",
        scheduleId: "sched-morning",
        runId: "run-4611",
        userLogin: "alice",
      },
      tenantChannelStore: store,
      layer: "followup_port.deliver",
      audit: (_t, p) => audits.push(p),
    });
    expect(okRes).toEqual({
      allowed: true,
      url: "https://hooks.alpha.example.com/sched-morning",
    });
    expect(audits).toHaveLength(0);

    // 2. Wrong schedule on tenant-alpha (no default fallback) -> refused with recipient_schedule_mismatch
    const wrongSchedule = await resolveAndVerifyWebhookRecipientAtDelivery({
      envFallbackUrl: "https://global.example.com/shared-hook",
      run: {
        tenantId: "tenant-alpha",
        scheduleId: "sched-other",
        runId: "run-4611",
        userLogin: "alice",
      },
      tenantChannelStore: store,
      layer: "followup_port.deliver",
      audit: (_t, p) => audits.push(p),
    });
    expect(wrongSchedule.allowed).toBe(false);
    if (!wrongSchedule.allowed) {
      expect(wrongSchedule.reason).toBe("recipient_schedule_mismatch");
      expect(wrongSchedule.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");
    }
    expect(audits).toHaveLength(1);

    // 3. Mismatched caller-supplied URL on bound schedule -> refused with webhook_url_not_in_tenant_run
    const wrongUrl = await resolveAndVerifyWebhookRecipientAtDelivery({
      requestedUrl: "https://hooks.beta.example.com/hijack",
      run: {
        tenantId: "tenant-alpha",
        scheduleId: "sched-morning",
        runId: "run-4611",
        userLogin: "alice",
      },
      tenantChannelStore: store,
      layer: "followup_port.deliver",
      audit: (_t, p) => audits.push(p),
    });
    expect(wrongUrl.allowed).toBe(false);
    if (!wrongUrl.allowed) {
      expect(wrongUrl.reason).toBe("webhook_url_not_in_tenant_run");
    }
    expect(audits).toHaveLength(2);

    // 4. Unmapped tenant-beta -> refused with webhook_tenant_url_unmapped (never falls back to global URL)
    const unmappedTenant = await resolveAndVerifyWebhookRecipientAtDelivery({
      envFallbackUrl: "https://global.example.com/shared-hook",
      run: {
        tenantId: "tenant-beta",
        scheduleId: "sched-morning",
        runId: "run-4611",
        userLogin: "bob",
      },
      tenantChannelStore: store,
      layer: "followup_port.deliver",
      audit: (_t, p) => audits.push(p),
    });
    expect(unmappedTenant.allowed).toBe(false);
    if (!unmappedTenant.allowed) {
      expect(unmappedTenant.reason).toBe("webhook_tenant_url_unmapped");
    }
    expect(audits).toHaveLength(3);

    // 5. Run mismatch via TENANT_WEBHOOK_URLS_JSON -> refused with recipient_run_mismatch
    const wrongRun = await resolveAndVerifyWebhookRecipientAtDelivery({
      env: {
        TENANT_WEBHOOK_URLS_JSON: JSON.stringify({
          "tenant-alpha": {
            schedules: { "sched-morning": "https://hooks.alpha.example.com/sched-morning" },
            runId: "run-4611",
          },
        }),
      },
      run: {
        tenantId: "tenant-alpha",
        scheduleId: "sched-morning",
        runId: "run-stale-999",
        userLogin: "alice",
      },
      layer: "executor.deliver",
      audit: (_t, p) => audits.push(p),
    });
    expect(wrongRun.allowed).toBe(false);
    if (!wrongRun.allowed) {
      expect(wrongRun.reason).toBe("recipient_run_mismatch");
    }
    expect(audits).toHaveLength(4);
  });

  it("ETradeWebhookService.dispatchOutboundWebhook enforces tenant+schedule+run URL binding before HMAC signing (signing is transport-integrity only)", async () => {
    const postedUrls: string[] = [];
    const postedHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      postedUrls.push(String(input));
      const h = (init?.headers ?? {}) as Record<string, string>;
      postedHeaders.push(h);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const d1Mock = new MockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    // #6102: the refusal audit writes to D1 now, fire-and-forget from
    // the sync audit callback — poll until the row lands.
    async function pollRefused(expected: number) {
      let rows: Array<{ id: string; type: string; payload: Record<string, unknown> }> = [];
      for (let i = 0; i < 50; i++) {
        rows = (await d1Store.findMany({ where: { type: "delivery.recipient_refused" } })).map((r) => ({
          id: r.id,
          type: r.type,
          payload: JSON.parse(r.payload as unknown as string) as Record<string, unknown>,
        }));
        if (rows.length >= expected) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return rows;
    }

    const env = {
      OUTBOUND_WEBHOOK_URL: "https://global.example.com/shared-hook",
      OUTBOUND_WEBHOOK_SECRET: "super-secret-hmac-key",
      AGENT_DB: d1Mock,
      TENANT_WEBHOOK_URLS_JSON: JSON.stringify({
        "tenant-alpha": {
          schedules: {
            "sched-morning": "https://hooks.alpha.example.com/sched-morning",
          },
          runId: "run-4611",
        },
      }),
    };

    const service = new ETradeWebhookService(undefined, env as never, "alice");

    // 1. Even with a valid signing secret configured, a mismatched URL is refused + audited before fetch
    const refusedUrl = await service.dispatchOutboundWebhook(
      "screener.completed",
      { tenantId: "tenant-alpha", scheduleId: "sched-morning", deliveryId: "run-4611" },
      "https://hooks.beta.example.com/evil",
    );
    expect(refusedUrl.success).toBe(false);
    expect(refusedUrl.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");
    expect(postedUrls).toHaveLength(0);
    const events = await pollRefused(1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("delivery.recipient_refused");
    expect(events[0].payload.reason).toBe("webhook_url_not_in_tenant_run");
    const firstRefusalId = events[0].id;

    // 2. Wrong runId is refused + audited before fetch
    const refusedRun = await service.dispatchOutboundWebhook(
      "screener.completed",
      { tenantId: "tenant-alpha", scheduleId: "sched-morning", deliveryId: "run-wrong" },
    );
    expect(refusedRun.success).toBe(false);
    expect(refusedRun.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");
    expect(postedUrls).toHaveLength(0);
    const events2 = await pollRefused(2);
    expect(events2).toHaveLength(2);
    // #6102: the D1 store's unordered findMany returns rows via
    // idx_mas_events_type_created (type, created_at DESC) — newest
    // first — so positions are NOT dispatch order. Identify the
    // second dispatch's row by id instead: it is the row that was
    // not present after the first refusal.
    const secondRefusal = events2.find((e) => e.id !== firstRefusalId);
    expect(secondRefusal).toBeDefined();
    expect(secondRefusal!.payload.reason).toBe("recipient_run_mismatch");

    // 3. Matching tenant + schedule + run dispatches ONLY to the bound URL with HMAC signature header
    const allowed = await service.dispatchOutboundWebhook(
      "screener.completed",
      { tenantId: "tenant-alpha", scheduleId: "sched-morning", deliveryId: "run-4611" },
    );
    expect(allowed.success).toBe(true);
    expect(allowed.url).toBe("https://hooks.alpha.example.com/sched-morning");
    expect(postedUrls).toEqual(["https://hooks.alpha.example.com/sched-morning"]);
    expect(postedHeaders[0]["X-Signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("enforces tenant+schedule+run webhook URL binding across FollowupDeliveryPort, ScreeningDelivery, and ScreenerPublishers", async () => {
    const postedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      postedUrls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const env = {
      OUTBOUND_WEBHOOK_URL: "https://global.example.com/shared-hook",
      SCREENER_WEBHOOK_URL: "https://global.example.com/shared-hook",
      OUTBOUND_WEBHOOK_SECRET: "hmac-secret-4611",
    };

    const gateAlpha = channelGateFromConfig(
      "tenant-alpha",
      DEFAULT_TENANT_CHANNELS,
      "C-ALPHA",
      null,
      { "sched-morning": "https://hooks.alpha.example.com/sched-morning" },
    );

    const audits: ChannelRecipientAuditPayload[] = [];
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () =>
        ({
          getPdfByKey: async () => null,
          getXlsxByKey: async () => null,
          getCsvByKey: async () => null,
          getOptionsPdfByKey: async () => null,
          getOptionsXlsxByKey: async () => null,
          getOptionsCsvByKey: async () => null,
        }) as never,
      getTenantChannelGate: async () => gateAlpha,
      audit: (_t, p) => audits.push(p),
    });

    // FollowupDeliveryPort: bound schedule fires to tenant+schedule URL (not global URL)
    const portOk = await port.deliver({
      channel: "webhook",
      userLogin: "alice",
      outcome: makeOutcome({ webhookUrl: undefined }),
      artifacts: [],
    });
    expect(portOk.ok).toBe(true);
    expect(postedUrls).toEqual(["https://hooks.alpha.example.com/sched-morning"]);

    // FollowupDeliveryPort: mismatched schedule is refused + audited
    const portWrongSched = await port.deliver({
      channel: "webhook",
      userLogin: "alice",
      outcome: makeOutcome({ scheduleId: "sched-unregistered" }),
      artifacts: [],
    });
    expect(portWrongSched.ok).toBe(false);
    expect(portWrongSched.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");
    expect(postedUrls).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0].layer).toBe("followup_port.deliver");
    expect(audits[0].reason).toBe("recipient_schedule_mismatch");

    // deliverScreeningContent + deliverDiscoveryDirect: verify bound URL resolution & refusal on mismatch
    const senderUrls: Array<string | undefined> = [];
    const contentOk = await deliverScreeningContent({
      channels: ["webhook"],
      subject: "Screen",
      text: "Body",
      event: "screener.completed",
      senders: {
        webhook: async (args: { event: string; data: Record<string, unknown>; url?: string }) => {
          senderUrls.push(args.url);
          return { ok: true };
        },
      },
      userLogin: "alice",
      tenantId: "tenant-alpha",
      scheduleId: "sched-morning",
      runId: "run-4611",
      channelGate: gateAlpha,
      audit: (_t, p) => audits.push(p),
    });
    expect(contentOk).toEqual([{ channel: "webhook", ok: true }]);
    expect(senderUrls).toEqual(["https://hooks.alpha.example.com/sched-morning"]);

    const directRefused = await deliverDiscoveryDirect({
      port: { deliver: async () => ({ ok: true }) },
      outcome: makeOutcome({ webhookUrl: "https://hooks.beta.example.com/other" }),
      config: resolveScreenerFollowupConfig(env),
      userLogin: "alice",
      channelGate: gateAlpha,
      audit: (_t, p) => audits.push(p),
    });
    expect(directRefused[0].ok).toBe(false);
    expect(directRefused[0].error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");
    expect(audits[1].layer).toBe("discovery_direct");
    expect(audits[1].reason).toBe("webhook_url_not_in_tenant_run");

    // ScreenerPublishers: unmapped tenant-beta is refused + audited and never posts to global webhook URL
    const publisherEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const pubEnv = {
      ...env,
      TENANT_WEBHOOK_URLS_JSON: JSON.stringify({
        "tenant-alpha": {
          schedules: { "sched-morning": "https://hooks.alpha.example.com/sched-morning" },
        },
      }),
    };
    await publishScreenerCompleted(
      {
        env: pubEnv as never,
        orm: {
          events: { create: (r: { type: string; payload: Record<string, unknown> }) => publisherEvents.push(r) },
        } as never,
        userLogin: "bob",
      },
      {
        type: "screener.completed",
        timestamp: "2026-11-15T12:00:00.000Z",
        sector: "TECH",
        totalScanned: 10,
        matchedCount: 1,
        opportunities: [],
        deliveryId: "run-4611",
        scheduleId: "sched-morning",
        tenantId: "tenant-beta",
      },
    );
    await publishScreenerFailed(
      {
        env: pubEnv as never,
        orm: {
          events: { create: (r: { type: string; payload: Record<string, unknown> }) => publisherEvents.push(r) },
        } as never,
        userLogin: "bob",
      },
      {
        type: "screener.failed",
        timestamp: "2026-11-15T12:00:00.000Z",
        sector: "TECH",
        error: "timeout",
        deliveryId: "run-4611",
        scheduleId: "sched-morning",
        tenantId: "tenant-beta",
      },
    );
    const pubRefusals = publisherEvents.filter((e) => e.type === "delivery.recipient_refused");
    expect(pubRefusals).toHaveLength(2);
    expect(pubRefusals.every((e) => e.payload.reason === "webhook_tenant_url_unmapped")).toBe(true);
    expect(postedUrls).toHaveLength(1);
  });
});
