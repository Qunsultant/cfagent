/**
 * Saga journey gate — issue #2041 S2 (Q1 ruled 2026-10-31, #2041
 * comment 6543052265: all decision surfaces, first answer wins).
 *
 * What this module is:
 * - The gate copy (G-DISCLOSURE, gate prompt copy): the prompt
 *   states plainly that answering authorizes ENTERING the trading
 *   leg, not approving a trade, and repeats the rail's
 *   compensation policy. The copy is deliberately unmistakable
 *   from per-order trade approval copy ("Approve & Submit",
 *   "execute order" never appear here).
 * - The decision event shape + validation (G-GATE-DELIVERY,
 *   G-APPROVER): a journey decision is { decision, deciderLogin,
 *   surface }. The flow validates it (owner-only, working
 *   default — G-APPROVER is still open, pinned + flagged); the
 *   delivery helper below enforces first-wins at the route layer.
 * - The delivery helper: resolves the saga workflow instance,
 *   refuses when it is already complete (superseded, with the
 *   deciding surface from the outcome), otherwise sends the
 *   decision event. All three decision surfaces (Slack door,
 *   goal panel, chat widget) deliver through this one helper —
 *   no surface invents its own event path, and no new event bus
 *   is introduced (delivery is instance.sendEvent, the same
 *   channel the payment workflow's approval delivery uses).
 * - The pending-gate query: pending gates are derived from the
 *   saga audit rows (journey_prompted minus journey_decided),
 *   read through the SEARCH_AGENT stub's audit read path — the
 *   same stub-mediated path S1's audit forwarder uses, so it
 *   shares S1's live-proof caveat (unit-pinned; live proof is
 *   owner-side). No new store is introduced for gate state.
 *
 * What this module is NOT:
 * - Email is NOT a decision surface (ruling): it can only notify
 *   with a link. No email-reply decision path is built here.
 * - First-wins has a known race window, stated not hidden: two
 *   answers sent concurrently can both observe a running
 *   instance and both sendEvent; the flow consumes exactly one
 *   (the first) and the second sits queued, never recorded as a
 *   decision. The single journey_decided audit row is the record
 *   of which answer won. Closing that window fully would need a
 *   transactional decision store; the route-level owner check +
 *   the complete-instance check close every case except the
 *   concurrent-send window.
 * - Prompt delivery is best-effort per surface, unlike audit
 *   (which throws). A Slack outage must not fail a saga whose
 *   panel and chat prompts still work: deliverPrompts records
 *   per-surface results and the flow continues. The prompted
 *   audit row is the durable prompt record for the state-driven
 *   surfaces (panel, chat).
 *
 * Instance-id convention (S4 entry-route contract): the saga
 * workflow instance id is derived from the saga id by
 * sagaWorkflowInstanceId() — readable when short, hashed when
 * long (same shape as the leg ids, same 100-character ceiling).
 * The S4 entry route MUST start saga instances under this id,
 * or delivery cannot resolve them.
 */

import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import { sagaCompensationDisclosure } from "./sagaCompensation";

/** Decision surfaces (ruling Q1). Email is notification only. */
export type JourneySurface = "slack" | "panel" | "chat";

/** One journey decision, carried as a workflow event payload. */
export interface SagaJourneyDecision {
  /** The saga this decision is for — the flow refuses events without it or for another saga. */
  sagaId: string;
  decision: "approved" | "denied";
  deciderLogin: string;
  surface: JourneySurface;
}

/** Gate copy: title + body + the rail's compensation line. */
export interface JourneyGateCopy {
  title: string;
  body: string;
  compensationLine: string;
}

/**
 * Gate copy (G-DISCLOSURE, gate copy). The body states the
 * journey authorization in words that cannot be mistaken for a
 * trade approval, and the compensation line is per-rail from the
 * single source sagaCompensationDisclosure (S3 corrected the
 * stripe line to the request-first reality: a refund is
 * REQUESTED, operator approval still required before money
 * moves, credit as fallback — the S2 line overstated it as a
 * refund already received). Unknown rail falls back to the
 * credit framing — never to a refund promise.
 */
