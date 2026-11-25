/**
 * Monetization Phase 1.3 (#2522, sub-issue of #2405): tier plumbing.
 *
 * RED-first pins: the tier attribute slice 2 records (#2408) must be
 * consumed where it matters —
 * 1. Gate tier-decision audit: every served paid call writes one
 *    `commercial.tier.decision` mas_events row (x402 + MPP branches).
 *    An audit write failure never refuses or unserves the call (the
 *    meter row remains the authoritative per-call tier record).
 * 2. Email content selection by tier over the existing lifecycle
 *    routes: Subscribed → full digest; Free/PayPerUse → capped digest
 *    (limitedDigestItemCap items + a factual cap line); welcome
 *    states the tier factually. Preferences and security-mail rules
 *    unchanged; tier-store failure on a send route refuses typed
 *    503, never sends on an unknown tier.
 * 3. Tier-change audit on the existing mutating routes: account
 *    upsert / activation / cancel / refund-execute audits carry the
 *    previous → new effective tier (cancel: effective tier at cancel
 *    time, access continuing to periodEnd).
 *
 * Deliberately NOT pinned here: the Subscribed included-run bypass
 * at the premium gate (deferred to Phase 2 — needs owner-decided
 * included-usage rules), B1 teaser links, and any new store/route.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDigestEmail,
  buildWelcomeEmail,
  sendDailyDigest,
  sendWelcomeBestEffort,
} from "../src/services/lifecycleEmail";
import { LIFECYCLE_DEFAULTS } from "../src/config/lifecycleDefaults";
import {
  resolveEffectiveTier,
  resolveTierTransition,
} from "../src/data/subscriptionPorts";
import type { StoreTier } from "../src/data/commercialPorts";
import type { LifecycleStore } from "../src/data/lifecyclePorts";
import {
  ETradeAgenticPaymentService,
  payerScopeId,
  TRADING_PAID_SERVICES,
} from "../src/services/agenticPayments";
import type { MeteredGateOptions } from "../src/services/meteredPaymentGate";
import type {
  InsertUsageEventRow,
  UsageEventPort,
} from "../src/data/canonicalReportStorePorts";
import type { X402ClaimVerifier } from "../src/services/x402Verifier";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
// #6102: the tier-decision audit writes to D1 now. The shared
// mock is imported under an alias — this file already defines a
// local MockD1Database (used by the email-route harness below).
import { MockD1Database as SharedMockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import { APPROVED_PREMIUM_PRICES } from "./premiumPriceCatalogueFixture";

// #5609 (G-7): the gate takes its price as an argument — the caller
// resolves the APPROVED catalogue price. These tests drive the gate
// directly, so the price comes from the approved premium catalogue.
const OPTIONS_SCAN_PRICE = APPROVED_PREMIUM_PRICES["options-scan"];
import type { Env, X402PaymentProof } from "../src/types";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import { createLifecycleAdapter } from "../src/data/createLifecyclePorts";
import { ensureLifecycleSchema } from "../src/data/d1LifecycleAdapter";

// ---------------------------------------------------------------------------
// MPP fakes (mirrors tests/metered_payment_gate_2408.test.ts)
// ---------------------------------------------------------------------------
const mppFake = vi.hoisted(() => ({
  mode: "verified" as "verified" | "challenge",
  source: undefined as string | undefined,
}));

vi.mock("mppx/server", () => ({
  Mppx: {
    create: (_config: unknown) => ({
      charge: (_options: unknown) => async (_req: Request) => {
        if (mppFake.mode === "challenge") {
          return {
            status: 402,
            challenge: new Response("Payment required", {
              status: 402,
              headers: { "WWW-Authenticate": 'Payment id="fake-challenge", realm="test"' },
            }),
          };
        }
        return { status: 200, withReceipt: (res: Response) => res };
      },
    }),
  },
  tempo: { charge: (_config: unknown) => ({}) },
}));

vi.mock("mppx", () => ({
  Credential: {
    fromRequest: (_req: Request) => ({
      challenge: {},
      payload: {},
      ...(mppFake.source ? { source: mppFake.source } : {}),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures shared by the gate-audit tests
// ---------------------------------------------------------------------------
const PAYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x71C8363837918a211797E3c76A8B3C4258759550";
const MPP_PAYER = "0x700C0FFEE700C0FFEE700C0FFEE700C0FFEE7001";

let txCounter = 0;
const nextTxHash = () => `0x${(++txCounter).toString(16).padStart(64, "0")}`;

const verifyingClaim: X402ClaimVerifier = async ({ proof }) => ({
  ok: true,
  payer: proof.payer,
  txHash: proof.txHash || "",
});

class CapturingMeter implements UsageEventPort {
  rows: InsertUsageEventRow[] = [];
  ensureSchema(): void {}
  insertEvent(row: InsertUsageEventRow): void {
    if (this.rows.some((r) => r.id === row.id)) {
      throw new Error(`UNIQUE constraint failed: usage_events.id`);
    }
    this.rows.push({ ...row });
  }
  listByUser(userLogin: string, limit: number) {
    return this.rows
      .filter((r) => r.userLogin === userLogin)
      .slice(-limit)
      .map(({ id, userLogin: u, runId, category, createdAt }) => ({ id, userLogin: u, runId, category, createdAt }));
  }
}

function makeService(claimVerifier: X402ClaimVerifier = verifyingClaim, agentDb?: unknown) {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("trader_session_1");
  // #6102: the tier-decision audit resolves from env.AGENT_DB — a
  // fresh mock per service (the port is memoized per env object).
  // A caller may pass a throwing stub DB instead, to prove an
  // audit failure never refuses the call.
  const d1Mock = agentDb ?? new SharedMockD1Database();
  const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
  const env = {
    AGENT_DB: d1Mock,
    X402_NETWORK: "base-sepolia",
    X402_RECIPIENT_ADDRESS: RECIPIENT,
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
  } as unknown as Env;
  const service = new ETradeAgenticPaymentService(orm, env, "trader_session_1", claimVerifier);
  return { orm, service, d1Store };
}

/**
 * A working D1 mock whose commercial.tier.decision inserts throw:
 * ONLY the tier-decision audit fails. A blanket throwing AGENT_DB
 * would also break verifyPayment (its tx-hash claim goes through
 * the D1-backed bucket ports when AGENT_DB is bound), and failing
 * every mas_events insert would break the AGENTIC_PAYMENT_COLLECTED
 * audit that verifyPayment awaits without a try/catch — either way
 * the call would 402 before ever reaching the tier audit. The
 * test's point is that a tier-audit failure alone never refuses
 * the call. The insert's bound params are in column order
 * (id, session_id, type, ...) so params[2] is the event type.
 */
