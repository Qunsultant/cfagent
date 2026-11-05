/**
 * Issue #945, Slice 5 — IAAA accountability: audit events and
 * audit-failure policy (pure evidence model, no wiring).
 *
 * This module is deliberately NOT live audit enforcement. It does
 * not touch src/agents/routes/audit.ts, the mas_events table, any
 * audit route, API, job, tool, storage backend, or consequential
 * action flow, and it changes no production audit data. A later
 * slice wires these pure rules into live call sites; until then
 * they are a testable policy/evidence model, and nothing here
 * should be read as a claim that live actions are currently
 * governed by it, or that this module replaces the existing
 * audit route.
 *
 * What is covered (spec §4 audit event, §6 acceptance cases):
 * - IaaaAuditEvent with the spec §6 fields: event id, timestamp,
 *   event type, actor principal + principal type, initiating
 *   principal, tenant/workspace scope, task/agent/delegation/
 *   correlation ids, action, resource, decision, policy version,
 *   approval id, outcome status/error. Never raw credentials or
 *   tokens: authentication assurance / session references only.
 * - Validation rejecting events missing required attribution
 *   fields (actor, initiating principal, tenant, action, decision,
 *   outcome). A rejected event writes nothing to the store.
 * - An append-only AuditStore interface plus an in-memory
 *   implementation. No update or delete operation is exposed.
 * - Audit-failure policy: consequential actions BLOCK when audit
 *   cannot be recorded; non-consequential actions may proceed
 *   with a warning. An action whose audit write failed must not
 *   be reported as a successful audited action, even when
 *   authorization passed — authorization is not audit evidence.
 * - Integrity: a hash chain. Each event carries the previous
 *   event's hash (null for the genesis event) and its own hash,
 *   computed with SHA-256 (WebCrypto, as in apiKeys.ts /
 *   webhookReplay.ts; no new dependency). verifyChain() recomputes
 *   every hash and checks every link, so tampering with an
 *   earlier event is detectable.
 * - Audit-access logging: reading or exporting audit events
 *   itself produces an audit event (audit:read / audit:export),
 *   via createAuditAccessEvent / recordAuditAccess. This is a
 *   helper that constructs such an event; it is not a live
 *   access-control layer, and it does not enforce who may read
 *   or export audit data (that is Slice 3 PDP territory, applied
 *   by the caller at a live call site).
 *
 * What is NOT covered, explicitly:
 * - Retention: how long audit events are kept, and where they
 *   are stored long-term, remain open decisions in spec §8
 *   (CISO + CDO, due before Slice 5 wiring). The hash chain is
 *   the proposed tamper-detection mechanism, not a settled
 *   retention policy, and this module makes no retention claim.
 * - Tamper response: detection is provided; alerting, quarantine,
 *   or recovery after detection is a later wiring decision.
 * - The audit-failure blocking set: the consequential /
 *   non-consequential split is the caller's sensitivity label
 *   here; which live actions count as consequential is a CISO
 *   decision, not something this module classifies from an
 *   action string. Never infer sensitivity from the action name.
 * - Identity: identity here is the Slice 1 stable internal user
 *   id for principals and an agent principal id for agents.
 *   Email and display login are NOT inputs to any function in
 *   this module, so an email change cannot create or transfer
 *   audit attribution.
 * - Time is always a caller-supplied `timestamp` seam, never
 *   Date.now() inside a decision, so every rule is testable at
 *   its exact boundary. Identifiers are trimmed and compared
 *   exactly, as in Slices 1–4: no case folding, no URL
 *   canonicalization.
 */

import type { AuditStore } from "../data/auditLogPorts";

export type ActorType = "human" | "service" | "agent";
export type AuditDecision = "allow" | "deny";
export type AuditOutcome = "succeeded" | "failed" | "pending" | "unknown";

/** Spec §4 IaaaAuditEvent, plus the Slice 5 hash-chain fields. */
export interface IaaaAuditEvent {
  id: string;
  timestamp: number;
  type: string;
  actorPrincipalId: string;
  actorType: ActorType;
  initiatingPrincipalId: string;
  tenantId: string;
  workspaceId?: string;
  taskId?: string;
  agentInstanceId?: string;
  agentRunId?: string;
  delegationId?: string;
  correlationId: string;
  action: string;
  resourceId?: string;
  decision: AuditDecision;
  policyVersion: string;
  approvalId?: string;
  outcome: AuditOutcome;
  errorCode?: string;
  /** Hash of the previous event in the chain; null for the genesis event. */
  previousEventHash: string | null;
  /** SHA-256 of the canonical serialization of this event (excluding this field). */
  eventHash: string;
}

