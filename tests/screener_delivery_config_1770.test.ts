/**
 * Issue #1770 (slice B, F-63): the named delivery-config check.
 * A missing email transport must surface as a visible, named status —
 * never a silent skip — and RESEND/SMTP variables must be reported as
 * set-but-unconsumed, since no sender on current main reads them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkScreenerDeliveryConfig } from "../src/services/screenerDeliveryConfig";
import { publishScreenerCompleted, publishScreenerFailed } from "../src/events/screenerPublishers";
import type { ScreenerCompletedEvent, ScreenerFailedEvent } from "../src/events/screenerEvents";

vi.mock("agents", () => ({
  Agent: class {},
}));

const mockCfpaySendEmail = vi.fn(async () => ({ ok: true, messageId: "msg_1" }));
const mockCfpaySendEmailWithAttachments = vi.fn(async () => ({ ok: true, messageId: "msg_2" }));

vi.mock("../src/services/cfpayA2A", () => ({
  getCfpayConfig: vi.fn((env: any) =>
    env?.DASHBOARD_API_KEY_IS_A2A_TOKEN || env?.CFPAY_A2A_TOKEN
      ? { token: "test-token", baseUrl: "https://example.invalid" }
      : null
  ),
  cfpaySendEmail: (...args: any[]) => mockCfpaySendEmail(...args),
  cfpaySendEmailWithAttachments: (...args: any[]) => mockCfpaySendEmailWithAttachments(...args),
  cfpayPostToSlack: vi.fn(async () => ({ ok: true })),
  cfpayPostFileToSlack: vi.fn(async () => ({ ok: true })),
}));

// #3515 S3 batch 9: the publishers now log via the structured logger,
// whose fallback sink writes every event as one JSON line via
// console.info. Parse those lines into structured events (batch-3
// pattern) instead of reading raw console.warn lines.
function structuredEvents(): Array<{
  operation: string;
  level: string;
  fields: Record<string, unknown>;
}> {
  const info = console.info as unknown as { mock: { calls: unknown[][] } };
  const events: Array<{
    operation: string;
    level: string;
    fields: Record<string, unknown>;
  }> = [];
  for (const call of info.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as {
        operation?: unknown;
        level?: unknown;
        fields?: unknown;
      };
      if (parsed && typeof parsed.operation === "string") {
        events.push({
          operation: parsed.operation,
          level: typeof parsed.level === "string" ? parsed.level : "",
          fields:
            parsed.fields && typeof parsed.fields === "object"
              ? (parsed.fields as Record<string, unknown>)
              : {},
        });
      }
    } catch {
      // Non-JSON console.info lines are not structured events.
    }
  }
  return events;
}

describe("checkScreenerDeliveryConfig (#1770 slice B)", () => {
  it("reports unconfigured with a named reason when no transport exists", () => {
    const status = checkScreenerDeliveryConfig({ APP_BASE_URL: "https://example.invalid" });
    expect(status.emailConfigured).toBe(false);
    expect(status.emailTransports).toEqual([]);
    expect(status.emailMissingReason).toContain("cfpay A2A token");
    expect(status.emailMissingReason).toContain("env.EMAIL binding");
    expect(status.unusedEmailVars).toEqual([]);
  });

  it("reports cfpay-a2a when the A2A token is present", () => {
    const status = checkScreenerDeliveryConfig({
      DASHBOARD_API_KEY_IS_A2A_TOKEN: "test-token",
    });
    expect(status.emailConfigured).toBe(true);
    expect(status.emailTransports).toEqual(["cfpay-a2a"]);
    expect(status.emailMissingReason).toBeUndefined();
  });

  it("reports email-binding when env.EMAIL.send exists", () => {
    const status = checkScreenerDeliveryConfig({
      EMAIL: { send: async () => {} },
    });
    expect(status.emailConfigured).toBe(true);
    expect(status.emailTransports).toEqual(["email-binding"]);
  });

  it("reports both transports when both are present", () => {
    const status = checkScreenerDeliveryConfig({
      CFPAY_A2A_TOKEN: "test-token",
      EMAIL: { send: async () => {} },
    });
    expect(status.emailTransports).toEqual(["cfpay-a2a", "email-binding"]);
  });

  it("names RESEND_API_KEY as set-but-unconsumed, never as configured", () => {
    const status = checkScreenerDeliveryConfig({ RESEND_API_KEY: "test-key" });
    expect(status.emailConfigured).toBe(false);
    expect(status.unusedEmailVars).toEqual(["RESEND_API_KEY"]);
    expect(status.emailMissingReason).toContain("RESEND_API_KEY");
    expect(status.emailMissingReason).toContain("does not enable delivery");
  });

  it("names SMTP vars as set-but-unconsumed without reading their values", () => {
    const status = checkScreenerDeliveryConfig({
      SMTP_HOST: "smtp.example.invalid",
      SMTP_USER: "user@example.invalid",
    });
    expect(status.emailConfigured).toBe(false);
    expect(status.unusedEmailVars).toEqual(["SMTP_HOST", "SMTP_USER"]);
    // The status carries names only — never a credential value.
    expect(JSON.stringify(status)).not.toContain("smtp.example.invalid");
    expect(JSON.stringify(status)).not.toContain("user@example.invalid");
  });
});

describe("bus publishers surface missing email transport (#1770 slice B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  const completedEvent = (overrides: Partial<ScreenerCompletedEvent> = {}): ScreenerCompletedEvent => ({
    type: "screener.completed",
    timestamp: "2026-11-02T00:00:00.000Z",
    sector: "ALL",
    totalScanned: 10,
    matchedCount: 1,
    opportunities: [
      { symbol: "NVDA", companyName: "NVIDIA Corp", signal: "BULLISH_MOMENTUM", momentumScore: 80, lastPrice: 200, changePercent: 1.5 },
    ],
    emailTo: "trader@example.invalid",
    ...overrides,
  });

  const failedEvent = (overrides: Partial<ScreenerFailedEvent> = {}): ScreenerFailedEvent => ({
    type: "screener.failed",
    timestamp: "2026-11-02T00:00:00.000Z",
    sector: "ALL",
    error: "boom",
    emailTo: "trader@example.invalid",
    ...overrides,
  });

  it("completed: skips email with a named warning and issues no send when unconfigured", async () => {
    const env = { APP_BASE_URL: "https://example.invalid" } as any;
    await publishScreenerCompleted({ env, userLogin: "trader1" }, completedEvent());
    expect(mockCfpaySendEmail).not.toHaveBeenCalled();
    expect(mockCfpaySendEmailWithAttachments).not.toHaveBeenCalled();
    // The missing-transport skip must surface as a named structured event.
    const skip = structuredEvents().filter(
      (e) => e.operation === "screenerPublishers.email_delivery_skipped"
    );
    expect(skip).toHaveLength(1);
    expect(skip[0]?.level).toBe("warn");
    expect(String(skip[0]?.fields?.message ?? "")).toContain(
      "No email transport is configured"
    );
  });

  it("failed: skips email with a named warning and issues no send when unconfigured", async () => {
    const env = { APP_BASE_URL: "https://example.invalid" } as any;
    await publishScreenerFailed({ env, userLogin: "trader1" }, failedEvent());
    expect(mockCfpaySendEmail).not.toHaveBeenCalled();
    const skip = structuredEvents().filter(
      (e) => e.operation === "screenerPublishers.email_failure_notify_skipped"
    );
    expect(skip).toHaveLength(1);
    expect(skip[0]?.level).toBe("warn");
    expect(String(skip[0]?.fields?.message ?? "")).toContain(
      "No email transport is configured"
    );
  });

  it("completed: still sends via cfpay when configured (no skip warning)", async () => {
    const env = {
      APP_BASE_URL: "https://example.invalid",
      DASHBOARD_API_KEY_IS_A2A_TOKEN: "test-token",
    } as any;
    await publishScreenerCompleted({ env, userLogin: "trader1" }, completedEvent());
    expect(mockCfpaySendEmail).toHaveBeenCalled();
    // The cfpay transport is configured, so no missing-transport
    // skip event is emitted for the completed publish.
    const skip = structuredEvents().filter(
      (e) => e.operation === "screenerPublishers.email_delivery_skipped"
    );
    expect(skip).toHaveLength(0);
  });
});
