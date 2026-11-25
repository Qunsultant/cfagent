/**
 * Issue #2437 — checkpointed audit-chain verification.
 *
 * The nightly retention pass verifies the mas_events chain (#3156), but the
 * result was never persisted and every run did an unbounded full-table
 * scan. This pins the checkpointed replacement: the first run establishes
 * a genesis-anchored checkpoint in mas_settings, later runs read only the
 * post-checkpoint window, a tampered window row fails loud with an alert
 * and does NOT advance the checkpoint, and the GET status route surfaces
 * the persisted record.
 */
import { describe, it, expect, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import type { AuditEvent } from "../src/types";
import { diagnoseAuditChainWindow } from "../src/security/auditChain";
import {
  AUDIT_CHAIN_LAST_VERIFICATION_KEY,
  parseAuditChainVerificationRecord,
  readAuditChainWindow,
  verifyStoredAuditChainAndAlertCheckpointed,
} from "../src/services/auditChainVerification";
import { settingReadFromSql, settingWriteFromSql } from "../src/services/screeningFlags";
import { handleAuditRoutes, type AuditRouteContext } from "../src/agents/routes/audit";

function makeOrm() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  return { sql, orm };
}

function event(id: string, type: string, payload: Record<string, unknown>): AuditEvent {
  return {
    id,
    sessionId: "sess-1",
    type,
    agent: "orchestrator",
    payload,
    createdAt: new Date().toISOString(),
  };
}

function chainRows(orm: DatabaseORM) {
  return orm.events.findMany({ orderBy: "rowid ASC" }).map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    type: r.type,
    agent: r.agent,
    payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload ?? {}),
    createdAt: r.createdAt,
    previousEventHash: r.previousEventHash ?? null,
    eventHash: r.eventHash ?? "",
  }));
}

function tamperAlerts(orm: DatabaseORM): Array<{ payload: Record<string, unknown> }> {
  return orm.events
    .findMany({})
    .filter((r) => r.type === "audit.tamper_detected")
    .map((r) => ({
      payload:
        typeof r.payload === "string"
          ? (JSON.parse(r.payload) as Record<string, unknown>)
          : (r.payload as Record<string, unknown>),
    }));
}

function storedRecord(sql: MockSqlStorage) {
  return parseAuditChainVerificationRecord(
    settingReadFromSql(sql as never)(AUDIT_CHAIN_LAST_VERIFICATION_KEY),
  );
}

