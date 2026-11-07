/**
 * Issue #3460 slice 1 — the provider-connection configuration seam.
 *
 * One validated screen selection — (provider connection, external
 * account, environment) — resolved server-side from tenant-scoped
 * configuration, in #1069 §8 terms. This is the ONLY place a screen
 * entry learns which broker, connection, account, and environment a
 * run executes under; every entry resolves through here (slices 2–6)
 * instead of constructing a broker client directly.
 *
 * Rules (Venus, #3460 + #1069):
 * - Externalized configuration, no defaults in code. The broker
 *   selection is a presence-aware read of the tenant's stored
 *   selection (`getTenantBrokerSelection` — null when absent, never
 *   a default). Absent ⇒ UNCONFIGURED. A failed read ⇒
 *   STORE_UNAVAILABLE. Neither ever resolves to E*TRADE.
 * - The connection is the credential binding: a connection id names
 *   (broker, environment, login), and it counts as bound only when
 *   that login holds a credential for the broker+side (Alpaca key
 *   pair in the SessionStore, E*TRADE OAuth tokens). No credential
 *   ⇒ CONNECTION_NOT_BOUND.
 * - The external account is enumerated from the platform at
 *   selection time: exactly one account ⇒ it; zero ⇒
 *   CONNECTION_HAS_NO_ACCOUNT; several ⇒ ACCOUNT_AMBIGUOUS (the
 *   tenant must select one — the S7 menu stores that selection).
 *   No silent "first account" default.
 * - The environment rides the validated context (#1069 §8):
 *   TradingEnvironment TEST/PROD maps to context sandbox/live.
 *   The read side keeps #2482's setting resolution (stored value
 *   wins; unset resolves from the deployment) — see Q3 on #3460.
 * - The §8 context is consumed, not rebuilt: `ExecutionContext`
 *   from `src/security/executionContext.ts` (#1078 S1, OPEN) is the
 *   contract. This module supplies the missing connection-binding
 *   authority over the configured connections; it does NOT build
 *   #1078 (no reference-path propagation, no observe→enforce flip,
 *   no PDP work). If #1078 lands first, this follows its contract.
 * - Boundaries: `isConnectionBound` checks credential presence
 *   (a KV read, no broker call). Account membership is checked at
 *   selection time; revalidation re-checks the binding, not the
 *   live account list — a run in flight carries the context it
 *   started with, and the next selection re-resolution catches a
 *   closed account.
 * - Server-side only. Never imported from client code: the
 *   credential stores and the PDP are server-only.
 */

import { createCommercialAdapter } from "../data/createCommercialPorts";
import type { CommercialStore } from "../data/commercialPorts";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { createKvMembershipStore } from "../security/iaaaMembershipStore";
import { sessionStore } from "../security/session";
import {
  resolveExecutionContext,
  type ExecutionContextAuthority,
  type ResolveExecutionContextResult,
} from "../security/executionContext";
import { getStoredTokens } from "../security/etradeOAuth";
import {
  getAlpacaCredentials,
  TradingPlatformRegistry,
  tradingTypeFor,
  type TradingEnvironment,
  type TradingType,
} from "../trading";
import {
  isBrokerId,
  type BrokerId,
} from "./tenantProviders";
import {
  resolveBrokerEnvironmentFromSettings,
  type BrokerEnvironment,
} from "../agents/routes/brokerEnvironment";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Connection identity
// ---------------------------------------------------------------------------

/** A provider connection: one broker, one environment, one login. */
export interface ProviderConnection {
  /** `broker:environment:login` — e.g. `alpaca:TEST:alice`. */
  id: string;
  brokerId: BrokerId;
  environment: TradingEnvironment;
  userLogin: string;
}

export function connectionIdFor(
  brokerId: BrokerId,
  environment: TradingEnvironment,
  userLogin: string,
): string {
  return `${brokerId}:${environment}:${userLogin.toLowerCase()}`;
}