class AuditFailingD1Database extends SharedMockD1Database {
  override prepare(sql: string): any {
    const stmt: any = super.prepare(sql);
    if (!/^\s*insert\s+into\s+mas_events\b/i.test(sql)) return stmt;
    return {
      bind: (...params: unknown[]) => {
        const bound: any = stmt.bind(...params);
        if (params[2] !== "commercial.tier.decision") return bound;
        return {
          ...bound,
          run: async () => {
            throw new Error("audit store unavailable");
          },
        };
      },
    };
  }
}

function paidRequest(service: ETradeAgenticPaymentService, tier: { resource: string; priceUSD: number }, txHash: string) {
  const challenge = service.createX402Challenge(tier.resource, tier.priceUSD);
  const proof: X402PaymentProof = {
    payer: PAYER,
    signature: `0x${"b".repeat(64)}`,
    txHash,
    nonce: challenge.nonce,
    timestamp: Date.now(),
  };
  return new Request(`https://agent.internal${tier.resource}`, {
    method: "GET",
    headers: {
      "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64"),
    },
  });
}

function meteredOptions(meter: UsageEventPort, category: string, resolveTier?: MeteredGateOptions["resolveTier"]): MeteredGateOptions {
  return { meter, category, ...(resolveTier ? { resolveTier } : {}) };
}