describe("audit chain window diagnosis (#2437)", () => {
  it("anchors on the given tail hash instead of genesis", () => {
    const { orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    orm.events.create(event("a3", "followup.schedule_failed", { jobId: "j1" }));
    const rows = chainRows(orm);
    // The tail window [a2, a3] verifies against a1's hash.
    expect(diagnoseAuditChainWindow(rows.slice(1), rows[0].eventHash)).toEqual({
      valid: true,
      brokenIndex: null,
      reason: null,
    });
    // A wrong anchor fails at the first window row.
    const wrong = diagnoseAuditChainWindow(rows.slice(1), "deadbeef");
    expect(wrong.valid).toBe(false);
    expect(wrong.brokenIndex).toBe(0);
    expect(wrong.reason).toMatch(/previousEventHash mismatch/);
    // A null anchor is the genesis case, identical to the full walk.
    expect(diagnoseAuditChainWindow(rows, null)).toEqual({
      valid: true,
      brokenIndex: null,
      reason: null,
    });
  });
});

describe("checkpointed verification (#2437)", () => {
  it("first run establishes a genesis checkpoint with the tail position", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    orm.events.create(event("a3", "followup.schedule_failed", { jobId: "j1" }));
    const result = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    expect(result.valid).toBe(true);
    expect(result.windowed).toBe(false);
    expect(result.rowsChecked).toBe(3);
    expect(result.alertRecorded).toBe(false);
    expect(result.checkpoint.valid).toBe(true);
    expect(result.checkpoint.anchorKind).toBe("genesis");
    expect(result.checkpoint.tailRowId).toBe(3);
    const rows = chainRows(orm);
    expect(result.checkpoint.tailHash).toBe(rows[2].eventHash);
    // The record is persisted: a later read finds the same checkpoint.
    expect(storedRecord(sql)).toMatchObject({
      valid: true,
      rowsChecked: 3,
      tailRowId: 3,
      tailHash: rows[2].eventHash,
      anchorKind: "genesis",
    });
  });

  it("later runs read only the post-checkpoint window", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    orm.events.create(event("a3", "followup.schedule_failed", { jobId: "j1" }));
    verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    orm.events.create(event("a4", "goal_screen.workflow_submitted", { jobId: "j2" }));
    orm.events.create(event("a5", "goal_screen.run_failed", { jobId: "j2" }));

    const calls: Array<{ q: string; args: unknown[] }> = [];
    const origExec = sql.exec.bind(sql);
    const sqlWithSpy = sql as unknown as { exec: (...a: unknown[]) => Iterable<unknown> };
    sqlWithSpy.exec = (q: string, ...a: unknown[]) => {
      calls.push({ q, args: a });
      return origExec(q, ...a);
    };
    const result = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    sqlWithSpy.exec = origExec;
    expect(result.valid).toBe(true);
    expect(result.windowed).toBe(true);
    expect(result.rowsChecked).toBe(2);
    expect(result.checkpoint.anchorKind).toBe("checkpoint");
    expect(result.checkpoint.tailRowId).toBe(5);
    const rows = chainRows(orm);
    expect(result.checkpoint.tailHash).toBe(rows[4].eventHash);
    // The only mas_events read is the bounded window query, bound to the
    // checkpoint tail — no full-table scan on the second run.
    const eventReads = calls.filter((c) => c.q.includes("mas_events") && /SELECT/i.test(c.q));
    expect(eventReads).toHaveLength(1);
    expect(eventReads[0].q).toContain("WHERE rowid > ?");
    expect(eventReads[0].args).toEqual([3]);
  });

  it("an empty window verifies clean and refreshes verifiedAt without moving the tail", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    const first = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    const second = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    expect(second.valid).toBe(true);
    expect(second.windowed).toBe(true);
    expect(second.rowsChecked).toBe(0);
    expect(second.checkpoint.tailRowId).toBe(first.checkpoint.tailRowId);
    expect(second.checkpoint.tailHash).toBe(first.checkpoint.tailHash);
    expect(second.checkpoint.verifiedAt >= first.checkpoint.verifiedAt).toBe(true);
  });

  it("sabotage: a tampered window row fails loud, alerts, and does NOT advance the checkpoint", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    orm.events.create(event("a3", "followup.schedule_failed", { jobId: "j1" }));
    const first = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    orm.events.create(event("a4", "goal_screen.workflow_submitted", { jobId: "j2" }));
    orm.events.create(event("a5", "goal_screen.run_failed", { jobId: "j2" }));
    sql.exec(
      `UPDATE mas_events SET payload = ? WHERE id = ?`,
      JSON.stringify({ jobId: "tampered" }),
      "a5",
    );
    const result = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    expect(result.valid).toBe(false);
    expect(result.windowed).toBe(true);
    expect(result.alertRecorded).toBe(true);
    expect(result.alertId).toMatch(/^tamper_/);
    // brokenIndex is window-relative (a5 is the second window row);
    // brokenRowId names the exact row for the runbook.
    expect(result.brokenIndex).toBe(1);
    expect(result.checkpoint.brokenRowId).toBe(5);
    expect(result.checkpoint.valid).toBe(false);
    // The checkpoint tail is NOT advanced past the break.
    expect(result.checkpoint.tailRowId).toBe(first.checkpoint.tailRowId);
    expect(result.checkpoint.tailHash).toBe(first.checkpoint.tailHash);
    // The alert row itself is recorded on the chain.
    const alerts = tamperAlerts(orm);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.brokenIndex).toBe(1);
    expect(String(alerts[0].payload.reason)).toMatch(/hash/i);
    // The persisted record is the failed attempt at the old tail.
    expect(storedRecord(sql)).toMatchObject({
      valid: false,
      tailRowId: 3,
      brokenRowId: 5,
    });
  });

  it("a corrupt stored checkpoint falls back to a full verification", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    settingWriteFromSql(sql as never)(AUDIT_CHAIN_LAST_VERIFICATION_KEY, "not-json{");
    const result = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    expect(result.valid).toBe(true);
    expect(result.windowed).toBe(false);
    expect(result.checkpoint.anchorKind).toBe("genesis");
    expect(result.checkpoint.tailRowId).toBe(2);
  });

  it("genesis-pruned first run fails strict: no second genesis is invented", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    orm.events.create(event("a3", "followup.schedule_failed", { jobId: "j1" }));
    // The retention prune deleted the genesis row before any checkpoint
    // existed: the surviving chain's first row links to a deleted
    // predecessor, so the prefix is unverifiable — a loud failure, not a
    // silent re-anchor.
    sql.exec(`DELETE FROM mas_events WHERE id = ?`, "a1");
    const result = verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    expect(result.valid).toBe(false);
    expect(result.alertRecorded).toBe(true);
    expect(result.checkpoint.tailRowId).toBeNull();
  });
});

