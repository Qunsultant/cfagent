import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_POLICY_VERSION,
  createMembership,
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";
import {
  EXECUTION_CONTEXT_HEADER,
  LEDGER_WRITE_SERVICE_ID,
  ledgerWriteApprovalReference,
  ledgerWriteAuthority,
  observeLedgerWriteContext,
  resolveLedgerWriteContext,
  resolveLedgerWriteContextHeader,
  revalidateLedgerWriteContext,
} from "../src/security/commercialExecutionContext";
import {
  parseExecutionContext,
  serializeExecutionContext,
} from "../src/security/executionContext";
import { serviceUserInternalUserId } from "../src/security/serviceIdentity";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import { recordCfpayLedgerRow } from "../src/services/cfpayLedger";
import type { Env, TransactionRecord } from "../src/types";

/**
 * GAP-5 (#5477) — ExecutionContext staged wiring for the commercial
 * path. The contract is unchanged; this pins the commercial mapping
 * (service principal + `ledger:record` + live + approval evidence),
 * the boundary carriage (serialize → header → parse → revalidate),
 * the observe-mode guarantees (never denies, never throws, never
 * fails a write), and the handler call sites.
 */

const NOW = 1_800_000_000_000;
const SERVICE_LOGIN = "svc-test";
const SERVICE_ID = serviceUserInternalUserId(SERVICE_LOGIN);
const TENANT = "tenant-a";
const RUN = "run-1";

