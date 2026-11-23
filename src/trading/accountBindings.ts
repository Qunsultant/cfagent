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
  maskAccountId,
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
import { codedMessage } from "../outcomes/outcomeAspects";
import type { BrokerAccount } from "../types";
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

/**
 * The fundamental 4-element account binding tuple { broker, mode, accountType, accountId }
 * required across tenant state and per-surface scopes (issue #5094 / #5098).
 */
export interface AccountBindingTuple {
  readonly broker: AccountBindingBroker;
  readonly mode: TradingType;
  readonly accountType: AccountType;
  readonly accountId: string;
  readonly accountName?: string;
}

export interface AccountBindingKey {
  readonly broker: AccountBindingBroker;
  readonly mode: TradingType;
  readonly accountType: AccountType;
  readonly scope: AccountBindingScope;
}

export interface AccountBinding extends AccountBindingKey, AccountBindingTuple {
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export function toAccountBindingTuple(binding: AccountBinding | AccountBindingTuple): AccountBindingTuple {
  return {
    broker: binding.broker,
    mode: binding.mode,
    accountType: binding.accountType,
    accountId: binding.accountId,
    ...(binding.accountName ? { accountName: binding.accountName } : {}),
  };
}

export function isAccountBindingTuple(value: unknown): value is AccountBindingTuple {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.broker === "string" &&
    t.broker.trim().length > 0 &&
    isTradingType(t.mode) &&
    typeof t.accountType === "string" &&
    t.accountType.trim().length > 0 &&
    typeof t.accountId === "string" &&
    t.accountId.trim().length > 0
  );
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
  const normalized = value.trim().toLowerCase();
  if (normalized === "records") return true;
  return (ACCOUNT_BINDING_SCOPES as readonly string[]).includes(normalized);
}

export function normalizeAccountBindingScope(
  value: unknown,
  fallback: AccountBindingScope = ACCOUNT_BINDING_CONFIG.defaultScope,
): AccountBindingScope {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "records") return "audit";
  return (ACCOUNT_BINDING_SCOPES as readonly string[]).includes(normalized)
    ? (normalized as AccountBindingScope)
    : fallback;
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

/**
 * Structural shape accepted for actual broker accounts during validation
 * and migration (satisfies `BrokerAccount` from `src/types.ts` as well as
 * lightweight discovery / platform responses).
 */
export interface BrokerAccountRecordLike {
  readonly accountId: string;
  readonly accountKey?: string;
  readonly accountType?: string;
  readonly accountDesc?: string;
  readonly accountName?: string;
  readonly broker?: string;
  readonly status?: string;
  readonly accountStatus?: string;
  readonly isClosed?: boolean;
  readonly closedDate?: number;
  readonly owned?: boolean;
  readonly isDefault?: boolean;
  readonly supportedAssetTypes?: readonly string[];
}

export interface ValidateAccountAgainstBrokerInput {
  readonly broker: unknown;
  readonly mode: unknown;
  readonly accountType?: unknown;
  readonly accountId: unknown;
  readonly accountName?: unknown;
  readonly scope?: unknown;
  readonly availableAccounts: readonly (BrokerAccount | BrokerAccountRecordLike)[];
  readonly registry?: BrokerAssetAccountRegistry;
  readonly updatedBy?: string;
}

export type ValidateAccountAgainstBrokerResult =
  | {
      readonly ok: true;
      readonly tuple: AccountBindingTuple;
      readonly binding: AccountBinding;
      readonly account: BrokerAccountRecordLike;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error: string;
    };

/**
 * Validates a proposed `{ broker, mode, accountType, accountId }` tuple against
 * the broker's actual registered/connected accounts (issue #5094 F1 / #5098).
 *
 * Enforces:
 *   - Unknown account -> coded error `FAILURE_ACCOUNT_UNKNOWN` (404)
 *   - Unowned / closed account -> coded error `FAILURE_ACCOUNT_UNOWNED` (403)
 *   - Wrong asset type / asset-class mismatch -> coded error `FAILURE_ACCOUNT_ASSET_TYPE_MISMATCH` (400)
 *   - Cross-broker mismatch -> coded error `FAILURE_ACCOUNT_BROKER_MISMATCH` (409)
 *
 * Never silently falls back across brokers, modes, or accounts.
 */
