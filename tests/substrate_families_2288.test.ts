// @vitest-environment node
/**
 * Issue #2288 (#1976 step 0, ADR 0022 D-F) — intelligence
 * substrate conformance suite.
 *
 * The four substrate families (trace records, proposal ledger,
 * fleet registry + conformance matrix, work-item events) each
 * run the SAME conformance suite against their Drizzle D1
 * adapter (over a MockD1Database backed by node:sqlite — no
 * Cloudflare credentials, no live D1 calls) and their in-memory
 * adapter. A behaviour that passes on one adapter and fails on
 * the other is a layer defect, not an application bug — the
 * src/data pattern since slice 0 (#1548).
 *
 * Also pinned here:
 *  - migration 0017 owns the families' DDL; the Drizzle schema
 *    maps it (column parity, the audit-policy technique);
 *  - ALL_MIGRATIONS registers version 17 exactly once and the
 *    14 gap is preserved as-is (gate G-3 — 0013 claimed by
 *    #2306 subscription Stripe ids, #2198, not this slice);
 *  - the port modules import no store client (structural pins);
 *  - recordTraceSafely honours the #1133 discipline: it never
 *    throws, and a failed append returns the stable catalog
 *    code DATA_TRACE_APPEND_FAILED as data.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  ALL_MIGRATIONS,
  MIGRATION_0017_INTELLIGENCE_SUBSTRATE,
} from "../src/data/migrationRunner";
import {
  agentConformanceCells,
  agentFleetRegistry,
  agentProposals,
  agentProposalTransitions,
  agentTraceRecords,
  agentWorkItemEvents,
} from "../src/data/drizzleSchema";
import {
  createD1TraceRecordDb,
  D1TraceRecordAdapter,
  ensureTraceRecordSchema,
} from "../src/data/d1TraceRecordAdapter";
import { InMemoryTraceRecordAdapter } from "../src/data/inMemoryTraceRecordAdapter";
import {
  recordTraceSafely,
  type TraceRecord,
  type TraceRecordStore,
} from "../src/data/traceRecordPorts";
import { createTraceRecordAdapter } from "../src/data/createTraceRecordPorts";
import {
  createD1ProposalLedgerDb,
  D1ProposalLedgerAdapter,
  ensureProposalLedgerSchema,
} from "../src/data/d1ProposalLedgerAdapter";
import { InMemoryProposalLedgerAdapter } from "../src/data/inMemoryProposalLedgerAdapter";
import type { ProposalLedgerStore } from "../src/data/proposalLedgerPorts";
import { createProposalLedgerAdapter } from "../src/data/createProposalLedgerPorts";
import {
  createD1FleetRegistryDb,
  D1FleetRegistryAdapter,
  ensureFleetRegistrySchema,
} from "../src/data/d1FleetRegistryAdapter";
import { InMemoryFleetRegistryAdapter } from "../src/data/inMemoryFleetRegistryAdapter";
import type { FleetRegistryStore } from "../src/data/fleetRegistryPorts";
import { createFleetRegistryAdapter } from "../src/data/createFleetRegistryPorts";
import {
  createD1WorkItemEventDb,
  D1WorkItemEventAdapter,
  ensureWorkItemEventSchema,
} from "../src/data/d1WorkItemEventAdapter";
import { InMemoryWorkItemEventAdapter } from "../src/data/inMemoryWorkItemEventAdapter";
import type { WorkItemEventStore } from "../src/data/workItemEventPorts";
import { createWorkItemEventAdapter } from "../src/data/createWorkItemEventPorts";
import { DataFoundationCode } from "../src/aspects/errorCodes";

/** Minimal D1Database stand-in over node:sqlite (test-only). */
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

/* ------------------------------------------------------------------ */
/* Trace records                                                       */
/* ------------------------------------------------------------------ */

function traceRecord(
  overrides: Partial<TraceRecord> & { id: string },
): TraceRecord {
  return {
    correlationId: "corr-1",
    causationId: null,
    actingAgent: "orchestrator",
    principal: "user:alice",
    operation: "aisearch.search",
    outcomeCode: "DATA_TX_COMMITTED",
    latencyMs: 42,
    costUnits: 1.5,
    costDetailJson: null,
    occurredAtMs: 1000,
    ...overrides,
  };
}

