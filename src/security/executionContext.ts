/**
 * Issue #1078 (epic #1070, Phase S1) — validated ExecutionContext
 * contract for the #1069 §8 shared execution context.
 *
 * #1069 §8 requires one validated context carried through APIs,
 * jobs, agents, and tools. Before this module those fields existed
 * only piecemeal (IAAA audit events, delegation records, the
 * screener's {userLogin, environment} pair). This module is the
 * single contract:
 *
 *   tenantId, workspaceId, principalId, initiatingPrincipalId,
 *   taskId, agentRunId, delegationId, serviceId, connectionId,
 *   externalAccountId, environment, policyVersion,
 *   entitlementReference, approvalReference, correlationId,
 *   sessionId, runId, platformId, traceId, dispatchMode, execMode
 *
 * The last six are the universal fields (Venus direction
 * 2026-11-22, #1078 Consistency rule): the context carries ALL ids
 * and BOTH modes, so the one shared resolution (#6151) produces
 * this contract verbatim with no second shape. They are optional
 * inputs validated when present, following the module's existing
 * optional-field pattern — absence resolves, malformed values deny
 * fail-closed. Dispatch mode reuses the one trigger vocabulary
 * (JOB_RUN_TRIGGERS, #5028/#3214 ruling); exec mode is the #4136
 * axis (sync/async), separate from the dispatch mode, never
 * conflated. Narrowing inherits every universal field verbatim
 * and can never set or change one.
 *
 * Rules (fail-closed throughout):
 * - resolveExecutionContext() is the only constructor. It builds a
 *   context exclusively from server-side authoritative sources:
 *   the authenticated principal's Slice 3 memberships (via the
 *   authorization PDP), and a connection-binding authority for
 *   provider connections / external accounts. Client-supplied
 *   identifiers are requests to be checked, never facts.
 * - The PDP decision is embedded (policyVersion) so a context
 *   carries the policy it was evaluated under.
 * - A context is frozen. Crossing a boundary (durable task, agent
 *   run) it travels as data (serialize/parse) and MUST be
 *   revalidated at the point of use: authority is re-checked
 *   against current state, so revocation or a tenant swapped in
 *   transit denies.
 * - Delegation narrows, never widens: narrowExecutionContext() can
 *   attach an agent run / delegation and can move live → sandbox,
 *   but can never escalate sandbox → live, change the tenant,
 *   workspace, initiator, task, or correlation, swap the
 *   connection, or replace a parent's approval/entitlement
 *   references.
 * - Consequential actions and live-environment execution require
 *   an approval reference at resolution time. Approval bypass is
 *   a resolution failure, not a downstream concern.
 *
 * Live wiring is deliberately staged, as in the #945 slices:
 * evaluateExecutionContext() exposes observe/enforce modes
 * (EXECUTION_CONTEXT_MODE, default observe). Call sites adopt
 * observe mode first so production validation outcomes are
 * visible before enforcement can deny real work; the enforcement
 * flip is a separate, separately reviewed step under #1078.
 *
 * Time is a caller-supplied `nowMs` seam, never Date.now() inside
 * a decision. Identifiers are trimmed and compared exactly, as in
 * Slices 1–5: no case folding, no canonicalization.
 */

import {
  authorize,
  AUTHORIZATION_POLICY_VERSION,
  type DecisionReason,
  type MembershipStore,
  type Permission,
} from "./authorization";
import {
  JOB_RUN_TRIGGERS,
  type JobRunTrigger,
} from "../data/jobRunRecordPorts";
import {
  recordAuditEvent,
  type ActorType,
  type AuditResult,
  type AuditStore,
} from "./iaaaAudit";

export const EXECUTION_CONTEXT_POLICY_VERSION = "execution-context-1";

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export type ExecutionEnvironment = "sandbox" | "live";

/**
 * Dispatch mode: the five modes of the #5028/#3214 ruling (Venus
 * 2026-11-17). JOB_RUN_TRIGGERS is the one source of truth; this
 * type is an alias, never a second vocabulary.
 */
export type ExecutionDispatchMode = JobRunTrigger;

