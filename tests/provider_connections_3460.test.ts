import { describe, it, expect } from "vitest";
import {
  createMembership,
  createMemoryMembershipStore,
} from "../src/security/authorization";
import type { MembershipStore } from "../src/security/authorization";
import {
  parseExecutionContext,
  revalidateExecutionContext,
  serializeExecutionContext,
} from "../src/security/executionContext";
import {
  connectionIdFor,
  createScreenConnectionAuthority,
  parseConnectionId,
  resolveScreenExecutionContext,
  resolveScreenSelection,
  screenEnvironmentToContextEnvironment,
} from "../src/services/providerConnections";
import type { ScreenSelectionReaders } from "../src/services/providerConnections";

/**
 * Issue #3460 slice 1 — the provider-connection configuration seam.
 *
 * The screen path resolves ONE validated selection — (provider
 * connection, external account, environment) — from tenant-scoped
 * configuration, server-side, with no default broker and no
 * fail-open. Unconfigured, store-unavailable, unbound, or
 * cross-tenant ⇒ a named refusal, never E*TRADE.
 */

const NOW = 1_800_000_000_000;

function readers(
  overrides: Partial<ScreenSelectionReaders> = {},
): ScreenSelectionReaders {
  return {
    env: {},
    userLogin: "alice",
    commercial: {
      getTenantBrokerSelection: async () => "alpaca",
    },
    hasCredentials: async () => true,
    listAccounts: async () => ["acct-1"],
    ...overrides,
  };
}

