/**
 * Issue #6151 item 7 (epic #6147, parent #1070) — the ONE shared
 * context resolution (`resolvePlatformContext`), slice 1 of the
 * universal execution context (Venus direction 2026-11-22).
 *
 * This module produces the #1078 Validated ExecutionContext
 * VERBATIM — the same field list, no second shape, no
 * nav-shaped subset, no new context type. It composes the
 * per-concern resolvers as internals and hands the composed
 * inputs to the contract's only constructor,
 * resolveExecutionContext:
 *
 *   identity   — resolvePlatformIdentity (tenant, tier, account)
 *   broker     — resolveTenantBroker (tenant default broker)
 *   provider   — resolveScreenProviderForRun (screen provider)
 *   run broker — resolveRunBrokerContext (broker, mode, account)
 *   roles      — the IAAA PDP, via resolveExecutionContext
 *
 * The per-concern resolvers are called ONLY here. The census
 * pin (tests/platform_context_census_6151.test.ts) fails any
 * other file in src/ that calls one directly; slices 2–3
 * (#6172/#6173) wire handlers to consume this resolution, and
 * each migration lowers its baseline entry in the same PR.
 *
 * Resolved once per session:
 * - The SESSION-SCOPED facts (identity, broker, screen
 *   provider) are read from the underlying stores once per
 *   session and cached in-isolate (TTL + max entries from
 *   config/platform-context.json); every consumer in the
 *   session sees the same values.
 * - The PDP authorization runs on EVERY call, by the #1078
 *   contract's design: revocation must deny at the point of
 *   use, so the membership decision is never cached — only
 *   the session facts are. Facts staleness is bounded by the
 *   TTL and by re-resolution on the defined events below.
 * - The run-broker concern is RUN-scoped, not session-scoped:
 *   it resolves per call. The caller's selection wins; absent
 *   a selection the cached tenant broker is passed as the
 *   "tenant" source, so the broker store is still read once
 *   per session. Its mode/capability steps run per call, as a
 *   run's mode is a property of the run.
 *
 * Re-resolution happens only on defined events
 * (PLATFORM_CONTEXT_RE_RESOLUTION_EVENTS): sign-in,
 * subscription change (payment webhook / operator grant),
 * role change, tenant change. The webhook/grant call sites
 * that invoke invalidatePlatformContextSession are follow-on
 * wiring (named in the PR); this slice builds the mechanism,
 * not the call sites.
 *
 * Roles are enforced by the PDP at resolution (the caller's
 * permission against the memberships' RoleBindings), not
 * carried as a field: #1078's field list has no roles field,
 * and the Consistency rule forbids adding one here.
 *
 * platformId is caller-supplied and passed through, validated
 * by the contract when present. No platform registry is
 * invented in this slice: docs/agentic-org/platforms.md
 * defines the federated platforms but no id registry exists
 * in code, and inventing one would be a second system. A
 * registry, if wanted, is a follow-up — slices 2–3 stamp the
 * platformId their request belongs to.
 *
 * Fail-closed throughout: no tenant, unbound stores, a broker
 * or run-broker refusal, and every contract denial are typed
 * denials, never throws and never partial contexts. Time is
 * the caller-supplied nowMs seam, never Date.now() inside a
 * decision — including the cache TTL.
 */
import { PLATFORM_CONTEXT_LIMITS, type PlatformContextCacheLimits } from "../config/platformContext";
import type { CommercialStore, StoreTier } from "../data/commercialPorts";
import type { SubscriptionStore } from "../data/subscriptionPorts";
import {
  resolveExecutionContext,
  type ContextDenyCode,
  type ExecutionContext,
  type ExecutionContextAuthority,
  type ExecutionDispatchMode,
  type ExecutionEnvironment,
  type ExecutionMode,
  type ResolveExecutionContextResult,
} from "./executionContext";
import type { ActorType } from "./iaaaAudit";
import type { Env } from "../types";
import type { Permission } from "./authorization";
import {
  resolvePlatformIdentity,
  type PlatformIdentity,
} from "../services/platformIdentity";
import {
  isBrokerId,
  resolveScreenProviderForRun,
  resolveTenantBroker,
  type BrokerId,
} from "../services/tenantProviders";
import {
  resolveRunBrokerContext,
  type BrokerCapability,
  type RunBrokerContext,
  type RunBrokerSelection,
} from "../services/runBrokerContext";
import type { StockScreenProvider } from "../trading";