function traceSuite(
  label: string,
  makeStore: () => Promise<TraceRecordStore>,
): void {
  describe(`trace records — ${label}`, () => {
    it("appends and reads back a flow by correlation, oldest first", async () => {
      const store = await makeStore();
      await store.appendTrace(traceRecord({ id: "t2", causationId: "t1", occurredAtMs: 2000 }));
      await store.appendTrace(traceRecord({ id: "t1", occurredAtMs: 1000 }));
      await store.appendTrace(
        traceRecord({ id: "other", correlationId: "corr-2", occurredAtMs: 1500 }),
      );
      const flow = await store.listByCorrelation("corr-1");
      expect(flow.map((r) => r.id)).toEqual(["t1", "t2"]);
      expect(flow[1].causationId).toBe("t1");
      expect(flow[0].principal).toBe("user:alice");
      expect(flow[0].costUnits).toBe(1.5);
    });

    it("replaying a record id is a no-op (at-least-once safe)", async () => {
      const store = await makeStore();
      await store.appendTrace(traceRecord({ id: "t1" }));
      await store.appendTrace(traceRecord({ id: "t1" }));
      expect(await store.listByCorrelation("corr-1")).toHaveLength(1);
    });

    it("lists an agent's steps newest first, honouring the limit", async () => {
      const store = await makeStore();
      await store.appendTrace(traceRecord({ id: "t1", occurredAtMs: 1000 }));
      await store.appendTrace(traceRecord({ id: "t2", occurredAtMs: 3000 }));
      await store.appendTrace(traceRecord({ id: "t3", occurredAtMs: 2000 }));
      await store.appendTrace(
        traceRecord({ id: "t4", actingAgent: "screener", occurredAtMs: 4000 }),
      );
      const steps = await store.listByAgent("orchestrator", 2);
      expect(steps.map((r) => r.id)).toEqual(["t2", "t3"]);
    });
  });
}

traceSuite("D1 adapter", async () => {
  const mock = new MockD1Database();
  const db = createD1TraceRecordDb(mock as any);
  await ensureTraceRecordSchema(db);
  return new D1TraceRecordAdapter(db);
});
traceSuite("in-memory adapter", async () => new InMemoryTraceRecordAdapter());

