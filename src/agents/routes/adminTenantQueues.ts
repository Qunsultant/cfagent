/**
 * Cross-tenant queue routes (#2457).
 *
 * Owner ruling (2026-10-30): a platform admin manages ALL tenants. The
 * #2454 Queue tab covers the admin's own instance; these routes cover
 * every OTHER tenant's queues from the same panel surface (the tab UI
 * itself lands after #2454 merges — this module is the server side).
 *
 * Shape of the slice, and what it deliberately does NOT do:
 * - Gate: the #2331 slice-1 resolveCaller pattern exactly — the
 *   x-user-login header (set by the Worker from the verified session)
 *   resolves through the wired-login alias record to an internalUserId,
 *   which must hold a live platform-admin membership (isPlatformAdmin).
 *   Anything else answers 401/403 with no data. Tenant admins get 403
 *   on every route here: platform-admin-only, same as today.
 * - Mapping: tenant -> logins comes from tenantQueueMapping.ts
 *   (memberships for tenancy, alias + session records for logins).
 *   Zero resolved logins fails closed (409); partial mappings proceed
 *   on resolved logins only, with the unmapped members disclosed in
 *   every response and in the audit record. Nothing is guessed.
 * - Fan-out: the admin's instance forwards to each target instance's
 *   EXISTING own-instance routes (GET /schedules, POST
 *   /schedules/cancel-all, POST /maintenance/clear-table) via
 *   ORCHESTRATOR_AGENT stub fetch (#2516): the per-login instances live in
 *   the ORCHESTRATOR_AGENT namespace — the same addressing src/server.ts
 *   and the chat client use — and that is where the target handlers'
 *   state (schedules, maintenance tables) lives. Target handlers
 *   operate on instance-local state, so scope is the instance, not
 *   the header — the forward cannot leak scope across instances.
 * - Delegation headers (x-admin-actor, x-admin-tenant) are set ONLY
 *   by this module and annotate the target's audit payload; they
 *   never change scope or authorization. The target handlers read
 *   them for annotation only (see the schedules/maintenance notes).
 * - Preview (no confirm) cancels/deletes nothing and writes no
 *   audit event, the same contract as #2454/#2328. Confirm fans out
 *   per login, aggregates per-login results (a failing login never
 *   hides the others), and audits ONCE on the admin's instance with
 *   tenantId, adminLogin, per-login results, and unmappedMembers.
 * - Grants are untouched: this ruling covers management reach only.
 *   The #2331 slice-1 grant rule stands unchanged.
 * - No new client files, no tab changes: the Queue tab UI (picker +
 *   per-tenant actions) and its scope-copy correction land after
 *   #2454 merges, on top of these routes.
 */

import { isPlatformAdmin } from "../../security/iaaaAdminOverview";
import {
  createKvMembershipStore,
  listMembershipsFromEntries,
} from "../../security/iaaaMembershipStore";
import { listStoreEntries } from "../../data/durableKv";
import type { DoNamespaceLike } from "../../data/durableKv";
import {
  lookupInternalUserIdByLogin,
  lookupLoginByUserId,
} from "../../security/iaaaMigration";
import { sessionStore } from "../../security/session";
import { isLoginShaped } from "../../security/serviceIdentity";
import type { Membership, MembershipStore } from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import type { Env } from "../../types";
import {
  isTenantIdShaped,
  listTenantIds,
  resolveTenantLogins,
  tenantMemberIds,
} from "../../security/tenantQueueMapping";

export interface AdminTenantQueueContext {
  /** Worker env (carries the SESSION_STORE + ORCHESTRATOR_AGENT bindings). */
  env: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /** Test seam: use this KV instead of the SessionStore KV for aliases. */
  aliasKv?: KvLike;
  /** Test seam: use this store instead of the SessionStore KV store. */
  membershipStore?: MembershipStore;
  /** Test seam: membership-namespace listing entries. */
  listMembershipEntries?: () => Promise<Array<{ key: string; value: string }> | null>;
  /** Test seam: sessions-namespace listing entries. */
  listSessionEntries?: () => Promise<Array<{ key: string; value: string }> | null>;
  /** Test seam: per-login instance stub. */
  fetchInstance?: (login: string) => { fetch(req: Request): Promise<Response> };
}

interface Caller {
  login: string;
  internalUserId: string;
}