/**
 * Exec mode: the #4136 axis, separate from the dispatch mode — the
 * trigger says what dispatched this execution; the exec mode says
 * whether the caller awaits it. Never conflated, never defaulted:
 * an unknown value denies at resolution (INVALID_FIELD).
 */
export type ExecutionMode = "sync" | "async";

export interface ExecutionContext {
  tenantId: string;
  workspaceId?: string;
  /** Executing principal: a Slice 1 internal user id, or a service/agent principal id. */
  principalId: string;
  principalType: ActorType;
  /** The original initiator; survives delegation unchanged. */
  initiatingPrincipalId: string;
  taskId: string;
  agentRunId?: string;
  delegationId?: string;
  serviceId: string;
  connectionId?: string;
  externalAccountId?: string;
  environment: ExecutionEnvironment;
  /** Policy version of the PDP decision this context was resolved under. */
  policyVersion: string;
  entitlementReference?: string;
  approvalReference?: string;
  correlationId: string;
  /** Session this execution belongs to (universal field). */
  sessionId?: string;
  /** Uniform job/workflow run id (universal field). */
  runId?: string;
  /** Owning platform/domain (universal field). */
  platformId?: string;
  /** Trace id, carried by the attribution envelope (universal field). */
  traceId?: string;
  /** What dispatched this execution (universal field). */
  dispatchMode?: ExecutionDispatchMode;
  /** Whether the caller awaits this execution (universal field). */
  execMode?: ExecutionMode;
}

// ---------------------------------------------------------------------------
// Authority seam
// ---------------------------------------------------------------------------

export interface ConnectionBindingInput {
  tenantId: string;
  principalId: string;
  connectionId: string;
  externalAccountId?: string;
}

/**
 * The authoritative sources a context is resolved from. The
 * membership store is Slice 3's; the connection binding is the
 * provider-connection authority (a connection/account pair counts
 * as bound only when the provider integration layer says the
 * principal owns it in this tenant).
 */
export interface ExecutionContextAuthority {
  memberships: MembershipStore;
  isConnectionBound(input: ConnectionBindingInput): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveExecutionContextInput {
  /** Authenticated principal (Slice 1 internal user id for humans). Never a login or email. */
  principalId: string;
  principalType?: ActorType;
  /** Defaults to principalId. A different initiator requires delegationId. */
  initiatingPrincipalId?: string;
  tenantId: string;
  workspaceId?: string;
  taskId: string;
  agentRunId?: string;
  delegationId?: string;
  serviceId: string;
  connectionId?: string;
  externalAccountId?: string;
  environment: ExecutionEnvironment;
  /** PDP permission the operation this context authorizes requires. */
  permission: Permission;
  /** Consequential actions require an approval reference (see header). */
  consequential?: boolean;
  entitlementReference?: string;
  approvalReference?: string;
  correlationId?: string;
  sessionId?: string;
  runId?: string;
  platformId?: string;
  traceId?: string;
  dispatchMode?: ExecutionDispatchMode;
  execMode?: ExecutionMode;
  nowMs: number;
}

export type ContextDenyCode =
  | "INVALID_FIELD"
  | "INITIATOR_MISMATCH"
  | "PDP_DENIED"
  | "CONNECTION_NOT_BOUND"
  | "APPROVAL_REQUIRED"
  | "ENVIRONMENT_ESCALATION"
  | "CONNECTION_CHANGE"
  | "REFERENCE_CHANGE";

/** The requested fields, echoed on denial so the decision can be audited. */
export interface ExecutionContextRequestEcho {
  principalId: string;
  principalType: ActorType;
  initiatingPrincipalId: string;
  tenantId: string;
  workspaceId?: string;
  taskId: string;
  agentRunId?: string;
  delegationId?: string;
  serviceId: string;
  correlationId: string;
  approvalReference?: string;
  sessionId?: string;
  runId?: string;
  platformId?: string;
  traceId?: string;
  dispatchMode?: ExecutionDispatchMode;
  execMode?: ExecutionMode;
}

export type ResolveExecutionContextResult =
  | { ok: true; context: ExecutionContext }
  | {
      ok: false;
      code: ContextDenyCode;
      error: string;
      pdpReason?: DecisionReason;
      request: ExecutionContextRequestEcho;
    };

const MAX_FIELD_LENGTH = 512;

function isValidField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_FIELD_LENGTH
  );
}