export function parseConnectionId(id: unknown): ProviderConnection | null {
  if (typeof id !== "string") return null;
  const parts = id.split(":");
  if (parts.length !== 3) return null;
  const [brokerId, environment, userLogin] = parts;
  if (!isBrokerId(brokerId)) return null;
  if (environment !== "TEST" && environment !== "PROD") return null;
  if (!userLogin) return null;
  return { id, brokerId, environment, userLogin };
}

/** TradingEnvironment TEST/PROD → §8 context sandbox/live. */
export function screenEnvironmentToContextEnvironment(
  environment: TradingEnvironment,
): "sandbox" | "live" {
  return environment === "PROD" ? "live" : "sandbox";
}

// ---------------------------------------------------------------------------
// Screen selection
// ---------------------------------------------------------------------------

/** The resolved selection a screen run executes under. */
export interface ScreenSelection {
  connectionId: string;
  brokerId: BrokerId;
  environment: TradingEnvironment;
  /** paper | live, per the broker catalog's mapping. */
  mode: TradingType;
  externalAccountId: string;
}

export type SelectionDenyCode =
  | "UNCONFIGURED"
  | "STORE_UNAVAILABLE"
  | "CONNECTION_NOT_BOUND"
  | "CONNECTION_HAS_NO_ACCOUNT"
  | "ACCOUNT_AMBIGUOUS";

export type ResolveScreenSelectionResult =
  | { resolved: true; selection: ScreenSelection }
  | { resolved: false; code: SelectionDenyCode; error: string };

export interface ScreenSelectionReaders {
  env: Partial<Env>;
  /** The login the run executes as. Never defaulted (#1185). */
  userLogin: string;
  /** The instance's settings reader (#2482 store). */
  readSettingRaw?: ((key: string) => string | null) | undefined;
  /** Composition seam: when omitted, the commercial store is composed from env. */
  commercial?: Pick<CommercialStore, "getTenantBrokerSelection"> | null;
  /** Test/alt-host seam: credential presence for one broker+side. */
  hasCredentials?: (
    brokerId: BrokerId,
    side: TradingType,
  ) => Promise<boolean>;
  /** Test/alt-host seam: account ids for the resolved connection. */
  listAccounts?: (
    brokerId: BrokerId,
    environment: TradingEnvironment,
  ) => Promise<string[]>;
  /** ORM for the production account lister. */
  orm?: Parameters<typeof TradingPlatformRegistry.getPlatform>[2];
}

function credentialSide(environment: TradingEnvironment): TradingType {
  return environment === "PROD" ? "live" : "paper";
}

async function defaultHasCredentials(
  env: Partial<Env>,
  userLogin: string,
  brokerId: BrokerId,
  side: TradingType,
): Promise<boolean> {
  if (!userLogin) return false;
  if (brokerId === "alpaca") {
    return (
      (await getAlpacaCredentials(env as Env, userLogin, side)) !== null
    );
  }
  const overrideEnv: BrokerEnvironment = side === "live" ? "PROD" : "TEST";
  return (
    (await getStoredTokens(env as Env, userLogin, overrideEnv)) !== null
  );
}

/**
 * Production account lister: the platform's own accounts for the
 * resolved connection. Throws when the platform cannot be built or
 * the accounts cannot be read — a selection-time failure is a
 * refusal, never an empty list.
 */
export async function listScreenConnectionAccounts(
  env: Partial<Env>,
  orm: Parameters<typeof TradingPlatformRegistry.getPlatform>[2],
  userLogin: string,
  brokerId: BrokerId,
  environment: TradingEnvironment,
): Promise<string[]> {
  const platform = TradingPlatformRegistry.getPlatform(
    brokerId,
    env as Env,
    orm,
    userLogin,
    environment,
  );
  const accounts = await platform.getAccounts();
  return accounts
    .map((account) => account.accountId)
    .filter(
      (accountId): accountId is string =>
        typeof accountId === "string" && accountId.length > 0,
    );
}

