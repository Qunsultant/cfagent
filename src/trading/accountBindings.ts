/**
 * Multi-Account & Asset-Class Account Binding Domain Model (issues #5094, #5110).
 *
 * Tracks `{ broker, mode, accountType, accountId }` per scope
 * (`tenant`, `autopilot`, `copilot`, `schedule`) so a user with multiple
 * brokerage, options, or forex accounts can bind each surface to a specific
 * account without ever silently falling back across brokers, modes, or
 * account types.
 */
import {
  ACCOUNT_BINDING_CONFIG,
  ACCOUNT_BINDING_SCOPES,
  ACCOUNT_TYPES,
} from "../config/accountBindings";
import {
  applyBrokerRegistryPatch,
  buildDefaultRegistryWithHosted,
  DEFAULT_ASSET_TYPES,
  type BrokerAssetAccountRegistry,
  type BrokerAssetAccountRegistryPatch,
  type BrokerRegistryEntry,
} from "../config/brokerRegistry";
import { IBKR_CONFIG } from "../config/ibkr";
import { isBrokerId, type BrokerId, type TradingType } from "./brokerCatalog";

export {
  applyBrokerRegistryPatch,
  DEFAULT_ASSET_TYPES,
  type BrokerAssetAccountRegistry,
  type BrokerAssetAccountRegistryPatch,
  type BrokerRegistryEntry,
};

/**
 * Seeds the default registry from `BROKER_CATALOG` (#3855) plus the hosted
 * MCP broker and `ACCOUNT_TYPES`.
 */
export function buildDefaultBrokerAssetAccountRegistry(): BrokerAssetAccountRegistry {
  return buildDefaultRegistryWithHosted(IBKR_CONFIG);
}

export type AccountType = (typeof ACCOUNT_TYPES)[number] | (string & {});
export type AccountBindingScope = (typeof ACCOUNT_BINDING_SCOPES)[number];

/**
 * Broker identifier accepted by account bindings. Includes registered
 * `BrokerId` values, the hosted MCP broker, and any
 * custom broker configured in the runtime registry (#5097).
 */
export type AccountBindingBroker = BrokerId | typeof IBKR_CONFIG.serverId | (string & {});

export interface AccountBindingKey {
  readonly broker: AccountBindingBroker;
  readonly mode: TradingType;
  readonly accountType: AccountType;
  readonly scope: AccountBindingScope;
}

export interface AccountBinding extends AccountBindingKey {
  readonly accountId: string;
  readonly accountName?: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface AccountBindingResolution {
  readonly found: boolean;
  readonly binding: AccountBinding | null;
  readonly resolvedFromScope: AccountBindingScope | null;
}

export function isAccountBindingBroker(
  value: unknown,
  registry?: BrokerAssetAccountRegistry,
): value is AccountBindingBroker {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (registry) {
    return registry.brokers.some((b) => b.id === normalized && b.enabled);
  }
  return normalized === IBKR_CONFIG.serverId || isBrokerId(normalized);
}

export function isAccountType(
  value: unknown,
  registry?: BrokerAssetAccountRegistry,
): value is AccountType {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (registry) {
    return registry.accountTypes.includes(normalized);
  }
  return (ACCOUNT_TYPES as readonly string[]).includes(normalized);
}

export function normalizeAccountType(
  value: unknown,
  registry?: BrokerAssetAccountRegistry,
): AccountType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isAccountType(normalized, registry) ? normalized : null;
}

export function isAccountBindingScope(value: unknown): value is AccountBindingScope {
  if (typeof value !== "string") return false;
  return (ACCOUNT_BINDING_SCOPES as readonly string[]).includes(value.trim().toLowerCase());
}

export function normalizeAccountBindingScope(
  value: unknown,
  fallback: AccountBindingScope = ACCOUNT_BINDING_CONFIG.defaultScope,
): AccountBindingScope {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return isAccountBindingScope(normalized) ? normalized : fallback;
}

export function isTradingType(value: unknown): value is TradingType {
  return value === "paper" || value === "live";
}