/** Read tier-decision rows from the D1 audit store, payloads parsed (D1 stores payload as JSON TEXT). */
async function readTierDecisions(d1Store: D1AuditEventStore) {
  const rows = await d1Store.findMany({ where: { type: "commercial.tier.decision" } });
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as unknown as string) }));
}

beforeEach(() => {
  mppFake.mode = "verified";
  mppFake.source = undefined;
});

// ---------------------------------------------------------------------------
// 1. Welcome builder: tier stated factually
// ---------------------------------------------------------------------------
describe("welcome email states the tier (#2522)", () => {
  it("defaults to Free when no tier is given", () => {
    const { body } = buildWelcomeEmail("u1");
    expect(body).toContain("Your current tier is Free.");
  });

  it("states Subscribed and PayPerUse tiers", () => {
    expect(buildWelcomeEmail("u1", "Subscribed").body).toContain("Your current tier is Subscribed.");
    expect(buildWelcomeEmail("u1", "PayPerUse").body).toContain("Your current tier is PayPerUse.");
  });

  it("keeps the existing welcome lines alongside the tier line", () => {
    const { subject, body } = buildWelcomeEmail("u1", "Subscribed");
    expect(subject).toBe("Welcome to the screener service");
    expect(body).toContain("Hello u1,");
    expect(body).toContain("digest mail is opt-in and off by default.");
    expect(body).toContain("Security mail about your account cannot be turned off.");
  });
});

// ---------------------------------------------------------------------------
// 2. Digest builder: Subscribed full, others capped
// ---------------------------------------------------------------------------
describe("digest email capped by tier (#2522)", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("Subscribed receives every item with no cap line", () => {
    const { body } = buildDigestEmail("u1", items, "Subscribed");
    for (const item of items) expect(body).toContain(`- ${item}`);
    expect(body).not.toMatch(/Showing \d+ of \d+/);
  });

  it("Free receives only the cap, plus a factual cap line", () => {
    expect(LIFECYCLE_DEFAULTS.limitedDigestItemCap).toBe(3);
    const { body } = buildDigestEmail("u1", items, "Free");
    expect(body).toContain("- a");
    expect(body).toContain("- c");
    expect(body).not.toContain("- d");
    expect(body).toContain("Showing 3 of 5 digest items for your current tier.");
  });

  it("PayPerUse is capped like Free (one-off payments confer no ongoing benefit)", () => {
    const { body } = buildDigestEmail("u1", items, "PayPerUse");
    expect(body).not.toContain("- d");
    expect(body).toContain("Showing 3 of 5 digest items for your current tier.");
  });

  it("no cap line when nothing was capped, and no line for an empty digest", () => {
    expect(buildDigestEmail("u1", ["a", "b"], "Free").body).not.toMatch(/Showing \d+ of \d+/);
    expect(buildDigestEmail("u1", [], "Free").body).not.toMatch(/Showing \d+ of \d+/);
  });

  it("defaults to Free (capped) when no tier is given, and keeps the unsubscribe block", () => {
    const { body } = buildDigestEmail("u1", items, undefined, "https://example.test/unsub?token=x");
    expect(body).not.toContain("- d");
    expect(body).toContain("Showing 3 of 5 digest items for your current tier.");
    expect(body).toContain("To stop digest mail only, use this link: https://example.test/unsub?token=x");
    expect(body).toContain("Security mail about your account is unaffected by that link.");
  });
});

// ---------------------------------------------------------------------------
// 3. Sender tier pass-through + preference interplay
// ---------------------------------------------------------------------------
function stubLifecycleStore(overrides: Partial<{
  digestEnabled: boolean;
  welcomeEnabled: boolean;
  sentToday: boolean;
}> = {}) {
  let sent = overrides.sentToday ?? false;
  return {
    store: {
      getPreferences: async () => ({
        userId: "u1",
        tenantId: "t1",
        digestEnabled: overrides.digestEnabled ?? true,
        welcomeEnabled: overrides.welcomeEnabled ?? true,
        updatedAtMs: Date.now(),
      }),
      setPreferences: async (input: any) => input,
      hasSentDigest: async () => sent,
      markDigestSent: async () => {
        sent = true;
      },
    } as unknown as LifecycleStore,
    wasMarked: () => sent,
  };
}

