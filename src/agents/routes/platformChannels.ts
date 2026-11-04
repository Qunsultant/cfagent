/**
 * Issue #3169 (program #2218) — tenant delivery-channel
 * administration routes, extracted-style sibling of
 * routes/platformTenants.ts — invoked from
 * OrchestratorAgent.routeRequest in the sequential
 * path.endsWith sequence (immediately after the account-admin
 * handler, before premium — there is no central route table).
 * Returns a Response on match, null when no channel-admin path
 * matches.
 *
 *   GET    /platform-channels/:id              channel config for a tenant (defaults when no row)
 *   PATCH  /platform-channels/:id/channels     update channel flags (partial, booleans only)
 *
 * (Paths are the DO-internal spellings: src/server.ts strips the
 * /api prefix when forwarding, so externally these are
 * /api/platform-channels*.)
 *
 * SCOPE — READ THIS BEFORE EXTENDING:
 * - Session-scoped ALWAYS: the operator login comes from the
 *   x-user-login header, which server.ts sets from the verified
 *   session (401 without a session). A tenant id in a path
 *   names the operator's ADMINISTRATION target, never the
 *   caller's scope: an operator administers ALL tenants (the
 *   #2457 owner ruling), and nothing here trusts a caller claim
 *   to BE that tenant.
 * - Gate: effective operators = env COMMERCIAL_STORE_OPERATORS
 *   UNION the store list (#2680, empty = deny all), the same
 *   idiom the commercial price routes and the tenant slice use.
 *   A missing login is 401, a non-operator is 403, an unbound
 *   store is 503.
 * - Known tenants only: the tenant id must appear in the tenant
 *   directory (account + settings rows, the #2221 authority);
 *   an unknown tenant is 404, never an invented config row.
 * - Enablement flags ONLY: PATCH accepts booleans for the five
 *   known channels and nothing else. A webhook URL, token, or
 *   secret in a patch is rejected (unknown-field 400 for an
 *   unknown channel id; the shape carries no secret field at
 *   all). Secrets stay in worker bindings.
 * - Defaults are all-enabled: GET for a tenant with no channel
 *   row returns the port defaults and creates nothing, so a
 *   tenant never configured behaves exactly as before.
 * - Audit funnel: operator writes are audit-annotated
 *   best-effort when the caller supplies a funnel (an audit
 *   failure never fails the write), the same posture as the
 *   tenant slice; the orchestrator dispatch supplies no funnel
 *   today, so this annotation is a follow-up, not a control —
 *   the gate above is the control.
 */
import { createTenantChannelAdapter } from "../../data/createTenantChannelPorts";
import type { TenantChannelStore } from "../../data/tenantChannelPorts";
import {
  TENANT_CHANNEL_IDS,
  type TenantChannelConfig,
  type TenantChannelId,
  type TenantChannelPatch,
} from "../../data/tenantChannelPorts";
import { createTenantDirectoryAdapter } from "../../data/createTenantDirectoryPorts";
import type { TenantDirectory } from "../../data/tenantDirectoryPorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";