/** Everything a caller supplies; id and chain fields are generated on append. */
export type CreateIaaaAuditEventInput = Omit<
  IaaaAuditEvent,
  "id" | "previousEventHash" | "eventHash"
>;

/**
 * The AuditStore contract is carried as the AuditLog family's
 * port in the data layer since #1976 step 5d (#2435):
 * src/data/auditLogPorts.ts defines it (semantics unchanged —
 * append-only, #1760 transactional append), and this module
 * re-exports it (below, from the import at the top of this
 * file) so every existing import keeps working. The pure
 * model, validation and failure policy in this module do NOT
 * move.
 */
export type { AuditStore };

export function createMemoryAuditStore(): AuditStore {
  const events: IaaaAuditEvent[] = [];
  return {
    async append(event: IaaaAuditEvent): Promise<void> {
      events.push({ ...event });
    },
    async list(): Promise<IaaaAuditEvent[]> {
      return events.map((event) => ({ ...event }));
    },
  };
}

// ---------------------------------------------------------------------------
// Hash chain (SHA-256 over a canonical, key-ordered serialization)
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

/** Canonical serialization: defined fields only, in fixed key order. */
export function canonicalizeEvent(
  event: Omit<IaaaAuditEvent, "eventHash">,
): string {
  const entries: Array<[string, string | number | null]> = [
    ["id", event.id],
    ["timestamp", event.timestamp],
    ["type", event.type],
    ["actorPrincipalId", event.actorPrincipalId],
    ["actorType", event.actorType],
    ["initiatingPrincipalId", event.initiatingPrincipalId],
    ["tenantId", event.tenantId],
    ["correlationId", event.correlationId],
    ["action", event.action],
    ["decision", event.decision],
    ["policyVersion", event.policyVersion],
    ["outcome", event.outcome],
    ["previousEventHash", event.previousEventHash],
  ];
  const optional: Array<[string, string | undefined]> = [
    ["workspaceId", event.workspaceId],
    ["taskId", event.taskId],
    ["agentInstanceId", event.agentInstanceId],
    ["agentRunId", event.agentRunId],
    ["delegationId", event.delegationId],
    ["resourceId", event.resourceId],
    ["approvalId", event.approvalId],
    ["errorCode", event.errorCode],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) entries.push([key, value]);
  }
  return JSON.stringify(entries);
}

export async function computeEventHash(
  event: Omit<IaaaAuditEvent, "eventHash">,
): Promise<string> {
  return sha256Hex(canonicalizeEvent(event));
}

/**
 * Verify a chain in order: every event's hash must recompute, and
 * every event's previousEventHash must equal the previous event's
 * hash (null for the first event). Any tampering, reordering, or
 * relinking fails verification. An empty chain verifies.
 */
export async function verifyChain(events: IaaaAuditEvent[]): Promise<boolean> {
  let previousHash: string | null = null;
  for (const event of events) {
    if (event.previousEventHash !== previousHash) return false;
    const { eventHash, ...rest } = event;
    if ((await computeEventHash(rest)) !== eventHash) return false;
    previousHash = eventHash;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type AuditErrorCode =
  | "MISSING_ACTOR"
  | "INVALID_ACTOR_TYPE"
  | "MISSING_INITIATING_PRINCIPAL"
  | "MISSING_TENANT"
  | "MISSING_ACTION"
  | "MISSING_TYPE"
  | "MISSING_CORRELATION_ID"
  | "MISSING_POLICY_VERSION"
  | "INVALID_DECISION"
  | "INVALID_OUTCOME"
  | "INVALID_TIMESTAMP"
  | "FIELD_TOO_LONG"
  | "AUDIT_STORE_FULL"
  | "AUDIT_WRITE_FAILED";

export type AuditResult =
  | { ok: true; event: IaaaAuditEvent }
  | { ok: false; code: AuditErrorCode; error: string };

const MAX_FIELD_LENGTH = 512;
const ACTOR_TYPES: readonly string[] = ["human", "service", "agent"];
const DECISIONS: readonly string[] = ["allow", "deny"];
const OUTCOMES: readonly string[] = ["succeeded", "failed", "pending", "unknown"];

function isValidField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_FIELD_LENGTH
  );
}

