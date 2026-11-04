/**
 * Issue #1274 — elevation request records ("request access").
 *
 * A signed-in member asks for tenant-admin; an existing admin approves
 * or denies. Requests NEVER auto-grant: the grant happens only when an
 * admin approves through the route, which calls grantMembership (with
 * its canGrantRole enforcement) — the store here records decisions,
 * it never grants anything itself.
 *
 * Storage mirrors the membership store's documented pattern over a
 * KvLike (production: sessionStore(env), the SessionStore DO):
 * - `iaaa-access-request:<requestId>` -> JSON AccessRequest
 * - `iaaa-access-request:index` -> JSON string[] of request ids
 * One key per record, no list op (SessionStore refuses list outside
 * the etrade namespace). A value that is not valid JSON or fails the
 * shape guard reads as ABSENT, never as a granted request; corrupt
 * bytes are left untouched for inspection. Index drift (a record
 * written but the index write lost) fails closed: the request is
 * invisible to list, and re-requesting is refused only while a
 * pending record is visible — a lost index entry can therefore
 * re-request, never double-grant (approval still goes through
 * grantMembership per request).
 *
 * First cut: only tenant-admin, tenant scope, may be requested.
 * Platform-admin requests are refused (INVALID_ROLE): platform
 * grants need a platform-scope granter and are out of scope here.
 */
import type { KvLike } from "./kvResilience";

export type AccessRequestStatus = "pending" | "approved" | "denied";

export interface AccessRequest {
  requestId: string;
  requesterInternalUserId: string;
  requestedRole: "tenant-admin";
  scope: "tenant";
  tenantId: string;
  status: AccessRequestStatus;
  createdAtMs: number;
  decidedAtMs?: number;
  decidedBy?: string;
  /**
   * Issue #3155 (Q9 second-approver rule): approvers of an approval
   * decision, in order. Absent (pre-#3155 records) means no recorded
   * approval yet. The route records each approver; the request moves
   * to "approved" (and grants) only on the second distinct approver.
   */
  approvers?: string[];
}

export type AccessRequestCreateResult =
  | { ok: true; request: AccessRequest }
  | { ok: false; code: "INVALID_ROLE" | "INVALID_REQUESTER" | "ALREADY_PENDING"; request?: AccessRequest };

export type AccessRequestDecideResult =
  | { ok: true; request: AccessRequest }
  | { ok: false; code: "NOT_FOUND" | "NOT_PENDING" };

