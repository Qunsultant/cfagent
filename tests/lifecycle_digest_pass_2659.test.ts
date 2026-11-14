// @vitest-environment node
/**
 * Issue #2659 (monetization Phase 2.4, #2405) — scheduled digest
 * pass: port conformance (both adapters), pass-module behavior,
 * run-due trigger route, and preferences/opt-out E2E verification.
 *
 * TDD red first: the pass module, the DigestPassPort methods, and
 * migration 0035 do not exist yet when this file lands.
 *
 * Contracts pinned here:
 * - listDigestSubscribers returns digestEnabled=1 rows only, with
 *   the recorded email (or null); an email row for another tenant
 *   never leaks across tenants (JOIN is tenant-aware).
 * - setSubscriberEmail stores the address from a successful send;
 *   a tenant mismatch throws (the #1761 fail-closed idiom), and
 *   blank inputs throw. Persistence never changes a send result
 *   (routes catch).
 * - The pass marker is per UTC day, written only after a completed
 *   pass; a thrown pass writes nothing (retry next tick is safe
 *   because per-user day guards make re-runs idempotent).
 * - The pass delegates per-user sends to sendDailyDigest, so the
 *   opt-in check, per-day guard, skip-on-empty, and tier cap are
 *   inherited, not re-implemented. Per-user failures never throw
 *   the pass.
 * - The run-due route accepts the SERVICE identity only (never
 *   own-or-operator): the tick runs as the service user, not as a
 *   subscriber.
 * - Digest content sourcing is an explicit seam: the trigger route
 *   accepts an optional itemsByUser map (operator/system caller);
 *   the tick supplies none, so scheduled passes skip-on-empty
 *   until a content provider lands. Nothing here invents content.
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1LifecycleDb,
  D1LifecycleAdapter,
  ensureLifecycleSchema,
} from "../src/data/d1LifecycleAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import { digestDayKey, type LifecycleStore } from "../src/data/lifecyclePorts";
import type { EmailSender } from "../src/services/lifecycleEmail";
import {
  sendDueDigests,
  shouldFireDigestPass,
} from "../src/services/lifecycleDigestPass";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";

/** Minimal D1Database stand-in over node:sqlite (mirrors lifecycle_ports). */
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

describe("digest pass port (#2659)", () => {
  const adapters = [
    { name: "drizzle", make: makeD1Store },
    { name: "in-memory", make: async () => new InMemoryLifecycleAdapter() },
  ] as const;

  for (const { name, make } of adapters) {
    describe(`adapter: ${name}`, () => {
      it("lists digest-enabled subscribers only, with recorded emails", async () => {
        const store: LifecycleStore = await make();
        expect(await store.listDigestSubscribers()).toEqual([]);
        await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
        await store.setPreferences({ userId: "u2", tenantId: "t1", digestEnabled: false });
        await store.setPreferences({ userId: "u3", tenantId: "t1", digestEnabled: true });
        await store.setSubscriberEmail("u1", "t1", "u1@example.com");
        const subs = await store.listDigestSubscribers();
        expect(subs).toEqual([
          { userId: "u1", tenantId: "t1", email: "u1@example.com" },
          { userId: "u3", tenantId: "t1", email: null },
        ]);
      });

      it("never leaks an email across tenants", async () => {
        const store: LifecycleStore = await make();
        await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
        await store.setSubscriberEmail("u1", "t1", "u1@example.com");
        // A row for another tenant must not overwrite or leak.
        await expect(store.setSubscriberEmail("u1", "t2", "attacker@example.com")).rejects.toThrow();
        const subs = await store.listDigestSubscribers();
        expect(subs).toEqual([{ userId: "u1", tenantId: "t1", email: "u1@example.com" }]);
      });

      it("rejects blank email inputs", async () => {
        const store: LifecycleStore = await make();
        await expect(store.setSubscriberEmail("", "t1", "a@b.c")).rejects.toThrow();
        await expect(store.setSubscriberEmail("u1", "", "a@b.c")).rejects.toThrow();
        await expect(store.setSubscriberEmail("u1", "t1", "")).rejects.toThrow();
      });

      it("pass marker: absent, then present, idempotent", async () => {
        const store: LifecycleStore = await make();
        expect(await store.hasDigestPassRun("2026-01-05")).toBe(false);
        await store.markDigestPassRun("2026-01-05");
        expect(await store.hasDigestPassRun("2026-01-05")).toBe(true);
        await store.markDigestPassRun("2026-01-05");
        expect(await store.hasDigestPassRun("2026-01-05")).toBe(true);
        expect(await store.hasDigestPassRun("2026-01-06")).toBe(false);
      });
    });
  }
});

