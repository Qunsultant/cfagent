/**
 * SessionStore-backed persistence seam for `{ broker, mode, accountType, accountId }`
 * bindings (issues #5094, #5110).
 *
 * All reads/writes go through the SessionStore Durable Object (`account_bindings`
 * namespace) so tenant UX, chat, copilots, autopilot, and schedules share one
 * source of truth.
 */
import type { Env } from "../types";
import { ACCOUNT_BINDING_CONFIG } from "../config/accountBindings";
import { createStoreKv, type DoNamespaceLike } from "../data/durableKv";
import {
  accountBindingSlotId,
  isAccountBindingBroker,
  normalizeAccountBindingScope,
  normalizeAccountType,
  resolveEffectiveAccountBinding,
  validateAccountBindingInput,
  type AccountBinding,
  type AccountBindingBroker,
  type AccountBindingKey,
  type AccountBindingResolution,
  type AccountBindingScope,
  type AccountType,
  type TradingType,
} from "../trading";

function getBindingKv(env: Env) {
  const ns = (env as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE;
  if (!ns) return null;
  return createStoreKv({
    namespace: ns,
    namespaceName: "account_bindings",
    legacyFallback: false,
  });
}

function userBindingsKey(userLogin: string): string {
  return `${ACCOUNT_BINDING_CONFIG.keyPrefix}${userLogin.trim().toLowerCase()}`;
}

export async function listAccountBindings(env: Env, userLogin: string): Promise<AccountBinding[]> {
  const kv = getBindingKv(env);
  if (!kv || !userLogin.trim()) return [];
  const raw = await kv.get(userBindingsKey(userLogin));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as AccountBinding[]) : [];
  } catch {
    return [];
  }
}

export async function resolveUserAccountBinding(
  env: Env,
  userLogin: string,
  query: AccountBindingKey,
): Promise<AccountBindingResolution> {
  const bindings = await listAccountBindings(env, userLogin);
  return resolveEffectiveAccountBinding(bindings, query);
}

export async function upsertAccountBinding(
  env: Env,
  userLogin: string,
  input: {
    broker: unknown;
    mode: unknown;
    accountType?: unknown;
    scope?: unknown;
    accountId: unknown;
    accountName?: unknown;
  },
): Promise<{ readonly ok: true; readonly binding: AccountBinding } | { readonly ok: false; readonly error: string }> {
  const validated = validateAccountBindingInput({
    ...input,
    updatedBy: userLogin,
  });
  if (!validated.ok) return validated;

  const kv = getBindingKv(env);
  if (!kv) {
    return {
      ok: false,
      error: "SessionStore Durable Object is not bound; cannot persist account binding.",
    };
  }

  const existing = await listAccountBindings(env, userLogin);
  const slotId = accountBindingSlotId(validated.binding);
  const next = existing.filter((b) => accountBindingSlotId(b) !== slotId);
  next.push(validated.binding);

  await kv.put(userBindingsKey(userLogin), JSON.stringify(next));
  return { ok: true, binding: validated.binding };
}

export async function removeAccountBinding(
  env: Env,
  userLogin: string,
  key: AccountBindingKey,
): Promise<boolean> {
  const kv = getBindingKv(env);
  if (!kv || !userLogin.trim()) return false;

  const existing = await listAccountBindings(env, userLogin);
  const slotId = accountBindingSlotId(key);
  const next = existing.filter((b) => accountBindingSlotId(b) !== slotId);
  if (next.length === existing.length) return false;

  if (next.length === 0) {
    await kv.delete(userBindingsKey(userLogin));
  } else {
    await kv.put(userBindingsKey(userLogin), JSON.stringify(next));
  }
  return true;
}

export interface ExecutionAccountContext {
  readonly broker: AccountBindingBroker;
  readonly mode: TradingType;
  readonly accountType: AccountType;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly scope: AccountBindingScope;
  readonly resolvedFromScope: AccountBindingScope | null;
  readonly source: "explicit" | "binding" | "unset";
}

export async function resolveExecutionAccountContext(
  env: Env,
  userLogin: string,
  input: {
    broker: string;
    mode: TradingType;
    accountType?: unknown;
    scope?: unknown;
    explicitAccountId?: unknown;
  },
): Promise<ExecutionAccountContext | null> {
  const normBroker = input.broker.trim().toLowerCase();
  if (!isAccountBindingBroker(normBroker)) return null;

  const accountType =
    normalizeAccountType(input.accountType) ?? ACCOUNT_BINDING_CONFIG.defaultAccountType;
  const scope = normalizeAccountBindingScope(input.scope, "copilot");

  const explicit =
    typeof input.explicitAccountId === "string" && input.explicitAccountId.trim()
      ? input.explicitAccountId.trim()
      : undefined;
  if (explicit) {
    return {
      broker: normBroker,
      mode: input.mode,
      accountType,
      accountId: explicit,
      scope,
      resolvedFromScope: null,
      source: "explicit",
    };
  }

  const resolved = await resolveUserAccountBinding(env, userLogin, {
    broker: normBroker,
    mode: input.mode,
    accountType,
    scope,
  });
  if (resolved.found && resolved.binding) {
    return {
      broker: normBroker,
      mode: input.mode,
      accountType,
      accountId: resolved.binding.accountId,
      accountName: resolved.binding.accountName,
      scope,
      resolvedFromScope: resolved.resolvedFromScope,
      source: "binding",
    };
  }

  return {
    broker: normBroker,
    mode: input.mode,
    accountType,
    scope,
    resolvedFromScope: null,
    source: "unset",
  };
}

export function accountBindingAuditFields(ctx: ExecutionAccountContext | null): Record<string, unknown> {
  if (!ctx) return {};
  return {
    broker: ctx.broker,
    mode: ctx.mode,
    accountType: ctx.accountType,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    bindingScope: ctx.scope,
    bindingSource: ctx.source,
  };
}