export function journeyGateCopy(rail?: "stripe" | "x402"): JourneyGateCopy {
  const compensationLine = sagaCompensationDisclosure(rail);
  return {
    title: "Enter the trading leg?",
    body:
      "This authorizes ENTERING the trading leg for this paid screen. " +
      "It is NOT approval of any trade: each trade will still ask for its own " +
      "per-order approval before anything is placed. " +
      "Denying, or letting this expire, ends the saga with no trades and no proposals.",
    compensationLine,
  };
}

/** The full gate prompt: ids + copy, carried to the surfaces. */
export interface JourneyGatePrompt {
  sagaId: string;
  runRequestId: string;
  family: string;
  rail?: "stripe" | "x402";
  copy: JourneyGateCopy;
}

/** Build the prompt for one saga (copy from journeyGateCopy). */
export function buildJourneyGatePrompt(
  sagaId: string,
  runRequestId: string,
  family: string,
  rail?: "stripe" | "x402",
): JourneyGatePrompt {
  return { sagaId, runRequestId, family, ...(rail ? { rail } : {}), copy: journeyGateCopy(rail) };
}

/** Slack action ids for the journey buttons (distinct from trade ids). */
export const SAGA_JOURNEY_APPROVE_ACTION = "saga_journey_approve";
export const SAGA_JOURNEY_DENY_ACTION = "saga_journey_deny";

/**
 * Slack prompt payload for the journey gate. Buttons carry the
 * saga id as their value (Slack values cap at 2000 chars; saga
 * ids fit). The text repeats the gate copy so the Slack prompt
 * cannot drift from the panel/chat copy.
 */
export function buildSlackJourneyPrompt(prompt: JourneyGatePrompt): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  const text =
    `${prompt.copy.title} — run ${prompt.runRequestId} (${prompt.family}). ` +
    `${prompt.copy.body} ${prompt.copy.compensationLine}`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Enter trading leg" },
            action_id: SAGA_JOURNEY_APPROVE_ACTION,
            value: prompt.sagaId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Do not enter" },
            action_id: SAGA_JOURNEY_DENY_ACTION,
            value: prompt.sagaId,
          },
        ],
      },
    ],
  };
}

/** Two-seed FNV-1a 64-bit → 32 hex chars (same shape as the leg ids). */
function hashSagaId(input: string): string {
  const hash = (seed: bigint): string => {
    let h = seed;
    const prime = 1099511628211n;
    const mask = (1n << 64n) - 1n;
    for (const ch of input) {
      h ^= BigInt(ch.codePointAt(0) as number);
      h = (h * prime) & mask;
    }
    return h.toString(16).padStart(16, "0");
  };
  return hash(14695981039346656037n) + hash(14695981039346656037n ^ 0x9e3779b97f4a7c15n);
}

/**
 * Derive the saga workflow instance id from the saga id (S4
 * entry-route contract). Sanitizes to [A-Za-z0-9_-]; hashes down
 * when the readable form would exceed the 100-character ceiling
 * (the #2129 lesson). Deterministic: the same saga id always
 * maps to the same instance id.
 */
export function sagaWorkflowInstanceId(sagaId: string): string {
  const sanitized = sagaId.replace(/[^A-Za-z0-9_-]/g, "-");
  const short = `saga-${sanitized}`;
  if (short.length <= 100) return short;
  return `saga-h-${hashSagaId(sagaId)}`;
}