/**
 * Issue #3460 slice 3: the ONE presence-aware tenant broker read.
 *
 * Returns the stored broker id without ever defaulting: absent ⇒
 * `unconfigured`, no store bound or a failed read ⇒ `store_unavailable`.
 * Callers that need a broker decide their own refusal from the status;
 * none of them falls back to E*TRADE. `resolveScreenSelection` reads
 * through this helper, and so do the broker gate and the screen entries.
 */
export type TenantBrokerSelectionRead =
  | { status: "ok"; brokerId: BrokerId }
  | { status: "unconfigured"; error: string }
  | { status: "store_unavailable"; error: string };

export async function readTenantBrokerSelection(
  env: Partial<Env>,
  commercial?: Pick<CommercialStore, "getTenantBrokerSelection"> | null,
): Promise<TenantBrokerSelectionRead> {
  const store =
    commercial !== undefined ? commercial : createCommercialAdapter(env);
  if (!store) {
    return {
      status: "store_unavailable",
      error: "broker selection could not be read: tenant store is not bound",
    };
  }
  let storedBrokerId: string | null;
  try {
    storedBrokerId = await store.getTenantBrokerSelection(
      resolveIaaaTenant(env),
    );
  } catch {
    return {
      status: "store_unavailable",
      error: "broker selection could not be read: tenant store failed",
    };
  }
  if (storedBrokerId === null || !isBrokerId(storedBrokerId)) {
    return {
      status: "unconfigured",
      error:
        storedBrokerId === null
          ? "no broker selection: the tenant has not configured a broker"
          : `no broker selection: stored broker "${storedBrokerId}" is not a registered broker`,
    };
  }
  return { status: "ok", brokerId: storedBrokerId };
}

/**
 * Resolve the ONE screen selection for this run. Fail-closed by
 * construction: every failure mode returns a named refusal. There
 * is no default broker, no default account, and no fail-open — an
 * unconfigured tenant never screens on E*TRADE.
 */
