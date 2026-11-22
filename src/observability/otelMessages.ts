/**
 * Issue #5081 (S1, observability program #5080) — the coded
 * OTel messages (OBS-####). Adopted and expanded by #5086 (S7)
 * into the ONE message catalog for all of cfagent telemetry.
 *
 * The catalog is the single source for message text: every log /
 * audit / alert / trace event carries a catalog code, and the
 * rendered message comes from the catalog's template — no
 * free-form message string at a call site. Codes are stable
 * across releases (never reused for a different meaning).
 *
 * Each entry carries a severity: the catalog's DEFAULT severity
 * for the code. The config port (#5086, src/config/otelConfigPort.ts)
 * may override a code's severity at runtime
 * (`catalog.<OBS-code>.severity`); the catalog default is what
 * a fresh deploy uses.
 *
 * Codes used in S1:
 *  OBS-1001 otel.config.invalid — a switch value failed closed.
 *  OBS-1002 otel.export.failed — the OTLP exporter failed to
 *    export a batch (transport or serialization failure).
 *  OBS-1003 otel.ingest.failed — the ingestion route failed to
 *    write a batch to R2.
 *  OBS-1004 otel.ingest.rejected — the ingestion route rejected
 *    a malformed OTLP payload.
 *  OBS-1005 otel.sink.degraded — the OTel sink dropped or could
 *    not emit a log record.
 *
 * Codes added in S2 (#5082, metrics):
 *  OBS-1006 otel.metrics.export.failed — the OTLP metrics
 *    exporter failed to export a batch (transport or
 *    serialization failure).
 *  OBS-1007 otel.metrics.free_tier_guard — the metrics
 *    free-tier write guard dropped Analytics Engine writes for
 *    the day (the configured daily write limit was reached).
 *
 * Codes added for the R2 archive sub-tab (#5169, interim file
 * browser over the same archive):
 *  OBS-1008 otel.archive.unavailable — the archive could not be
 *    read (R2 unbound, or the audit write a read depends on
 *    failed).
 *  OBS-1009 otel.archive.key_rejected — the requested key is
 *    outside the otel-archive/ prefix (or missing).
 *  OBS-1010 otel.archive.not_found — no object exists under the
 *    requested archive key.
 *  OBS-1011 otel.archive.forbidden — a signed-in non-admin was
 *    denied the archive (authenticated, not platform-admin).
 *
 * Codes added in S3 (#2808, tracing):
 *  OBS-1012 otel.traces.export.failed — the OTLP traces
 *    exporter failed to export a batch (transport or
 *    serialization failure).
 *  OBS-1013 otel.traces.free_tier_guard — the traces
 *    free-tier write guard dropped Analytics Engine writes for
 *    the day (the configured daily write limit was reached).
 *
 * Codes added in S4 (#5083, error-reporting / alerting):
 *  OBS-1014 otel.alerting.send.failed — the alerting port
 *    failed to deliver an alert (every enabled channel failed).
 *  OBS-1015 otel.alerting.destination.missing — an alert had
 *    no configured destination (no Slack token/webhook AND no
 *    email binding, or no email recipients).
 *  OBS-1016 otel.alerting.free_tier_guard — the alerting
 *    free-tier guard dropped alerts for the day (the configured
 *    max alerts per day was reached).
 *  OBS-1017 otel.alerting.stuck_run — the sweep stuck-run
 *    alert (a job has been RUNNING past the stuck threshold).
 *  OBS-1018 otel.alerting.cap_breach — the SessionStore
 *    resource cap alert (a free-tier budget is at/over 70%).
 *  OBS-1019 otel.alerting.ci_failure — the CI failure alert
 *    (a GitHub Actions workflow failed on main).
 *
 * Codes added in S6 (#5085, recording — one runs ledger):
 *  OBS-1020 otel.ledger.write_failed — a runs-ledger write
 *    failed and was named (audited + logged) instead of
 *    vanishing silently. The #4921 KV marker sink is the
 *    follow-up mechanism for naming a failure the SQL path
 *    cannot report; OBS-1020 names it on the audit/log path.
 *
 * Codes added in S7 (#5086, this slice — the catalog itself):
 *  OBS-1021 otel.alerting.rule.unknown — an alert report
 *    carried an unknown rule id (not a catalog rule and not a
 *    placeholder-* rule). The report is rejected, never sent.
 *  OBS-1022 otel.config.forbidden — a signed-in non-admin was
 *    denied the OTel config (authenticated, not platform-admin).
 *
 * Codes added in #6112 (audit-chain race fix):
 *  OBS-1023 otel.audit_chain.append_failed — an audit-chain
 *    append failed after the bounded retry (or the append itself
 *    threw) and was named (audited + logged) instead of vanishing
 *    silently in appendAuditChainBestEffort.
 *
 * The three exporter codes (OBS-1002 / OBS-1006 / OBS-1012)
 * carry a `{detail}` template: their message shape varies by
 * failure stage (extraction vs serialization vs transport), so
 * the call site supplies the stage detail and the catalog owns
 * the code, the severity, and the routing. Every other code's
 * template is fixed; its fields are the event's data.
 */