/** Validation of a raw journey-decision event payload. */
export function parseJourneyDecision(
  payload: unknown,
): { ok: true; decision: SagaJourneyDecision } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "malformed_decision_payload" };
  }
  const p = payload as Record<string, unknown>;
  if (typeof p["sagaId"] !== "string" || !p["sagaId"]) {
    return { ok: false, reason: "malformed_saga_id" };
  }
  if (p["decision"] !== "approved" && p["decision"] !== "denied") {
    return { ok: false, reason: "malformed_decision_value" };
  }
  if (typeof p["deciderLogin"] !== "string" || !p["deciderLogin"]) {
    return { ok: false, reason: "malformed_decider" };
  }
  if (p["surface"] !== "slack" && p["surface"] !== "panel" && p["surface"] !== "chat") {
    return { ok: false, reason: "malformed_surface" };
  }
  return {
    ok: true,
    decision: {
      sagaId: p["sagaId"] as string,
      decision: p["decision"] as "approved" | "denied",
      deciderLogin: p["deciderLogin"] as string,
      surface: p["surface"] as JourneySurface,
    },
  };
}

/** Minimal structural surface of a workflow binding instance. */
export interface SagaJourneyInstance {
  sendEvent?: (event: { type: string; payload: unknown }) => Promise<void>;
  status?: () => Promise<{ status: string; output?: unknown; error?: unknown }>;
}

/** Minimal structural surface of the saga workflow binding. */
export interface SagaJourneyBinding {
  get(id: string): Promise<SagaJourneyInstance | null>;
}

/** Delivery result: accepted, or refused as superseded. */
export type JourneyDeliveryResult =
  | { accepted: true }
  | { accepted: false; reason: "superseded"; decidedBy: string };

/**
 * Deliver one journey decision to a running saga (the single
 * delivery path for Slack, panel, and chat). Complete instance →
 * superseded (the outcome's deciding surface names the winner);
 * running instance → sendEvent with the exact decision payload.
 * Missing binding or missing sendEvent throws (fail loud — a
 * misconfigured delivery path must never silently drop a
 * decision). The owner check lives in the caller (route/handler);
 * the flow re-validates as defense in depth.
 */
export async function deliverJourneyDecision(
  binding: SagaJourneyBinding | undefined,
  input: { sagaId: string; decision: SagaJourneyDecision },
): Promise<JourneyDeliveryResult> {
  if (!binding || typeof binding.get !== "function") {
    throw new Error("Saga journey delivery unavailable: SAGA_WORKFLOW binding is not configured.");
  }
  const instanceId = sagaWorkflowInstanceId(input.sagaId);
  const instance = await binding.get(instanceId);
  if (!instance || typeof instance.sendEvent !== "function") {
    throw new Error(
      `Saga journey delivery unavailable: saga instance ${instanceId} cannot receive events.`,
    );
  }
  if (typeof instance.status === "function") {
    const s = await instance.status();
    if (s.status === "complete") {
      const output = (s.output ?? {}) as Record<string, unknown>;
      const decidedBy =
        typeof output["decidingSurface"] === "string" ? (output["decidingSurface"] as string) : "unknown";
      return { accepted: false, reason: "superseded", decidedBy };
    }
  }
  await instance.sendEvent({
    type: "saga-journey-decision",
    payload: {
      // sagaId is REQUIRED by parseJourneyDecision: the flow
      // refuses any event without it (malformed_saga_id) and
      // refuses events for other sagas (saga_id_mismatch).
      sagaId: input.sagaId,
      decision: input.decision.decision,
      deciderLogin: input.decision.deciderLogin,
      surface: input.decision.surface,
    },
  });
  return { accepted: true };
}

/** One pending gate, as the panel/chat surfaces render it. */
export interface PendingJourneyGate {
  sagaId: string;
  runRequestId: string;
  family: string;
  rail?: "stripe" | "x402";
  promptedAt: string;
  copy: JourneyGateCopy;
}

/** Minimal structural surface of the audit-owner stub (fetch only). */
export interface AuditOwnerStub {
  fetch: (req: Request) => Promise<Response>;
}

interface AuditProjectedEvent {
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  created_at: string;
}

