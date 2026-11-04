/**
 * Client for the bootstrap-proposal endpoints (issue 3077, 945 Q3):
 * GET /api/iaaa/bootstrap-proposals, GET /api/iaaa/bootstrap-proposals/current,
 * POST /api/iaaa/bootstrap-proposals/propose|approve|reject|confirm-applied.
 *
 * Nothing client-side decides authorization: every button calls a real
 * endpoint, and a server refusal surfaces as an error instead of a
 * hidden button. The list itself stays in the IAAA_BOOTSTRAP_ADMINS
 * env var: the panel manages proposals/approvals/audit, and an
 * approved change is applied through the secrets channel, then
 * confirmed here — the panel never writes the env var.
 *
 * All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";

export interface BootstrapProposalInfo {
  proposalId: string;
  status: "proposed" | "approved" | "rejected" | "applied";
  action: "add" | "remove";
  identifier: string;
  reason: string;
  proposer: string;
  approver?: string;
  exceptionReason?: string;
  retained?: { internalUserId: string; membershipId: string };
  correlationId: string;
  createdAtMs: number;
  reviewedAtMs?: number;
  appliedAtMs?: number;
  appliedBy?: string;
  applicationNote?: string;
}

export interface BootstrapDivergenceInfo {
  internalUserId: string;
  membershipId: string;
  roles: string[];
  grantedVia: string;
}

export interface BootstrapCurrentInfo {
  entries: string[];
  resolvedInternalUserIds: string[];
  unresolvedEntries: string[];
  divergence: BootstrapDivergenceInfo[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProposal(value: unknown): BootstrapProposalInfo {
  if (!isRecord(value)) throw new Error("Bootstrap-proposal response was not an object.");
  const { proposalId, status, action, identifier, reason, proposer, correlationId, createdAtMs } = value;
  if (
    typeof proposalId !== "string" ||
    (status !== "proposed" && status !== "approved" && status !== "rejected" && status !== "applied") ||
    (action !== "add" && action !== "remove") ||
    typeof identifier !== "string" ||
    typeof reason !== "string" ||
    typeof proposer !== "string" ||
    typeof correlationId !== "string" ||
    typeof createdAtMs !== "number"
  ) {
    throw new Error("Bootstrap-proposal response was malformed.");
  }
  return {
    proposalId,
    status,
    action,
    identifier,
    reason,
    proposer,
    ...(typeof value.approver === "string" ? { approver: value.approver } : {}),
    ...(typeof value.exceptionReason === "string" ? { exceptionReason: value.exceptionReason } : {}),
    ...(isRecord(value.retained) &&
    typeof value.retained.internalUserId === "string" &&
    typeof value.retained.membershipId === "string"
      ? {
          retained: {
            internalUserId: value.retained.internalUserId,
            membershipId: value.retained.membershipId,
          },
        }
      : {}),
    correlationId,
    createdAtMs,
    ...(typeof value.reviewedAtMs === "number" ? { reviewedAtMs: value.reviewedAtMs } : {}),
    ...(typeof value.appliedAtMs === "number" ? { appliedAtMs: value.appliedAtMs } : {}),
    ...(typeof value.appliedBy === "string" ? { appliedBy: value.appliedBy } : {}),
    ...(typeof value.applicationNote === "string" ? { applicationNote: value.applicationNote } : {}),
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
  if (!parsed) throw new Error("Bootstrap-proposal response was malformed.");
  return parsed;
}

export async function fetchBootstrapProposals(): Promise<BootstrapProposalInfo[]> {
  const res = await apiFetch("/api/iaaa/bootstrap-proposals");
  if (!res.ok) throw await readError(res, "Failed to load bootstrap proposals.");
  const body = (await res.json().catch(() => null)) as { proposals?: unknown } | null;
  if (!body || !Array.isArray(body.proposals)) {
    throw new Error("Bootstrap-proposal response was malformed.");
  }
  return body.proposals.map(parseProposal);
}

export async function fetchBootstrapCurrent(): Promise<BootstrapCurrentInfo> {
  const res = await apiFetch("/api/iaaa/bootstrap-proposals/current");
  if (!res.ok) throw await readError(res, "Failed to load current bootstrap list.");
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    !body ||
    !Array.isArray(body.entries) ||
    !Array.isArray(body.resolvedInternalUserIds) ||
    !Array.isArray(body.unresolvedEntries) ||
    !Array.isArray(body.divergence)
  ) {
    throw new Error("Bootstrap-current response was malformed.");
  }
  return {
    entries: body.entries as string[],
    resolvedInternalUserIds: body.resolvedInternalUserIds as string[],
    unresolvedEntries: body.unresolvedEntries as string[],
    divergence: body.divergence as BootstrapDivergenceInfo[],
  };
}

export async function proposeBootstrapChange(
  action: "add" | "remove",
  identifier: string,
  reason: string,
): Promise<BootstrapProposalInfo> {
  const body = await postJson("/api/iaaa/bootstrap-proposals/propose", {
    action,
    identifier,
    reason,
  });
  return parseProposal(body.proposal);
}

export async function approveBootstrapProposal(
  proposalId: string,
  exceptionReason?: string,
): Promise<BootstrapProposalInfo> {
  const body = await postJson("/api/iaaa/bootstrap-proposals/approve", {
    proposalId,
    ...(exceptionReason !== undefined && exceptionReason !== "" ? { exceptionReason } : {}),
  });
  return parseProposal(body.proposal);
}

export async function rejectBootstrapProposal(proposalId: string): Promise<BootstrapProposalInfo> {
  const body = await postJson("/api/iaaa/bootstrap-proposals/reject", { proposalId });
  return parseProposal(body.proposal);
}

export async function confirmBootstrapApplied(
  proposalId: string,
  applicationNote?: string,
): Promise<BootstrapProposalInfo> {
  const body = await postJson("/api/iaaa/bootstrap-proposals/confirm-applied", {
    proposalId,
    ...(applicationNote !== undefined && applicationNote !== "" ? { applicationNote } : {}),
  });
  return parseProposal(body.proposal);
}

export function fmtBootstrapTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