export function accountBindingSlotId(key: AccountBindingKey): string {
  return `${key.broker}:${key.mode}:${key.accountType}:${key.scope}`;
}

export function validateAccountBindingInput(input: {
  broker: unknown;
  mode: unknown;
  accountType?: unknown;
  scope?: unknown;
  accountId: unknown;
  accountName?: unknown;
  updatedBy?: string;
  registry?: BrokerAssetAccountRegistry;
}):
  | { readonly ok: true; readonly binding: AccountBinding }
  | { readonly ok: false; readonly error: string } {
  const rawBroker = typeof input.broker === "string" ? input.broker.trim().toLowerCase() : "";
  if (!isAccountBindingBroker(rawBroker, input.registry)) {
    return { ok: false, error: `Unsupported broker "${String(input.broker ?? "")}".` };
  }

  const rawMode = typeof input.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!isTradingType(rawMode)) {
    return { ok: false, error: `Invalid trading mode "${String(input.mode ?? "")}"; expected "paper" or "live".` };
  }
  if (input.registry) {
    const brokerEntry = input.registry.brokers.find((b) => b.id === rawBroker && b.enabled);
    if (brokerEntry && !brokerEntry.modes.includes(rawMode)) {
      return {
        ok: false,
        error: `Broker "${rawBroker}" does not support mode "${rawMode}" (supported: ${brokerEntry.modes.join(", ")}).`,
      };
    }
  }

  const allowedTypes = input.registry ? input.registry.accountTypes : ACCOUNT_TYPES;
  const accountType =
    input.accountType === undefined
      ? ACCOUNT_BINDING_CONFIG.defaultAccountType
      : normalizeAccountType(input.accountType, input.registry);
  if (!accountType) {
    return {
      ok: false,
      error: `Invalid accountType "${String(input.accountType ?? "")}"; expected one of ${allowedTypes.join(", ")}.`,
    };
  }

  const scope =
    input.scope === undefined
      ? ACCOUNT_BINDING_CONFIG.defaultScope
      : isAccountBindingScope(input.scope)
        ? (input.scope.trim().toLowerCase() as AccountBindingScope)
        : null;
  if (!scope) {
    return {
      ok: false,
      error: `Invalid scope "${String(input.scope ?? "")}"; expected one of ${ACCOUNT_BINDING_SCOPES.join(", ")}.`,
    };
  }

  const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
  if (!accountId) {
    return { ok: false, error: "accountId is required and cannot be empty." };
  }

  const accountName =
    typeof input.accountName === "string" && input.accountName.trim()
      ? input.accountName.trim()
      : undefined;

  return {
    ok: true,
    binding: {
      broker: rawBroker,
      mode: rawMode,
      accountType,
      scope,
      accountId,
      ...(accountName ? { accountName } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy?.trim() || "system",
    },
  };
}

/**
 * Resolves the effective account binding for `(broker, mode, accountType, scope)`.
 *
 * Precedence:
 *   1. Exact `(broker, mode, accountType, scope)` match.
 *   2. If `scope !== "tenant"`, falls back to `(broker, mode, accountType, "tenant")`.
 *
 * Never falls back across different brokers, modes, or account types.
 */
export function resolveEffectiveAccountBinding(
  bindings: readonly AccountBinding[],
  query: AccountBindingKey,
): AccountBindingResolution {
  const exact = bindings.find(
    (b) =>
      b.broker === query.broker &&
      b.mode === query.mode &&
      b.accountType === query.accountType &&
      b.scope === query.scope,
  );
  if (exact) {
    return { found: true, binding: exact, resolvedFromScope: exact.scope };
  }

  if (query.scope !== "tenant") {
    const tenantDefault = bindings.find(
      (b) =>
        b.broker === query.broker &&
        b.mode === query.mode &&
        b.accountType === query.accountType &&
        b.scope === "tenant",
    );
    if (tenantDefault) {
      return { found: true, binding: tenantDefault, resolvedFromScope: "tenant" };
    }
  }

  return { found: false, binding: null, resolvedFromScope: null };
}
