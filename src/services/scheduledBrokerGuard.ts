/**
 * Broker-aware scheduled-run auth guard (issue #3655).
 *
 * The scheduled guard was E*TRADE-only: it ran the E*TRADE preflight
 * before any broker resolution, so an Alpaca-broker tenant's scheduled
 * runs were blocked with FAILURE_AUTH_NO_SESSION naming E*TRADE even
 * though the tenant never selected E*TRADE. This module resolves the
 * tenant broker FIRST (fail-closed `readTenantBrokerSelection`) and
 * only then decides which credential check applies:
 *
 * - broker etrade → the caller runs the existing E*TRADE preflight,
 *   unchanged (this helper reports `legacy: true` for that case);
 * - broker unconfigured / store unreadable → likewise `legacy: true`,
 *   preserving the pre-#3655 behaviour for tenants with no readable
 *   selection instead of newly blocking runs that worked before;
 * - any other broker → `resolveScreenSelection` verifies that
 *   broker's credentials; a missing credential blocks LOUD with a
 *   coded, broker-named message. The E*TRADE preflight is never run
 *   for a non-etrade broker, and FAILURE_AUTH_NO_SESSION never names
 *   E*TRADE for an Alpaca tenant.
 *
 * Pure except for the injected readers; the production readers are
 * the real seams, the test seams are the optional overrides.
 */

import { codedMessage } from "../outcomes/outcomeAspects";
import type {
  ResolveScreenSelectionResult,
  TenantBrokerSelectionRead,
} from "./providerConnections";
import { BROKER_DISPLAY_NAMES } from "./tenantProviders";
import type { BrokerId } from "./tenantProviders";
import type { Env } from "../types";

export interface ScheduledBrokerGuardReaders {
  /** Test seam: broker read. Defaults to readTenantBrokerSelection(env). */
  readBroker?: () => Promise<TenantBrokerSelectionRead>;
  /** Test seam: selection resolution. Defaults to resolveScreenSelection. */
  resolveSelection?: (args: {
    env: Partial<Env>;
    userLogin: string;
    orm?: unknown;
  }) => Promise<ResolveScreenSelectionResult>;
}

export type ScheduledBrokerGuardResult =
  | {
      brokerId: BrokerId;
      blocked: false;
      /** True when the caller must run the legacy E*TRADE preflight. */
      legacy: false;
    }
  | {
      brokerId: BrokerId;
      blocked: false;
      legacy: true;
    }
  | {
      brokerId: BrokerId;
      blocked: true;
      legacy: false;
      /** Coded, broker-named refusal, e.g. `[FAILURE_AUTH_NO_SESSION] … Alpaca …`. */
      error: string;
      /** The resolveScreenSelection denial code. */
      code: string;
    }
  | {
      brokerId: null;
      blocked: false;
      legacy: true;
    };

/**
 * Resolve the tenant broker and, for a non-etrade broker, verify that
 * broker's credentials. Never throws: a reader failure is reported as
 * `legacy: true` (the caller keeps the pre-#3655 E*TRADE guard) rather
 * than inventing a broker or blocking a run on a read blip.
 */
export async function guardScheduledBrokerAuth(args: {
  env: Partial<Env>;
  userLogin: string;
  /** ORM for the production account lister, when the host has one. */
  orm?: unknown;
  readers?: ScheduledBrokerGuardReaders;
}): Promise<ScheduledBrokerGuardResult> {
  let brokerRead: TenantBrokerSelectionRead;
  try {
    // Issue #3655: the provider-connections module is imported
    // LAZILY, never statically. It sits on a load cycle with the
    // trading barrel (providerConnections → ../trading →
    // unifiedOptionsService → providerConnections); a static import
    // here would make scheduledTasks load it before the barrel and
    // bind unifiedOptionsService to the real reader instead of a
    // test's vi.mock of it (the #1718/#3186 options tests pin the
    // mocked E*TRADE path). Dynamic import resolves through the
    // installed module registry — the mock in tests, the real
    // reader in production.
    const { readTenantBrokerSelection } = await import("./providerConnections");
    brokerRead = args.readers?.readBroker
      ? await args.readers.readBroker()
      : await readTenantBrokerSelection(args.env);
  } catch {
    return { brokerId: null, blocked: false, legacy: true };
  }
  if (brokerRead.status !== "ok") {
    return { brokerId: null, blocked: false, legacy: true };
  }
  const brokerId = brokerRead.brokerId;
  if (brokerId === "etrade") {
    return { brokerId, blocked: false, legacy: true };
  }
  let selection: ResolveScreenSelectionResult;
  try {
    // Issue #3655: lazy import — same cycle as the broker read
    // above; never a static import of providerConnections here.
    const { resolveScreenSelection } = await import("./providerConnections");
    selection = args.readers?.resolveSelection
      ? await args.readers.resolveSelection({
          env: args.env,
          userLogin: args.userLogin,
          orm: args.orm,
        })
      : await resolveScreenSelection({
          env: args.env,
          userLogin: args.userLogin,
          ...(args.orm
            ? { orm: args.orm as never }
            : {}),
        });
  } catch (err) {
    return {
      brokerId,
      blocked: true,
      legacy: false,
      error: codedMessage(
        "FAILURE_AUTH_TOKEN_MISSING",
        `No ${brokerDisplayName(brokerId)} credential could be verified for this account: ${
          err instanceof Error ? err.message : String(err)
        }. Connect the ${brokerDisplayName(brokerId)} account before scheduling runs.`,
      ),
      code: "STORE_UNAVAILABLE",
    };
  }
  if (selection.resolved) {
    return { brokerId, blocked: false, legacy: false };
  }
  const display = brokerDisplayName(brokerId);
  return {
    brokerId,
    blocked: true,
    legacy: false,
    error: codedMessage(
      // Issue #3655: FAILURE_AUTH_NO_SESSION's catalog text names
      // E*TRADE ("No E*TRADE session is stored…"), so it must never
      // be emitted for a non-etrade broker. FAILURE_AUTH_TOKEN_MISSING
      // is the broker-neutral auth code; the detail names the broker.
      "FAILURE_AUTH_TOKEN_MISSING",
      `No ${display} credential is stored for this account (${selection.code}: ${selection.error}). Connect the ${display} account before scheduling runs.`,
    ),
    code: selection.code,
  };
}

export function brokerDisplayName(brokerId: BrokerId): string {
  return BROKER_DISPLAY_NAMES[brokerId] ?? brokerId;
}