async function seedBinding(
  store: MembershipStore,
  overrides: {
    internalUserId?: string;
    tenantId?: string;
    role?: "member" | "tenant-admin" | "workspace-admin";
    expiresAtMs?: number;
  } = {},
): Promise<void> {
  const result = await createMembership(store, {
    internalUserId: overrides.internalUserId ?? SERVICE_ID,
    tenantId: overrides.tenantId ?? TENANT,
    roleBindings: [
      {
        role: overrides.role ?? "tenant-admin",
        scope: "tenant",
        grantedBy: "admin-1",
        ...(overrides.expiresAtMs !== undefined
          ? { expiresAtMs: overrides.expiresAtMs }
          : {}),
      },
    ],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
}

describe("ledgerWriteApprovalReference", () => {
  it("prefers the payment intent, then the claim hash, then the checkout", () => {
    expect(
      ledgerWriteApprovalReference({
        kind: "charge",
        runRequestId: RUN,
        checkoutId: "co-1",
        claimTxHash: "0xabc",
        paymentIntentId: "pi-1",
      }),
    ).toBe("pi-1");
    expect(
      ledgerWriteApprovalReference({
        kind: "charge",
        runRequestId: RUN,
        checkoutId: "co-1",
        claimTxHash: "0xabc",
      }),
    ).toBe("0xabc");
    expect(
      ledgerWriteApprovalReference({
        kind: "charge",
        runRequestId: RUN,
        checkoutId: "co-1",
      }),
    ).toBe("co-1");
  });

  it("ignores blank proof references", () => {
    expect(
      ledgerWriteApprovalReference({
        kind: "charge",
        runRequestId: RUN,
        checkoutId: "   ",
        paymentIntentId: "",
      }),
    ).toBeUndefined();
  });

  it("yields nothing for a charge with no proof reference", () => {
    expect(
      ledgerWriteApprovalReference({ kind: "charge", runRequestId: RUN }),
    ).toBeUndefined();
  });

  it("references the failure-credit issuance for a credit", () => {
    expect(
      ledgerWriteApprovalReference({ kind: "credit", runRequestId: RUN }),
    ).toBe("failure-credit:run-1");
    expect(
      ledgerWriteApprovalReference({ kind: "credit", runRequestId: "  " }),
    ).toBeUndefined();
  });
});

describe("ledgerWriteAuthority", () => {
  it("never binds a connection: ledger contexts carry none", async () => {
    const store = createMemoryMembershipStore();
    const authority = ledgerWriteAuthority(store);
    expect(
      await authority.isConnectionBound({
        tenantId: TENANT,
        principalId: SERVICE_ID,
        connectionId: "conn-1",
      }),
    ).toBe(false);
  });
});

describe("resolveLedgerWriteContext", () => {
  it("resolves a frozen context embedding the PDP decision", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const result = await resolveLedgerWriteContext(
      ledgerWriteAuthority(store),
      {
        servicePrincipalId: SERVICE_ID,
        tenantId: TENANT,
        runRequestId: RUN,
        approvalReference: "pi-1",
        nowMs: NOW,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected resolution");
    expect(result.context.principalId).toBe("service:svc-test");
    expect(result.context.principalType).toBe("service");
    expect(result.context.initiatingPrincipalId).toBe("service:svc-test");
    expect(result.context.tenantId).toBe(TENANT);
    expect(result.context.taskId).toBe(RUN);
    expect(result.context.serviceId).toBe(LEDGER_WRITE_SERVICE_ID);
    expect(result.context.environment).toBe("live");
    expect(result.context.approvalReference).toBe("pi-1");
    expect(result.context.correlationId).toBe(RUN);
    expect(result.context.connectionId).toBeUndefined();
    // The embedded decision follows the live policy version, never a copy.
    expect(result.context.policyVersion).toBe(AUTHORIZATION_POLICY_VERSION);
    expect(Object.isFrozen(result.context)).toBe(true);
  });

  it("denies a member: the money permission is admin-held (GAP-2)", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store, { role: "member" });
    const result = await resolveLedgerWriteContext(
      ledgerWriteAuthority(store),
      {
        servicePrincipalId: SERVICE_ID,
        tenantId: TENANT,
        runRequestId: RUN,
        approvalReference: "pi-1",
        nowMs: NOW,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.code).toBe("PDP_DENIED");
  });

  it("denies with no binding, a revoked binding, or an expired binding", async () => {
    const input = {
      servicePrincipalId: SERVICE_ID,
      tenantId: TENANT,
      runRequestId: RUN,
      approvalReference: "pi-1",
      nowMs: NOW,
    };
    const empty = createMemoryMembershipStore();
    const denied = await resolveLedgerWriteContext(
      ledgerWriteAuthority(empty),
      input,
    );
    expect(denied.ok).toBe(false);

    const revoked = createMemoryMembershipStore();
    await seedBinding(revoked);
    const memberships = await revoked.getMembershipsByUser(SERVICE_ID);
    await revoked.revokeMembership(memberships[0].membershipId, NOW);
    const afterRevoke = await resolveLedgerWriteContext(
      ledgerWriteAuthority(revoked),
      input,
    );
    expect(afterRevoke.ok).toBe(false);

    const expired = createMemoryMembershipStore();
    await seedBinding(expired, { expiresAtMs: NOW - 1 });
    const afterExpiry = await resolveLedgerWriteContext(
      ledgerWriteAuthority(expired),
      input,
    );
    expect(afterExpiry.ok).toBe(false);
  });

  it("denies cross-tenant: the binding must be in the ledger's tenant", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store, { tenantId: "tenant-other" });
    const result = await resolveLedgerWriteContext(
      ledgerWriteAuthority(store),
      {
        servicePrincipalId: SERVICE_ID,
        tenantId: TENANT,
        runRequestId: RUN,
        approvalReference: "pi-1",
        nowMs: NOW,
      },
    );
    expect(result.ok).toBe(false);
  });
});

