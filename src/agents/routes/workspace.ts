/**
 * Issue #3896 — Authenticated Workspace File Routes (`/api/workspace/files` & `/api/workspace/file`).
 *
 * Thin route adapter delegating directly to the PortThink workspace port
 * (`createCfActorWorkspace` + `handlePortWorkspaceRequest` in
 * `src/actors/thinkAdapter.ts` and `src/actors/thinkPortMapping.ts`), so
 * workspace storage and HTTP semantics live once in the PortThink adapter
 * layer and are shared by every agent that extends `PortThink`.
 */

import type { SqlStorage } from "../../orm";
import { createCfActorWorkspace, type WorkspaceHostEntryLike, type WorkspaceHostLike } from "../../actors/cfAgentsAdapter";
import { handlePortWorkspaceRequest } from "../../actors/thinkAdapter";
import { resolveThinkWorkspacePath, thinkWorkspaceEndpointFromPath } from "../../actors/thinkPortMapping";
import type { ActorWorkspaceFileEntry } from "../../actors/actorPorts";

export type WorkspaceHostEntry = WorkspaceHostEntryLike;
export type WorkspaceRouteHost = WorkspaceHostLike;
export type WorkspaceFileMetadata = ActorWorkspaceFileEntry;

export interface WorkspaceRouteContext {
  sql: SqlStorage;
  getScreenerExecutionContext: () => Promise<{ userLogin?: string } | undefined>;
  hostWorkspace?: WorkspaceRouteHost;
  audit?: (type: string, agent: "orchestrator", payload: Record<string, unknown>) => void;
}

export const resolveCanonicalWorkspacePath = resolveThinkWorkspacePath;

export async function handleWorkspaceRoutes(
  request: Request,
  _url: URL,
  path: string,
  _sessionId: string,
  ctx: WorkspaceRouteContext,
): Promise<Response | null> {
  const endpoint = thinkWorkspaceEndpointFromPath(path);
  if (!endpoint) {
    return null;
  }

  const executionContext = await ctx.getScreenerExecutionContext().catch(() => undefined);
  const userLogin = executionContext?.userLogin;
  if (!userLogin) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const workspacePort = createCfActorWorkspace({ sql: ctx.sql }, ctx.hostWorkspace);
  return handlePortWorkspaceRequest(request, endpoint, workspacePort, {
    scopeId: userLogin,
    audit: ctx.audit ? (type, payload) => ctx.audit!(type, "orchestrator", payload) : undefined,
  });
}