/** A switch value failed closed to the safe default (OFF / none / 0). */
export const OBS_CONFIG_INVALID = "OBS-1001" as const;
/** The OTLP exporter failed to export a batch. */
export const OBS_EXPORT_FAILED = "OBS-1002" as const;
/** The ingestion route failed to write a batch to R2. */
export const OBS_INGEST_FAILED = "OBS-1003" as const;
/** The ingestion route rejected a malformed OTLP payload. */
export const OBS_INGEST_REJECTED = "OBS-1004" as const;
/** The OTel sink dropped or could not emit a log record. */
export const OBS_SINK_DEGRADED = "OBS-1005" as const;
/** The OTLP metrics exporter failed to export a batch. */
export const OBS_METRICS_EXPORT_FAILED = "OBS-1006" as const;
/** The metrics free-tier write guard dropped Analytics Engine writes for the day. */
export const OBS_METRICS_FREE_TIER_GUARD = "OBS-1007" as const;
/** The OTel archive could not be read (R2 unbound, or the audit a read depends on failed). */
export const OBS_ARCHIVE_UNAVAILABLE = "OBS-1008" as const;
/** The requested archive key is outside the otel-archive/ prefix (or missing). */
export const OBS_ARCHIVE_KEY_REJECTED = "OBS-1009" as const;
/** No object exists under the requested archive key. */
export const OBS_ARCHIVE_NOT_FOUND = "OBS-1010" as const;
/** A signed-in non-admin was denied the OTel archive. */
export const OBS_ARCHIVE_FORBIDDEN = "OBS-1011" as const;
/** The OTLP traces exporter failed to export a batch. */
export const OBS_TRACES_EXPORT_FAILED = "OBS-1012" as const;
/** The traces free-tier write guard dropped Analytics Engine writes for the day. */
export const OBS_TRACES_FREE_TIER_GUARD = "OBS-1013" as const;
/** The alerting port failed to deliver an alert (every enabled channel failed). */
export const OBS_ALERTING_SEND_FAILED = "OBS-1014" as const;
/** An alert had no configured destination (no Slack token/webhook AND no email binding/recipients). */
export const OBS_ALERTING_DESTINATION_MISSING = "OBS-1015" as const;
/** The alerting free-tier guard dropped alerts for the day (max alerts per day reached). */
export const OBS_ALERTING_FREE_TIER_GUARD = "OBS-1016" as const;
/** The sweep stuck-run alert (a job has been RUNNING past the stuck threshold). */
export const OBS_ALERTING_STUCK_RUN = "OBS-1017" as const;
/** The SessionStore resource cap alert (a free-tier budget is at/over 70%). */
export const OBS_ALERTING_CAP_BREACH = "OBS-1018" as const;
/** The CI failure alert (a GitHub Actions workflow failed on main). */
export const OBS_ALERTING_CI_FAILURE = "OBS-1019" as const;
/** A runs-ledger write failed and was named (audited + logged) instead of vanishing silently. */
export const OBS_LEDGER_WRITE_FAILED = "OBS-1020" as const;
/** An alert report carried an unknown rule id (rejected, never sent). */
export const OBS_ALERTING_RULE_UNKNOWN = "OBS-1021" as const;
/** A signed-in non-admin was denied the OTel config. */
export const OBS_CONFIG_FORBIDDEN = "OBS-1022" as const;
/** An audit-chain append failed and was named (audited + logged) instead of vanishing silently. */
export const OBS_AUDIT_CHAIN_APPEND_FAILED = "OBS-1023" as const;

