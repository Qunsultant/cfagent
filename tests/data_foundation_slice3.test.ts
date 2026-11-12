// @vitest-environment node
/**
 * Issue #1688 ([AGENTIC] Slice 3, audit + reports projection,
 * sub-issue of the #1546 AgentDB program) — TDD red-first.
 *
 * Pinned contracts:
 *  - Migration 0004 owns the agent_chain_audit and agent_reports
 *    DDL; the Drizzle schema maps it.
 *  - Audit grain is row-per-event: one row per lifecycle event,
 *    never a JSON log blob. Replaying the same event id is a
 *    no-op under the primary-key conflict.
 *  - Canonical report rows are written only by the projection
 *    path; deletion happens ONLY via deleteCanonicalReport.
 *  - The chain authority matrix is explicit and enforced:
 *    read for any signed-in role, reconcile/seed for
 *    platform-admin only, project for the system writer only.
 *  - The mas_reports seed is one-time + idempotent, admin-gated,
 *    and never auto-run; its scope is exactly the current
 *    canonical mas_reports rows at invoke time.
 *  - Tenancy is enforced at the repository boundary; a
 *    projection failure never fails the originating transition.
 *  - No projection writer accepts auth material; port modules
 *    never import a store client; domain modules never import
 *    drizzle-orm.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";
import { InMemoryAuditReportAdapter } from "../src/data/inMemoryAuditReportAdapter";
import {
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
  MIGRATION_0059_RUN_LEDGER,
  MIGRATION_0060_RUN_LEDGER_OWNER,
  applyMigrations,
} from "../src/data/migrationRunner";
import {
  agentChainAudit,
  agentReports,
} from "../src/data/drizzleSchema";
import type {
  AuditEventDraft,
  AuditReportStore,
  CanonicalReportRow,
} from "../src/data/auditReportPorts";
import {
  deleteCanonicalReport,
  recordAuditEvent,
  seedCanonicalReports,
} from "../src/data/auditReportProjection";
import {
  isChainOperationAllowed,
  type ChainOperation,
  type ChainRole,
} from "../src/data/chainAuthority";
import {
  handleAuditHistoryRoute,
  handleReportsRoute,
  handleSeedReportsRoute,
} from "../src/data/auditReportRoute";
import { handleReconcileChainsRoute } from "../src/data/chainStatusRoute";
import { runCanonicalReportSeed } from "../src/agents/orchestrator/canonicalReportSeed";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slices 0–2). */
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
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
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
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

async function makeD1Store(): Promise<AuditReportStore> {
  const mock = new MockD1Database();
  const db = createD1AuditReportDb(mock as any);
  await ensureAuditReportSchema(db);
  return new D1AuditReportAdapter(db);
}

function auditDraft(
  overrides: Partial<AuditEventDraft> & { eventKind: AuditEventDraft["eventKind"] },
): AuditEventDraft {
  return {
    tenantId: "primary",
    workspaceId: "primary",
    chainId: "chain-1",
    subjectType: "chain",
    subjectId: "chain-1",
    actor: "system",
    detailJson: "{}",
    occurredAtMs: 1000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
    ...overrides,
  };
}

function reportRow(
  overrides: Partial<CanonicalReportRow> & { reportId: string },
): CanonicalReportRow {
  return {
    tenantId: "primary",
    workspaceId: "primary",
    runId: "run-1",
    generationId: "gen-1",
    title: "Test report",
    source: "screener",
    summary: "summary",
    body: "body",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    version: 1,
    provenanceWriter: "test",
    provenanceSourceDo: "Orchestrator",
    provenanceSourceVersion: "1",
    ...overrides,
  };
}

