/**
 * Issue #2381 (phase 1): the single outcome catalog — success AND
 * failure entries under meaningful outcome-encoded names, one
 * resolver, and a read-time-only legacy-alias map.
 *
 * The old strings below appear ONLY as alias fixtures: they assert
 * that pre-rename stored values still resolve at read time. No
 * emitter in src references them (see the phase 1 grep proof).
 * Stored rows are never rewritten: resolving a stored row must not
 * mutate it, and the resolver must never invent a code for an
 * unknown input — unknown codes pass through unresolved.
 */
import { describe, expect, it } from "vitest";
import catalog from "../src/outcomes/outcomeCatalog.json";
import {
  BusinessError,
  classifyRunDetailError,
  codedMessage,
  getOutcome,
  getRunDetailMessageCatalog,
  hasOutcomeCodePrefix,
  LEGACY_OUTCOME_ALIASES,
  resolveOutcome,
  resolveRunDetailMessage,
  RUN_DETAIL_MESSAGE_CATALOG_VERSION,
} from "../src/outcomes/outcomeAspects";

const outcomes = (catalog as {
  outcomes: Record<string, Record<string, unknown>>;
  legacyAliases: Record<string, string>;
}).outcomes;

const LEGACY_ALIASES: Record<string, string> = {
  AUTH_001: "FAILURE_AUTH_TOKEN_MISSING",
  AUTH_002: "FAILURE_AUTH_TOKEN_EXPIRED",
  AUTH_003: "FAILURE_AUTH_NO_SESSION",
  QUOTE_001: "FAILURE_QUOTE_AUTH_MISSING",
  QUOTE_002: "FAILURE_QUOTE_SERVICE_UNAVAILABLE",
  QUOTE_003: "FAILURE_QUOTE_PARTIAL_SYMBOLS",
  QUOTE_004: "FAILURE_QUOTE_FORMAT_UNEXPECTED",
  QUOTE_005: "FAILURE_QUOTE_DATA_STALE",
  QUOTE_006: "FAILURE_QUOTE_RATE_LIMITED",
  SYS_001: "FAILURE_UNEXPECTED_ERROR",
  WATCHLIST_001: "FAILURE_WATCHLIST_UNAVAILABLE",
  SCREEN_001: "FAILURE_SCREEN_RUN_FAILED",
  SCREEN_002: "FAILURE_SCREEN_PARTIAL_COVERAGE",
  SCREEN_003: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
  REPORT_001: "FAILURE_REPORT_PDF_GENERATION",
  REPORT_002: "FAILURE_REPORT_XLSX_GENERATION",
  REPORT_003: "FAILURE_REPORT_ARTIFACT_MISSING",
  REPORT_004: "FAILURE_REPORT_CSV_GENERATION",
  DELIVER_001: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED",
  DELIVER_002: "FAILURE_DELIVERY_CHANNEL_FAILED",
  DATA_001: "FAILURE_DATA_PROVIDER_UNAVAILABLE",
  MCP_001: "FAILURE_MCP_PERMISSION_DENIED",
};

