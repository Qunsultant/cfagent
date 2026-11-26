import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_POLICY_VERSION,
  createMemoryMembershipStore,
  type AuthorizationScope,
  type Membership,
  type MembershipStore,
  type Role,
} from "../src/security/authorization";
import {
  authorizeLedgerWrite,
  type LedgerWriteGateResult,
} from "../src/security/serviceDispatch";
import {
  LEGACY_SHARED_ORCHESTRATOR_INSTANCE,
  SHARED_ORCHESTRATOR_INSTANCE,
  serviceUserInternalUserId,
} from "../src/security/serviceIdentity";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import { recordLedgerPayment } from "../src/payments/ledger";
import { recordCfpayLedgerRow } from "../src/services/cfpayLedger";
import type { Env, TransactionRecord } from "../src/types";

/**
 * Ledger gate (#5572, hardening slice 1 — G-1; CISO coordination
 * #5348/#5349/#5350; design #5343 / ADR 0034 D2).
 *
 * The gate: entry requires the request to present the configured
 * service login (#2331 equality rule), and the permission is
 * `ledger:record` (GAP-2) over the system actor's binding (GAP-3),
 * consulted per tenant via authorizeSystemPrincipal. Candidate
 * tenants derive from the service principal's own memberships,
 * never from the request (filed M-4): two legitimate write paths
 * carry no tenant, and a body tenantId is client-supplied from
 * the handler's perspective. The derivation is a
 * pattern-following proposal put to CISO review, not a CISO
 * decision; the residual (the gate authorizes the actor, not the
 * actor-in-the-write's-tenant) is recorded on the PR.
 *
 * These pins prove: both legitimate server-side callers succeed
 * through the IAAA path (fetcher end-to-end through the real
 * handler); a forged signed-in-user request is denied with a
 * coded response and the decision audited; the fail-loud
 * contract holds (a denial throws at the fetcher, never a
 * silent success — the fixed #5037 semantics); dedupe (409)
 * and validation (400) behavior is preserved; and
 * `record-native` no longer answers.
 */

const NOW = 1_800_000_000_000;
const SERVICE_LOGIN = "svc-test";
const SERVICE_ID = serviceUserInternalUserId(SERVICE_LOGIN);
const TENANT = "tenant-a";
const TENANT_B = "tenant-b";
const RUN = "run-1";

function membershipFor(
  userId: string,
  opts: {
    role: Role;
    scope: AuthorizationScope;
    tenantId: string;
    expiresAtMs?: number;
    revokedAtMs?: number;
    suffix?: string;
  },
): Membership {
  return {
    membershipId: `m-${userId}-${opts.tenantId}-${opts.role}-${opts.scope}-${opts.suffix ?? "1"}`,
    internalUserId: userId,
    tenantId: opts.tenantId,
    roleBindings: [
      {
        role: opts.role,
        scope: opts.scope,
        grantedBy: "admin-1",
        ...(opts.expiresAtMs !== undefined
          ? { expiresAtMs: opts.expiresAtMs }
          : {}),
      },
    ],
    createdBy: "admin-1",
    createdAtMs: NOW - 2_000,
    ...(opts.revokedAtMs !== undefined
      ? { revokedAtMs: opts.revokedAtMs }
      : {}),
  };
}

async function seedAdmin(
  store: MembershipStore,
  tenantId: string = TENANT,
  role: Role = "tenant-admin",
): Promise<void> {
  await store.put(
    membershipFor(SERVICE_ID, { role, scope: "tenant", tenantId }),
  );
}

function allowed(
  result: LedgerWriteGateResult,
): Extract<LedgerWriteGateResult, { allowed: true }> {
  if (!result.allowed)
    throw new Error(`expected allow, got ${result.reason}`);
  return result;
}

function denied(
  result: LedgerWriteGateResult,
): Extract<LedgerWriteGateResult, { allowed: false }> {
  if (result.allowed) throw new Error("expected deny, got allow");
  return result;
}

