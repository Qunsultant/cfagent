/**
 * Issue #3156 (Q7, #945): verification-failure alert path.
 *
 * A failed chain verification emits a loud, AUDITED alert: an
 * `audit.tamper_detected` row recorded through the BLOCKING seam
 * (recordBlockingAudit), never console-only, never silent. If the
 * alert write itself fails, the failure propagates to the caller —
 * the caller must not report success for a verification it could
 * not even record.
 *
 * Appending the alert onto a broken tail does NOT repair or hide
 * the break: the alert row links to the current tail hash, and the
 * original break still fails every later verification. That is by
 * design — the alert repeats on every nightly retention run until
 * the range is reviewed (see the tamper-response runbook), and the
 * affected range stays untrusted thereafter. A future slice may add
 * acknowledgement suppression; this slice deliberately does not
 * invent suppression semantics.
 *
 * Two chains, one alert shape:
 * - mas_events (the live chain): verified + alerted synchronously
 *   by verifyStoredAuditChainAndAlert, wired into the nightly
 *   retention trigger BEFORE any pruning.
 * - d1-chain (the #2183 policy-store chain): verified + alerted
 *   asynchronously by verifyAndAlertD1Chain; no production writer
 *   feeds it today, so it is exercised by tests and available to
 *   the gate's future chain writes.
 */
import {
  diagnoseStoredAuditChain,
  type DatabaseORM,
} from "../data/ormFacade";
import {
  verifyAuditChain as verifyPolicyChain,
  type AuditPolicyPort,
} from "../data/auditPolicyPorts";
import type { AuditEvent } from "../types";
import {
  recordBlockingAudit,
  type BlockingAuditEvents,
} from "../security/auditChain";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/auditTamperAlert",
});

/** What broke, carried in the alert payload for the runbook's affected-range step. */
export interface TamperFinding {
  chain: "mas_events" | "d1-chain";
  tenantId?: string;
  brokenIndex: number | null;
  reason: string;
}

/** Outcome of a verify-and-alert pass. */
export interface TamperAlertResult {
  valid: boolean;
  brokenIndex: number | null;
  reason: string | null;
  alertRecorded: boolean;
  alertId?: string;
}

function buildAlertRecord(finding: TamperFinding): AuditEvent {
  return {
    id: `tamper_${crypto.randomUUID().slice(0, 8)}`,
    sessionId: "system",
    type: "audit.tamper_detected",
    agent: "orchestrator",
    payload: {
      chain: finding.chain,
      ...(finding.tenantId ? { tenantId: finding.tenantId } : {}),
      brokenIndex: finding.brokenIndex,
      reason: finding.reason,
      detectedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Record a tamper alert through the blocking seam. Deliberately no
 * try/catch: a failed alert write must propagate, never be
 * swallowed — a verification failure the system could not even
 * record is louder as a thrown error than as silence.
 */
export function recordTamperAlert(
  events: BlockingAuditEvents,
  finding: TamperFinding,
): AuditEvent {
  const record = buildAlertRecord(finding);
  structuredLog.error("audit.tamper_detected", {
    message:
      `[audit-tamper] chain verification FAILED chain=${finding.chain}` +
      (finding.tenantId ? ` tenant=${finding.tenantId}` : "") +
      ` brokenIndex=${finding.brokenIndex} reason=${finding.reason}`,
    chain: finding.chain,
    ...(finding.tenantId ? { tenantId: finding.tenantId } : {}),
    brokenIndex: finding.brokenIndex,
    reason: finding.reason,
  });
  return recordBlockingAudit(events, record);
}

/**
 * Verify the stored mas_events chain and, on failure, record the
 * alert against the same store. A verification READ failure is
 * treated as a break (fail-closed: an unverifiable chain is not an
 * intact chain); if the alert write then also fails, that failure
 * propagates — the caller must surface it, never swallow it.
 */
export function verifyStoredAuditChainAndAlert(orm: DatabaseORM): TamperAlertResult {
  let diagnosis: { valid: boolean; brokenIndex: number | null; reason: string | null };
  try {
    diagnosis = diagnoseStoredAuditChain(orm);
  } catch (err) {
    diagnosis = {
      valid: false,
      brokenIndex: null,
      reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (diagnosis.valid) {
    return { valid: true, brokenIndex: null, reason: null, alertRecorded: false };
  }
  const alert = recordTamperAlert(orm.events, {
    chain: "mas_events",
    brokenIndex: diagnosis.brokenIndex,
    reason: diagnosis.reason ?? "chain verification failed",
  });
  return { ...diagnosis, alertRecorded: true, alertId: alert.id };
}

/**
 * Verify one tenant's d1-chain entries and, on failure, record the
 * alert against the given audit-events store. Same fail-closed
 * treatment of verification read failures as the mas_events pass.
 */
export async function verifyAndAlertD1Chain(
  port: AuditPolicyPort,
  events: BlockingAuditEvents,
  tenantId: string,
): Promise<TamperAlertResult> {
  let verification: { valid: boolean; brokenIndex: number | null; reason: string | null };
  try {
    verification = await verifyPolicyChain(await port.listChainEntries(tenantId));
  } catch (err) {
    verification = {
      valid: false,
      brokenIndex: null,
      reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (verification.valid) {
    return { valid: true, brokenIndex: null, reason: null, alertRecorded: false };
  }
  const alert = recordTamperAlert(events, {
    chain: "d1-chain",
    tenantId,
    brokenIndex: verification.brokenIndex,
    reason: verification.reason ?? "chain verification failed",
  });
  return { ...verification, alertRecorded: true, alertId: alert.id };
}
