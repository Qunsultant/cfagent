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
import { codedMessage, getOutcome } from "../outcomes/outcomeAspects";
import {
  accountBindingSlotId,
  applyBrokerRegistryPatch,
  buildDefaultBrokerAssetAccountRegistry,
  isAccountBindingBroker,
  isAccountBindingTuple,
  migrateLegacyBrokerSelectionToTuple,
  normalizeAccountBindingScope,
  normalizeAccountType,
  resolveEffectiveAccountBinding,
  toAccountBindingTuple,
  validateAccountAgainstBroker,
  validateAccountBindingInput,
  type AccountBinding,
  type AccountBindingBroker,
  type AccountBindingKey,
  type AccountBindingResolution,
  type AccountBindingScope,
  type AccountBindingTuple,
  type AccountType,
  type BrokerAccountRecordLike,
  type BrokerAssetAccountRegistry,
  type BrokerAssetAccountRegistryPatch,
  type MigrateLegacyBrokerSelectionInput,
  type MigrateLegacyBrokerSelectionResult,
  type TradingType,
  type ValidateAccountAgainstBrokerInput,
  type ValidateAccountAgainstBrokerResult,
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

function userRegistryKey(userLogin: string): string {
  return `${ACCOUNT_BINDING_CONFIG.registryKeyPrefix}${userLogin.trim().toLowerCase()}`;
}

export async function getBrokerAssetAccountRegistry(
  env: Env,
  userLogin: string,
): Promise<BrokerAssetAccountRegistry> {
  const defaults = buildDefaultBrokerAssetAccountRegistry();
  const kv = getBindingKv(env);
  if (!kv || !userLogin.trim()) return defaults;
  const raw = await kv.get(userRegistryKey(userLogin));
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<BrokerAssetAccountRegistry> | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.brokers)) {
      return defaults;
    }
    return {
      brokers: parsed.brokers,
      assetTypes: Array.isArray(parsed.assetTypes) ? parsed.assetTypes : defaults.assetTypes,
      accountTypes: Array.isArray(parsed.accountTypes) ? parsed.accountTypes : defaults.accountTypes,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaults.updatedAt,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : defaults.updatedBy,
    };
  } catch {
    return defaults;
  }
}

