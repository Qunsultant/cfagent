/**
 * Issue #5086 (S7, observability program #5080) — the one message
 * catalog: stable OBS codes, a human-readable template per code,
 * and a severity per message.
 *
 * TDD Red first: the catalog (src/observability/otelMessages.ts
 * expanded into the one catalog) does not exist yet, so this file
 * fails at import.
 *
 * Rules the catalog enforces:
 *  - Every OBS code OBS-1001..OBS-1023 resolves with its template
 *    + severity (the S1 seed + S2/S3/S4/S6 codes, absorbed without
 *    renumbering — codes are stable across releases, never reused
 *    for a different meaning — plus the two codes S7 adds).
 *  - An unknown code FAILS CLOSED: resolveCatalogMessage returns
 *    ok:false (rejected, never silently passing); the formatted
 *    rendering names it explicitly ([OBS-UNKNOWN]).
 *  - Template substitution renders the exact message text the
 *    producers emitted before S7 (the catalog adopts the existing
 *    text, it does not rewrite the deployed log format).
 *  - Severities are the catalog's default per code; the config
 *    port may override a code's severity at runtime (S7), the
 *    catalog never hard-codes a severity at a call site.
 */
import { describe, it, expect } from "vitest";
import {
  OBS_ALERTING_CAP_BREACH,
  OBS_ALERTING_CI_FAILURE,
  OBS_ALERTING_DESTINATION_MISSING,
  OBS_ALERTING_FREE_TIER_GUARD,
  OBS_ALERTING_RULE_UNKNOWN,
  OBS_ALERTING_SEND_FAILED,
  OBS_ALERTING_STUCK_RUN,
  OBS_ARCHIVE_FORBIDDEN,
  OBS_ARCHIVE_KEY_REJECTED,
  OBS_ARCHIVE_NOT_FOUND,
  OBS_ARCHIVE_UNAVAILABLE,
  OBS_AUDIT_CHAIN_APPEND_FAILED,
  OBS_CONFIG_FORBIDDEN,
  OBS_CONFIG_INVALID,
  OBS_EXPORT_FAILED,
  OBS_INGEST_FAILED,
  OBS_INGEST_REJECTED,
  OBS_LEDGER_WRITE_FAILED,
  OBS_METRICS_EXPORT_FAILED,
  OBS_METRICS_FREE_TIER_GUARD,
  OBS_SINK_DEGRADED,
  OBS_TRACES_EXPORT_FAILED,
  OBS_TRACES_FREE_TIER_GUARD,
  OBS_CATALOG,
  formatCatalogMessage,
  isKnownObsCode,
  resolveCatalogMessage,
  type ObsCatalogEntry,
} from "../src/observability/otelMessages";

/** The codes the catalog must carry (the S1 seed + every slice since). */
const EXPECTED_CODES = [
  OBS_CONFIG_INVALID,
  OBS_EXPORT_FAILED,
  OBS_INGEST_FAILED,
  OBS_INGEST_REJECTED,
  OBS_SINK_DEGRADED,
  OBS_METRICS_EXPORT_FAILED,
  OBS_METRICS_FREE_TIER_GUARD,
  OBS_ARCHIVE_UNAVAILABLE,
  OBS_ARCHIVE_KEY_REJECTED,
  OBS_ARCHIVE_NOT_FOUND,
  OBS_ARCHIVE_FORBIDDEN,
  OBS_TRACES_EXPORT_FAILED,
  OBS_TRACES_FREE_TIER_GUARD,
  OBS_ALERTING_SEND_FAILED,
  OBS_ALERTING_DESTINATION_MISSING,
  OBS_ALERTING_FREE_TIER_GUARD,
  OBS_ALERTING_STUCK_RUN,
  OBS_ALERTING_CAP_BREACH,
  OBS_ALERTING_CI_FAILURE,
  OBS_LEDGER_WRITE_FAILED,
  OBS_ALERTING_RULE_UNKNOWN,
  OBS_CONFIG_FORBIDDEN,
  OBS_AUDIT_CHAIN_APPEND_FAILED,
] as const;