describe("digest pass guard (#2659)", () => {
  it("fires once per UTC day, no hour or weekday gate", () => {
    const first = shouldFireDigestPass(new Date("2026-01-05T00:30:00Z"), null);
    expect(first).toEqual({ fire: true, dateKey: "2026-01-05" });
    const again = shouldFireDigestPass(new Date("2026-01-05T23:30:00Z"), "2026-01-05");
    expect(again).toEqual({ fire: false, dateKey: "2026-01-05", reason: "already-ran-today" });
    const nextDay = shouldFireDigestPass(new Date("2026-01-06T00:30:00Z"), "2026-01-05");
    expect(nextDay).toEqual({ fire: true, dateKey: "2026-01-06" });
  });
});

describe("digest pass module (#2659)", () => {
  async function setup() {
    const store = new InMemoryLifecycleAdapter();
    const sender = okSender();
    return { store, sender };
  }

  it("sends to emailed subscribers, skips the email-less, counts honestly", async () => {
    const { store, sender } = await setup();
    await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
    await store.setPreferences({ userId: "u2", tenantId: "t1", digestEnabled: true });
    await store.setSubscriberEmail("u1", "t1", "u1@example.com");
    const summary = await sendDueDigests({
      store,
      sender,
      tierResolver: async () => "Free",
      itemsProvider: async () => ["screener update"],
      nowMs: Date.parse("2026-01-05T00:30:00Z"),
    });
    expect(summary.day).toBe("2026-01-05");
    expect(summary.sent).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results).toEqual([
      { userId: "u1", tenantId: "t1", sent: true },
      { userId: "u2", tenantId: "t1", sent: false, reason: "no-email-on-file" },
    ]);
    expect(sender.calls.map((c) => c.to)).toEqual(["u1@example.com"]);
  });

  it("re-checks opt-out at send time, even mid-pass", async () => {
    const { store, sender } = await setup();
    await store.setPreferences({ userId: "a", tenantId: "t1", digestEnabled: true });
    await store.setPreferences({ userId: "b", tenantId: "t1", digestEnabled: true });
    await store.setSubscriberEmail("a", "t1", "a@example.com");
    await store.setSubscriberEmail("b", "t1", "b@example.com");
    const summary = await sendDueDigests({
      store,
      sender,
      tierResolver: async () => "Free",
      itemsProvider: async (userId) => {
        // Opting out mid-pass must suppress the later subscriber.
        if (userId === "a") await store.setPreferences({ userId: "b", tenantId: "t1", digestEnabled: false });
        return ["item"];
      },
      nowMs: Date.parse("2026-01-05T00:30:00Z"),
    });
    expect(summary.results).toEqual([
      { userId: "a", tenantId: "t1", sent: true },
      { userId: "b", tenantId: "t1", sent: false, reason: "digest-opted-out" },
    ]);
    expect(sender.calls.map((c) => c.to)).toEqual(["a@example.com"]);
  });

  it("empty items skip without marking the day sent", async () => {
    const { store, sender } = await setup();
    await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
    await store.setSubscriberEmail("u1", "t1", "u1@example.com");
    const summary = await sendDueDigests({
      store,
      sender,
      tierResolver: async () => "Free",
      itemsProvider: async () => [],
      nowMs: Date.parse("2026-01-05T00:30:00Z"),
    });
    expect(summary.results).toEqual([
      { userId: "u1", tenantId: "t1", sent: false, reason: "empty-skipped" },
    ]);
    expect(await store.hasSentDigest("u1", "2026-01-05")).toBe(false);
    expect(sender.calls).toEqual([]);
  });

  it("already-sent-today skips, and per-user failures never throw the pass", async () => {
    const { store, sender } = await setup();
    await store.setPreferences({ userId: "sent", tenantId: "t1", digestEnabled: true });
    await store.setPreferences({ userId: "tierbad", tenantId: "t1", digestEnabled: true });
    await store.setPreferences({ userId: "itemsbad", tenantId: "t1", digestEnabled: true });
    await store.setPreferences({ userId: "ok", tenantId: "t1", digestEnabled: true });
    await store.setSubscriberEmail("sent", "t1", "sent@example.com");
    await store.setSubscriberEmail("tierbad", "t1", "tierbad@example.com");
    await store.setSubscriberEmail("itemsbad", "t1", "itemsbad@example.com");
    await store.setSubscriberEmail("ok", "t1", "ok@example.com");
    await store.markDigestSent("sent", "2026-01-05");
    const summary = await sendDueDigests({
      store,
      sender,
      tierResolver: async (userId) => {
        if (userId === "tierbad") throw new Error("tier store down");
        return "Free";
      },
      itemsProvider: async (userId) => {
        if (userId === "itemsbad") throw new Error("items provider down");
        return ["item"];
      },
      nowMs: Date.parse("2026-01-05T00:30:00Z"),
    });
    expect(summary.results).toEqual([
      { userId: "itemsbad", tenantId: "t1", sent: false, reason: "items-failed" },
      { userId: "ok", tenantId: "t1", sent: true },
      { userId: "sent", tenantId: "t1", sent: false, reason: "already-sent-today" },
      { userId: "tierbad", tenantId: "t1", sent: false, reason: "tier-unavailable" },
    ]);
    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(2);
    expect(sender.calls.map((c) => c.to)).toEqual(["ok@example.com"]);
  });

  it("passes the unsubscribe URL through to the digest body", async () => {
    const { store, sender } = await setup();
    await store.setPreferences({ userId: "u1", tenantId: "t1", digestEnabled: true });
    await store.setSubscriberEmail("u1", "t1", "u1@example.com");
    await sendDueDigests({
      store,
      sender,
      tierResolver: async () => "Free",
      itemsProvider: async () => ["item"],
      unsubscribeUrlFor: async () => "https://example.invalid/unsubscribe?token=abc",
      nowMs: Date.parse("2026-01-05T00:30:00Z"),
    });
    expect(sender.calls[0].body).toContain("https://example.invalid/unsubscribe?token=abc");
  });
});