/** Issue #5425 (#3515 S5) — the SLO read is available to platform admins only. */
export const OBS_SLO_FORBIDDEN = "OBS-1024" as const;

/** Issue #5425 (#3515 S5) — the SLO read could not be served (admin check / audit failed). */
export const OBS_SLO_UNAVAILABLE = "OBS-1025" as const;

/**
 * The severity scale for coded messages. The S4 placeholder
 * severities ("info" | "warning" | "error" | "critical") are
 * now the real catalog scale: S7 replaces the placeholders
 * with catalog-resolved severities, keeping the same four
 * values so no consumer changes shape.
 */
export type ObsSeverity = "info" | "warning" | "error" | "critical";

/** One catalog entry: the code, its dotted event name, its template, and its default severity. */
export interface ObsCatalogEntry {
  code: string;
  name: string;
  template: string;
  severity: ObsSeverity;
}

/** The template fields a call site supplies (string or number values only). */
export type ObsTemplateFields = Record<string, string | number>;

/**
 * The one message catalog. Keyed by code; the key IS the code,
 * so a lookup by an unknown code misses (never a silent pass).
 */
export const OBS_CATALOG: Readonly<Record<string, ObsCatalogEntry>> = {
  [OBS_CONFIG_INVALID]: {
    code: OBS_CONFIG_INVALID,
    name: "otel.config.invalid",
    template: `{switch} unrecognized value at {source}; failing closed to "{fallback}"`,
    severity: "warning",
  },
  [OBS_EXPORT_FAILED]: {
    code: OBS_EXPORT_FAILED,
    name: "otel.export.failed",
    template: "{detail}",
    severity: "error",
  },
  [OBS_INGEST_FAILED]: {
    code: OBS_INGEST_FAILED,
    name: "otel.ingest.failed",
    template: "OTLP ingestion failed writing {key} to R2: {error}",
    severity: "error",
  },
  [OBS_INGEST_REJECTED]: {
    code: OBS_INGEST_REJECTED,
    name: "otel.ingest.rejected",
    template: "OTLP ingestion rejected: {reason}",
    severity: "warning",
  },
  [OBS_SINK_DEGRADED]: {
    code: OBS_SINK_DEGRADED,
    name: "otel.sink.degraded",
    template: `OTel sink could not emit "{eventType}": {error}`,
    severity: "warning",
  },
  [OBS_METRICS_EXPORT_FAILED]: {
    code: OBS_METRICS_EXPORT_FAILED,
    name: "otel.metrics.export.failed",
    template: "{detail}",
    severity: "error",
  },
  [OBS_METRICS_FREE_TIER_GUARD]: {
    code: OBS_METRICS_FREE_TIER_GUARD,
    name: "otel.metrics.free_tier_guard",
    template:
      "Analytics Engine daily write limit reached ({limit} writes for {day}); further metric writes are dropped for the rest of the day. The OTLP/R2 archive path is unaffected.",
    severity: "warning",
  },
  [OBS_ARCHIVE_UNAVAILABLE]: {
    code: OBS_ARCHIVE_UNAVAILABLE,
    name: "otel.archive.unavailable",
    template: "OTel archive unavailable: {reason}",
    severity: "error",
  },
  [OBS_ARCHIVE_KEY_REJECTED]: {
    code: OBS_ARCHIVE_KEY_REJECTED,
    name: "otel.archive.key_rejected",
    template: "OTel archive key rejected: {reason}",
    severity: "warning",
  },
  [OBS_ARCHIVE_NOT_FOUND]: {
    code: OBS_ARCHIVE_NOT_FOUND,
    name: "otel.archive.not_found",
    template: "OTel archive object not found: {key}",
    severity: "info",
  },
  [OBS_ARCHIVE_FORBIDDEN]: {
    code: OBS_ARCHIVE_FORBIDDEN,
    name: "otel.archive.forbidden",
    template: "OTel archive is available to platform admins only",
    severity: "warning",
  },
  [OBS_TRACES_EXPORT_FAILED]: {
    code: OBS_TRACES_EXPORT_FAILED,
    name: "otel.traces.export.failed",
    template: "{detail}",
    severity: "error",
  },
  [OBS_TRACES_FREE_TIER_GUARD]: {
    code: OBS_TRACES_FREE_TIER_GUARD,
    name: "otel.traces.free_tier_guard",
    template:
      "Analytics Engine daily write limit reached ({limit} writes for {day}); further span writes are dropped for the rest of the day. The OTLP/R2 archive path is unaffected.",
    severity: "warning",
  },
  [OBS_ALERTING_SEND_FAILED]: {
    code: OBS_ALERTING_SEND_FAILED,
    name: "otel.alerting.send.failed",
    template: "Alert delivery failed: {detail}",
    severity: "error",
  },
  [OBS_ALERTING_DESTINATION_MISSING]: {
    code: OBS_ALERTING_DESTINATION_MISSING,
    name: "otel.alerting.destination.missing",
    template: "Alert had no configured destination: {detail}",
    severity: "warning",
  },
  [OBS_ALERTING_FREE_TIER_GUARD]: {
    code: OBS_ALERTING_FREE_TIER_GUARD,
    name: "otel.alerting.free_tier_guard",
    template:
      "Alert free-tier guard dropped alerts for the day (max {maxAlertsPerDay} alerts per day reached)",
    severity: "warning",
  },
  [OBS_ALERTING_STUCK_RUN]: {
    code: OBS_ALERTING_STUCK_RUN,
    name: "otel.alerting.stuck_run",
    template: "Stuck run alert: {detail}",
    severity: "warning",
  },
  [OBS_ALERTING_CAP_BREACH]: {
    code: OBS_ALERTING_CAP_BREACH,
    name: "otel.alerting.cap_breach",
    template: "SessionStore resource cap alert: {detail}",
    severity: "warning",
  },
  [OBS_ALERTING_CI_FAILURE]: {
    code: OBS_ALERTING_CI_FAILURE,
    name: "otel.alerting.ci_failure",
    template: "CI failure alert: {detail}",
    severity: "error",
  },
  [OBS_LEDGER_WRITE_FAILED]: {
    code: OBS_LEDGER_WRITE_FAILED,
    name: "otel.ledger.write_failed",
    template: "ledger write failed for job {jobId}: {error}",
    severity: "error",
  },
  [OBS_ALERTING_RULE_UNKNOWN]: {
    code: OBS_ALERTING_RULE_UNKNOWN,
    name: "otel.alerting.rule.unknown",
    template: `Alert report rejected: unknown rule id "{ruleId}"`,
    severity: "error",
  },
  [OBS_CONFIG_FORBIDDEN]: {
    code: OBS_CONFIG_FORBIDDEN,
    name: "otel.config.forbidden",
    template: "OTel config is available to platform admins only",
    severity: "warning",
  },
  [OBS_AUDIT_CHAIN_APPEND_FAILED]: {
    code: OBS_AUDIT_CHAIN_APPEND_FAILED,
    name: "otel.audit_chain.append_failed",
    template:
      "Audit-chain append failed for tenant {tenantId} ({action}): {error}",
    severity: "error",
  },
  [OBS_SLO_FORBIDDEN]: {
    code: OBS_SLO_FORBIDDEN,
    name: "otel.slo.forbidden",
    template: "SLO compliance is available to platform admins only",
    severity: "warning",
  },
  [OBS_SLO_UNAVAILABLE]: {
    code: OBS_SLO_UNAVAILABLE,
    name: "otel.slo.unavailable",
    template: "{reason}",
    severity: "error",
  },
} as const;