describe("resolveLedgerWriteContextHeader", () => {
  async function attachedHeader(
    store: MembershipStore,
  ): Promise<{ name: string; value: string }> {
    const result = await resolveLedgerWriteContextHeader({
      memberships: store,
      serviceLogin: SERVICE_LOGIN,
      tenantId: TENANT,
      kind: "charge",
      runRequestId: RUN,
      paymentIntentId: "pi-1",
      nowMs: NOW,
    });
    expect(result.attached).toBe(true);
    if (!result.attached) throw new Error("expected attachment");
    return result;
  }

  it("attaches a header whose value parses to the resolved context", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const header = await attachedHeader(store);
    expect(header.name).toBe(EXECUTION_CONTEXT_HEADER);
    expect(header.name).toBe("x-execution-context");
    const parsed = parseExecutionContext(header.value);
    expect(parsed).not.toBeNull();
    expect(parsed?.principalId).toBe(SERVICE_ID);
    expect(parsed?.tenantId).toBe(TENANT);
    expect(parsed?.taskId).toBe(RUN);
    expect(parsed?.approvalReference).toBe("pi-1");
    expect(parsed?.policyVersion).toBe(AUTHORIZATION_POLICY_VERSION);
  });

  it("never throws for expected non-attachment: identity, tenant, proof, denial", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const base = {
      memberships: store,
      serviceLogin: SERVICE_LOGIN,
      tenantId: TENANT,
      kind: "charge" as const,
      runRequestId: RUN,
      paymentIntentId: "pi-1",
      nowMs: NOW,
    };
    await expect(
      resolveLedgerWriteContextHeader({ ...base, serviceLogin: null }),
    ).resolves.toEqual({ attached: false, reason: "no-service-identity" });
    await expect(
      resolveLedgerWriteContextHeader({
        ...base,
        serviceLogin: "not a login",
      }),
    ).resolves.toEqual({ attached: false, reason: "no-service-identity" });
    await expect(
      resolveLedgerWriteContextHeader({
        ...base,
        serviceLogin: "shared_orchestrator",
      }),
    ).resolves.toEqual({ attached: false, reason: "shared-address" });
    await expect(
      resolveLedgerWriteContextHeader({
        ...base,
        serviceLogin: "default_trader",
      }),
    ).resolves.toEqual({ attached: false, reason: "shared-address" });
    await expect(
      resolveLedgerWriteContextHeader({ ...base, tenantId: undefined }),
    ).resolves.toEqual({ attached: false, reason: "no-verified-tenant" });
    await expect(
      resolveLedgerWriteContextHeader({ ...base, tenantId: "   " }),
    ).resolves.toEqual({ attached: false, reason: "no-verified-tenant" });
    await expect(
      resolveLedgerWriteContextHeader({
        ...base,
        paymentIntentId: undefined,
      }),
    ).resolves.toEqual({ attached: false, reason: "no-approval-reference" });

    const empty = createMemoryMembershipStore();
    await expect(
      resolveLedgerWriteContextHeader({ ...base, memberships: empty }),
    ).resolves.toEqual({
      attached: false,
      reason: "resolution-denied:PDP_DENIED",
    });
  });

  it("propagates authority failures: the caller logs and proceeds", async () => {
    const store = createMemoryMembershipStore();
    const throwing: MembershipStore = {
      ...store,
      getMembershipsByUser: async () => {
        throw new Error("kv down");
      },
    };
    await expect(
      resolveLedgerWriteContextHeader({
        memberships: throwing,
        serviceLogin: SERVICE_LOGIN,
        tenantId: TENANT,
        kind: "charge",
        runRequestId: RUN,
        paymentIntentId: "pi-1",
        nowMs: NOW,
      }),
    ).rejects.toThrow("kv down");
  });
});

