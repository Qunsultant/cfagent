/**
 * Issue #2433 (#1976 step 5b) — composition root for the
 * session/identity family. This is the ONLY module that maps
 * a host's storage handles to the family's production
 * implementation: consumers import this helper and the port
 * types, never a funnel client for this family's bucket.
 *
 * The root is the family's funnel composition site: it builds
 * the sessions-bucket KvLike via createStoreKv and the
 * listing seam via listStoreEntries, both over the SAME
 * SessionStore instance the flag-off factories use, with
 * `legacyFallback: false` declared. Flag selection lives in
 * the factories (sessionStore(env) and its wired siblings in
 * session.ts / iaaaLogin.ts), which call this root only when
 * SESSION_PORTS_ENABLED is on (isSessionPortsEnabled in
 * sessionPorts.ts, #1169 semantics).
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from sessionPorts.ts (type-only), never this root.
 *
 * #CDO-mha7
 */
import {
  createStoreKv,
  listStoreEntries,
  type DoNamespaceLike,
} from "./durableKv";
import type { Env } from "../types";
import type {
  ResourceAttribution,
  ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";
import { DoSessionFamilyAdapter } from "./doSessionFamilyAdapter";
import { InMemorySessionFamilyAdapter } from "./inMemorySessionFamilyAdapter";
import type { SessionFamilyPorts } from "./sessionPorts";

export type { SessionFamilyPorts };
export { isSessionPortsEnabled } from "./sessionPorts";

/** Compose the family over an env's SessionStore binding. */
export function createSessionPorts(
  env: Env,
  resource?: {
    attribution?: ResourceAttribution;
    resourceSink?: ResourceUsagePort;
  },
): SessionFamilyPorts {
  const namespace = env.SESSION_STORE as unknown as
    | DoNamespaceLike
    | undefined;
  const kv = createStoreKv({
    namespace,
    namespaceName: "sessions",
    legacyFallback: false,
    attribution: resource?.attribution,
    resourceSink: resource?.resourceSink,
  });
  return new DoSessionFamilyAdapter(kv, (prefix) =>
    listStoreEntries({
      namespace,
      namespaceName: "sessions",
      prefix,
    }),
  );
}

/** Compose the family over a DO namespace directly (test seams / fakes). */
export function createSessionPortsFromNamespace(
  namespace: DoNamespaceLike | undefined,
  resource?: {
    attribution?: ResourceAttribution;
    resourceSink?: ResourceUsagePort;
  },
): SessionFamilyPorts {
  const kv = createStoreKv({
    namespace,
    namespaceName: "sessions",
    legacyFallback: false,
    attribution: resource?.attribution,
    resourceSink: resource?.resourceSink,
  });
  return new DoSessionFamilyAdapter(kv, (prefix) =>
    listStoreEntries({
      namespace,
      namespaceName: "sessions",
      prefix,
    }),
  );
}

/** Compose the in-memory family (conformance / test doubles). */
export function createInMemorySessionPorts(): SessionFamilyPorts {
  return new InMemorySessionFamilyAdapter();
}