/** True when the code is in the catalog. */
export function isKnownObsCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(OBS_CATALOG, code);
}

/** Renders a catalog template: `{field}` slots are filled from fields; an unsupplied field stays verbatim so a missing field is visible, never silently dropped. */
export function renderCatalogTemplate(template: string, fields?: ObsTemplateFields): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = fields?.[name];
    return value === undefined ? match : String(value);
  });
}

/** The result of resolving a code through the catalog: ok with the entry + rendered message, or a fail-closed rejection for an unknown code. */
export type CatalogMessageResolution =
  | { ok: true; entry: ObsCatalogEntry; message: string }
  | { ok: false; code: string; reason: string };

/**
 * Resolves a code through the catalog. An unknown code FAILS
 * CLOSED (ok:false) — it is rejected, never silently passed
 * as a valid message.
 */
export function resolveCatalogMessage(
  code: string,
  fields?: ObsTemplateFields,
): CatalogMessageResolution {
  const entry = OBS_CATALOG[code];
  if (!entry) {
    return { ok: false, code, reason: `${code} is not in the message catalog` };
  }
  return { ok: true, entry, message: `[${entry.code}] ${renderCatalogTemplate(entry.template, fields)}` };
}

/**
 * Formats a coded message from the catalog: `[OBS-####] <rendered
 * template>`. An unknown code renders fail-closed as
 * `[OBS-UNKNOWN] <code> is not in the message catalog` — named
 * explicitly, never a silent pass.
 */