export interface PlatformChannelRouteContext {
  /** Worker env (carries the AGENT_DB + COMMERCIAL_STORE_OPERATORS bindings). */
  env: { AGENT_DB?: unknown };
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
  /** Test seam: use this store instead of the AGENT_DB adapter. */
  channels?: TenantChannelStore | null;
  /** Test seam: use this directory instead of the AGENT_DB adapter. */
  directory?: TenantDirectory | null;
  /** Test seam: use this operator list instead of the AGENT_DB adapter. */
  operators?: Pick<StoreOperators, "listOperators"> | null;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** Same shape rule as isTenantIdShaped (tenantQueueMapping): non-empty, <=512, no whitespace/control. */
function isTenantIdShaped(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512 &&
    !/[\s\x00-\x1F\x7F]/.test(value.trim())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvOperators(env: { AGENT_DB?: unknown }): Set<string> {
  const raw = (env as unknown as Record<string, unknown>)["COMMERCIAL_STORE_OPERATORS"];
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Resolve the verified operator login, or an error Response. */
async function resolveOperator(
  request: Request,
  ctx: PlatformChannelRouteContext,
): Promise<string | Response> {
  const login = request.headers.get("x-user-login")?.trim() ?? "";
  if (!login) {
    return jsonError("Unauthorized: a signed-in session is required.", 401);
  }
  const effective = parseEnvOperators(ctx.env);
  const adapter = ctx.operators ?? createStoreOperatorsAdapter(ctx.env);
  if (adapter) {
    try {
      for (const entry of await adapter.listOperators()) effective.add(entry.login);
    } catch {
      // Store-list failure degrades to env-only, exactly as the
      // commercial price routes behave — never a lockout, never
      // a silent widening (the operator check below still applies).
    }
  }
  if (!effective.has(login)) {
    return jsonError("Forbidden: channel administration requires a store operator.", 403);
  }
  return login;
}

function auditBestEffort(
  ctx: PlatformChannelRouteContext,
  login: string,
  action: string,
  tenantId: string,
): void {
  try {
    ctx.audit?.("platform-channel-admin", "orchestrator", { actorLogin: login, action, tenantId });
  } catch {
    // Best-effort annotation only; see the module header.
  }
}

export async function handlePlatformChannelRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PlatformChannelRouteContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  if (!path.includes("/platform-channels/")) return null;
  const rest = path.split("/platform-channels/")[1] ?? "";
  const segments = rest.split("/");
  let action: "read" | "patch" | null = null;
  let tenantId = "";
  if (segments.length === 1 && segments[0]) {
    tenantId = decodeURIComponent(segments[0]);
    action = "read";
  } else if (segments.length === 2 && segments[0] && segments[1] === "channels") {
    tenantId = decodeURIComponent(segments[0]);
    action = "patch";
  } else {
    return null;
  }

  const operator = await resolveOperator(request, ctx);
  if (operator instanceof Response) return operator;
  const channels = ctx.channels ?? createTenantChannelAdapter(ctx.env);
  const directory = ctx.directory ?? createTenantDirectoryAdapter(ctx.env);
  if (!channels || !directory) {
    return jsonError("Channel administration unavailable: AGENT_DB is not bound.", 503);
  }

  try {
    if (!isTenantIdShaped(tenantId)) return jsonError("Unknown tenant.", 404);
    const known = await directory.listTenantIds();
    if (!known.includes(tenantId)) return jsonError("Unknown tenant.", 404);

    if (action === "read") {
      if (request.method !== "GET") return jsonError("Method not allowed", 405);
      const config = await channels.getTenantChannels(tenantId);
      return Response.json({ tenantId, channels: config });
    }

    // action === "patch"
    if (request.method !== "PATCH") return jsonError("Method not allowed", 405);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const supplied = body["channels"];
    if (!isRecord(supplied)) {
      return jsonError("channels must be an object of channel flags.", 400);
    }
    const patch: TenantChannelPatch = {};
    for (const [key, value] of Object.entries(supplied)) {
      if (!(TENANT_CHANNEL_IDS as readonly string[]).includes(key)) {
        return jsonError(`Unknown channel: ${key}.`, 400);
      }
      if (typeof value !== "boolean") {
        return jsonError(`Channel flag ${key} must be a boolean.`, 400);
      }
      patch[key as TenantChannelId] = value;
    }
    if (Object.keys(patch).length === 0) {
      return jsonError("No channel flag supplied.", 400);
    }
    const config: TenantChannelConfig = await channels.setTenantChannels(tenantId, patch);
    auditBestEffort(ctx, operator, "update-channels", tenantId);
    return Response.json({ tenantId, channels: config });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Channel administration failed.", 500);
  }
}