export type AccessRequestApproveResult =
  | { ok: true; request: AccessRequest; approverCount: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_PENDING" | "ALREADY_APPROVER" };

export interface AccessRequestStore {
  create(input: {
    requesterInternalUserId: string;
    requestedRole: string;
    tenantId: string;
    nowMs: number;
  }): Promise<AccessRequestCreateResult>;
  get(requestId: string): Promise<AccessRequest | null>;
  list(): Promise<AccessRequest[]>;
  decide(
    requestId: string,
    decision: "approved" | "denied",
    decidedBy: string,
    nowMs: number,
  ): Promise<AccessRequestDecideResult>;
  /**
   * Issue #3155: record one approver of an approval decision without
   * changing status. The route calls this on approve, then grants
   * and decides "approved" only when approverCount reaches 2. A deny
   * still goes through decide("denied") directly, single-admin.
   */
  recordApprover(
    requestId: string,
    approver: string,
    nowMs: number,
  ): Promise<AccessRequestApproveResult>;
}

const RECORD_PREFIX = "iaaa-access-request:";
const INDEX_KEY = "iaaa-access-request:index";

function isAccessRequest(value: unknown): value is AccessRequest {
  if (typeof value !== "object" || value === null) return false;
  const r = value as AccessRequest;
  return (
    typeof r.requestId === "string" &&
    r.requestId !== "" &&
    typeof r.requesterInternalUserId === "string" &&
    r.requesterInternalUserId !== "" &&
    r.requestedRole === "tenant-admin" &&
    r.scope === "tenant" &&
    typeof r.tenantId === "string" &&
    r.tenantId !== "" &&
    (r.status === "pending" || r.status === "approved" || r.status === "denied") &&
    typeof r.createdAtMs === "number" &&
    (r.approvers === undefined ||
      (Array.isArray(r.approvers) && r.approvers.every((a) => typeof a === "string")))
  );
}

function parseRequest(raw: string | null): AccessRequest | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isAccessRequest(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * #2433 (step 5b): this Kv factory remains the flag-off and
 * adapter-internal construction. Env-level composition goes
 * through session.ts wiredAccessRequestStore(env), which
 * returns the session family's access-request port when
 * SESSION_PORTS_ENABLED is on and this factory when off.
 */
export function createAccessRequestStore(kv: KvLike): AccessRequestStore {
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

  return {
    async create(input) {
      if (typeof input.requesterInternalUserId !== "string" || input.requesterInternalUserId.trim() === "") {
        return { ok: false, code: "INVALID_REQUESTER" };
      }
      if (input.requestedRole !== "tenant-admin") {
        return { ok: false, code: "INVALID_ROLE" };
      }
      const tenantId = typeof input.tenantId === "string" ? input.tenantId.trim() : "";
      if (tenantId === "") return { ok: false, code: "INVALID_ROLE" };
      const existing = await this.list();
      const pending = existing.find(
        (r) =>
          r.requesterInternalUserId === input.requesterInternalUserId.trim() &&
          r.requestedRole === "tenant-admin" &&
          r.tenantId === tenantId &&
          r.status === "pending",
      );
      if (pending) return { ok: false, code: "ALREADY_PENDING", request: pending };
      const request: AccessRequest = {
        requestId: crypto.randomUUID(),
        requesterInternalUserId: input.requesterInternalUserId.trim(),
        requestedRole: "tenant-admin",
        scope: "tenant",
        tenantId,
        status: "pending",
        createdAtMs: input.nowMs,
      };
      await kv.put(`${RECORD_PREFIX}${request.requestId}`, JSON.stringify(request));
      const ids = await readIndex();
      if (!ids.includes(request.requestId)) {
        ids.push(request.requestId);
        await writeIndex(ids);
      }
      return { ok: true, request };
    },

    async get(requestId: string) {
      if (typeof requestId !== "string" || requestId === "") return null;
      return parseRequest(await kv.get(`${RECORD_PREFIX}${requestId}`));
    },

    async list() {
      const ids = await readIndex();
      const found: AccessRequest[] = [];
      for (const id of ids) {
        const request = parseRequest(await kv.get(`${RECORD_PREFIX}${id}`));
        if (request) found.push(request);
      }
      return found;
    },

    async decide(requestId, decision, decidedBy, nowMs) {
      const request = await this.get(requestId);
      if (!request) return { ok: false, code: "NOT_FOUND" };
      if (request.status !== "pending") return { ok: false, code: "NOT_PENDING" };
      const decided: AccessRequest = {
        ...request,
        status: decision,
        decidedAtMs: nowMs,
        decidedBy,
      };
      await kv.put(`${RECORD_PREFIX}${requestId}`, JSON.stringify(decided));
      return { ok: true, request: decided };
    },

    async recordApprover(requestId, approver, nowMs) {
      const request = await this.get(requestId);
      if (!request) return { ok: false, code: "NOT_FOUND" };
      if (request.status !== "pending") return { ok: false, code: "NOT_PENDING" };
      const approvers = request.approvers ?? [];
      if (approvers.includes(approver)) return { ok: false, code: "ALREADY_APPROVER" };
      const updated: AccessRequest = {
        ...request,
        approvers: [...approvers, approver],
      };
      await kv.put(`${RECORD_PREFIX}${requestId}`, JSON.stringify(updated));
      return { ok: true, request: updated, approverCount: approvers.length + 1 };
    },
  };
}