export async function resolveScreenSelection(
  readers: ScreenSelectionReaders,
): Promise<ResolveScreenSelectionResult> {
  if (!readers.userLogin) {
    return {
      resolved: false,
      code: "UNCONFIGURED",
      error: "no broker selection: no login to resolve a selection for",
    };
  }
  const brokerRead = await readTenantBrokerSelection(
    readers.env,
    readers.commercial,
  );
  if (brokerRead.status === "store_unavailable") {
    return { resolved: false, code: "STORE_UNAVAILABLE", error: brokerRead.error };
  }
  if (brokerRead.status === "unconfigured") {
    return { resolved: false, code: "UNCONFIGURED", error: brokerRead.error };
  }
  const brokerId = brokerRead.brokerId;
  const environment = resolveBrokerEnvironmentFromSettings(
    readers.readSettingRaw,
    readers.env,
  );
  const mode = tradingTypeFor(brokerId, environment);
  const connectionId = connectionIdFor(brokerId, environment, readers.userLogin);

  const hasCredentials =
    readers.hasCredentials ??
    ((broker: BrokerId, side: TradingType) =>
      defaultHasCredentials(readers.env, readers.userLogin, broker, side));
  if (!(await hasCredentials(brokerId, mode))) {
    return {
      resolved: false,
      code: "CONNECTION_NOT_BOUND",
      error: `no credential: connection ${connectionId} has no stored credential for this login`,
    };
  }

  const listAccounts =
    readers.listAccounts ??
    ((broker: BrokerId, env: TradingEnvironment) =>
      listScreenConnectionAccounts(
        readers.env,
        readers.orm,
        readers.userLogin,
        broker,
        env,
      ));
  let accountIds: string[];
  try {
    accountIds = await listAccounts(brokerId, environment);
  } catch (err) {
    return {
      resolved: false,
      code: "CONNECTION_HAS_NO_ACCOUNT",
      error: `brokerage accounts could not be read for connection ${connectionId}: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    };
  }
  if (accountIds.length === 0) {
    return {
      resolved: false,
      code: "CONNECTION_HAS_NO_ACCOUNT",
      error: `connection ${connectionId} has no brokerage accounts`,
    };
  }
  if (accountIds.length > 1) {
    return {
      resolved: false,
      code: "ACCOUNT_AMBIGUOUS",
      error: `connection ${connectionId} has more than one brokerage account; the tenant must select one`,
    };
  }
  return {
    resolved: true,
    selection: {
      connectionId,
      brokerId,
      environment,
      mode,
      externalAccountId: accountIds[0],
    },
  };
}

// ---------------------------------------------------------------------------
// The §8 binding authority
// ---------------------------------------------------------------------------

export interface ScreenConnectionAuthorityInput {
  env: Partial<Env>;
  /** Composition seam: when omitted, the KV membership store is composed from env. */
  memberships?: ExecutionContextAuthority["memberships"];
  /** Test/alt-host seam: credential presence for one broker+side. */
  hasCredentials?: (
    brokerId: BrokerId,
    side: TradingType,
  ) => Promise<boolean>;
  /**
   * Principal → login correspondence, from the authenticated
   * session. When omitted, the binding check is credential
   * presence only and the caller owns the correspondence.
   */
  loginForPrincipal?: (principalId: string) => Promise<string | undefined>;
}

/**
 * The `ExecutionContextAuthority` for screen runs: the #945 PDP
 * membership store (KV-backed in production) plus the connection
 * binding over the configured connections. A connection counts as
 * bound only when its login holds a credential for the broker+side
 * — and, when the caller supplies the principal→login mapping,
 * only when that login is the executing principal's.
 */
export function createScreenConnectionAuthority(
  input: ScreenConnectionAuthorityInput,
): ExecutionContextAuthority {
  const memberships =
    input.memberships ??
    createKvMembershipStore(sessionStore(input.env as Env));
  return {
    memberships,
    async isConnectionBound(binding) {
      const connection = parseConnectionId(binding.connectionId);
      if (!connection) return false;
      if (input.loginForPrincipal) {
        const login = await input.loginForPrincipal(binding.principalId);
        if (login === undefined || login.toLowerCase() !== connection.userLogin) {
          return false;
        }
      }
      const hasCredentials =
        input.hasCredentials ??
        ((broker: BrokerId, side: TradingType) =>
          defaultHasCredentials(
            input.env,
            connection.userLogin,
            broker,
            side,
          ));
      return hasCredentials(
        connection.brokerId,
        credentialSide(connection.environment),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The §8 context for a screen run
// ---------------------------------------------------------------------------

export interface ResolveScreenExecutionContextInput {
  principalId: string;
  tenantId: string;
  workspaceId?: string;
  taskId: string;
  serviceId: string;
  connectionId: string;
  externalAccountId?: string;
  /** TradingEnvironment TEST/PROD — mapped to context sandbox/live. */
  environment: TradingEnvironment;
  /** Defaults to `task:create`. The PDP permission authorizes
   *  creating the screen task; the connection itself is
   *  authorized by the binding check (credential ownership), not
   *  by the permission — `integration:use` stays admin-held for
   *  connect/manage operations (#2450) and would newly gate every
   *  member screen, which is out of scope for this slice. A
   *  caller may pass a stricter permission when the operation
   *  warrants it. */
  permission?: Parameters<typeof resolveExecutionContext>[1]["permission"];
  correlationId?: string;
  nowMs: number;
}

/**
 * Build the validated §8 `ExecutionContext` for a screen run from
 * the resolved selection. Thin mapping over
 * `resolveExecutionContext` — the PDP decision, the binding check,
 * and the fail-closed denials are the contract's, not this
 * module's. A denied resolution is a refusal of the run, never a
 * fallback context.
 */
export async function resolveScreenExecutionContext(
  authority: ExecutionContextAuthority,
  input: ResolveScreenExecutionContextInput,
): Promise<ResolveExecutionContextResult> {
  return resolveExecutionContext(authority, {
    principalId: input.principalId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    serviceId: input.serviceId,
    connectionId: input.connectionId,
    externalAccountId: input.externalAccountId,
    environment: screenEnvironmentToContextEnvironment(input.environment),
    permission: input.permission ?? "task:create",
    correlationId: input.correlationId,
    nowMs: input.nowMs,
  });
}