describe("lifecycle senders pass the tier through (#2522)", () => {
  it("welcome send carries the Subscribed tier line", async () => {
    const sent: any[] = [];
    const result = await sendWelcomeBestEffort({
      sender: { send: async (input) => {
        sent.push(input);
        return { ok: true };
      } },
      email: "u1@example.com",
      userId: "u1",
      tier: "Subscribed",
    });
    expect(result.sent).toBe(true);
    expect(sent[0].body).toContain("Your current tier is Subscribed.");
  });

  it("welcome opt-out still suppresses regardless of tier", async () => {
    const { store } = stubLifecycleStore({ welcomeEnabled: false });
    const prefs = await store.getPreferences("u1", "t1");
    const sent: any[] = [];
    const result = await sendWelcomeBestEffort({
      sender: { send: async (input) => {
        sent.push(input);
        return { ok: true };
      } },
      email: "u1@example.com",
      userId: "u1",
      preferences: prefs,
      tier: "Subscribed",
    });
    expect(result).toEqual({ sent: false, reason: "welcome-opted-out" });
    expect(sent).toHaveLength(0);
  });

  it("digest send caps for Free and marks the day only on success", async () => {
    const { store, wasMarked } = stubLifecycleStore({ digestEnabled: true });
    const sent: any[] = [];
    const result = await sendDailyDigest({
      store,
      sender: { send: async (input) => {
        sent.push(input);
        return { ok: true };
      } },
      userId: "u1",
      tenantId: "t1",
      email: "u1@example.com",
      items: ["a", "b", "c", "d", "e"],
      tier: "Free",
    });
    expect(result).toEqual({ sent: true });
    expect(sent[0].body).not.toContain("- d");
    expect(sent[0].body).toContain("Showing 3 of 5 digest items for your current tier.");
    expect(wasMarked()).toBe(true);
  });

  it("digest opt-out, already-sent, and empty still take precedence over tier", async () => {
    const optedOut = stubLifecycleStore({ digestEnabled: false });
    await expect(sendDailyDigest({
      store: optedOut.store,
      sender: { send: async () => ({ ok: true }) },
      userId: "u1", tenantId: "t1", email: "u1@example.com",
      items: ["a"], tier: "Subscribed",
    })).resolves.toEqual({ sent: false, reason: "digest-opted-out" });

    const already = stubLifecycleStore({ sentToday: true });
    await expect(sendDailyDigest({
      store: already.store,
      sender: { send: async () => ({ ok: true }) },
      userId: "u1", tenantId: "t1", email: "u1@example.com",
      items: ["a"], tier: "Subscribed",
    })).resolves.toEqual({ sent: false, reason: "already-sent-today" });

    const { store } = stubLifecycleStore({});
    await expect(sendDailyDigest({
      store,
      sender: { send: async () => ({ ok: true }) },
      userId: "u1", tenantId: "t1", email: "u1@example.com",
      items: [], tier: "Subscribed",
    })).resolves.toEqual({ sent: false, reason: "empty-skipped" });
  });
});

