/**
 * Issue #5169 (observability program #5080) — the R2 archive
 * HTTP routes: GET /api/otel/v1/archive (list) and
 * GET /api/otel/v1/archive/object (serve one object, `?key=`).
 *
 * The read surface for the interim file browser. Gating
 * follows the IAAA admin pattern exactly (requireAuth → live
 * platform-admin membership, fail-closed): an unauthenticated
 * caller reads 401, a signed-in non-admin reads 403 with a
 * coded OBS-1011 message and a deny audit record. An allowed
 * read is audited BEFORE it is served (audit-before-allow);
 * when the audit write itself fails the route fails closed
 * with 500 — the read is never served unaudited. A deny audit
 * is best-effort (the core.ts service-token precedent): the
 * deny stands even when the audit store is down.
 *
 * The audit records the AUTHORIZATION decision (the admin gate
 * passed); a read that then fails (bad key, missing object,
 * unbound R2) surfaces through its own coded HTTP error.
 * The R2 destination switch governs the LIST only: when it is
 * OFF the list reports archivingEnabled false with no objects
 * (the view states it plainly); serving an existing object by
 * key still works, because the switch is a WRITE switch — a
 * read of an object that already exists is not a write.
 *
 * The handler takes injectable deps (the telemetry-route
 * pattern): tests pass fakes, production wires the real auth,
 * admin, audit, blob-store, and config resolution.
 */

import type { Env, SessionData } from "../../types";
import { requireAuth } from "../auth";
import { sessionStore, wiredMembershipStore } from "../../security/session";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import { buildAdminOverview } from "../../security/iaaaAdminOverview";
import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
  type CreateIaaaAuditEventInput,
} from "../../security/iaaaAudit";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { createBlobStore } from "../../services/blobStoreR2Adapter";
import type { BlobStore } from "../../services/blobStorePorts";
import {
  OTEL_FILE_CONFIG,
  resolveOtelArchiveSettings,
  resolveOtelDestinationEnabled,
  type OtelScopeLevels,
} from "../../config/otelModes";
import {
  cachedOtelRuntimeOverrides,
  otelConfigD1FromEnv,
  otelRuntimeLevelByEnvName,
  refreshOtelRuntimeOverrideCache,
} from "../../config/otelConfigPort";
import {
  OTEL_ARCHIVE_LIST_ROUTE,
  OTEL_ARCHIVE_OBJECT_ROUTE,
  listOtelArchive,
  serveOtelArchiveObject,
} from "../../observability/otelArchive";

export { OTEL_ARCHIVE_LIST_ROUTE, OTEL_ARCHIVE_OBJECT_ROUTE };
import {
  OBS_ARCHIVE_FORBIDDEN,
  OBS_ARCHIVE_UNAVAILABLE,
  formatCatalogMessage,
} from "../../observability/otelMessages";

/** The audit event type for archive reads. */
export const OTEL_ARCHIVE_AUDIT_TYPE = "observability.archive" as const;

/** The archive state the routes resolve from env + config file. */
export interface OtelArchiveRouteState {
  archivingEnabled: boolean;
  pageSize: number;
  maxObjects: number;
}

export interface OtelArchiveRouteDeps {
  requireSession: (request: Request, env: Env) => Promise<SessionData | null>;
  isPlatformAdmin: (session: SessionData, env: Env) => Promise<boolean>;
  audit: (env: Env, input: CreateIaaaAuditEventInput) => Promise<boolean>;
  blobStore: (env: Env) => BlobStore | null;
  resolveState: (env: Env) => OtelArchiveRouteState;
}

function defaultResolveState(env: Env): OtelArchiveRouteState {
  const envRecord = env as unknown as Record<string, unknown>;
  const levelsFor = (envName: string, fileValue: unknown): OtelScopeLevels => ({
    // S7 (#5086): the runtime level from the override cache
    // (refreshed per request by the handler below).
    runtime: otelRuntimeLevelByEnvName(cachedOtelRuntimeOverrides(), envName),
    env: envRecord[envName],
    file: fileValue,
  });
  const archivingEnabled = resolveOtelDestinationEnabled(
    "r2",
    levelsFor("OTEL_DESTINATION_R2_ENABLED", OTEL_FILE_CONFIG.destinations.r2),
  ).enabled;
  const settings = resolveOtelArchiveSettings({
    pageSize: levelsFor("OTEL_ARCHIVE_PAGE_SIZE", OTEL_FILE_CONFIG.archive?.pageSize),
    maxObjects: levelsFor("OTEL_ARCHIVE_MAX_OBJECTS", OTEL_FILE_CONFIG.archive?.maxObjects),
  }).settings;
  return {
    archivingEnabled,
    pageSize: settings.pageSize,
    maxObjects: settings.maxObjects,
  };
}