/** The defined re-resolution events — "once" never means stale. */
export const PLATFORM_CONTEXT_RE_RESOLUTION_EVENTS = [
  "sign-in",
  "subscription-change",
  "role-change",
  "tenant-change",
] as const;

export type PlatformContextReResolutionEvent =
  (typeof PLATFORM_CONTEXT_RE_RESOLUTION_EVENTS)[number];

/**
 * Port inputs for the resolution (ADR 0002: port interfaces
 * only). The real D1 adapters satisfy these structurally;
 * tests pass memory/partial fakes.
 */
export interface PlatformContextPorts {
  commercial: CommercialStore | null;
  subscriptions: SubscriptionStore | null;
}

export interface PlatformContextSources {
  authority: ExecutionContextAuthority;
  ports: PlatformContextPorts;
  /** Env the broker/provider concerns read (same as today). */
  env: unknown;
  /** Cache limits; defaults to config/platform-context.json. */
  limits?: PlatformContextCacheLimits;
  /** Test seams — production callers use the defaults. */
  resolveIdentity?: typeof resolvePlatformIdentity;
  resolveBroker?: typeof resolveTenantBroker;
  resolveScreenProvider?: typeof resolveScreenProviderForRun;
  resolveRunBroker?: typeof resolveRunBrokerContext;
}

export interface ResolvePlatformContextInput {
  /** Authenticated principal (Slice 1 internal user id). */
  principalId: string;
  principalType?: ActorType;
  /** Defaults to principalId. A different initiator requires delegationId. */
  initiatingPrincipalId?: string;
  /** The session the facts are resolved once for. Required. */
  sessionId: string;
  taskId: string;
  serviceId: string;
  /** PDP permission the operation this context authorizes requires. */
  permission: Permission;
  environment: ExecutionEnvironment;
  nowMs: number;
  workspaceId?: string;
  agentRunId?: string;
  delegationId?: string;
  connectionId?: string;
  externalAccountId?: string;
  platformId?: string;
  runId?: string;
  traceId?: string;
  correlationId?: string;
  dispatchMode?: ExecutionDispatchMode;
  execMode?: ExecutionMode;
  consequential?: boolean;
  approvalReference?: string;
  /** The run's broker selection; absent, the cached tenant broker wins. */
  runSelection?: RunBrokerSelection;
  /** The schedule's environment (TEST/PROD) for mode inference. */
  runEnvironment?: string;
  /** When set, the broker must declare this capability or the run is refused. */
  requireCapability?: BrokerCapability;
}

export type PlatformContextDenyCode =
  | ContextDenyCode
  | "NO_TENANT"
  | "STORE_UNAVAILABLE"
  | "BROKER_UNAVAILABLE";

export type PlatformContextResult =
  | {
      ok: true;
      /** The validated #1078 context — the ONLY context shape. */
      context: ExecutionContext;
      /** Tenant default broker (session fact). */
      broker: BrokerId;
      /** Screen provider (session fact; null when not a screen provider). */
      screenProvider: StockScreenProvider | null;
      /** Effective tier at resolution (session fact). */
      tier: StoreTier;
      /** Run-scoped broker context (resolved per call). */
      runBroker: RunBrokerContext;
      /** True when the session facts came from the cache. */
      factsFromCache: boolean;
    }
  | { ok: false; code: PlatformContextDenyCode; error: string };

