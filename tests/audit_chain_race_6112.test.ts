// @vitest-environment node
/**
 * Issue #6112 — audit chain sequence collision loses entries under
 * concurrent appends.
 *
 * TDD Red first: N concurrent appends for one tenant must land as
 * N entries, in order, with no collision. Before the fix the
 * second concurrent append computes the same sequence as the
 * first (read-modify-write with no serialization) and is lost:
 * the in-memory adapter throws `audit chain sequence collision`,
 * the D1 adapter throws the `agent_audit_chain.id` UNIQUE
 * constraint — and `appendAuditChainBestEffort` swallows it.
 *
 * The port suite runs UNCHANGED against the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — a real UNIQUE
 * constraint) and the in-memory adapter, following the #2183
 * pattern: a behavior that passes on one adapter and fails on
 * the other is a layer defect, not an application bug.
 */
import { describe, it, expect, vi } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditPolicyDb,
  D1AuditPolicyAdapter,
  ensureAuditPolicySchema,
} from "../src/data/d1AuditPolicyAdapter";
import { InMemoryAuditPolicyAdapter } from "../src/data/inMemoryAuditPolicyAdapter";
import {
  verifyAuditChain,
  type AuditPolicyPort,
} from "../src/data/auditPolicyPorts";
import { appendAuditChainBestEffort } from "../src/services/auditGate";
import { OBS_AUDIT_CHAIN_APPEND_FAILED } from "../src/observability/otelMessages";

async function makeD1Store(): Promise<{ port: AuditPolicyPort }> {
  const mock = new MockD1Database();
  const db = createD1AuditPolicyDb(mock as any);
  await ensureAuditPolicySchema(db);
  return { port: new D1AuditPolicyAdapter(db) };
}

const makers: Array<{
  name: string;
  make: () => Promise<{ port: AuditPolicyPort }>;
}> = [
  { name: "Drizzle D1 adapter", make: makeD1Store },
  {
    name: "in-memory adapter",
    make: async () => ({ port: new InMemoryAuditPolicyAdapter() }),
  },
];

describe.each(makers)("audit chain race (#6112) — $name", ({ make }) => {
  it("N concurrent appends for one tenant land as N entries, in order, with no collision", async () => {
    const { port } = await make();
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        port.appendChainEntry({
          tenantId: "acme",
          action: `race.append.${i}`,
          payload: { i },
        }),
      ),
    );
    expect(results).toHaveLength(N);
    const chain = await port.listChainEntries("acme");
    expect(chain).toHaveLength(N);
    expect(chain.map((e) => e.sequence)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
    expect(chain.map((e) => e.action)).toEqual(
      Array.from({ length: N }, (_, i) => `race.append.${i}`),
    );
    const verification = await verifyAuditChain(chain);
    expect(verification.valid).toBe(true);
  });

  it("concurrent appends for two tenants stay isolated and consecutive per tenant", async () => {
    const { port } = await make();
    const N = 5;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) =>
        port.appendChainEntry({
          tenantId: "alpha",
          action: `race.alpha.${i}`,
          payload: { i },
        }),
      ),
      ...Array.from({ length: N }, (_, i) =>
        port.appendChainEntry({
          tenantId: "beta",
          action: `race.beta.${i}`,
          payload: { i },
        }),
      ),
    ]);
    for (const tenant of ["alpha", "beta"]) {
      const chain = await port.listChainEntries(tenant);
      expect(chain).toHaveLength(N);
      expect(chain.map((e) => e.sequence)).toEqual(
        Array.from({ length: N }, (_, i) => i + 1),
      );
      const verification = await verifyAuditChain(chain);
      expect(verification.valid).toBe(true);
    }
  });
});

describe("audit chain append failure is named, never swallowed (#6112)", () => {
  function throwingPort(): AuditPolicyPort {
    return {
      listActionPolicies: async () => {
        throw new Error("D1 unavailable");
      },
      getActionPolicy: async () => {
        throw new Error("D1 unavailable");
      },
      setActionPolicy: async () => {
        throw new Error("D1 unavailable");
      },
      getSetting: async () => {
        throw new Error("D1 unavailable");
      },
      setSetting: async () => {
        throw new Error("D1 unavailable");
      },
      getChainHead: async () => {
        throw new Error("D1 unavailable");
      },
      listChainEntries: async () => {
        throw new Error("D1 unavailable");
      },
      appendChainEntry: async () => {
        throw new Error("D1 unavailable");
      },
      listAgedChainEntries: async () => {
        throw new Error("D1 unavailable");
      },
      deleteChainEntries: async () => {
        throw new Error("D1 unavailable");
      },
    };
  }

  it("a failed append audits the failure and logs coded OBS-1023", async () => {
    const audit = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await appendAuditChainBestEffort(
        async () => throwingPort(),
        {
          tenantId: "acme",
          action: "platform.tenant_admin.create",
          payload: { actorLogin: "op1" },
        },
        audit,
      );
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith(
        "audit.chain.append_failed",
        "orchestrator",
        expect.objectContaining({
          code: "audit_chain_append_failed",
          tenantId: "acme",
          action: "platform.tenant_admin.create",
          error: expect.stringMatching(/D1 unavailable/),
        }),
      );
      const logged = [
        ...infoSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .map((c) => c.map(String).join(" "))
        .join("\n");
      expect(logged).toContain(OBS_AUDIT_CHAIN_APPEND_FAILED);
      expect(OBS_AUDIT_CHAIN_APPEND_FAILED).toBe("OBS-1023");
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a throwing audit callback never breaks the best-effort append", async () => {
    const audit = vi.fn(() => {
      throw new Error("audit exploded");
    });
    await expect(
      appendAuditChainBestEffort(
        async () => throwingPort(),
        {
          tenantId: "acme",
          action: "platform.tenant_admin.create",
          payload: { actorLogin: "op1" },
        },
        audit,
      ),
    ).resolves.toBeUndefined();
  });

  it("no audit callback still logs the coded OBS-1023 floor", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await appendAuditChainBestEffort(async () => throwingPort(), {
        tenantId: "acme",
        action: "platform.tenant_admin.create",
        payload: { actorLogin: "op1" },
      });
      const logged = [
        ...infoSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .map((c) => c.map(String).join(" "))
        .join("\n");
      expect(logged).toContain(OBS_AUDIT_CHAIN_APPEND_FAILED);
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
