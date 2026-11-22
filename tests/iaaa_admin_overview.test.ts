import { describe, it, expect } from "vitest";
import {
  buildAdminOverview,
  IAAA_ADMIN_OVERVIEW_LIMIT,
  type AdminOverviewDeps,
} from "../src/security/iaaaAdminOverview";
import { checkPlatformPermission } from "../src/security/iaaaPdpSeam";
import { createMemoryMembershipStore } from "../src/security/authorization";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import type { IaaaAuditEvent, AuditStore } from "../src/security/iaaaAudit";
import type { Membership } from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";

/**
 * #945 IAAA-UI v1 (read-only) — overview builder tests.
 *
 * The builder is pure over store interfaces: no writes happen here
 * (the route only ever calls buildAdminOverview, never put/append/
 * revoke), and a non-admin caller gets { allowed: false } with NO
 * membership or audit data attached — the 403 body must not leak
 * partial data.
 */

const NOW = 1792660000000;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function membership(
  overrides: Partial<Membership> & { internalUserId: string },
): Membership {
  return {
    membershipId: `m-${overrides.internalUserId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
    internalUserId: overrides.internalUserId,
    tenantId: overrides.tenantId ?? "primary",
    roleBindings: overrides.roleBindings ?? [
      { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    createdAtMs: NOW - 1000,
    ...overrides,
  };
}

const platformAdmin = (userId: string, tenantId = "primary"): Membership =>
  membership({
    internalUserId: userId,
    tenantId,
    roleBindings: [
      { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" },
    ],
  });

function mapKv(): { kv: KvLike; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv: KvLike = {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
  return { kv, store };
}

function auditEvent(overrides: Partial<IaaaAuditEvent> & { timestamp: number }): IaaaAuditEvent {
  return {
    id: `evt-${overrides.timestamp}`,
    timestamp: overrides.timestamp,
    type: "auth.login.success",
    actorPrincipalId: ADMIN_ID,
    actorType: "user",
    initiatingPrincipalId: ADMIN_ID,
    tenantId: "primary",
    correlationId: `corr-${overrides.timestamp}`,
    action: "auth.login",
    decision: "allow",
    policyVersion: "iaaa-1",
    outcome: "success",
    previousEventHash: null,
    eventHash: "hash",
    ...overrides,
  };
}

async function depsWith(opts: {
  memberships?: Membership[];
  events?: IaaaAuditEvent[];
  genesis?: boolean;
  genesisPerIdentity?: boolean;
}): Promise<{ deps: AdminOverviewDeps; audit: AuditStore }> {
  const membershipStore = createMemoryMembershipStore();
  for (const m of opts.memberships ?? []) await membershipStore.put(m);
  const audit = createMemoryAuditStore();
  for (const e of opts.events ?? []) await audit.append(e);
  const { kv, store } = mapKv();
  if (opts.genesis) {
    store.set("iaaa-bootstrap:platform-genesis:primary", JSON.stringify({ grantedTo: ADMIN_ID }));
  }
  if (opts.genesisPerIdentity) {
    store.set(
      `iaaa-bootstrap:platform-genesis:primary:${ADMIN_ID}`,
      JSON.stringify({ grantedTo: ADMIN_ID }),
    );
  }
  return {
    deps: { membershipStore, auditStore: audit, kv, tenantId: "primary", nowMs: NOW },
    audit,
  };
}

describe("checkPlatformPermission (GAP-1 seam A)", () => {
  // GAP-1: the PDP platform-scope consultation replaces the
  // hand-rolled isPlatformAdmin predicate. This matrix is the
  // predicate's former contract, asserted against the PDP.
  it("allows only a live platform-scoped platform-admin binding", async () => {
    const decide = async (memberships: Membership[], userId: string) => {
      const store = createMemoryMembershipStore();
      for (const m of memberships) await store.put(m);
      return checkPlatformPermission(store, {
        internalUserId: userId,
        permission: "role:assign",
        nowMs: NOW,
      });
    };
    expect((await decide([platformAdmin(ADMIN_ID)], ADMIN_ID)).decision).toBe("allow");
    expect(
      (await decide([membership({ internalUserId: USER_ID })], USER_ID)).decision,
    ).toBe("deny");
    expect(
      (await decide([platformAdmin(ADMIN_ID, "other-tenant")], ADMIN_ID)).decision,
    ).toBe("allow"); // platform scope is platform-wide, not tenant-scoped
    expect(
      (
        await decide(
          [{ ...platformAdmin(ADMIN_ID), revokedAtMs: NOW - 1 }],
          ADMIN_ID,
        )
      ).decision,
    ).toBe("deny");
    expect(
      (
        await decide(
          [
            membership({
              internalUserId: ADMIN_ID,
              roleBindings: [
                {
                  role: "platform-admin",
                  scope: "platform",
                  grantedBy: "system:bootstrap-genesis",
                  expiresAtMs: NOW - 1,
                },
              ],
            }),
          ],
          ADMIN_ID,
        )
      ).decision,
    ).toBe("deny");
  });
});

describe("buildAdminOverview", () => {
  it("non-admin caller → not allowed, with no membership or audit data", async () => {
    const { deps } = await depsWith({
      memberships: [membership({ internalUserId: USER_ID })],
      events: [auditEvent({ timestamp: NOW })],
      genesis: true,
    });
    const result = await buildAdminOverview(deps, { callerInternalUserId: USER_ID });
    expect(result.allowed).toBe(false);
    expect("memberships" in result).toBe(false);
    expect("recentAuditEvents" in result).toBe(false);
  });

  it("legacy-style caller with no memberships at all → not allowed", async () => {
    const { deps } = await depsWith({ events: [auditEvent({ timestamp: NOW })] });
    const result = await buildAdminOverview(deps, { callerInternalUserId: USER_ID });
    expect(result.allowed).toBe(false);
  });

  it("platform-admin caller → allowed with own memberships, genesis status, tenant events", async () => {
    const { deps } = await depsWith({
      memberships: [platformAdmin(ADMIN_ID), membership({ internalUserId: USER_ID })],
      events: [
        auditEvent({ timestamp: NOW - 2000 }),
        auditEvent({ timestamp: NOW - 1000 }),
        auditEvent({ timestamp: NOW - 3000, tenantId: "other-tenant" }),
      ],
      genesis: true,
    });
    const result = await buildAdminOverview(deps, { callerInternalUserId: ADMIN_ID });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.tenantId).toBe("primary");
    expect(result.callerInternalUserId).toBe(ADMIN_ID);
    // Only the caller's own memberships: no list-all exists in the store.
    expect(result.memberships).toHaveLength(1);
    expect(result.memberships[0].internalUserId).toBe(ADMIN_ID);
    expect(result.genesis.platformGenesisOccurred).toBe(true);
    // Tenant-filtered, newest first.
    expect(result.recentAuditEvents.map((e) => e.timestamp)).toEqual([NOW - 1000, NOW - 2000]);
    expect(result.recentAuditEvents[0].action).toBe("auth.login");
    expect(result.recentAuditEvents[0].correlationId).toBe(`corr-${NOW - 1000}`);
  });

  it("genesis marker absent → platformGenesisOccurred false", async () => {
    const { deps } = await depsWith({ memberships: [platformAdmin(ADMIN_ID)] });
    const result = await buildAdminOverview(deps, { callerInternalUserId: ADMIN_ID });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.genesis.platformGenesisOccurred).toBe(false);
  });

  it("caller's own per-identity marker → platformGenesisOccurred true (#6191)", async () => {
    // No legacy global marker. The caller holds platform-admin (to
    // be allowed — the "absent" test pins that membership alone
    // reads false); the per-identity marker alone flips the field.
    const { deps } = await depsWith({
      memberships: [platformAdmin(ADMIN_ID)],
      genesisPerIdentity: true,
    });
    const result = await buildAdminOverview(deps, { callerInternalUserId: ADMIN_ID });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.genesis.platformGenesisOccurred).toBe(true);
  });

  it("audit events are capped at the documented limit, newest first", async () => {
    const events = Array.from({ length: IAAA_ADMIN_OVERVIEW_LIMIT + 50 }, (_, i) =>
      auditEvent({ timestamp: NOW - i * 1000 }),
    );
    const { deps } = await depsWith({ memberships: [platformAdmin(ADMIN_ID)], events });
    const result = await buildAdminOverview(deps, { callerInternalUserId: ADMIN_ID });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.recentAuditEvents).toHaveLength(IAAA_ADMIN_OVERVIEW_LIMIT);
    expect(result.recentAuditEvents[0].timestamp).toBe(NOW);
    expect(result.recentAuditEvents[IAAA_ADMIN_OVERVIEW_LIMIT - 1].timestamp).toBe(
      NOW - (IAAA_ADMIN_OVERVIEW_LIMIT - 1) * 1000,
    );
  });
});
