/**
 * Issue #3155 (parent #945, Q9) — grant proposals: the record behind
 * the second-approver rule for admin grants.
 *
 * A proposal records that one admin proposed an admin-role grant;
 * the grant mints only when a second, distinct admin confirms the
 * same proposal. The store here records proposals and confirmations;
 * it never grants anything itself — minting happens only in the
 * route, which calls grantMembership (with its canGrantRole
 * enforcement) after confirmation.
 *
 * Storage mirrors the access-request pattern over a KvLike
 * (production: sessionStore(env), the SessionStore DO):
 * - `iaaa-grant-proposal:<proposalId>` -> JSON GrantProposal
 * - `iaaa-grant-proposal:index` -> JSON string[] of proposal ids
 * One key per record, no list op (SessionStore refuses list outside
 * the etrade namespace). A value that is not valid JSON or fails the
 * shape guard reads as ABSENT, never as a confirmed proposal; corrupt
 * bytes are left untouched for inspection. Index drift fails closed:
 * a proposal whose index write was lost is invisible to matching,
 * so a resubmit creates a fresh proposal instead of confirming a
 * phantom — a stale proposal can never mint on its own, because
 * confirmation requires an explicit resubmit of the identical grant
 * by a distinct admin, and minting still passes grantMembership.
 *
 * The proposal stores NO grantedBy: the granter of record is set at
 * mint time by grantMembership (the confirmer), and the proposal's
 * approvers list preserves both approvers for audit. A proposal by
 * a granter who is later revoked stays confirmable by any other
 * valid granter: the second approver passes the full gate chain on
 * the confirm call, so a revoked proposer cannot launder a grant.
 */
import type { KvLike } from "./kvResilience";
import { bindingsEqual, type GrantBindingKey } from "./grantRules";

export type GrantProposalKind = "grant" | "edit";
export type GrantProposalStatus = "pending" | "confirmed";

export interface GrantProposal {
  proposalId: string;
  kind: GrantProposalKind;
  /** Membership being edited, for kind "edit"; absent for kind "grant". */
  targetMembershipId?: string;
  granteeInternalUserId: string;
  tenantId: string;
  roleBindings: GrantBindingKey[];
  proposerInternalUserId: string;
  /** Approvers in order: [proposer, confirmer] once confirmed. */
  approvers: string[];
  status: GrantProposalStatus;
  createdAtMs: number;
  confirmedAtMs?: number;
  confirmedBy?: string;
}

export type GrantProposalResolveResult =
  | { action: "propose"; proposal: GrantProposal }
  | { action: "confirm"; proposal: GrantProposal }
  | { action: "awaiting"; proposal: GrantProposal };

export interface GrantProposalStore {
  propose(input: {
    kind: GrantProposalKind;
    targetMembershipId?: string;
    granteeInternalUserId: string;
    tenantId: string;
    roleBindings: GrantBindingKey[];
    proposerInternalUserId: string;
    nowMs: number;
  }): Promise<GrantProposal>;
  get(proposalId: string): Promise<GrantProposal | null>;
  listPending(): Promise<GrantProposal[]>;
  findMatchingPending(input: {
    kind: GrantProposalKind;
    targetMembershipId?: string;
    granteeInternalUserId: string;
    tenantId: string;
    roleBindings: GrantBindingKey[];
  }): Promise<GrantProposal | null>;
  confirm(
    proposalId: string,
    confirmerInternalUserId: string,
    nowMs: number,
  ): Promise<
    | { ok: true; proposal: GrantProposal }
    | { ok: false; code: "NOT_FOUND" | "NOT_PENDING" | "SELF_CONFIRM" | "ALREADY_APPROVER" }
  >;
}

const RECORD_PREFIX = "iaaa-grant-proposal:";
const INDEX_KEY = "iaaa-grant-proposal:index";

function parseProposal(raw: unknown): GrantProposal | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.proposalId !== "string" || p.proposalId === "") return null;
  if (p.kind !== "grant" && p.kind !== "edit") return null;
  if (p.targetMembershipId !== undefined && typeof p.targetMembershipId !== "string") return null;
  if (typeof p.granteeInternalUserId !== "string" || p.granteeInternalUserId === "") return null;
  if (typeof p.tenantId !== "string" || p.tenantId === "") return null;
  if (!Array.isArray(p.roleBindings)) return null;
  for (const b of p.roleBindings) {
    if (typeof b !== "object" || b === null) return null;
    const binding = b as Record<string, unknown>;
    if (typeof binding.role !== "string" || binding.role === "") return null;
    if (typeof binding.scope !== "string" || binding.scope === "") return null;
    if (binding.workspaceId !== undefined && typeof binding.workspaceId !== "string") return null;
  }
  if (typeof p.proposerInternalUserId !== "string" || p.proposerInternalUserId === "") return null;
  if (!Array.isArray(p.approvers) || !p.approvers.every((a) => typeof a === "string")) return null;
  if (p.status !== "pending" && p.status !== "confirmed") return null;
  if (typeof p.createdAtMs !== "number") return null;
  if (p.confirmedAtMs !== undefined && typeof p.confirmedAtMs !== "number") return null;
  if (p.confirmedBy !== undefined && typeof p.confirmedBy !== "string") return null;
  return parsed as GrantProposal;
}