export function validateAccountAgainstBroker(
  input: ValidateAccountAgainstBrokerInput,
): ValidateAccountAgainstBrokerResult {
  const baseRes = validateAccountBindingInput({
    broker: input.broker,
    mode: input.mode,
    accountType: input.accountType,
    scope: input.scope,
    accountId: input.accountId,
    accountName: input.accountName,
    updatedBy: input.updatedBy,
    registry: input.registry,
  });
  if (!baseRes.ok) {
    return {
      ok: false,
      code: ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing,
      error: baseRes.error,
    };
  }

  const binding = baseRes.binding;
  const requestedId = binding.accountId.trim().toLowerCase();

  // 1. Cross-broker check: an account specified under another broker
  const crossBrokerMatch = input.availableAccounts.find((a) => {
    const accId = typeof a.accountId === "string" ? a.accountId.trim().toLowerCase() : "";
    const accKey =
      typeof (a as BrokerAccount).accountKey === "string"
        ? (a as BrokerAccount).accountKey.trim().toLowerCase()
        : "";
    const idMatch = accId === requestedId || accKey === requestedId;
    const aBroker = (a as BrokerAccountRecordLike).broker;
    return idMatch && aBroker && aBroker.trim().toLowerCase() !== binding.broker;
  });
  if (crossBrokerMatch) {
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.brokerMismatch;
    const brokerName = (crossBrokerMatch as BrokerAccountRecordLike).broker;
    return {
      ok: false,
      code,
      error: codedMessage(
        code,
        `Account "${binding.accountId}" belongs to broker "${brokerName}", not "${binding.broker}". Cross-broker substitution is disallowed.`,
      ),
    };
  }

  // 2. Unknown account check
  const matched = input.availableAccounts.find((a) => {
    const accId = typeof a.accountId === "string" ? a.accountId.trim().toLowerCase() : "";
    const accKey =
      typeof (a as BrokerAccount).accountKey === "string"
        ? (a as BrokerAccount).accountKey.trim().toLowerCase()
        : "";
    const idMatch = accId === requestedId || accKey === requestedId;
    if (!idMatch) return false;
    const aBroker = (a as BrokerAccountRecordLike).broker;
    if (aBroker && aBroker.trim().toLowerCase() !== binding.broker) return false;
    return true;
  });

  if (!matched) {
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.unknownAccount;
    return {
      ok: false,
      code,
      error: codedMessage(
        code,
        `Account "${binding.accountId}" was not found among available accounts for broker "${binding.broker}".`,
      ),
    };
  }

  // 3. Unowned / inactive / closed account check
  const isClosed =
    (matched as BrokerAccountRecordLike).isClosed === true ||
    ((matched as BrokerAccount).closedDate !== undefined &&
      ((matched as BrokerAccount).closedDate ?? 0) > 0) ||
    String(
      (matched as BrokerAccount).accountStatus ||
        (matched as BrokerAccountRecordLike).status ||
        "",
    )
      .trim()
      .toLowerCase() === "closed";
  const isUnowned = (matched as BrokerAccountRecordLike).owned === false;
  if (isClosed || isUnowned) {
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.unownedAccount;
    return {
      ok: false,
      code,
      error: codedMessage(
        code,
        `Account "${binding.accountId}" is ${isClosed ? "closed" : "not owned or accessible by the tenant"}.`,
      ),
    };
  }

  // 4. Asset type / account type mismatch check
  const matchedType = String(matched.accountType ?? "").trim().toLowerCase();
  const supportedTypes = (matched as BrokerAccountRecordLike).supportedAssetTypes;
  if (Array.isArray(supportedTypes) && supportedTypes.length > 0) {
    const supports = supportedTypes.map((s) => s.trim().toLowerCase());
    if (!supports.includes(binding.accountType.toLowerCase())) {
      const code = ACCOUNT_BINDING_CONFIG.failureCodes.assetTypeMismatch;
      return {
        ok: false,
        code,
        error: codedMessage(
          code,
          `Account "${binding.accountId}" supports [${supports.join(", ")}], which does not match requested asset class "${binding.accountType}".`,
        ),
      };
    }
  } else if (matchedType) {
    const isOptionsOrMargin = binding.accountType === "options" || binding.accountType === "margin";
    const isCashRestricted = matchedType === "cash" || matchedType === "cash_only";
    if (isOptionsOrMargin && isCashRestricted) {
      const code = ACCOUNT_BINDING_CONFIG.failureCodes.assetTypeMismatch;
      return {
        ok: false,
        code,
        error: codedMessage(
          code,
          `Account "${binding.accountId}" has type "${matchedType}" and does not support "${binding.accountType}" trading.`,
        ),
      };
    }
    if (
      binding.accountType === "crypto" &&
      (matchedType === "stock" || matchedType === "equity" || matchedType === "ira")
    ) {
      const code = ACCOUNT_BINDING_CONFIG.failureCodes.assetTypeMismatch;
      return {
        ok: false,
        code,
        error: codedMessage(
          code,
          `Account "${binding.accountId}" has type "${matchedType}" and does not support crypto trading.`,
        ),
      };
    }
  }

  return {
    ok: true,
    tuple: toAccountBindingTuple(binding),
    binding,
    account: matched as BrokerAccountRecordLike,
  };
}