describe("audit + report port / dialect suite (#1688)", () => {
  const factories: Array<{
    name: string;
    make: () => Promise<AuditReportStore>;
  }> = [
    { name: "d1", make: makeD1Store },
    {
      name: "in-memory",
      make: async () => new InMemoryAuditReportAdapter(),
    },
  ];

  for (const factory of factories) {
    describe(`adapter: ${factory.name}`, () => {
      it("no rows → empty audit history and null latest report", async () => {
        const store = await factory.make();
        expect(await store.listAuditForChain("primary", "chain-1")).toEqual([]);
        expect(await store.latestReport("primary", "rep-1")).toBeNull();
        expect(await store.listReports("primary")).toEqual([]);
      });

      it("audit rows are row-per-event, newest first", async () => {
        const store = await factory.make();
        await recordAuditEvent(store, auditDraft({ eventKind: "synthesize", occurredAtMs: 1000 }), "evt-s", 1000);
        await recordAuditEvent(store, auditDraft({ eventKind: "approve", occurredAtMs: 2000 }), "evt-a", 2000);
        const rows = await store.listAuditForChain("primary", "chain-1");
        expect(rows).toHaveLength(2);
        expect(rows[0].eventKind).toBe("approve");
        expect(rows[1].eventKind).toBe("synthesize");
      });

      it("replaying the same audit event id is a no-op", async () => {
        const store = await factory.make();
        const draft = auditDraft({ eventKind: "synthesize" });
        await recordAuditEvent(store, draft, "evt-1", 1000);
        await recordAuditEvent(store, draft, "evt-1", 1000);
        expect(await store.listAuditForChain("primary", "chain-1")).toHaveLength(1);
      });

      it("latest report version wins regardless of insert order", async () => {
        const store = await factory.make();
        await store.recordReport(reportRow({ reportId: "r1", version: 2, title: "v2" }));
        await store.recordReport(reportRow({ reportId: "r1", version: 1, title: "v1" }));
        const latest = await store.latestReport("primary", "r1");
        expect(latest?.title).toBe("v2");
        expect((await store.listReports("primary"))).toHaveLength(1);
      });

      it("replaying the same report version is a no-op", async () => {
        const store = await factory.make();
        await store.recordReport(reportRow({ reportId: "r1", version: 1, title: "v1" }));
        await store.recordReport(reportRow({ reportId: "r1", version: 1, title: "v1-changed" }));
        expect((await store.latestReport("primary", "r1"))?.title).toBe("v1");
      });

      it("tenant isolation: one tenant's audit + reports are invisible to another", async () => {
        const store = await factory.make();
        await recordAuditEvent(store, auditDraft({ tenantId: "tenant-a", eventKind: "synthesize" }), "evt-t", 1000);
        await store.recordReport(reportRow({ tenantId: "tenant-a", reportId: "r1" }));
        expect(await store.listAuditForChain("tenant-b", "chain-1")).toEqual([]);
        expect(await store.latestReport("tenant-b", "r1")).toBeNull();
        expect(await store.listReports("tenant-b")).toEqual([]);
      });

      it("deleteReport removes only that report's rows", async () => {
        const store = await factory.make();
        await store.recordReport(reportRow({ reportId: "r1" }));
        await store.recordReport(reportRow({ reportId: "r2" }));
        await store.deleteReport("primary", "r1");
        expect(await store.latestReport("primary", "r1")).toBeNull();
        expect((await store.latestReport("primary", "r2"))?.reportId).toBe("r2");
      });
    });
  }
});

