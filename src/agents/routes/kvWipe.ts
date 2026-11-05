/**
 * KV wipe routes: selective deletion of platform-wide SessionStore rows.
 *
 * Issue #2489 — the selective wipe's KV half. SQL rows are own-instance
 * (the caller's OrchestratorAgent instance); KV rows live in the ONE
 * shared SessionStore DO (idFromName("kv")), so wiping one affects all
 * users. That blast radius is why this route is platform-admin-gated
 * server-side (the #2331 slice-1 resolveCaller + isPlatformAdmin
 * pattern), not merely UI-gated: a raw call must not bypass the gate.
 *
 * Route: POST /api/maintenance/kv-wipe, body `{ rows, confirm }`.
 * - Preview without `{ confirm: true }`: per-row counts, no deletes,
 *   no audit.
 * - With confirm: the gate is checked ONCE, then rows execute in a
 *   FIXED safe order (memberships, tokens, bindings, sessions last)
 *   regardless of the request's row order. A single aggregate call is
 *   required, not per-row calls: after the memberships row is wiped,
 *   a per-call gate re-check would 403 every later row, since the
 *   caller's own membership is gone. Sessions last because wiping
 *   them signs the admin out too — the client needs no further
 *   authenticated call after this response.
 * - Every row's deleted count is VERIFIED by re-listing after the
 *   deletes (KvLike.delete reports nothing), so a silent store
 *   failure can never be reported as success. A row whose listing
 *   is unavailable fails that row with an error and never claims a
 *   count; other rows still execute (per-table results pattern).
 *
 * Rows (all platform-wide):
 * - memberships: "sessions" namespace, prefix `iaaa-membership:`
 *   (records + user indexes). Wiping memberships ALWAYS clears the
 *   genesis marker too (coupled): the marker survives membership
 *   wipes otherwise, and a surviving marker takes the genesis-closed
 *   path on the next owner login — tenant-admin only, platform-admin
 *   lost (the lockout #2489 forbids). The response reports the
 *   marker row with `coupled: true` when it was added this way.
 * - tokens: "etrade" namespace, prefix `etrade:token:` (same listing
 *   the nightly renewal uses). Every user reconnects after.
 * - bindings: "sessions" namespace, prefixes `iaaa-binding:` and
 *   `iaaa-alias:` (identity bindings + login alias records).
 * - marker: single key `iaaa-bootstrap:platform-genesis:<tenant>`.
 *   Standalone selection re-opens the genesis window (only the owner
 *   is listed, so only the owner can claim it) — allowed, with UI
 *   warning copy. The UI disables the marker checkbox while
 *   memberships is checked, since the coupling makes it moot.
 * - sessions: "sessions" namespace, every key NOT starting with
 *   `iaaa-` (session records are bare UUID keys; the iaaa-* rows
 *   belong to the rows above). Wiping sessions logs everyone out.
 *
 * Route-level gate review (required by the SessionStore list op's own
 * comment): this is a NEW list caller, gated to platform-admin above.
 * The listed values are never returned to the client — only counts.
 */

import { createStoreKv, listStoreEntries } from "../../data/durableKv";
import {
  platformGenesisMarkerKey,
  resolveIaaaTenant,
} from "../../security/iaaaGithubEndToEnd";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { isPlatformAdmin } from "../../security/iaaaAdminOverview";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import { isLoginShaped } from "../../security/serviceIdentity";
import { sessionStore } from "../../security/session";
import type { MembershipStore } from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import type { DoNamespaceLike } from "../../data/durableKv";
import type { Env } from "../../types";

export const KV_WIPE_ROWS = [
  "memberships",
  "tokens",
  "bindings",
  "marker",
  "sessions",
] as const;

export type KvWipeRow = (typeof KV_WIPE_ROWS)[number];

/** Fixed execution order for confirm (safe order, not request order). */
const EXECUTION_ORDER: KvWipeRow[] = [
  "memberships",
  "tokens",
  "bindings",
  "sessions",
];

/** List/delete seams per bucket (production builder below; fakes in tests). */
export interface KvWipeStores {
  listSessions(prefix: string): Promise<Array<{ key: string }> | null>;
  getSessionKey(key: string): Promise<string | null>;
  deleteSessionKey(key: string): Promise<void>;
  listEtrade(prefix: string): Promise<Array<{ key: string }> | null>;
  deleteEtradeKey(key: string): Promise<void>;
}