/** The session-scoped facts — everything cached once per session. */
interface PlatformContextFacts {
  identity: PlatformIdentity;
  broker: BrokerId;
  screenProvider: StockScreenProvider | null;
}

const sessionFactsCache = new Map<
  string,
  { facts: PlatformContextFacts; resolvedAtMs: number }
>();

function cacheKey(principalId: string, sessionId: string): string {
  return `${principalId}\n${sessionId}`;
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveIdentityFacts(
  sources: PlatformContextSources,
  input: ResolvePlatformContextInput,
): Promise<PlatformIdentity> {
  const memberships = await sources.authority.memberships.getMembershipsByUser(
    input.principalId,
  );
  const resolveIdentity = sources.resolveIdentity ?? resolvePlatformIdentity;
  return resolveIdentity(sources.ports, {
    userId: input.principalId,
    nowMs: input.nowMs,
    memberships: memberships.map((m) => ({
      membershipId: m.membershipId,
      tenantId: m.tenantId,
      createdAtMs: m.createdAtMs,
      revokedAtMs: m.revokedAtMs,
    })),
  });
}

async function resolveBrokerFacts(
  sources: PlatformContextSources,
): Promise<{
  broker: BrokerId;
  screenProvider: StockScreenProvider | null;
}> {
  // Explicit default calls (not seam references): the composition
  // points are the module's core contract, and the census pin
  // reads them literally — this module is the one allowed
  // composer of the per-concern resolvers.
  const [broker, screenProvider] = await Promise.all([
    sources.resolveBroker !== undefined
      ? sources.resolveBroker(sources.env)
      : resolveTenantBroker(sources.env),
    sources.resolveScreenProvider !== undefined
      ? sources.resolveScreenProvider(sources.env)
      : resolveScreenProviderForRun(sources.env),
  ]);
  return { broker, screenProvider };
}

/**
 * Resolve the one shared context for a session + request.
 * Any failed check denies the whole resolution; there is no
 * partial context and no fallback identity.
 */
export async function resolvePlatformContext(
  sources: PlatformContextSources,
  input: ResolvePlatformContextInput,
): Promise<PlatformContextResult> {
  const limits = sources.limits ?? PLATFORM_CONTEXT_LIMITS;
  if (!isValidId(input.sessionId)) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      error: "sessionId must be a non-empty string",
    };
  }
  const key = cacheKey(input.principalId, input.sessionId);
  const cached = sessionFactsCache.get(key);
  let facts: PlatformContextFacts;
  let factsFromCache = false;
  if (
    cached !== undefined &&
    input.nowMs - cached.resolvedAtMs < limits.cacheTtlMs
  ) {
    facts = cached.facts;
    factsFromCache = true;
  } else {
    // Two stages, two named refusals: the identity concern
    // throws on unbound stores / unreadable tiers; the broker
    // concern throws on unreadable selections. Both are
    // denials here, never a throw to the caller.
    let identity: PlatformIdentity;
    try {
      identity = await resolveIdentityFacts(sources, input);
    } catch (err) {
      return {
        ok: false,
        code: "STORE_UNAVAILABLE",
        error: messageOf(err),
      };
    }
    let brokerFacts: { broker: BrokerId; screenProvider: StockScreenProvider | null };
    try {
      brokerFacts = await resolveBrokerFacts(sources);
    } catch (err) {
      return {
        ok: false,
        code: "BROKER_UNAVAILABLE",
        error: messageOf(err),
      };
    }
    facts = { identity, ...brokerFacts };
    if (sessionFactsCache.size >= limits.cacheMaxEntries) {
      // Oldest-out eviction (insertion order): the oldest session
      // leaves first, never the session being resolved.
      const oldest = sessionFactsCache.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        sessionFactsCache.delete(oldest);
      }
    }
    sessionFactsCache.set(key, { facts, resolvedAtMs: input.nowMs });
  }

  // The tenant is resolved, never invented: the canonical current
  // tenant (account > membership) wins; no row anywhere denies.
  const tenantId =
    facts.identity.currentTenantId ?? facts.identity.tenantId;
  if (tenantId === null) {
    return {
      ok: false,
      code: "NO_TENANT",
      error: "no tenant resolves for this principal in this session",
    };
  }

  // Run-scoped broker context, resolved per call. The caller's
  // selection wins; absent one, the cached tenant broker is
  // passed as the "tenant" source, so the broker store is still
  // read once per session — resolveRunBrokerContext never
  // re-reads the tenant broker here.
  const explicitBroker =
    input.runSelection !== undefined && isBrokerId(input.runSelection.brokerId)
      ? input.runSelection.brokerId
      : null;
  let runBroker: RunBrokerContext;
  try {
    // Explicit default call (see resolveBrokerFacts): the census
    // pin reads this composition point literally.
    runBroker =
      sources.resolveRunBroker !== undefined
        ? await sources.resolveRunBroker({
            env: sources.env as Env,
            environment: input.runEnvironment,
            selection: {
              ...input.runSelection,
              brokerId: explicitBroker ?? facts.broker,
              source: explicitBroker
                ? (input.runSelection?.source ?? "caller")
                : "tenant",
            },
            requireCapability: input.requireCapability,
          })
        : await resolveRunBrokerContext({
            env: sources.env as Env,
            environment: input.runEnvironment,
            selection: {
              ...input.runSelection,
              brokerId: explicitBroker ?? facts.broker,
              source: explicitBroker
                ? (input.runSelection?.source ?? "caller")
                : "tenant",
            },
            requireCapability: input.requireCapability,
          });
  } catch (err) {
    return { ok: false, code: "BROKER_UNAVAILABLE", error: messageOf(err) };
  }

  // The run-broker account is the external account — but the
  // contract requires a connectionId for any externalAccountId,
  // so without a connection the account stays in the run-broker
  // output only, never smuggled into the context.
  const externalAccountId =
    input.externalAccountId ??
    (input.connectionId !== undefined ? (runBroker.accountId ?? undefined) : undefined);

  const resolution: ResolveExecutionContextResult =
    await resolveExecutionContext(sources.authority, {
      principalId: input.principalId,
      principalType: input.principalType,
      initiatingPrincipalId: input.initiatingPrincipalId,
      tenantId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      agentRunId: input.agentRunId,
      delegationId: input.delegationId,
      serviceId: input.serviceId,
      connectionId: input.connectionId,
      externalAccountId,
      environment: input.environment,
      permission: input.permission,
      consequential: input.consequential,
      entitlementReference: `tier:${facts.identity.tier}`,
      approvalReference: input.approvalReference,
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      runId: input.runId,
      platformId: input.platformId,
      traceId: input.traceId,
      dispatchMode: input.dispatchMode,
      execMode: input.execMode,
      nowMs: input.nowMs,
    });
  if (!resolution.ok) {
    return { ok: false, code: resolution.code, error: resolution.error };
  }
  return {
    ok: true,
    context: resolution.context,
    broker: facts.broker,
    screenProvider: facts.screenProvider,
    tier: facts.identity.tier,
    runBroker,
    factsFromCache,
  };
}

/**
 * Drop a session's cached facts on a defined re-resolution
 * event, so the next resolution re-reads the stores. Returns
 * true when an entry was dropped. An event outside the defined
 * set is a no-op (never silently a re-resolution trigger).
 */
export function invalidatePlatformContextSession(
  sessionId: string,
  event: PlatformContextReResolutionEvent,
): boolean {
  if (
    !(PLATFORM_CONTEXT_RE_RESOLUTION_EVENTS as readonly string[]).includes(
      event,
    )
  ) {
    return false;
  }
  let dropped = false;
  for (const key of [...sessionFactsCache.keys()]) {
    if (key.endsWith(`\n${sessionId}`)) {
      sessionFactsCache.delete(key);
      dropped = true;
    }
  }
  return dropped;
}