describe("migration 0004 (#1688)", () => {
  it("applies once, records _migrations, second apply is a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1AuditReportDb(mock as any);
    await applyMigrations(db, [MIGRATION_0004_AGENT_AUDIT_REPORTS]);
    await applyMigrations(db, [MIGRATION_0004_AGENT_AUDIT_REPORTS]);
    const rows = mock.sqlite
      .prepare("SELECT version, name FROM _migrations ORDER BY version")
      .all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 4 });
    for (const table of ["agent_chain_audit", "agent_reports"]) {
      const found = mock.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(table);
      expect(found).toHaveLength(1);
    }
  });

  it("migration DDL and Drizzle schema agree on columns for both tables", () => {
    // Issue #4116: the drizzle schema is the CURRENT table shape
    // (0004 + the 0059/0060 ALTERs), so the expected columns are
    // the 0004 DDL columns plus every column the later migrations
    // ADD to that table. A drizzle column with no migration still
    // fails this pin — the pin is updated, not loosened.
    const addedColumns = (sqlText: string, table: string): string[] =>
      [...sqlText.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN (\\w+)`, "g"))].map(
        (m) => m[1],
      );
    const pairs: Array<[string, unknown, string]> = [
      ["agent_chain_audit", agentChainAudit, MIGRATION_0004_AGENT_AUDIT_REPORTS.sql],
      ["agent_reports", agentReports, MIGRATION_0004_AGENT_AUDIT_REPORTS.sql],
    ];
    for (const [table, schema, sqlText] of pairs) {
      const rawColumns = getTableConfig(schema as any).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = (sqlText as string)
        .split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1]
        .split("\n);")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
      const expected = [
        ...ddlColumns,
        ...addedColumns(MIGRATION_0059_RUN_LEDGER.sql, table),
        ...addedColumns(MIGRATION_0060_RUN_LEDGER_OWNER.sql, table),
      ];
      expect(expected.sort()).toEqual(schemaColumns.sort());
    }
  });
});

describe("audit projection (#1688, R5)", () => {
  it("a projection failure never throws and is reported", async () => {
    const throwing = {
      recordAuditEvent: async () => {
        throw new Error("boom");
      },
    } as unknown as AuditReportStore;
    const result = await recordAuditEvent(
      throwing,
      auditDraft({ eventKind: "synthesize" }),
      "evt-1",
      1000,
    );
    expect(result.recorded).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("audit rows carry tenant, workspace, chain, timestamps, provenance", async () => {
    const store = new InMemoryAuditReportAdapter();
    await recordAuditEvent(store, auditDraft({ eventKind: "kill" }), "evt-9", 5000);
    const rows = await store.listAuditForChain("primary", "chain-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: "primary",
      workspaceId: "primary",
      chainId: "chain-1",
      eventKind: "kill",
      version: 1,
      occurredAtMs: 1000,
      provenanceWriter: "test",
      provenanceSourceDo: "ScheduledAgent",
      provenanceSourceVersion: "1",
    });
    expect(rows[0].id).toContain("evt-9");
  });
});

describe("chain authority matrix (#1688)", () => {
  it("read is open to signed-in roles; reconcile/seed are platform-admin only; project is system only", () => {
    const roles: ChainRole[] = ["platform-admin", "tenant-admin", "signed-in", "system"];
    const expected: Record<ChainOperation, ChainRole[]> = {
      read: ["platform-admin", "tenant-admin", "signed-in"],
      reconcile: ["platform-admin"],
      project: ["system"],
      seed: ["platform-admin"],
    };
    for (const op of Object.keys(expected) as ChainOperation[]) {
      for (const role of roles) {
        expect(isChainOperationAllowed(role, op)).toBe(
          expected[op].includes(role),
        );
      }
    }
  });

  it("matrix enforcement: a signed-in caller cannot reconcile chains", async () => {
    const res = await handleReconcileChainsRoute({
      session: { internalUserId: "u-1" },
      method: "POST",
      isPlatformAdmin: false,
      tenantId: "primary",
      runReconcile: async () => ({ checked: 0, reconciled: 0, alreadyCurrent: 0, errors: [] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("canonical reports (#1688)", () => {
  it("deleteCanonicalReport refuses non-admin callers and deletes nothing", async () => {
    const store = new InMemoryAuditReportAdapter();
    await store.recordReport(reportRow({ reportId: "r1" }));
    await expect(
      deleteCanonicalReport(store, "primary", "r1", "signed-in"),
    ).rejects.toThrow();
    expect((await store.latestReport("primary", "r1"))?.reportId).toBe("r1");
  });

  it("deleteCanonicalReport deletes for platform-admin callers", async () => {
    const store = new InMemoryAuditReportAdapter();
    await store.recordReport(reportRow({ reportId: "r1" }));
    const result = await deleteCanonicalReport(store, "primary", "r1", "platform-admin");
    expect(result.deleted).toBe(true);
    expect(await store.latestReport("primary", "r1")).toBeNull();
  });

  it("deletion is only reachable via deleteCanonicalReport (source pin)", () => {
    const allowlist = new Set([
      "auditReportPorts.ts",
      "auditReportProjection.ts",
      "d1AuditReportAdapter.ts",
      "inMemoryAuditReportAdapter.ts",
    ]);
    for (const file of readdirSync(resolve(__dirname, "../src/data"))) {
      if (!file.endsWith(".ts") || allowlist.has(file)) continue;
      const text = readFileSync(resolve(__dirname, "../src/data", file), "utf8");
      expect(text).not.toContain("deleteReport");
    }
  });

  it("oversized report bodies are capped, never unbounded", async () => {
    const store = new InMemoryAuditReportAdapter();
    const seeded = await seedCanonicalReports({
      store,
      auditStore: store,
      tenantId: "primary",
      workspaceId: "primary",
      reports: [
        {
          reportId: "r-big",
          runId: "run-big",
          generationId: null,
          title: "big",
          source: "screener",
          summary: "s",
          body: "x".repeat(20000),
          createdAtMs: 1000,
        },
      ],
      nowMs: 2000,
      writer: "test",
      actor: "operator",
    });
    expect(seeded.seededCount).toBe(1);
    const row = await store.latestReport("primary", "r-big");
    expect(row).not.toBeNull();
    expect(row!.body.length).toBeLessThanOrEqual(8000 + "[truncated]".length);
    expect(row!.body).toContain("[truncated]");
  });
});

describe("canonical mas_reports seed (#1688)", () => {
  it("first run seeds every row; second run seeds none", async () => {
    const store = new InMemoryAuditReportAdapter();
    const reports = [
      {
        reportId: "r1", runId: "run-1", generationId: "g1",
        title: "one", source: "screener", summary: "s1", body: "b1", createdAtMs: 100,
      },
      {
        reportId: "r2", runId: "run-2", generationId: null,
        title: "two", source: "screener", summary: "s2", body: "b2", createdAtMs: 200,
      },
    ];
    const first = await seedCanonicalReports({
      store, auditStore: store, tenantId: "primary", workspaceId: "primary",
      reports, nowMs: 1000, writer: "test", actor: "operator",
    });
    expect(first).toMatchObject({ seeded: true, seededCount: 2, alreadyPresent: 0, total: 2 });
    const second = await seedCanonicalReports({
      store, auditStore: store, tenantId: "primary", workspaceId: "primary",
      reports, nowMs: 2000, writer: "test", actor: "operator",
    });
    expect(second).toMatchObject({ seeded: false, seededCount: 0, alreadyPresent: 2, total: 2 });
    expect((await store.listReports("primary"))).toHaveLength(2);
  });

  it("a partial seed fills only the missing rows and records one seed audit event", async () => {
    const store = new InMemoryAuditReportAdapter();
    await store.recordReport(reportRow({ reportId: "r1" }));
    const result = await seedCanonicalReports({
      store, auditStore: store, tenantId: "primary", workspaceId: "primary",
      reports: [
        { reportId: "r1", runId: "run-1", generationId: "g1", title: "one", source: "screener", summary: "s", body: "b", createdAtMs: 100 },
        { reportId: "r2", runId: "run-2", generationId: null, title: "two", source: "screener", summary: "s", body: "b", createdAtMs: 200 },
      ],
      nowMs: 1000, writer: "test", actor: "operator",
    });
    expect(result).toMatchObject({ seeded: true, seededCount: 1, alreadyPresent: 1, total: 2 });
    const audit = await store.listAuditForChain("primary", "chain-1");
    expect(audit).toHaveLength(0);
    const tenantAudit = await store.listAuditForTenant("primary");
    expect(tenantAudit.some((e) => e.eventKind === "seed")).toBe(true);
  });

  it("seed execution throws when AgentDB is unbound (never a fabricated result)", async () => {
    await expect(
      runCanonicalReportSeed({
        env: {},
        listCanonicalReports: () => [],
        tenantId: "primary",
        setBy: "operator",
        nowMs: 1000,
      }),
    ).rejects.toThrow(/not bound/);
  });

  it("seed execution over a bound store seeds and is idempotent", async () => {
    const mock = new MockD1Database();
    const result1 = await runCanonicalReportSeed({
      env: { AGENT_DB: mock as any },
      listCanonicalReports: () => [
        { id: "r1", runId: "run-1", generationId: "g1", title: "one", source: "screener", summary: "s", body: "b", createdAt: new Date(100).toISOString() },
      ],
      tenantId: "primary",
      setBy: "operator",
      nowMs: 1000,
    });
    expect(result1).toMatchObject({ seeded: true, seededCount: 1, total: 1 });
    const result2 = await runCanonicalReportSeed({
      env: { AGENT_DB: mock as any },
      listCanonicalReports: () => [
        { id: "r1", runId: "run-1", generationId: "g1", title: "one", source: "screener", summary: "s", body: "b", createdAt: new Date(100).toISOString() },
      ],
      tenantId: "primary",
      setBy: "operator",
      nowMs: 2000,
    });
    expect(result2).toMatchObject({ seeded: false, seededCount: 0, total: 1 });
  });
});

describe("audit + report routes (#1688)", () => {
  it("audit history: 401 unauthenticated; 405 non-GET; 400 without chainId", async () => {
    const unauth = await handleAuditHistoryRoute({
      session: null, method: "GET", tenantId: "primary", chainId: "c1",
      readHistory: async () => [],
    });
    expect(unauth.status).toBe(401);
    const wrongMethod = await handleAuditHistoryRoute({
      session: { internalUserId: "u" }, method: "POST", tenantId: "primary", chainId: "c1",
      readHistory: async () => [],
    });
    expect(wrongMethod.status).toBe(405);
    const noChain = await handleAuditHistoryRoute({
      session: { internalUserId: "u" }, method: "GET", tenantId: "primary", chainId: "",
      readHistory: async () => [],
    });
    expect(noChain.status).toBe(400);
  });

  it("audit history: 200 returns projection events only", async () => {
    const store = new InMemoryAuditReportAdapter();
    await recordAuditEvent(store, auditDraft({ eventKind: "approve" }), "e1", 1000);
    const res = await handleAuditHistoryRoute({
      session: { internalUserId: "u" }, method: "GET", tenantId: "primary", chainId: "chain-1",
      readHistory: async () => store.listAuditForChain("primary", "chain-1"),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.chainId).toBe("chain-1");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventKind).toBe("approve");
    expect(body.events[0]).not.toHaveProperty("tenantId");
  });

  it("audit history: 500 on read failure, never a partial body", async () => {
    const res = await handleAuditHistoryRoute({
      session: { internalUserId: "u" }, method: "GET", tenantId: "primary", chainId: "c1",
      readHistory: async () => { throw new Error("boom"); },
    });
    expect(res.status).toBe(500);
  });

  it("reports list: 401 / 405; 200 lists latest per report; reportId filters to one", async () => {
    const store = new InMemoryAuditReportAdapter();
    await store.recordReport(reportRow({ reportId: "r1", title: "one" }));
    await store.recordReport(reportRow({ reportId: "r2", title: "two" }));
    const unauth = await handleReportsRoute({
      session: null, method: "GET", tenantId: "primary", reportId: null,
      readReports: async () => [],
    });
    expect(unauth.status).toBe(401);
    const list = await handleReportsRoute({
      session: { internalUserId: "u" }, method: "GET", tenantId: "primary", reportId: null,
      readReports: async () => store.listReports("primary"),
    });
    const listBody = await list.json() as any;
    expect(listBody.reports).toHaveLength(2);
    expect(listBody.reports[0]).not.toHaveProperty("body");
    const one = await handleReportsRoute({
      session: { internalUserId: "u" }, method: "GET", tenantId: "primary", reportId: "r1",
      readReports: async () => {
        const row = await store.latestReport("primary", "r1");
        return row ? [row] : [];
      },
    });
    const oneBody = await one.json() as any;
    expect(oneBody.reports).toHaveLength(1);
    expect(oneBody.reports[0].reportId).toBe("r1");
  });

  it("seed route: 401 / 405 / 403 unwired / 403 non-admin / 200 for admins / 500 on failure", async () => {
    const base = { method: "POST", tenantId: "primary", runSeed: async () => ({ seeded: true, seededCount: 1, alreadyPresent: 0, total: 1 }) };
    expect((await handleSeedReportsRoute({ ...base, session: null, isPlatformAdmin: false })).status).toBe(401);
    expect((await handleSeedReportsRoute({ ...base, session: { internalUserId: "u" }, method: "GET", isPlatformAdmin: true })).status).toBe(405);
    expect((await handleSeedReportsRoute({ ...base, session: { githubLogin: "op" }, isPlatformAdmin: true })).status).toBe(403);
    expect((await handleSeedReportsRoute({ ...base, session: { internalUserId: "u" }, isPlatformAdmin: false })).status).toBe(403);
    const ok = await handleSeedReportsRoute({ ...base, session: { internalUserId: "u", githubLogin: "op" }, isPlatformAdmin: true });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).seeded).toBe(true);
    const fail = await handleSeedReportsRoute({
      ...base, session: { internalUserId: "u" }, isPlatformAdmin: true,
      runSeed: async () => { throw new Error("boom"); },
    });
    expect(fail.status).toBe(500);
  });
});

describe("retention + catalog contract (#1688)", () => {
  it("storageRetention names both new tables", () => {
    const text = readFileSync(resolve(__dirname, "../src/security/storageRetention.ts"), "utf8");
    expect(text).toContain("agent_chain_audit");
    expect(text).toContain("agent_reports");
  });

  it("every new route is catalogued", () => {
    const text = readFileSync(resolve(__dirname, "../src/client/iaaaEndpointCatalog.ts"), "utf8");
    for (const path of ["/api/audit/history", "/api/reports/list", "/api/reports/seed-canonical"]) {
      expect(text).toContain(path);
    }
  });
});

describe("port purity (#1688, R1/R9)", () => {
  it("port, projection, and authority modules never import a store client or write SQL", () => {
    for (const file of ["auditReportPorts.ts", "auditReportProjection.ts", "chainAuthority.ts"]) {
      const text = readFileSync(resolve(__dirname, "../src/data", file), "utf8");
      expect(text).not.toMatch(/drizzle-orm/);
      expect(text).not.toMatch(/D1Database/);
      expect(text).not.toMatch(/env\.AGENT_DB/);
      expect(text).not.toMatch(/SELECT|INSERT INTO/);
    }
  });

  it("no audit/report writer accepts auth material of any kind", () => {
    const text = readFileSync(resolve(__dirname, "../src/data/auditReportPorts.ts"), "utf8");
    expect(text).not.toMatch(/session|credential/i);
  });

  it("new domain modules never import drizzle-orm", () => {
    for (const file of [
      "../src/data/auditReportRoute.ts",
      "../src/agents/orchestrator/canonicalReportSeed.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(text).not.toMatch(/drizzle-orm/);
    }
  });
});
