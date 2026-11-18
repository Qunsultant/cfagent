/**
 * Issue #5084 (observability S5) — one audit store.
 *
 * The canonical audit store is the IAAA audit store: the contract in
 * src/data/auditLogPorts.ts, the pure model + single write path
 * recordAuditEvent in src/security/iaaaAudit.ts, the wiring
 * createWiredAuditStore in src/security/iaaaAuditStore.ts, backed by
 * the SessionStore DO's audit-append op on `iaaa-audit:` keys.
 *
 * The duplicate this slice eliminates is the CLIENT implementation:
 * createAtomicAuditStore (security/iaaaAuditStore.ts) and
 * createAuditLogStore (data/auditLogStoreImpl.ts) both spoke the same
 * DO op on the same keys with the same reply mapping, selected by
 * the AUDIT_PORTS_ENABLED flag. After S5 the audit-append op is
 * spoken by exactly one production client implementation
 * (createAuditLogStore); createAtomicAuditStore is a thin adapter
 * over it. Both flag states still serve (the flag selects the
 * composition root only), and both compositions read/write the same
 * bytes — pinned by the cross-composition tests below and by the
 * #2435 conformance suite.
 *
 * NOT a duplicate (recorded in docs/architecture/security/
 * audit-canonical-store-5084.md): the #1688 audit REPORT family
 * (src/data/auditReportPorts.ts) projects DIFFERENT events (agent
 * chain lifecycle rows in D1); and the Audit Vault page
 * (?tab=audit-vault) reads the older mas_events table, a third
 * record outside this spec's two layers — its read path needs its
 * own decision (filed out-of-scope). The canonical audit surface
 * this slice proves is the IAAA Admin Overview Audit events view,
 * which reads the one store.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  createAtomicAuditStore,
  createWiredAuditStore,
} from "../src/security/iaaaAuditStore";
import { createAuditPortsFromNamespace } from "../src/data/createAuditPorts";
import {
  classifyAuditFailure,
  isAuditedSuccess,
  recordAuditEvent,
  shouldBlockAction,
  verifyChain,
  type CreateIaaaAuditEventInput,
} from "../src/security/iaaaAudit";
import { buildAdminOverview } from "../src/security/iaaaAdminOverview";
import {
  createMemoryMembershipStore,
  type Membership,
} from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

const NOW = 1792660000000;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

function validInput(
  overrides: Partial<CreateIaaaAuditEventInput> = {},
): CreateIaaaAuditEventInput {
  return {
    timestamp: NOW,
    type: "role.grant",
    actorPrincipalId: ADMIN_ID,
    actorType: "human",
    initiatingPrincipalId: ADMIN_ID,
    tenantId: "primary",
    correlationId: "corr-5084",
    action: "role:assign",
    decision: "allow",
    policyVersion: "iaaa-audit-1",
    outcome: "succeeded",
    ...overrides,
  };
}

function platformAdminMembership(): Membership {
  return {
    membershipId: "m-admin-5084",
    internalUserId: ADMIN_ID,
    tenantId: "primary",
    roleBindings: [
      {
        role: "platform-admin",
        scope: "platform",
        grantedBy: "system:bootstrap-genesis",
      },
    ],
    createdBy: "system:bootstrap",
    createdAtMs: NOW - 1000,
  };
}

function mapKv(): KvLike {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

describe("S5 single-sourcing (structural pin)", () => {
  const iaaaStoreSrc = readFileSync(
    new URL("../src/security/iaaaAuditStore.ts", import.meta.url),
    "utf8",
  );
  const familyImplSrc = readFileSync(
    new URL("../src/data/auditLogStoreImpl.ts", import.meta.url),
    "utf8",
  );

  it("the security layer no longer speaks the audit-append op itself", () => {
    expect(iaaaStoreSrc).not.toContain('op: "audit-append"');
  });

  it("the security layer delegates to the AuditLog family implementation", () => {
    expect(iaaaStoreSrc).toContain("createAuditLogStore");
  });

  it("exactly one production client implementation speaks the audit-append op", () => {
    expect(familyImplSrc).toContain('op: "audit-append"');
  });
});

describe("one store, two compositions", () => {
  it("an event written via the flag-OFF composition reads via the flag-ON composition (and vice versa)", async () => {
    const fake = makeFakeSessionStore();
    const offStore = createAtomicAuditStore(fake.namespace as never);
    const onStore = createAuditPortsFromNamespace(fake.namespace as never);

    const r1 = await recordAuditEvent(
      offStore,
      validInput({ correlationId: "corr-off-to-on" }),
    );
    expect(r1.ok).toBe(true);
    const listedOn = await onStore.list();
    expect(listedOn.map((e) => e.correlationId)).toContain("corr-off-to-on");
    expect(await verifyChain(listedOn)).toBe(true);

    const r2 = await recordAuditEvent(
      onStore,
      validInput({ correlationId: "corr-on-to-off" }),
    );
    expect(r2.ok).toBe(true);
    const listedOff = await offStore.list();
    expect(listedOff.map((e) => e.correlationId)).toContain("corr-on-to-off");
    expect(listedOff).toHaveLength(2);
    expect(await verifyChain(listedOff)).toBe(true);
  });

  it("createWiredAuditStore serves one store in both flag states", async () => {
    const fake = makeFakeSessionStore();
    const offEnv = { SESSION_STORE: fake.namespace } as unknown as Env;
    const onEnv = {
      SESSION_STORE: fake.namespace,
      AUDIT_PORTS_ENABLED: "1",
    } as unknown as Env;
    const offStore = createWiredAuditStore(offEnv);
    const onStore = createWiredAuditStore(onEnv);

    const r = await recordAuditEvent(
      offStore,
      validInput({ correlationId: "corr-flag" }),
    );
    expect(r.ok).toBe(true);
    const listed = await onStore.list();
    expect(listed.map((e) => e.correlationId)).toContain("corr-flag");
    expect(await verifyChain(listed)).toBe(true);
  });
});

describe("the canonical audit surface reads the one store", () => {
  it("an event written once via recordAuditEvent appears in the Admin Overview Audit events view", async () => {
    const fake = makeFakeSessionStore();
    const env = { SESSION_STORE: fake.namespace } as unknown as Env;
    const store = createWiredAuditStore(env);

    const result = await recordAuditEvent(
      store,
      validInput({ correlationId: "corr-overview" }),
    );
    expect(result.ok).toBe(true);

    const membershipStore = createMemoryMembershipStore();
    await membershipStore.put(platformAdminMembership());
    const overview = await buildAdminOverview(
      {
        membershipStore,
        auditStore: store,
        kv: mapKv(),
        tenantId: "primary",
        nowMs: NOW,
      },
      { callerInternalUserId: ADMIN_ID },
    );
    expect(overview.allowed).toBe(true);
    if (overview.allowed) {
      expect(
        overview.recentAuditEvents.map((e) => e.correlationId),
      ).toContain("corr-overview");
      expect(overview.recentAuditEvents[0].action).toBe("role:assign");
    }
  });
});

describe("audit-before-allow is preserved", () => {
  it("a failed audit write is visible data and blocks a consequential action", async () => {
    const noBackend = createAtomicAuditStore(undefined);
    const result = await recordAuditEvent(noBackend, validInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUDIT_WRITE_FAILED");

    expect(classifyAuditFailure("consequential", true)).toEqual({
      action: "block",
      reason: "AUDIT_REQUIRED_FOR_CONSEQUENTIAL_ACTION",
      blocked: true,
    });
    expect(shouldBlockAction("consequential", true)).toBe(true);
    expect(shouldBlockAction("non-consequential", true)).toBe(false);
    expect(
      isAuditedSuccess({
        decision: "allow",
        outcome: "succeeded",
        auditRecorded: false,
      }),
    ).toBe(false);
    expect(
      isAuditedSuccess({
        decision: "allow",
        outcome: "succeeded",
        auditRecorded: true,
      }),
    ).toBe(true);
  });
});