export interface MigrateLegacyBrokerSelectionInput {
  readonly broker: unknown;
  readonly mode: unknown;
  readonly targetAccountType?: unknown;
  readonly scope?: unknown;
  readonly availableAccounts: readonly (BrokerAccount | BrokerAccountRecordLike)[];
  readonly registry?: BrokerAssetAccountRegistry;
  readonly updatedBy?: string;
}

export type MigrateLegacyBrokerSelectionResult =
  | {
      readonly ok: true;
      readonly tuple: AccountBindingTuple;
      readonly binding: AccountBinding;
      readonly account: BrokerAccountRecordLike;
      readonly migrated: true;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error: string;
      readonly candidateAccountIds?: readonly string[];
    };

/**
 * Migrates a legacy broker/mode-only selection to a full `{ broker, mode, accountType, accountId }`
 * tuple with an explicit default-account rule (issue #5094 F1 / #5098).
 *
 * Rules:
 *   - 0 candidate accounts: fails loud with `FAILURE_ACCOUNT_UNKNOWN`.
 *   - Exactly 1 candidate account (or exactly 1 marked default): unambiguous, migrates cleanly.
 *   - Multiple candidate accounts: ambiguous — fails loud with `FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS`
 *     so the tenant can be asked instead of guessing.
 */