function validateInput(
  input: CreateIaaaAuditEventInput,
): { ok: true } | { ok: false; code: AuditErrorCode; error: string } {
  // Length is checked before the guard: isValidField() narrows to
  // "not a string" on failure, so a too-long string cannot be
  // distinguished from a missing one inside the guard branch.
  if (
    typeof input.actorPrincipalId === "string" &&
    input.actorPrincipalId.trim().length > MAX_FIELD_LENGTH
  ) {
    return { ok: false, code: "FIELD_TOO_LONG", error: "actorPrincipalId exceeds 512 characters" };
  }
  if (!isValidField(input.actorPrincipalId)) {
    return { ok: false, code: "MISSING_ACTOR", error: "actorPrincipalId must be a non-empty string" };
  }
  if (!ACTOR_TYPES.includes(String(input.actorType))) {
    return { ok: false, code: "INVALID_ACTOR_TYPE", error: "actorType must be human, service, or agent" };
  }
  if (!isValidField(input.initiatingPrincipalId)) {
    return { ok: false, code: "MISSING_INITIATING_PRINCIPAL", error: "initiatingPrincipalId must be a non-empty string" };
  }
  if (!isValidField(input.tenantId)) {
    return { ok: false, code: "MISSING_TENANT", error: "tenantId must be a non-empty string" };
  }
  if (!isValidField(input.action)) {
    return { ok: false, code: "MISSING_ACTION", error: "action must be a non-empty string" };
  }
  if (!isValidField(input.type)) {
    return { ok: false, code: "MISSING_TYPE", error: "type must be a non-empty string" };
  }
  if (!isValidField(input.correlationId)) {
    return { ok: false, code: "MISSING_CORRELATION_ID", error: "correlationId must be a non-empty string" };
  }
  if (!isValidField(input.policyVersion)) {
    return { ok: false, code: "MISSING_POLICY_VERSION", error: "policyVersion must be a non-empty string" };
  }
  if (!DECISIONS.includes(String(input.decision))) {
    return { ok: false, code: "INVALID_DECISION", error: "decision must be allow or deny" };
  }
  if (!OUTCOMES.includes(String(input.outcome))) {
    return { ok: false, code: "INVALID_OUTCOME", error: "outcome must be succeeded, failed, pending, or unknown" };
  }
  if (typeof input.timestamp !== "number" || !Number.isFinite(input.timestamp)) {
    return { ok: false, code: "INVALID_TIMESTAMP", error: "timestamp must be a finite number" };
  }
  for (const optional of [
    input.workspaceId,
    input.taskId,
    input.agentInstanceId,
    input.agentRunId,
    input.delegationId,
    input.resourceId,
    input.approvalId,
    input.errorCode,
  ]) {
    if (optional !== undefined && optional.trim().length > MAX_FIELD_LENGTH) {
      return { ok: false, code: "FIELD_TOO_LONG", error: "an optional field exceeds 512 characters" };
    }
  }
  return { ok: true };
}

function normalize(value: string): string {
  return value.trim();
}

function normalizeOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalize(value);
}

/**
 * Validate, chain, and append one audit event. Validation failures
 * and audit-write failures write nothing and return ok:false; the
 * caller must treat an ok:false result as "not audited" (see
 * isAuditedSuccess), never as a successful audited action.
 */