describe("carriage: serialize, parse, revalidate", () => {
  async function resolvedContext(store: MembershipStore) {
    const result = await resolveLedgerWriteContext(
      ledgerWriteAuthority(store),
      {
        servicePrincipalId: SERVICE_ID,
        tenantId: TENANT,
        runRequestId: RUN,
        approvalReference: "pi-1",
        nowMs: NOW,
      },
    );
    if (!result.ok) throw new Error("expected resolution");
    return result.context;
  }

  it("round-trips across the boundary and revalidates", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const context = await resolvedContext(store);
    const parsed = parseExecutionContext(serializeExecutionContext(context));
    expect(parsed).toEqual(context);
    const revalidated = await revalidateLedgerWriteContext(
      ledgerWriteAuthority(store),
      parsed!,
      NOW,
    );
    expect(revalidated).toEqual({ ok: true });
  });

  it("rejects a context tampered with in transit", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const context = await resolvedContext(store);
    const tamper = (mutate: (record: Record<string, unknown>) => void) => {
      const record = JSON.parse(
        serializeExecutionContext(context),
      ) as Record<string, unknown>;
      mutate(record);
      return parseExecutionContext(JSON.stringify(record));
    };
    const swappedTenant = tamper((r) => {
      r["tenantId"] = "tenant-other";
    });
    expect(swappedTenant).not.toBeNull();
    expect(
      await revalidateLedgerWriteContext(
        ledgerWriteAuthority(store),
        swappedTenant!,
        NOW,
      ),
    ).toMatchObject({ ok: false, code: "PDP_DENIED" });

    const swappedPrincipal = tamper((r) => {
      r["principalId"] = "service:intruder";
    });
    expect(swappedPrincipal).not.toBeNull();
    expect(
      await revalidateLedgerWriteContext(
        ledgerWriteAuthority(store),
        swappedPrincipal!,
        NOW,
      ),
    ).toMatchObject({ ok: false, code: "PDP_DENIED" });
  });

  it("rejects a stale context after revocation", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const context = await resolvedContext(store);
    const memberships = await store.getMembershipsByUser(SERVICE_ID);
    await store.revokeMembership(memberships[0].membershipId, NOW);
    expect(
      await revalidateLedgerWriteContext(
        ledgerWriteAuthority(store),
        context,
        NOW,
      ),
    ).toMatchObject({ ok: false, code: "PDP_DENIED" });
  });

  it("rejects a context smuggling a connection", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const context = await resolvedContext(store);
    expect(
      await revalidateLedgerWriteContext(
        ledgerWriteAuthority(store),
        { ...context, connectionId: "conn-1" },
        NOW,
      ),
    ).toMatchObject({ ok: false, code: "CONNECTION_NOT_BOUND" });
  });

  it("parse rejects malformed payloads and unknown fields", () => {
    expect(parseExecutionContext("not json")).toBeNull();
    expect(parseExecutionContext(JSON.stringify({ nope: 1 }))).toBeNull();
  });
});

