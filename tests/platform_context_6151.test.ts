// @vitest-environment node
/**
 * #6151 item 7 — the one shared context resolution
 * (`resolvePlatformContext`, slice 1 of the universal execution
 * context, Venus direction 2026-11-22).
 *
 * The resolver produces the #1078 Validated ExecutionContext
 * VERBATIM — the same field list, no second shape, no nav-shaped
 * subset: it composes the per-concern resolvers as internals
 * (identity via resolvePlatformIdentity, broker via
 * resolveTenantBroker, screen provider via
 * resolveScreenProviderForRun, run broker via
 * resolveRunBrokerContext) and hands the composed inputs to the
 * contract's only constructor, resolveExecutionContext.
 *
 * Rules pinned here:
 * - Resolved once per session: the session-scoped facts
 *   (identity, broker, screen provider) are read from the
 *   underlying stores once per session; every consumer in the
 *   session sees the same values. The PDP authorization itself
 *   runs on EVERY call, by the #1078 contract's design —
 *   revocation must deny at the point of use, so the membership
 *   decision is never cached; only the session facts are.
 * - The run-broker concern is run-scoped, not session-scoped:
 *   it resolves per call (the caller's selection wins; absent a
 *   selection the cached tenant broker is passed as the
 *   "tenant" source, so the broker store is still read once).
 * - Fail-closed throughout: no tenant, unbound stores, a broker
 *   or run-broker refusal, and every contract denial are
 *   denials, never throws and never partial contexts.
 * - No second shape: the returned context round-trips through
 *   parseExecutionContext (the contract's own shape check).
 * - Roles are enforced by the PDP at resolution (the caller's
 *   permission against the memberships' RoleBindings), not
 *   carried as a field — #1078's field list has no roles field,
 *   and the Consistency rule forbids adding one here.
 * - platformId is caller-supplied and passed through; no
 *   platform registry is invented in this slice.
 * - Time is the caller-supplied nowMs seam, never Date.now().
 *
 * The session-facts cache is module-level, so every test uses
 * its own sessionId — a shared session would make one test's
 * cached facts leak into the next test's counts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_POLICY_VERSION,
  createMemoryMembershipStore,
  createMembership,
  type MembershipStore,
} from "../src/security/authorization";
import type { ExecutionContextAuthority } from "../src/security/executionContext";
import {
  parseExecutionContext,
  serializeExecutionContext,
} from "../src/security/executionContext";
import {
  invalidatePlatformContextSession,
  PLATFORM_CONTEXT_RE_RESOLUTION_EVENTS,
  resolvePlatformContext,
  type PlatformContextSources,
  type ResolvePlatformContextInput,
} from "../src/security/platformContext";
import { PLATFORM_CONTEXT_LIMITS } from "../src/config/platformContext";
import type { CommercialStore } from "../src/data/commercialPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import type { PlatformIdentity } from "../src/services/platformIdentity";

const NOW = 1_800_000_000_000;

async function seedMember(
  store: MembershipStore,
  overrides: {
    internalUserId?: string;
    tenantId?: string;
    role?: "member" | "tenant-admin" | "workspace-admin";
  } = {},
): Promise<void> {
  const result = await createMembership(store, {
    internalUserId: overrides.internalUserId ?? "user-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    roleBindings: [
      {
        role: overrides.role ?? "member",
        scope: "tenant",
        grantedBy: "admin-1",
      },
    ],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
}

function authority(memberships: MembershipStore): ExecutionContextAuthority {
  return {
    memberships,
    async isConnectionBound(): Promise<boolean> {
      return true;
    },
  };
}

function memoryPorts() {
  const getAccount = vi.fn(async (_userId: string) => ({
    id: "acct-1",
    tenantId: "tenant-a",
    tier: "Subscribed" as const,
    tierSource: "subscription" as const,
    creditsUSD: 0,
    includedRuns: 0,
    updatedAtMs: NOW,
  }));
  const listSubscriptions = vi.fn(async (_userId: string) => [
    { periodEndMs: NOW + 1 },
  ]);
  return {
    getAccount,
    listSubscriptions,
    commercial: {
      getAccount,
    } as unknown as CommercialStore,
    subscriptions: {
      listSubscriptions,
    } as unknown as SubscriptionStore,
  };
}

function countingSeams() {
  const identity: PlatformIdentity = {
    userLogin: "user-1",
    tenantId: "tenant-a",
    currentTenantId: "tenant-a",
    currentTenantSource: "account",
    candidateMembershipTenants: ["tenant-a"],
    hasAccount: true,
    tier: "Subscribed",
    creditsUSD: 0,
    includedRunsRemaining: 0,
    stored: null,
  };
  return {
    identity,
    resolveIdentity: vi.fn(async () => identity),
    resolveBroker: vi.fn(async () => "alpaca" as const),
    resolveScreenProvider: vi.fn(async () => "alpaca" as const),
    resolveRunBroker: vi.fn(async () => ({
      brokerId: "alpaca" as const,
      mode: "paper" as const,
      modeSource: "selection" as const,
      accountId: null as string | null,
      source: "tenant" as const,
    })),
  };
}

function baseInput(
  overrides: Partial<ResolvePlatformContextInput> = {},
): ResolvePlatformContextInput {
  return {
    principalId: "user-1",
    sessionId: "session-1",
    taskId: "task-1",
    serviceId: "screener",
    permission: "task:create",
    environment: "sandbox",
    nowMs: NOW,
    ...overrides,
  };
}

async function sourcesWithSeams(
  seams: ReturnType<typeof countingSeams>,
  memberships: MembershipStore,
): Promise<PlatformContextSources> {
  const ports = memoryPorts();
  return {
    authority: authority(memberships),
    ports: { commercial: ports.commercial, subscriptions: ports.subscriptions },
    env: {},
    resolveIdentity: seams.resolveIdentity,
    resolveBroker: seams.resolveBroker,
    resolveScreenProvider: seams.resolveScreenProvider,
    resolveRunBroker: seams.resolveRunBroker,
  };
}

describe("resolvePlatformContext", () => {
  it("resolves a validated ExecutionContext verbatim from the composed concerns", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    const sources = await sourcesWithSeams(seams, store);
    const result = await resolvePlatformContext(
      sources,
      baseInput({
        sessionId: "session-verbatim",
        runId: "run-1",
        platformId: "nextgentp",
        traceId: "trace-1",
        dispatchMode: "manual",
        execMode: "async",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected resolution");
    expect(result.context.tenantId).toBe("tenant-a");
    expect(result.context.principalId).toBe("user-1");
    expect(result.context.policyVersion).toBe(AUTHORIZATION_POLICY_VERSION);
    expect(result.context.entitlementReference).toBe("tier:Subscribed");
    expect(result.context.sessionId).toBe("session-verbatim");
    expect(result.context.runId).toBe("run-1");
    expect(result.context.platformId).toBe("nextgentp");
    expect(result.context.traceId).toBe("trace-1");
    expect(result.context.dispatchMode).toBe("manual");
    expect(result.context.execMode).toBe("async");
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(result.broker).toBe("alpaca");
    expect(result.screenProvider).toBe("alpaca");
    expect(result.tier).toBe("Subscribed");
    expect(result.runBroker.brokerId).toBe("alpaca");
    expect(result.factsFromCache).toBe(false);
    // No second shape: the contract's own shape check accepts it.
    expect(
      parseExecutionContext(serializeExecutionContext(result.context)),
    ).toEqual(result.context);
  });

  it("resolves the session facts once per session across calls", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    const sources = await sourcesWithSeams(seams, store);
    const first = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-once" }),
    );
    const second = await resolvePlatformContext(
      sources,
      baseInput({
        sessionId: "session-once",
        taskId: "task-2",
        serviceId: "copilot",
      }),
    );
    const third = await resolvePlatformContext(
      sources,
      baseInput({
        sessionId: "session-once",
        taskId: "task-3",
        serviceId: "billing",
      }),
    );
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) throw new Error("expected resolutions");
    // Each per-concern resolver ran once; every consumer sees the same facts.
    expect(seams.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(seams.resolveBroker).toHaveBeenCalledTimes(1);
    expect(seams.resolveScreenProvider).toHaveBeenCalledTimes(1);
    expect(seams.resolveRunBroker).toHaveBeenCalledTimes(3);
    expect(first.factsFromCache).toBe(false);
    expect(second.factsFromCache).toBe(true);
    expect(third.factsFromCache).toBe(true);
    expect(second.context.tenantId).toBe(first.context.tenantId);
    expect(second.context.entitlementReference).toBe(
      first.context.entitlementReference,
    );
    expect(third.context.sessionId).toBe(first.context.sessionId);
    // The contexts themselves are per-call (task/service differ).
    expect(second.context.taskId).toBe("task-2");
    expect(third.context.serviceId).toBe("billing");
  });

  it("re-resolves the facts only on a defined re-resolution event", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    const sources = await sourcesWithSeams(seams, store);
    await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-reresolve" }),
    );
    expect(seams.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(
      invalidatePlatformContextSession(
        "session-reresolve",
        "subscription-change",
      ),
    ).toBe(true);
    expect(
      invalidatePlatformContextSession(
        "session-reresolve",
        "subscription-change",
      ),
    ).toBe(false);
    const again = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-reresolve" }),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("expected resolution");
    expect(again.factsFromCache).toBe(false);
    expect(seams.resolveIdentity).toHaveBeenCalledTimes(2);
    expect(seams.resolveBroker).toHaveBeenCalledTimes(2);
  });

  it("names exactly the defined re-resolution events", () => {
    expect([...PLATFORM_CONTEXT_RE_RESOLUTION_EVENTS]).toEqual([
      "sign-in",
      "subscription-change",
      "role-change",
      "tenant-change",
    ]);
  });

  it("pins the externalized cache limits (config, never hardcoded)", () => {
    expect(PLATFORM_CONTEXT_LIMITS.cacheTtlMs).toBeGreaterThan(0);
    expect(PLATFORM_CONTEXT_LIMITS.cacheMaxEntries).toBeGreaterThan(0);
    expect(PLATFORM_CONTEXT_LIMITS.cacheTtlMs).toBe(60_000);
    expect(PLATFORM_CONTEXT_LIMITS.cacheMaxEntries).toBe(2000);
  });

  it("re-resolves expired facts after the configured TTL", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    const ports = memoryPorts();
    const sources: PlatformContextSources = {
      authority: authority(store),
      ports: { commercial: ports.commercial, subscriptions: ports.subscriptions },
      env: {},
      limits: { cacheTtlMs: 1000, cacheMaxEntries: 2000 },
      resolveIdentity: seams.resolveIdentity,
      resolveBroker: seams.resolveBroker,
      resolveScreenProvider: seams.resolveScreenProvider,
      resolveRunBroker: seams.resolveRunBroker,
    };
    await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-ttl", nowMs: NOW }),
    );
    await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-ttl", nowMs: NOW + 999 }),
    );
    expect(seams.resolveIdentity).toHaveBeenCalledTimes(1);
    await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-ttl", nowMs: NOW + 1000 }),
    );
    expect(seams.resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest session when the cache is full", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    const ports = memoryPorts();
    const sources: PlatformContextSources = {
      authority: authority(store),
      ports: { commercial: ports.commercial, subscriptions: ports.subscriptions },
      env: {},
      limits: { cacheTtlMs: 60_000, cacheMaxEntries: 2 },
      resolveIdentity: seams.resolveIdentity,
      resolveBroker: seams.resolveBroker,
      resolveScreenProvider: seams.resolveScreenProvider,
      resolveRunBroker: seams.resolveRunBroker,
    };
    // Five inserts through a 2-entry cache: whatever earlier
    // tests left behind, the cache converges to the two most
    // recent sessions — so the first session is evicted and
    // re-resolves on the next call.
    for (const n of [1, 2, 3, 4, 5]) {
      await resolvePlatformContext(
        sources,
        baseInput({ sessionId: `session-evict-${n}` }),
      );
    }
    expect(seams.resolveIdentity).toHaveBeenCalledTimes(5);
    const again = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-evict-1" }),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("expected resolution");
    expect(again.factsFromCache).toBe(false);
    expect(seams.resolveIdentity).toHaveBeenCalledTimes(6);
  });

  it("denies when no tenant resolves, never inventing one", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    seams.identity.currentTenantId = null;
    seams.identity.tenantId = null;
    const sources = await sourcesWithSeams(seams, store);
    const result = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-no-tenant" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("NO_TENANT");
  });

  it("denies when a store is unbound", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const sources: PlatformContextSources = {
      authority: authority(store),
      ports: { commercial: null, subscriptions: null },
      env: {},
    };
    const result = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-unbound" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("STORE_UNAVAILABLE");
  });

  it("denies when the broker concern fails", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    seams.resolveBroker.mockRejectedValue(new Error("broker store down"));
    const sources = await sourcesWithSeams(seams, store);
    const result = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-broker-fail" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("BROKER_UNAVAILABLE");
  });

  it("denies when the run-broker concern refuses (capability / mode)", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    seams.resolveRunBroker.mockRejectedValue(
      new Error("alpaca does not declare optionChains"),
    );
    const sources = await sourcesWithSeams(seams, store);
    const result = await resolvePlatformContext(
      sources,
      baseInput({
        sessionId: "session-runbroker-fail",
        requireCapability: "optionChains",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("BROKER_UNAVAILABLE");
  });

  it("propagates the contract's PDP denial verbatim", async () => {
    const store = createMemoryMembershipStore();
    // No membership seeded: the PDP denies.
    const seams = countingSeams();
    const sources = await sourcesWithSeams(seams, store);
    const result = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-pdp" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("PDP_DENIED");
  });

  it("denies a resolution with no session", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    const sources = await sourcesWithSeams(seams, store);
    const result = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "   " }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("INVALID_FIELD");
  });

  it("denies an unknown dispatch mode, never defaulting", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    const sources = await sourcesWithSeams(seams, store);
    const result = await resolvePlatformContext(
      sources,
      baseInput({
        sessionId: "session-bad-mode",
        dispatchMode: "smoke-signal" as never,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("INVALID_FIELD");
  });

  it("carries the run-broker account into the context only with a connection", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const seams = countingSeams();
    seams.resolveRunBroker.mockResolvedValue({
      brokerId: "alpaca",
      mode: "paper",
      modeSource: "selection",
      accountId: "acct-external-1",
      source: "tenant",
    });
    const sources = await sourcesWithSeams(seams, store);
    const withoutConnection = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "s-no-conn" }),
    );
    expect(withoutConnection.ok).toBe(true);
    if (!withoutConnection.ok) throw new Error("expected resolution");
    expect(withoutConnection.context.externalAccountId).toBeUndefined();
    expect(withoutConnection.runBroker.accountId).toBe("acct-external-1");
    const withConnection = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "s-conn", connectionId: "conn-1" }),
    );
    expect(withConnection.ok).toBe(true);
    if (!withConnection.ok) throw new Error("expected resolution");
    expect(withConnection.context.externalAccountId).toBe("acct-external-1");
    expect(withConnection.context.connectionId).toBe("conn-1");
  });

  it("composes the real identity concern end to end (no seams)", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const ports = memoryPorts();
    const sources: PlatformContextSources = {
      authority: authority(store),
      ports: { commercial: ports.commercial, subscriptions: ports.subscriptions },
      env: {},
      runSelection: { brokerId: "alpaca", mode: "paper", source: "caller" },
    };
    const result = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-real" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected resolution, got ${result.code}`);
    expect(result.context.tenantId).toBe("tenant-a");
    expect(result.context.entitlementReference).toBe("tier:Subscribed");
    expect(result.tier).toBe("Subscribed");
    expect(result.runBroker.mode).toBe("paper");
    // The identity stores were read once for the session...
    expect(ports.getAccount).toHaveBeenCalledTimes(1);
    expect(ports.listSubscriptions).toHaveBeenCalledTimes(1);
    // ...and a second call in the same session reads them zero more times.
    const second = await resolvePlatformContext(
      sources,
      baseInput({ sessionId: "session-real", taskId: "task-2" }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected resolution");
    expect(second.factsFromCache).toBe(true);
    expect(ports.getAccount).toHaveBeenCalledTimes(1);
    expect(ports.listSubscriptions).toHaveBeenCalledTimes(1);
  });
});