describe("digest run-due trigger route (#2659)", () => {
  async function setup(opts: { serviceLogin?: string | null; withEmail?: boolean; withDb?: boolean } = {}) {
    const mock = new MockD1Database();
    const db = createD1LifecycleDb(mock as unknown as D1Database);
    await ensureLifecycleSchema(db);
    const emailSend = vi.fn(async () => undefined);
    const env: Record<string, unknown> = {
      ...(opts.withDb === false ? {} : { AGENT_DB: mock }),
      COMMERCIAL_STORE_OPERATORS: "op1",
      ...(opts.withEmail === false ? {} : { EMAIL: { send: emailSend } }),
      LIFECYCLE_UNSUBSCRIBE_SECRET: "route-test-secret",
      ...(opts.serviceLogin === null ? {} : { SERVICE_USER_LOGIN: opts.serviceLogin ?? "svc" }),
    };
    const ctx = {
      env,
      getOrm: () => ({}),
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    const store = new D1LifecycleAdapter(db);
    return { ctx, emailSend, mock, store };
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

  const RUN_DUE = "/payments/agentic/commercial/lifecycle/digest/run-due";

  it("refuses non-service logins and unconfigured service login", async () => {
    const { ctx } = await setup();
    const wrong = await call(ctx, "POST", RUN_DUE, "u1", {});
    expect(wrong?.status).toBe(401);
    const anon = await call(ctx, "POST", RUN_DUE, null, {});
    expect(anon?.status).toBe(401);
    const { ctx: noSvc } = await setup({ serviceLogin: null });
    const unconfigured = await call(noSvc, "POST", RUN_DUE, "svc", {});
    expect(unconfigured?.status).toBe(401);
  });

  it("runs the pass once per day: welcome-recorded email → send → marker → second run skipped", async () => {
    const { ctx, emailSend, store } = await setup();
    // Bootstrap: welcome send records the address (tenantId present).
    const welcome = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/welcome", "u1", {
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
    });
    expect(((await welcome?.json()) as any).sent).toBe(true);
    expect(await store.listDigestSubscribers()).toEqual([]);
    // Opt in, then run the pass with operator-supplied items.
    await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", {
      userId: "u1",
      tenantId: "t1",
      digestEnabled: true,
    });
    expect(await store.listDigestSubscribers()).toEqual([
      { userId: "u1", tenantId: "t1", email: "u1@example.com" },
    ]);
    const run = await call(ctx, "POST", RUN_DUE, "svc", { itemsByUser: { u1: ["hello"] } });
    const runBody = (await run?.json()) as any;
    expect(run?.status).toBe(200);
    expect(runBody.fired).toBe(true);
    expect(runBody.summary.sent).toBe(1);
    expect(emailSend).toHaveBeenCalled();
    expect(await store.hasDigestPassRun(digestDayKey(Date.now()))).toBe(true);
    expect((ctx.audit as any)).toHaveBeenCalledWith(
      "lifecycle.digest.pass",
      "payments",
      expect.objectContaining({ sent: 1 }),
    );
    const again = await call(ctx, "POST", RUN_DUE, "svc", { itemsByUser: { u1: ["hello"] } });
    const againBody = (await again?.json()) as any;
    expect(againBody.fired).toBe(false);
    expect(againBody.reason).toBe("already-ran-today");
  });

  it("tick-style run with no items skips-on-empty and still marks the pass", async () => {
    const { ctx, emailSend, store } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", {
      userId: "u1",
      tenantId: "t1",
      digestEnabled: true,
    });
    await store.setSubscriberEmail("u1", "t1", "u1@example.com");
    const run = await call(ctx, "POST", RUN_DUE, "svc", {});
    const runBody = (await run?.json()) as any;
    expect(runBody.fired).toBe(true);
    expect(runBody.summary.results).toEqual([
      { userId: "u1", tenantId: "t1", sent: false, reason: "empty-skipped" },
    ]);
    expect(emailSend).not.toHaveBeenCalled();
    expect(await store.hasDigestPassRun(digestDayKey(Date.now()))).toBe(true);
    // The pass marker never blocks a manual send.
    const manual = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/digest/send", "u1", {
      userId: "u1",
      tenantId: "t1",
      email: "u1@example.com",
      items: ["manual"],
    });
    expect(((await manual?.json()) as any).sent).toBe(true);
  });

  it("refuses without a store or without an email transport, writing no marker", async () => {
    const { ctx: noDb, store: _s1 } = await setup({ withDb: false });
    const noStore = await call(noDb, "POST", RUN_DUE, "svc", {});
    expect(noStore?.status).toBe(503);
    const { ctx: noMail, store } = await setup({ withEmail: false });
    const noTransport = await call(noMail, "POST", RUN_DUE, "svc", {});
    expect(noTransport?.status).toBe(503);
    expect(await store.hasDigestPassRun(digestDayKey(Date.now()))).toBe(false);
  });

  it("digest/send success records the address for the pass", async () => {
    const { ctx, store } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", {
      userId: "u1",
      tenantId: "t1",
      digestEnabled: true,
    });
    const send = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/digest/send", "u1", {
      userId: "u1",
      tenantId: "t1",
      email: "u1@example.com",
      items: ["item"],
    });
    expect(((await send?.json()) as any).sent).toBe(true);
    expect(await store.listDigestSubscribers()).toEqual([
      { userId: "u1", tenantId: "t1", email: "u1@example.com" },
    ]);
  });
});