describe("observeLedgerWriteContext", () => {
  function collectors() {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const infos: string[] = [];
    const errors: string[] = [];
    return {
      audits,
      infos,
      errors,
      audit: (type: string, payload: Record<string, unknown>) => {
        audits.push({ type, payload });
      },
      log: {
        info: (event: string) => {
          infos.push(event);
        },
        error: (event: string) => {
          errors.push(event);
        },
      },
    };
  }

  function requestWith(headerValue: string | null): Request {
    return new Request("https://agent.internal/payments/agentic/ledger/record-cfpay", {
      method: "POST",
      headers: {
        ...(headerValue === null
          ? {}
          : { [EXECUTION_CONTEXT_HEADER]: headerValue }),
      },
      body: "{}",
    });
  }

  async function validHeader(store: MembershipStore): Promise<string> {
    const result = await resolveLedgerWriteContextHeader({
      memberships: store,
      serviceLogin: SERVICE_LOGIN,
      tenantId: TENANT,
      kind: "charge",
      runRequestId: RUN,
      paymentIntentId: "pi-1",
      nowMs: NOW,
    });
    if (!result.attached) throw new Error("expected attachment");
    return result.value;
  }

  it("is a silent no-op without a header, and never builds the store", async () => {
    const c = collectors();
    let storeBuilt = false;
    const outcome = await observeLedgerWriteContext({
      getStore: () => {
        storeBuilt = true;
        return createMemoryMembershipStore();
      },
      request: requestWith(null),
      nowMs: NOW,
      audit: c.audit,
      log: c.log,
    });
    expect(outcome).toEqual({ observed: false });
    expect(storeBuilt).toBe(false);
    expect(c.audits).toHaveLength(0);
    expect(c.infos).toHaveLength(0);
    expect(c.errors).toHaveLength(0);
  });

  it("revalidates a carried context and audits the allow", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const c = collectors();
    const outcome = await observeLedgerWriteContext({
      getStore: () => store,
      request: requestWith(await validHeader(store)),
      nowMs: NOW,
      audit: c.audit,
      log: c.log,
    });
    expect(outcome).toMatchObject({ observed: true, revalidated: true });
    expect(c.audits).toHaveLength(1);
    expect(c.audits[0].type).toBe("execution_context.revalidation");
    expect(c.audits[0].payload).toMatchObject({
      outcome: "allowed",
      tenantId: TENANT,
      principalId: SERVICE_ID,
      taskId: RUN,
    });
    expect(c.infos).toContain("commercialExecutionContext.revalidated");
  });

  it("observes a denial without denying: revoked binding", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const header = await validHeader(store);
    const memberships = await store.getMembershipsByUser(SERVICE_ID);
    await store.revokeMembership(memberships[0].membershipId, NOW);
    const c = collectors();
    const outcome = await observeLedgerWriteContext({
      getStore: () => store,
      request: requestWith(header),
      nowMs: NOW,
      audit: c.audit,
      log: c.log,
    });
    expect(outcome).toMatchObject({
      observed: true,
      revalidated: false,
      code: "PDP_DENIED",
    });
    expect(c.audits[0].payload).toMatchObject({ outcome: "denied" });
    expect(c.errors).toContain(
      "commercialExecutionContext.revalidation_denied",
    );
  });

  it("observes a malformed header without throwing", async () => {
    const c = collectors();
    const outcome = await observeLedgerWriteContext({
      getStore: () => createMemoryMembershipStore(),
      request: requestWith("{not json"),
      nowMs: NOW,
      audit: c.audit,
      log: c.log,
    });
    expect(outcome).toMatchObject({
      observed: true,
      revalidated: false,
      code: "MALFORMED_CONTEXT",
    });
    expect(c.audits[0].payload).toMatchObject({ outcome: "malformed" });
  });

  it("never throws: store failure, audit failure, and read failure", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const header = await validHeader(store);
    const c = collectors();

    const storeFailed = await observeLedgerWriteContext({
      getStore: () => {
        throw new Error("kv down");
      },
      request: requestWith(header),
      nowMs: NOW,
      audit: c.audit,
      log: c.log,
    });
    expect(storeFailed).toMatchObject({
      observed: true,
      revalidated: false,
      code: "OBSERVE_ERROR",
    });

    const auditFailed = await observeLedgerWriteContext({
      getStore: () => store,
      request: requestWith(header),
      nowMs: NOW,
      audit: () => {
        throw new Error("audit down");
      },
      log: c.log,
    });
    expect(auditFailed).toMatchObject({ code: "OBSERVE_ERROR" });

    const throwing: MembershipStore = {
      ...store,
      getMembershipsByUser: async () => {
        throw new Error("kv down");
      },
    };
    const readFailed = await observeLedgerWriteContext({
      getStore: () => throwing,
      request: requestWith(header),
      nowMs: NOW,
      audit: c.audit,
      log: c.log,
    });
    expect(readFailed).toMatchObject({ code: "OBSERVE_ERROR" });
  });
});

