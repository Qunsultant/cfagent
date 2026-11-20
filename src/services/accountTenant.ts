/**
 * Issue #3185 (stamp slice) — the usage_events tenant stamp's
 * ONE authority: the ACCOUNT tenant, `getAccount(login).tenantId`
 * from D1 agent_commercial_accounts.
 *
 * The codebase holds three tenant authorities that can disagree
 * (commercial account; IAAA memberships — one login can hold
 * many; the env default IAAA_TENANT_ID / "primary"), and
 * resolveCurrentTenant (platformIdentity.ts) orders them account
 * > earliest membership > null. The meter stamp pins the FIRST
 * authority only: the account row is the billing tenant, and a
 * login with no account row stamps NULL — never a membership
 * tenant (ambiguous for multi-membership logins), never the env
 * default, never a synthetic `login:<login>` fallback. NULL
 * means unattributed, per the #3182 rule.
 *
 * Best-effort by design: an unbound store, a missing row, or a
 * store read failure all resolve to null, and metering must
 * never break the metered operation over attribution. Callers
 * on fail-closed money paths keep their own direction; this
 * helper only answers "which account tenant, if any".
 */
import { createCommercialAdapter } from "../data/createCommercialPorts";

export async function resolveAccountTenantId(
  env: { AGENT_DB?: unknown } | undefined | null,
  login: string,
): Promise<string | null> {
  try {
    if (!env || !login) return null;
    const store = createCommercialAdapter(env);
    if (!store) return null;
    const account = await store.getAccount(login);
    const tenantId = account?.tenantId;
    return typeof tenantId === "string" && tenantId.trim().length > 0
      ? tenantId.trim()
      : null;
  } catch {
    return null;
  }
}
