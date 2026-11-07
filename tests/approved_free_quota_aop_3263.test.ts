// @vitest-environment node
/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — AOP coded
 * messages for the approved-free quota.
 *
 * The mechanism is the EXISTING outcome catalog (#2381) + its single
 * resolver — no new catalog, no second resolver, no revived error
 * catalog. Every new user-visible quota success and failure gets a
 * catalog entry (SUCCESS_... / FAILURE_... names), resolved ONLY
 * through the resolver. The failure kind is recorded structurally at the point
 * of failure (the port assert / adapter read throws
 * ApprovedFreeQuotaError with its kind); the route maps kind to
 * code; the panel renders the catalog businessMessage (#2573
 * precedent). Tests assert the message comes FROM the catalog, not
 * from a hardcoded string: the route bodies are compared against
 * resolveOutcome(code).businessMessage (see
 * tests/approved_free_quota_routes_3263.test.ts), and this file
 * pins the catalog contract + the kind→code mapping.
 */
import { describe, expect, it } from "vitest";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
import {
  APPROVED_FREE_QUOTA_ERROR_CODES,
  ApprovedFreeQuotaError,
  type ApprovedFreeQuotaErrorKind,
} from "../src/data/approvedFreeQuotaPorts";

const NEW_CODES: Array<{
  code: string;
  outcome: "success" | "failure";
  category: string;
  retryable: boolean;
  httpStatus: number;
}> = [
  { code: "SUCCESS_APPROVED_FREE_QUOTA_COVERED", outcome: "success", category: "commercial", retryable: false, httpStatus: 200 },
  { code: "SUCCESS_APPROVED_FREE_QUOTA_UPDATED", outcome: "success", category: "commercial", retryable: false, httpStatus: 200 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_CORRUPT", outcome: "failure", category: "commercial", retryable: false, httpStatus: 500 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_EXPIRED", outcome: "failure", category: "commercial", retryable: false, httpStatus: 200 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_ACTION", outcome: "failure", category: "commercial", retryable: false, httpStatus: 400 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_CAP", outcome: "failure", category: "commercial", retryable: false, httpStatus: 400 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_FAMILY", outcome: "failure", category: "commercial", retryable: false, httpStatus: 400 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_SETTINGS", outcome: "failure", category: "commercial", retryable: false, httpStatus: 400 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_WINDOW", outcome: "failure", category: "commercial", retryable: false, httpStatus: 400 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_MISSING_UPDATE", outcome: "failure", category: "commercial", retryable: false, httpStatus: 400 },
  { code: "FAILURE_APPROVED_FREE_QUOTA_UNAVAILABLE", outcome: "failure", category: "commercial", retryable: true, httpStatus: 503 },
];

describe("approved-free quota: outcome catalog entries (#3263, AOP)", () => {
  it("all eleven new codes resolve with their contract fields and a non-empty business message", () => {
    expect(NEW_CODES).toHaveLength(11);
    for (const { code, outcome, category, retryable, httpStatus } of NEW_CODES) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved).toBe(true);
      expect(resolved.entry).toMatchObject({ code, outcome, category, retryable, httpStatus });
      expect(typeof resolved.businessMessage).toBe("string");
      expect((resolved.businessMessage ?? "").length).toBeGreaterThan(0);
      expect(resolved.entry?.technicalDetail.length).toBeGreaterThan(0);
    }
  });

  it("the two pre-existing at-limit codes are unchanged", () => {
    for (const code of [
      "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED",
      "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED_STOP",
    ]) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved).toBe(true);
      expect(resolved.entry).toMatchObject({ outcome: "failure", category: "commercial", retryable: false, httpStatus: 402 });
    }
  });
});

describe("approved-free quota: typed errors map kind to catalog code (#3263, AOP)", () => {
  it("every kind maps to its catalog code and the message is the catalog business message", () => {
    const kinds = Object.keys(APPROVED_FREE_QUOTA_ERROR_CODES) as ApprovedFreeQuotaErrorKind[];
    expect(kinds).toHaveLength(7);
    for (const kind of kinds) {
      const err = new ApprovedFreeQuotaError(kind);
      expect(err).toBeInstanceOf(ApprovedFreeQuotaError);
      expect(err.kind).toBe(kind);
      expect(err.code).toBe(APPROVED_FREE_QUOTA_ERROR_CODES[kind]);
      // The message IS the catalog business message — asserted from
      // the catalog, never a hardcoded string.
      expect(err.message).toBe(resolveOutcome(err.code).businessMessage);
      expect(err.toJSON()).toEqual({
        code: err.code,
        message: resolveOutcome(err.code).businessMessage,
        retryable: resolveOutcome(err.code).entry?.retryable ?? false,
      });
    }
  });

  it("missing_context maps to the existing unexpected-error code (a server-side caller bug, not a quota code)", () => {
    expect(APPROVED_FREE_QUOTA_ERROR_CODES.missing_context).toBe("FAILURE_UNEXPECTED_ERROR");
  });
});
