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
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const warns = (console.warn as any).mock.calls.map((c: any[]) => String(c.join(" ")));
    expect(warns.some((w: string) => w.includes("No email transport is configured"))).toBe(true);
  });

  it("failed: skips email with a named warning and issues no send when unconfigured", async () => {
    const env = { APP_BASE_URL: "https://example.invalid" } as any;
    await publishScreenerFailed({ env, userLogin: "trader1" }, failedEvent());
    expect(mockCfpaySendEmail).not.toHaveBeenCalled();
    const warns = (console.warn as any).mock.calls.map((c: any[]) => String(c.join(" ")));
    expect(warns.some((w: string) => w.includes("No email transport is configured"))).toBe(true);
  });

  it("completed: still sends via cfpay when configured (no skip warning)", async () => {
    const env = {
      APP_BASE_URL: "https://example.invalid",
      DASHBOARD_API_KEY_IS_A2A_TOKEN: "test-token",
    } as any;
    await publishScreenerCompleted({ env, userLogin: "trader1" }, completedEvent());
    expect(mockCfpaySendEmail).toHaveBeenCalled();
    const warns = (console.warn as any).mock.calls.map((c: any[]) => String(c.join(" ")));
    expect(warns.some((w: string) => w.includes("No email transport is configured"))).toBe(false);
  });
});