async function seedMember(
  store: MembershipStore,
  internalUserId = "user-1",
  tenantId = "tenant-a",
): Promise<void> {
  const result = await createMembership(store, {
    internalUserId,
    tenantId,
    roleBindings: [
      { role: "member", scope: "tenant", grantedBy: "admin-1" },
    ],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
}

describe("connection ids", () => {
  it("derives a stable id from broker + environment + login", () => {
    expect(connectionIdFor("alpaca", "TEST", "Alice")).toBe(
      "alpaca:TEST:alice",
    );
    expect(connectionIdFor("etrade", "PROD", "bob")).toBe("etrade:PROD:bob");
  });

  it("round-trips through parse, and rejects malformed ids", () => {
    const id = connectionIdFor("alpaca", "PROD", "alice");
    expect(parseConnectionId(id)).toEqual({
      id,
      brokerId: "alpaca",
      environment: "PROD",
      userLogin: "alice",
    });
    expect(parseConnectionId("alpaca:PROD")).toBeNull();
    expect(parseConnectionId("unknown:TEST:alice")).toBeNull();
    expect(parseConnectionId("alpaca:SIDEWAYS:alice")).toBeNull();
    expect(parseConnectionId("alpaca:TEST:")).toBeNull();
    expect(parseConnectionId("")).toBeNull();
  });

  it("maps trading environments to context environments", () => {
    expect(screenEnvironmentToContextEnvironment("TEST")).toBe("sandbox");
    expect(screenEnvironmentToContextEnvironment("PROD")).toBe("live");
  });
});

describe("resolveScreenSelection — fail closed, no defaults", () => {
  it("resolves a configured Alpaca tenant to its connection + account", async () => {
    const result = await resolveScreenSelection(
      readers({ readSettingRaw: () => "TEST" }),
    );
    expect(result).toEqual({
      resolved: true,
      selection: {
        connectionId: "alpaca:TEST:alice",
        brokerId: "alpaca",
        environment: "TEST",
        mode: "paper",
        externalAccountId: "acct-1",
      },
    });
  });

  it("maps PROD to live for both brokers", async () => {
    const result = await resolveScreenSelection(
      readers({
        commercial: {
          getTenantBrokerSelection: async () => "etrade",
        },
        readSettingRaw: () => "PROD",
      }),
    );
    expect(result).toEqual({
      resolved: true,
      selection: {
        connectionId: "etrade:PROD:alice",
        brokerId: "etrade",
        environment: "PROD",
        mode: "live",
        externalAccountId: "acct-1",
      },
    });
  });

  it("refuses UNCONFIGURED when no broker selection is stored — never E*TRADE", async () => {
    const result = await resolveScreenSelection(
      readers({
        commercial: { getTenantBrokerSelection: async () => null },
      }),
    );
    expect(result).toEqual({
      resolved: false,
      code: "UNCONFIGURED",
      error: expect.stringContaining("no broker selection"),
    });
  });

  it("refuses STORE_UNAVAILABLE when the selection read throws — never fail-open", async () => {
    const result = await resolveScreenSelection(
      readers({
        commercial: {
          getTenantBrokerSelection: async () => {
            throw new Error("D1 down");
          },
        },
      }),
    );
    expect(result).toEqual({
      resolved: false,
      code: "STORE_UNAVAILABLE",
      error: expect.stringContaining("could not be read"),
    });
  });

  it("refuses UNCONFIGURED for a stored broker id that is not a known broker", async () => {
    const result = await resolveScreenSelection(
      readers({
        commercial: {
          getTenantBrokerSelection: async () => "fidelity",
        },
      }),
    );
    expect(result).toEqual({
      resolved: false,
      code: "UNCONFIGURED",
      error: expect.stringContaining("not a registered broker"),
    });
  });

  // Issue #4348 (S6) — a deployment's Alpaca key pair binds the connection.
  // The incident: schedule creation refused `CONNECTION_NOT_BOUND: no
  // credential ... for this login` for a signed-in owner whose account is
  // connected with the deployment keys, because the default check asked only
  // the per-user store.
  it("binds an Alpaca connection the deployment's key pair covers", async () => {
    const result = await resolveScreenSelection({
      env: {
        ALPACA_PAPER_API_KEY: "PK-DEPLOYMENT",
        ALPACA_PAPER_SECRET_KEY: "SK-DEPLOYMENT",
      } as never,
      userLogin: "owner@example.com",
      commercial: { getTenantBrokerSelection: async () => "alpaca" },
      readSettingRaw: () => "TEST",
      listAccounts: async () => ["acct-1"],
    });
    expect(result).toEqual({
      resolved: true,
      selection: {
        connectionId: "alpaca:TEST:owner@example.com",
        brokerId: "alpaca",
        environment: "TEST",
        mode: "paper",
        externalAccountId: "acct-1",
      },
    });
  });

  it("still refuses, naming both sources, when neither the login nor the deployment holds a pair", async () => {
    const result = await resolveScreenSelection({
      env: {} as never,
      userLogin: "owner@example.com",
      commercial: { getTenantBrokerSelection: async () => "alpaca" },
      readSettingRaw: () => "TEST",
      listAccounts: async () => ["acct-1"],
    });
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.code).toBe("CONNECTION_NOT_BOUND");
    expect(result.error).toContain("no stored credential for this login");
    expect(result.error).toContain("the deployment declares no key pair for paper");
  });

  it("refuses CONNECTION_NOT_BOUND when no credential exists for the selection", async () => {
    const result = await resolveScreenSelection(
      readers({ hasCredentials: async () => false }),
    );
    expect(result).toEqual({
      resolved: false,
      code: "CONNECTION_NOT_BOUND",
      error: expect.stringContaining("no credential"),
    });
  });

  it("refuses CONNECTION_HAS_NO_ACCOUNT when the connection has no accounts", async () => {
    const result = await resolveScreenSelection(
      readers({ listAccounts: async () => [] }),
    );
    expect(result).toEqual({
      resolved: false,
      code: "CONNECTION_HAS_NO_ACCOUNT",
      error: expect.stringContaining("no brokerage accounts"),
    });
  });

  it("refuses ACCOUNT_AMBIGUOUS when the connection has several accounts and none is selected", async () => {
    const result = await resolveScreenSelection(
      readers({ listAccounts: async () => ["acct-1", "acct-2"] }),
    );
    expect(result).toEqual({
      resolved: false,
      code: "ACCOUNT_AMBIGUOUS",
      error: expect.stringContaining("more than one"),
    });
  });
});

describe("createScreenConnectionAuthority — the §8 binding authority", () => {
  it("binds a connection whose credential exists for the principal's login", async () => {
    const authority = createScreenConnectionAuthority({
      env: {},
      hasCredentials: async () => true,
      loginForPrincipal: async (principalId) =>
        principalId === "user-1" ? "alice" : undefined,
    });
    expect(
      await authority.isConnectionBound({
        tenantId: "tenant-a",
        principalId: "user-1",
        connectionId: "alpaca:TEST:alice",
      }),
    ).toBe(true);
  });

  it("does not bind when no credential exists", async () => {
    const authority = createScreenConnectionAuthority({
      env: {},
      hasCredentials: async () => false,
      loginForPrincipal: async () => "alice",
    });
    expect(
      await authority.isConnectionBound({
        tenantId: "tenant-a",
        principalId: "user-1",
        connectionId: "alpaca:TEST:alice",
      }),
    ).toBe(false);
  });

  it("does not bind when the connection's login is not the principal's login", async () => {
    const authority = createScreenConnectionAuthority({
      env: {},
      hasCredentials: async () => true,
      loginForPrincipal: async () => "mallory",
    });
    expect(
      await authority.isConnectionBound({
        tenantId: "tenant-a",
        principalId: "user-1",
        connectionId: "alpaca:TEST:alice",
      }),
    ).toBe(false);
  });

  it("does not bind a malformed connection id", async () => {
    const authority = createScreenConnectionAuthority({
      env: {},
      hasCredentials: async () => true,
      loginForPrincipal: async () => "alice",
    });
    expect(
      await authority.isConnectionBound({
        tenantId: "tenant-a",
        principalId: "user-1",
        connectionId: "not-a-connection",
      }),
    ).toBe(false);
  });
});

describe("resolveScreenExecutionContext — the §8 context for a screen run", () => {
  it("resolves a frozen context carrying the selection", async () => {
    const memberships = createMemoryMembershipStore();
    await seedMember(memberships);
    const authority = createScreenConnectionAuthority({
      env: {},
      memberships,
      hasCredentials: async () => true,
      loginForPrincipal: async () => "alice",
    });
    const result = await resolveScreenExecutionContext(authority, {
      principalId: "user-1",
      tenantId: "tenant-a",
      taskId: "task-1",
      serviceId: "options-screen",
      connectionId: "alpaca:TEST:alice",
      externalAccountId: "acct-1",
      environment: "TEST",
      correlationId: "corr-1",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.context).toMatchObject({
      tenantId: "tenant-a",
      principalId: "user-1",
      initiatingPrincipalId: "user-1",
      taskId: "task-1",
      serviceId: "options-screen",
      connectionId: "alpaca:TEST:alice",
      externalAccountId: "acct-1",
      environment: "sandbox",
      correlationId: "corr-1",
    });
    expect(Object.isFrozen(result.context)).toBe(true);
  });

  it("round-trips across a boundary: serialize → parse → revalidate", async () => {
    const memberships = createMemoryMembershipStore();
    await seedMember(memberships);
    const authority = createScreenConnectionAuthority({
      env: {},
      memberships,
      hasCredentials: async () => true,
      loginForPrincipal: async () => "alice",
    });
    const result = await resolveScreenExecutionContext(authority, {
      principalId: "user-1",
      tenantId: "tenant-a",
      taskId: "task-1",
      serviceId: "options-screen",
      connectionId: "alpaca:TEST:alice",
      environment: "TEST",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const parsed = parseExecutionContext(
      serializeExecutionContext(result.context),
    );
    expect(parsed).not.toBeNull();
    expect(
      await revalidateExecutionContext(authority, parsed!, "task:create", NOW),
    ).toEqual({ ok: true });
  });

  it("denies a cross-tenant context", async () => {
    const memberships = createMemoryMembershipStore();
    await seedMember(memberships);
    const authority = createScreenConnectionAuthority({
      env: {},
      memberships,
      hasCredentials: async () => true,
      loginForPrincipal: async () => "alice",
    });
    const result = await resolveScreenExecutionContext(authority, {
      principalId: "user-1",
      tenantId: "tenant-b",
      taskId: "task-1",
      serviceId: "options-screen",
      connectionId: "alpaca:TEST:alice",
      environment: "TEST",
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("PDP_DENIED");
  });

  it("denies a context whose connection is not bound", async () => {
    const memberships = createMemoryMembershipStore();
    await seedMember(memberships);
    const authority = createScreenConnectionAuthority({
      env: {},
      memberships,
      hasCredentials: async () => false,
      loginForPrincipal: async () => "alice",
    });
    const result = await resolveScreenExecutionContext(authority, {
      principalId: "user-1",
      tenantId: "tenant-a",
      taskId: "task-1",
      serviceId: "options-screen",
      connectionId: "alpaca:TEST:alice",
      environment: "TEST",
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("CONNECTION_NOT_BOUND");
  });
});