describe("authorizeLedgerWrite — the PDP consultation", () => {
  it("allows a tenant-admin binding, threading principal, tenant, and policy version", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const result = allowed(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.serviceLogin).toBe(SERVICE_LOGIN);
    expect(result.principalId).toBe(SERVICE_ID);
    expect(result.tenantId).toBe(TENANT);
    expect(result.decision.decision).toBe("allow");
    expect(result.decision.permission).toBe("ledger:record");
    expect(result.decision.policyVersion).toBe(
      AUTHORIZATION_POLICY_VERSION,
    );
    expect(result.tenantsEvaluated).toEqual([TENANT]);
    expect(result.anomaly).toBeUndefined();
  });

  it("allows a workspace-admin binding (the role holds ledger:record via the spread)", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store, TENANT, "workspace-admin");
    const result = await authorizeLedgerWrite(store, {
      presentedLogin: SERVICE_LOGIN,
      serviceLogin: SERVICE_LOGIN,
      nowMs: NOW,
    });
    expect(result.allowed).toBe(true);
  });

  it("denies a shaped non-service presenter even when the service binding is provisioned", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: "some-user",
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    // The consultation evaluates the SERVICE principal's binding:
    // a user presenter must never borrow it.
    expect(result.reason).toBe("NOT_SERVICE_ACTOR");
    expect(result.tenantsEvaluated).toEqual([]);
  });

  it("denies a missing, blank, or malformed presented login", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    for (const presented of [null, undefined, "", "   ", 42, "bad login!"]) {
      const result = denied(
        await authorizeLedgerWrite(store, {
          presentedLogin: presented,
          serviceLogin: SERVICE_LOGIN,
          nowMs: NOW,
        }),
      );
      expect(result.reason).toBe("NO_IDENTITY");
    }
  });

  it("never resolves a shared-orchestrator address as the presenter", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    for (const address of [
      SHARED_ORCHESTRATOR_INSTANCE,
      LEGACY_SHARED_ORCHESTRATOR_INSTANCE,
    ]) {
      const result = denied(
        await authorizeLedgerWrite(store, {
          presentedLogin: address,
          serviceLogin: SERVICE_LOGIN,
          nowMs: NOW,
        }),
      );
      expect(result.reason).toBe("SHARED_ADDRESS");
    }
  });

  it("denies when no service login is configured, whatever is presented", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: null,
        nowMs: NOW,
      }),
    );
    expect(result.reason).toBe("SERVICE_NOT_CONFIGURED");
  });

  it("denies when the configured service login is itself a shared address", async () => {
    const store = createMemoryMembershipStore();
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: SHARED_ORCHESTRATOR_INSTANCE,
        serviceLogin: SHARED_ORCHESTRATOR_INSTANCE,
        nowMs: NOW,
      }),
    );
    expect(result.reason).toBe("SHARED_ADDRESS");
  });

  it("denies when the service principal holds no membership anywhere", async () => {
    const store = createMemoryMembershipStore();
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.reason).toBe("SERVICE_NOT_PROVISIONED");
    expect(result.tenantsEvaluated).toEqual([]);
  });

  it("denies a member-only binding with the PDP's own NO_GRANT (no money permission)", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "member",
        scope: "tenant",
        tenantId: TENANT,
      }),
    );
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.reason).toBe("PDP_DENIED");
    expect(result.detail).toBe(`${TENANT}:NO_GRANT`);
    expect(result.tenantsEvaluated).toEqual([TENANT]);
  });

  it("denies a revoked membership with the PDP's own reason", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "tenant-admin",
        scope: "tenant",
        tenantId: TENANT,
        revokedAtMs: NOW - 1,
      }),
    );
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.reason).toBe("PDP_DENIED");
    expect(result.detail).toBe(`${TENANT}:MEMBERSHIP_REVOKED`);
  });

  it("denies an expired binding (0 ms revocation semantics: the PDP fresh-reads)", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "tenant-admin",
        scope: "tenant",
        tenantId: TENANT,
        expiresAtMs: NOW - 1,
      }),
    );
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.reason).toBe("PDP_DENIED");
    expect(result.detail).toBe(`${TENANT}:NO_GRANT`);
  });

  it("derives tenants from the principal's memberships: a binding in another tenant allows, in sorted order", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "member",
        scope: "tenant",
        tenantId: TENANT,
      }),
    );
    await seedAdmin(store, TENANT_B);
    const result = allowed(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.tenantId).toBe(TENANT_B);
    expect(result.tenantsEvaluated).toEqual([TENANT, TENANT_B]);
  });

  it("denies a service id holding only a platform-admin binding, and surfaces the anomaly", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "platform-admin",
        scope: "platform",
        tenantId: TENANT,
      }),
    );
    const result = denied(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.reason).toBe("PDP_DENIED");
    expect(result.anomaly).toContain("platform-admin binding");
  });

  it("surfaces the anomaly without overriding a PDP allow from a legitimate tenant binding", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "platform-admin",
        scope: "platform",
        tenantId: TENANT,
        suffix: "2",
      }),
    );
    const result = allowed(
      await authorizeLedgerWrite(store, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    );
    expect(result.anomaly).toContain("platform-admin binding");
  });

  it("propagates store failures to the caller, which fails closed (no silent allow)", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const throwing: MembershipStore = {
      ...store,
      getMembershipsByUser: async () => {
        throw new Error("kv down");
      },
    };
    await expect(
      authorizeLedgerWrite(throwing, {
        presentedLogin: SERVICE_LOGIN,
        serviceLogin: SERVICE_LOGIN,
        nowMs: NOW,
      }),
    ).rejects.toThrow("kv down");
  });
});

