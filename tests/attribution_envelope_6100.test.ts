/**
 * Issue #6100 — one attribution envelope: every platform event attributable
 * per tenant / user / session / action.
 *
 * TDD: written before the implementation. The envelope is defined once
 * (src/security/attributionEnvelope.ts), stamped at the boundary
 * (OrchestratorAgent.recordAudit), and carried into mas_events as
 * first-class columns (decision: columns, not a payload envelope —
 * the four read questions must be queries, and the repository
 * findMany is column-based; see NOTES.md in ~/workspace/w6100).
 */
import { describe, expect, it } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM, verifyStoredAuditChain } from "../src/orm";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import type { Env } from "../src/types";
import { linkAuditRow } from "../src/security/auditChain";
import { ensureAttributionEnvelopeColumns } from "../src/data/ormSchema";
import {
  auditEventToEnvelope,
  resolveAttributionEnvelope,
  resolvePlatformId,
  usageEventToEnvelope,
  type AttributionEnvelope,
} from "../src/security/attributionEnvelope";
import type { AuditEvent } from "../src/types";

function makeOrm() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  return { sql, orm };
}

function event(
  id: string,
  type: string,
  envelope: Partial<AttributionEnvelope> & { sessionId?: string },
): AuditEvent {
  return {
    id,
    sessionId: envelope.sessionId ?? "sess-1",
    type,
    agent: "orchestrator",
    payload: { jobId: "j1" },
    createdAt: "2026-11-23T00:00:00.000Z",
    platformId: envelope.platformId ?? null,
    tenantId: envelope.tenantId ?? null,
    principalId: envelope.principalId ?? null,
    correlationId: envelope.correlationId ?? null,
    traceId: envelope.traceId ?? null,
  };
}

describe("resolvePlatformId (#6100)", () => {
  it("defaults to cfagent when the env value is absent or blank", () => {
    expect(resolvePlatformId(undefined)).toBe("cfagent");
    expect(resolvePlatformId(null)).toBe("cfagent");
    expect(resolvePlatformId("   ")).toBe("cfagent");
  });

  it("uses the configured platform id when set", () => {
    expect(resolvePlatformId("acme-platform")).toBe("acme-platform");
    expect(resolvePlatformId("  acme-platform  ")).toBe("acme-platform");
  });
});

describe("resolveAttributionEnvelope (#6100)", () => {
  it("stamps the boundary dimensions and leaves the rest null, never invented", () => {
    const envelope = resolveAttributionEnvelope({
      platformId: "cfagent",
      sessionId: "sess-1",
      action: "async_job.queued",
    });
    expect(envelope).toEqual({
      platformId: "cfagent",
      tenantId: null,
      principalId: null,
      sessionId: "sess-1",
      action: "async_job.queued",
      traceId: null,
      correlationId: null,
    });
  });

  it("carries the boundary trace and an explicit caller override wins per field", () => {
    const envelope = resolveAttributionEnvelope(
      {
        platformId: "cfagent",
        sessionId: "sess-1",
        action: "async_job.queued",
        traceId: "aabbccddeeff00112233445566778899",
        tenantId: "tenant-boundary",
      },
      { tenantId: "tenant-explicit", correlationId: "corr-1" },
    );
    expect(envelope.tenantId).toBe("tenant-explicit");
    expect(envelope.traceId).toBe("aabbccddeeff00112233445566778899");
    expect(envelope.correlationId).toBe("corr-1");
    expect(envelope.principalId).toBeNull();
  });

  it("is deterministic: no time, no randomness inside", () => {
    const boundary = {
      platformId: "cfagent",
      sessionId: "sess-1",
      action: "async_job.queued",
    } as const;
    expect(resolveAttributionEnvelope(boundary)).toEqual(
      resolveAttributionEnvelope(boundary),
    );
  });
});