describe("S7 message catalog (#5086)", () => {
  it("carries every OBS code with a template and a severity", () => {
    for (const code of EXPECTED_CODES) {
      const entry: ObsCatalogEntry | undefined = OBS_CATALOG[code];
      expect(entry, `${code} must be in the catalog`).toBeDefined();
      expect(entry!.code).toBe(code);
      expect(entry!.name.length).toBeGreaterThan(0);
      expect(entry!.template.length).toBeGreaterThan(0);
      expect(["info", "warning", "error", "critical"]).toContain(entry!.severity);
    }
  });

  it("pins the code list: no code is added, removed, or renumbered silently", () => {
    expect(Object.keys(OBS_CATALOG).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it("resolves a known code with its entry and rendered message", () => {
    const resolved = resolveCatalogMessage(OBS_CONFIG_INVALID, {
      switch: "OTEL_ENABLED",
      source: "env",
      fallback: "OFF",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.entry.code).toBe(OBS_CONFIG_INVALID);
      expect(resolved.entry.severity).toBe("warning");
      expect(resolved.message).toBe(
        "[OBS-1001] OTEL_ENABLED unrecognized value at env; failing closed to \"OFF\"",
      );
    }
  });

  it("renders the exact pre-S7 message text for each templated code", () => {
    expect(
      formatCatalogMessage(OBS_INGEST_REJECTED, { reason: "malformed JSON" }),
    ).toBe("[OBS-1004] OTLP ingestion rejected: malformed JSON");
    expect(
      formatCatalogMessage(OBS_INGEST_REJECTED, {
        reason: "payload has no resourceLogs array",
      }),
    ).toBe("[OBS-1004] OTLP ingestion rejected: payload has no resourceLogs array");
    expect(
      formatCatalogMessage(OBS_INGEST_FAILED, { key: "otel-archive/2026-11-18/x.jsonl", error: "boom" }),
    ).toBe(
      "[OBS-1003] OTLP ingestion failed writing otel-archive/2026-11-18/x.jsonl to R2: boom",
    );
    expect(
      formatCatalogMessage(OBS_ARCHIVE_UNAVAILABLE, { reason: "REPORTS_BUCKET is not bound" }),
    ).toBe("[OBS-1008] OTel archive unavailable: REPORTS_BUCKET is not bound");
    expect(
      formatCatalogMessage(OBS_ARCHIVE_KEY_REJECTED, {
        reason: "the key must be under otel-archive/",
      }),
    ).toBe("[OBS-1009] OTel archive key rejected: the key must be under otel-archive/");
    expect(formatCatalogMessage(OBS_ARCHIVE_NOT_FOUND, { key: "otel-archive/nope.jsonl" })).toBe(
      "[OBS-1010] OTel archive object not found: otel-archive/nope.jsonl",
    );
    expect(
      formatCatalogMessage(OBS_METRICS_FREE_TIER_GUARD, { limit: 100000, day: "2026-11-18" }),
    ).toBe(
      "[OBS-1007] Analytics Engine daily write limit reached (100000 writes for 2026-11-18); further metric writes are dropped for the rest of the day. The OTLP/R2 archive path is unaffected.",
    );
    expect(
      formatCatalogMessage(OBS_TRACES_FREE_TIER_GUARD, { limit: 100000, day: "2026-11-18" }),
    ).toBe(
      "[OBS-1013] Analytics Engine daily write limit reached (100000 writes for 2026-11-18); further span writes are dropped for the rest of the day. The OTLP/R2 archive path is unaffected.",
    );
    expect(
      formatCatalogMessage(OBS_SINK_DEGRADED, { eventType: "job.run.settled", error: "boom" }),
    ).toBe('[OBS-1005] OTel sink could not emit "job.run.settled": boom');
    // OBS-1002 / OBS-1006 / OBS-1012 are the exporter codes whose
    // message shape varies by failure stage (extraction vs
    // serialization vs transport), so their template is {detail}:
    // the call site supplies the stage detail, the catalog owns
    // the code, the severity, and the routing.
    expect(
      formatCatalogMessage(OBS_METRICS_EXPORT_FAILED, {
        detail: "Metric series extraction failed: boom",
      }),
    ).toBe("[OBS-1006] Metric series extraction failed: boom");
    expect(
      formatCatalogMessage(OBS_METRICS_EXPORT_FAILED, {
        detail: "OTLP metrics serialization failed: boom",
      }),
    ).toBe("[OBS-1006] OTLP metrics serialization failed: boom");
    expect(
      formatCatalogMessage(OBS_EXPORT_FAILED, {
        detail: "OTLP serialization failed: boom",
      }),
    ).toBe("[OBS-1002] OTLP serialization failed: boom");
    expect(
      formatCatalogMessage(OBS_TRACES_EXPORT_FAILED, {
        detail: "Span event conversion failed: boom",
      }),
    ).toBe("[OBS-1012] Span event conversion failed: boom");
  });

  it("fails closed on an unknown code: rejected, never silently passed", () => {
    const resolved = resolveCatalogMessage("OBS-9999", { reason: "x" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("OBS-9999");
      expect(resolved.reason).toMatch(/not in the message catalog/);
    }
    expect(formatCatalogMessage("OBS-9999")).toBe(
      "[OBS-UNKNOWN] OBS-9999 is not in the message catalog",
    );
    expect(isKnownObsCode("OBS-9999")).toBe(false);
    expect(isKnownObsCode(OBS_CONFIG_INVALID)).toBe(true);
  });

  it("leaves an unsupplied template field verbatim so a missing field is visible", () => {
    expect(formatCatalogMessage(OBS_INGEST_REJECTED)).toBe(
      "[OBS-1004] OTLP ingestion rejected: {reason}",
    );
  });

  it("gives the alert-subject codes their catalog severities", () => {
    expect(OBS_CATALOG[OBS_ALERTING_STUCK_RUN]?.severity).toBe("warning");
    expect(OBS_CATALOG[OBS_ALERTING_CAP_BREACH]?.severity).toBe("warning");
    expect(OBS_CATALOG[OBS_ALERTING_CI_FAILURE]?.severity).toBe("error");
    expect(OBS_CATALOG[OBS_LEDGER_WRITE_FAILED]?.severity).toBe("error");
    expect(OBS_CATALOG[OBS_ALERTING_SEND_FAILED]?.severity).toBe("error");
    expect(OBS_CATALOG[OBS_ALERTING_RULE_UNKNOWN]?.severity).toBe("error");
    expect(OBS_CATALOG[OBS_CONFIG_FORBIDDEN]?.severity).toBe("warning");
    expect(OBS_CATALOG[OBS_AUDIT_CHAIN_APPEND_FAILED]?.severity).toBe(
      "error",
    );
    expect(
      formatCatalogMessage(OBS_AUDIT_CHAIN_APPEND_FAILED, {
        tenantId: "acme",
        action: "platform.tenant_admin.create",
        error: "boom",
      }),
    ).toBe(
      "[OBS-1023] Audit-chain append failed for tenant acme (platform.tenant_admin.create): boom",
    );
    expect(
      formatCatalogMessage(OBS_ALERTING_RULE_UNKNOWN, { ruleId: "rule:nope" }),
    ).toBe('[OBS-1021] Alert report rejected: unknown rule id "rule:nope"');
    expect(formatCatalogMessage(OBS_CONFIG_FORBIDDEN)).toBe(
      "[OBS-1022] OTel config is available to platform admins only",
    );
  });
});