describe("ledger-write handlers — the enforced gate", () => {
  function fakeOrm() {
    const rows: TransactionRecord[] = [];
    return {
      rows,
      orm: {
        transactions: {
          findMany: () => [...rows],
          create: (tx: TransactionRecord) => {
            rows.push(tx);
            return tx;
          },
        },
      } as unknown as DatabaseORM,
    };
  }

  type AuditEntry = { type: string; payload: Record<string, unknown> };

  function fakeCtx(
    store: MembershipStore,
    audits: AuditEntry[],
    orm: DatabaseORM,
    env: Record<string, unknown> = { SERVICE_USER_LOGIN: SERVICE_LOGIN },
  ): AgenticPaymentsRouteContext {
    return {
      env: env as unknown as Env,
      getOrm: () => orm,
      audit: (
        type: string,
        _agent: unknown,
        payload: Record<string, unknown>,
      ) => {
        audits.push({ type, payload });
      },
      executionContextMembershipStore: store,
    } as unknown as AgenticPaymentsRouteContext;
  }

  async function callRoute(
    ctx: AgenticPaymentsRouteContext,
    path: string,
    body: unknown,
    login: string | null,
  ) {
    const url = new URL(`https://agent.internal${path}`);
    const request = new Request(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(login === null ? {} : { "x-user-login": login }),
      },
      body: JSON.stringify(body),
    });
    return handleAgenticPaymentsRoutes(
      request,
      url,
      url.pathname,
      "sess-1",
      ctx,
    );
  }

  const cfpayBody = {
    kind: "charge",
    runRequestId: RUN,
    userId: "user-1",
    family: "stock",
    priceUSD: 0.02,
    paymentIntentId: "pi-1",
  };

  const recordBody = {
    agentId: "agent-1",
    operation: "spend",
    amountCents: 2,
    idempotencyKey: "key-1",
  };

  it("record-cfpay: the service actor with a provisioned binding writes, and the allow is audited", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      SERVICE_LOGIN,
    );
    expect(res?.status).toBe(200);
    expect(rows).toHaveLength(1);
    const gate = audits.find((a) => a.type === "payments_ledger.gate");
    expect(gate?.payload).toMatchObject({
      route: "record-cfpay",
      outcome: "allowed",
      principalId: SERVICE_ID,
      tenantId: TENANT,
      policyVersion: AUTHORIZATION_POLICY_VERSION,
    });
    expect(
      audits.some((a) => a.type === "payments_cfpay.recorded"),
    ).toBe(true);
  });

  it("record: the service actor with a provisioned binding writes, and the allow is audited", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record",
      recordBody,
      SERVICE_LOGIN,
    );
    expect(res?.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(
      audits.find((a) => a.type === "payments_ledger.gate")?.payload,
    ).toMatchObject({ route: "record", outcome: "allowed" });
    expect(
      audits.some((a) => a.type === "payments_agent.recorded"),
    ).toBe(true);
  });

  it("a forged signed-in-user request naming another user is denied coded, writes nothing, and is audited", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      { ...cfpayBody, userId: "victim-user", priceUSD: 999 },
      "attacker-login",
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({
      code: "FAILURE_COMMERCIAL_FORBIDDEN",
      error:
        "Forbidden: ledger recording requires the payment service identity.",
    });
    expect(rows).toHaveLength(0);
    expect(
      audits.find((a) => a.type === "payments_ledger.gate")?.payload,
    ).toMatchObject({ outcome: "denied", reason: "NOT_SERVICE_ACTOR" });
    expect(
      audits.some((a) => a.type === "payments_cfpay.recorded"),
    ).toBe(false);
  });

  it("a forged request to record is denied the same way", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record",
      { ...recordBody, agentId: "victim-agent" },
      "attacker-login",
    );
    expect(res?.status).toBe(403);
    expect(rows).toHaveLength(0);
    expect(
      audits.find((a) => a.type === "payments_ledger.gate")?.payload,
    ).toMatchObject({
      route: "record",
      outcome: "denied",
      reason: "NOT_SERVICE_ACTOR",
    });
  });

  it("no presented login denies, and an unconfigured service login denies", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const noLogin = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      null,
    );
    expect(noLogin?.status).toBe(403);
    const unconfigured = await callRoute(
      // Phase 3 (#6550): a bare env now resolves "svc-background"
      // from environment.config.json, so the unconfigured-service
      // case needs the malformed login.
      fakeCtx(store, audits, orm, { SERVICE_USER_LOGIN: "not a login!" }),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      SERVICE_LOGIN,
    );
    expect(unconfigured?.status).toBe(403);
    expect(rows).toHaveLength(0);
    expect(
      audits
        .filter((a) => a.type === "payments_ledger.gate")
        .map((a) => a.payload["reason"]),
    ).toEqual(["NO_IDENTITY", "SERVICE_NOT_CONFIGURED"]);
  });

  it("an unprovisioned service actor denies fail-closed (the production precondition)", async () => {
    const store = createMemoryMembershipStore();
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      SERVICE_LOGIN,
    );
    expect(res?.status).toBe(403);
    expect(rows).toHaveLength(0);
    expect(
      audits.find((a) => a.type === "payments_ledger.gate")?.payload,
    ).toMatchObject({
      outcome: "denied",
      reason: "SERVICE_NOT_PROVISIONED",
    });
  });

  it("a member-only binding denies at the handler with the PDP reason", async () => {
    const store = createMemoryMembershipStore();
    await store.put(
      membershipFor(SERVICE_ID, {
        role: "member",
        scope: "tenant",
        tenantId: TENANT,
      }),
    );
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record",
      recordBody,
      SERVICE_LOGIN,
    );
    expect(res?.status).toBe(403);
    expect(rows).toHaveLength(0);
    expect(
      audits.find((a) => a.type === "payments_ledger.gate")?.payload,
    ).toMatchObject({
      outcome: "denied",
      reason: "PDP_DENIED",
      detail: `${TENANT}:NO_GRANT`,
    });
  });

  it("a store failure fails closed with 500 and no data, writing nothing", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const throwing: MembershipStore = {
      ...store,
      getMembershipsByUser: async () => {
        throw new Error("kv down");
      },
    };
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const res = await callRoute(
      fakeCtx(throwing, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      SERVICE_LOGIN,
    );
    expect(res?.status).toBe(500);
    expect(rows).toHaveLength(0);
  });

  it("dedupe (409) and validation (400) behavior is preserved for allowed requests", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const ctx = fakeCtx(store, audits, orm);
    const first = await callRoute(
      ctx,
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      SERVICE_LOGIN,
    );
    expect(first?.status).toBe(200);
    const replay = await callRoute(
      ctx,
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      SERVICE_LOGIN,
    );
    expect(replay?.status).toBe(409);
    expect(rows).toHaveLength(1);
    const invalid = await callRoute(
      ctx,
      "/payments/agentic/ledger/record-cfpay",
      { ...cfpayBody, priceUSD: -1 },
      SERVICE_LOGIN,
    );
    expect(invalid?.status).toBe(400);
    // The permission check is audited even when the request then
    // dedupes or fails validation.
    expect(
      audits.filter(
        (a) =>
          a.type === "payments_ledger.gate" &&
          a.payload["outcome"] === "allowed",
      ),
    ).toHaveLength(3);
  });

  it("record-native no longer answers: the handler returns null and nothing is observed, audited, or written", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const { rows, orm } = fakeOrm();
    const audits: AuditEntry[] = [];
    const ctx = fakeCtx(store, audits, orm);
    const nativeBody = {
      kind: "charge",
      runRequestId: RUN,
      tenantId: TENANT,
      userId: "user-1",
      family: "stock",
      priceUSD: 0.02,
    };
    const asService = await callRoute(
      ctx,
      "/payments/agentic/ledger/record-native",
      nativeBody,
      SERVICE_LOGIN,
    );
    const asUser = await callRoute(
      ctx,
      "/payments/agentic/ledger/record-native",
      nativeBody,
      "some-user",
    );
    expect(asService).toBeNull();
    expect(asUser).toBeNull();
    expect(rows).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe("legitimate fetchers end-to-end through the real handler", () => {
  /**
   * The production shape, in miniature: the fetchers' DO stub.fetch
   * routes to the real handler with the gate's store, and the
   * handler reads the same SERVICE_USER_LOGIN the fetchers forward
   * under. A null handler result falls through as 404, as the
   * sequential dispatcher would continue matching.
   */
  function routedEnv(
    store: MembershipStore,
    audits: Array<{ type: string; payload: Record<string, unknown> }>,
    rows: TransactionRecord[],
  ): Env {
    const orm = {
      transactions: {
        findMany: () => [...rows],
        create: (tx: TransactionRecord) => {
          rows.push(tx);
          return tx;
        },
      },
    } as unknown as DatabaseORM;
    const env = {
      SERVICE_USER_LOGIN: SERVICE_LOGIN,
    } as unknown as Env;
    const ctx = {
      env,
      getOrm: () => orm,
      audit: (
        type: string,
        _agent: unknown,
        payload: Record<string, unknown>,
      ) => {
        audits.push({ type, payload });
      },
      executionContextMembershipStore: store,
    } as unknown as AgenticPaymentsRouteContext;
    const stub = {
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const res = await handleAgenticPaymentsRoutes(
          req,
          url,
          url.pathname,
          "sess-1",
          ctx,
        );
        return res ?? Response.json({ error: "no route" }, { status: 404 });
      },
    };
    (env as unknown as Record<string, unknown>)["ORCHESTRATOR_AGENT"] = {
      idFromName: (name: string) => name,
      get: () => stub,
    };
    return env;
  }

  it("recordLedgerPayment succeeds through the IAAA path, and replays dedupe", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const rows: TransactionRecord[] = [];
    const env = routedEnv(store, audits, rows);
    const input = {
      agentId: "agent-1",
      operation: "spend",
      amountCents: 2,
      idempotencyKey: "key-1",
    };
    const first = await recordLedgerPayment(env, input);
    expect(first.duplicate).toBe(false);
    expect(rows).toHaveLength(1);
    const replay = await recordLedgerPayment(env, input);
    expect(replay.duplicate).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("recordCfpayLedgerRow succeeds through the IAAA path, and replays dedupe", async () => {
    const store = createMemoryMembershipStore();
    await seedAdmin(store);
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const rows: TransactionRecord[] = [];
    const env = routedEnv(store, audits, rows);
    const input = {
      runRequestId: RUN,
      userId: "user-1",
      family: "stock",
      priceUSD: 0.02,
      paymentIntentId: "pi-1",
      tenantId: TENANT,
    };
    const first = await recordCfpayLedgerRow(env, "charge", input, {
      membershipStore: store,
      nowMs: Date.now(),
    });
    expect(first.duplicate).toBe(false);
    expect(rows).toHaveLength(1);
    const replay = await recordCfpayLedgerRow(env, "charge", input, {
      membershipStore: store,
      nowMs: Date.now(),
    });
    expect(replay.duplicate).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("an unprovisioned binding makes both fetchers throw loud — a failed write is never reported as success", async () => {
    // The fixed #5037 semantics: confirmDraft no longer reports
    // success when the ledger write fails, and the fetchers'
    // fail-loud throw is the surface that carries the failure.
    const store = createMemoryMembershipStore();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const rows: TransactionRecord[] = [];
    const env = routedEnv(store, audits, rows);
    await expect(
      recordLedgerPayment(env, {
        agentId: "agent-1",
        operation: "spend",
        amountCents: 2,
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow("payment ledger record failed: HTTP 403");
    await expect(
      recordCfpayLedgerRow(
        env,
        "charge",
        {
          runRequestId: RUN,
          userId: "user-1",
          family: "stock",
          priceUSD: 0.02,
          paymentIntentId: "pi-1",
          tenantId: TENANT,
        },
        { membershipStore: store, nowMs: Date.now() },
      ),
    ).rejects.toThrow("cfpay ledger record failed: HTTP 403");
    expect(rows).toHaveLength(0);
  });
});
