/**
 * Issue #3156 (Q7, #945): verification-failure alert path.
 *
 * A failed chain verification must emit a loud, AUDITED alert —
 * recorded as an audit row, never console-only, never silent.
 * Proven here: corrupt a link in a test chain -> an
 * `audit.tamper_detected` row is recorded carrying the broken
 * index and reason; a valid chain records no alert; an alert
 * write failure throws (it must never be swallowed); and
 * appending the alert onto a broken tail does NOT repair or
 * hide the original break.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM, verifyStoredAuditChain } from "../src/orm";
import type { AuditEvent } from "../src/types";
import { diagnoseAuditChain } from "../src/security/auditChain";
import {
  recordTamperAlert,
  verifyStoredAuditChainAndAlert,
  verifyAndAlertD1Chain,
} from "../src/services/auditTamperAlert";
import { InMemoryAuditPolicyAdapter } from "../src/data/inMemoryAuditPolicyAdapter";

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

describe("tamper diagnosis (#3156)", () => {
  it("diagnoses a tampered payload with its index and reason", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    sql.exec(`UPDATE mas_events SET payload = ? WHERE id = ?`, JSON.stringify({ jobId: "tampered" }), "a1");
    const rows = orm.events.findMany({}).map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      type: r.type,
      agent: r.agent,
      payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload ?? {}),
      createdAt: r.createdAt,
      previousEventHash: r.previousEventHash ?? null,
      eventHash: r.eventHash ?? "",
    }));
    const diagnosis = diagnoseAuditChain(rows);
    expect(diagnosis.valid).toBe(false);
    expect(diagnosis.brokenIndex).toBe(0);
    expect(diagnosis.reason).toMatch(/hash/i);
  });

  it("a valid chain diagnoses clean", () => {
    const { orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    const rows = orm.events.findMany({}).map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      type: r.type,
      agent: r.agent,
      payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload ?? {}),
      createdAt: r.createdAt,
      previousEventHash: r.previousEventHash ?? null,
      eventHash: r.eventHash ?? "",
    }));
    expect(diagnoseAuditChain(rows)).toEqual({ valid: true, brokenIndex: null, reason: null });
  });
});

describe("mas_events verification-failure alert (#3156)", () => {
  it("a corrupted chain records an audit.tamper_detected alert carrying brokenIndex + reason", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    sql.exec(`UPDATE mas_events SET payload = ? WHERE id = ?`, JSON.stringify({ jobId: "tampered" }), "a1");
    const result = verifyStoredAuditChainAndAlert(orm);
    expect(result.valid).toBe(false);
    expect(result.alertRecorded).toBe(true);
    expect(result.alertId).toMatch(/^tamper_/);
    const alerts = tamperAlerts(orm);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.chain).toBe("mas_events");
    expect(alerts[0].payload.brokenIndex).toBe(0);
    expect(typeof alerts[0].payload.reason).toBe("string");
  });

  it("a valid chain records no alert", () => {
    const { orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    const result = verifyStoredAuditChainAndAlert(orm);
    expect(result.valid).toBe(true);
    expect(result.alertRecorded).toBe(false);
    expect(result.alertId).toBeUndefined();
    expect(tamperAlerts(orm)).toHaveLength(0);
  });

  it("an alert write failure throws — never silent, never swallowed", () => {
    expect(() =>
      recordTamperAlert(
        {
          create: () => {
            throw new Error("audit store down");
          },
        },
        { chain: "mas_events", brokenIndex: 0, reason: "hash recomputation mismatch" },
      ),
    ).toThrow("audit store down");
  });

  it("appending the alert onto a broken tail does NOT repair or hide the break", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    sql.exec(`UPDATE mas_events SET payload = ? WHERE id = ?`, JSON.stringify({ jobId: "tampered" }), "a1");
    verifyStoredAuditChainAndAlert(orm);
    // The alert row chained onto the tail; the original break persists.
    expect(verifyStoredAuditChain(orm)).toBe(false);
    expect(tamperAlerts(orm)).toHaveLength(1);
  });
});

describe("d1-chain verification-failure alert (#3156)", () => {
  it("a corrupted d1 chain records an alert carrying tenant + sequence position", async () => {
    const port = new InMemoryAuditPolicyAdapter();
    await port.appendChainEntry({ tenantId: "primary", action: "payment.charge", payload: { order: "o1" } });
    await port.appendChainEntry({ tenantId: "primary", action: "payment.charge", payload: { order: "o2" } });
    // Corrupt the second link in place (test-only poke at the adapter store).
    const stored = (port as unknown as { chain: Map<string, { sequence: number; prevHash: string }> }).chain;
    for (const entry of stored.values()) {
      if (entry.sequence === 2) entry.prevHash = "garbage";
    }
    const recorded: AuditEvent[] = [];
    const result = await verifyAndAlertD1Chain(
      port,
      {
        create: (r: AuditEvent) => {
          recorded.push(r);
          return r;
        },
      },
      "primary",
    );
    expect(result.valid).toBe(false);
    expect(result.alertRecorded).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].type).toBe("audit.tamper_detected");
    const payload = recorded[0].payload as Record<string, unknown>;
    expect(payload.chain).toBe("d1-chain");
    expect(payload.tenantId).toBe("primary");
    expect(typeof payload.reason).toBe("string");
  });

  it("a valid d1 chain records no alert", async () => {
    const port = new InMemoryAuditPolicyAdapter();
    await port.appendChainEntry({ tenantId: "primary", action: "payment.charge", payload: { order: "o1" } });
    await port.appendChainEntry({ tenantId: "primary", action: "payment.refund", payload: { order: "o1" } });
    const recorded: AuditEvent[] = [];
    const result = await verifyAndAlertD1Chain(
      port,
      {
        create: (r: AuditEvent) => {
          recorded.push(r);
          return r;
        },
      },
      "primary",
    );
    expect(result.valid).toBe(true);
    expect(result.alertRecorded).toBe(false);
    expect(recorded).toHaveLength(0);
  });
});
