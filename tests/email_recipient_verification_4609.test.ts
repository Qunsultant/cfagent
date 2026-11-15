/**
 * Issue #4609 (G14, sub-issue of #4608 / #2856):
 * Email recipient verification — recipient must be in tenant+run (and owner)
 * at delivery time across every email channel layer, including refusing and
 * auditing a schedule created with someone else's email address.
 */
import { describe, expect, it, vi } from "vitest";
import { verifyEmailRecipientAtDelivery } from "../src/services/channelRecipientVerification";
import {
  isEmailAllowed,
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import { createFollowupDeliveryPort } from "../src/services/screenerFollowupDelivery";
import {
  deliverDiscoveryDirect,
  deliverScreeningContent,
  type ScreeningDeliveryTransport,
} from "../src/services/screeningDelivery";
import {
  publishScreenerCompleted,
  publishScreenerFailed,
} from "../src/events/screenerPublishers";
import { userEmailDestinationStore } from "../src/services/userEmailDestination";
import type { Env } from "../src/types";

function makeInMemorySessionStoreNamespace() {
  const store = new Map<string, string>();
  return {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(req: Request): Promise<Response> {
          const body = (await req.json()) as {
            op: string;
            namespace: string;
            key?: string;
            value?: string;
          };
          const fullKey = `${body.namespace}:${body.key ?? ""}`;
          if (body.op === "get") {
            return Response.json({ value: store.get(fullKey) ?? null });
          }
          if (body.op === "put" && typeof body.value === "string") {
            store.set(fullKey, body.value);
            return Response.json({ ok: true });
          }
          if (body.op === "delete") {
            store.delete(fullKey);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: true });
        },
      };
    },
  };
}

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
        symbol: "AAPL",
        companyName: "Apple Inc.",
        sector: "TECH",
        lastPrice: 225.5,
        changePercent: 1.8,
        volume: 50_000_000,
        momentumScore: 84,
        signal: "BULLISH",
      },
    ],
    ...overrides,
  };
}

