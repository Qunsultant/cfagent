/**
 * Issue #2664 (monetization Phase 2 slice 2.9) — tenant isolation:
 * one user's screens, reports, and deliveries are unreachable from
 * another user's session.
 *
 * Verification suite + gap fixes. The suite pins, at the route layer,
 * every surface #2664 names: reports lists/detail, the HITL
 * report-confirmation path, stored-report delivery, the commercial
 * D1 reads/writes with a userId parameter, and schedule creation
 * identity. Already-enforced surfaces are pinned (green), not rebuilt;
 * the two gaps (unowned confirmations, owner-unchecked delivery) are
 * fixed by this slice and their tests fail until the fix lands.
 *
 * Harnesses follow the established patterns: node:sqlite storage for
 * the DO routes (orchestrator_tables_step4d pattern), MockD1Database
 * for the commercial routes (commercial_routes pattern).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { handleReportsRoutes } from "../src/agents/routes/reports";
import {
  canonicalResearchEmailBody,
  canonicalResearchWebhookBody,
  ensureScheduledReportsTable,
  getScheduledReportById,
  listScheduledReports,
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import {
  confirmationDeliveryMeta,
  createReportConfirmation,
  decideReportConfirmation,
  deliverStoredReportEmail,
  deliverStoredReportWebhook,
  getReportConfirmation,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { createOrchestratorTablePorts } from "../src/data/createOrchestratorTablePorts";
import { buildSchedulePayload } from "../src/trading/screeningSchemas";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import { createD1SubscriptionDb, ensureSubscriptionSchema } from "../src/data/d1SubscriptionAdapter";
import { createD1LifecycleDb, ensureLifecycleSchema } from "../src/data/d1LifecycleAdapter";

/** SqlStorage-shaped executor over node:sqlite (real semantics). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] & { rowsWritten?: number } {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const TTL_MS = 24 * 60 * 60 * 1000;

function makeDispatch(sql: SqliteTestStorage, sent: { emails: string[]; webhooks: number }) {
  const ctx: ReportDispatchContext = {
    env: {} as never,
    ensureTables: () => sql as never,
    getOrm: () => ({}) as never,
    reportDispatchHitlKey: "test-hit",
    reportConfirmationTtlMs: TTL_MS,
    sendReportEmail: async (recipient: string) => {
      sent.emails.push(recipient);
      return true;
    },
    sendReportWebhook: async () => {
      sent.webhooks += 1;
      return { success: true };
    },
  };
  return ctx;
}

function storeEmailReport(sql: SqliteTestStorage, owner: string, runId: string) {
  ensureScheduledReportsTable(sql as never);
  const stored = storeReportAtGeneration(sql as never, {
    runId,
    generationId: runId,
    title: `Report ${runId}`,
    source: "research_report",
    summary: "s",
    body: JSON.parse(
      canonicalResearchEmailBody({ title: "T", fileName: "r.xlsx", attachmentBase64: "QUJD" })
    ),
    userLogin: owner,
  });
  if (!stored) throw new Error("store failed");
  return stored.reportId;
}

function storeWebhookReport(sql: SqliteTestStorage, owner: string, runId: string) {
  ensureScheduledReportsTable(sql as never);
  const stored = storeReportAtGeneration(sql as never, {
    runId,
    generationId: runId,
    title: `Report ${runId}`,
    source: "research_report",
    summary: "s",
    body: JSON.parse(
      canonicalResearchWebhookBody({ title: "T", query: "q", sheets: [{ name: "s", rows: [{}] }] })
    ),
    userLogin: owner,
  });
  if (!stored) throw new Error("store failed");
  return stored.reportId;
}

function reportsRouteCtx(sql: SqliteTestStorage, dispatch: ReportDispatchContext, audits: string[]) {
  return {
    ensureTables: () => sql as never,
    getReportConfirmation: (id: string) => getReportConfirmation(dispatch, id),
    decideReportConfirmation: (id: string, status: "approved" | "rejected" | "expired", by: string | null) =>
      decideReportConfirmation(dispatch, id, status, by),
    submitFollowupDelivery: async () => true,
    confirmationDeliveryMeta: (row: unknown) => confirmationDeliveryMeta(row as never),
    deliverStoredReportEmail: (reportId: string, recipient: string, userLogin: string) =>
      deliverStoredReportEmail(dispatch, reportId, recipient, userLogin),
    // Pre-#308 orphan fallback delivers the embedded payload through
    // the route context's own send leg, not the stored-report seam.
    sendReportEmail: (...args: Parameters<ReportDispatchContext["sendReportEmail"]>) =>
      dispatch.sendReportEmail(...args),
    deliverStoredReportWebhook: (reportId: string, userLogin: string) =>
      deliverStoredReportWebhook(dispatch, reportId, userLogin),
    audit: (type: string) => audits.push(type),
    reportConfirmationTtlMs: () => TTL_MS,
  } as never;
}

function confirmReq(caller: string, confirmationId: string, decision: string) {
  const url = new URL("https://agent.internal/trading/reports/confirm");
  return {
    req: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": caller },
      body: JSON.stringify({ confirmationId, decision }),
    }),
    url,
    path: "/trading/reports/confirm",
  };
}

// ---------------------------------------------------------------------------
// Report confirmations: ownership
// ---------------------------------------------------------------------------

describe("tenant isolation #2664: report confirmations are creator-owned", () => {
  it("the creator approves their own held delivery", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    createOrchestratorTablePorts(sql as never).confirmations.ensureSchema();
    const reportId = storeEmailReport(sql, "alice", "run-alice-1");
    const cid = createReportConfirmation(
      dispatch,
      "email",
      JSON.stringify({ recipient: "alice@example.com", title: "T", fileName: "r.xlsx" }),
      reportId,
      "alice"
    );
    const audits: string[] = [];
    const { req, url, path } = confirmReq("alice", cid, "approved");
    const res = await handleReportsRoutes(req, url, path, "sess-1", reportsRouteCtx(sql, dispatch, audits));
    expect(res?.status).toBe(200);
    expect(sent.emails).toEqual(["alice@example.com"]);
    expect(getReportConfirmation(dispatch, cid)?.status).toBe("approved");
  });

  it("another user approving a held delivery gets 403 and nothing is decided or sent", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    createOrchestratorTablePorts(sql as never).confirmations.ensureSchema();
    const reportId = storeEmailReport(sql, "alice", "run-alice-2");
    const cid = createReportConfirmation(
      dispatch,
      "email",
      JSON.stringify({ recipient: "alice@example.com", title: "T", fileName: "r.xlsx" }),
      reportId,
      "alice"
    );
    const audits: string[] = [];
    const { req, url, path } = confirmReq("bob", cid, "approved");
    const res = await handleReportsRoutes(req, url, path, "sess-1", reportsRouteCtx(sql, dispatch, audits));
    expect(res?.status).toBe(403);
    expect(sent.emails).toEqual([]);
    expect(getReportConfirmation(dispatch, cid)?.status).toBe("pending");
  });

  it("another user rejecting a held delivery gets 403 and the row stays pending", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    createOrchestratorTablePorts(sql as never).confirmations.ensureSchema();
    const reportId = storeEmailReport(sql, "alice", "run-alice-3");
    const cid = createReportConfirmation(
      dispatch,
      "email",
      JSON.stringify({ recipient: "alice@example.com", title: "T", fileName: "r.xlsx" }),
      reportId,
      "alice"
    );
    const audits: string[] = [];
    const { req, url, path } = confirmReq("bob", cid, "rejected");
    const res = await handleReportsRoutes(req, url, path, "sess-1", reportsRouteCtx(sql, dispatch, audits));
    expect(res?.status).toBe(403);
    expect(getReportConfirmation(dispatch, cid)?.status).toBe("pending");
  });

  it("a legacy row (no created_by) whose report belongs to the caller is still decidable", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    createOrchestratorTablePorts(sql as never).confirmations.ensureSchema();
    const reportId = storeEmailReport(sql, "alice", "run-alice-4");
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      "rc_legacy_alice",
      "email",
      JSON.stringify({ recipient: "alice@example.com", title: "T", fileName: "r.xlsx" }),
      "pending",
      new Date().toISOString(),
      reportId
    );
    const audits: string[] = [];
    const { req, url, path } = confirmReq("alice", "rc_legacy_alice", "approved");
    const res = await handleReportsRoutes(req, url, path, "sess-1", reportsRouteCtx(sql, dispatch, audits));
    expect(res?.status).toBe(200);
    expect(sent.emails).toEqual(["alice@example.com"]);
    expect(getReportConfirmation(dispatch, "rc_legacy_alice")?.status).toBe("approved");
  });

  it("a legacy row whose report belongs to another user gets 403", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    createOrchestratorTablePorts(sql as never).confirmations.ensureSchema();
    const reportId = storeEmailReport(sql, "alice", "run-alice-5");
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      "rc_legacy_bob",
      "email",
      JSON.stringify({ recipient: "alice@example.com", title: "T", fileName: "r.xlsx" }),
      "pending",
      new Date().toISOString(),
      reportId
    );
    const audits: string[] = [];
    const { req, url, path } = confirmReq("bob", "rc_legacy_bob", "approved");
    const res = await handleReportsRoutes(req, url, path, "sess-1", reportsRouteCtx(sql, dispatch, audits));
    expect(res?.status).toBe(403);
    expect(sent.emails).toEqual([]);
    expect(getReportConfirmation(dispatch, "rc_legacy_bob")?.status).toBe("pending");
  });

  it("a pre-#308 orphan row (no report_id, no created_by) keeps the pinned embedded-payload fallback", async () => {
    // Pinned by canonical-report.test.ts ("legacy rows still approve
    // via fallback"): orphan rows predate ownership tracking, are
    // age-bounded by the TTL check, and live in the creator's
    // per-user instance store, so the fallback — not a 403 — is the
    // correct gate outcome. The strict gates above still cover every
    // row created since #308 and every report-linked legacy row.
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    createOrchestratorTablePorts(sql as never).confirmations.ensureSchema();
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      "rc_legacy_orphan",
      "email",
      JSON.stringify({ recipient: "nobody@example.com", title: "T", fileName: "r.xlsx" }),
      "pending",
      new Date().toISOString(),
      null
    );
    const audits: string[] = [];
    const { req, url, path } = confirmReq("alice", "rc_legacy_orphan", "approved");
    const res = await handleReportsRoutes(req, url, path, "sess-1", reportsRouteCtx(sql, dispatch, audits));
    expect(res?.status).toBe(200);
    expect(sent.emails).toEqual(["nobody@example.com"]);
    expect(getReportConfirmation(dispatch, "rc_legacy_orphan")?.status).toBe("approved");
  });

  it("an unknown confirmation id stays 404", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    createOrchestratorTablePorts(sql as never).confirmations.ensureSchema();
    const audits: string[] = [];
    const { req, url, path } = confirmReq("alice", "rc_nope", "approved");
    const res = await handleReportsRoutes(req, url, path, "sess-1", reportsRouteCtx(sql, dispatch, audits));
    expect(res?.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Stored-report delivery seam: owner check
// ---------------------------------------------------------------------------

describe("tenant isolation #2664: stored-report delivery is owner-checked", () => {
  it("the owner delivers their own stored report by email", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    const reportId = storeEmailReport(sql, "alice", "run-alice-6");
    expect(await deliverStoredReportEmail(dispatch, reportId, "alice@example.com", "alice")).toBe("sent");
    expect(sent.emails).toEqual(["alice@example.com"]);
  });

  it("a non-owner delivering another user's stored report gets missing, never sent", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    const reportId = storeEmailReport(sql, "alice", "run-alice-7");
    expect(await deliverStoredReportEmail(dispatch, reportId, "bob@example.com", "bob")).toBe("missing");
    expect(sent.emails).toEqual([]);
  });

  it("the owner delivers their own stored report by webhook", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    const reportId = storeWebhookReport(sql, "alice", "run-alice-8");
    const out = await deliverStoredReportWebhook(dispatch, reportId, "alice");
    expect(out.outcome).toBe("sent");
    expect(sent.webhooks).toBe(1);
  });

  it("a non-owner delivering another user's stored report by webhook gets missing", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    const reportId = storeWebhookReport(sql, "alice", "run-alice-9");
    const out = await deliverStoredReportWebhook(dispatch, reportId, "bob");
    expect(out.outcome).toBe("missing");
    expect(sent.webhooks).toBe(0);
  });

  it("an unknown report id stays missing", async () => {
    const sql = new SqliteTestStorage();
    const sent = { emails: [] as string[], webhooks: 0 };
    const dispatch = makeDispatch(sql, sent);
    expect(await deliverStoredReportEmail(dispatch, "nope", "a@b.c", "alice")).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// Reports lists/detail: caller-scoped (pins of existing enforcement)
// ---------------------------------------------------------------------------

describe("tenant isolation #2664: report lists and detail are caller-scoped", () => {
  it("a list under one login returns only that login's rows", () => {
    const sql = new SqliteTestStorage();
    storeEmailReport(sql, "alice", "run-alice-10");
    storeEmailReport(sql, "bob", "run-bob-10");
    const alice = listScheduledReports(sql as never, { userLogin: "alice", limit: 100 });
    expect(alice.length).toBeGreaterThan(0);
    expect(alice.every((r) => r.runId.startsWith("run-alice"))).toBe(true);
    const bob = listScheduledReports(sql as never, { userLogin: "bob", limit: 100 });
    expect(bob.every((r) => r.runId.startsWith("run-bob"))).toBe(true);
  });

  it("a detail read of another user's report id returns null", () => {
    const sql = new SqliteTestStorage();
    const bobId = storeEmailReport(sql, "bob", "run-bob-11");
    expect(getScheduledReportById(sql as never, bobId, { userLogin: "alice" })).toBeNull();
    expect(getScheduledReportById(sql as never, bobId, { userLogin: "bob" })?.id).toBe(bobId);
  });
});

// ---------------------------------------------------------------------------
// Schedule creation: identity stamped from the creator session, never input
// ---------------------------------------------------------------------------

describe("tenant isolation #2664: schedule creation stamps the creator", () => {
  it("the payload carries the creator identity, never a body-supplied login", () => {
    const stamped = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100" },
      { userLogin: "alice", trigger: "manual" },
      { applyCreationDefaults: false }
    );
    expect(stamped.ok).toBe(true);
    if (stamped.ok) expect(stamped.value.userLogin).toBe("alice");
    // A body-supplied userLogin key is not a valid criterion: the
    // strict criteria schema rejects it outright, so it can neither
    // survive into the payload nor override the creator identity
    // (the create route additionally strips it before this call).
    const forged = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100", userLogin: "mallory" },
      { userLogin: "alice", trigger: "manual" },
      { applyCreationDefaults: false }
    );
    expect(forged.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Commercial D1 reads/writes: cross-user attempts refused (pins)
// ---------------------------------------------------------------------------

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
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
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

async function commercialSetup() {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
  await ensureLifecycleSchema(createD1LifecycleDb(mock as unknown as D1Database));
  const env = { AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" };
  const ctx = { env, getOrm: () => ({}) as never, audit: vi.fn() } as unknown as AgenticPaymentsRouteContext;
  return { ctx, mock };
}

const commercialCall = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown
) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(
    new Request(url, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    url,
    url.pathname,
    "sess-1",
    ctx
  );
};

describe("tenant isolation #2664: commercial reads refuse cross-user access", () => {
  it("account read of another user is 403; self and operator reads proceed", async () => {
    const { ctx } = await commercialSetup();
    const cross = await commercialCall(ctx, "GET", "/payments/agentic/commercial/account?userId=alice", "bob");
    expect(cross?.status).toBe(403);
    const self = await commercialCall(ctx, "GET", "/payments/agentic/commercial/account?userId=alice", "alice");
    expect(self?.status).toBe(200);
    const op = await commercialCall(ctx, "GET", "/payments/agentic/commercial/account?userId=alice", "op1");
    expect(op?.status).toBe(200);
  });

  it("subscription read of another user is 403; self read proceeds", async () => {
    const { ctx } = await commercialSetup();
    const cross = await commercialCall(ctx, "GET", "/payments/agentic/commercial/subscription?userId=alice", "bob");
    expect(cross?.status).toBe(403);
    const self = await commercialCall(ctx, "GET", "/payments/agentic/commercial/subscription?userId=alice", "alice");
    expect(self?.status).toBe(200);
  });

  it("lifecycle preferences read of another user is 403; self read returns defaults", async () => {
    const { ctx } = await commercialSetup();
    const cross = await commercialCall(
      ctx, "GET", "/payments/agentic/commercial/lifecycle/preferences?userId=alice&tenantId=t1", "bob"
    );
    expect(cross?.status).toBe(403);
    const self = await commercialCall(
      ctx, "GET", "/payments/agentic/commercial/lifecycle/preferences?userId=alice&tenantId=t1", "alice"
    );
    expect(self?.status).toBe(200);
    expect(((await self!.json()) as any).preferences.userId).toBe("alice");
  });

  it("cancel for another user is 403", async () => {
    const { ctx } = await commercialSetup();
    const cross = await commercialCall(ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "bob", {
      userId: "alice",
    });
    expect(cross?.status).toBe(403);
  });

  it("submission-status for an unknown workflow is 404", async () => {
    const { ctx } = await commercialSetup();
    const res = await commercialCall(
      ctx, "GET", "/payments/agentic/commercial/submission-status?workflowId=wf-nope", "alice"
    );
    expect(res?.status).toBe(404);
  });

  it("submission-status for another user's submission is 403", async () => {
    const { ctx, mock } = await commercialSetup();
    const adapter = (await import("../src/data/createCommercialPorts")).createCommercialAdapter({
      AGENT_DB: mock,
    } as never);
    await adapter!.recordPaidSubmission({ workflowId: "wf-alice-1", userId: "alice", runRequestId: "rr-1" });
    const res = await commercialCall(
      ctx, "GET", "/payments/agentic/commercial/submission-status?workflowId=wf-alice-1", "bob"
    );
    expect(res?.status).toBe(403);
  });
});
