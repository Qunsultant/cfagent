/**
 * Issue #5081 (S1, observability program #5080) — the coded
 * OTel messages (OBS-####).
 *
 * This is the SEED of the S7 message catalog (#5086): the first
 * OBS codes, defined in one place so every OTel module names the
 * same code for the same failure. S7 will adopt and expand this
 * file into the one message catalog (stable codes + severity per
 * message); no OTel module invents a code inline.
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
 *  OBS-1017/1018/1019 are the S4 alert-subject codes (the
 *  code each consumer's alert is logged under). Their
 *  severity/rule mapping lands with the S7 catalog (#5086);
 *  S4 carries only the code identifiers, not a severity/rule
 *  schema.
 *
 * Codes added in S6 (#5085, recording — one runs ledger):
 *  OBS-1020 otel.ledger.write_failed — a runs-ledger write
 *    failed and was named (audited + logged) instead of
 *    vanishing silently. The #4921 KV marker sink is the
 *    follow-up mechanism for naming a failure the SQL path
 *    cannot report; OBS-1020 names it on the audit/log path.
 *  Severity/rule mapping lands with the S7 catalog (#5086);
 *  S6 carries only the code identifier, not a severity/rule
 *  schema.
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
/** The sweep stuck-run alert (a job has been RUNNING past the stuck threshold). S4 subject code; severity/rule mapping lands with S7. */
export const OBS_ALERTING_STUCK_RUN = "OBS-1017" as const;
/** The SessionStore resource cap alert (a free-tier budget is at/over 70%). S4 subject code; severity/rule mapping lands with S7. */
export const OBS_ALERTING_CAP_BREACH = "OBS-1018" as const;
/** The CI failure alert (a GitHub Actions workflow failed on main). S4 subject code; severity/rule mapping lands with S7. */
export const OBS_ALERTING_CI_FAILURE = "OBS-1019" as const;
/** A runs-ledger write failed and was named (audited + logged) instead of vanishing silently. S6 code; severity/rule mapping lands with S7. */
export const OBS_LEDGER_WRITE_FAILED = "OBS-1020" as const;

/** Formats a coded message: `[OBS-####] <message>`. */
export function formatOtelMessage(code: string, message: string): string {
  return `[${code}] ${message}`;
}