async function readAuditEvents(
  stub: AuditOwnerStub,
  type: string,
): Promise<AuditProjectedEvent[]> {
  const url = new URL("/api/audit", "https://agent.internal");
  url.searchParams.set("type", type);
  url.searchParams.set("agent", "saga");
  url.searchParams.set("limit", "1000");
  const res = await stub.fetch(new Request(url, { method: "GET" }));
  if (!res.ok) {
    throw new Error(`Journey-gate audit read failed: HTTP ${res.status} for ${type}.`);
  }
  const body = (await res.json().catch(() => null)) as { events?: unknown } | null;
  const events = Array.isArray(body?.events) ? body.events : [];
  return events.filter(
    (e): e is AuditProjectedEvent =>
      !!e &&
      typeof e === "object" &&
      typeof (e as { type?: unknown }).type === "string" &&
      (e as { payload?: unknown }).payload !== null &&
      typeof (e as { payload?: unknown }).payload === "object",
  ) as AuditProjectedEvent[];
}

/**
 * List pending journey gates from the saga audit rows: prompted
 * rows minus decided rows (by saga id). When userLogin is given,
 * only that user's gates are returned (the route/handler passes
 * the session login; never list another user's gates). The stub
 * is the SEARCH_AGENT shared instance (same path S1's forwarder
 * writes through), so the session filter on the read path passes
 * for these rows.
 */
export async function listPendingJourneyGates(
  stub: AuditOwnerStub,
  userLogin?: string,
): Promise<PendingJourneyGate[]> {
  const prompted = await readAuditEvents(stub, "saga.journey_prompted");
  const decided = await readAuditEvents(stub, "saga.journey_decided");
  const decidedIds = new Set(
    decided
      .map((e) => e.payload["sagaId"])
      .filter((v): v is string => typeof v === "string"),
  );
  const gates: PendingJourneyGate[] = [];
  for (const e of prompted) {
    const sagaId = e.payload["sagaId"];
    const runRequestId = e.payload["runRequestId"];
    if (typeof sagaId !== "string" || !sagaId) continue;
    if (typeof runRequestId !== "string" || !runRequestId) continue;
    if (decidedIds.has(sagaId)) continue;
    if (userLogin !== undefined && e.payload["userLogin"] !== userLogin) continue;
    const rail = e.payload["rail"];
    gates.push({
      sagaId,
      runRequestId,
      family: typeof e.payload["family"] === "string" ? (e.payload["family"] as string) : "goal",
      ...(rail === "stripe" || rail === "x402" ? { rail } : {}),
      promptedAt: e.created_at,
      copy: journeyGateCopy(rail === "stripe" || rail === "x402" ? rail : undefined),
    });
  }
  return gates;
}

/**
 * Find a decided gate for one saga (for the superseded
 * distinction: a decided gate answers 409 with its deciding
 * surface; a never-prompted or foreign gate answers 404).
 */
export async function findDecidedJourneyGate(
  stub: AuditOwnerStub,
  sagaId: string,
): Promise<{ decidingSurface: string } | null> {
  const decided = await readAuditEvents(stub, "saga.journey_decided");
  for (const e of decided) {
    if (e.payload["sagaId"] !== sagaId) continue;
    const surface = e.payload["decidingSurface"];
    return { decidingSurface: typeof surface === "string" ? surface : "unknown" };
  }
  return null;
}

/** Resolve the SEARCH_AGENT shared-instance stub from env. */
export function sagaAuditOwnerStub(env: unknown): AuditOwnerStub {
  // Structural read, mirroring S1's audit forwarder in
  // sagaWorkflow.ts: Env's SEARCH_AGENT namespace types its get
  // by DurableObjectId, so the helper reads it structurally
  // instead of demanding Env's exact namespace type.
  const ns = (env as Record<string, unknown> | null)?.SEARCH_AGENT as
    | { idFromName: (name: string) => unknown; get: (id: unknown) => AuditOwnerStub }
    | undefined;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw new Error("Journey-gate audit read unavailable: SEARCH_AGENT is not bound.");
  }
  return ns.get(ns.idFromName(SHARED_ORCHESTRATOR_INSTANCE));
}