describe("mas_events carries the envelope as first-class columns (#6100)", () => {
  it("migration adds the envelope columns to a pre-envelope table, idempotently", () => {
    const { sql } = makeOrm();
    const before = Array.from(sql.exec(`PRAGMA table_info(mas_events)`)) as Array<{
      name: string;
    }>;
    for (const col of ["platform_id", "tenant_id", "principal_id", "correlation_id", "trace_id"]) {
      expect(before.map((c) => c.name)).not.toContain(col);
    }
    ensureAttributionEnvelopeColumns(sql);
    const after = Array.from(sql.exec(`PRAGMA table_info(mas_events)`)) as Array<{
      name: string;
    }>;
    for (const col of ["platform_id", "tenant_id", "principal_id", "correlation_id", "trace_id"]) {
      expect(after.map((c) => c.name)).toContain(col);
    }
    ensureAttributionEnvelopeColumns(sql);
    const again = Array.from(sql.exec(`PRAGMA table_info(mas_events)`)) as Array<{
      name: string;
    }>;
    expect(again.filter((c) => c.name === "tenant_id")).toHaveLength(1);
  });

  it("round-trips the envelope fields through the chained adapter", () => {
    const { orm } = makeOrm();
    orm.events.create(
      event("e1", "async_job.queued", {
        platformId: "cfagent",
        tenantId: "tenant-acme",
        principalId: "user-alice",
        correlationId: "corr-1",
        traceId: "aabbccddeeff00112233445566778899",
      }),
    );
    const stored = orm.events.findById("e1")!;
    expect(stored.platformId).toBe("cfagent");
    expect(stored.tenantId).toBe("tenant-acme");
    expect(stored.principalId).toBe("user-alice");
    expect(stored.correlationId).toBe("corr-1");
    expect(stored.traceId).toBe("aabbccddeeff00112233445566778899");
    expect(stored.sessionId).toBe("sess-1");
    expect(stored.type).toBe("async_job.queued");
  });

  it("the envelope fields do not enter the hash chain (G-5)", () => {
    const { orm } = makeOrm();
    orm.events.create(
      event("e1", "async_job.queued", {
        platformId: "cfagent",
        tenantId: "tenant-acme",
        principalId: "user-alice",
        correlationId: "corr-1",
        traceId: "aabbccddeeff00112233445566778899",
      }),
    );
    const stored = orm.events.findById("e1")!;
    const expected = linkAuditRow(
      {
        id: stored.id,
        sessionId: stored.sessionId,
        type: stored.type,
        agent: stored.agent,
        payload:
          typeof stored.payload === "string"
            ? stored.payload
            : JSON.stringify(stored.payload ?? {}),
        createdAt: stored.createdAt,
      },
      null,
    );
    expect(stored.eventHash).toBe(expected.eventHash);
    expect(verifyStoredAuditChain(orm)).toBe(true);
  });

  it("the four read questions are queries, not scans — named examples", () => {
    const { orm } = makeOrm();
    orm.events.create(
      event("e1", "async_job.queued", {
        tenantId: "tenant-acme",
        principalId: "user-alice",
        sessionId: "sess-1",
        correlationId: "corr-1",
      }),
    );
    orm.events.create(
      event("e2", "async_job.failed", {
        tenantId: "tenant-acme",
        principalId: "user-bob",
        sessionId: "sess-2",
        correlationId: "corr-2",
      }),
    );
    orm.events.create(
      event("e3", "async_job.queued", {
        tenantId: "tenant-globex",
        principalId: "user-alice",
        sessionId: "sess-1",
        correlationId: "corr-3",
      }),
    );
    orm.events.create(
      event("e4", "screener.run_bridged", {
        tenantId: "tenant-globex",
        principalId: "user-carol",
        sessionId: "sess-3",
        correlationId: "corr-1",
      }),
    );
    expect(verifyStoredAuditChain(orm)).toBe(true);

    // Per-tenant: tenant-acme sees e1 + e2 only.
    expect(
      orm.events.findMany({ where: { tenantId: "tenant-acme" } }).map((r) => r.id).sort(),
    ).toEqual(["e1", "e2"]);
    // Per-user: user-alice sees e1 + e3 only.
    expect(
      orm.events.findMany({ where: { principalId: "user-alice" } }).map((r) => r.id).sort(),
    ).toEqual(["e1", "e3"]);
    // Per-session: sess-1 sees e1 + e3 only.
    expect(
      orm.events.findMany({ where: { sessionId: "sess-1" } }).map((r) => r.id).sort(),
    ).toEqual(["e1", "e3"]);
    // Per-action: async_job.queued sees e1 + e3 only (type IS the action).
    expect(
      orm.events.findMany({ where: { type: "async_job.queued" } }).map((r) => r.id).sort(),
    ).toEqual(["e1", "e3"]);
    // Correlation links across tenants and users: corr-1 sees e1 + e4.
    expect(
      orm.events.findMany({ where: { correlationId: "corr-1" } }).map((r) => r.id).sort(),
    ).toEqual(["e1", "e4"]);
  });
});