describe("Issue #4609 (G14): Email recipient verification at delivery time", () => {
  it("verifyEmailRecipientAtDelivery refuses malformed addresses, disallowed domains, and addresses outside the run's tenant+owner binding across all layers", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const env = {
      SESSION_STORE: makeInMemorySessionStoreNamespace(),
      EMAIL_TO_ALLOWED_DOMAINS: "tenant-a.com",
    } as unknown as Env;

    await userEmailDestinationStore(env).set("alice", "alice@tenant-a.com", "alice");

    const malformed = await verifyEmailRecipientAtDelivery({
      recipient: "not-an-email",
      env,
      run: { tenantId: "tenant-a", runId: "run-1", scheduleId: "sched-1", userLogin: "alice" },
      layer: "executor.deliver",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(malformed.allowed).toBe(false);
    if (!malformed.allowed) {
      expect(malformed.code).toBe("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
    }

    const wrongDomain = await verifyEmailRecipientAtDelivery({
      recipient: "alice@other-domain.com",
      env,
      run: { tenantId: "tenant-a", runId: "run-1", scheduleId: "sched-1", userLogin: "alice" },
      layer: "executor.notify",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(wrongDomain.allowed).toBe(false);
    if (!wrongDomain.allowed) {
      expect(wrongDomain.code).toBe("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
    }

    // Schedule created with someone else's email in the same domain is still refused
    // because the run belongs to alice (whose stored owner email is alice@tenant-a.com).
    const someoneElse = await verifyEmailRecipientAtDelivery({
      recipient: "bob@tenant-a.com",
      env,
      run: { tenantId: "tenant-a", runId: "run-1", scheduleId: "sched-1", userLogin: "alice" },
      layer: "followup_port.deliver",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(someoneElse.allowed).toBe(false);
    if (!someoneElse.allowed) {
      expect(someoneElse.code).toBe("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
    }
    expect(audits).toHaveLength(3);
    expect(audits[2].payload).toMatchObject({
      channel: "email",
      layer: "followup_port.deliver",
      recipient: "bob@tenant-a.com",
      tenantId: "tenant-a",
      runId: "run-1",
      userLogin: "alice",
    });

    const ownerMatch = await verifyEmailRecipientAtDelivery({
      recipient: "Alice@Tenant-A.com",
      env,
      run: { tenantId: "tenant-a", runId: "run-1", scheduleId: "sched-1", userLogin: "alice" },
      layer: "followup_port.deliver",
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(ownerMatch).toEqual({ allowed: true });
    expect(audits).toHaveLength(3);
  });

  it("isEmailAllowed refuses a schedule created with someone else's email when ownerEmail is bound", () => {
    const outcome = makeOutcome({
      ownerEmail: "alice@tenant-a.com",
      emailTo: "someone-else@tenant-a.com",
    });
    const config = resolveScreenerFollowupConfig({
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "noreply@cfagent.test",
      SCREENER_EMAIL_TO: "someone-else@tenant-a.com",
    });

    expect(isEmailAllowed(config, "someone-else@tenant-a.com", outcome)).toBe(false);
    expect(isEmailAllowed(config, "alice@tenant-a.com", outcome)).toBe(true);
  });

  it("followup_port.deliver and followup_port.notify refuse a schedule created with someone else's email and allow the owner's stored email", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const transportCalls: string[] = [];
    const env = {
      SESSION_STORE: makeInMemorySessionStoreNamespace(),
      EMAIL_FROM_ADDRESS: "noreply@cfagent.test",
      SCREENER_EMAIL_TO: "alice@tenant-a.com",
      EMAIL: {
        send: async () => {
          transportCalls.push("direct:sent");
        },
      },
    } as unknown as Env;
    await userEmailDestinationStore(env).set("alice", "alice@tenant-a.com", "alice");

    const port = createFollowupDeliveryPort({
      env,
      getOrm: () => undefined as any,
      getScreenerAgent: () => null,
      audit: (type, payload) => audits.push({ type, payload }),
    });

    const hijackedOutcome = makeOutcome({ emailTo: "someone-else@other.com" });
    const refusedDeliver = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome: hijackedOutcome,
      artifacts: {},
    });
    expect(refusedDeliver.ok).toBe(false);
    expect(refusedDeliver.error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");

    const refusedNotify = await port.notify({
      channel: "email",
      userLogin: "alice",
      text: "Screen failed",
      emailTo: "someone-else@other.com",
      tenantId: "tenant-a",
      runId: "run-4609",
      scheduleId: "sched-1",
    });
    expect(refusedNotify.ok).toBe(false);
    expect(refusedNotify.error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");

    expect(transportCalls).toHaveLength(0);
    expect(audits).toHaveLength(2);
    expect(audits[0].payload).toMatchObject({
      channel: "email",
      layer: "followup_port.deliver",
      recipient: "someone-else@other.com",
      userLogin: "alice",
      tenantId: "tenant-a",
    });
    expect(audits[1].payload).toMatchObject({
      channel: "email",
      layer: "followup_port.notify",
      recipient: "someone-else@other.com",
      userLogin: "alice",
      tenantId: "tenant-a",
    });

    // Matching the owner's stored email succeeds and dispatches via transport
    const allowedDeliver = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome: makeOutcome({ emailTo: "alice@tenant-a.com" }),
      artifacts: [],
    });
    expect(allowedDeliver.ok).toBe(true);
    expect(transportCalls).toEqual(["direct:sent"]);
  });

  it("discovery_direct and screening_content refuse and audit email delivery when recipient does not match owner's stored email", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const env = {
      SESSION_STORE: makeInMemorySessionStoreNamespace(),
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "noreply@cfagent.test",
    } as unknown as Env;
    await userEmailDestinationStore(env).set("alice", "alice@tenant-a.com", "alice");

    const senderCalls: string[] = [];

    const contentOutcomes = await deliverScreeningContent({
      channels: ["email"],
      subject: "Screen Digest",
      text: "Opportunities",
      event: "screener.completed",
      emailTo: "intruder@other.com",
      senders: {
        email: async () => {
          senderCalls.push("content.email");
          return { ok: true };
        },
      },
      userLogin: "alice",
      tenantId: "tenant-a",
      runId: "run-content-4609",
      scheduleId: "sched-1",
      env: env as unknown as Record<string, unknown>,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(contentOutcomes).toHaveLength(1);
    expect(contentOutcomes[0].ok).toBe(false);
    expect(contentOutcomes[0].error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");

    const directOutcomes = await deliverDiscoveryDirect({
      port: {
        deliver: async () => {
          senderCalls.push("direct.deliver");
          return { ok: true };
        },
      },
      outcome: makeOutcome({ emailTo: "intruder@other.com" }),
      config: resolveScreenerFollowupConfig({
        RESEND_API_KEY: "re_test_key",
        EMAIL_FROM: "noreply@cfagent.test",
        SCREENER_EMAIL_TO: "alice@tenant-a.com",
      }),
      userLogin: "alice",
      env: env as unknown as Record<string, unknown>,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(directOutcomes).toHaveLength(1);
    expect(directOutcomes[0].ok).toBe(false);
    expect(directOutcomes[0].error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");

    expect(senderCalls).toHaveLength(0);
    expect(audits.map((a) => a.payload.layer)).toEqual([
      "screening_content",
      "discovery_direct",
    ]);
  });

  it("publisher layer refuses and audits a schedule created with someone else's emailTo when the owner has a stored email destination", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const env = {
      SESSION_STORE: makeInMemorySessionStoreNamespace(),
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "noreply@cfagent.test",
    } as unknown as Env;
    await userEmailDestinationStore(env).set("alice", "alice@tenant-a.com", "alice");

    const orm = {
      events: {
        create: (row: { type: string; payload: Record<string, unknown> }) => {
          audits.push({ type: row.type, payload: row.payload });
        },
      },
    } as any;

    await publishScreenerCompleted(
      { env, orm, userLogin: "alice" },
      {
        type: "screener.completed",
        sector: "TECH",
        universe: "SP500",
        totalScanned: 10,
        matchedCount: 0,
        opportunities: [],
        timestamp: "2026-11-15T12:00:00.000Z",
        deliveryId: "scheduled:tenant-a:TECH:2026-11-15T12:00",
        scheduleId: "sched-1",
        tenantId: "tenant-a",
        emailTo: "someone-else@other.com",
      },
    );

    await publishScreenerFailed(
      { env, orm, userLogin: "alice" },
      {
        type: "screener.failed",
        sector: "TECH",
        universe: "SP500",
        error: "quote timeout",
        timestamp: "2026-11-15T12:00:00.000Z",
        deliveryId: "scheduled:tenant-a:TECH:2026-11-15T12:00",
        scheduleId: "sched-1",
        tenantId: "tenant-a",
        emailTo: "someone-else@other.com",
      },
    );

    const refusalAudits = audits.filter((a) => a.type === "delivery.recipient_refused");
    expect(refusalAudits).toHaveLength(2);
    expect(refusalAudits[0].payload).toMatchObject({
      channel: "email",
      layer: "publisher",
      recipient: "someone-else@other.com",
      tenantId: "tenant-a",
      userLogin: "alice",
    });
    expect(refusalAudits[1].payload).toMatchObject({
      channel: "email",
      layer: "publisher",
      recipient: "someone-else@other.com",
      tenantId: "tenant-a",
      userLogin: "alice",
    });
  });
});