function normalize(value: string): string {
  return value.trim();
}

function echoOf(input: ResolveExecutionContextInput): ExecutionContextRequestEcho {
  const raw = (value: unknown): string =>
    typeof value === "string" ? normalize(value) : "";
  return {
    principalId: raw(input.principalId),
    principalType: input.principalType ?? "human",
    initiatingPrincipalId: raw(input.initiatingPrincipalId ?? input.principalId),
    tenantId: raw(input.tenantId),
    workspaceId:
      typeof input.workspaceId === "string"
        ? normalize(input.workspaceId)
        : undefined,
    taskId: raw(input.taskId),
    agentRunId:
      typeof input.agentRunId === "string"
        ? normalize(input.agentRunId)
        : undefined,
    delegationId:
      typeof input.delegationId === "string"
        ? normalize(input.delegationId)
        : undefined,
    serviceId: raw(input.serviceId),
    correlationId: isValidField(input.correlationId)
      ? normalize(input.correlationId)
      : crypto.randomUUID(),
    approvalReference:
      typeof input.approvalReference === "string"
        ? normalize(input.approvalReference)
        : undefined,
    sessionId:
      typeof input.sessionId === "string"
        ? normalize(input.sessionId)
        : undefined,
    runId:
      typeof input.runId === "string" ? normalize(input.runId) : undefined,
    platformId:
      typeof input.platformId === "string"
        ? normalize(input.platformId)
        : undefined,
    traceId:
      typeof input.traceId === "string"
        ? normalize(input.traceId)
        : undefined,
    dispatchMode: input.dispatchMode,
    execMode: input.execMode,
  };
}

function deny(
  input: ResolveExecutionContextInput,
  code: ContextDenyCode,
  error: string,
  pdpReason?: DecisionReason,
): ResolveExecutionContextResult {
  return { ok: false, code, error, pdpReason, request: echoOf(input) };
}

/**
 * Resolve a validated ExecutionContext from authoritative sources.
 * Any failed check denies the whole resolution; there is no
 * partial context and no fallback identity.
 */