describe("recordCfpayLedgerRow header carriage", () => {
  function capturingEnv(captured: string[]) {
    const seen = new Map<string, TransactionRecord>();
    const stub = {
      fetch: async (req: Request) => {
        const header = req.headers.get(EXECUTION_CONTEXT_HEADER);
        if (header !== null) captured.push(header);
        const body = (await req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const key = `${body["runRequestId"]}:${body["kind"]}`;
        if (seen.has(key)) {
          return Response.json(
            { duplicate: true, record: seen.get(key) },
            { status: 409 },
          );
        }
        const tx = {
          id: "tx-1",
          sessionId: `screener-payment:${body["runRequestId"]}`,
          action: body["kind"],
        } as TransactionRecord;
        seen.set(key, tx);
        return Response.json({ duplicate: false, record: tx });
      },
    };
    return {
      SERVICE_USER_LOGIN: SERVICE_LOGIN,
      ORCHESTRATOR_AGENT: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
    } as unknown as Env;
  }

  it("attaches the context header when the write resolves one", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const captured: string[] = [];
    const env = capturingEnv(captured);
    const { duplicate } = await recordCfpayLedgerRow(
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
      { membershipStore: store, nowMs: NOW },
    );
    expect(duplicate).toBe(false);
    expect(captured).toHaveLength(1);
    const parsed = parseExecutionContext(captured[0]);
    expect(parsed?.principalId).toBe(SERVICE_ID);
    expect(parsed?.tenantId).toBe(TENANT);
    expect(parsed?.taskId).toBe(RUN);
    expect(parsed?.approvalReference).toBe("pi-1");
  });

  it("attaches a credit context referencing the failure-credit issuance", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const captured: string[] = [];
    const env = capturingEnv(captured);
    await recordCfpayLedgerRow(
      env,
      "credit",
      {
        runRequestId: RUN,
        userId: "user-1",
        family: "stock",
        priceUSD: 0.02,
        tenantId: TENANT,
      },
      { membershipStore: store, nowMs: NOW },
    );
    expect(captured).toHaveLength(1);
    expect(parseExecutionContext(captured[0])?.approvalReference).toBe(
      "failure-credit:run-1",
    );
  });

  it("writes unchanged without a header when no tenant, no binding, or a store failure", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const input = {
      runRequestId: RUN,
      userId: "user-1",
      family: "stock",
      priceUSD: 0.02,
      paymentIntentId: "pi-1",
    };

    const noTenant: string[] = [];
    const noTenantResult = await recordCfpayLedgerRow(
      capturingEnv(noTenant),
      "charge",
      input,
      { membershipStore: store, nowMs: NOW },
    );
    expect(noTenantResult.duplicate).toBe(false);
    expect(noTenant).toHaveLength(0);

    const noBinding: string[] = [];
    const empty = createMemoryMembershipStore();
    const noBindingResult = await recordCfpayLedgerRow(
      capturingEnv(noBinding),
      "charge",
      { ...input, tenantId: TENANT },
      { membershipStore: empty, nowMs: NOW },
    );
    expect(noBindingResult.duplicate).toBe(false);
    expect(noBinding).toHaveLength(0);

    const throwing: MembershipStore = {
      ...store,
      getMembershipsByUser: async () => {
        throw new Error("kv down");
      },
    };
    const failed: string[] = [];
    const failedResult = await recordCfpayLedgerRow(
      capturingEnv(failed),
      "charge",
      { ...input, tenantId: TENANT },
      { membershipStore: throwing, nowMs: NOW },
    );
    expect(failedResult.duplicate).toBe(false);
    expect(failed).toHaveLength(0);
  });
});