/** Per-surface prompt receipts, carried from deliver to withdraw. */
export interface JourneyPromptReceipts {
  slackChannel?: string;
  slackTs?: string;
  slackSkipped?: string;
}

/** Per-surface withdraw results, audited on both decide and expire. */
export interface JourneyWithdrawResult {
  slack: "edited" | "skipped" | "failed";
  slackDetail?: string;
  panel: "state-driven";
  chat: "state-driven";
}

/**
 * Post the Slack journey prompt via chat.postMessage (bot token),
 * capturing channel + ts for later edit-cleanup. Webhook-only
 * installs and missing tokens skip Slack (recorded, not thrown):
 * prompt delivery is best-effort per surface.
 */
export async function postSlackJourneyPrompt(
  env: { SLACK_BOT_TOKEN?: string },
  prompt: JourneyGatePrompt,
): Promise<JourneyPromptReceipts> {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return { slackSkipped: "no Slack bot token configured" };
  const payload = buildSlackJourneyPrompt(prompt);
  // Channel resolution follows the established postSlackMessage
  // order (payload channel, then SLACK_CHANNEL, then
  // SCREENER_SLACK_CHANNEL). No channel resolves → skip, recorded:
  // prompt delivery never guesses a destination.
  const envRec = env as Record<string, unknown>;
  const channel =
    typeof envRec["SLACK_CHANNEL"] === "string"
      ? (envRec["SLACK_CHANNEL"] as string)
      : typeof envRec["SCREENER_SLACK_CHANNEL"] === "string"
        ? (envRec["SCREENER_SLACK_CHANNEL"] as string)
        : undefined;
  if (!channel) {
    return { slackSkipped: "no Slack channel configured (SLACK_CHANNEL/SCREENER_SLACK_CHANNEL)" };
  }
  try {
    const res = await fetch(new URL("https://slack.com/api/chat.postMessage"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, ...payload }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; ts?: unknown; channel?: unknown } | null;
    if (!res.ok || !data?.ok || typeof data.ts !== "string") {
      return { slackSkipped: `Slack post failed (HTTP ${res.status})` };
    }
    return {
      slackChannel: typeof data.channel === "string" ? data.channel : channel,
      slackTs: data.ts,
    };
  } catch (err) {
    return { slackSkipped: `Slack post threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Edit-cleanup for the Slack prompt (chat.update with the
 * captured channel + ts). Webhook-only/skipped receipts skip
 * (recorded); failures are recorded, never thrown — withdraw
 * must not fail a saga whose decision is already recorded.
 */
export async function editSlackJourneyPrompt(
  env: { SLACK_BOT_TOKEN?: string },
  receipts: JourneyPromptReceipts,
  text: string,
): Promise<JourneyWithdrawResult> {
  const base: JourneyWithdrawResult = { slack: "skipped", panel: "state-driven", chat: "state-driven" };
  const token = env.SLACK_BOT_TOKEN;
  if (!receipts.slackChannel || !receipts.slackTs) {
    return {
      ...base,
      slackDetail: receipts.slackSkipped ?? "no Slack prompt receipt to edit",
    };
  }
  if (!token) return { ...base, slackDetail: "no Slack bot token configured" };
  try {
    const res = await fetch(new URL("https://slack.com/api/chat.update"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: receipts.slackChannel, ts: receipts.slackTs, text, blocks: [] }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: unknown } | null;
    if (!res.ok || !data?.ok) {
      return { ...base, slack: "failed", slackDetail: `Slack edit failed (HTTP ${res.status})` };
    }
    return { ...base, slack: "edited" };
  } catch (err) {
    return {
      ...base,
      slack: "failed",
      slackDetail: `Slack edit threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
