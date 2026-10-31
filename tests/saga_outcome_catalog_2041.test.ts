/**
 * Issue #2041 S1+S2+S3 — saga outcome catalog entries (gap G-CATALOG).
 *
 * S1 proposes the four Leg 0/1 outcomes; S2 adds the three
 * journey-gate outcomes below; S3 adds the two compensated
 * screen-failure outcomes. Trading (S4) entries arrive with
 * their slice; nothing here claims them. Every entry follows
 * the #2381 catalog contract: SUCCESS_* / FAILURE_* names,
 * businessMessage to UI and channels, technicalDetail to logs
 * only, stored rows never rewritten, and the resolver never
 * invents a code for an unknown input.
 */
import { describe, expect, it } from "vitest";
import catalog from "../src/outcomes/outcomeCatalog.json";
import { codedMessage, getOutcome, resolveOutcome } from "../src/outcomes/outcomeAspects";

const outcomes = (
  catalog as { outcomes: Record<string, Record<string, unknown>> }
).outcomes;

const SAGA_ENTRIES: Record<
  string,
  {
    outcome: string;
    category: string;
    retryable: boolean;
    httpStatus: number;
    businessMessage: string;
  }
> = {
  FAILURE_SAGA_PAYMENT_NOT_COMPLETED: {
    outcome: "failure",
    category: "saga",
    retryable: false,
    httpStatus: 402,
    businessMessage: "Payment was not completed, so no screen ran and no trading leg started.",
  },
  FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED: {
    outcome: "failure",
    category: "saga",
    retryable: true,
    httpStatus: 502,
    businessMessage:
      "The paid screen failed to start; a one-time replacement-run credit was issued by the payment leg.",
  },
  SUCCESS_SAGA_SCREEN_COMPLETED: {
    outcome: "success",
    category: "saga",
    retryable: false,
    httpStatus: 200,
    businessMessage: "The paid screen completed.",
  },
  FAILURE_SAGA_SCREEN_FAILED: {
    outcome: "failure",
    category: "saga",
    retryable: true,
    httpStatus: 502,
    businessMessage: "The paid screen failed after starting.",
  },
  FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED: {
    outcome: "failure",
    category: "saga",
    retryable: true,
    httpStatus: 502,
    businessMessage:
      "The paid screen failed after starting; a one-time replacement-run credit was issued.",
  },
  FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED: {
    outcome: "failure",
    category: "saga",
    retryable: true,
    httpStatus: 502,
    businessMessage:
      "The paid screen failed after starting; a provider refund was requested (operator approval required before money moves).",
  },
  SUCCESS_SAGA_JOURNEY_APPROVED: {
    outcome: "success",
    category: "saga",
    retryable: false,
    httpStatus: 200,
    businessMessage: "The journey gate was approved; the saga will enter the trading leg.",
  },
  FAILURE_SAGA_JOURNEY_DENIED: {
    outcome: "failure",
    category: "saga",
    retryable: false,
    httpStatus: 200,
    businessMessage: "The journey gate was denied; the saga ends with no trades and no proposals.",
  },
  FAILURE_SAGA_JOURNEY_EXPIRED: {
    outcome: "failure",
    category: "saga",
    retryable: false,
    httpStatus: 200,
    businessMessage: "The journey gate expired unanswered; the saga ends with no trades and no proposals.",
  },
};

describe("saga outcome catalog (S1+S2+S3, #2041)", () => {
  it.each(Object.keys(SAGA_ENTRIES))("carries %s with its full contract", (code) => {
    const expected = SAGA_ENTRIES[code];
    const entry = outcomes[code];
    expect(entry, `catalog entry ${code}`).toBeDefined();
    expect(entry["code"]).toBe(code);
    expect(entry["outcome"]).toBe(expected.outcome);
    expect(entry["category"]).toBe(expected.category);
    expect(entry["retryable"]).toBe(expected.retryable);
    expect(entry["httpStatus"]).toBe(expected.httpStatus);
    expect(entry["businessMessage"]).toBe(expected.businessMessage);
    expect(typeof entry["technicalDetail"]).toBe("string");
    expect((entry["technicalDetail"] as string).length).toBeGreaterThan(0);
    expect(code).toMatch(/^(SUCCESS|FAILURE)_[A-Z_]+$/);
  });

  it.each(Object.keys(SAGA_ENTRIES))("resolves %s through the single resolver", (code) => {
    const resolved = resolveOutcome(code);
    expect(resolved.resolved).toBe(true);
    expect(resolved.code).toBe(code);
    expect(resolved.entry?.code).toBe(code);
    expect(getOutcome(code)?.code).toBe(code);
    expect(codedMessage(code)).toBe(`[${code}] ${SAGA_ENTRIES[code].businessMessage}`);
  });

  it("does not invent a code for an unknown saga-like input", () => {
    const resolved = resolveOutcome("FAILURE_SAGA_NOPE");
    expect(resolved.resolved).toBe(false);
    expect(resolved.entry).toBeNull();
    expect(codedMessage("FAILURE_SAGA_NOPE")).toBe("[FAILURE_SAGA_NOPE]");
  });

  it("S1's screen_failed entry stays valid and notes the S3 compensation lineage", () => {
    const entry = outcomes["FAILURE_SAGA_SCREEN_FAILED"];
    expect(entry["businessMessage"]).toBe("The paid screen failed after starting.");
    expect(entry["technicalDetail"]).toContain("S3 compensates");
    expect(entry["technicalDetail"]).toContain("FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED");
    expect(entry["technicalDetail"]).toContain("FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED");
  });
});
