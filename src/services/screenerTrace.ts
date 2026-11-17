/**
 * Issue #2216 (#1969 P1): the human-readable trace carried on a
 * screener run, rendered onto every outbound message for that run.
 *
 * Why a separate module: the trace is built by the scheduled wrappers,
 * rendered by the guard alert and the followup legs, and carried on the
 * run outcome — three call sites that must agree on field names and
 * rendering. One type + one renderer keeps them identical.
 *
 * Fields are attribution identity only — never secrets, tokens, or
 * technical detail. The catalog message carries the failure; the trace
 * block carries which run it belongs to.
 */

import type { JobRunTrigger } from "../data/jobRunRecordPorts";

export interface ScreenerTrace {
  /** The arming schedule's id, when the caller knows it (see the
   *  scheduleId precedent on the scheduled-task options: the SDK
   *  callback path supplies none, so schedules stamp it at arm time). */
  scheduleId?: string;
  /** Human schedule name, when known (e.g. "hourly options NASDAQ100"). */
  scheduleName?: string;
  /** The run's own id (e.g. the wrapper's reportRunId). */
  runId: string;
  /** Wrapper name, e.g. "autonomousOptionsAnalysis". */
  workflow: string;
  /** What started the run. The five dispatch modes plus the two
   *  mechanism values: "retry" (a re-fire) and "followup" (a
   *  follow-up leg). Issue #5052: a Run-now trace carries
   *  "triggered". */
  trigger: JobRunTrigger | "retry" | "followup";
  /** Pipeline stage/step that emitted the message, e.g. "auth guard". */
  stage: string;
  /** The tracked job id, when the message comes from a job leg. */
  jobId?: string;
  /** ISO timestamp the run fired (not the message time). */
  firedAt: string;
  /** Login the run executed as. */
  runAs: string;
  /** Universe / thesis, carried for the audit record (the leg text
   *  already names them, so the block does not repeat them). */
  universe?: string;
  thesis?: string;
  /** Audit event id, when the emission was recorded (readable through
   *  the #1968 audit path). */
  auditEventId?: string;
}

/**
 * Render a trace block for appending to a Slack message. Absent
 * optional fields are omitted, never printed as "undefined".
 * Returns "" when no trace is carried, so builders append it
 * unconditionally and stay byte-identical for untraced runs.
 */
export function formatTraceBlock(trace: ScreenerTrace | undefined): string {
  if (!trace) return "";
  const lines: string[] = [];
  if (trace.scheduleId || trace.scheduleName) {
    const name = trace.scheduleName ?? "";
    const id = trace.scheduleId ? `(${trace.scheduleId})` : "";
    lines.push(`Schedule: ${[name, id].filter(Boolean).join(" ")}`);
  }
  if (trace.runId) lines.push(`Run: ${trace.runId}`);
  if (trace.workflow) lines.push(`Workflow: ${trace.workflow}`);
  if (trace.trigger) lines.push(`Trigger: ${trace.trigger}`);
  if (trace.stage) lines.push(`Stage: ${trace.stage}`);
  if (trace.firedAt) lines.push(`Fired: ${trace.firedAt}`);
  if (trace.runAs) lines.push(`Run-as: ${trace.runAs}`);
  if (trace.jobId) lines.push(`Job: ${trace.jobId}`);
  if (trace.auditEventId) lines.push(`Audit: ${trace.auditEventId}`);
  return lines.join("\n");
}