export function formatCatalogMessage(code: string, fields?: ObsTemplateFields): string {
  const resolved = resolveCatalogMessage(code, fields);
  if (resolved.ok) return resolved.message;
  return `[OBS-UNKNOWN] ${resolved.reason}`;
}

/**
 * The effective severity for a code: the runtime override (a
 * `catalog.<code>.severity` override record, when one is set)
 * wins over the catalog default. An invalid override value is
 * ignored (the catalog default governs — the override was
 * rejected at write time, so this is a belt-and-braces check).
 */
export function resolveCatalogSeverity(
  code: string,
  severityOverrides?: Readonly<Record<string, string>>,
): ObsSeverity {
  const entry = OBS_CATALOG[code];
  const override = severityOverrides?.[`catalog.${code}.severity`];
  if (
    override === "info" ||
    override === "warning" ||
    override === "error" ||
    override === "critical"
  ) {
    return override;
  }
  return entry?.severity ?? "error";
}

/** One alert rule: the rule id a consumer passes, the catalog code it resolves to, and the severity (from the code's catalog entry). */
export interface ObsAlertRule {
  ruleId: string;
  code: string;
  severity: ObsSeverity;
}

/**
 * The real alert rules (S7 replaces the S4 placeholders). The
 * three first consumers (owner decision, S4) resolve through
 * these; a rule's severity is the catalog severity of its code.
 */
export const OBS_ALERT_RULES: Readonly<Record<string, ObsAlertRule>> = {
  "rule:stuck-run": {
    ruleId: "rule:stuck-run",
    code: OBS_ALERTING_STUCK_RUN,
    severity: OBS_CATALOG[OBS_ALERTING_STUCK_RUN].severity,
  },
  "rule:cap-breach": {
    ruleId: "rule:cap-breach",
    code: OBS_ALERTING_CAP_BREACH,
    severity: OBS_CATALOG[OBS_ALERTING_CAP_BREACH].severity,
  },
  "rule:ci-failure": {
    ruleId: "rule:ci-failure",
    code: OBS_ALERTING_CI_FAILURE,
    severity: OBS_CATALOG[OBS_ALERTING_CI_FAILURE].severity,
  },
} as const;

/** The result of resolving a rule id: ok with the rule, or a fail-closed rejection for an unknown rule. */
export type AlertRuleResolution =
  | { ok: true; rule: ObsAlertRule }
  | { ok: false; ruleId: string; reason: string };

/**
 * Resolves an alert rule id through the catalog. An unknown
 * rule id FAILS CLOSED (ok:false) — it is rejected, never
 * silently passed as a valid rule. Placeholder rule ids
 * ("placeholder-*") are NOT resolved here: they are the S4
 * placeholder path, still valid for consumers not yet
 * catalogued (the port reports them as placeholderRules:true).
 */
export function resolveAlertRule(ruleId: string): AlertRuleResolution {
  const rule = OBS_ALERT_RULES[ruleId];
  if (!rule) {
    return { ok: false, ruleId, reason: `${ruleId} is not in the alert-rule catalog` };
  }
  return { ok: true, rule };
}