export async function updateBrokerAssetAccountRegistry(
  env: Env,
  userLogin: string,
  patch: BrokerAssetAccountRegistryPatch,
): Promise<{ readonly ok: true; readonly registry: BrokerAssetAccountRegistry } | { readonly ok: false; readonly error: string }> {
  const kv = getBindingKv(env);
  if (!kv) {
    return {
      ok: false,
      error: "SessionStore Durable Object is not bound; cannot persist broker registry.",
    };
  }
  const current = await getBrokerAssetAccountRegistry(env, userLogin);
  const patched = applyBrokerRegistryPatch(current, patch, userLogin);
  if (!patched.ok) return patched;
  await kv.put(userRegistryKey(userLogin), JSON.stringify(patched.registry));
  return patched;
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
  const registry = await getBrokerAssetAccountRegistry(env, userLogin);
  const validated = validateAccountBindingInput({
    ...input,
    updatedBy: userLogin,
    registry,
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

/**
 * Validates a proposed binding against actual accounts (if provided) and persists
 * the `{ broker, mode, accountType, accountId }` tuple in SessionStore.
 */
export async function validateAndUpsertAccountBinding(
  env: Env,
  userLogin: string,
  input: {
    broker: unknown;
    mode: unknown;
    accountType?: unknown;
    scope?: unknown;
    accountId: unknown;
    accountName?: unknown;
    availableAccounts?: readonly BrokerAccountRecordLike[];
  },
): Promise<
  | { readonly ok: true; readonly binding: AccountBinding; readonly tuple: AccountBindingTuple }
  | { readonly ok: false; readonly code: string; readonly error: string }
> {
  const registry = await getBrokerAssetAccountRegistry(env, userLogin);
  if (Array.isArray(input.availableAccounts)) {
    const valRes = validateAccountAgainstBroker({
      broker: input.broker,
      mode: input.mode,
      accountType: input.accountType,
      scope: input.scope,
      accountId: input.accountId,
      accountName: input.accountName,
      availableAccounts: input.availableAccounts,
      registry,
      updatedBy: userLogin,
    });
    if (!valRes.ok) return valRes;

    const kv = getBindingKv(env);
    if (!kv) {
      return {
        ok: false,
        code: "FAILURE_SESSION_STORE_UNBOUND",
        error: "SessionStore Durable Object is not bound; cannot persist account binding.",
      };
    }
    const existing = await listAccountBindings(env, userLogin);
    const slotId = accountBindingSlotId(valRes.binding);
    const next = existing.filter((b) => accountBindingSlotId(b) !== slotId);
    next.push(valRes.binding);
    await kv.put(userBindingsKey(userLogin), JSON.stringify(next));
    return { ok: true, binding: valRes.binding, tuple: valRes.tuple };
  }

  const upsertRes = await upsertAccountBinding(env, userLogin, input);
  if (!upsertRes.ok) {
    return {
      ok: false,
      code: ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing,
      error: upsertRes.error,
    };
  }
  return {
    ok: true,
    binding: upsertRes.binding,
    tuple: toAccountBindingTuple(upsertRes.binding),
  };
}

/**
 * Migrates a legacy broker/mode-only selection to an explicit tuple in SessionStore
 * following the unambiguous default rule (issue #5094 F1 / #5098).
 */
export async function migrateTenantAccountBinding(
  env: Env,
  userLogin: string,
  input: {
    broker: unknown;
    mode: unknown;
    targetAccountType?: unknown;
    scope?: unknown;
    availableAccounts: readonly BrokerAccountRecordLike[];
  },
): Promise<MigrateLegacyBrokerSelectionResult> {
  const registry = await getBrokerAssetAccountRegistry(env, userLogin);
  const migRes = migrateLegacyBrokerSelectionToTuple({
    broker: input.broker,
    mode: input.mode,
    targetAccountType: input.targetAccountType,
    scope: input.scope,
    availableAccounts: input.availableAccounts,
    registry,
    updatedBy: userLogin,
  });
  if (!migRes.ok) return migRes;

  const kv = getBindingKv(env);
  if (!kv) {
    return {
      ok: false,
      code: "FAILURE_SESSION_STORE_UNBOUND",
      error: "SessionStore Durable Object is not bound; cannot persist account binding.",
    };
  }

  const existing = await listAccountBindings(env, userLogin);
  const slotId = accountBindingSlotId(migRes.binding);
  const next = existing.filter((b) => accountBindingSlotId(b) !== slotId);
  next.push(migRes.binding);
  await kv.put(userBindingsKey(userLogin), JSON.stringify(next));

  return migRes;
}

/**
 * Resolves the tenant-level default account tuple { broker, mode, accountType, accountId }.
 */
export async function getTenantAccountBinding(
  env: Env,
  userLogin: string,
  query: {
    broker: AccountBindingBroker;
    mode: TradingType;
    accountType?: AccountType;
  },
): Promise<AccountBindingTuple | null> {
  const accountType = query.accountType ?? ACCOUNT_BINDING_CONFIG.defaultAccountType;
  const res = await resolveUserAccountBinding(env, userLogin, {
    broker: query.broker,
    mode: query.mode,
    accountType,
    scope: "tenant",
  });
  return res.found && res.binding ? toAccountBindingTuple(res.binding) : null;
}

/**
 * Resolves the effective account binding tuple across tenant and per-surface scopes.
 * Fails loud with `FAILURE_ACCOUNT_BINDING_MISSING` if unbound.
 */
export async function resolveExecutionAccountTuple(
  env: Env,
  userLogin: string,
  query: {
    broker: AccountBindingBroker;
    mode: TradingType;
    accountType?: AccountType;
    scope?: AccountBindingScope;
  },
): Promise<
  | {
      readonly found: true;
      readonly tuple: AccountBindingTuple;
      readonly binding: AccountBinding;
      readonly resolvedFromScope: AccountBindingScope;
    }
  | {
      readonly found: false;
      readonly tuple: null;
      readonly code: string;
      readonly error: string;
    }
> {
  const accountType = query.accountType ?? ACCOUNT_BINDING_CONFIG.defaultAccountType;
  const scope = normalizeAccountBindingScope(query.scope, "tenant");

  const res = await resolveUserAccountBinding(env, userLogin, {
    broker: query.broker,
    mode: query.mode,
    accountType,
    scope,
  });

  if (res.found && res.binding) {
    return {
      found: true,
      tuple: toAccountBindingTuple(res.binding),
      binding: res.binding,
      resolvedFromScope: res.resolvedFromScope ?? res.binding.scope,
    };
  }

  const code = ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing;
  return {
    found: false,
    tuple: null,
    code,
    error: codedMessage(
      code,
      `No binding found for ${query.broker}:${query.mode}:${accountType}:${scope}. Silent fallback is disallowed.`,
    ),
  };
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

/**
 * Issue #6257 — one-time migration of bindings saved under a DO instance id
 * to the verified login key.
 *
 * Settings used to write bindings under `acctbind:v1:<do-id>` (the
 * Orchestrator `sessionKey()`), while every login-keyed reader (schedules,
 * orders, autopilot, copilot, NLQ, research) reads `acctbind:v1:<login>`.
 * Copies each legacy slot missing under the login key; login-keyed entries
 * win on conflict. Also copies a stored registry patch when the login key
 * has none. Legacy entries are left in place (copy, not move) and the
 * function is idempotent: a second run migrates nothing.
 */
export async function migrateAccountBindingsToLogin(
  env: Env,
  legacyUserLogin: string,
  userLogin: string,
): Promise<{ readonly migratedBindings: number; readonly migratedRegistry: boolean }> {
  const legacy = legacyUserLogin.trim().toLowerCase();
  const login = userLogin.trim().toLowerCase();
  if (!legacy || !login || legacy === login) {
    return { migratedBindings: 0, migratedRegistry: false };
  }
  const kv = getBindingKv(env);
  if (!kv) return { migratedBindings: 0, migratedRegistry: false };

  const legacyBindings = await listAccountBindings(env, legacyUserLogin);
  const currentBindings = await listAccountBindings(env, userLogin);
  const missing = legacyBindings.filter(
    (b) => !currentBindings.some((c) => accountBindingSlotId(c) === accountBindingSlotId(b)),
  );
  let migratedBindings = 0;
  if (missing.length > 0) {
    await kv.put(userBindingsKey(userLogin), JSON.stringify([...currentBindings, ...missing]));
    migratedBindings = missing.length;
  }

  let migratedRegistry = false;
  const legacyRegistryRaw = await kv.get(userRegistryKey(legacyUserLogin));
  if (legacyRegistryRaw) {
    const loginRegistryRaw = await kv.get(userRegistryKey(userLogin));
    if (!loginRegistryRaw) {
      await kv.put(userRegistryKey(userLogin), legacyRegistryRaw);
      migratedRegistry = true;
    }
  }
  return { migratedBindings, migratedRegistry };
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
  readonly tuple?: AccountBindingTuple;
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
  const registry = await getBrokerAssetAccountRegistry(env, userLogin);
  const normBroker = input.broker.trim().toLowerCase();
  if (!isAccountBindingBroker(normBroker, registry)) return null;

  const accountType =
    normalizeAccountType(input.accountType, registry) ?? ACCOUNT_BINDING_CONFIG.defaultAccountType;
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
      tuple: {
        broker: normBroker,
        mode: input.mode,
        accountType,
        accountId: explicit,
      },
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
      tuple: toAccountBindingTuple(resolved.binding),
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

export type ValidatedExecutionAccountContext =
  | { readonly ok: true; readonly context: ExecutionAccountContext }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error: string;
      /** The outcome-catalog httpStatus for the code — never invented. */
      readonly status: number;
    };

/**
 * Issue #5100 (F3 of #5094) — the validated-resolution wrapper over
 * `resolveExecutionAccountContext`. Closes the two holes the B1 plan
 * flagged in the F1 primitive:
 *
 * - `source: "explicit"` — a body-supplied accountId is validated
 *   against the broker's enumerated accounts via
 *   `validateAccountAgainstBroker` (never accepted verbatim). Without
 *   an enumeration the resolution fails closed: an explicit id that
 *   cannot be validated is a refusal, not a pass-through.
 * - `source: "unset"` — an unbound resolution is a coded
 *   `FAILURE_ACCOUNT_BINDING_MISSING` refusal. No caller may receive
 *   an unset context and proceed.
 *
 * `resolveExecutionAccountContext` itself is unchanged (the F1 pin
 * `tests/account_binding_execution_5112.test.ts` asserts its shape);
 * every F3 call site uses this wrapper.
 */
export async function resolveValidatedExecutionAccountContext(
  env: Env,
  userLogin: string,
  input: {
    broker: string;
    mode: TradingType;
    accountType?: unknown;
    scope?: unknown;
    explicitAccountId?: unknown;
    /** The broker's enumerated accounts — required to validate an explicit accountId. */
    availableAccounts?: readonly BrokerAccountRecordLike[];
  },
): Promise<ValidatedExecutionAccountContext> {
  const fail = (code: string, error: string): ValidatedExecutionAccountContext => ({
    ok: false,
    code,
    error,
    status: getOutcome(code)?.httpStatus ?? 500,
  });
  const ctx = await resolveExecutionAccountContext(env, userLogin, input);
  if (!ctx) {
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing;
    return fail(
      code,
      codedMessage(
        code,
        `Unsupported broker "${input.broker}": no account binding can resolve for it.`,
      ),
    );
  }
  if (ctx.source === "unset") {
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing;
    return fail(
      code,
      codedMessage(
        code,
        `No binding found for ${ctx.broker}:${ctx.mode}:${ctx.accountType}:${ctx.scope}. Silent fallback is disallowed.`,
      ),
    );
  }
  if (ctx.source === "explicit") {
    if (!Array.isArray(input.availableAccounts)) {
      const code = ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing;
      return fail(
        code,
        codedMessage(
          code,
          `Cannot validate explicit account "${ctx.accountId}" for ${ctx.broker}: the broker's enumerated accounts were not supplied.`,
        ),
      );
    }
    const registry = await getBrokerAssetAccountRegistry(env, userLogin);
    const valRes = validateAccountAgainstBroker({
      broker: ctx.broker,
      mode: ctx.mode,
      accountType: ctx.accountType,
      scope: ctx.scope,
      accountId: ctx.accountId,
      availableAccounts: input.availableAccounts,
      registry,
      updatedBy: userLogin,
    });
    if (!valRes.ok) return fail(valRes.code, valRes.error);
    return {
      ok: true,
      context: {
        ...ctx,
        accountName: valRes.account.accountName ?? ctx.accountName,
        tuple: valRes.tuple,
      },
    };
  }
  return { ok: true, context: ctx };
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