export async function resolveExecutionContext(
  authority: ExecutionContextAuthority,
  input: ResolveExecutionContextInput,
): Promise<ResolveExecutionContextResult> {
  // 1. Shape. Every identifier the context will carry must be a
  //    well-formed field; a malformed identifier never reaches
  //    the PDP or the binding authority.
  const required: Array<[string, unknown]> = [
    ["principalId", input.principalId],
    ["tenantId", input.tenantId],
    ["taskId", input.taskId],
    ["serviceId", input.serviceId],
  ];
  for (const [name, value] of required) {
    if (!isValidField(value)) {
      return deny(input, "INVALID_FIELD", `${name} must be a non-empty string`);
    }
  }
  const optional: Array<[string, unknown]> = [
    ["workspaceId", input.workspaceId],
    ["agentRunId", input.agentRunId],
    ["delegationId", input.delegationId],
    ["connectionId", input.connectionId],
    ["externalAccountId", input.externalAccountId],
    ["entitlementReference", input.entitlementReference],
    ["approvalReference", input.approvalReference],
    ["correlationId", input.correlationId],
    ["initiatingPrincipalId", input.initiatingPrincipalId],
    ["sessionId", input.sessionId],
    ["runId", input.runId],
    ["platformId", input.platformId],
    ["traceId", input.traceId],
  ];
  for (const [name, value] of optional) {
    if (value !== undefined && !isValidField(value)) {
      return deny(input, "INVALID_FIELD", `${name} must be a non-empty string when present`);
    }
  }
  if (input.environment !== "sandbox" && input.environment !== "live") {
    return deny(input, "INVALID_FIELD", "environment must be sandbox or live");
  }
  // Modes validate by membership, never by default: an unknown
  // dispatch mode must deny, never silently read as "manual"
  // (normalizeJobRunTrigger's manual default is the dispatch-site
  // pass-through, not this contract). An unknown exec mode denies
  // the same way; there is no default exec mode.
  if (
    input.dispatchMode !== undefined &&
    !(JOB_RUN_TRIGGERS as readonly string[]).includes(input.dispatchMode)
  ) {
    return deny(
      input,
      "INVALID_FIELD",
      "dispatchMode must be one of scheduled, manual, triggered, copilot, autopilot",
    );
  }
  if (
    input.execMode !== undefined &&
    input.execMode !== "sync" &&
    input.execMode !== "async"
  ) {
    return deny(input, "INVALID_FIELD", "execMode must be sync or async");
  }
  if (input.externalAccountId !== undefined && input.connectionId === undefined) {
    return deny(
      input,
      "INVALID_FIELD",
      "externalAccountId requires the connectionId it belongs to",
    );
  }

  const principalId = normalize(input.principalId);
  const tenantId = normalize(input.tenantId);
  const initiatingPrincipalId =
    input.initiatingPrincipalId !== undefined
      ? normalize(input.initiatingPrincipalId)
      : principalId;

  // 2. Initiator integrity: a context whose initiator differs
  //    from the executing principal exists only under delegation.
  if (initiatingPrincipalId !== principalId && input.delegationId === undefined) {
    return deny(
      input,
      "INITIATOR_MISMATCH",
      "initiatingPrincipalId differs from principalId without a delegationId",
    );
  }

  // 3. Tenant/workspace authority: the Slice 3 PDP decides from
  //    the principal's memberships. Its reason propagates so a
  //    denial is diagnosable (cross-tenant is not "no grant").
  const decision = await authorize(authority.memberships, {
    actorInternalUserId: principalId,
    tenantId,
    permission: input.permission,
    scope: input.workspaceId !== undefined ? "workspace" : "tenant",
    resourceScope:
      input.workspaceId !== undefined
        ? { workspaceId: normalize(input.workspaceId) }
        : undefined,
    nowMs: input.nowMs,
  });
  if (decision.decision === "deny") {
    return deny(
      input,
      "PDP_DENIED",
      `authorization denied: ${decision.reason}`,
      decision.reason,
    );
  }

  // 4. Connection binding: a named connection (and its external
  //    account) must be bound to this principal in this tenant by
  //    the provider authority.
  if (input.connectionId !== undefined) {
    const bound = await authority.isConnectionBound({
      tenantId,
      principalId,
      connectionId: normalize(input.connectionId),
      externalAccountId:
        input.externalAccountId !== undefined
          ? normalize(input.externalAccountId)
          : undefined,
    });
    if (!bound) {
      return deny(
        input,
        "CONNECTION_NOT_BOUND",
        "connection is not bound to this principal in this tenant",
      );
    }
  }

  // 5. Approval: consequential actions, and any live-environment
  //    execution, require an approval reference at resolution.
  const approvalReference =
    input.approvalReference !== undefined
      ? normalize(input.approvalReference)
      : undefined;
  if (
    (input.consequential === true || input.environment === "live") &&
    approvalReference === undefined
  ) {
    return deny(
      input,
      "APPROVAL_REQUIRED",
      "an approval reference is required for consequential or live execution",
    );
  }

  const context: ExecutionContext = {
    tenantId,
    workspaceId:
      input.workspaceId !== undefined ? normalize(input.workspaceId) : undefined,
    principalId,
    principalType: input.principalType ?? "human",
    initiatingPrincipalId,
    taskId: normalize(input.taskId),
    agentRunId:
      input.agentRunId !== undefined ? normalize(input.agentRunId) : undefined,
    delegationId:
      input.delegationId !== undefined ? normalize(input.delegationId) : undefined,
    serviceId: normalize(input.serviceId),
    connectionId:
      input.connectionId !== undefined ? normalize(input.connectionId) : undefined,
    externalAccountId:
      input.externalAccountId !== undefined
        ? normalize(input.externalAccountId)
        : undefined,
    environment: input.environment,
    policyVersion: decision.policyVersion,
    entitlementReference:
      input.entitlementReference !== undefined
        ? normalize(input.entitlementReference)
        : undefined,
    approvalReference,
    correlationId: isValidField(input.correlationId)
      ? normalize(input.correlationId)
      : crypto.randomUUID(),
    sessionId:
      input.sessionId !== undefined ? normalize(input.sessionId) : undefined,
    runId: input.runId !== undefined ? normalize(input.runId) : undefined,
    platformId:
      input.platformId !== undefined
        ? normalize(input.platformId)
        : undefined,
    traceId:
      input.traceId !== undefined ? normalize(input.traceId) : undefined,
    dispatchMode: input.dispatchMode,
    execMode: input.execMode,
  };
  return { ok: true, context: Object.freeze(context) };
}