describe("recordAudit stamps the envelope at the boundary (#6100)", () => {
  // #6102: recordAudit is async and writes D1 through the port
  // resolved from the agent env (memoized per env object), so each
  // agent gets a fresh env carrying a fresh MockD1Database, and the
  // stored row is read back from the D1 store. The store omits null
  // envelope columns (as the DO rowToRecord did not), so null
  // assertions read `(stored.<field> ?? null)`.
  function makeAgent(envOverrides: Record<string, unknown> = {}) {
    const d1Mock = new MockD1Database();
    const store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    const ctx = {
      id: { toString: () => "sess-envelope-1" },
      storage: { sql: new MockSqlStorage() },
      waitUntil: () => {},
    };
    const env = { AI: {}, AGENT_DB: d1Mock, ...envOverrides } as unknown as Env;
    const agent = new OrchestratorAgent(ctx as any, env);
    return { agent, store };
  }

  it("stamps platform/session/action and leaves the rest null outside a turn", async () => {
    const { agent, store } = makeAgent();
    const stored = await (agent as any).recordAudit("async_job.queued", "orchestrator", {
      jobId: "j1",
    });
    const row = (await store.findById(stored.id))!;
    expect(row.platformId).toBe("cfagent");
    expect(row.sessionId).toBe("sess-envelope-1");
    expect(row.type).toBe("async_job.queued");
    expect(row.tenantId ?? null).toBeNull();
    expect(row.principalId ?? null).toBeNull();
    expect(row.traceId ?? null).toBeNull();
    expect(row.correlationId ?? null).toBeNull();
    expect(row.eventHash).toBeTruthy();
  });

  it("uses the configured platform id when PLATFORM_ID is set", async () => {
    const { agent, store } = makeAgent({ PLATFORM_ID: "acme-platform" });
    const stored = await (agent as any).recordAudit("async_job.queued", "orchestrator", {
      jobId: "j1",
    });
    const row = (await store.findById(stored.id))!;
    expect(row.platformId).toBe("acme-platform");
  });

  it("stamps the turn user and trace id inside a turn", async () => {
    const { agent, store } = makeAgent();
    (agent as any).pendingTurn = {
      userLogin: "user-alice",
      traceparent: "00-aabbccddeeff00112233445566778899-0102030405060708-01",
    };
    const stored = await (agent as any).recordAudit("async_job.queued", "orchestrator", {
      jobId: "j1",
    });
    const row = (await store.findById(stored.id))!;
    expect(row.principalId).toBe("user-alice");
    expect(row.traceId).toBe("aabbccddeeff00112233445566778899");
  });

  it("an explicit caller override stamps tenant and correlation", async () => {
    const { agent, store } = makeAgent();
    const stored = await (agent as any).recordAudit(
      "async_job.queued",
      "orchestrator",
      { jobId: "j1" },
      { tenantId: "tenant-acme", correlationId: "corr-9" },
    );
    const row = (await store.findById(stored.id))!;
    expect(row.tenantId).toBe("tenant-acme");
    expect(row.correlationId).toBe("corr-9");
  });
});

describe("usage_events maps to the same envelope (#6100)", () => {
  it("maps the metering axis onto the envelope without changing the row", () => {
    const envelope = usageEventToEnvelope(
      {
        id: "u1",
        userLogin: "user-alice",
        runId: "run-7",
        category: "saga-paid-run",
        createdAt: "2026-11-23T00:00:00.000Z",
        tenantId: "tenant-acme",
      },
      "cfagent",
    );
    expect(envelope).toEqual({
      platformId: "cfagent",
      tenantId: "tenant-acme",
      principalId: "user-alice",
      sessionId: null,
      action: "saga-paid-run",
      traceId: null,
      correlationId: "run-7",
    });
  });

  it("unattributed metering rows map to nulls, never invented values", () => {
    const envelope = usageEventToEnvelope(
      {
        id: "u2",
        userLogin: "user-bob",
        runId: "run-8",
        category: "saga-paid-run",
        createdAt: "2026-11-23T00:00:00.000Z",
        tenantId: null,
      },
      "cfagent",
    );
    expect(envelope.tenantId).toBeNull();
    expect(envelope.principalId).toBe("user-bob");
    expect(envelope.correlationId).toBe("run-8");
  });
});

describe("auditEventToEnvelope (#6100)", () => {
  it("maps a stored mas_events row onto the envelope, action = type", () => {
    const { orm } = makeOrm();
    orm.events.create(
      event("e1", "async_job.queued", {
        platformId: "cfagent",
        tenantId: "tenant-acme",
        principalId: "user-alice",
        correlationId: "corr-1",
        traceId: "aabbccddeeff00112233445566778899",
      }),
    );
    const stored = orm.events.findById("e1")!;
    expect(auditEventToEnvelope(stored)).toEqual({
      platformId: "cfagent",
      tenantId: "tenant-acme",
      principalId: "user-alice",
      sessionId: "sess-1",
      action: "async_job.queued",
      traceId: "aabbccddeeff00112233445566778899",
      correlationId: "corr-1",
    });
  });
});