// ---------------------------------------------------------------------------
// 4. Tier transition helper (pure; routes consume it for audit payloads)
// ---------------------------------------------------------------------------
describe("resolveTierTransition (#2522)", () => {
  const now = Date.now();
  const future = now + 30 * 86_400_000;
  const past = now - 86_400_000;

  it("activation: Free → Subscribed via a new unexpired row", () => {
    const t = resolveTierTransition({ tier: "Free" }, [], { tier: "Free", tierSource: "subscription" }, [{ periodEndMs: future }], now);
    expect(t).toEqual({ previousEffectiveTier: "Free", newEffectiveTier: "Subscribed" });
  });

  it("operator grant: Free → PayPerUse", () => {
    const t = resolveTierTransition(null, [], { tier: "PayPerUse", tierSource: "operator" }, [], now);
    expect(t).toEqual({ previousEffectiveTier: "Free", newEffectiveTier: "PayPerUse" });
  });

  it("cancel-at-period-end: Subscribed → Subscribed (access continues to periodEnd)", () => {
    const t = resolveTierTransition(
      { tier: "Free", tierSource: "subscription" }, [{ periodEndMs: future }],
      { tier: "Free", tierSource: "subscription" }, [{ periodEndMs: future }],
      now,
    );
    expect(t).toEqual({ previousEffectiveTier: "Subscribed", newEffectiveTier: "Subscribed" });
  });

  it("revoke: Subscribed → Free when the only unexpired row is revoked", () => {
    const t = resolveTierTransition(
      { tier: "Free", tierSource: "subscription" }, [{ periodEndMs: future }],
      { tier: "Free", tierSource: "subscription" }, [{ periodEndMs: now }],
      now,
    );
    expect(t).toEqual({ previousEffectiveTier: "Subscribed", newEffectiveTier: "Free" });
  });

  it("lapsed subscription-granted tier falls back to Free; operator grants survive", () => {
    expect(resolveTierTransition(
      { tier: "Subscribed", tierSource: "subscription" }, [{ periodEndMs: past }],
      { tier: "Subscribed", tierSource: "subscription" }, [{ periodEndMs: past }],
      now,
    ).newEffectiveTier).toBe("Free");
    expect(resolveTierTransition(
      { tier: "Subscribed", tierSource: "operator" }, [{ periodEndMs: past }],
      { tier: "Subscribed", tierSource: "operator" }, [{ periodEndMs: past }],
      now,
    ).newEffectiveTier).toBe("Subscribed");
  });

  it("is consistent with resolveEffectiveTier on both sides", () => {
    const prev = { tier: "PayPerUse" as StoreTier };
    const next = { tier: "PayPerUse" as StoreTier, tierSource: "subscription" as const };
    const subs = [{ periodEndMs: future }];
    const t = resolveTierTransition(prev, [], next, subs, now);
    expect(t.previousEffectiveTier).toBe(resolveEffectiveTier(prev, [], now));
    expect(t.newEffectiveTier).toBe(resolveEffectiveTier(next, subs, now));
  });
});

// ---------------------------------------------------------------------------
// 5. Gate tier-decision audit
// ---------------------------------------------------------------------------
describe("gate tier-decision audit, x402 branch (#2522)", () => {
  const def = { ...TRADING_PAID_SERVICES.OPTIONS_SCREENER, priceUSD: OPTIONS_SCAN_PRICE };

  it("served call writes exactly one commercial.tier.decision row with the decision", async () => {
    const { service, d1Store } = makeService();
    const meter = new CapturingMeter();
    const res = await service.handleGatedEndpoint(
      paidRequest(service, def, nextTxHash()),
      def.resource,
      def.priceUSD,
      def.description,
      vi.fn().mockResolvedValue({ served: true }),
      meteredOptions(meter, def.id),
    );
    expect(res.status).toBe(200);
    // The gate awaits the audit write, so a direct read is settled.
    const decisions = await readTierDecisions(d1Store);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].agent).toBe("payments");
    expect(decisions[0].payload).toMatchObject({
      tier: "Free",
      category: "options_screener",
      priceUSD: OPTIONS_SCAN_PRICE,
      protocol: "x402",
    });
    expect(decisions[0].payload.userLogin).toBe(payerScopeId(PAYER));
    expect(typeof decisions[0].payload.receiptId).toBe("string");
  });

  it("session traffic records the resolved tier, not the default", async () => {
    const { service, d1Store } = makeService();
    const meter = new CapturingMeter();
    const req = paidRequest(service, def, nextTxHash());
    req.headers.set("x-user-login", "owner-login");
    const res = await service.handleGatedEndpoint(
      req,
      def.resource,
      def.priceUSD,
      def.description,
      vi.fn().mockResolvedValue({ served: true }),
      meteredOptions(meter, def.id, async () => "Subscribed"),
    );
    expect(res.status).toBe(200);
    const decisions = await readTierDecisions(d1Store);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload.tier).toBe("Subscribed");
    expect(decisions[0].payload.userLogin).toBe("owner-login");
  });

  it("an audit write failure never refuses or unserves the call", async () => {
    // #6102: the audit now writes through the D1 port, so the
    // failure is a mas_events-insert failure on the bound DB —
    // the gate still serves and the meter row is still recorded.
    const { service } = makeService(verifyingClaim, new AuditFailingD1Database());
    const meter = new CapturingMeter();
    const res = await service.handleGatedEndpoint(
      paidRequest(service, def, nextTxHash()),
      def.resource,
      def.priceUSD,
      def.description,
      vi.fn().mockResolvedValue({ served: true }),
      meteredOptions(meter, def.id),
    );
    expect(res.status).toBe(200);
    expect(meter.rows).toHaveLength(1);
  });

  it("a service without an events port still serves", async () => {
    const env = {
      X402_NETWORK: "base-sepolia",
      X402_RECIPIENT_ADDRESS: RECIPIENT,
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
    } as unknown as Env;
    const service = new ETradeAgenticPaymentService({} as DatabaseORM, env, "trader_session_1", verifyingClaim);
    const meter = new CapturingMeter();
    const res = await service.handleGatedEndpoint(
      paidRequest(service, def, nextTxHash()),
      def.resource,
      def.priceUSD,
      def.description,
      vi.fn().mockResolvedValue({ served: true }),
      meteredOptions(meter, def.id),
    );
    expect(res.status).toBe(200);
    expect(meter.rows).toHaveLength(1);
  });
});

