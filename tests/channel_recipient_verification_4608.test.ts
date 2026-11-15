/**
 * Issue #4608 (sub of #2856) — Channel recipient verification:
 * recipient must be in tenant+run at every channel layer.
 *
 * Acceptance:
 * - Architectural decision recorded: verification at delivery time at
 *   every channel layer (not schedule-creation time alone).
 * - G22 verified: delivery-claim scoping is tenant+run via
 *   `scopedDeliveryClaimRunId`.
 * - Shared acceptance test: for every channel (`email`, `slack`,
 *   `webhook`) and every layer (`executor.deliver`, `executor.notify`,
 *   `followup_port.deliver`, `followup_port.notify`, `discovery_direct`,
 *   `screening_content`, `gated_slack`, `publisher`), a delivery attempt
 *   whose recipient is not in the run's tenant+run is refused with
 *   `FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED` AND audited
 *   (`delivery.recipient_refused`) at that layer, with zero transport sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyChannelRecipient,
  resolveEnvChannelRecipientBinding,
  inferTenantFromDeliveryId,
  type ChannelRecipientBinding,
} from "../src/services/channelRecipientVerification";
import { createFollowupDeliveryPort } from "../src/services/screenerFollowupDelivery";
import {
  deliverScreeningContent,
  deliverDiscoveryDirect,
  type ScreeningDeliveryTransport,
} from "../src/services/screeningDelivery";
import { deliverGatedSlack } from "../src/services/gatedSlackDelivery";
import {
  publishScreenerCompleted,
  publishScreenerFailed,
} from "../src/events/screenerPublishers";
import {
  createDeliverySuppressor,
  scopedDeliveryClaimRunId,
} from "../src/workflows/screenDeliverySuppression";
import {
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";

const TENANT_A_BINDING: ChannelRecipientBinding = {
  tenantId: "tenant-a",
  runId: "run-101",
  scheduleId: "sched-101",
  userLogin: "alice",
  emailRecipients: ["alice@tenant-a.example.com"],
  slackChannels: ["C-TENANT-A"],
  webhookUrls: ["https://hooks.tenant-a.example.com/ingest"],
};

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
    deliveryId: "run-101",
    scheduleId: "sched-101",
    tenantId: "tenant-a",
    recipientBinding: TENANT_A_BINDING,
    ...overrides,
  };
}

describe("Channel recipient verification (#4608)", () => {
  describe("verifyChannelRecipient core contract", () => {
    it("allows email, slack, and webhook recipients that match the tenant+run binding", () => {
      const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const run = {
        tenantId: "tenant-a",
        runId: "run-101",
        scheduleId: "sched-101",
        userLogin: "alice",
      };

      expect(
        verifyChannelRecipient({
          channel: "email",
          recipient: "ALICE@tenant-a.example.com",
          run,
          binding: TENANT_A_BINDING,
          layer: "followup_port.deliver",
          audit: (type, payload) => audits.push({ type, payload }),
        }),
      ).toEqual({ allowed: true });

      expect(
        verifyChannelRecipient({
          channel: "slack",
          recipient: "C-TENANT-A",
          run,
          binding: TENANT_A_BINDING,
          layer: "followup_port.deliver",
          audit: (type, payload) => audits.push({ type, payload }),
        }),
      ).toEqual({ allowed: true });

      expect(
        verifyChannelRecipient({
          channel: "webhook",
          recipient: "https://hooks.tenant-a.example.com/ingest",
          run,
          binding: TENANT_A_BINDING,
          layer: "followup_port.deliver",
          audit: (type, payload) => audits.push({ type, payload }),
        }),
      ).toEqual({ allowed: true });

      expect(audits).toHaveLength(0);
    });

    it("refuses and audits cross-tenant, wrong-run, wrong-schedule, wrong-owner, and unlisted recipients across all channels", () => {
      const cases = [
        {
          name: "missing run tenant",
          channel: "email" as const,
          recipient: "alice@tenant-a.example.com",
          run: { tenantId: null, runId: "run-101", scheduleId: "sched-101", userLogin: "alice" },
          expectedReason: "run_tenant_missing",
        },
        {
          name: "cross-tenant mismatch",
          channel: "slack" as const,
          recipient: "C-TENANT-A",
          run: { tenantId: "tenant-b", runId: "run-101", scheduleId: "sched-101", userLogin: "alice" },
          expectedReason: "recipient_tenant_mismatch",
        },
        {
          name: "runId mismatch",
          channel: "webhook" as const,
          recipient: "https://hooks.tenant-a.example.com/ingest",
          run: { tenantId: "tenant-a", runId: "run-999", scheduleId: "sched-101", userLogin: "alice" },
          expectedReason: "recipient_run_mismatch",
        },
        {
          name: "scheduleId mismatch",
          channel: "email" as const,
          recipient: "alice@tenant-a.example.com",
          run: { tenantId: "tenant-a", runId: "run-101", scheduleId: "sched-999", userLogin: "alice" },
          expectedReason: "recipient_schedule_mismatch",
        },
        {
          name: "owner mismatch",
          channel: "email" as const,
          recipient: "alice@tenant-a.example.com",
          run: { tenantId: "tenant-a", runId: "run-101", scheduleId: "sched-101", userLogin: "mallory" },
          expectedReason: "recipient_owner_mismatch",
        },
        {
          name: "unlisted email recipient",
          channel: "email" as const,
          recipient: "intruder@tenant-b.example.com",
          run: { tenantId: "tenant-a", runId: "run-101", scheduleId: "sched-101", userLogin: "alice" },
          expectedReason: "email_recipient_not_in_tenant_run",
        },
        {
          name: "unlisted slack channel",
          channel: "slack" as const,
          recipient: "C-TENANT-B",
          run: { tenantId: "tenant-a", runId: "run-101", scheduleId: "sched-101", userLogin: "alice" },
          expectedReason: "slack_channel_not_in_tenant_run",
        },
        {
          name: "unlisted webhook URL",
          channel: "webhook" as const,
          recipient: "https://evil.example.com/hook",
          run: { tenantId: "tenant-a", runId: "run-101", scheduleId: "sched-101", userLogin: "alice" },
          expectedReason: "webhook_url_not_in_tenant_run",
        },
      ];

      for (const c of cases) {
        const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const res = verifyChannelRecipient({
          channel: c.channel,
          recipient: c.recipient,
          run: c.run,
          binding: TENANT_A_BINDING,
          layer: "executor.deliver",
          audit: (type, payload) => audits.push({ type, payload }),
        });
        expect(res.allowed, c.name).toBe(false);
        if (!res.allowed) {
          expect(res.reason, c.name).toBe(c.expectedReason);
          expect(res.error, c.name).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");
        }
        expect(audits, c.name).toHaveLength(1);
        expect(audits[0].type).toBe("delivery.recipient_refused");
        expect(audits[0].payload.reason).toBe(c.expectedReason);
        expect(audits[0].payload.layer).toBe("executor.deliver");
      }
    });

    it("resolves tenant from scheduledDeliveryIdentity and parses CHANNEL_RECIPIENT_BINDINGS_JSON", () => {
      expect(inferTenantFromDeliveryId("scheduled:tenant-a:TECH:2026-11-15T12:00")).toBe("tenant-a");
      expect(inferTenantFromDeliveryId("manual:TECH:2026-11-15T12:00")).toBeNull();
      expect(inferTenantFromDeliveryId("bare-run-id")).toBeNull();

      const env = {
        CHANNEL_RECIPIENT_BINDINGS_JSON: JSON.stringify({
          "tenant-a": TENANT_A_BINDING,
        }),
      };
      expect(resolveEnvChannelRecipientBinding(env, { tenantId: "tenant-a" })).toEqual(
        TENANT_A_BINDING,
      );
    });
  });

  describe("FollowupDeliveryPort layers (followup_port.deliver & followup_port.notify)", () => {
    it("refuses and audits unlisted recipients on email, slack, and webhook in deliver() and notify()", async () => {
      const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const transportCalls: string[] = [];
      const transport: ScreeningDeliveryTransport = {
        postSlackViaCfpay: async () => {
          transportCalls.push("slack");
          return { ok: true };
        },
        postSlackDirect: async () => {
          transportCalls.push("slack-direct");
          return { ok: true };
        },
        sendEmailViaCfpay: async () => {
          transportCalls.push("email");
          return { ok: true };
        },
        sendEmailDirect: async () => {
          transportCalls.push("email-direct");
          return { ok: true };
        },
        dispatchWebhook: async () => {
          transportCalls.push("webhook");
          return { ok: true };
        },
      };

      const port = createFollowupDeliveryPort({
        env: {
          SCREENER_SLACK_CHANNEL: "C-TENANT-A",
          SCREENER_EMAIL_TO: "alice@tenant-a.example.com",
          OUTBOUND_WEBHOOK_URL: "https://hooks.tenant-a.example.com/ingest",
        },
        transport,
        getRecipientBinding: () => TENANT_A_BINDING,
        audit: (type, payload) => audits.push({ type, payload }),
      });

      const badEmail = await port.deliver({
        channel: "email",
        userLogin: "alice",
        outcome: makeOutcome({ emailTo: "attacker@other.example.com" }),
        artifacts: {},
      });
      expect(badEmail.ok).toBe(false);
      expect(badEmail.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");

      const badSlack = await port.deliver({
        channel: "slack",
        userLogin: "alice",
        outcome: makeOutcome({ slackChannel: "C-WRONG" }),
        artifacts: {},
      });
      expect(badSlack.ok).toBe(false);
      expect(badSlack.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");

      const badWebhook = await port.deliver({
        channel: "webhook",
        userLogin: "alice",
        outcome: makeOutcome({ webhookUrl: "https://attacker.example.com/hook" }),
        artifacts: {},
      });
      expect(badWebhook.ok).toBe(false);
      expect(badWebhook.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");

      const badNotify = await port.notify({
        channel: "slack",
        userLogin: "alice",
        text: "Screen failed",
        slackChannel: "C-WRONG",
        tenantId: "tenant-a",
        runId: "run-101",
        scheduleId: "sched-101",
      });
      expect(badNotify.ok).toBe(false);
      expect(badNotify.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");

      expect(transportCalls).toHaveLength(0);
      expect(audits).toHaveLength(4);
      expect(audits.map((a) => a.payload.layer)).toEqual([
        "followup_port.deliver",
        "followup_port.deliver",
        "followup_port.deliver",
        "followup_port.notify",
      ]);
    });
  });

  describe("ScreeningDelivery layers (screening_content & discovery_direct)", () => {
    it("refuses and audits unlisted recipients in deliverScreeningContent and deliverDiscoveryDirect", async () => {
      const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const senderCalls: string[] = [];

      const contentRes = await deliverScreeningContent({
        channels: ["webhook"],
        subject: "Subj",
        text: "Report",
        event: "screener.completed",
        webhookUrl: "https://untrusted.example.com/hook",
        senders: {
          webhook: async () => {
            senderCalls.push("webhook");
            return { ok: true };
          },
        },
        userLogin: "alice",
        tenantId: "tenant-a",
        runId: "run-101",
        scheduleId: "sched-101",
        recipientBinding: TENANT_A_BINDING,
        audit: (type, payload) => audits.push({ type, payload }),
      });
      expect(contentRes).toHaveLength(1);
      expect(contentRes[0].ok).toBe(false);
      expect(contentRes[0].error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");

      const directRes = await deliverDiscoveryDirect({
        port: {
          deliver: async () => {
            senderCalls.push("port.deliver");
            return { ok: true };
          },
        },
        outcome: makeOutcome({ emailTo: "outsider@other.example.com" }),
        config: resolveScreenerFollowupConfig({
          SCREENER_EMAIL_TO: "alice@tenant-a.example.com",
        }),
        userLogin: "alice",
        recipientBinding: TENANT_A_BINDING,
        audit: (type, payload) => audits.push({ type, payload }),
      });
      expect(directRes).toHaveLength(1);
      expect(directRes[0].ok).toBe(false);
      expect(directRes[0].error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");

      expect(senderCalls).toHaveLength(0);
      expect(audits.map((a) => a.payload.layer)).toEqual([
        "screening_content",
        "discovery_direct",
      ]);
    });
  });

  describe("GatedSlack layer (gated_slack) & Publisher layer (publisher)", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("refuses and audits an unlisted Slack channel in deliverGatedSlack", async () => {
      const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const res = await deliverGatedSlack(
        { SCREENER_SLACK_CHANNEL: "C-TENANT-A" },
        {
          userLogin: "alice",
          text: "Alert",
          channel: "C-INTRUDER",
          tenantId: "tenant-a",
          runId: "run-101",
          scheduleId: "sched-101",
          recipientBinding: TENANT_A_BINDING,
          audit: (type, payload) => audits.push({ type, payload }),
        },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED]");
      expect(audits).toHaveLength(1);
      expect(audits[0].payload.layer).toBe("gated_slack");
    });

    it("refuses and audits unlisted recipients in publishScreenerCompleted and publishScreenerFailed", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const orm = {
        events: {
          create: (row: { type: string; payload: Record<string, unknown> }) => {
            events.push(row);
          },
        },
      } as any;

      await publishScreenerCompleted(
        {
          env: {
            SCREENER_SLACK_CHANNEL: "C-UNLISTED",
            SCREENER_EMAIL_TO: "unlisted@other.example.com",
            OUTBOUND_WEBHOOK_URL: "https://unlisted.example.com/hook",
          } as any,
          orm,
          userLogin: "alice",
        },
        {
          type: "screener.completed",
          timestamp: "2026-11-15T12:00:00.000Z",
          sector: "TECH",
          totalScanned: 10,
          matchedCount: 0,
          opportunities: [],
          deliveryId: "run-101",
          scheduleId: "sched-101",
          tenantId: "tenant-a",
          recipientBinding: TENANT_A_BINDING,
        },
      );

      await publishScreenerFailed(
        {
          env: {
            SCREENER_SLACK_CHANNEL: "C-UNLISTED",
            SCREENER_EMAIL_TO: "unlisted@other.example.com",
            OUTBOUND_WEBHOOK_URL: "https://unlisted.example.com/hook",
          } as any,
          orm,
          userLogin: "alice",
        },
        {
          type: "screener.failed",
          timestamp: "2026-11-15T12:00:00.000Z",
          sector: "TECH",
          error: "timeout",
          deliveryId: "run-101",
          scheduleId: "sched-101",
          tenantId: "tenant-a",
          recipientBinding: TENANT_A_BINDING,
        },
      );

      const refused = events.filter((e) => e.type === "delivery.recipient_refused");
      expect(refused).toHaveLength(6);
      expect(refused.every((e) => e.payload.layer === "publisher")).toBe(true);
    });
  });

  describe("G22 — tenant+run scoped delivery claims (scopedDeliveryClaimRunId)", () => {
    it("scopes bare runIds by tenantId so two tenants never cross-suppress in mas_delivery_claims", () => {
      const suppressor = createDeliverySuppressor();
      const claimKeyA = scopedDeliveryClaimRunId("run-shared-42", "tenant-a");
      const claimKeyB = scopedDeliveryClaimRunId("run-shared-42", "tenant-b");

      expect(claimKeyA).toBe("tenant:tenant-a:run-shared-42");
      expect(claimKeyB).toBe("tenant:tenant-b:run-shared-42");
      // Already-prefixed runIds are not double-prefixed:
      expect(scopedDeliveryClaimRunId("tenant:tenant-a:run-shared-42", "tenant-a")).toBe(
        "tenant:tenant-a:run-shared-42",
      );
      expect(
        scopedDeliveryClaimRunId("scheduled:tenant-a:TECH:2026-11-15T12:00", "tenant-a"),
      ).toBe("scheduled:tenant-a:TECH:2026-11-15T12:00");

      expect(suppressor.tryClaim(claimKeyA, "slack")).toBe(true);
      expect(suppressor.tryClaim(claimKeyB, "slack")).toBe(true);
      expect(suppressor.tryClaim(claimKeyA, "slack")).toBe(false);
    });
  });
});
