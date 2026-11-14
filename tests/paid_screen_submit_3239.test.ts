/**
 * Issue #3239: client side of the #2373 paid seam for manual stock screens.
 *
 * The server seam (paidStockScreenSeam.ts) refuses a SYNC screen with
 * 402 monetization_enabled_workflow_required when monetization is ON;
 * the paid path is async submission (async: true) plus the checkout
 * contact email. These pure helpers are the ONE mapping every manual
 * screen call site shares, so a server error code is never rendered
 * raw and the paid body is built identically everywhere.
 */
import { describe, it, expect } from "vitest";
import {
  BROKER_UNAVAILABLE_ERROR,
  MONETIZATION_WORKFLOW_ERROR,
  buildPaidScreenBody,
  buildPaidScreenQuery,
  isBrokerUnavailableError,
  isMonetizationWorkflowError,
  isPaymentStarted,
  mapScreenError,
  mapScreenErrorFromBody,
  readMonetizationState,
  readScreenErrorText,
} from "../src/client/paidScreenSubmit";

describe("paidScreenBody (#3239)", () => {
  it("adds async + email when monetization is ON and an email is present", () => {
    const body = buildPaidScreenBody(
      { universe: "NASDAQ100" },
      { monetization: "on", checkoutEmail: "buyer@firm.com" },
    );
    expect(body).toEqual({ universe: "NASDAQ100", async: true, email: "buyer@firm.com" });
  });

  it("leaves the body unchanged when monetization is ON but no email is present", () => {
    const body = buildPaidScreenBody(
      { universe: "NASDAQ100" },
      { monetization: "on", checkoutEmail: "  " },
    );
    expect(body).toEqual({ universe: "NASDAQ100" });
    expect("async" in body).toBe(false);
  });

  it("leaves the body unchanged when monetization is OFF", () => {
    const body = buildPaidScreenBody(
      { universe: "NASDAQ100" },
      { monetization: "off", checkoutEmail: "buyer@firm.com" },
    );
    expect(body).toEqual({ universe: "NASDAQ100" });
  });

  it("leaves the body unchanged when the monetization state is unknown", () => {
    const body = buildPaidScreenBody(
      { universe: "NASDAQ100" },
      { monetization: "unknown", checkoutEmail: "buyer@firm.com" },
    );
    expect(body).toEqual({ universe: "NASDAQ100" });
  });
});

describe("paidScreenQuery (#3239)", () => {
  it("adds async=1 + email to the GET query when monetization is ON", () => {
    const params = buildPaidScreenQuery(new URLSearchParams("sector=Technology"), {
      monetization: "on",
      checkoutEmail: "buyer@firm.com",
    });
    expect(params.get("async")).toBe("1");
    expect(params.get("email")).toBe("buyer@firm.com");
    expect(params.get("sector")).toBe("Technology");
  });

  it("leaves the query unchanged when monetization is OFF", () => {
    const params = buildPaidScreenQuery(new URLSearchParams("sector=Technology"), {
      monetization: "off",
      checkoutEmail: "buyer@firm.com",
    });
    expect(params.toString()).toBe("sector=Technology");
  });
});

describe("isMonetizationWorkflowError (#3239)", () => {
  it("identifies the 402 workflow code", () => {
    expect(isMonetizationWorkflowError(402, MONETIZATION_WORKFLOW_ERROR)).toBe(true);
    expect(isMonetizationWorkflowError(402, "something else")).toBe(false);
    expect(isMonetizationWorkflowError(500, undefined)).toBe(false);
  });
});

describe("isPaymentStarted (#3239)", () => {
  it("identifies the seam's 202 payment_started shape", () => {
    expect(isPaymentStarted({ status: "payment_started", runRequestId: "req-1" })).toBe(true);
    expect(isPaymentStarted({ status: "payment_started" })).toBe(false);
    expect(isPaymentStarted({ status: "ok", runRequestId: "req-1" })).toBe(false);
    expect(isPaymentStarted(null)).toBe(false);
  });
});