describe("preferences/opt-out E2E verification (#2659)", () => {
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

  const prefs = (ctx: AgenticPaymentsRouteContext, body: unknown) =>
    call(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", body);
  const digestSend = (ctx: AgenticPaymentsRouteContext, items: string[]) =>
    call(ctx, "POST", "/payments/agentic/commercial/lifecycle/digest/send", "u1", {
      userId: "u1",
      tenantId: "t1",
      email: "u1@example.com",
      items,
    });

  it("panel opt-out suppresses the next send the same day (opt-out checked before the day guard)", async () => {
    const { ctx } = await setup();
    await prefs(ctx, { userId: "u1", tenantId: "t1", digestEnabled: true });
    const first = await digestSend(ctx, ["item"]);
    expect(((await first?.json()) as any).sent).toBe(true);
    await prefs(ctx, { userId: "u1", tenantId: "t1", digestEnabled: false });
    const second = await digestSend(ctx, ["item"]);
    expect(((await second?.json()) as any)).toEqual({ sent: false, reason: "digest-opted-out", code: "FAILURE_LIFECYCLE_EMAIL_NOT_SENT" });
  });

  it("unsubscribe suppresses the next send", async () => {
    const { ctx } = await setup();
    const { signUnsubscribeToken } = await import("../src/services/lifecycleEmail");
    await prefs(ctx, { userId: "u1", tenantId: "t1", digestEnabled: true });
    const token = await signUnsubscribeToken("route-test-secret", "u1", "t1");
    const unsub = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/unsubscribe", null, { token });
    expect(unsub?.status).toBe(200);
    const send = await digestSend(ctx, ["item"]);
    expect(((await send?.json()) as any)).toEqual({ sent: false, reason: "digest-opted-out", code: "FAILURE_LIFECYCLE_EMAIL_NOT_SENT" });
  });

  it("a security-scoped token is a 400 at the route (security mail has no unsubscribe path)", async () => {
    const { ctx } = await setup();
    const { createHmac } = await import("node:crypto");
    const payload = Buffer.from(JSON.stringify({ u: "u1", t: "t1", s: "security" }))
      .toString("base64url");
    const signature = createHmac("sha256", "route-test-secret").update(payload).digest("base64url");
    const bad = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/unsubscribe", null, {
      token: `${payload}.${signature}`,
    });
    expect(bad?.status).toBe(400);
  });

  it("welcome toggle off suppresses the welcome send at the route", async () => {
    const { ctx } = await setup();
    await prefs(ctx, { userId: "u1", tenantId: "t1", welcomeEnabled: false });
    const welcome = await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/welcome", "u1", {
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
    });
    expect(((await welcome?.json()) as any)).toEqual({ sent: false, reason: "welcome-opted-out", code: "FAILURE_LIFECYCLE_EMAIL_NOT_SENT" });
  });
});
