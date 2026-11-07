/**
 * Issue #3471 — the Stock Copilot push leg, delivery half: after a
 * broker/mode selection write commits, the Worker notifies the
 * affected user's OrchestratorAgent through the agent's BUILT-IN
 * webhook channel (#3474: PortThink intercepts the reserved
 * `/webhooks/<source>` path at fetch, HMAC-verifies, and dispatches
 * to the instance's onWebhook hook). This module is the sender:
 *
 * - Delivery is IN-WORKER: a signed POST to the login's own
 *   instance through its Durable Object stub fetch — the same
 *   dispatch every production request terminates at. No public
 *   round trip, no new endpoint.
 * - The payload carries the FACT of change only (kind, login,
 *   changedAt) — never the new broker/mode values. The receiving
 *   hook re-resolves the selection from the authoritative stores
 *   (orchestrator/settingsWebhook.ts), so a delivered event can
 *   only ever cause a re-read, never inject a selection.
 * - Fail-open to the floor, by design: the settings write is
 *   authoritative and already committed before any of this runs.
 *   An unconfigured THINK_WEBHOOK_SECRET SKIPS the delivery with
 *   a loud structured log (never an unsigned send — the port
 *   would 503 it anyway), and any delivery failure is reported
 *   in the result, never thrown. Behind this leg stands #3473's
 *   observe floor (the cycle re-resolves at every firing), which
 *   bounds the staleness when a notification is missed.
 *
 * Signing uses the port's own seam (thinkPortMapping), so the
 * scheme has exactly one definition for both sides.
 */

import {
  THINK_WEBHOOK_SIGNATURE_HEADER,
  resolveThinkWebhookSecret,
  signThinkWebhookSignature,
} from "../actors/thinkPortMapping";
import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/settingsWebhookNotify",
});

/** The reserved webhook source segment for selection-change events. */
export const SETTINGS_WEBHOOK_SOURCE = "settings";

/** Which selection write committed. */
export type SettingsChangeKind = "broker_selection_changed" | "mode_changed";

/**
 * The fact of a selection change — all a notification may carry.
 * Values are deliberately absent: the hook re-resolves them.
 */
export interface SettingsChange {
  kind: SettingsChangeKind;
  /** The affected user's login (their orchestrator instance name). */
  login: string;
  /** ISO timestamp of the committed write. */
  changedAt: string;
}

/**
 * The fire-and-forget notification callback the selection write
 * routes receive from their host. Implementations never throw and
 * never block the write's response on the delivery.
 */
export type SettingsChangeNotifier = (change: SettingsChange) => void;

/** The instance stub shape the delivery needs (structural, so
 *  tests inject a fake namespace without a real DO binding). */
export interface SettingsWebhookInstanceStub {
  fetch(request: Request): Promise<Response>;
}

export interface SettingsWebhookNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): SettingsWebhookInstanceStub;
}

export type SettingsWebhookDelivery =
  | { delivered: true }
  | { delivered: false; reason: string };

/** Resolve the orchestrator namespace from env, structurally. */
function orchestratorNamespace(env: Partial<Env>): SettingsWebhookNamespace | null {
  const ns = (env as { ORCHESTRATOR_AGENT?: unknown }).ORCHESTRATOR_AGENT;
  if (
    !ns ||
    typeof (ns as SettingsWebhookNamespace).idFromName !== "function" ||
    typeof (ns as SettingsWebhookNamespace).get !== "function"
  ) {
    return null;
  }
  return ns as SettingsWebhookNamespace;
}

/**
 * Deliver one settings-change webhook to the login's instance.
 * NEVER throws: every failure mode is a `{ delivered: false }`
 * result with a named reason plus a loud structured log — the
 * caller's write has already committed and must not fail because
 * a notification could not be sent.
 */
export async function deliverSettingsChangeWebhook(
  env: Partial<Env>,
  change: SettingsChange,
): Promise<SettingsWebhookDelivery> {
  const fail = (reason: string): SettingsWebhookDelivery => {
    structuredLog.warn("settingsWebhookNotify.settings_change_delivery_skipped", {
      message:
        `[SettingsWebhook] delivery skipped for login "${change.login}" ` +
        `(kind "${change.kind}"): ${reason} — the write stands; ` +
        "the observe floor bounds the copilot's staleness",
      login: change.login,
      kind: change.kind,
      reason,
    });
    return { delivered: false, reason };
  };
  const secret = resolveThinkWebhookSecret(env);
  if (!secret) {
    return fail(
      "THINK_WEBHOOK_SECRET is not configured, so the webhook channel " +
        "is closed (the port answers 503) — set the deployment secret to enable the push leg",
    );
  }
  const namespace = orchestratorNamespace(env);
  if (!namespace) {
    return fail("the ORCHESTRATOR_AGENT namespace is not bound in this deployment");
  }
  try {
    const rawBody = JSON.stringify({
      kind: change.kind,
      login: change.login,
      changedAt: change.changedAt,
    });
    const signature = await signThinkWebhookSignature(rawBody, secret);
    const stub = namespace.get(namespace.idFromName(change.login));
    // The routeAgentRequest production URL shape; the stub routes
    // on the instance id, and PortThink matches the reserved tail.
    const request = new Request(
      `https://agent.openaimp.com/agents/orchestrator-agent/${encodeURIComponent(change.login)}/webhooks/${SETTINGS_WEBHOOK_SOURCE}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [THINK_WEBHOOK_SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
      },
    );
    const response = await stub.fetch(request);
    if (!response.ok) {
      return fail(`the instance answered ${response.status}`);
    }
    return { delivered: true };
  } catch (err) {
    return fail(
      `delivery error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build the host's notifier: fire-and-forget delivery, deferred
 * through the host's waitUntil when one is provided (the DO entry
 * point's, so a self-delivery to the same instance is dispatched
 * after the write's own request completes rather than contending
 * with it). Never throws, never rejects into the host.
 */
export function createSettingsChangeNotifier(
  env: Partial<Env>,
  waitUntil?: (promise: Promise<unknown>) => void,
): SettingsChangeNotifier {
  return (change) => {
    const delivery = deliverSettingsChangeWebhook(env, change).catch(() => {
      // deliverSettingsChangeWebhook never throws by contract; this
      // guard keeps a future regression from reaching a write path.
      return { delivered: false, reason: "unexpected delivery failure" };
    });
    if (waitUntil) {
      try {
        waitUntil(delivery);
        return;
      } catch {
        // A host whose waitUntil rejects the promise falls through
        // to the floating delivery — still best-effort, still logged.
      }
    }
    void delivery;
  };
}
