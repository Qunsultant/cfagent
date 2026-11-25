/**
 * Issue #2178 (Q7 S2) — guard family.
 * TDD: written before the implementation.
 *
 * Contract: the chained mas_events store as the audit-before-allow
 * sink, via createChainedAuditWriter. A successful chained write
 * satisfies the obligation (allow); a throwing store denies
 * (auditSatisfied already fails closed on throw — the writer must
 * NOT swallow it). Honest boundary, stated not hidden: today's
 * worker-level enforcement points (the server.ts IAAA routes) have
 * no ORM/mas_events write path, so they keep the IAAA DO-log
 * writer until a worker→DO audit RPC exists; this factory is the
 * sink agent-side enforcement points use, proved here through the
 * real obligation evaluator.
 */
import { describe, it, expect } from "vitest";
import {
  createMemoryMembershipStore,
  createMembership,
  type MembershipStore,
} from "../src/security/authorization";
import {
  createChainedAuditWriter,
  evaluateWithObligations,
} from "../src/security/obligations";

const NOW = 1_800_000_000_000;
const TENANT = "primary";

async function tenantAdminStore(): Promise<MembershipStore> {
  const store = createMemoryMembershipStore();
  const created = await createMembership(store, {
    internalUserId: "v1:admin",
    tenantId: TENANT,
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
    createdBy: "system:bootstrap",
    nowMs: NOW,
  });
  if (!created.ok) throw new Error("fixture membership failed");
  return store;
}

describe("chained audit writer as guard sink (#2178 S2)", () => {
  it("a successful chained write satisfies audit-before-allow", async () => {
    const rows: any[] = [];
    const writer = createChainedAuditWriter({ create: async (record: any) => { rows.push(record); return record; } });
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      authTimeMs: NOW,
      audit: writer,
    });
    expect(result.decision).toBe("allow");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("iaaa.guard_decision");
    expect(rows[0].payload.permission).toBe("role:assign");
    expect(rows[0].payload.principalId).toBe("v1:admin");
  });

  it("a throwing chained store denies, never allows unaudited", async () => {
    const writer = createChainedAuditWriter({
      create: async () => { throw new Error("audit store unavailable"); },
    });
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "membership:revoke",
      nowMs: NOW,
      audit: writer,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
    expect(result.obligations).toEqual([
      expect.objectContaining({ kind: "audit-before-allow", satisfied: false }),
    ]);
  });

  it("the writer itself propagates a store throw (no swallow)", async () => {
    const writer = createChainedAuditWriter({
      create: async () => { throw new Error("audit store unavailable"); },
    });
    await expect(
      writer({ permission: "role:assign", principalId: "v1:admin", tenantId: TENANT, decision: "allow", nowMs: NOW }),
    ).rejects.toThrowError("audit store unavailable");
  });
});
