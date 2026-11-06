/**
 * Issue #2426 (Agent Mesh S16, programme #2225 goal G14) — per-agent
 * identity: registry identity records, per-agent mesh credentials,
 * attestation verify-or-relabel, synthetic-identity dispositions,
 * two-part A2A attribution.
 *
 * What this suite pins:
 *
 *  - The credential module (src/a2a/meshCredentials.ts): one env
 *    credential per A2A surface, derived from A2A_RESOLUTIONS; a
 *    per-agent credential is accepted for its own surface and
 *    refused for every other; once a surface's per-agent credential
 *    is set, the shared token no longer authenticates that surface;
 *    while it is unset, the shared token authenticates it as a
 *    recorded TRANSITIONAL posture; with neither configured the
 *    surface is unconfigured (the edge answers 503).
 *  - The edge (src/a2a/index.ts) through the real dispatcher:
 *    per-agent dispatch works, cross-surface credentials are 401,
 *    and the authenticated attribution (caller + surface +
 *    credential kind) reaches the agent stub as handleA2A's third
 *    argument.
 *  - Attestation (src/agents/did.ts): keyed proofs are real
 *    HMAC-SHA256 and verify via verifyDidAttestation (valid
 *    verifies; tampered fails; wrong key fails); unkeyed proofs are
 *    labelled UnkeyedContentLabel2026 and NEVER verify; the sync
 *    variant carries the same honest label; the DID document no
 *    longer publishes fabricated Ed25519 key material.
 *  - Synthetic-identity dispositions: getUserDid / getLoginDid fail
 *    closed on an empty login instead of minting an "anonymous"
 *    DID; ScreenerAgent's goal-gather paths thread the run owner's
 *    login as tenantId (the "default" literal is gone);
 *    ScheduledAgent's reconcile audit actor is the threaded
 *    operator (route-level and agent-level behavior below), with
 *    the named SCHEDULED_AGENT_AUDIT_ACTOR when no actor is
 *    supplied (the "system" literal is gone).
 *  - Two-part attribution end to end: a payments.process A2A call
 *    through the real PaymentsAgent + real ledger route handler
 *    records BOTH the caller-asserted spending agentId and the
 *    edge-authenticated caller in the payments_agent.recorded
 *    audit record.
 *  - Registry identity records (MESH_IDENTITIES): one per fleet
 *    class, drift-pinned against MESH_SURFACES, A2A_RESOLUTIONS,
 *    and the credential module.
 *
 * Evidence boundary: the ScheduledAgent audit test mocks the chain
 * -schedule adapter/schema/audit-port modules at their import seam
 * (the reconcile report itself is not under test — the actor the
 * audit draft carries is); everything else runs the real modules.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

// Captured audit drafts from the mocked audit port (hoisted: the
// vi.mock factories below run before module scope initializes).
const auditDrafts = vi.hoisted(() => [] as any[]);

vi.mock("../src/data/createChainSchedulePorts", () => ({
  createChainScheduleAdapter: () => ({ db: {} }),
  projectAfterTransition: async () => {},
}));
vi.mock("../src/data/d1ChainScheduleAdapter", () => ({
  ensureChainScheduleSchema: async () => {},
}));
vi.mock("../src/data/createAuditReportPorts", () => ({
  recordAuditEventBestEffort: async (_env: unknown, draft: any) => {
    auditDrafts.push(draft);
  },
}));

import {
  a2aSurfaceCredentialEnv,
  A2A_SURFACE_CREDENTIAL_ENVS,
  authenticateA2A,
} from "../src/a2a/meshCredentials";
import { handleA2A } from "../src/a2a/index";
import { A2A_RESOLUTIONS } from "../src/a2a/resolution";
import {
  AGENT_DIDS,
  createDidAttestation,
  createDidAttestationSync,
  getLoginDid,
  getUserDid,
  resolveAgentDidDocument,
  verifyDidAttestation,
} from "../src/agents/did";
import {
  MESH_AGENTS,
  MESH_SURFACES,
  MESH_IDENTITIES,
  getIdentityRecord,
  getDoor,
} from "../src/agents/registry";
import { dispatchPaymentsA2A } from "../src/agents/payments/a2aDispatch";
import { PaymentsAgent } from "../src/agents/payments-agent";
import { ScheduledAgent, SCHEDULED_AGENT_AUDIT_ACTOR } from "../src/agents/scheduled-agent";
import { handleReconcileChainsRoute } from "../src/data/chainStatusRoute";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { handleAgenticPaymentsRoutes } from "../src/agents/routes/agenticPayments";

afterEach(() => {
  vi.unstubAllGlobals();
  auditDrafts.length = 0;
});

// ---------------------------------------------------------------------------
// Per-agent mesh credentials — the module
// ---------------------------------------------------------------------------

describe("mesh credentials — surface credential map (#2426)", () => {
  it("derives one credential env name per A2A surface, from the resolutions", () => {
    expect(Object.keys(A2A_SURFACE_CREDENTIAL_ENVS).sort()).toEqual(
      Object.keys(A2A_RESOLUTIONS).sort(),
    );
    expect(Object.keys(A2A_SURFACE_CREDENTIAL_ENVS)).toHaveLength(15);
    expect(a2aSurfaceCredentialEnv("trading")).toBe("A2A_TOKEN_TRADING");
    expect(a2aSurfaceCredentialEnv("report-asset")).toBe("A2A_TOKEN_REPORT_ASSET");
    expect(a2aSurfaceCredentialEnv("aisearch")).toBe("A2A_TOKEN_AISEARCH");
    expect(a2aSurfaceCredentialEnv("nlq")).toBe("A2A_TOKEN_NLQ");
  });

  it("accepts a per-agent credential for its own surface, with the caller named", () => {
    const env = { A2A_TOKEN_TRADING: "s16-fake-trading-token" };
    const out = authenticateA2A(env, "trading", "s16-fake-trading-token");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.attribution.credential).toBe("per-agent");
      expect(out.attribution.surface).toBe("trading");
      expect(out.attribution.caller).toBe("a2a-credential:trading");
    }
  });

  it("refuses a per-agent credential presented to another surface", () => {
    const env = {
      A2A_TOKEN_TRADING: "s16-fake-trading-token",
      A2A_TOKEN_PAYMENTS: "s16-fake-payments-token",
      A2A_API_TOKEN: "s16-fake-shared-token",
    };
    const out = authenticateA2A(env, "payments", "s16-fake-trading-token");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unauthorized");
  });

  it("once a surface's per-agent credential is set, the shared token no longer authenticates it", () => {
    const env = {
      A2A_TOKEN_TRADING: "s16-fake-trading-token",
      A2A_API_TOKEN: "s16-fake-shared-token",
    };
    const out = authenticateA2A(env, "trading", "s16-fake-shared-token");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unauthorized");
  });

  it("TRANSITIONAL: the shared token authenticates a surface whose per-agent credential is unset", () => {
    const env = { A2A_API_TOKEN: "s16-fake-shared-token" };
    const out = authenticateA2A(env, "payments", "s16-fake-shared-token");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.attribution.credential).toBe("shared-transitional");
      expect(out.attribution.caller).toBe("a2a-credential:shared-transitional");
    }
  });

  it("with neither credential configured the surface is unconfigured (fail closed)", () => {
    expect(authenticateA2A({}, "trading", "anything")).toEqual({
      ok: false,
      reason: "unconfigured",
    });
    // An unknown surface has no per-agent env by definition; with no
    // shared token it is unconfigured too (today's 503 posture).
    expect(authenticateA2A({}, "nope", "anything")).toEqual({
      ok: false,
      reason: "unconfigured",
    });
    // Another surface's configured credential does not configure this one.
    expect(
      authenticateA2A({ A2A_TOKEN_TRADING: "s16-fake-trading-token" }, "payments", "s16-fake-trading-token"),
    ).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("a missing or wrong credential is unauthorized when the surface is configured", () => {
    const env = { A2A_API_TOKEN: "s16-fake-shared-token" };
    expect(authenticateA2A(env, "trading", "")).toEqual({ ok: false, reason: "unauthorized" });
    expect(authenticateA2A(env, "trading", "wr0ng")).toEqual({ ok: false, reason: "unauthorized" });
  });
});

// ---------------------------------------------------------------------------
// Per-agent mesh credentials — through the real edge dispatcher
// ---------------------------------------------------------------------------

function edgeEnv(extra: Record<string, unknown>, calls: unknown[]) {
  const stub = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      handleA2A: async (body: unknown, origin: string, attribution?: unknown) => {
        calls.push([body, origin, attribution]);
        return { text: "ok", data: { ok: true } };
      },
    }),
  };
  return { ...extra, TRADING_AGENT: stub, PAYMENTS_AGENT: stub } as any;
}

const edgePost = (path: string, token?: string) =>
  new Request(`https://agent.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "message/send", params: {} }),
  });

describe("mesh credentials — the A2A edge (#2426)", () => {
  it("dispatches with the surface's per-agent credential and passes two-part attribution to the stub", async () => {
    const calls: unknown[] = [];
    const env = edgeEnv({ A2A_TOKEN_TRADING: "s16-fake-trading-token" }, calls);
    const res = await handleA2A(edgePost("/a2a/trading", "s16-fake-trading-token"), env);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const attribution = (calls[0] as any[])[2];
    expect(attribution).toMatchObject({
      surface: "trading",
      caller: "a2a-credential:trading",
      credential: "per-agent",
    });
  });

  it("refuses another surface's credential at the edge (401; stub never reached)", async () => {
    const calls: unknown[] = [];
    const env = edgeEnv(
      {
        A2A_TOKEN_TRADING: "s16-fake-trading-token",
        A2A_TOKEN_PAYMENTS: "s16-fake-payments-token",
      },
      calls,
    );
    const res = await handleA2A(edgePost("/a2a/payments", "s16-fake-trading-token"), env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("shared token still dispatches transitionally, and the attribution says so", async () => {
    const calls: unknown[] = [];
    const env = edgeEnv({ A2A_API_TOKEN: "s16-fake-shared-token" }, calls);
    const res = await handleA2A(edgePost("/a2a/trading", "s16-fake-shared-token"), env);
    expect(res.status).toBe(200);
    const attribution = (calls[0] as any[])[2];
    expect(attribution).toMatchObject({
      surface: "trading",
      caller: "a2a-credential:shared-transitional",
      credential: "shared-transitional",
    });
  });

  it("with nothing configured the edge stays 503, and an unknown agent with a valid shared token stays 404", async () => {
    const calls: unknown[] = [];
    expect(
      (await handleA2A(edgePost("/a2a/trading", "anything"), edgeEnv({}, calls))).status,
    ).toBe(503);
    const env = edgeEnv({ A2A_API_TOKEN: "s16-fake-shared-token" }, calls);
    expect(
      (await handleA2A(edgePost("/a2a/nope", "s16-fake-shared-token"), env)).status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attestation — keyed proof with a verify function; unkeyed relabelled
// ---------------------------------------------------------------------------

const ATTEST_PARAMS = {
  draftId: "draft_s16_1",
  action: "charge",
  amount: 12.5,
  currency: "usd",
  customer: "cust_s16",
  gateway: "stripe",
  proposerDid: AGENT_DIDS.PAYMENTS,
  authorizerDid: "did:user:github:octocat",
};
const ATTEST_BINDING = { draftId: "draft_s16_1", customer: "cust_s16" };
const FAKE_KEY = "s16-fake-attestation-key";

describe("DID attestation — verify or relabel (#2426)", () => {
  it("a keyed proof is a real HMAC and verifies round-trip", async () => {
    const proof = await createDidAttestation(ATTEST_PARAMS, FAKE_KEY);
    expect(proof.proofType).toBe("HmacSha256Verification2026");
    expect(proof.signature).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyDidAttestation(proof, ATTEST_BINDING, FAKE_KEY)).resolves.toBe(true);
  });

  it("a tampered proof fails verification (amount, gateway, signature)", async () => {
    const proof = await createDidAttestation(ATTEST_PARAMS, FAKE_KEY);
    await expect(
      verifyDidAttestation({ ...proof, amount: 999 }, ATTEST_BINDING, FAKE_KEY),
    ).resolves.toBe(false);
    await expect(
      verifyDidAttestation({ ...proof, gateway: "paypal" }, ATTEST_BINDING, FAKE_KEY),
    ).resolves.toBe(false);
    const flippedSignature =
      (proof.signature[0] === "0" ? "1" : "0") + proof.signature.slice(1);
    await expect(
      verifyDidAttestation(
        { ...proof, signature: flippedSignature },
        ATTEST_BINDING,
        FAKE_KEY,
      ),
    ).resolves.toBe(false);
    // The binding inputs are part of the proof: a proof transplanted
    // onto another draft does not verify.
    await expect(
      verifyDidAttestation(proof, { draftId: "draft_other", customer: "cust_s16" }, FAKE_KEY),
    ).resolves.toBe(false);
  });

  it("the wrong key fails verification", async () => {
    const proof = await createDidAttestation(ATTEST_PARAMS, FAKE_KEY);
    await expect(verifyDidAttestation(proof, ATTEST_BINDING, "s16-wrong-key")).resolves.toBe(false);
  });

  it("an unkeyed proof is labelled a content label and never verifies", async () => {
    const proof = await createDidAttestation(ATTEST_PARAMS);
    expect(proof.proofType).toBe("UnkeyedContentLabel2026");
    expect(proof.signature).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyDidAttestation(proof, ATTEST_BINDING, FAKE_KEY)).resolves.toBe(false);
    await expect(verifyDidAttestation(proof, ATTEST_BINDING, "")).resolves.toBe(false);
  });

  it("the sync variant carries the same honest label (its value is not a signature)", () => {
    const proof = createDidAttestationSync(ATTEST_PARAMS);
    expect(proof.proofType).toBe("UnkeyedContentLabel2026");
    expect(proof.signature.startsWith("sig_0x")).toBe(true);
  });

  it("the DID document publishes no fabricated Ed25519 key material", () => {
    const doc = resolveAgentDidDocument(AGENT_DIDS.PAYMENTS);
    expect(doc.verificationMethod.length).toBeGreaterThan(0);
    expect(doc.verificationMethod[0].type).not.toBe("Ed25519VerificationKey2020");
    expect(doc.verificationMethod[0].type).toBe("UnkeyedContentLabel2026");
    expect(doc.verificationMethod[0].publicKeyMultibase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Synthetic-identity dispositions
// ---------------------------------------------------------------------------

describe("synthetic identities — DID derivations fail closed (#2426)", () => {
  it("getUserDid refuses an empty login instead of minting an anonymous DID", () => {
    expect(() => getUserDid("")).toThrow(/refusing to derive/i);
    expect(() => getUserDid("   ")).toThrow(/refusing to derive/i);
    expect(() => getUserDid("!!!")).toThrow(/refusing to derive/i);
    expect(getUserDid("OctoCat")).toBe("did:user:github:octocat");
  });

  it("getLoginDid refuses an empty login on every provider", () => {
    expect(() => getLoginDid("github", "")).toThrow(/refusing to derive/i);
    expect(() => getLoginDid("google", "  ")).toThrow(/refusing to derive/i);
    expect(getLoginDid("google", "OctoCat")).toBe("did:user:google:octocat");
  });
});

describe("synthetic identities — ScreenerAgent tenant + ScheduledAgent actor (#2426)", () => {
  it("the screener goal-gather paths thread the run owner's login as tenantId", () => {
    const src = read("src/agents/screener-agent.ts");
    expect(src).not.toContain('tenantId: "default"');
    expect(src.split("tenantId: userLogin").length - 1).toBe(2);
  });

  it("the scheduled-agent reconcile audit actor is no longer the 'system' literal", () => {
    const src = read("src/agents/scheduled-agent.ts");
    expect(src).not.toContain('actor: "system"');
    expect(SCHEDULED_AGENT_AUDIT_ACTOR).toBe("scheduled-agent");
    expect(src).toContain("SCHEDULED_AGENT_AUDIT_ACTOR");
  });

  it("the reconcile route threads the operator's login as the audit actor", async () => {
    const seen: any[] = [];
    const res = await handleReconcileChainsRoute({
      session: { githubLogin: "operator-a", internalUserId: "user-1" },
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runReconcile: async (input: any) => {
        seen.push(input);
        return { checked: 0, reconciled: 0, alreadyCurrent: 0, errors: [] };
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].actor).toBe("operator-a");
  });

  it("the agent's reconcile audit row carries the threaded actor, or the named agent identity when none is supplied", async () => {
    const agent = Object.create(ScheduledAgent.prototype) as any;
    agent.env = {};
    agent.ctx = {
      storage: {
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
      },
    };
    await agent.reconcileChainScheduleProjection("primary", "operator-a");
    expect(auditDrafts.length).toBe(1);
    expect(auditDrafts[0].actor).toBe("operator-a");

    auditDrafts.length = 0;
    await agent.reconcileChainScheduleProjection("primary");
    expect(auditDrafts.length).toBe(1);
    expect(auditDrafts[0].actor).toBe("scheduled-agent");
  });
});

// ---------------------------------------------------------------------------
// Two-part attribution — payments A2A, end to end
// ---------------------------------------------------------------------------

describe("two-part attribution — payments A2A records (#2426)", () => {
  it("the dispatch threads the edge-authenticated caller into the process request", async () => {
    const seen: any[] = [];
    const data = await dispatchPaymentsA2A({} as any, {
      operation: "payments.process",
      op: "nlq.execute",
      agentId: "orchestrator",
      amountCents: 100,
      idempotencyKey: "s16-dispatch-1",
      paymentProof: "proof",
    }, {
      executor: {
        budgetCheck: async () => ({ allowed: true }),
        todaySpent: async () => 0,
        listPayments: async () => [],
        processPaidRequest: async (req: any) => {
          seen.push(req);
          return {
            id: "pay_1",
            agentId: req.agentId,
            operation: req.operation,
            amountCents: req.amountCents,
            timestamp: new Date().toISOString(),
            idempotencyKey: req.idempotencyKey,
            status: "verified" as const,
          };
        },
      },
      attribution: {
        surface: "payments",
        caller: "a2a-credential:payments",
        credential: "per-agent" as const,
      },
    });
    expect(data.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].agentId).toBe("orchestrator");
    expect(seen[0].caller).toBe("a2a-credential:payments");
  });

  it("a payments.process call records BOTH parts in the audit record it already writes", async () => {
    // The S3 harness pattern: a real ledger owner (DatabaseORM over
    // MockSqlStorage) behind the real agentic-payments route
    // handler, bound as ORCHESTRATOR_AGENT; the audit port captures.
    const auditCalls: any[] = [];
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("default_trader");
    const routeCtx = {
      env: {},
      getOrm: () => orm,
      audit: (type: string, agent: string, payload: any) =>
        auditCalls.push({ type, agent, payload }),
    };
    const env: any = {
      CF_WALLET_FACILITATOR: "https://facilitator.test",
      SERVICE_USER_LOGIN: "default_trader",
      ORCHESTRATOR_AGENT: {
        idFromName: (name: string) => name,
        get: (_id: unknown) => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            const res = await handleAgenticPaymentsRoutes(
              req,
              url,
              url.pathname,
              "default_trader",
              routeCtx as any,
            );
            return res ?? Response.json({ error: "no such route" }, { status: 404 });
          },
        }),
      },
    };
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ isValid: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const agent = new (PaymentsAgent as any)(
      {
        storage: {
          get: async () => undefined,
          put: async () => {},
          delete: async () => {},
        },
      },
      env,
    );
    const proof = btoa(
      JSON.stringify({ signature: "s16-fake-proof-signature", payer: "0xS16Payer" }),
    );
    const outcome = await agent.handleA2A(
      {
        operation: "payments.process",
        op: "nlq.execute",
        agentId: "orchestrator",
        amountCents: 100,
        idempotencyKey: "s16-e2e-1",
        paymentProof: proof,
      },
      "https://agent.test",
      {
        surface: "payments",
        caller: "a2a-credential:payments",
        credential: "per-agent",
      },
    );
    expect(outcome.data.ok).toBe(true);
    const recorded = auditCalls.filter((c) => c.type === "payments_agent.recorded");
    expect(recorded).toHaveLength(1);
    // Part 1: the spending agent the caller named (S3's discipline).
    expect(recorded[0].payload.agentId).toBe("orchestrator");
    // Part 2: the caller the edge authenticated (S16).
    expect(recorded[0].payload.caller).toBe("a2a-credential:payments");
    // The recording agent is the audit row's own agent field.
    expect(recorded[0].agent).toBe("payments");
  });
});

// ---------------------------------------------------------------------------
// Registry identity records
// ---------------------------------------------------------------------------

describe("registry identity records (#2426)", () => {
  it("covers exactly the fleet roster, one record per class", () => {
    expect(MESH_IDENTITIES.map((r) => r.className)).toEqual(
      MESH_AGENTS.map((a) => a.className),
    );
    for (const record of MESH_IDENTITIES) {
      expect(record.identitySource.length).toBeGreaterThan(20);
      expect(record.attribution.length).toBeGreaterThan(20);
      expect(getIdentityRecord(record.className)).toBe(record);
    }
  });

  it("records each class's A2A surfaces and their per-agent credential env names", () => {
    for (const record of MESH_IDENTITIES) {
      const surfaces = MESH_SURFACES.filter(
        (s) => s.ownerClass === record.className && s.dispatch,
      ).map((s) => s.name);
      expect(record.a2aSurfaces, record.className).toEqual(surfaces);
      expect(record.meshCredentials, record.className).toEqual(
        surfaces.map((s) => A2A_SURFACE_CREDENTIAL_ENVS[s]),
      );
    }
    // The two classes whose identity story this slice completes:
    expect(getIdentityRecord("SlackAgent")?.meshCredentials).toEqual(["A2A_TOKEN_SLACK"]);
    expect(getIdentityRecord("PaymentsAgent")?.did).toBe(AGENT_DIDS.PAYMENTS);
    expect(getIdentityRecord("TickerAgent")?.meshCredentials).toEqual([]);
  });

  it("the A2A door's recorded gate names the per-agent credential and the transitional fallback", () => {
    const gate = getDoor("a2a")?.gate ?? "";
    expect(gate).toContain("A2A_TOKEN_<SURFACE>");
    expect(gate).toContain("TRANSITIONAL");
  });
});
