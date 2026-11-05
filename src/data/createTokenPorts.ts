/**
 * Issue #2434 (#1976 step 5c) — composition root for the
 * OAuth token family. This is the ONLY module that maps a
 * host's storage handles to the family's production
 * implementation: consumers import this helper and the port
 * types, never a funnel client for this family's buckets.
 *
 * The root is the family's funnel composition site: it builds
 * the etrade/public bucket KvLikes, the etrade lister, and
 * the per-call bucket factory (the Public credential-
 * reference seam's arbitrary namespaces) via createStoreKv /
 * listStoreEntries, all over the SAME SessionStore instance
 * the flag-off factories use, with `legacyFallback: false`
 * declared. Flag selection lives in the façades
 * (etradeOAuth's tokenFamilyPorts / getKv and publicOAuth's
 * equivalents), which call this root only when
 * TOKEN_PORTS_ENABLED is on (isTokenPortsEnabled in
 * tokenPorts.ts, #1169 semantics).
 *
 * The host services close over the env: environment
 * resolution is config/environment's resolveEnvironmentConfig
 * (the façade's own resolution, unchanged), and the alias
 * lookup reads through sessionStore(env) — the session
 * family's own composition — exactly as the façade's
 * resolveAliasLogin does.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from tokenPorts.ts (type-only), never this root.
 *
 * #CDO-mha7
 */
import { resolveEnvironmentConfig } from "../config/environment";
import {
  createStoreKv,
  listStoreEntries,
  type DoNamespaceLike,
} from "./durableKv";
import { lookupLoginByUserId } from "../security/iaaaMigration";
import { sessionStore } from "../security/session";
import type { Env } from "../types";
import { DoTokenFamilyAdapter } from "./doTokenFamilyAdapter";
import { InMemoryTokenFamilyAdapter } from "./inMemoryTokenFamilyAdapter";
import type { TokenFamilyBackend } from "./tokenFamilyKvImpl";
import type { TokenFamilyHost, TokenFamilyPorts } from "./tokenPorts";

export type { TokenFamilyPorts };
export { isTokenPortsEnabled } from "./tokenPorts";

function doFamily(
  namespace: DoNamespaceLike | undefined,
  host: TokenFamilyHost,
): TokenFamilyPorts {
  const backend: TokenFamilyBackend = {
    etradeKv: createStoreKv({
      namespace,
      namespaceName: "etrade",
      legacyFallback: false,
    }),
    publicKv: createStoreKv({
      namespace,
      namespaceName: "public",
      legacyFallback: false,
    }),
    listEtrade: (prefix) =>
      listStoreEntries({ namespace, namespaceName: "etrade", prefix }),
    bucketKv: (ns) =>
      createStoreKv({ namespace, namespaceName: ns, legacyFallback: false }),
    host,
  };
  return new DoTokenFamilyAdapter(backend);
}

/** Compose the family over an env's SessionStore binding. */
export function createTokenPorts(env: Env): TokenFamilyPorts {
  const namespace = env.SESSION_STORE as unknown as
    | DoNamespaceLike
    | undefined;
  return doFamily(namespace, {
    envName: (overrideEnv) => resolveEnvironmentConfig(env, overrideEnv).name,
    aliasLogin: async (internalUserId) => {
      try {
        return await lookupLoginByUserId(sessionStore(env), internalUserId);
      } catch {
        return null;
      }
    },
  });
}

/** Compose the family over a DO namespace directly (test seams / fakes). */
export function createTokenPortsFromNamespace(
  namespace: DoNamespaceLike | undefined,
  host: TokenFamilyHost,
): TokenFamilyPorts {
  return doFamily(namespace, host);
}

/** Compose the in-memory family (conformance / test doubles). */
export function createInMemoryTokenPorts(): TokenFamilyPorts {
  return new InMemoryTokenFamilyAdapter();
}