// ---------------------------------------------------------------------------
// Narrowing (delegation)
// ---------------------------------------------------------------------------

export interface NarrowExecutionContextInput {
  agentRunId?: string;
  delegationId?: string;
  environment?: ExecutionEnvironment;
  connectionId?: string;
  externalAccountId?: string;
  entitlementReference?: string;
  approvalReference?: string;
}

export type NarrowExecutionContextResult =
  | { ok: true; context: ExecutionContext }
  | { ok: false; code: ContextDenyCode; error: string };

/**
 * Derive a child context for an agent run / tool call. The child
 * may only ever hold less authority than the parent: identity,
 * tenant, workspace, task, and correlation are inherited verbatim;
 * the environment can narrow live → sandbox but never escalate;
 * the connection cannot change (a different connection requires
 * a fresh resolution); references a parent already carries cannot
 * be replaced, only added when the parent lacks them. The universal
 * fields (sessionId, runId, platformId, traceId, dispatchMode,
 * execMode) are inherited verbatim and can never be set or changed
 * by narrowing — they are stamped at resolution, not at delegation.
 */
export function narrowExecutionContext(
  parent: ExecutionContext,
  input: NarrowExecutionContextInput,
): NarrowExecutionContextResult {
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined && !isValidField(value)) {
      return {
        ok: false,
        code: "INVALID_FIELD",
        error: `${name} must be a non-empty string when present`,
      };
    }
  }
  if (
    input.environment !== undefined &&
    input.environment !== "sandbox" &&
    input.environment !== "live"
  ) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      error: "environment must be sandbox or live",
    };
  }
  if (
    parent.environment === "sandbox" &&
    input.environment === "live"
  ) {
    return {
      ok: false,
      code: "ENVIRONMENT_ESCALATION",
      error: "a sandbox context cannot be escalated to live by narrowing",
    };
  }
  if (
    input.connectionId !== undefined &&
    normalize(input.connectionId) !== parent.connectionId
  ) {
    return {
      ok: false,
      code: "CONNECTION_CHANGE",
      error: "the connection cannot change on an existing context; resolve a new context",
    };
  }
  if (
    input.externalAccountId !== undefined &&
    parent.externalAccountId !== undefined &&
    normalize(input.externalAccountId) !== parent.externalAccountId
  ) {
    return {
      ok: false,
      code: "CONNECTION_CHANGE",
      error: "the external account cannot change on an existing context; resolve a new context",
    };
  }
  if (
    input.approvalReference !== undefined &&
    parent.approvalReference !== undefined &&
    normalize(input.approvalReference) !== parent.approvalReference
  ) {
    return {
      ok: false,
      code: "REFERENCE_CHANGE",
      error: "a parent's approval reference cannot be replaced by narrowing",
    };
  }
  if (
    input.entitlementReference !== undefined &&
    parent.entitlementReference !== undefined &&
    normalize(input.entitlementReference) !== parent.entitlementReference
  ) {
    return {
      ok: false,
      code: "REFERENCE_CHANGE",
      error: "a parent's entitlement reference cannot be replaced by narrowing",
    };
  }
  if (
    input.delegationId !== undefined &&
    parent.delegationId !== undefined &&
    normalize(input.delegationId) !== parent.delegationId
  ) {
    return {
      ok: false,
      code: "REFERENCE_CHANGE",
      error: "a context already carrying a delegation cannot be re-delegated by narrowing",
    };
  }

  const child: ExecutionContext = {
    ...parent,
    agentRunId:
      input.agentRunId !== undefined ? normalize(input.agentRunId) : parent.agentRunId,
    delegationId:
      input.delegationId !== undefined
        ? normalize(input.delegationId)
        : parent.delegationId,
    environment: input.environment ?? parent.environment,
    connectionId:
      input.connectionId !== undefined
        ? normalize(input.connectionId)
        : parent.connectionId,
    externalAccountId:
      input.externalAccountId !== undefined
        ? normalize(input.externalAccountId)
        : parent.externalAccountId,
    entitlementReference:
      input.entitlementReference !== undefined
        ? normalize(input.entitlementReference)
        : parent.entitlementReference,
    approvalReference:
      input.approvalReference !== undefined
        ? normalize(input.approvalReference)
        : parent.approvalReference,
  };
  return { ok: true, context: Object.freeze(child) };
}