describe("trace append discipline (#1133)", () => {
  it("recordTraceSafely returns the record on success", async () => {
    const store = new InMemoryTraceRecordAdapter();
    const result = await recordTraceSafely(store, traceRecord({ id: "t1" }));
    expect(result).toEqual({ recorded: true });
    expect(await store.listByCorrelation("corr-1")).toHaveLength(1);
  });

  it("recordTraceSafely never throws: a failed append returns the stable catalog code", async () => {
    const failing: TraceRecordStore = {
      appendTrace: async () => {
        throw new Error("store unavailable");
      },
      listByCorrelation: async () => [],
      listByAgent: async () => [],
    };
    const result = await recordTraceSafely(failing, traceRecord({ id: "t1" }));
    expect(result).toEqual({
      recorded: false,
      failureCode: DataFoundationCode.TRACE_APPEND_FAILED,
      error: "store unavailable",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Proposal ledger                                                     */
/* ------------------------------------------------------------------ */

function ledgerSuite(
  label: string,
  makeStore: () => Promise<ProposalLedgerStore>,
): void {
  describe(`proposal ledger — ${label}`, () => {
    it("proposes in state 'proposed' with a creation transition; replay is a no-op", async () => {
      const store = await makeStore();
      const row = await store.propose({
        id: "p1",
        title: "Promote challenger",
        summary: "Evidence attached",
        proposerAgent: "sentinel",
        principal: "user:alice",
        createdAtMs: 1000,
      });
      expect(row.state).toBe("proposed");
      const replay = await store.propose({
        id: "p1",
        title: "Promote challenger",
        summary: "Evidence attached",
        proposerAgent: "sentinel",
        principal: "user:alice",
        createdAtMs: 1000,
      });
      expect(replay).toEqual(row);
      const history = await store.listTransitions("p1");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromState: null,
        toState: "proposed",
        actor: "sentinel",
        gateRef: null,
      });
    });

    it("walks the full machine with the gate recorded as data at each step", async () => {
      const store = await makeStore();
      await store.propose({
        id: "p1",
        title: "t",
        summary: "s",
        proposerAgent: "sentinel",
        principal: "user:alice",
        createdAtMs: 1000,
      });
      const approved = await store.transition({
        proposalId: "p1",
        toState: "approved",
        actor: "user:alice",
        gateRef: "issue:2300",
        atMs: 2000,
      });
      expect(approved).toMatchObject({
        fromState: "proposed",
        toState: "approved",
        actor: "user:alice",
        gateRef: "issue:2300",
      });
      await store.transition({
        proposalId: "p1",
        toState: "applied",
        actor: "lane:cdo",
        gateRef: "pr:2301",
        atMs: 3000,
      });
      await store.transition({
        proposalId: "p1",
        toState: "verified",
        actor: "lane:cdo",
        gateRef: "pr:2301",
        atMs: 4000,
      });
      expect((await store.getProposal("p1"))?.state).toBe("verified");
      const history = await store.listTransitions("p1");
      expect(history.map((t) => t.toState)).toEqual([
        "proposed",
        "approved",
        "applied",
        "verified",
      ]);
      expect(
        (await store.listProposals("verified")).map((p) => p.id),
      ).toEqual(["p1"]);
    });

    it("refuses a gated transition without the gate recorded: nothing is written", async () => {
      const store = await makeStore();
      await store.propose({
        id: "p1",
        title: "t",
        summary: "s",
        proposerAgent: "sentinel",
        principal: "user:alice",
        createdAtMs: 1000,
      });
      await expect(
        store.transition({
          proposalId: "p1",
          toState: "approved",
          actor: "user:alice",
          atMs: 2000,
        }),
      ).rejects.toMatchObject({
        name: "DataFoundationError",
        code: DataFoundationCode.PROPOSAL_GATE_MISSING,
      });
      expect((await store.getProposal("p1"))?.state).toBe("proposed");
      expect(await store.listTransitions("p1")).toHaveLength(1);
    });

    it("refuses a transition that skips a step of the machine", async () => {
      const store = await makeStore();
      await store.propose({
        id: "p1",
        title: "t",
        summary: "s",
        proposerAgent: "sentinel",
        principal: "user:alice",
        createdAtMs: 1000,
      });
      await expect(
        store.transition({
          proposalId: "p1",
          toState: "applied",
          actor: "user:alice",
          gateRef: "issue:2300",
          atMs: 2000,
        }),
      ).rejects.toMatchObject({
        code: DataFoundationCode.PROPOSAL_ILLEGAL_TRANSITION,
      });
      expect((await store.getProposal("p1"))?.state).toBe("proposed");
    });

    it("transition on a missing proposal throws naming the id", async () => {
      const store = await makeStore();
      await expect(
        store.transition({
          proposalId: "nope",
          toState: "approved",
          actor: "user:alice",
          gateRef: "issue:2300",
        }),
      ).rejects.toThrow("nope");
    });
  });
}

ledgerSuite("D1 adapter", async () => {
  const mock = new MockD1Database();
  const db = createD1ProposalLedgerDb(mock as any);
  await ensureProposalLedgerSchema(db);
  return new D1ProposalLedgerAdapter(db);
});
ledgerSuite("in-memory adapter", async () => new InMemoryProposalLedgerAdapter());

/* ------------------------------------------------------------------ */
/* Fleet registry + conformance matrix                                 */
/* ------------------------------------------------------------------ */

function registrySuite(
  label: string,
  makeStore: () => Promise<FleetRegistryStore>,
): void {
  describe(`fleet registry — ${label}`, () => {
    it("round-trips an agent record incl. operations, identity, and DO schema version", async () => {
      const store = await makeStore();
      await store.upsertAgent({
        agentKey: "orchestrator",
        className: "OrchestratorAgent",
        binding: "ORCHESTRATOR_AGENT",
        instanceScheme: "per-login",
        migrationTag: "v9",
        operations: ["chat", "nlq"],
        identity: { did: "did:example:orchestrator" },
        doSchemaVersion: 2,
        updatedAtMs: 1000,
      });
      const stored = await store.getAgent("orchestrator");
      expect(stored?.operations).toEqual(["chat", "nlq"]);
      expect(stored?.identity).toEqual({ did: "did:example:orchestrator" });
      expect(stored?.doSchemaVersion).toBe(2);
      expect(await store.getAgent("missing")).toBeNull();
    });

    it("upsert replaces the record for the same key; listing is key-ordered", async () => {
      const store = await makeStore();
      const base = {
        className: "X",
        binding: "X_AGENT",
        instanceScheme: "singleton",
        migrationTag: null,
        operations: [] as string[],
        identity: null,
        doSchemaVersion: null,
        updatedAtMs: 1000,
      };
      await store.upsertAgent({ ...base, agentKey: "beta" });
      await store.upsertAgent({ ...base, agentKey: "alpha" });
      await store.upsertAgent({
        ...base,
        agentKey: "alpha",
        className: "AlphaV2",
        updatedAtMs: 2000,
      });
      const agents = await store.listAgents();
      expect(agents.map((a) => a.agentKey)).toEqual(["alpha", "beta"]);
      expect(agents[0].className).toBe("AlphaV2");
    });

    it("matrix cells upsert per (agent, dimension) and list as a whole matrix", async () => {
      const store = await makeStore();
      await store.upsertCell({
        agentKey: "screener",
        dimension: "scheduling",
        status: "GAP",
        reference: "issue:2400",
        updatedAtMs: 1000,
      });
      await store.upsertCell({
        agentKey: "screener",
        dimension: "state",
        status: "IMPLEMENTED",
        reference: null,
        updatedAtMs: 1000,
      });
      await store.upsertCell({
        agentKey: "screener",
        dimension: "scheduling",
        status: "IMPLEMENTED",
        reference: "pr:2401",
        updatedAtMs: 2000,
      });
      await store.upsertCell({
        agentKey: "browser",
        dimension: "state",
        status: "NOT-APPLICABLE",
        reference: null,
        updatedAtMs: 1000,
      });
      const cells = await store.listCells("screener");
      expect(cells.map((c) => c.dimension)).toEqual(["scheduling", "state"]);
      expect(cells[0]).toMatchObject({
        status: "IMPLEMENTED",
        reference: "pr:2401",
      });
      const matrix = await store.listMatrix();
      expect(matrix.map((c) => `${c.agentKey}/${c.dimension}`)).toEqual([
        "browser/state",
        "screener/scheduling",
        "screener/state",
      ]);
    });
  });
}

registrySuite("D1 adapter", async () => {
  const mock = new MockD1Database();
  const db = createD1FleetRegistryDb(mock as any);
  await ensureFleetRegistrySchema(db);
  return new D1FleetRegistryAdapter(db);
});
registrySuite("in-memory adapter", async () => new InMemoryFleetRegistryAdapter());

/* ------------------------------------------------------------------ */
/* Work-item events                                                    */
/* ------------------------------------------------------------------ */

function workItemSuite(
  label: string,
  makeStore: () => Promise<WorkItemEventStore>,
): void {
  describe(`work-item events — ${label}`, () => {
    it("first delivery inserts; the row carries projection bookkeeping", async () => {
      const store = await makeStore();
      const result = await store.upsertWorkItemEvent(
        {
          source: "github",
          externalId: "issue:2281",
          kind: "issue",
          state: "open",
          actor: "CDO-mha7",
          occurredAtMs: 1000,
          payloadDigest: "sha256:aaa",
        },
        5000,
      );
      expect(result).toEqual({ inserted: true });
      const row = await store.getWorkItemEvent("github", "issue:2281");
      expect(row).toMatchObject({
        kind: "issue",
        state: "open",
        createdAtMs: 5000,
        updatedAtMs: 5000,
      });
      expect(await store.getWorkItemEvent("github", "issue:missing")).toBeNull();
    });

    it("redelivery updates state, keeps createdAtMs, and reports inserted: false", async () => {
      const store = await makeStore();
      await store.upsertWorkItemEvent(
        {
          source: "github",
          externalId: "issue:2281",
          kind: "issue",
          state: "open",
          actor: "CDO-mha7",
          occurredAtMs: 1000,
          payloadDigest: "sha256:aaa",
        },
        5000,
      );
      const result = await store.upsertWorkItemEvent(
        {
          source: "github",
          externalId: "issue:2281",
          kind: "issue",
          state: "closed",
          actor: "CDO-mha7",
          occurredAtMs: 2000,
          payloadDigest: "sha256:bbb",
        },
        9000,
      );
      expect(result).toEqual({ inserted: false });
      const row = await store.getWorkItemEvent("github", "issue:2281");
      expect(row).toMatchObject({
        state: "closed",
        payloadDigest: "sha256:bbb",
        createdAtMs: 5000,
        updatedAtMs: 9000,
      });
      expect(await store.listWorkItemEvents()).toHaveLength(1);
    });

    it("lists by kind, newest first", async () => {
      const store = await makeStore();
      await store.upsertWorkItemEvent(
        { source: "github", externalId: "issue:1", kind: "issue", state: "open", actor: null, occurredAtMs: 1000, payloadDigest: "d1" },
        1000,
      );
      await store.upsertWorkItemEvent(
        { source: "github", externalId: "pr:2", kind: "pull_request", state: "merged", actor: null, occurredAtMs: 3000, payloadDigest: "d2" },
        3000,
      );
      await store.upsertWorkItemEvent(
        { source: "github", externalId: "issue:3", kind: "issue", state: "closed", actor: null, occurredAtMs: 2000, payloadDigest: "d3" },
        2000,
      );
      const issues = await store.listWorkItemEvents("issue");
      expect(issues.map((r) => r.externalId)).toEqual(["issue:3", "issue:1"]);
      const all = await store.listWorkItemEvents();
      expect(all.map((r) => r.externalId)).toEqual(["pr:2", "issue:3", "issue:1"]);
    });
  });
}

workItemSuite("D1 adapter", async () => {
  const mock = new MockD1Database();
  const db = createD1WorkItemEventDb(mock as any);
  await ensureWorkItemEventSchema(db);
  return new D1WorkItemEventAdapter(db);
});
workItemSuite("in-memory adapter", async () => new InMemoryWorkItemEventAdapter());

/* ------------------------------------------------------------------ */
/* Composition roots, migration registration, parity, structure        */
/* ------------------------------------------------------------------ */

describe("#2288 substrate — composition roots", () => {
  it("return null without the AGENT_DB binding and an adapter with it", async () => {
    expect(createTraceRecordAdapter({})).toBeNull();
    expect(createProposalLedgerAdapter({})).toBeNull();
    expect(createFleetRegistryAdapter({})).toBeNull();
    expect(createWorkItemEventAdapter({})).toBeNull();
    const mock = new MockD1Database();
    expect(createTraceRecordAdapter({ AGENT_DB: mock })).toBeInstanceOf(
      D1TraceRecordAdapter,
    );
    expect(createProposalLedgerAdapter({ AGENT_DB: mock })).toBeInstanceOf(
      D1ProposalLedgerAdapter,
    );
    expect(createFleetRegistryAdapter({ AGENT_DB: mock })).toBeInstanceOf(
      D1FleetRegistryAdapter,
    );
    expect(createWorkItemEventAdapter({ AGENT_DB: mock })).toBeInstanceOf(
      D1WorkItemEventAdapter,
    );
  });
});

describe("#2288 substrate — migration registration + parity + structure", () => {
  it("migration 0017 is registered exactly once; the 14 gap is preserved (gate G-3)", () => {
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toContain(17);
    expect(versions).toContain(13); // claimed by #2306 (subscription Stripe ids, #2198)
    expect(versions).toContain(14); // claimed by #2296 (billing, #2202)
    expect(MIGRATION_0017_INTELLIGENCE_SUBSTRATE.version).toBe(17);
  });

  it("migration DDL and Drizzle schema agree on columns for all six tables", () => {
    for (const [table, mapping] of [
      ["agent_trace_records", agentTraceRecords],
      ["agent_proposals", agentProposals],
      ["agent_proposal_transitions", agentProposalTransitions],
      ["agent_fleet_registry", agentFleetRegistry],
      ["agent_conformance_cells", agentConformanceCells],
      ["agent_work_item_events", agentWorkItemEvents],
    ] as const) {
      const rawColumns = getTableConfig(mapping).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = MIGRATION_0017_INTELLIGENCE_SUBSTRATE.sql
        .split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1]
        .split(");")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
      expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
    }
  });

  it("port modules import no store client", () => {
    const portFiles = [
      "data/traceRecordPorts.ts",
      "data/proposalLedgerPorts.ts",
      "data/fleetRegistryPorts.ts",
      "data/workItemEventPorts.ts",
    ];
    for (const file of portFiles) {
      const imports = readFileSync(resolve(__dirname, `../src/${file}`), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("import "))
        .join("\n");
      expect(imports).not.toContain("drizzle-orm");
      expect(imports).not.toContain("D1Database");
      expect(imports).not.toContain("Adapter");
    }
  });
});