export function migrateLegacyBrokerSelectionToTuple(
  input: MigrateLegacyBrokerSelectionInput,
): MigrateLegacyBrokerSelectionResult {
  const rawBroker = typeof input.broker === "string" ? input.broker.trim().toLowerCase() : "";
  if (!isAccountBindingBroker(rawBroker, input.registry)) {
    return {
      ok: false,
      code: ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing,
      error: `Unsupported broker "${String(input.broker ?? "")}".`,
    };
  }

  const rawMode = typeof input.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!isTradingType(rawMode)) {
    return {
      ok: false,
      code: ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing,
      error: `Invalid trading mode "${String(input.mode ?? "")}"; expected "paper" or "live".`,
    };
  }

  const targetAccountType =
    input.targetAccountType === undefined
      ? ACCOUNT_BINDING_CONFIG.defaultAccountType
      : normalizeAccountType(input.targetAccountType, input.registry);
  if (!targetAccountType) {
    return {
      ok: false,
      code: ACCOUNT_BINDING_CONFIG.failureCodes.assetTypeMismatch,
      error: `Invalid accountType "${String(input.targetAccountType ?? "")}".`,
    };
  }

  // Filter candidates: active/open, owned, matching broker if tagged
  const candidates = input.availableAccounts.filter((a) => {
    const aBroker = (a as BrokerAccountRecordLike).broker;
    if (aBroker && aBroker.trim().toLowerCase() !== rawBroker) return false;
    const isClosed =
      (a as BrokerAccountRecordLike).isClosed === true ||
      ((a as BrokerAccount).closedDate !== undefined &&
        ((a as BrokerAccount).closedDate ?? 0) > 0) ||
      String(
        (a as BrokerAccount).accountStatus ||
          (a as BrokerAccountRecordLike).status ||
          "",
      )
        .trim()
        .toLowerCase() === "closed";
    if (isClosed) return false;
    if ((a as BrokerAccountRecordLike).owned === false) return false;

    // Check asset type compatibility
    const supportedTypes = (a as BrokerAccountRecordLike).supportedAssetTypes;
    if (Array.isArray(supportedTypes) && supportedTypes.length > 0) {
      if (
        !supportedTypes
          .map((s) => s.trim().toLowerCase())
          .includes(targetAccountType.toLowerCase())
      ) {
        return false;
      }
    } else {
      const typeStr = String(a.accountType ?? "").trim().toLowerCase();
      if (
        (targetAccountType === "options" || targetAccountType === "margin") &&
        (typeStr === "cash" || typeStr === "cash_only")
      ) {
        return false;
      }
      if (
        targetAccountType === "crypto" &&
        (typeStr === "stock" || typeStr === "equity" || typeStr === "ira")
      ) {
        return false;
      }
    }
    return true;
  });

  if (candidates.length === 0) {
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.unknownAccount;
    return {
      ok: false,
      code,
      error: codedMessage(
        code,
        `No eligible accounts found for broker "${rawBroker}" and asset type "${targetAccountType}".`,
      ),
    };
  }

  // If multiple candidates, check if exactly one is designated as default
  const defaults = candidates.filter(
    (c) => (c as BrokerAccountRecordLike).isDefault === true,
  );
  let chosen: (BrokerAccount | BrokerAccountRecordLike) | null = null;
  if (defaults.length === 1) {
    chosen = defaults[0];
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  }

  if (!chosen) {
    const candidateAccountIds = candidates.map((c) => c.accountId);
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.migrationAmbiguous;
    return {
      ok: false,
      code,
      candidateAccountIds,
      error: codedMessage(
        code,
        `Multiple candidate accounts found for ${rawBroker} (${candidateAccountIds.join(", ")}); explicit selection required.`,
      ),
    };
  }

  const bound = validateAccountBindingInput({
    broker: rawBroker,
    mode: rawMode,
    accountType: targetAccountType,
    scope: input.scope,
    accountId: chosen.accountId,
    accountName: chosen.accountName || (chosen as BrokerAccountRecordLike).accountDesc,
    updatedBy: input.updatedBy ?? "migration",
    registry: input.registry,
  });

  if (!bound.ok) {
    return {
      ok: false,
      code: ACCOUNT_BINDING_CONFIG.failureCodes.unknownAccount,
      error: bound.error,
    };
  }

  return {
    ok: true,
    tuple: toAccountBindingTuple(bound.binding),
    binding: bound.binding,
    account: chosen as BrokerAccountRecordLike,
    migrated: true,
  };
}

export interface ResolveAccountByLabelInput {
  readonly accountName: unknown;
  readonly availableAccounts: readonly (BrokerAccount | BrokerAccountRecordLike)[];
}

export type ResolveAccountByLabelResult =
  | { readonly ok: true; readonly account: BrokerAccountRecordLike }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error: string;
      readonly candidateNames?: readonly string[];
    };

/**
 * Issue #5101 (F4 of #5094): switch-by-label — resolve a human account
 * label ("My IRA", "Individual Brokerage") to the broker's enumerated
 * account, server-side, so the model never holds a full account id.
 * Matching is against the account's display name (`accountName`, else
 * `accountDesc`): an exact (case-insensitive) match wins; with no exact
 * match a single substring match wins. Zero matches fail loud with
 * `FAILURE_ACCOUNT_UNKNOWN`; several matches fail loud with
 * `FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS` listing the candidate names —
 * ask, never guess (the F1 migration rule). Ownership, closed status,
 * and asset-class fit are NOT decided here; the resolved account still
 * goes through `validateAccountAgainstBroker` before anything is bound.
 * The error lists display names only, never account ids.
 */
