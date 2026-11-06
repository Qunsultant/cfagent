/**
 * Phase 5 Slice 1 (issue #2000) — dead-letter persistence.
 *
 * Additive, never a replacement: the caller always emits the
 * console dead-letter record first (sink.record / logDeadLetter);
 * this helper then persists the same record and runs the depth
 * check. It NEVER throws — a store or alert failure is warned
 * and the drop/ack path proceeds exactly as before. A null
 * store is a plain no-op: today's console-only behavior.
 *
 * The closure built by server.ts from env never throws by
 * construction (this helper catches everything), so drop-path
 * call sites await it directly with no ack depending on it.
 */
import type { DeadLetterRecord } from "./deadLetter";
import type { DeadLetterStore } from "./deadLetterStorePorts";
import { maybeAlertDlqDepth } from "./dlqDepthAlert";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "messaging/deadLetterPersist",
});

export interface DeadLetterPersistDeps {
  store: DeadLetterStore | null;
  /** 0 disables the depth alert. */
  threshold: number;
  sendAlert: (text: string) => Promise<void>;
  nowMs?: number;
}

/**
 * Persist one terminal drop and run the depth check.
 * envelope is the full envelope object when the drop carried
 * one, else null (undecodable / legacy drops carry none).
 * Typed unknown because MessageEnvelope (an interface) is not
 * assignable to Record<string, unknown>; only plain objects
 * are stored, anything else degrades to a null envelope.
 */
export async function persistDeadLetterLanding(
  deps: DeadLetterPersistDeps,
  record: DeadLetterRecord,
  envelope: unknown,
): Promise<void> {
  if (!deps.store) return;
  try {
    const envelopeObj =
      envelope && typeof envelope === "object" ? (envelope as Record<string, unknown>) : null;
    await deps.store.insert({
      queue: record.queue,
      reason: record.reason,
      messageId: record.messageId,
      runId: record.runId,
      unitId: record.unitId,
      actorLogin: record.actorLogin,
      actorKind: record.actorKind ?? null,
      subscriber: record.subscriber,
      detail: record.detail,
      envelope: envelopeObj,
      createdAtMs: record.atMs,
    });
    await maybeAlertDlqDepth({
      store: deps.store,
      threshold: deps.threshold,
      sendAlert: deps.sendAlert,
      nowMs: deps.nowMs,
    });
  } catch (err) {
    // The console record already stands; persistence is
    // best-effort and must never break the drop path.
    structuredLog.warn("dead_letter.store_persist_failed", {
      message: "[dead-letter] store persist failed (console record stands)",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
