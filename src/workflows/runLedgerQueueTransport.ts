/**
 * Issue #4116 — the queue carrier's message: a CloudEvents envelope
 * (the messaging-port standard) on the working `screener-events`
 * queue, type `run-ledger.project`.
 *
 * The envelope carries claim-check references ONLY (ledger, natural
 * key, tenant, owning login) — never the row payload. The consumer
 * re-reads the current DO row via stub and applies the shared
 * projector with the row's own updated_at, so a stale message can
 * never overwrite a newer row (the conditional upsert refuses it).
 *
 * NOT the raw StageMessage route: the stage-message builder throws
 * on undeclared stage ids, and a projection message would pollute
 * the stage vocabulary with a non-stage id (the #3285 problem).
 * NOT job-pipeline-events: its consumer is not wired (no queue()
 * branch — Gap 1 in the carrier grounding).
 */
import {
  assertMessageEnvelope,
  type MessageEnvelope,
} from "../messaging/messagingPorts";
import type { StageQueueSend } from "./stageQueueTransport";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/runLedgerQueueTransport",
});

export type RunLedgerProjectLedger = "reports" | "async_jobs";

export interface RunLedgerProjectMessage {
  ledger: RunLedgerProjectLedger;
  /** The DO row's natural key (report id / async job id). */
  naturalKey: string;
  tenantId: string;
  /** The owning login — never "default" (the queue routes to the owning DO). */
  userLogin: string;
}

export const RUN_LEDGER_PROJECT_TYPE = "run-ledger.project";

/** Build (and validate) the CloudEvents envelope for one projection. */
export function runLedgerProjectEvent(input: RunLedgerProjectMessage & { at: string }): MessageEnvelope {
  const suffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return assertMessageEnvelope({
    specversion: "1.0",
    id: `run-ledger-project:${input.ledger}:${input.naturalKey}:${input.at}:${suffix}`,
    source: "run-ledger",
    type: RUN_LEDGER_PROJECT_TYPE,
    time: input.at,
    subject: input.naturalKey,
    jobid: input.naturalKey,
    data: {
      ledger: input.ledger,
      naturalKey: input.naturalKey,
      tenantId: input.tenantId,
      userLogin: input.userLogin,
    },
  });
}

/** True only for a well-shaped run-ledger.project envelope. */
export function isRunLedgerProjectEnvelope(value: unknown): value is MessageEnvelope {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<MessageEnvelope> & { data?: Record<string, unknown> };
  if (m.type !== RUN_LEDGER_PROJECT_TYPE) return false;
  const data = m.data;
  if (!data || typeof data !== "object") return false;
  return (
    (data["ledger"] === "reports" || data["ledger"] === "async_jobs") &&
    typeof data["naturalKey"] === "string" &&
    (data["naturalKey"] as string).trim() !== "" &&
    typeof data["tenantId"] === "string" &&
    (data["tenantId"] as string).trim() !== "" &&
    typeof data["userLogin"] === "string" &&
    (data["userLogin"] as string).trim() !== "" &&
    (data["userLogin"] as string) !== "default"
  );
}

/** Extract the projection request from an envelope, or null when it is not one. */
export function extractRunLedgerProject(
  envelope: MessageEnvelope,
): RunLedgerProjectMessage | null {
  if (!isRunLedgerProjectEnvelope(envelope)) return null;
  const data = envelope.data as Record<string, unknown>;
  return {
    ledger: data["ledger"] as RunLedgerProjectLedger,
    naturalKey: data["naturalKey"] as string,
    tenantId: data["tenantId"] as string,
    userLogin: data["userLogin"] as string,
  };
}

export type PublishRunLedgerProjectResult =
  | { published: true; message: MessageEnvelope }
  | { published: false; reason: string };

/**
 * Publish one projection message. Never throws: absence of a queue
 * binding, a bad ledger/key/login, or a send failure is reported,
 * because the caller has already persisted the DO row — a publish
 * failure must not turn a persisted row into a failed request. The
 * sweep carrier is the backstop for a lost send (the queue carrier
 * alone cannot satisfy "never fails the write AND is reconciled").
 */
export async function publishRunLedgerProject(args: {
  queue?: StageQueueSend | null;
  message: RunLedgerProjectMessage;
  at: string;
}): Promise<PublishRunLedgerProjectResult> {
  const ledger = args.message?.ledger;
  const naturalKey = args.message?.naturalKey?.trim();
  const tenantId = args.message?.tenantId?.trim();
  const userLogin = args.message?.userLogin?.trim();
  if (ledger !== "reports" && ledger !== "async_jobs") {
    return { published: false, reason: "unknown run-ledger projection ledger; refusing to publish." };
  }
  if (!naturalKey) {
    return { published: false, reason: "no natural key; refusing to publish without a row identity." };
  }
  if (!tenantId) {
    return { published: false, reason: "no tenant; refusing to publish without a tenant scope." };
  }
  if (!userLogin || userLogin === "default") {
    return { published: false, reason: "no real userLogin; refusing to publish under a default identity." };
  }
  if (!args.queue || typeof args.queue.send !== "function") {
    return { published: false, reason: "no SCREENER_EVENTS queue binding; publish skipped (ORM + sweep carriers only)." };
  }
  let message: MessageEnvelope;
  try {
    message = runLedgerProjectEvent({ ...args.message, at: args.at });
  } catch (err) {
    return { published: false, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    await args.queue.send(message);
  } catch (err) {
    structuredLog.error("runLedgerQueueTransport.publish_failed", {
      message: `[runLedgerQueueTransport] run-ledger.project publish failed for ${ledger}/${naturalKey} (DO row persisted, projection unqueued): ${err instanceof Error ? err.message : String(err)}`,
      ledger,
      naturalKey,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { published: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { published: true, message };
}
