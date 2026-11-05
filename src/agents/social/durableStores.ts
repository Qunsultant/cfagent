/**
 * #1077 Phase 5b slice 1 — SessionStore-backed social stores.
 *
 * Durable adapters over the SESSION_STORE Durable Object binding, so
 * drafts and pending approvals survive across the every-30-minute ticks (the
 * Phase 5a in-memory stores reset every isolate).
 *
 * Why not the list op: SessionStore.fetch refuses op "list" unless
 * ns === "etrade" and the key starts with "etrade:token:" — so no
 * social listing via list, ever. listDrafts/listPending are instead
 * implemented by fan-out gets over the five KNOWN_SOCIAL_CHANNELS:
 * one key per (date, channel), no index to maintain, no race from
 * load-all/write-back (every put/record writes through immediately).
 *
 * Wire format: SessionStore values are strings, so drafts and pending
 * approvals are JSON.stringify'd on put and JSON.parse'd on get. A
 * value that is not valid JSON or fails the shape guard is treated as
 * ABSENT, never as a minted draft or approval: a corrupt draft must
 * never publish, and treating it as absent lets the next build
 * recreate and overwrite it (self-healing). Corrupt values are NOT
 * deleted on read — the record is preserved for inspection.
 *
 * Transport failures are the opposite of corrupt values: a failed
 * fetch, a non-2xx reply, or a reply {error} THROWS, so the goal
 * executor can record the error and leave the goal due for retry.
 * Silent no-ops would lose drafts.
 */

import type { DoNamespaceLike } from "../../data/durableKv";
import { KNOWN_SOCIAL_CHANNELS } from "./config";
import type { SocialDraft } from "./draft";
import { isSocialDraft, type SocialLedger } from "./ledger";
import type { PendingApproval, PendingApprovalStore } from "./approvals";

/** Minimal DO stub surface: the fetch side of a DO namespace binding. */
export interface SessionStoreStub {
  fetch(request: Request): Promise<Response>;
}

const SOCIAL_NS = "social";
const STORE_URL = "https://session-store.internal/kv";

function draftKey(date: string, channel: string): string {
  return `social-draft:${date}:${channel}`;
}

function pendingKey(date: string, channel: string): string {
  return `social-pending:${date}:${channel}`;
}

function isPendingApproval(value: unknown): value is PendingApproval {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PendingApproval).date === "string" &&
    typeof (value as PendingApproval).channel === "string" &&
    typeof (value as PendingApproval).draftId === "string" &&
    typeof (value as PendingApproval).requestedAtMs === "number"
  );
}

export async function socialStoreOp(
  stub: SessionStoreStub,
  op: "get" | "put" | "delete",
  key: string,
  value?: string,
): Promise<{ value?: string | null; ok?: boolean }> {
  const res = await stub.fetch(
    new Request(STORE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ns: SOCIAL_NS, key, value }),
    }),
  );
  if (!res.ok) {
    throw new Error(`social store ${op} failed: HTTP ${res.status}`);
  }
  const reply = (await res.json()) as { value?: string | null; ok?: boolean; error?: string };
  if (reply.error) {
    throw new Error(`social store ${op} failed: ${reply.error}`);
  }
  return reply;
}

function parseDraft(raw: string | null | undefined): SocialDraft | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isSocialDraft(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parsePending(raw: string | null | undefined): PendingApproval | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isPendingApproval(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createSessionStoreSocialLedger(stub: SessionStoreStub): SocialLedger {
  const ledger: SocialLedger = {
    async getDraft(date: string, channel: string) {
      const reply = await socialStoreOp(stub, "get", draftKey(date, channel));
      return parseDraft(reply.value);
    },
    async putDraft(draft: SocialDraft) {
      await socialStoreOp(stub, "put", draftKey(draft.date, draft.channel), JSON.stringify(draft));
    },
    async listDrafts(date: string) {
      const out: SocialDraft[] = [];
      for (const channel of KNOWN_SOCIAL_CHANNELS) {
        const draft = await ledger.getDraft(date, channel);
        if (draft) out.push(draft);
      }
      return out;
    },
  };
  return ledger;
}

export function createSessionStorePendingApprovalStore(stub: SessionStoreStub): PendingApprovalStore {
  const store: PendingApprovalStore = {
    async recordPending(approval: PendingApproval) {
      await socialStoreOp(
        stub,
        "put",
        pendingKey(approval.date, approval.channel),
        JSON.stringify(approval),
      );
    },
    async listPending(date: string) {
      const out: PendingApproval[] = [];
      for (const channel of KNOWN_SOCIAL_CHANNELS) {
        const reply = await socialStoreOp(stub, "get", pendingKey(date, channel));
        const pending = parsePending(reply.value);
        if (pending) out.push(pending);
      }
      return out;
    },
    async clearPending(date: string, channel: string) {
      await socialStoreOp(stub, "delete", pendingKey(date, channel));
    },
  };
  return store;
}

/**
 * Resolve durable social stores from a Worker Env namespace. Returns
 * null when the namespace is absent, so callers fail closed instead
 * of silently writing to nowhere. The single "kv" instance holds every
 * bucket (see SessionStore), namespaced by ns = "social".
 */
export function createSocialStoresFromNamespace(
  namespace: DoNamespaceLike | null | undefined,
): { ledger: SocialLedger; approvals: PendingApprovalStore } | null {
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName("kv")) as SessionStoreStub;
  return {
    ledger: createSessionStoreSocialLedger(stub),
    approvals: createSessionStorePendingApprovalStore(stub),
  };
}
