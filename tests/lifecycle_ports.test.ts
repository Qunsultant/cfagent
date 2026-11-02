// @vitest-environment node
/**
 * Issue #2208 ([CBO] Lifecycle email + referral credits,
 * sub-issue of #2012; advances #2021/#2020; source #1076) —
 * port conformance + pins + service + route tests, TDD.
 *
 * The port suite runs UNCHANGED against the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — no Cloudflare
 * credentials, no live D1 calls) and the in-memory adapter. A
 * behavior that passes on one adapter and fails on the other is
 * a layer defect, not an application bug.
 *
 * Pinned contracts:
 * - Rules are operator data: the seeded row (migration 0015)
 *   carries the PROPOSED defaults, and a setRules change drives
 *   later earnings (change a rule value, behavior follows).
 * - One earning per referred user, ever; self-referral throws.
 * - Unvested credits are NOT redeemable, even when the total
 *   balance would cover the amount.
 * - Redemption is oldest-first, partial-aware, and tenant-gated:
 *   a tenant mismatch throws before any write.
 * - Referral earnings are a SEPARATE balance from the
 *   failure-credit claims (different tables; never joined).
 * - Preferences default digest OFF / welcome ON; digest opt-out
 *   is a single write (same-day effect on the next send check).
 * - Digest guard: at most one digest per user per day;
 *   skip-on-empty never marks the day sent.
 * - Welcome send failure never throws (best-effort).
 * - Unsubscribe token works for digest ONLY; a security-scoped
 *   or tampered token is rejected.
 * - Migration 0015 owns the lifecycle DDL; the Drizzle schema
 *   maps it (column parity pinned here).
 * - Port/service modules never import a store client
 *   (structural grep pins).
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1LifecycleDb,
  D1LifecycleAdapter,
  ensureLifecycleSchema,
} from "../src/data/d1LifecycleAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import { MIGRATION_0015_LIFECYCLE_REFERRAL } from "../src/data/migrationRunner";
import {
  agentDigestSends,
  agentNotificationPreferences,
  agentReferralEarnings,
  agentReferralRules,
} from "../src/data/drizzleSchema";
import type { LifecycleStore } from "../src/data/lifecyclePorts";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import {
  applyUnsubscribe,
  sendDailyDigest,
  sendWelcomeBestEffort,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  type EmailSender,
} from "../src/services/lifecycleEmail";
import {
  convertReferralCreditsForRun,
  recordFirstPaidRunEarning,
} from "../src/services/referralCredits";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
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
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function makeD1Store(): Promise<D1LifecycleAdapter> {
  const mock = new MockD1Database();
  const db = createD1LifecycleDb(mock as unknown as D1Database);
  const adapter = new D1LifecycleAdapter(db);
  await ensureLifecycleSchema(db);
  return adapter;
}

const okSender = (): EmailSender & { calls: Array<{ to: string; subject: string; body: string }> } => {
  const calls: Array<{ to: string; subject: string; body: string }> = [];
  return {
    calls,
    send: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  };
};

describe("lifecycle port conformance (#2208)", () => {
  const adapters = [
    { name: "drizzle", make: makeD1Store },
    { name: "in-memory", make: async () => new InMemoryLifecycleAdapter() },
  ] as const;

  for (const { name, make } of adapters) {
    describe(`adapter: ${name}`, () => {
      it("seeds the PROPOSED rule row (migration 0015 values)", async () => {
        const store: LifecycleStore = await make();
        const rules = await store.getRules();
        expect(rules.earnAmountUSD).toBe(0.5);
        expect(rules.vestingDelayMs).toBe(604800000);
        expect(rules.redemptionScope).toBe("pay-per-run");
      });

      it("rule changes drive later earnings (operator data, not code constants)", async () => {
        const store: LifecycleStore = await make();
        await store.setRules({ earnAmountUSD: 2, vestingDelayMs: 0, redemptionScope: "pay-per-run" });
        const earning = await store.recordEarning({
          referrerUserId: "ref",
          referredUserId: "new-1",
          tenantId: "t1",
        });
        expect(earning.amountUSD).toBe(2);
        expect(earning.vestedAtMs).toBe(earning.earnedAtMs);
      });

      it("one earning per referred user; replay is a no-op; self-referral throws", async () => {
        const store: LifecycleStore = await make();
        await store.setRules({ earnAmountUSD: 1, vestingDelayMs: 0, redemptionScope: "pay-per-run" });
        const first = await store.recordEarning({ referrerUserId: "ref", referredUserId: "new-1", tenantId: "t1" });
        const replay = await store.recordEarning({ referrerUserId: "other", referredUserId: "new-1", tenantId: "t1" });
        expect(replay.id).toBe(first.id);
        expect(replay.referrerUserId).toBe("ref");
        expect((await store.listEarnings("ref")).length).toBe(1);
        await expect(
          store.recordEarning({ referrerUserId: "me", referredUserId: "me", tenantId: "t1" }),
        ).rejects.toThrow(/cannot refer themselves/);
      });

      it("unvested credits are not redeemable, even when the total would cover", async () => {
        const store: LifecycleStore = await make();
        // Seeded vesting is 7 days: a fresh earning is unvested.
        await store.recordEarning({ referrerUserId: "ref", referredUserId: "new-1", tenantId: "t1" });
        expect(await store.redeemableBalance("ref")).toBe(0);
        await expect(
          store.redeem({ userId: "ref", tenantId: "t1", amountUSD: 0.5, runRequestId: "run-1" }),
        ).rejects.toThrow(/Insufficient vested/);
        expect((await store.listEarnings("ref"))[0].redeemedAmountUSD).toBe(0);
      });

      it("redemption is oldest-first, partial-aware, and tenant-gated", async () => {
        const store: LifecycleStore = await make();
        await store.setRules({ earnAmountUSD: 1, vestingDelayMs: 0, redemptionScope: "pay-per-run" });
        await store.recordEarning({ referrerUserId: "ref", referredUserId: "new-1", tenantId: "t1" });
        await store.recordEarning({ referrerUserId: "ref", referredUserId: "new-2", tenantId: "t1" });
        expect(await store.redeemableBalance("ref")).toBe(2);
        const redeemed = await store.redeem({ userId: "ref", tenantId: "t1", amountUSD: 1.5, runRequestId: "run-9" });
        expect(redeemed.redeemedUSD).toBe(1.5);
        expect(redeemed.allocations).toHaveLength(2);
        expect(await store.redeemableBalance("ref")).toBe(0.5);
        await expect(
          store.redeem({ userId: "ref", tenantId: "t2", amountUSD: 0.1, runRequestId: "run-10" }),
        ).rejects.toThrow(/never cross tenants/);
        expect(await store.redeemableBalance("ref")).toBe(0.5);
      });

      it("preferences default digest OFF / welcome ON; toggles stick; opt-out is immediate", async () => {
        const store: LifecycleStore = await make();
        const defaults = await store.getPreferences("u1", "t1");
        expect(defaults.digestEnabled).toBe(false);
        expect(defaults.welcomeEnabled).toBe(true);
        const optedIn = await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
        expect(optedIn.digestEnabled).toBe(true);
        const optedOut = await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: false });
        expect(optedOut.digestEnabled).toBe(false);
        expect((await store.getPreferences("u1", "t1")).digestEnabled).toBe(false);
      });

      it("digest guard: one per day, idempotent mark", async () => {
        const store: LifecycleStore = await make();
        expect(await store.hasSentDigest("u1", "2026-10-28")).toBe(false);
        await store.markDigestSent("u1", "2026-10-28");
        await store.markDigestSent("u1", "2026-10-28");
        expect(await store.hasSentDigest("u1", "2026-10-28")).toBe(true);
        expect(await store.hasSentDigest("u1", "2026-10-29")).toBe(false);
      });
    });
  }
});

describe("lifecycle email service (#2208)", () => {
  it("welcome send failure never throws and never blocks the caller", async () => {
    const throwing: EmailSender = {
      send: async () => {
        throw new Error("transport down");
      },
    };
    const result = await sendWelcomeBestEffort({ sender: throwing, email: "u@example.com", userId: "u1" });
    expect(result).toEqual({ sent: false, reason: "send-failed" });
    const failing: EmailSender = { send: async () => ({ ok: false, error: "rejected" }) };
    await expect(
      sendWelcomeBestEffort({ sender: failing, email: "u@example.com", userId: "u1" }),
    ).resolves.toEqual({ sent: false, reason: "send-failed" });
  });

  it("welcome respects the welcome toggle", async () => {
    const sender = okSender();
    const store = new InMemoryLifecycleAdapter();
    await store.setPreferences({ userId: "u1", tenantId: "t1", welcomeEnabled: false });
    const prefs = await store.getPreferences("u1", "t1");
    const result = await sendWelcomeBestEffort({ sender, email: "u@example.com", userId: "u1", preferences: prefs });
    expect(result.sent).toBe(false);
    expect(sender.calls).toHaveLength(0);
  });

  it("digest: opt-in default off, per-day guard, skip-on-empty without marking", async () => {
    const sender = okSender();
    const store = new InMemoryLifecycleAdapter();
    // Default off: no send, no mark.
    expect(
      await sendDailyDigest({ store, sender, userId: "u1", tenantId: "t1", email: "u@example.com", items: ["a"] }),
    ).toEqual({ sent: false, reason: "digest-opted-out" });
    expect(sender.calls).toHaveLength(0);
    await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
    // Empty: skipped, day NOT marked — a later non-empty digest same day still sends.
    expect(
      await sendDailyDigest({ store, sender, userId: "u1", tenantId: "t1", email: "u@example.com", items: [] }),
    ).toEqual({ sent: false, reason: "empty-skipped" });
    expect(
      await sendDailyDigest({ store, sender, userId: "u1", tenantId: "t1", email: "u@example.com", items: ["a"] }),
    ).toEqual({ sent: true });
    expect(sender.calls).toHaveLength(1);
    // Second send same day: suppressed.
    expect(
      await sendDailyDigest({ store, sender, userId: "u1", tenantId: "t1", email: "u@example.com", items: ["b"] }),
    ).toEqual({ sent: false, reason: "already-sent-today" });
    expect(sender.calls).toHaveLength(1);
    // Opt-out is same-day effective on the next check.
    await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: false });
    expect(
      await sendDailyDigest({
        store, sender, userId: "u1", tenantId: "t1", email: "u@example.com", items: ["c"], nowMs: Date.now() + 86400000,
      }),
    ).toEqual({ sent: false, reason: "digest-opted-out" });
  });

  it("unsubscribe token works for digest only; tampered and security-scoped tokens are rejected", async () => {
    const store = new InMemoryLifecycleAdapter();
    await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
    const secret = "test-secret-do-not-use";
    const token = await signUnsubscribeToken(secret, "u1", "t1");
    const verified = await verifyUnsubscribeToken(secret, token);
    expect(verified).toEqual({ userId: "u1", tenantId: "t1", scope: "digest" });
    const prefs = await applyUnsubscribe(store, secret, token);
    expect(prefs.digestEnabled).toBe(false);
    // Tampered signature.
    await expect(verifyUnsubscribeToken(secret, `${token.slice(0, -2)}xx`)).rejects.toThrow(/Invalid/);
    // Security-scoped token, signed with the same secret: scope check rejects it.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payloadObj = JSON.stringify({ u: "u1", t: "t1", s: "security" });
    const payloadB64 = Buffer.from(payloadObj, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
    const sigB64 = Buffer.from(sig)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    await expect(verifyUnsubscribeToken(secret, `${payloadB64}.${sigB64}`)).rejects.toThrow(/digest mail only/);
  });
});

describe("referral conversion into the coverage path (#2208)", () => {
  it("converts exactly the run price into commercial credit; short balances stay untouched", async () => {
    const lifecycle = new InMemoryLifecycleAdapter();
    const commercial = new InMemoryCommercialAdapter();
    await lifecycle.setRules({ earnAmountUSD: 1, vestingDelayMs: 0, redemptionScope: "pay-per-run" });
    await recordFirstPaidRunEarning(lifecycle, { referrerUserId: "ref", referredUserId: "new-1", tenantId: "t1" });
    const converted = await convertReferralCreditsForRun({
      lifecycle,
      commercial,
      userId: "ref",
      tenantId: "t1",
      amountUSD: 0.1,
      runRequestId: "run-1",
    });
    expect(converted.redeemedUSD).toBe(0.1);
    // The commercial account now covers the run through the EXISTING
    // gate/consumeCoverage path (paidVia "credits") — no new paidVia.
    expect((await commercial.getAccount("ref"))?.creditsUSD).toBe(0.1);
    expect(await lifecycle.redeemableBalance("ref")).toBe(0.9);
    // Short balance: conversion throws and spends nothing.
    await expect(
      convertReferralCreditsForRun({
        lifecycle, commercial, userId: "ref", tenantId: "t1", amountUSD: 5, runRequestId: "run-2",
      }),
    ).rejects.toThrow(/Insufficient vested/);
    expect(await lifecycle.redeemableBalance("ref")).toBe(0.9);
    expect((await commercial.getAccount("ref"))?.creditsUSD).toBe(0.1);
  });

  it("conversion never crosses tenants", async () => {
    const lifecycle = new InMemoryLifecycleAdapter();
    const commercial = new InMemoryCommercialAdapter();
    await lifecycle.setRules({ earnAmountUSD: 1, vestingDelayMs: 0, redemptionScope: "pay-per-run" });
    await recordFirstPaidRunEarning(lifecycle, { referrerUserId: "ref", referredUserId: "new-1", tenantId: "t1" });
    await expect(
      convertReferralCreditsForRun({
        lifecycle, commercial, userId: "ref", tenantId: "t2", amountUSD: 0.1, runRequestId: "run-1",
      }),
    ).rejects.toThrow(/never cross tenants/);
  });
});

describe("lifecycle structural pins (#2208)", () => {
  function importLines(file: string): string[] {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
  }

  it("port and service modules import no store client", () => {
    for (const file of [
      "data/lifecyclePorts.ts",
      "services/lifecycleEmail.ts",
      "services/lifecycleDigestPass.ts",
      "services/referralCredits.ts",
    ]) {
      const imports = importLines(file).join("\n");
      expect(imports).not.toContain("drizzle-orm");
      expect(imports).not.toContain("D1Database");
      expect(imports).not.toContain("d1LifecycleAdapter");
      expect(imports).not.toContain("inMemoryLifecycleAdapter");
      expect(imports).not.toContain("AGENT_DB");
    }
  });

  it("migration DDL and Drizzle schema agree on columns for all four tables", () => {
    for (const [table, mapping] of [
      ["agent_referral_rules", agentReferralRules],
      ["agent_referral_earnings", agentReferralEarnings],
      ["agent_notification_preferences", agentNotificationPreferences],
      ["agent_digest_sends", agentDigestSends],
    ] as const) {
      const rawColumns = getTableConfig(mapping).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = MIGRATION_0015_LIFECYCLE_REFERRAL.sql.split(
        `CREATE TABLE IF NOT EXISTS ${table} (`,
      )[1].split(");")[0];
      // Constraint lines (e.g. the composite PRIMARY KEY on
      // agent_digest_sends) are not columns; exclude them.
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)]
        .map((m) => m[1])
        .filter((c) => !["PRIMARY", "FOREIGN", "UNIQUE", "CONSTRAINT", "CHECK"].includes(c));
      expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
    }
  });

  it("referral tables are separate from failure-credit claim tables", () => {
    expect(MIGRATION_0015_LIFECYCLE_REFERRAL.sql).not.toContain("agent_credit_claims");
    expect(MIGRATION_0015_LIFECYCLE_REFERRAL.sql).not.toContain("agent_credit_redemptions");
  });
});

describe("lifecycle routes (#2208)", () => {
  async function setup() {
    const mock = new MockD1Database();
    const db = createD1LifecycleDb(mock as unknown as D1Database);
    await ensureLifecycleSchema(db);
    const emailSend = vi.fn(async () => undefined);
    const env = {
      AGENT_DB: mock,
      COMMERCIAL_STORE_OPERATORS: "op1",
      EMAIL: { send: emailSend },
      LIFECYCLE_UNSUBSCRIBE_SECRET: "route-test-secret",
    };
    const ctx = {
      env,
      getOrm: () => ({}),
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    return { ctx, emailSend };
  }

  const req = (method: string, path: string, login: string | null, body?: unknown) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const call = (
    ctx: AgenticPaymentsRouteContext,
    method: string,
    path: string,
    login: string | null,
    body?: unknown,
  ) => {
    const url = new URL(`https://agent.internal${path}`);
    return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
  };

  it("record-earn is operator-only; balance reflects vesting; preferences round-trip", async () => {
    const { ctx } = await setup();
    const forbidden = await call(ctx, "POST", "/payments/agentic/commercial/referral/record-earn", "u1", {
      referrerUserId: "ref",
      referredUserId: "new-1",
      tenantId: "t1",
    });
    expect(forbidden?.status).toBe(403);
    const earned = await call(ctx, "POST", "/payments/agentic/commercial/referral/record-earn", "op1", {
      referrerUserId: "ref",
      referredUserId: "new-1",
      tenantId: "t1",
    });
    expect(earned?.status).toBe(200);
    // Fresh earning is unvested (7-day seed rule): redeemable is 0.
    const balance = await call(ctx, "GET", "/payments/agentic/commercial/referral/balance?userId=ref", "ref");
    expect(balance?.status).toBe(200);
    const balanceBody = (await balance?.json()) as { redeemableUSD: number; rules: { earnAmountUSD: number } };
    expect(balanceBody.redeemableUSD).toBe(0);
    expect(balanceBody.rules.earnAmountUSD).toBe(0.5);
    // Others cannot read the balance.
    const peek = await call(ctx, "GET", "/payments/agentic/commercial/referral/balance?userId=ref", "u1");
    expect(peek?.status).toBe(403);
    // Preferences: default digest off; opt in; read back.
    const prefs0 = await call(ctx, "GET", "/payments/agentic/commercial/lifecycle/preferences?userId=ref&tenantId=t1", "ref");
    expect(((await prefs0?.json()) as any).preferences.digestEnabled).toBe(false);
    const prefs1 = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "ref", {
      userId: "ref",
      tenantId: "t1",
      digestEnabled: true,
    });
    expect(prefs1?.status).toBe(200);
    expect(((await prefs1?.json()) as any).preferences.digestEnabled).toBe(true);
  });

  it("welcome is best-effort (200 even when the transport fails); digest guard + unsubscribe work", async () => {
    const { ctx, emailSend } = await setup();
    emailSend.mockRejectedValueOnce(new Error("transport down"));
    const welcome = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/welcome", "u1", {
      userId: "u1",
      email: "u@example.com",
      tenantId: "t1",
    });
    expect(welcome?.status).toBe(200);
    expect(((await welcome?.json()) as any).sent).toBe(false);
    // Opt in, send digest, second send same day suppressed.
    await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", {
      userId: "u1",
      tenantId: "t1",
      digestEnabled: true,
    });
    const digest1 = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/digest/send", "u1", {
      userId: "u1",
      tenantId: "t1",
      email: "u@example.com",
      items: ["screener update"],
    });
    expect(((await digest1?.json()) as any).sent).toBe(true);
    const digest2 = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/digest/send", "u1", {
      userId: "u1",
      tenantId: "t1",
      email: "u@example.com",
      items: ["another"],
    });
    expect(((await digest2?.json()) as any).reason).toBe("already-sent-today");
    // Unsubscribe via the signed token from the digest route's link:
    // rebuild the token the same way the route does and apply it.
    const token = await signUnsubscribeToken("route-test-secret", "u1", "t1");
    const unsub = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/unsubscribe", null, { token });
    expect(unsub?.status).toBe(200);
    expect(((await unsub?.json()) as any).preferences.digestEnabled).toBe(false);
    const bad = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/unsubscribe", null, {
      token: `${token.slice(0, -2)}xx`,
    });
    expect(bad?.status).toBe(400);
  });
});