export function createKvWipeStores(env: Env): KvWipeStores {
  const namespace = env.SESSION_STORE as unknown as DoNamespaceLike | undefined;
  const sessionsKv = sessionStore(env);
  const etradeKv = createStoreKv({
    namespace,
    namespaceName: "etrade",
    legacyFallback: false,
  });
  return {
    listSessions: (prefix) =>
      listStoreEntries({ namespace, namespaceName: "sessions", prefix }),
    getSessionKey: (key) => sessionsKv.get(key),
    deleteSessionKey: (key) => sessionsKv.delete(key),
    listEtrade: (prefix) =>
      listStoreEntries({ namespace, namespaceName: "etrade", prefix }),
    deleteEtradeKey: (key) => etradeKv.delete(key),
  };
}

export interface KvWipeRouteContext {
  /** Worker env (carries the SESSION_STORE binding). */
  env: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /** Test seam: use this store instead of the SessionStore KV store. */
  stores?: KvWipeStores;
  /** Test seam: use this store instead of the SessionStore KV for aliases. */
  aliasKv?: KvLike;
  /** Test seam: use this store instead of the SessionStore KV for memberships. */
  membershipStore?: MembershipStore;
  /** Test seam: use this tenant instead of resolveIaaaTenant(env). */
  tenantId?: string;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function resolveCaller(
  request: Request,
  ctx: KvWipeRouteContext,
): Promise<{ login: string; internalUserId: string } | Response> {
  const login = request.headers.get("x-user-login") || "";
  if (!isLoginShaped(login)) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const kv = ctx.aliasKv ?? sessionStore(ctx.env);
  const internalUserId = await lookupInternalUserIdByLogin(kv, login);
  if (!internalUserId) {
    return jsonError(
      "Forbidden: KV wipe requires a wired session.",
      403,
    );
  }
  const store =
    ctx.membershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
  const memberships = await store.getMembershipsByUser(internalUserId);
  if (!isPlatformAdmin(memberships, Date.now())) {
    return jsonError(
      "Forbidden: KV wipe requires platform-admin membership.",
      403,
    );
  }
  return { login, internalUserId };
}

export interface KvWipeRowResult {
  row: KvWipeRow;
  /** Counted on preview; verified deleted count on confirm. */
  count: number;
  /** True when the marker row was added by the memberships coupling. */
  coupled?: boolean;
  /** Set when the row could not be listed or verified (nothing claimed). */
  error?: string;
}

interface RowPlan {
  row: KvWipeRow;
  coupled?: boolean;
  list: () => Promise<Array<{ key: string }> | null>;
  count: (entries: Array<{ key: string }>) => number;
  keys: (entries: Array<{ key: string }>) => string[];
  deleteKey: (key: string) => Promise<void>;
  verify: () => Promise<Array<{ key: string }> | null>;
}

function buildPlans(
  stores: KvWipeStores,
  tenantId: string,
  requested: KvWipeRow[],
): RowPlan[] {
  const markerKey = platformGenesisMarkerKey(tenantId);
  const plans = new Map<KvWipeRow, RowPlan>();
  plans.set("memberships", {
    row: "memberships",
    list: () => stores.listSessions("iaaa-membership:"),
    count: (entries) => entries.length,
    keys: (entries) => entries.map((e) => e.key),
    deleteKey: (key) => stores.deleteSessionKey(key),
    verify: () => stores.listSessions("iaaa-membership:"),
  });
  plans.set("tokens", {
    row: "tokens",
    list: () => stores.listEtrade("etrade:token:"),
    count: (entries) => entries.length,
    keys: (entries) => entries.map((e) => e.key),
    deleteKey: (key) => stores.deleteEtradeKey(key),
    verify: () => stores.listEtrade("etrade:token:"),
  });
  plans.set("bindings", {
    row: "bindings",
    list: async () => {
      const byProvider = await stores.listSessions("iaaa-binding:");
      if (byProvider === null) return null;
      const alias = await stores.listSessions("iaaa-alias:");
      if (alias === null) return null;
      return [...byProvider, ...alias];
    },
    count: (entries) => entries.length,
    keys: (entries) => entries.map((e) => e.key),
    deleteKey: (key) => stores.deleteSessionKey(key),
    verify: async () => {
      const byProvider = await stores.listSessions("iaaa-binding:");
      if (byProvider === null) return null;
      const alias = await stores.listSessions("iaaa-alias:");
      if (alias === null) return null;
      return [...byProvider, ...alias];
    },
  });
  plans.set("marker", {
    row: "marker",
    list: async () => {
      const value = await stores.getSessionKey(markerKey);
      return value === null ? [] : [{ key: markerKey }];
    },
    count: (entries) => entries.length,
    keys: (entries) => entries.map((e) => e.key),
    deleteKey: (key) => stores.deleteSessionKey(key),
    verify: async () => {
      const value = await stores.getSessionKey(markerKey);
      return value === null ? [] : [{ key: markerKey }];
    },
  });
  plans.set("sessions", {
    row: "sessions",
    // Session records are bare UUID keys; every iaaa-* key belongs to
    // another row, so the filter — not a bare namespace wipe — is what
    // makes this row session-records-only.
    list: async () => {
      const all = await stores.listSessions("");
      if (all === null) return null;
      return all.filter((e) => !e.key.startsWith("iaaa-"));
    },
    count: (entries) => entries.length,
    keys: (entries) => entries.map((e) => e.key),
    deleteKey: (key) => stores.deleteSessionKey(key),
    verify: async () => {
      const all = await stores.listSessions("");
      if (all === null) return null;
      return all.filter((e) => !e.key.startsWith("iaaa-"));
    },
  });

  const selected = new Set(requested);
  // Memberships coupling (#2489 design): a memberships wipe without a
  // marker clear strands the genesis marker and locks platform-admin
  // out on the next owner login (genesis-closed path). The marker is
  // added, and reported as coupled, whenever memberships is selected.
  if (selected.has("memberships") && !selected.has("marker")) {
    selected.add("marker");
  }
  const ordered: RowPlan[] = [];
  for (const row of EXECUTION_ORDER) {
    if (selected.has(row)) ordered.push(plans.get(row)!);
  }
  // The marker rides with memberships (same step, right after it);
  // standalone marker selection executes in its own position. When
  // memberships is selected the marker clear is required by the
  // coupling either way, so it is reported as coupled.
  if (selected.has("marker") && !ordered.some((p) => p.row === "marker")) {
    const markerPlan = plans.get("marker")!;
    const membershipsIndex = ordered.findIndex((p) => p.row === "memberships");
    const plan: RowPlan = selected.has("memberships")
      ? { ...markerPlan, coupled: true }
      : markerPlan;
    if (membershipsIndex >= 0) {
      ordered.splice(membershipsIndex + 1, 0, plan);
    } else {
      ordered.push(plan);
    }
  }
  return ordered;
}

export async function handleKvWipeRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: KvWipeRouteContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  if (
    !path.endsWith("/maintenance/kv-wipe") ||
    request.method !== "POST"
  ) {
    return null;
  }
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    const requested = rawRows.filter((r: unknown): r is KvWipeRow =>
      (KV_WIPE_ROWS as readonly string[]).includes(r as string),
    );
    if (requested.length === 0) {
      return jsonError(
        `No valid KV rows selected. Valid rows: ${KV_WIPE_ROWS.join(", ")}`,
        400,
      );
    }
    if (rawRows.length !== requested.length) {
      return jsonError(
        `Unknown KV row in request. Valid rows: ${KV_WIPE_ROWS.join(", ")}`,
        400,
      );
    }
    const caller = await resolveCaller(request, ctx);
    if (caller instanceof Response) return caller;