describe("mapScreenError (#3239)", () => {
  it("maps the 402 workflow code to a payment message with remediation, never the code", () => {
    const message = mapScreenError(402, MONETIZATION_WORKFLOW_ERROR);
    expect(message).not.toContain(MONETIZATION_WORKFLOW_ERROR);
    expect(message).toMatch(/payment/i);
    expect(message).toMatch(/payment workflow/i);
  });

  it("maps the missing-checkout-email 400 to an email prompt", () => {
    const message = mapScreenError(
      400,
      "email (checkout contact) is required when monetization is on.",
    );
    expect(message).toMatch(/checkout email/i);
  });

  it("keeps a 400 field-guidance sentence (it is remediation, not a code)", () => {
    expect(mapScreenError(400, "minScore must be a number")).toBe("minScore must be a number");
  });

  it("keeps a descriptive 500 sentence (pinned by #2438's upstream-down test)", () => {
    expect(mapScreenError(500, "Screening request failed: upstream down")).toBe(
      "Screening request failed: upstream down",
    );
  });

  it("maps auth and availability statuses to fixed messages", () => {
    expect(mapScreenError(401, "unauthenticated")).toMatch(/sign in/i);
    expect(mapScreenError(503, "down")).toMatch(/temporarily unavailable/i);
  });

  it("never renders an unknown bare snake_case code", () => {
    const message = mapScreenError(500, "some_upstream_code_here");
    expect(message).not.toContain("some_upstream_code_here");
  });

  it("falls back to a fixed status message when no error body is present", () => {
    expect(mapScreenError(500, undefined)).toMatch(/temporarily unavailable/i);
    expect(mapScreenError(500, undefined)).not.toContain("undefined");
  });
});

describe("mapScreenError — broker-gate 409 (#4430)", () => {
  const brokerBody = {
    code: BROKER_UNAVAILABLE_ERROR,
    error: "This broker surface is not available for the selected broker. Change the broker selection in Settings.",
    message: "This broker surface is not available for the selected broker. Change the broker selection in Settings.",
    retryable: false,
    selectedBroker: "public",
  };

  it("maps 409 + FAILURE_BROKER_UNAVAILABLE to the business message with a switch-to-Yahoo remediation", () => {
    const message = mapScreenErrorFromBody(409, brokerBody);
    expect(message).toContain("This broker surface is not available for the selected broker.");
    expect(message).toContain("Change the broker selection in Settings.");
    expect(message).toMatch(/Switch the hub provider to Yahoo Finance/i);
    expect(message).not.toContain("Screening request failed [HTTP 409]");
    expect(message).not.toContain(BROKER_UNAVAILABLE_ERROR);
  });

  it("maps the 409 from a message-only body (the pre-#4430 shape, no `error` field)", () => {
    const { error: _error, ...messageOnly } = brokerBody;
    const message = mapScreenErrorFromBody(409, messageOnly);
    expect(message).toContain("This broker surface is not available for the selected broker.");
    expect(message).not.toContain("Screening request failed [HTTP 409]");
  });

  it("detects the broker refusal by status + code, not by the message text", () => {
    expect(isBrokerUnavailableError(409, undefined, BROKER_UNAVAILABLE_ERROR)).toBe(true);
    expect(isBrokerUnavailableError(409, BROKER_UNAVAILABLE_ERROR)).toBe(true);
    expect(isBrokerUnavailableError(409, "something else")).toBe(false);
    expect(isBrokerUnavailableError(500, undefined, BROKER_UNAVAILABLE_ERROR)).toBe(false);
  });

  it("reads `message` when `error` is absent, so the other call sites benefit", () => {
    expect(readScreenErrorText({ message: "Screening request failed: upstream down" })).toBe(
      "Screening request failed: upstream down",
    );
    expect(readScreenErrorText({ error: "from error", message: "from message" })).toBe("from error");
    expect(readScreenErrorText({ code: BROKER_UNAVAILABLE_ERROR })).toBeUndefined();
    expect(readScreenErrorText(null)).toBeUndefined();
    expect(mapScreenErrorFromBody(500, { message: "Screening request failed: upstream down" })).toBe(
      "Screening request failed: upstream down",
    );
  });
});

describe("readMonetizationState (#3239)", () => {
  it("maps the pricing flag to on/off and any read failure to unknown", async () => {
    await expect(readMonetizationState(async () => ({ monetizationEnabled: true }))).resolves.toBe("on");
    await expect(readMonetizationState(async () => ({ monetizationEnabled: false }))).resolves.toBe("off");
    await expect(
      readMonetizationState(async () => {
        throw new Error("pricing route down");
      }),
    ).resolves.toBe("unknown");
  });
});