interface InstanceStub {
  fetch(req: Request): Promise<Response>;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function resolveCaller(
  request: Request,
  ctx: AdminTenantQueueContext,
): Promise<Caller | Response> {
  const login = request.headers.get("x-user-login") || "";
  if (!isLoginShaped(login)) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const kv = ctx.aliasKv ?? sessionStore(ctx.env);
  const internalUserId = await lookupInternalUserIdByLogin(kv, login);
  if (!internalUserId) {
    return jsonError(
      "Forbidden: tenant queue administration requires a wired session.",
      403,
    );
  }
  const store =
    ctx.membershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
  const memberships = await store.getMembershipsByUser(internalUserId);
  if (!isPlatformAdmin(memberships, Date.now())) {
    return jsonError(
      "Forbidden: tenant queue administration requires platform-admin membership.",
      403,
    );
  }
  return { login, internalUserId };
}

async function loadAllMemberships(
  ctx: AdminTenantQueueContext,
): Promise<Membership[] | null> {
  const entries = ctx.listMembershipEntries
    ? await ctx.listMembershipEntries()
    : await listStoreEntries({
        namespace: ctx.env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
        namespaceName: "sessions",
        prefix: "iaaa-membership:",
      });
  if (!entries) return null;
  return listMembershipsFromEntries(entries);
}

async function loadSessionEntries(
  ctx: AdminTenantQueueContext,
): Promise<Array<{ key: string; value: string }> | null> {
  if (ctx.listSessionEntries) return ctx.listSessionEntries();
  return listStoreEntries({
    namespace: ctx.env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "sessions",
    prefix: "",
  });
}

function instanceStub(
  ctx: AdminTenantQueueContext,
  login: string,
): InstanceStub | null {
  if (ctx.fetchInstance) return ctx.fetchInstance(login);
  const ns = (
    ctx.env as unknown as {
      ORCHESTRATOR_AGENT?: {
        idFromName(name: string): unknown;
        get(id: unknown): InstanceStub;
      };
    }
  ).ORCHESTRATOR_AGENT;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    return null;
  }
  return ns.get(ns.idFromName(login));
}

interface ForwardResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  error?: string;
}

async function forwardToInstance(
  stub: InstanceStub,
  targetPath: string,
  init: RequestInit,
  targetLogin: string,
  adminLogin: string,
  tenantId: string,
): Promise<ForwardResult> {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set("Content-Type", "application/json");
  headers.set("x-user-login", targetLogin);
  headers.set("x-admin-actor", adminLogin);
  headers.set("x-admin-tenant", tenantId);
  try {
    const res = await stub.fetch(
      new Request(new URL(targetPath, "https://agent.internal"), {
        ...init,
        headers,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {},
      error: err instanceof Error ? err.message : "instance unreachable",
    };
  }
}

function toScheduleView(schedules: unknown): Array<{ id: string; callback: string }> {
  if (!Array.isArray(schedules)) return [];
  const out: Array<{ id: string; callback: string }> = [];
  for (const item of schedules) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { callback?: unknown }).callback === "string"
    ) {
      out.push({
        id: (item as { id: string }).id,
        callback: (item as { callback: string }).callback,
      });
    }
  }
  return out;
}