    const stores = ctx.stores ?? createKvWipeStores(ctx.env);
    const tenantId = ctx.tenantId ?? resolveIaaaTenant(ctx.env);
    const plans = buildPlans(stores, tenantId, requested);
    const confirm = body.confirm === true;

    const results: KvWipeRowResult[] = [];
    for (const plan of plans) {
      const listed = await plan.list();
      if (listed === null) {
        results.push({
          row: plan.row,
          count: 0,
          ...(plan.coupled ? { coupled: true } : {}),
          error: "listing unavailable; nothing deleted for this row",
        });
        continue;
      }
      const count = plan.count(listed);
      if (!confirm) {
        results.push({
          row: plan.row,
          count,
          ...(plan.coupled ? { coupled: true } : {}),
        });
        continue;
      }
      const keys = plan.keys(listed);
      for (const key of keys) {
        await plan.deleteKey(key);
      }
      const remaining = await plan.verify();
      if (remaining === null) {
        results.push({
          row: plan.row,
          count: 0,
          ...(plan.coupled ? { coupled: true } : {}),
          error: "verification listing unavailable; deleted count not claimed",
        });
        continue;
      }
      const deleted = count - plan.count(remaining);
      ctx.audit("maintenance.kv.cleared", "orchestrator", {
        row: plan.row,
        scope: "platform",
        deletedCount: deleted,
        actorLogin: caller.login,
        ...(plan.coupled ? { coupled: true } : {}),
      });
      results.push({
        row: plan.row,
        count: deleted,
        ...(plan.coupled ? { coupled: true } : {}),
      });
    }
    return Response.json({
      confirmed: confirm,
      ...(confirm ? {} : { confirmRequired: true }),
      rows: results,
    });
  } catch (err: any) {
    return Response.json(
      { error: err.message || "Failed to wipe KV rows" },
      { status: 500 },
    );
  }
}