describe("handler observe wiring", () => {
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

  function fakeCtx(
    store: MembershipStore,
    audits: Array<{ type: string; payload: Record<string, unknown> }>,
    orm: DatabaseORM,
  ): AgenticPaymentsRouteContext {
    return {
      env: {} as Env,
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

  async function headerFor(
    store: MembershipStore,
    mutate?: (record: Record<string, unknown>) => void,
  ): Promise<string> {
    const result = await resolveLedgerWriteContextHeader({
      memberships: store,
      serviceLogin: SERVICE_LOGIN,
      tenantId: TENANT,
      kind: "charge",
      runRequestId: RUN,
      paymentIntentId: "pi-1",
      nowMs: NOW,
    });
    if (!result.attached) throw new Error("expected attachment");
    if (!mutate) return result.value;
    const record = JSON.parse(result.value) as Record<string, unknown>;
    mutate(record);
    return JSON.stringify(record);
  }

  const callRoute = (
    ctx: AgenticPaymentsRouteContext,
    path: string,
    body: unknown,
    headerValue: string | null,
  ) => {
    const url = new URL(`https://agent.internal${path}`);
    const request = new Request(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(headerValue === null
          ? {}
          : { [EXECUTION_CONTEXT_HEADER]: headerValue }),
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
  };

  const cfpayBody = {
    kind: "charge",
    runRequestId: RUN,
    userId: "user-1",
    family: "stock",
    priceUSD: 0.02,
    paymentIntentId: "pi-1",
  };

  it("record-cfpay: a valid carried context is revalidated and audited", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const { rows, orm } = fakeOrm();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      await headerFor(store),
    );
    expect(res?.status).toBe(200);
    expect(rows).toHaveLength(1);
    const revalidation = audits.find(
      (a) => a.type === "execution_context.revalidation",
    );
    expect(revalidation?.payload).toMatchObject({
      outcome: "allowed",
      tenantId: TENANT,
      principalId: SERVICE_ID,
    });
  });

  it("record-cfpay: no header means no observation and the same write", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const { rows, orm } = fakeOrm();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      null,
    );
    expect(res?.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(
      audits.some((a) => a.type === "execution_context.revalidation"),
    ).toBe(false);
    expect(audits.some((a) => a.type === "payments_cfpay.recorded")).toBe(
      true,
    );
  });

  it("record-cfpay: a tampered context is observed denied AND the write still proceeds (observe mode)", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const { rows, orm } = fakeOrm();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record-cfpay",
      cfpayBody,
      await headerFor(store, (r) => {
        r["tenantId"] = "tenant-other";
      }),
    );
    expect(res?.status).toBe(200);
    expect(rows).toHaveLength(1);
    const revalidation = audits.find(
      (a) => a.type === "execution_context.revalidation",
    );
    expect(revalidation?.payload).toMatchObject({
      outcome: "denied",
      code: "PDP_DENIED",
    });
  });

  it("record: the agent path observes a carried context too", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const { rows, orm } = fakeOrm();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const res = await callRoute(
      fakeCtx(store, audits, orm),
      "/payments/agentic/ledger/record",
      {
        agentId: "agent-1",
        operation: "spend",
        amountCents: 2,
        idempotencyKey: "key-1",
      },
      await headerFor(store),
    );
    expect(res?.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(
      audits.some((a) => a.type === "execution_context.revalidation"),
    ).toBe(true);
  });

  it("record-native: observation runs and the response is unchanged by the header", async () => {
    const store = createMemoryMembershipStore();
    await seedBinding(store);
    const nativeBody = {
      kind: "charge",
      runRequestId: RUN,
      tenantId: TENANT,
      userId: "user-1",
      family: "stock",
      priceUSD: 0.02,
    };
    const withoutHeader: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const plain = await callRoute(
      fakeCtx(store, withoutHeader, fakeOrm().orm),
      "/payments/agentic/ledger/record-native",
      nativeBody,
      null,
    );
    const withHeader: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const observed = await callRoute(
      fakeCtx(store, withHeader, fakeOrm().orm),
      "/payments/agentic/ledger/record-native",
      nativeBody,
      await headerFor(store),
    );
    expect(observed?.status).toBe(plain?.status);
    expect(
      withHeader.some((a) => a.type === "execution_context.revalidation"),
    ).toBe(true);
    expect(
      withoutHeader.some((a) => a.type === "execution_context.revalidation"),
    ).toBe(false);
  });
});
