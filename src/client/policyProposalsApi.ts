/**
 * Client for the PAP policy-proposal endpoints (issue #2838):
 * GET /api/iaaa/policy-proposals, GET /api/iaaa/policy-proposals/active,
 * POST /api/iaaa/policy-proposals/propose|approve|reject|promote|preview.
 *
 * Roles and permissions here are never declared: the panel renders
 * whatever the server's active snapshot carries (its roles and its
 * permission list), and the server validates every submitted
 * snapshot against ALL_ROLES via parsePolicySnapshot(). Nothing
 * client-side decides authorization.
 *
 * All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";

export interface PolicySnapshotInfo {
  version: string;
  permissions: string[];
  roleGrants: Record<string, string[]>;
}

export interface PolicyProposalInfo {
  proposalId: string;
  status: "proposed" | "approved" | "rejected" | "promoted";
  proposer: string;
  approver?: string;
  exceptionReason?: string;
  proposedSnapshot: PolicySnapshotInfo;
  beforeRef: string;
  afterRef: string;
  tenantScope: string;
  correlationId: string;
  createdAtMs: number;
  reviewedAtMs?: number;
  promotedAtMs?: number;
}

export interface PolicyGrantChange {
  role: string;
  permission: string;
  change: "added" | "removed";
}

export interface PolicyDecisionChange {
  role: string;
  permission: string;
  before: string;
  after: string;
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(value: unknown): PolicySnapshotInfo {
  if (!isRecord(value)) throw new Error("Policy response was not an object.");
  if (typeof value.version !== "string" || !Array.isArray(value.permissions)) {
    throw new Error("Policy response was malformed.");
  }
  if (!isRecord(value.roleGrants)) throw new Error("Policy response was malformed.");
  const roleGrants: Record<string, string[]> = {};
  for (const [role, grants] of Object.entries(value.roleGrants)) {
    if (!Array.isArray(grants) || grants.some((g) => typeof g !== "string")) {
      throw new Error("Policy response was malformed.");
    }
    roleGrants[role] = grants as string[];
  }
  return {
    version: value.version,
    permissions: value.permissions as string[],
    roleGrants,
  };
}

function parseProposal(value: unknown): PolicyProposalInfo {
  if (!isRecord(value)) throw new Error("Policy-proposal response was not an object.");
  const { proposalId, status, proposer, beforeRef, afterRef, tenantScope, correlationId, createdAtMs } = value;
  if (
    typeof proposalId !== "string" ||
    (status !== "proposed" && status !== "approved" && status !== "rejected" && status !== "promoted") ||
    typeof proposer !== "string" ||
    typeof beforeRef !== "string" ||
    typeof afterRef !== "string" ||
    typeof tenantScope !== "string" ||
    typeof correlationId !== "string" ||
    typeof createdAtMs !== "number"
  ) {
    throw new Error("Policy-proposal response was malformed.");
  }
  return {
    proposalId,
    status,
    proposer,
    ...(typeof value.approver === "string" ? { approver: value.approver } : {}),
    ...(typeof value.exceptionReason === "string" ? { exceptionReason: value.exceptionReason } : {}),
    proposedSnapshot: parseSnapshot(value.proposedSnapshot),
    beforeRef,
    afterRef,
    tenantScope,
    correlationId,
    createdAtMs,
    ...(typeof value.reviewedAtMs === "number" ? { reviewedAtMs: value.reviewedAtMs } : {}),
    ...(typeof value.promotedAtMs === "number" ? { promotedAtMs: value.promotedAtMs } : {}),
  };
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === "string" && body.error !== "" ? body.error : fallback;
  return new Error(message);
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, `Request to ${path} failed.`);
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!parsed) throw new Error("Policy-proposal response was malformed.");
  return parsed;
}

export async function fetchPolicyProposals(): Promise<PolicyProposalInfo[]> {
  const res = await apiFetch("/api/iaaa/policy-proposals");
  if (!res.ok) throw await readError(res, "Failed to load policy proposals.");
  const body = (await res.json().catch(() => null)) as { proposals?: unknown } | null;
  if (!body || !Array.isArray(body.proposals)) {
    throw new Error("Policy-proposal response was malformed.");
  }
  return body.proposals.map(parseProposal);
}

export async function fetchActivePolicy(): Promise<{
  active: PolicySnapshotInfo;
  source: string;
}> {
  const res = await apiFetch("/api/iaaa/policy-proposals/active");
  if (!res.ok) throw await readError(res, "Failed to load active policy.");
  const body = (await res.json().catch(() => null)) as { active?: unknown; source?: unknown } | null;
  if (!body) throw new Error("Policy response was malformed.");
  return {
    active: parseSnapshot(body.active),
    source: typeof body.source === "string" ? body.source : "unknown",
  };
}

export async function proposePolicy(snapshot: PolicySnapshotInfo): Promise<PolicyProposalInfo> {
  const body = await postJson("/api/iaaa/policy-proposals/propose", { snapshot });
  return parseProposal(body.proposal);
}

export async function approvePolicyProposal(
  proposalId: string,
  exceptionReason?: string,
): Promise<PolicyProposalInfo> {
  const body = await postJson("/api/iaaa/policy-proposals/approve", {
    proposalId,
    ...(exceptionReason !== undefined && exceptionReason !== "" ? { exceptionReason } : {}),
  });
  return parseProposal(body.proposal);
}

export async function rejectPolicyProposal(proposalId: string): Promise<PolicyProposalInfo> {
  const body = await postJson("/api/iaaa/policy-proposals/reject", { proposalId });
  return parseProposal(body.proposal);
}

export async function promotePolicyProposal(proposalId: string): Promise<PolicyProposalInfo> {
  const body = await postJson("/api/iaaa/policy-proposals/promote", { proposalId });
  return parseProposal(body.proposal);
}

export async function previewPolicy(snapshot: PolicySnapshotInfo): Promise<{
  beforeRef: string;
  afterRef: string;
  diff: PolicyGrantChange[];
  changedDecisions: PolicyDecisionChange[];
}> {
  const body = await postJson("/api/iaaa/policy-proposals/preview", { snapshot });
  if (
    typeof body.beforeRef !== "string" ||
    typeof body.afterRef !== "string" ||
    !Array.isArray(body.diff) ||
    !Array.isArray(body.changedDecisions)
  ) {
    throw new Error("Policy preview response was malformed.");
  }
  return {
    beforeRef: body.beforeRef,
    afterRef: body.afterRef,
    diff: body.diff as PolicyGrantChange[],
    changedDecisions: body.changedDecisions as PolicyDecisionChange[],
  };
}

export function fmtPolicyTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