describe("outcome catalog (#2381)", () => {
  it("carries new names only — no old cryptic code is a catalog key", () => {
    for (const key of Object.keys(outcomes)) {
      expect(key, `catalog key ${key}`).not.toMatch(/^[A-Z]+_[0-9]{3}$/);
      expect(key).toMatch(/^(SUCCESS|FAILURE)_[A-Z_]+$/);
    }
    for (const key of Object.keys(outcomes)) {
      const entry = outcomes[key] as Record<string, unknown>;
      expect(entry.code).toBe(key);
      expect(entry.outcome).toBe(
        key.startsWith("SUCCESS_") ? "success" : "failure",
      );
      expect(typeof entry.businessMessage).toBe("string");
      expect((entry.businessMessage as string).length).toBeGreaterThan(0);
      expect(typeof entry.technicalDetail).toBe("string");
      expect(typeof entry.category).toBe("string");
      expect(typeof entry.retryable).toBe("boolean");
      expect(typeof entry.httpStatus).toBe("number");
    }
  });

  it("covers success entries for job outcomes", () => {
    for (const code of [
      "SUCCESS_SCREEN_COMPLETED",
      "SUCCESS_SCREEN_PARTIAL_RESULTS",
      "SUCCESS_REPORT_PDF_GENERATED",
      "SUCCESS_REPORT_XLSX_GENERATED",
      "SUCCESS_REPORT_CSV_GENERATED",
      "SUCCESS_REPORT_DELIVERED",
      "SUCCESS_JOB_COMPLETED",
    ]) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved).toBe(true);
      expect(resolved.entry?.outcome).toBe("success");
      expect(codedMessage(code)).toBe(
        `[${code}] ${resolved.entry?.businessMessage}`,
      );
    }
    expect(codedMessage("SUCCESS_SCREEN_COMPLETED")).toContain(
      "Screen completed",
    );
  });

  it("resolves cataloged failure entries", () => {
    const resolved = resolveOutcome("FAILURE_AUTH_TOKEN_EXPIRED");
    expect(resolved.resolved).toBe(true);
    expect(resolved.entry?.outcome).toBe("failure");
    expect(codedMessage("FAILURE_AUTH_TOKEN_EXPIRED")).toBe(
      "[FAILURE_AUTH_TOKEN_EXPIRED] E*TRADE connection expired. Please reconnect your account in Settings.",
    );
    expect(
      codedMessage(
        "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED",
        "recipient ops@example.com",
      ),
    ).toBe(
      "[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED] The delivery recipient is not on the screener email allowlist; delivery refused. — recipient ops@example.com",
    );
    expect(codedMessage("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED")).toContain(
      "[FAILURE_SCREEN_NO_CONTRACTS_EVALUATED]",
    );
  });

  it("passes unknown codes through unresolved — a read never fails, never invents", () => {
    const resolved = resolveOutcome("NOPE_999");
    expect(resolved.resolved).toBe(false);
    expect(resolved.entry).toBeNull();
    expect(resolved.code).toBe("NOPE_999");
    expect(resolved.businessMessage).toBeNull();
    expect(getOutcome("NOPE_999")).toBeNull();
    expect(codedMessage("NOPE_999")).toBe("[NOPE_999]");
    expect(codedMessage("NOPE_999", "some detail")).toBe(
      "[NOPE_999] — some detail",
    );
    // Never silently substituted with the unexpected-error entry.
    expect(codedMessage("NOPE_999")).not.toContain("FAILURE_UNEXPECTED_ERROR");
    expect(() => resolveOutcome("")).not.toThrow();
  });

  it("resolves pre-rename values through the legacy-alias map (read time only)", () => {
    expect(LEGACY_OUTCOME_ALIASES).toEqual(LEGACY_ALIASES);
    expect(
      (catalog as { legacyAliases: Record<string, string> }).legacyAliases,
    ).toEqual(LEGACY_ALIASES);
    for (const [oldCode, newCode] of Object.entries(LEGACY_ALIASES)) {
      const resolved = resolveOutcome(oldCode);
      expect(resolved.resolved).toBe(true);
      expect(resolved.inputCode).toBe(oldCode);
      expect(resolved.code).toBe(newCode);
      expect(resolved.entry?.code).toBe(newCode);
      expect(getOutcome(oldCode)?.code).toBe(newCode);
      // Rendering a stored old value shows the NEW code and message.
      expect(codedMessage(oldCode)).toBe(codedMessage(newCode));
      expect(codedMessage(oldCode)).toContain(`[${newCode}]`);
    }
    // Preserved business messages, verbatim from the old catalog.
    expect(codedMessage("AUTH_002")).toBe(
      "[FAILURE_AUTH_TOKEN_EXPIRED] E*TRADE connection expired. Please reconnect your account in Settings.",
    );
    expect(codedMessage("REPORT_001")).toBe(
      "[FAILURE_REPORT_PDF_GENERATION] The PDF report could not be generated.",
    );
  });

  it("never rewrites a stored row", () => {
    const storedRow = Object.freeze({
      code: "AUTH_002",
      message: "[AUTH_002] E*TRADE connection expired.",
      status: "failed",
    });
    const before = JSON.stringify(storedRow);
    const resolved = resolveOutcome(storedRow.code);
    expect(resolved.code).toBe("FAILURE_AUTH_TOKEN_EXPIRED");
    expect(JSON.stringify(storedRow)).toBe(before);
    expect(storedRow.code).toBe("AUTH_002");
    // A BusinessError built from a stored old code normalizes only
    // its own in-memory code; the stored row above is untouched.
    expect(new BusinessError("AUTH_003").code).toBe(
      "FAILURE_AUTH_NO_SESSION",
    );
    expect(new BusinessError("FAILURE_SCREEN_RUN_FAILED").toJSON()).toEqual({
      code: "FAILURE_SCREEN_RUN_FAILED",
      message: "The screen run failed.",
      retryable: true,
    });
  });

  it("recognizes already-coded messages, old or new, for the report parsers", () => {
    expect(
      hasOutcomeCodePrefix("[FAILURE_REPORT_PDF_GENERATION] boom"),
    ).toBe(true);
    expect(hasOutcomeCodePrefix("[REPORT_001] boom")).toBe(true);
    expect(hasOutcomeCodePrefix("plain failure text")).toBe(false);
    expect(hasOutcomeCodePrefix("[NOPE_999] boom")).toBe(false);
  });
});

