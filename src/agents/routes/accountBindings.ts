/**
 * Issue #5113 (Sub-issue 4 of #5094) — HTTP routes for `{ broker, mode, accountType, accountId }`
 * account bindings:
 *   GET    /broker/account-binding
 *   PUT    /broker/account-binding (also accepts POST)
 *   DELETE /broker/account-binding
 */
import type { Env } from "../../types";
import { ACCOUNT_BINDING_SCOPES, ACCOUNT_TYPES } from "../../config/accountBindings";
import {
  listAccountBindings,
  removeAccountBinding,
  upsertAccountBinding,
} from "../../services/accountBindings";
import { isAccountBindingBroker } from "../../trading";

export async function handleAccountBindingRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: { env: Env },
): Promise<Response | null> {
  if (!path.endsWith("/broker/account-binding")) {
    return null;
  }

  if (!sessionId || !sessionId.trim()) {
    return Response.json(
      { code: "FAILURE_AUTH_NO_SESSION", message: "Authentication required." },
      { status: 401 },
    );
  }

  const method = request.method.toUpperCase();

  if (method === "GET") {
    const bindings = await listAccountBindings(ctx.env, sessionId);
    const brokerFilter = url.searchParams.get("broker")?.trim().toLowerCase();
    const modeFilter = url.searchParams.get("mode")?.trim().toLowerCase();
    const typeFilter = url.searchParams.get("accountType")?.trim().toLowerCase();
    const filtered = bindings.filter((b) => {
      if (brokerFilter && b.broker !== brokerFilter) return false;
      if (modeFilter && b.mode !== modeFilter) return false;
      if (typeFilter && b.accountType !== typeFilter) return false;
      return true;
    });
    return Response.json({
      bindings: filtered,
      supportedAccountTypes: ACCOUNT_TYPES,
      supportedScopes: ACCOUNT_BINDING_SCOPES,
    });
  }

  if (method === "PUT" || method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return Response.json({ code: "invalid_request", message: "JSON body is required." }, { status: 400 });
    }
    const res = await upsertAccountBinding(ctx.env, sessionId, {
      broker: body.broker,
      mode: body.mode,
      accountType: body.accountType,
      scope: body.scope,
      accountId: body.accountId,
      accountName: body.accountName,
    });
    if (!res.ok) {
      return Response.json({ code: "invalid_request", message: res.error }, { status: 400 });
    }
    return Response.json({ ok: true, binding: res.binding });
  }

  if (method === "DELETE") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const broker = String(body.broker ?? url.searchParams.get("broker") ?? "").trim().toLowerCase();
    const mode = String(body.mode ?? url.searchParams.get("mode") ?? "").trim().toLowerCase();
    const accountType = String(body.accountType ?? url.searchParams.get("accountType") ?? "stock").trim().toLowerCase();
    const scope = String(body.scope ?? url.searchParams.get("scope") ?? "tenant").trim().toLowerCase();

    if (!isAccountBindingBroker(broker) || (mode !== "paper" && mode !== "live")) {
      return Response.json(
        { code: "invalid_request", message: "Valid broker and mode are required." },
        { status: 400 },
      );
    }

    const removed = await removeAccountBinding(ctx.env, sessionId, {
      broker,
      mode,
      accountType: accountType as (typeof ACCOUNT_TYPES)[number],
      scope: scope as (typeof ACCOUNT_BINDING_SCOPES)[number],
    });
    return Response.json({ ok: true, removed });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
