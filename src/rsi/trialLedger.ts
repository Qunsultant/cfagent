/**
 * #1774 (parent #1717, F-43) — RSI trial ledger port.
 *
 * Replaces partially-manual RSI experiment tracking with an
 * automated, append-only, hash-chained ledger. A trial is proposed,
 * started, measured (telemetry events), evaluated, decided by a
 * human owner, and only then adopted. Status is DERIVED from the
 * event log — there is no update or delete operation anywhere in
 * this module, so a recorded trial, metric, evaluation, or
 * decision cannot be rewritten in place.
 *
 * Store question (stated in Qunsultant/cfagent#1774 BEFORE this
 * code was built): the scan names a trial-ledger Durable Object,
 * but a new DO class would need a wrangler migration tag for a
 * ledger that existing DO SQLite stores can already host. This
 * port therefore runs over ANY store implementing
 * TrialLedgerStore — the in-memory store below for tests and
 * embedding, and a SQL store (TrialLedgerSqlExecutor, the DO
 * SqlStorage exec shape) for production. A dedicated DO class
 * remains a carried follow-up if the owner directs one; it is
 * not silently substituted here, and no new store class is
 * created by this slice.
 *
 * Security / governance guard: adoption requires a prior
 * "approved" decision event. A rejected trial can never adopt,
 * and a trial with no decision can never adopt. The approver
 * is recorded as given; who counts as an owner is a governance
 * decision (see docs/architecture/security/rsi-governance-1774.md),
 * not something this port infers from a caller string.
 *
 * Telemetry shape: one event per metric observation
 * ({ metric, value, unit }). Telemetry never changes status;
 * only lifecycle events do (proposed -> running -> completed
 * -> approved|rejected -> adopted).
 */

export type TrialStatus =
  | "proposed"
  | "running"
  | "completed"
  | "approved"
  | "rejected"
  | "adopted";

export type TrialEventKind =
  | "proposed"
  | "started"
  | "telemetry"
  | "evaluation"
  | "decision"
  | "adopted";

export interface TrialMetric {
  metric: string;
  value: number;
  unit: string;
}

export interface TrialEvaluation {
  verdict: "pass" | "fail";
  evidence: string;
}

export interface TrialDecision {
  decision: "approved" | "rejected";
  approver: string;
}

export interface TrialEvent {
  id: string;
  trialId: string;
  kind: TrialEventKind;
  /** Event payload; telemetry/evaluation/decision shapes per kind. */
  payload: unknown;
  previousEventHash: string | null;
  eventHash: string;
  createdAt: string;
}

export interface TrialView {
  id: string;
  hypothesis: string;
  owner: string;
  status: TrialStatus;
  metrics: TrialMetric[];
  evaluation: TrialEvaluation | null;
  decision: TrialDecision | null;
  createdAt: string;
}

/** Append-only store contract. Deliberately no update/delete. */
export interface TrialLedgerStore {
  appendEvent(event: TrialEvent): Promise<void>;
  listEvents(trialId: string): Promise<TrialEvent[]>;
  /** Trial headers (hypothesis/owner) recorded at proposal time. */
  recordHeader(header: {
    id: string;
    hypothesis: string;
    owner: string;
    createdAt: string;
  }): Promise<void>;
  getHeader(
    trialId: string,
  ): Promise<{ id: string; hypothesis: string; owner: string; createdAt: string } | null>;
}