export async function recordAuditEvent(
  store: AuditStore,
  input: CreateIaaaAuditEventInput,
): Promise<AuditResult> {
  const validation = validateInput(input);
  if (!validation.ok) return validation;
  // #1760 — atomic path: the backend chains and stores in one
  // operation. No list-then-link step runs here, so no second
  // appender can observe the same tail. A throwing backend reads
  // as AUDIT_WRITE_FAILED, exactly like the legacy path below.
  if (typeof store.appendAtomic === "function") {
    try {
      return await store.appendAtomic(input);
    } catch {
      return {
        ok: false,
        code: "AUDIT_WRITE_FAILED",
        error: "audit event could not be recorded; the action must not be reported as audited",
      };
    }
  }
  const existing = await store.list();
  const previousEventHash =
    existing.length > 0 ? existing[existing.length - 1].eventHash : null;
  const unsigned: Omit<IaaaAuditEvent, "eventHash"> = {
    id: crypto.randomUUID(),
    timestamp: input.timestamp,
    type: normalize(input.type),
    actorPrincipalId: normalize(input.actorPrincipalId),
    actorType: input.actorType,
    initiatingPrincipalId: normalize(input.initiatingPrincipalId),
    tenantId: normalize(input.tenantId),
    workspaceId: normalizeOptional(input.workspaceId),
    taskId: normalizeOptional(input.taskId),
    agentInstanceId: normalizeOptional(input.agentInstanceId),
    agentRunId: normalizeOptional(input.agentRunId),
    delegationId: normalizeOptional(input.delegationId),
    correlationId: normalize(input.correlationId),
    action: normalize(input.action),
    resourceId: normalizeOptional(input.resourceId),
    decision: input.decision,
    policyVersion: normalize(input.policyVersion),
    approvalId: normalizeOptional(input.approvalId),
    outcome: input.outcome,
    errorCode: normalizeOptional(input.errorCode),
    previousEventHash,
  };
  const event: IaaaAuditEvent = {
    ...unsigned,
    eventHash: await computeEventHash(unsigned),
  };
  try {
    await store.append(event);
  } catch {
    return {
      ok: false,
      code: "AUDIT_WRITE_FAILED",
      error: "audit event could not be recorded; the action must not be reported as audited",
    };
  }
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// Audit-failure policy
// ---------------------------------------------------------------------------

/**
 * Caller-supplied sensitivity label. This module does NOT infer
 * sensitivity from an action string: which live actions count as
 * consequential is a CISO decision (spec §8), supplied by the
 * caller at a live call site.
 */
export type ActionSensitivity = "consequential" | "non-consequential";

export type AuditFailureAction = "block" | "allow-with-warning" | "allow";

export interface AuditFailureClassification {
  action: AuditFailureAction;
  reason: string;
  /** True only when the action must not proceed. */
  blocked: boolean;
}

/**
 * Decide what happens when an audit write fails. Consequential
 * actions BLOCK: they must not proceed unaudited. Non-consequential
 * actions may proceed with a warning (the warning itself should be
 * surfaced by the caller; this pure function records the decision,
 * it does not log anywhere). With no audit failure, the action
 * proceeds normally.
 */
export function classifyAuditFailure(
  sensitivity: ActionSensitivity,
  auditWriteFailed: boolean,
): AuditFailureClassification {
  if (!auditWriteFailed) {
    return { action: "allow", reason: "AUDIT_OK", blocked: false };
  }
  if (sensitivity === "consequential") {
    return {
      action: "block",
      reason: "AUDIT_REQUIRED_FOR_CONSEQUENTIAL_ACTION",
      blocked: true,
    };
  }
  return {
    action: "allow-with-warning",
    reason: "AUDIT_FAILED_NON_CONSEQUENTIAL_ALLOW_WITH_WARNING",
    blocked: false,
  };
}

/** Convenience: true only when a failed audit write must stop the action. */
export function shouldBlockAction(
  sensitivity: ActionSensitivity,
  auditWriteFailed: boolean,
): boolean {
  return classifyAuditFailure(sensitivity, auditWriteFailed).blocked;
}

/**
 * The "not success merely because authorization passed" rule.
 * An action counts as an audited success only when all three hold:
 * authorization allowed it, it actually succeeded, and its audit
 * record was written. Any one missing means: not audited-success.
 */
export function isAuditedSuccess(input: {
  decision: AuditDecision;
  outcome: AuditOutcome;
  auditRecorded: boolean;
}): boolean {
  return (
    input.decision === "allow" &&
    input.outcome === "succeeded" &&
    input.auditRecorded === true
  );
}

// ---------------------------------------------------------------------------
// Audit-access logging (reading/exporting audit events is itself audited)
// ---------------------------------------------------------------------------

export type AuditAccess = "audit:read" | "audit:export";

export interface AuditAccessInput {
  readerPrincipalId: string;
  actorType: ActorType;
  initiatingPrincipalId: string;
  tenantId: string;
  access: AuditAccess;
  correlationId: string;
  timestamp: number;
  workspaceId?: string;
  policyVersion?: string;
}

/**
 * Construct the audit event for an audit read/export. The reader is
 * the actor; the initiating principal is normally the reader too,
 * but is kept separate so a delegated read can attribute both.
 * This constructs the event input only — chaining and storage
 * happen in recordAuditEvent, and live read/export enforcement
 * (who may read) is the caller's PDP decision, not this helper.
 */
export function createAuditAccessEvent(
  input: AuditAccessInput,
): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: input.access,
    actorPrincipalId: input.readerPrincipalId,
    actorType: input.actorType,
    initiatingPrincipalId: input.initiatingPrincipalId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    action: input.access,
    decision: "allow",
    policyVersion: input.policyVersion ?? "iaaa-audit-1",
    outcome: "succeeded",
  };
}

/** Record an audit read/export as an audit event in the same store. */
export async function recordAuditAccess(
  store: AuditStore,
  input: AuditAccessInput,
): Promise<AuditResult> {
  return recordAuditEvent(store, createAuditAccessEvent(input));
}

export const IAAA_AUDIT_POLICY_VERSION = "iaaa-audit-1";