/** Shared with the OTel config routes (S7, #5086): the live platform-admin membership check (the IAAA admin pattern). */
export async function defaultIsPlatformAdmin(session: SessionData, env: Env): Promise<boolean> {
  if (!session.internalUserId) return false;
  const overview = await buildAdminOverview(
    {
      membershipStore: wiredMembershipStore(env),
      auditStore: createWiredAuditStore(env),
      kv: sessionStore(env),
      tenantId: resolveIaaaTenant(env),
      nowMs: Date.now(),
    },
    { callerInternalUserId: session.internalUserId },
  );
  return overview.allowed;
}

/** Shared with the OTel config routes (S7, #5086): the canonical audit writer. */
export async function defaultAudit(env: Env, input: CreateIaaaAuditEventInput): Promise<boolean> {
  try {
    const result = await recordAuditEvent(createWiredAuditStore(env), input);
    return result.ok;
  } catch {
    return false;
  }
}

const defaultOtelArchiveRouteDeps: OtelArchiveRouteDeps = {
  requireSession: requireAuth,
  isPlatformAdmin: defaultIsPlatformAdmin,
  audit: defaultAudit,
  blobStore: createBlobStore,
  resolveState: defaultResolveState,
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The OTel archive route handler (the server.ts dispatch shape:
 * returns a Response when the path matches, null to fall through
 * to the next handler). GET only; list + serve under
 * /api/otel/v1/archive.
 */
export async function handleOtelArchiveRoutes(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  deps: OtelArchiveRouteDeps = defaultOtelArchiveRouteDeps,
): Promise<Response | null> {
  if (path !== OTEL_ARCHIVE_LIST_ROUTE && path !== OTEL_ARCHIVE_OBJECT_ROUTE) return null;

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  const session = await deps.requireSession(request, env);
  if (!session) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const action =
    path === OTEL_ARCHIVE_LIST_ROUTE
      ? "observability.archive.list"
      : "observability.archive.serve";
  const resourceId =
    path === OTEL_ARCHIVE_OBJECT_ROUTE
      ? (url.searchParams.get("key") ?? undefined)
      : undefined;
  const auditBase = {
    timestamp: Date.now(),
    type: OTEL_ARCHIVE_AUDIT_TYPE,
    actorPrincipalId: session.internalUserId ?? session.githubLogin ?? "unknown",
    actorType: "human" as const,
    initiatingPrincipalId: session.internalUserId ?? session.githubLogin ?? "unknown",
    tenantId: resolveIaaaTenant(env),
    correlationId: crypto.randomUUID(),
    action,
    ...(resourceId ? { resourceId } : {}),
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
  };

  let admin: boolean;
  try {
    admin = await deps.isPlatformAdmin(session, env);
  } catch {
    const error = formatCatalogMessage(OBS_ARCHIVE_UNAVAILABLE, { reason: "the platform-admin check failed" });
    return jsonResponse(500, { error, code: OBS_ARCHIVE_UNAVAILABLE });
  }
  if (!admin) {
    try {
      await deps.audit(env, {
        ...auditBase,
        decision: "deny" as const,
        outcome: "failed" as const,
        errorCode: "OTEL_ARCHIVE_FORBIDDEN",
      });
    } catch {
      /* denial attribution is best-effort; the deny stands */
    }
    const error = formatCatalogMessage(OBS_ARCHIVE_FORBIDDEN);
    return jsonResponse(403, { error, code: OBS_ARCHIVE_FORBIDDEN });
  }

  // Audit-before-allow: the read is served only when its audit
  // record lands; an audit failure fails closed with 500.
  const audited = await deps
    .audit(env, { ...auditBase, decision: "allow" as const, outcome: "succeeded" as const })
    .catch(() => false);
  if (!audited) {
    const error = formatCatalogMessage(OBS_ARCHIVE_UNAVAILABLE, { reason: "the audit record could not be written" });
    return jsonResponse(500, { error, code: OBS_ARCHIVE_UNAVAILABLE });
  }

  if (path === OTEL_ARCHIVE_LIST_ROUTE) {
    // S7 (#5086): refresh the runtime override cache (TTL-guarded)
    // so a pageSize/maxObjects flip applies to this request.
    await refreshOtelRuntimeOverrideCache(otelConfigD1FromEnv(env));
    const state = deps.resolveState(env);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    const result = await listOtelArchive({
      blobStore: deps.blobStore(env),
      archivingEnabled: state.archivingEnabled,
      pageSize: state.pageSize,
      maxObjects: state.maxObjects,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    });
    if (result.status !== 200) {
      return jsonResponse(result.status, { error: result.error, code: result.code });
    }
    return jsonResponse(200, {
      archivingEnabled: result.archivingEnabled,
      objects: result.objects,
      truncated: result.truncated,
      ...(result.cursor ? { cursor: result.cursor } : {}),
      pageSize: result.pageSize,
      maxObjects: result.maxObjects,
    });
  }

  const key = url.searchParams.get("key") ?? "";
  const result = await serveOtelArchiveObject({ blobStore: deps.blobStore(env), key });
  if (result.status !== 200 || !result.content) {
    return jsonResponse(result.status, { error: result.error, code: result.code });
  }
  const filename = key.split("/").pop() ?? "archive.jsonl";
  return new Response(result.content as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": result.contentType ?? "application/x-ndjson",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