// ---------------------------------------------------------------------------
// Boundary crossing: serialize, parse, revalidate
// ---------------------------------------------------------------------------

export function serializeExecutionContext(context: ExecutionContext): string {
  return JSON.stringify(context);
}

const CONTEXT_FIELDS: ReadonlySet<string> = new Set([
  "tenantId",
  "workspaceId",
  "principalId",
  "principalType",
  "initiatingPrincipalId",
  "taskId",
  "agentRunId",
  "delegationId",
  "serviceId",
  "connectionId",
  "externalAccountId",
  "environment",
  "policyVersion",
  "entitlementReference",
  "approvalReference",
  "correlationId",
  "sessionId",
  "runId",
  "platformId",
  "traceId",
  "dispatchMode",
  "execMode",
]);

/**
 * Parse a context that crossed a boundary as data. Shape only:
 * parsing proves the payload is a well-formed context, NOT that
 * it is still authorized — revalidateExecutionContext() does
 * that at the point of use.
 */
export function parseExecutionContext(raw: string): ExecutionContext | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CONTEXT_FIELDS.has(key)) return null;
  }
  const requiredStrings = [
    "tenantId",
    "principalId",
    "initiatingPrincipalId",
    "taskId",
    "serviceId",
    "policyVersion",
    "correlationId",
  ] as const;
  for (const field of requiredStrings) {
    if (!isValidField(record[field])) return null;
  }
  const optionalStrings = [
    "workspaceId",
    "agentRunId",
    "delegationId",
    "connectionId",
    "externalAccountId",
    "entitlementReference",
    "approvalReference",
    "sessionId",
    "runId",
    "platformId",
    "traceId",
  ] as const;
  for (const field of optionalStrings) {
    if (record[field] !== undefined && !isValidField(record[field])) {
      return null;
    }
  }
  if (
    record.dispatchMode !== undefined &&
    !(JOB_RUN_TRIGGERS as readonly string[]).includes(
      record.dispatchMode as string,
    )
  ) {
    return null;
  }
  if (
    record.execMode !== undefined &&
    record.execMode !== "sync" &&
    record.execMode !== "async"
  ) {
    return null;
  }
  if (
    record.principalType !== "human" &&
    record.principalType !== "service" &&
    record.principalType !== "agent"
  ) {
    return null;
  }
  if (record.environment !== "sandbox" && record.environment !== "live") {
    return null;
  }
  if (
    record.externalAccountId !== undefined &&
    record.connectionId === undefined
  ) {
    return null;
  }
  return Object.freeze({ ...(record as unknown as ExecutionContext) });
}

/**
 * Re-check a carried context against CURRENT authority at the
 * point of use: the PDP runs again (revocation since resolution
 * denies) and the connection binding is re-checked. A context
 * whose tenant no longer matches the principal's memberships —
 * including one tampered with in transit — denies.
 */
export async function revalidateExecutionContext(
  authority: ExecutionContextAuthority,
  context: ExecutionContext,
  permission: Permission,
  nowMs: number,
): Promise<
  | { ok: true }
  | { ok: false; code: ContextDenyCode; error: string; pdpReason?: DecisionReason }