export async function handleAdminTenantQueueRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AdminTenantQueueContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  let action: "list" | "resolve" | "dump" | "cancel-all" | "clear-table" | null = null;
  if (path.endsWith("/admin/tenants")) {
    action = "list";
  } else if (path.endsWith("/queues/resolve")) {
    action = "resolve";
  } else if (path.endsWith("/queues/dump")) {
    action = "dump";
  } else if (path.endsWith("/queues/cancel-all")) {
    action = "cancel-all";
  } else if (path.endsWith("/queues/clear-table")) {
    action = "clear-table";
  } else {
    return null;
  }
  if (action === "list" && request.method !== "GET") {
    return jsonError("Method not allowed", 405);
  }
  if (action !== "list" && request.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }
  try {
    const caller = await resolveCaller(request, ctx);
    if (caller instanceof Response) return caller;
    if (action === "list") {
      const memberships = await loadAllMemberships(ctx);
      if (memberships === null) {
        return jsonError("Tenant listing unavailable.", 500);
      }
      const tenants = listTenantIds(memberships).map((tenantId) => ({
        tenantId,
        memberCount: tenantMemberIds(memberships, tenantId).length,
      }));
      return Response.json({ tenants });
    }
    const tenantMatch = path.match(
      /\/admin\/tenants\/([^/]+)\/queues\/(resolve|dump|cancel-all|clear-table)$/,
    );
    if (!tenantMatch) return null;
    let tenantId: string;
    try {
      tenantId = decodeURIComponent(tenantMatch[1]);
    } catch {
      return jsonError("Malformed tenant id.", 400);
    }
    if (!isTenantIdShaped(tenantId)) {
      return jsonError("Malformed tenant id.", 400);
    }
    const memberships = await loadAllMemberships(ctx);
    if (memberships === null) {
      return jsonError("Tenant queue administration unavailable.", 500);
    }
    const sessionEntries = await loadSessionEntries(ctx);
    if (sessionEntries === null) {
      return jsonError("Tenant queue administration unavailable.", 500);
    }
    const kv = ctx.aliasKv ?? sessionStore(ctx.env);
    const resolution = await resolveTenantLogins({
      memberships,
      tenantId,
      lookupLogin: (id) => lookupLoginByUserId(kv, id),
      sessionEntries,
    });
    if (action === "resolve") {
      if (resolution.zeroResolved) {
        return Response.json(
          {
            ...resolution,
            error:
              "No tenant member resolves to a login instance: nothing to act on. " +
              "Members without an alias record or a live session record are listed as unmapped.",
          },
          { status: 409 },
        );
      }
      return Response.json(resolution);
    }
    if (resolution.zeroResolved) {
      return Response.json(
        {
          ...resolution,
          error:
            "No tenant member resolves to a login instance: nothing to act on. " +
            "Members without an alias record or a live session record are listed as unmapped.",
        },
        { status: 409 },
      );
    }
    if (action === "dump") {
      const perLogin: Array<Record<string, unknown>> = [];
      for (const login of resolution.resolvedLogins) {
        const stub = instanceStub(ctx, login);
        if (!stub) {
          perLogin.push({ login, error: "instance unavailable" });
          continue;
        }
        const forwarded = await forwardToInstance(
          stub,
          "/schedules",
          { method: "GET" },
          login,
          caller.login,
          tenantId,
        );
        if (!forwarded.ok) {
          perLogin.push({
            login,
            error:
              forwarded.error ??
              (typeof forwarded.body.error === "string"
                ? forwarded.body.error
                : `instance answered ${forwarded.status}`),
          });
          continue;
        }
        perLogin.push({
          login,
          schedules: toScheduleView(forwarded.body.schedules),
        });
      }
      return Response.json({
        tenantId,
        perLogin,
        unmappedMembers: resolution.unmappedMembers,
      });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const confirm = body.confirm === true;
    if (action === "cancel-all") {
      const perLogin: Array<Record<string, unknown>> = [];
      for (const login of resolution.resolvedLogins) {
        const stub = instanceStub(ctx, login);
        if (!stub) {
          perLogin.push({ login, error: "instance unavailable" });
          continue;
        }
        const forwarded = await forwardToInstance(
          stub,
          "/schedules/cancel-all",
          {
            method: "POST",
            body: JSON.stringify(confirm ? { confirm: true } : {}),
          },
          login,
          caller.login,
          tenantId,
        );
        if (!forwarded.ok) {
          perLogin.push({
            login,
            error:
              forwarded.error ??
              (typeof forwarded.body.error === "string"
                ? forwarded.body.error
                : `instance answered ${forwarded.status}`),
          });
          continue;
        }
        perLogin.push({ login, ...forwarded.body });
      }
      if (!confirm) {
        return Response.json({
          tenantId,
          confirmRequired: true,
          perLogin,
          unmappedMembers: resolution.unmappedMembers,
        });
      }
      ctx.audit("admin.tenant.queues.cancelled.all", "orchestrator", {
        tenantId,
        adminLogin: caller.login,
        perLogin,
        unmappedMembers: resolution.unmappedMembers,
      });
      return Response.json({
        tenantId,
        perLogin,
        unmappedMembers: resolution.unmappedMembers,
      });
    }
    // clear-table
    const table = body.table;
    if (typeof table !== "string" || table === "") {
      return jsonError("table is required.", 400);
    }
    const perLogin: Array<Record<string, unknown>> = [];
    for (const login of resolution.resolvedLogins) {
      const stub = instanceStub(ctx, login);
      if (!stub) {
        perLogin.push({ login, error: "instance unavailable" });
        continue;
      }
      const forwarded = await forwardToInstance(
        stub,
        "/maintenance/clear-table",
        {
          method: "POST",
          body: JSON.stringify(
            confirm ? { table, confirm: true } : { table },
          ),
        },
        login,
        caller.login,
        tenantId,
      );
      if (!forwarded.ok) {
        perLogin.push({
          login,
          error:
            forwarded.error ??
            (typeof forwarded.body.error === "string"
              ? forwarded.body.error
              : `instance answered ${forwarded.status}`),
        });
        continue;
      }
      perLogin.push({ login, ...forwarded.body });
    }
    if (!confirm) {
      return Response.json({
        tenantId,
        table,
        confirmRequired: true,
        perLogin,
        unmappedMembers: resolution.unmappedMembers,
      });
    }
    ctx.audit("admin.tenant.queues.table.cleared", "orchestrator", {
      tenantId,
      adminLogin: caller.login,
      table,
      perLogin,
      unmappedMembers: resolution.unmappedMembers,
    });
    return Response.json({
      tenantId,
      table,
      perLogin,
      unmappedMembers: resolution.unmappedMembers,
    });
  } catch {
    return jsonError("Tenant queue administration unavailable.", 500);
  }
}