/** Minimal SQL executor matching the DO SqlStorage exec shape. */
export interface TrialLedgerSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export function createMemoryTrialLedgerStore(): TrialLedgerStore {
  const headers = new Map<
    string,
    { id: string; hypothesis: string; owner: string; createdAt: string }
  >();
  const events = new Map<string, TrialEvent[]>();
  return {
    async appendEvent(event: TrialEvent): Promise<void> {
      const list = events.get(event.trialId) ?? [];
      list.push({ ...event });
      events.set(event.trialId, list);
    },
    async listEvents(trialId: string): Promise<TrialEvent[]> {
      return (events.get(trialId) ?? []).map((e) => ({ ...e }));
    },
    async recordHeader(header: {
      id: string;
      hypothesis: string;
      owner: string;
      createdAt: string;
    }): Promise<void> {
      headers.set(header.id, { ...header });
    },
    async getHeader(trialId: string) {
      const header = headers.get(trialId);
      return header ? { ...header } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Hash chain (SHA-256 over a canonical serialization, as in iaaaAudit.ts)
// ---------------------------------------------------------------------------

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalizeTrialEvent(
  event: Omit<TrialEvent, "eventHash">,
): string {
  return JSON.stringify([
    ["id", event.id],
    ["trialId", event.trialId],
    ["kind", event.kind],
    ["payload", event.payload],
    ["previousEventHash", event.previousEventHash],
    ["createdAt", event.createdAt],
  ]);
}

export async function computeTrialEventHash(
  event: Omit<TrialEvent, "eventHash">,
): Promise<string> {
  return sha256Hex(canonicalizeTrialEvent(event));
}

export async function verifyTrialChain(
  events: TrialEvent[],
): Promise<boolean> {
  let previousHash: string | null = null;
  for (const event of events) {
    if (event.previousEventHash !== previousHash) return false;
    const { eventHash, ...rest } = event;
    if ((await computeTrialEventHash(rest)) !== eventHash) return false;
    previousHash = eventHash;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Append helpers + lifecycle
// ---------------------------------------------------------------------------

function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`RSI trial ${field} must not be blank`);
  return trimmed;
}

async function appendChained(
  store: TrialLedgerStore,
  trialId: string,
  kind: TrialEventKind,
  payload: unknown,
): Promise<TrialEvent> {
  const prior = await store.listEvents(trialId);
  const previousEventHash =
    prior.length > 0 ? prior[prior.length - 1].eventHash : null;
  const base: Omit<TrialEvent, "eventHash"> = {
    id: `trial_evt_${crypto.randomUUID().slice(0, 8)}`,
    trialId,
    kind,
    payload,
    previousEventHash,
    createdAt: new Date().toISOString(),
  };
  const event: TrialEvent = {
    ...base,
    eventHash: await computeTrialEventHash(base),
  };
  await store.appendEvent(event);
  return event;
}

function deriveStatus(events: TrialEvent[]): TrialStatus {
  let status: TrialStatus = "proposed";
  for (const event of events) {
    if (event.kind === "started") status = "running";
    else if (event.kind === "evaluation") status = "completed";
    else if (event.kind === "decision") {
      const decision = (event.payload as TrialDecision | null)?.decision;
      status = decision === "approved" ? "approved" : "rejected";
    } else if (event.kind === "adopted") status = "adopted";
  }
  return status;
}

export async function proposeTrial(
  store: TrialLedgerStore,
  input: { hypothesis: string; owner: string },
): Promise<TrialView> {
  const hypothesis = requireNonBlank(input.hypothesis, "hypothesis");
  const owner = requireNonBlank(input.owner, "owner");
  const id = `trial_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  await store.recordHeader({ id, hypothesis, owner, createdAt });
  await appendChained(store, id, "proposed", { hypothesis, owner });
  return (await getTrial(store, id)) as TrialView;
}

export async function getTrial(
  store: TrialLedgerStore,
  trialId: string,
): Promise<TrialView | null> {
  const header = await store.getHeader(trialId);
  if (!header) return null;
  const events = await store.listEvents(trialId);
  const metrics: TrialMetric[] = [];
  let evaluation: TrialEvaluation | null = null;
  let decision: TrialDecision | null = null;
  for (const event of events) {
    if (event.kind === "telemetry") metrics.push(event.payload as TrialMetric);
    else if (event.kind === "evaluation")
      evaluation = event.payload as TrialEvaluation;
    else if (event.kind === "decision") decision = event.payload as TrialDecision;
  }
  return {
    ...header,
    status: deriveStatus(events),
    metrics,
    evaluation,
    decision,
  };
}

export async function listTrialEvents(
  store: TrialLedgerStore,
  trialId: string,
): Promise<TrialEvent[]> {
  return store.listEvents(trialId);
}

async function requireTrial(
  store: TrialLedgerStore,
  trialId: string,
): Promise<TrialView> {
  const trial = await getTrial(store, trialId);
  if (!trial) throw new Error(`RSI trial not found: ${trialId}`);
  return trial;
}

export async function startTrial(
  store: TrialLedgerStore,
  trialId: string,
): Promise<TrialView> {
  const trial = await requireTrial(store, trialId);
  if (trial.status !== "proposed")
    throw new Error(`RSI trial ${trialId} cannot start from ${trial.status}`);
  await appendChained(store, trialId, "started", {});
  return (await getTrial(store, trialId)) as TrialView;
}

export async function recordTrialTelemetry(
  store: TrialLedgerStore,
  trialId: string,
  metric: TrialMetric,
): Promise<TrialEvent> {
  const trial = await requireTrial(store, trialId);
  if (trial.status !== "running")
    throw new Error(
      `RSI trial ${trialId} is ${trial.status}; telemetry requires running`,
    );
  if (!metric.metric.trim() || !Number.isFinite(metric.value))
    throw new Error("RSI trial telemetry needs a metric name and finite value");
  return appendChained(store, trialId, "telemetry", { ...metric });
}

export async function recordTrialEvaluation(
  store: TrialLedgerStore,
  trialId: string,
  evaluation: TrialEvaluation,
): Promise<TrialView> {
  const trial = await requireTrial(store, trialId);
  if (trial.status !== "running")
    throw new Error(
      `RSI trial ${trialId} is ${trial.status}; evaluation requires running`,
    );
  if (evaluation.verdict !== "pass" && evaluation.verdict !== "fail")
    throw new Error("RSI trial evaluation verdict must be pass or fail");
  await appendChained(store, trialId, "evaluation", { ...evaluation });
  return (await getTrial(store, trialId)) as TrialView;
}

export async function recordTrialDecision(
  store: TrialLedgerStore,
  trialId: string,
  decision: TrialDecision,
): Promise<TrialView> {
  const trial = await requireTrial(store, trialId);
  if (trial.status !== "completed")
    throw new Error(
      `RSI trial ${trialId} is ${trial.status}; decision requires completed`,
    );
  if (decision.decision !== "approved" && decision.decision !== "rejected")
    throw new Error("RSI trial decision must be approved or rejected");
  requireNonBlank(decision.approver, "approver");
  await appendChained(store, trialId, "decision", { ...decision });
  return (await getTrial(store, trialId)) as TrialView;
}

export async function adoptTrial(
  store: TrialLedgerStore,
  trialId: string,
): Promise<TrialView> {
  const trial = await requireTrial(store, trialId);
  if (trial.status !== "approved")
    throw new Error(
      `RSI trial ${trialId} is ${trial.status}; adoption requires an approved decision`,
    );
  await appendChained(store, trialId, "adopted", {});
  return (await getTrial(store, trialId)) as TrialView;
}