describe("gate tier-decision audit, MPP branch (#2522)", () => {
  const def = { ...TRADING_PAID_SERVICES.OPTIONS_SCREENER, priceUSD: OPTIONS_SCAN_PRICE };

  function mppService() {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("mpp_payer_test");
    // #6102: the tier-decision audit resolves from env.AGENT_DB —
    // a fresh mock per service (the port is memoized per env object).
    const d1Mock = new SharedMockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    const env = {
      AGENT_DB: d1Mock,
      X402_NETWORK: "base-sepolia",
      X402_RECIPIENT_ADDRESS: RECIPIENT,
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      MPP_SECRET_KEY: "test-mpp-secret-700",
    } as unknown as Env;
    const service = new ETradeAgenticPaymentService(orm, env, "gateway-instance-id", undefined, { payerBound: true });
    return { orm, service, d1Store };
  }

  it("served MPP call writes one tier-decision row", async () => {
    mppFake.source = `did:pkh:eip155:8453:${MPP_PAYER}`;
    const { service, d1Store } = mppService();
    const meter = new CapturingMeter();
    const res = await service.handleGatedEndpoint(
      new Request(`https://agent.test${def.resource}`, { method: "GET", headers: { Authorization: 'Payment id="cred-700"' } }),
      def.resource,
      def.priceUSD,
      def.description,
      vi.fn().mockResolvedValue({ data: "paid" }),
      meteredOptions(meter, def.id),
    );
    expect(res.status).toBe(200);
    const decisions = await readTierDecisions(d1Store);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload).toMatchObject({
      tier: "Free",
      category: "options_screener",
      protocol: "mpp",
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Email send routes resolve the tier (MockD1 harness, mirrors
//    tests/commercial_routes.test.ts + tests/subscription_routes.test.ts)
// ---------------------------------------------------------------------------
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db.prepare(sql).all(...(params as any[])).map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

/** A MockD1Database whose subscription SELECTs fail (present-but-failing tier store). */
class FailingSubsD1Database extends MockD1Database {
  override prepare(sql: string) {
    const inner = super.prepare(sql);
    const lowered = sql.trim().toLowerCase();
    if (lowered.startsWith("select") && lowered.includes("agent_subscriptions")) {
      return {
        bind(..._params: unknown[]) {
          return {
            async run(): Promise<never> {
              throw new Error("D1 unavailable (test fault)");
            },
            async all(): Promise<never> {
              throw new Error("D1 unavailable (test fault)");
            },
            async first(): Promise<never> {
              throw new Error("D1 unavailable (test fault)");
            },
            async raw(): Promise<never> {
              throw new Error("D1 unavailable (test fault)");
            },
          };
        },
      };
    }
    return inner;
  }
}

async function setupEmailRoutes() {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as any);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as any);
  await ensureSubscriptionSchema(subsDb);
  const lifecycle = createLifecycleAdapter({ AGENT_DB: mock } as any);
  await ensureLifecycleSchema(lifecycle!.db);
  const sent: any[] = [];
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    EMAIL: {
      send: async (input: { from: string; to: string; subject: string; text: string }) => {
        sent.push(input);
      },
    },
  };
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env, sent, mock };
}

const routeReq = (method: string, path: string, login: string | null, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const callRoute = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(routeReq(method, path, login, body), url, url.pathname, "sess-1", ctx);
};

const bodyOf = async (res: Response | null) => (await res?.json()) as any;

describe("email send routes resolve the tier (#2522)", () => {
  it("welcome send states the Subscribed tier for a Subscribed user", async () => {
    const { ctx, sent } = await setupEmailRoutes();
    await callRoute(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1", tenantId: "t1", tier: "Subscribed",
    });
    const res = await callRoute(ctx, "POST", "/payments/agentic/commercial/lifecycle/welcome", "u1", {
      userId: "u1", email: "u1@example.com", tenantId: "t1",
    });
    expect((await bodyOf(res)).sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Your current tier is Subscribed.");
  });

  it("digest send caps for a Free user", async () => {
    const { ctx, sent } = await setupEmailRoutes();
    await callRoute(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", {
      userId: "u1", tenantId: "t1", digestEnabled: true,
    });
    const items = ["a", "b", "c", "d", "e"];
    const freeRes = await callRoute(ctx, "POST", "/payments/agentic/commercial/lifecycle/digest/send", "u1", {
      userId: "u1", tenantId: "t1", email: "u1@example.com", items,
    });
    expect((await bodyOf(freeRes)).sent).toBe(true);
    expect(sent[0].text).not.toContain("- d");
    expect(sent[0].text).toContain("Showing 3 of 5 digest items for your current tier.");
  });

  it("digest send goes full for a Subscribed user on a fresh setup", async () => {
    const { ctx, sent } = await setupEmailRoutes();
    await callRoute(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1", tenantId: "t1", tier: "Subscribed",
    });
    await callRoute(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", {
      userId: "u1", tenantId: "t1", digestEnabled: true,
    });
    const res = await callRoute(ctx, "POST", "/payments/agentic/commercial/lifecycle/digest/send", "u1", {
      userId: "u1", tenantId: "t1", email: "u1@example.com", items: ["a", "b", "c", "d", "e"],
    });
    expect((await bodyOf(res)).sent).toBe(true);
    expect(sent[0].text).toContain("- e");
    expect(sent[0].text).not.toMatch(/Showing \d+ of \d+/);
  });

  it("a failing tier store refuses the welcome send with a typed 503, never defaulting", async () => {
    const { ctx, env, mock } = await setupEmailRoutes();
    const failing = new FailingSubsD1Database();
    (failing as any).sqlite = (mock as any).sqlite;
    (env as Record<string, unknown>).AGENT_DB = failing;
    const res = await callRoute(ctx, "POST", "/payments/agentic/commercial/lifecycle/welcome", "u1", {
      userId: "u1", email: "u1@example.com", tenantId: "t1",
    });
    expect(res?.status).toBe(503);
    expect((await bodyOf(res)).error).toMatch(/TierUnavailable|tier/i);
  });

  it("an unbound tier store defaults the welcome send to Free (limited)", async () => {
    const sent: any[] = [];
    const env: Record<string, unknown> = {
      EMAIL: {
        send: async (input: { from: string; to: string; subject: string; text: string }) => {
          sent.push(input);
        },
      },
    };
    const ctx = {
      env,
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    const res = await callRoute(ctx, "POST", "/payments/agentic/commercial/lifecycle/welcome", "u1", {
      userId: "u1", email: "u1@example.com",
    });
    expect((await bodyOf(res)).sent).toBe(true);
    expect(sent[0].text).toContain("Your current tier is Free.");
  });
});