describe("window read (#2437)", () => {
  it("reads only rows after the given rowid, in insertion order", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    orm.events.create(event("a3", "followup.schedule_failed", { jobId: "j1" }));
    const window = readAuditChainWindow(sql as never, 1);
    expect(window.map((r) => r.id)).toEqual(["a2", "a3"]);
    expect(window.map((r) => r.rowId)).toEqual([2, 3]);
    expect(readAuditChainWindow(sql as never, 3)).toEqual([]);
  });
});

describe("checkpoint record parse (#2437)", () => {
  it("round-trips a valid record and rejects corrupt values", () => {
    const record = {
      verifiedAt: "2026-11-17T10:00:00.000Z",
      valid: true,
      rowsChecked: 3,
      tailRowId: 3,
      tailHash: "abc",
      anchorKind: "genesis",
      brokenIndex: null,
      brokenRowId: null,
      reason: null,
      chain: "d1",
    };
    expect(parseAuditChainVerificationRecord(JSON.stringify(record))).toEqual(record);
    expect(parseAuditChainVerificationRecord(null)).toBeNull();
    expect(parseAuditChainVerificationRecord("not-json{")).toBeNull();
    expect(parseAuditChainVerificationRecord(JSON.stringify({ ...record, tailRowId: "3" }))).toBeNull();
    expect(parseAuditChainVerificationRecord(JSON.stringify({ ...record, anchorKind: "surviving" }))).toBeNull();
    expect(parseAuditChainVerificationRecord(JSON.stringify({ valid: true }))).toBeNull();
    // #6102: a record without a chain marker predates the D1 cutover —
    // it is not a D1 checkpoint (the D1 verifier re-anchors from genesis).
    const { chain: _dropped, ...preCutover } = record;
    expect(parseAuditChainVerificationRecord(JSON.stringify(preCutover))).toBeNull();
    expect(parseAuditChainVerificationRecord(JSON.stringify({ ...record, chain: "do" }))).toEqual({
      ...record,
      chain: "do",
    });
  });
});

describe("GET /api/audit/chain-verification (#2437)", () => {
  const auditCtx = (sql: MockSqlStorage, orm: DatabaseORM): AuditRouteContext =>
    ({
      ensureTables: () => sql as never,
      getOrm: () => orm,
      audit: vi.fn(),
      recordAudit: vi.fn(),
    }) as unknown as AuditRouteContext;

  const get = (path: string) =>
    new Request(`https://agent.internal${path}`, { method: "GET" });

  it("reports never verified when no checkpoint exists", async () => {
    const { sql, orm } = makeOrm();
    const res = await handleAuditRoutes(
      get("/api/audit/chain-verification"),
      new URL("https://agent.internal/api/audit/chain-verification"),
      "/api/audit/chain-verification",
      "s1",
      auditCtx(sql, orm),
    );
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({
      verified: false,
      reason: "never verified",
    });
  });

  it("returns the persisted record after a verification run", async () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    verifyStoredAuditChainAndAlertCheckpointed(sql as never, orm);
    const res = await handleAuditRoutes(
      get("/api/audit/chain-verification"),
      new URL("https://agent.internal/api/audit/chain-verification"),
      "/api/audit/chain-verification",
      "s1",
      auditCtx(sql, orm),
    );
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ verified: true, valid: true, tailRowId: 2, rowsChecked: 2 });
  });
});