/**
 * Issue #2608 (option a): the 18 RUN_* Run Details messages live in
 * the same catalog file as a top-level "runDetailMessages" section —
 * the #2975 channelTemplates precedent. RUN_* codes are display
 * templates with {param} placeholders, an action, a severity and a
 * level, NOT SUCCESS/FAILURE outcomes, so they are never "outcomes"
 * keys: the pin above still requires every outcomes key to match
 * SUCCESS|FAILURE, and the outcomes count is unchanged at 77.
 */
describe("outcome catalog: run detail messages (#2608)", () => {
  const runMessages = (
    catalog as {
      runDetailMessages: Record<string, Record<string, unknown>>;
    }
  ).runDetailMessages;

  const RUN_CODES = [
    "RUN_NO_ARTIFACT_RECORDED",
    "RUN_PDF_FAILED",
    "RUN_XLSX_FAILED",
    "RUN_CSV_FAILED",
    "RUN_EMPTY_RESULT",
    "RUN_PARTIAL_COVERAGE",
    "RUN_CAPTURE_MISSING",
    "RUN_CONNECTOR_UNAVAILABLE",
    "RUN_PROVIDER_FETCH_FAILED",
    "RUN_FIT_GATE_ALL_REJECTED",
    "RUN_DTE_EXCLUDED_ALL",
    "RUN_DUPLICATE_SUPPRESSED",
    "RUN_SERVICE_USER_NOT_PROVISIONED",
    "RUN_QUEUE_DROPPED",
    "RUN_BRIDGE_SERVE_SKIPPED",
    "RUN_STAGE_FAILED",
    "RUN_NEVER_ATTEMPTED",
    "RUN_LEGACY_UNKNOWN",
  ];

  it("carries the 18 RUN_* messages as a top-level section, never as outcome keys", () => {
    expect(Object.keys(runMessages).sort()).toEqual([...RUN_CODES].sort());
    // 123 on the #4002 head: 122 on the #3907 head (121 on the
    // #2667 rebased head (117 on main + 4 slice codes
    // FAILURE_/SUCCESS_USAGE_BILLING_*) + 1 (#3907
    // FAILURE_ASYNC_JOB_TIMEOUT)) + 1 (#4002
    // FAILURE_ASYNC_JOB_ORPHANED). The count pins that no RUN_*
    // code leaked into "outcomes".
    expect(Object.keys(outcomes)).toHaveLength(123);
    expect(Object.keys(outcomes).some((k) => k.startsWith("RUN_"))).toBe(false);
    for (const code of RUN_CODES) {
      expect(code).toMatch(/^RUN_[A-Z_]+$/);
      expect(resolveOutcome(code).resolved).toBe(false);
    }
    expect(RUN_DETAIL_MESSAGE_CATALOG_VERSION).toBe("2");
    expect(getRunDetailMessageCatalog()).toBe(runMessages);
  });

  it("each entry carries template/action/severity/level/params, and params name exactly the template placeholders", () => {
    for (const code of RUN_CODES) {
      const entry = runMessages[code];
      expect(entry.code).toBe(code);
      expect(["info", "warning", "error"]).toContain(entry.severity);
      expect(["info", "debugging", "error"]).toContain(entry.level);
      expect(typeof entry.template).toBe("string");
      expect((entry.template as string).length).toBeGreaterThan(0);
      expect(typeof entry.action).toBe("string");
      expect((entry.action as string).length).toBeGreaterThan(0);
      expect(Array.isArray(entry.params)).toBe(true);
      const placeholders = [
        ...new Set(
          [...(entry.template as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
        ),
      ].sort();
      expect([...(entry.params as string[])].sort()).toEqual(placeholders);
    }
  });

  it("resolves every RUN_* code through the single resolver, with template substitution", () => {
    const pdf = resolveRunDetailMessage("RUN_PDF_FAILED", { error: ": boom" });
    expect(pdf.code).toBe("RUN_PDF_FAILED");
    expect(pdf.text).toBe(
      "PDF generation failed for this run: boom. The PDF leg failed while the other legs were attempted independently.",
    );
    expect(pdf.severity).toBe("error");
    expect(pdf.action).toContain("regenerate the PDF");
    const stage = resolveRunDetailMessage("RUN_STAGE_FAILED", { stage: "analysis", error: "" });
    expect(stage.text).toContain("The analysis stage failed for this run.");
    expect(stage.text).not.toContain("{");
    // Unfilled optional evidence slots render empty, never raw "{param}".
    expect(resolveRunDetailMessage("RUN_PDF_FAILED").text).not.toContain("{error}");
    expect(resolveRunDetailMessage("RUN_CAPTURE_MISSING").text).not.toContain("{capture}");
    // Unknown codes render as a catalog-miss, never a guessed message.
    expect(resolveRunDetailMessage("RUN_DOES_NOT_EXIST").text).toContain("RUN_DOES_NOT_EXIST");
    expect(resolveRunDetailMessage("RUN_DOES_NOT_EXIST").text).toContain("version 2");
  });

  it("classifies recorded errors only to codes the catalog resolves", () => {
    const samples: Array<[string | null, string | null]> = [
      ["connector unavailable for enriching data", "RUN_CONNECTOR_UNAVAILABLE"],
      ["provider fetch failed", "RUN_PROVIDER_FETCH_FAILED"],
      ["etrade timeout", "RUN_PROVIDER_FETCH_FAILED"],
      ["service user not provisioned", "RUN_SERVICE_USER_NOT_PROVISIONED"],
      ["queue message dropped", "RUN_QUEUE_DROPPED"],
      ["duplicate run suppressed", "RUN_DUPLICATE_SUPPRESSED"],
      ["something else entirely", null],
      [null, null],
    ];
    for (const [error, code] of samples) {
      expect(classifyRunDetailError(error)).toBe(code);
      if (code) {
        expect(resolveRunDetailMessage(code).code).toBe(code);
        expect(resolveRunDetailMessage(code).text).not.toContain("has no catalog entry");
      }
    }
  });

  it("keeps near-equivalent FAILURE_* outcome codes distinct from RUN_* renderings", () => {
    // RUN_PDF_FAILED / RUN_XLSX_FAILED / RUN_CSV_FAILED have
    // near-equivalent FAILURE_REPORT_* outcomes, but the RUN_*
    // entries are the run-detail renderings: they carry the {error}
    // evidence slot and a remediation action the short business
    // messages do not. Neither aliases the other.
    for (const [run, failure] of [
      ["RUN_PDF_FAILED", "FAILURE_REPORT_PDF_GENERATION"],
      ["RUN_XLSX_FAILED", "FAILURE_REPORT_XLSX_GENERATION"],
      ["RUN_CSV_FAILED", "FAILURE_REPORT_CSV_GENERATION"],
    ] as const) {
      expect(resolveOutcome(failure).resolved).toBe(true);
      expect(resolveRunDetailMessage(run).text).not.toBe(
        codedMessage(failure),
      );
      expect(resolveRunDetailMessage(run).text).toContain("failed for this run");
    }
    expect(resolveOutcome("FAILURE_REPORT_ARTIFACT_MISSING").resolved).toBe(true);
  });
});