export function createGrantProposalStore(kv: KvLike): GrantProposalStore {
  async function readIndex(): Promise<string[]> {
    const raw = await kv.get(INDEX_KEY);
    if (typeof raw !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  async function writeIndex(ids: string[]): Promise<void> {
    await kv.put(INDEX_KEY, JSON.stringify(ids));
  }

  async function write(proposal: GrantProposal): Promise<void> {
    await kv.put(`${RECORD_PREFIX}${proposal.proposalId}`, JSON.stringify(proposal));
    const ids = await readIndex();
    if (!ids.includes(proposal.proposalId)) {
      ids.push(proposal.proposalId);
      await writeIndex(ids);
    }
  }

  return {
    async propose(input) {
      const proposal: GrantProposal = {
        proposalId: crypto.randomUUID(),
        kind: input.kind,
        ...(input.targetMembershipId !== undefined
          ? { targetMembershipId: input.targetMembershipId }
          : {}),
        granteeInternalUserId: input.granteeInternalUserId,
        tenantId: input.tenantId,
        roleBindings: input.roleBindings.map((b) => ({
          role: b.role,
          scope: b.scope,
          ...(b.workspaceId !== undefined ? { workspaceId: b.workspaceId } : {}),
        })),
        proposerInternalUserId: input.proposerInternalUserId,
        approvers: [input.proposerInternalUserId],
        status: "pending",
        createdAtMs: input.nowMs,
      };
      await write(proposal);
      return proposal;
    },

    async get(proposalId: string) {
      if (typeof proposalId !== "string" || proposalId === "") return null;
      return parseProposal(await kv.get(`${RECORD_PREFIX}${proposalId}`));
    },

    async listPending() {
      const ids = await readIndex();
      const found: GrantProposal[] = [];
      for (const id of ids) {
        const proposal = parseProposal(await kv.get(`${RECORD_PREFIX}${id}`));
        if (proposal && proposal.status === "pending") found.push(proposal);
      }
      return found;
    },

    async findMatchingPending(input) {
      const pending = await this.listPending();
      return (
        pending.find(
          (p) =>
            p.kind === input.kind &&
            (p.targetMembershipId ?? undefined) === (input.targetMembershipId ?? undefined) &&
            p.granteeInternalUserId === input.granteeInternalUserId &&
            p.tenantId === input.tenantId &&
            bindingsEqual(p.roleBindings, input.roleBindings),
        ) ?? null
      );
    },

    async confirm(proposalId, confirmerInternalUserId, nowMs) {
      const proposal = await this.get(proposalId);
      if (!proposal) return { ok: false, code: "NOT_FOUND" };
      if (proposal.status !== "pending") return { ok: false, code: "NOT_PENDING" };
      if (confirmerInternalUserId === proposal.proposerInternalUserId) {
        return { ok: false, code: "SELF_CONFIRM" };
      }
      if (proposal.approvers.includes(confirmerInternalUserId)) {
        return { ok: false, code: "ALREADY_APPROVER" };
      }
      const confirmed: GrantProposal = {
        ...proposal,
        approvers: [...proposal.approvers, confirmerInternalUserId],
        status: "confirmed",
        confirmedAtMs: nowMs,
        confirmedBy: confirmerInternalUserId,
      };
      await write(confirmed);
      return { ok: true, proposal: confirmed };
    },
  };
}

/**
 * Route-level resolution for an admin-role grant: find a matching
 * pending proposal for the identical grant, and either propose it
 * (first admin), confirm it (a distinct second admin), or report
 * that it is still awaiting a second approver (same admin resubmit,
 * or an already-approver resubmit). The caller mints only on
 * "confirm"; "propose" and "awaiting" both return the pending
 * response without minting.
 */
export async function resolveAdminGrantProposal(
  store: GrantProposalStore,
  input: {
    kind: GrantProposalKind;
    targetMembershipId?: string;
    granteeInternalUserId: string;
    tenantId: string;
    roleBindings: GrantBindingKey[];
    callerInternalUserId: string;
    nowMs: number;
  },
): Promise<GrantProposalResolveResult> {
  const existing = await store.findMatchingPending({
    kind: input.kind,
    targetMembershipId: input.targetMembershipId,
    granteeInternalUserId: input.granteeInternalUserId,
    tenantId: input.tenantId,
    roleBindings: input.roleBindings,
  });
  if (!existing) {
    const proposal = await store.propose({
      kind: input.kind,
      targetMembershipId: input.targetMembershipId,
      granteeInternalUserId: input.granteeInternalUserId,
      tenantId: input.tenantId,
      roleBindings: input.roleBindings,
      proposerInternalUserId: input.callerInternalUserId,
      nowMs: input.nowMs,
    });
    return { action: "propose", proposal };
  }
  if (existing.proposerInternalUserId === input.callerInternalUserId) {
    return { action: "awaiting", proposal: existing };
  }
  const confirmed = await store.confirm(existing.proposalId, input.callerInternalUserId, input.nowMs);
  if (!confirmed.ok) return { action: "awaiting", proposal: existing };
  return { action: "confirm", proposal: confirmed.proposal };
}