> {
  const decision = await authorize(authority.memberships, {
    actorInternalUserId: context.principalId,
    tenantId: context.tenantId,
    permission,
    scope: context.workspaceId !== undefined ? "workspace" : "tenant",
    resourceScope:
      context.workspaceId !== undefined
        ? { workspaceId: context.workspaceId }
        : undefined,
    nowMs,
  });
  if (decision.decision === "deny") {
    return {
      ok: false,
      code: "PDP_DENIED",
      error: `authorization denied: ${decision.reason}`,
      pdpReason: decision.reason,
    };
  }
  if (context.connectionId !== undefined) {
    const bound = await authority.isConnectionBound({
      tenantId: context.tenantId,
      principalId: context.principalId,
      connectionId: context.connectionId,
      externalAccountId: context.externalAccountId,
    });
    if (!bound) {
      return {
        ok: false,
        code: "CONNECTION_NOT_BOUND",
        error: "connection is no longer bound to this principal in this tenant",
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Observe / enforce modes
// ---------------------------------------------------------------------------

export type ExecutionContextMode = "observe" | "enforce";

/**
 * Mode from the environment. Default is observe: adoption is
 * staged (§Rollout on #1078), and an unrecognized value must
 * never silently become enforcement.
 */
export function executionContextMode(env: {
  EXECUTION_CONTEXT_MODE?: string;
}): ExecutionContextMode {
  return env.EXECUTION_CONTEXT_MODE === "enforce" ? "enforce" : "observe";
}

export interface EvaluateExecutionContextResult {
  mode: ExecutionContextMode;
  /** False only in enforce mode with a denied resolution. */
  allowed: boolean;
  resolution: ResolveExecutionContextResult;
}

/**
 * Resolve under a mode. Observe mode always allows the caller to
 * proceed but returns the full resolution, so call sites can log
 * and audit what enforcement WOULD have decided before the flip.
 */
export async function evaluateExecutionContext(
  authority: ExecutionContextAuthority,
  input: ResolveExecutionContextInput,
  mode: ExecutionContextMode,
): Promise<EvaluateExecutionContextResult> {
  const resolution = await resolveExecutionContext(authority, input);
  return {
    mode,
    allowed: mode === "observe" ? true : resolution.ok,
    resolution,
  };
}

// ---------------------------------------------------------------------------
// Audit emission
// ---------------------------------------------------------------------------

/**
 * Record a resolution decision on the Slice 5 IAAA audit chain.
 * The event carries the context's correlation, tenant, initiator,
 * and delegation, so a context decision is reconstructable from
 * the same evidence as every other IAAA decision. The caller
 * must treat an ok:false result as "not audited".
 */
export async function recordContextDecision(
  store: AuditStore,
  resolution: ResolveExecutionContextResult,
  timestamp: number,
): Promise<AuditResult> {
  if (resolution.ok) {
    const context = resolution.context;
    return recordAuditEvent(store, {
      timestamp,
      type: "execution_context.resolution",
      actorPrincipalId: context.principalId,
      actorType: context.principalType,
      initiatingPrincipalId: context.initiatingPrincipalId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      taskId: context.taskId,
      agentRunId: context.agentRunId,
      delegationId: context.delegationId,
      correlationId: context.correlationId,
      action: `execution-context:${context.serviceId}`,
      resourceId: context.connectionId,
      decision: "allow",
      policyVersion: context.policyVersion,
      approvalId: context.approvalReference,
      outcome: "succeeded",
    });
  }
  const request = resolution.request;
  return recordAuditEvent(store, {
    timestamp,
    type: "execution_context.resolution",
    actorPrincipalId: request.principalId,
    actorType: request.principalType,
    initiatingPrincipalId: request.initiatingPrincipalId,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    taskId: request.taskId,
    agentRunId: request.agentRunId,
    delegationId: request.delegationId,
    correlationId: request.correlationId,
    action: `execution-context:${request.serviceId}`,
    decision: "deny",
    policyVersion:
      resolution.pdpReason !== undefined
        ? AUTHORIZATION_POLICY_VERSION
        : EXECUTION_CONTEXT_POLICY_VERSION,
    approvalId: request.approvalReference,
    outcome: "failed",
    errorCode: resolution.code,
  });
}