export function resolveAccountByLabel(
  input: ResolveAccountByLabelInput,
): ResolveAccountByLabelResult {
  const rawLabel = typeof input.accountName === "string" ? input.accountName.trim() : "";
  if (!rawLabel) {
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing;
    return {
      ok: false,
      code,
      error: codedMessage(code, "An account label is required to switch by label."),
    };
  }
  const label = rawLabel.toLowerCase();
  const displayName = (a: BrokerAccount | BrokerAccountRecordLike): string => {
    const name = typeof a.accountName === "string" ? a.accountName.trim() : "";
    if (name) return name;
    const desc = typeof (a as BrokerAccount).accountDesc === "string" ? (a as BrokerAccount).accountDesc.trim() : "";
    if (desc) return desc;
    return maskAccountId(a.accountId);
  };
  const matches = (a: BrokerAccount | BrokerAccountRecordLike): boolean => {
    const name = typeof a.accountName === "string" ? a.accountName.trim().toLowerCase() : "";
    const desc = typeof (a as BrokerAccount).accountDesc === "string" ? (a as BrokerAccount).accountDesc.trim().toLowerCase() : "";
    return name === label || desc === label;
  };
  const contains = (a: BrokerAccount | BrokerAccountRecordLike): boolean => {
    const name = typeof a.accountName === "string" ? a.accountName.trim().toLowerCase() : "";
    const desc = typeof (a as BrokerAccount).accountDesc === "string" ? (a as BrokerAccount).accountDesc.trim().toLowerCase() : "";
    return (name.length > 0 && name.includes(label)) || (desc.length > 0 && desc.includes(label));
  };
  const ambiguous = (candidates: readonly (BrokerAccount | BrokerAccountRecordLike)[]) => {
    const candidateNames = Array.from(new Set(candidates.map(displayName)));
    const code = ACCOUNT_BINDING_CONFIG.failureCodes.migrationAmbiguous;
    return {
      ok: false as const,
      code,
      candidateNames,
      error: codedMessage(
        code,
        `Several accounts match "${rawLabel}" (${candidateNames.join(", ")}); say which one to switch to instead of guessing.`,
      ),
    };
  };

  const exact = input.availableAccounts.filter(matches);
  if (exact.length === 1) return { ok: true, account: exact[0] as BrokerAccountRecordLike };
  if (exact.length > 1) return ambiguous(exact);

  const partial = input.availableAccounts.filter(contains);
  if (partial.length === 1) return { ok: true, account: partial[0] as BrokerAccountRecordLike };
  if (partial.length > 1) return ambiguous(partial);

  const code = ACCOUNT_BINDING_CONFIG.failureCodes.unknownAccount;
  return {
    ok: false,
    code,
    error: codedMessage(
      code,
      `No account named "${rawLabel}" was found among the broker's accounts.`,
    ),
  };
}

/**
 * Issue #5101 (F4 of #5094): the masked form of a binding for anything
 * that leaves the server — tool results, NLQ answers, prompts, client
 * payloads. The stored binding keeps the full id; the masked copy carries
 * the masked id in `accountId` AND as `maskedAccountId`, so a reader
 * never has to guess which field is safe. Never surface an unmasked
 * binding (or tuple) outside the server.
 */
export function maskAccountBinding<T extends AccountBindingTuple>(
  binding: T,
): T & { readonly maskedAccountId: string } {
  const masked = maskAccountId(binding.accountId);
  return { ...binding, accountId: masked, maskedAccountId: masked };
}

/**
 * Issue #5101 (F4 of #5094): the masked form of a broker-enumerated
 * account. `accountId`, `accountKey`, and `accountIdKey` are all
 * identifiers the model and the client must never see in full.
 */
export function maskBrokerAccount<T extends BrokerAccountRecordLike>(
  account: T,
): T & { readonly maskedAccountId: string } {
  const masked = maskAccountId(account.accountId);
  const next = {
    ...account,
    accountId: masked,
    maskedAccountId: masked,
  } as T & { maskedAccountId: string; accountKey?: string; accountIdKey?: string };
  const rawKey = (account as unknown as BrokerAccount).accountKey;
  if (typeof rawKey === "string") next.accountKey = maskAccountId(rawKey);
  const rawIdKey = (account as unknown as BrokerAccount).accountIdKey;
  if (typeof rawIdKey === "string") next.accountIdKey = maskAccountId(rawIdKey);
  return next;
}
