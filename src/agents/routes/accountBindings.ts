/**
 * Issue #5113 & #5097 (Sub-issues of #5094) — HTTP routes for `{ broker, mode, accountType, accountId }`
 * account bindings and the runtime-configurable broker / asset-type / account-type registry:
 *   GET    /broker/account-binding
 *   PUT    /broker/account-binding (also accepts POST, including `registryPatch`)
 *   DELETE /broker/account-binding
 */
import type { Env } from "../../types";
import { ACCOUNT_BINDING_SCOPES } from "../../config/accountBindings";
import {
  getBrokerAssetAccountRegistry,
  listAccountBindings,
  migrateAccountBindingsToLogin,
  migrateTenantAccountBinding,
  removeAccountBinding,
  updateBrokerAssetAccountRegistry,
  upsertAccountBinding,
  validateAndUpsertAccountBinding,
} from "../../services/accountBindings";
import {
  isAccountBindingBroker,
  validateAccountAgainstBroker,
  type BrokerAccountRecordLike,
  type BrokerAssetAccountRegistryPatch,
} from "../../trading";

export async function handleAccountBindingRoutes(
  request: Request,
  url: URL,
  path: string,
  userLogin: string,
  ctx: { env: Env; legacySessionId?: string },
): Promise<Response | null> {
  if (!path.endsWith("/broker/account-binding")) {
    return null;
  }

  if (!userLogin || !userLogin.trim()) {
    return Response.json(
      { code: "FAILURE_AUTH_NO_SESSION", message: "Authentication required." },
      { status: 401 },
    );
  }

  // Issue #6257 — bindings saved before the login-keying fix live under the
  // DO instance id; copy them to the login key on first access so already-saved
  // bindings keep working with no manual re-save. Idempotent; a no-op when
  // the caller passed no legacy identity or it already equals the login.
  if (
    ctx.legacySessionId &&
    ctx.legacySessionId.trim().toLowerCase() !== userLogin.trim().toLowerCase()
  ) {
    await migrateAccountBindingsToLogin(ctx.env, ctx.legacySessionId, userLogin);
  }

  const method = request.method.toUpperCase();

  if (method === "GET") {
    const [bindings, registry] = await Promise.all([
      listAccountBindings(ctx.env, userLogin),
      getBrokerAssetAccountRegistry(ctx.env, userLogin),
    ]);
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
      registry,
      supportedAccountTypes: registry.accountTypes,
      supportedAssetTypes: registry.assetTypes,
      supportedBrokers: registry.brokers,
      supportedScopes: ACCOUNT_BINDING_SCOPES,
    });
  }

  if (method === "PUT" || method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return Response.json({ code: "invalid_request", message: "JSON body is required." }, { status: 400 });
    }
    if (body.registryPatch && typeof body.registryPatch === "object") {
      const regRes = await updateBrokerAssetAccountRegistry(
        ctx.env,
        userLogin,
        body.registryPatch as BrokerAssetAccountRegistryPatch,
      );
      if (!regRes.ok) {
        return Response.json({ code: "invalid_request", message: regRes.error }, { status: 400 });
      }
      return Response.json({ ok: true, registry: regRes.registry });
    }
    if (body.action === "validate") {
      const registry = await getBrokerAssetAccountRegistry(ctx.env, userLogin);
      const valRes = validateAccountAgainstBroker({
        broker: body.broker,
        mode: body.mode,
        accountType: body.accountType,
        scope: body.scope,
        accountId: body.accountId,
        accountName: body.accountName,
        availableAccounts: (Array.isArray(body.availableAccounts) ? body.availableAccounts : []) as BrokerAccountRecordLike[],
        registry,
        updatedBy: userLogin,
      });
      if (!valRes.ok) {
        const status =
          valRes.code === "FAILURE_ACCOUNT_UNKNOWN"
            ? 404
            : valRes.code === "FAILURE_ACCOUNT_UNOWNED"
              ? 403
              : valRes.code === "FAILURE_ACCOUNT_BROKER_MISMATCH"
                ? 409
                : 400;
        return Response.json({ ok: false, code: valRes.code, error: valRes.error }, { status });
      }
      return Response.json({
        ok: true,
        tuple: valRes.tuple,
        binding: valRes.binding,
        account: valRes.account,
      });
    }

    if (body.action === "migrate") {
      const migRes = await migrateTenantAccountBinding(ctx.env, userLogin, {
        broker: body.broker,
        mode: body.mode,
        targetAccountType: body.accountType ?? body.targetAccountType,
        scope: body.scope,
        availableAccounts: (Array.isArray(body.availableAccounts) ? body.availableAccounts : []) as BrokerAccountRecordLike[],
      });
      if (!migRes.ok) {
        const status =
          migRes.code === "FAILURE_ACCOUNT_UNKNOWN"
            ? 404
            : migRes.code === "FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS"
              ? 409
              : 400;
        return Response.json(
          {
            ok: false,
            code: migRes.code,
            error: migRes.error,
            ...(migRes.candidateAccountIds ? { candidateAccountIds: migRes.candidateAccountIds } : {}),
          },
          { status },
        );
      }
      return Response.json({
        ok: true,
        migrated: true,
        tuple: migRes.tuple,
        binding: migRes.binding,
        account: migRes.account,
      });
    }

    if (Array.isArray(body.availableAccounts)) {
      const res = await validateAndUpsertAccountBinding(ctx.env, userLogin, {
        broker: body.broker,
        mode: body.mode,
        accountType: body.accountType,
        scope: body.scope,
        accountId: body.accountId,
        accountName: body.accountName,
        availableAccounts: body.availableAccounts as BrokerAccountRecordLike[],
      });
      if (!res.ok) {
        const status =
          res.code === "FAILURE_ACCOUNT_UNKNOWN"
            ? 404
            : res.code === "FAILURE_ACCOUNT_UNOWNED"
              ? 403
              : res.code === "FAILURE_ACCOUNT_BROKER_MISMATCH"
                ? 409
                : 400;
        return Response.json({ ok: false, code: res.code, error: res.error }, { status });
      }
      return Response.json({ ok: true, binding: res.binding, tuple: res.tuple });
    }

    const res = await upsertAccountBinding(ctx.env, userLogin, {
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
    const registry = await getBrokerAssetAccountRegistry(ctx.env, userLogin);

    if (!isAccountBindingBroker(broker, registry) || (mode !== "paper" && mode !== "live")) {
      return Response.json(
        { code: "invalid_request", message: "Valid broker and mode are required." },
        { status: 400 },
      );
    }

    const removed = await removeAccountBinding(ctx.env, userLogin, {
      broker,
      mode,
      accountType,
      scope: scope as (typeof ACCOUNT_BINDING_SCOPES)[number],
    });
    return Response.json({ ok: true, removed });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
