// @vitest-environment node
/**
 * #2359 (#1976 step 4d) — orchestrator-table + canonical-report
 * store ports conformance.
 *
 * One contract suite per port, run over EVERY adapter the
 * composition roots can serve: the DO-SQLite adapters (over a
 * node:sqlite-backed SqlStorage double with real semantics)
 * and the in-memory adapters. The contract is the legacy
 * surfaces' behaviour as characterized in
 * orchestrator_tables_step4d_characterization_2359:
 * insert-or-throw writes (ADR D-E.1), owner scoping on every
 * preset/report statement, the confirmations TTL sweep, the
 * verdict ledger's append-only projection, the report seam's
 * dedupe lookup + fan-out outcome recording + the backfill
 * pointer's still-NULL guard, and per-tenant usage listing.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  createCanonicalReportStorePorts,
  createInMemoryCanonicalReportStorePorts,
  type CanonicalReportStorePorts,
} from "../src/data/createCanonicalReportStorePorts";
import {
  createInMemoryOrchestratorTablePorts,
  createOrchestratorTablePorts,
  type OrchestratorTablePorts,
} from "../src/data/createOrchestratorTablePorts";

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

const T0 = "2026-10-29T10:00:00.000Z";
const T1 = "2026-10-29T10:01:00.000Z";
const T2 = "2026-10-29T10:02:00.000Z";

const TABLE_ADAPTERS: Array<[string, () => OrchestratorTablePorts]> = [
  ["DO-SQLite", () => createOrchestratorTablePorts(new SqliteTestStorage() as never)],
  ["in-memory", () => createInMemoryOrchestratorTablePorts()],
];

for (const [name, make] of TABLE_ADAPTERS) {
  describe(`conformance 4d [${name}]: AutopilotStatePort`, () => {
    it("ensure is idempotent; missing key reads null; put/get round-trips and overwrites", () => {
      const p = make();
      p.autopilot.ensureSchema();
      p.autopilot.ensureSchema();
      expect(p.autopilot.getValue("k")).toBeNull();
      p.autopilot.putValue("k", "v1", T0);
      expect(p.autopilot.getValue("k")).toBe("v1");
      p.autopilot.putValue("k", "v2", T1);
      expect(p.autopilot.getValue("k")).toBe("v2");
      expect(p.autopilot.getValue("other")).toBeNull();
    });
  });

  describe(`conformance 4d [${name}]: PolicyVerdictPort`, () => {
    const verdict = (id: string, createdAt: string, symbol = "AAPL") => ({
      id,
      sessionId: "s1",
      symbol,
      action: "BUY",
      quantity: 5,
      notional: 500,
      mode: "paper",
      dryRun: true,
      passed: true,
      executionAllowed: false,
      requiresApproval: true,
      bindingRule: null,
      detail: "d",
      limitsJson: "{}",
      projectionsJson: "{}",
      findingsJson: "[]",
      signature: `sig-${id}`,
      signingKeyId: "key-1",
      proposerDid: "did:agent",
      authorizerDid: "did:user",
      createdAt,
    });

    it("insert + listRecent returns the projection newest-first with 0/1 flags", () => {
      const p = make();
      p.verdicts.ensureSchema();
      p.verdicts.insertVerdict(verdict("v1", T0));
      p.verdicts.insertVerdict(verdict("v2", T1, "MSFT"));
      const rows = p.verdicts.listRecent(25);
      expect(rows.map((r) => r.id)).toEqual(["v2", "v1"]);
      expect(rows[0].dry_run).toBe(1);
      expect(rows[0].passed).toBe(1);
      expect(rows[0].execution_allowed).toBe(0);
      expect(rows[0].requires_approval).toBe(1);
      expect(rows[0].signature).toBe("sig-v2");
      expect(p.verdicts.listRecent(1)).toHaveLength(1);
    });

    it("a duplicate verdict id throws (insert-or-throw, D-E.1)", () => {
      const p = make();
      p.verdicts.ensureSchema();
      p.verdicts.insertVerdict(verdict("v1", T0));
      expect(() => p.verdicts.insertVerdict(verdict("v1", T1))).toThrow();
    });
  });

  describe(`conformance 4d [${name}]: ReportConfirmationPort`, () => {
    const confirmation = (id: string, createdAt: string, reportId: string | null = null) => ({
      id,
      kind: "email",
      payloadJson: "{}",
      status: "pending",
      createdAt,
      reportId,
    });

    it("insert/getById/decide round-trips; missing id reads null", () => {
      const p = make();
      p.confirmations.ensureSchema();
      p.confirmations.insertConfirmation(confirmation("rc_1", T0, "rep_1"));
      const row = p.confirmations.getById("rc_1");
      expect(row?.status).toBe("pending");
      expect(row?.report_id).toBe("rep_1");
      p.confirmations.decide("rc_1", "approved", T1, "alice");
      const decided = p.confirmations.getById("rc_1");
      expect(decided?.status).toBe("approved");
      expect(decided?.decided_at).toBe(T1);
      expect(decided?.decided_by).toBe("alice");
      expect(p.confirmations.getById("rc_nope")).toBeNull();
      expect(() => p.confirmations.insertConfirmation(confirmation("rc_1", T0))).toThrow();
    });

    it("the sweep removes only still-pending rows older than the cutoff", () => {
      const p = make();
      p.confirmations.ensureSchema();
      p.confirmations.insertConfirmation(confirmation("rc_old_pending", T0));
      p.confirmations.insertConfirmation(confirmation("rc_old_decided", T0));
      p.confirmations.decide("rc_old_decided", "rejected", T0, "alice");
      p.confirmations.insertConfirmation(confirmation("rc_fresh", T2));
      p.confirmations.sweepExpiredPending(T1);
      expect(p.confirmations.getById("rc_old_pending")).toBeNull();
      expect(p.confirmations.getById("rc_old_decided")).not.toBeNull();
      expect(p.confirmations.getById("rc_fresh")).not.toBeNull();
    });

    it("listPending is pending-only newest-first; listByReportId is scoped to the report", () => {
      const p = make();
      p.confirmations.ensureSchema();
      p.confirmations.insertConfirmation(confirmation("rc_1", T0, "rep_1"));
      p.confirmations.insertConfirmation(confirmation("rc_2", T1, "rep_1"));
      p.confirmations.insertConfirmation(confirmation("rc_3", T2, "rep_2"));
      p.confirmations.decide("rc_2", "approved", T2, "alice");
      expect(p.confirmations.listPending().map((r) => r.id)).toEqual(["rc_3", "rc_1"]);
      expect(p.confirmations.listByReportId("rep_1").map((r) => r.id)).toEqual(["rc_2", "rc_1"]);
      expect(p.confirmations.listByReportId("rep_none")).toEqual([]);
    });
  });

  describe(`conformance 4d [${name}]: ScreenerPresetPort`, () => {
    const preset = (id: string, user: string, updatedAt: string) => ({
      id,
      user_login: user,
      name: `Preset ${id}`,
      asset_class: "stocks",
      criteria_json: "{}",
      created_at: T0,
      updated_at: updatedAt,
    });

    it("list/insert are owner-scoped and ordered by updated_at desc", () => {
      const p = make();
      p.presets.ensureSchema();
      p.presets.insertPreset(preset("p1", "alice", T0));
      p.presets.insertPreset(preset("p2", "alice", T1));
      p.presets.insertPreset(preset("p3", "bob", T2));
      expect(p.presets.listByUser("alice").map((r) => r.id)).toEqual(["p2", "p1"]);
      expect(p.presets.listByUser("carol")).toEqual([]);
      expect(() => p.presets.insertPreset(preset("p1", "alice", T2))).toThrow();
    });

    it("exists/delete/resolution never cross users (no existence oracle)", () => {
      const p = make();
      p.presets.ensureSchema();
      p.presets.insertPreset(preset("p1", "alice", T0));
      expect(p.presets.existsForUser("p1", "alice")).toBe(true);
      expect(p.presets.existsForUser("p1", "bob")).toBe(false);
      p.presets.deleteForUser("p1", "bob");
      expect(p.presets.existsForUser("p1", "alice")).toBe(true);
      expect(p.presets.getResolutionRow("p1", "bob")).toBeNull();
      expect(p.presets.getResolutionRow("p1", "alice")?.asset_class).toBe("stocks");
      p.presets.deleteForUser("p1", "alice");
      expect(p.presets.existsForUser("p1", "alice")).toBe(false);
    });
  });
}

describe("conformance 4d [DO-SQLite only]: confirmations probed migration", () => {
  it("ensureSchema adds report_id to a pre-#308 table without dropping rows", () => {
    const sql = new SqliteTestStorage();
    sql.exec(`CREATE TABLE mas_report_confirmations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
    )`);
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?)",
      "rc_legacy",
      "email",
      "{}",
      "pending",
      T0
    );
    const p = createOrchestratorTablePorts(sql as never);
    p.confirmations.ensureSchema();
    const row = p.confirmations.getById("rc_legacy");
    expect(row?.id).toBe("rc_legacy");
    expect(row?.report_id).toBeNull();
  });
});

const STORE_ADAPTERS: Array<[string, () => CanonicalReportStorePorts]> = [
  ["DO-SQLite", () => createCanonicalReportStorePorts(new SqliteTestStorage() as never)],
  ["in-memory", () => createInMemoryCanonicalReportStorePorts()],
];

for (const [name, make] of STORE_ADAPTERS) {
  describe(`conformance 4d [${name}]: CanonicalReportWritePort`, () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      runId: `run-${id}`,
      title: `Title ${id}`,
      source: "screener",
      summary: "s",
      body: "{}",
      createdAt: T0,
      generationId: `gen-${id}`,
      owner: "alice",
      bodyR2Key: null,
      fanoutOutcomeJson: "{}",
      ...over,
    });

    it("insert + read-back round-trips; the dedupe lookup is tenant-scoped", () => {
      const p = make();
      p.write.ensureSchema();
      p.write.ensureSchema();
      expect(p.write.findIdByGeneration("gen-r1", "alice")).toBe("");
      p.write.insertRow(row("r1"));
      expect(p.write.findIdByGeneration("gen-r1", "alice")).toBe("r1");
      expect(p.write.findIdByGeneration("gen-r1", "bob")).toBe("");
      const hit = p.read.getRowById("r1");
      expect(hit?.title).toBe("Title r1");
      expect(hit?.fanout_outcome).toBe("{}");
      expect(p.write.findStoredContent("r1")?.body).toBe("{}");
      expect(p.write.findStoredContent("nope")).toBeNull();
    });

    it("duplicate id throws; duplicate generation throws only within the same tenant (the #2398 tenant-scoped UNIQUE backstop)", () => {
      // INVERTED for #2398 (§7 — this was the #2359 as-found pin
      // of the GLOBAL unique backstop): the backstop is scoped
      // on (owner, generation) now. The scenario is unchanged —
      // same three inserts; the cross-tenant expectation flips
      // from throw to land, and a same-tenant duplicate insert
      // is pinned explicitly (it throws, as it did before).
      const p = make();
      p.write.ensureSchema();
      p.write.insertRow(row("r1"));
      expect(() => p.write.insertRow(row("r1", { generationId: "gen-other" }))).toThrow();
      expect(() => p.write.insertRow(row("r2", { generationId: "gen-r1" }))).toThrow();
      expect(() => p.write.insertRow(row("r3", { generationId: "gen-r1", owner: "bob" }))).not.toThrow();
      expect(p.write.findIdByGeneration("gen-r1", "alice")).toBe("r1");
      expect(p.write.findIdByGeneration("gen-r1", "bob")).toBe("r3");
    });

    it("fan-out outcome recording round-trips through the raw accessor", () => {
      const p = make();
      p.write.ensureSchema();
      p.write.insertRow(row("r1"));
      expect(p.write.getFanoutOutcomeRaw("r1")).toBe("{}");
      p.write.updateFanoutOutcome("r1", "{\"outcome\":\"deduped\"}");
      expect(p.write.getFanoutOutcomeRaw("r1")).toBe("{\"outcome\":\"deduped\"}");
      expect(p.write.getFanoutOutcomeRaw("nope")).toBeNull();
    });

    it("the backfill pointer rewrite is guarded on the pointer still being NULL", () => {
      const p = make();
      p.write.ensureSchema();
      p.write.insertRow(row("r1", { body: "inline-body" }));
      p.write.backfillBodyPointer("r1", "reports/r1.json");
      let hit = p.read.getRowById("r1");
      expect(hit?.body_r2_key).toBe("reports/r1.json");
      expect(hit?.body).toBe("");
      p.write.backfillBodyPointer("r1", "reports/other.json");
      hit = p.read.getRowById("r1");
      expect(hit?.body_r2_key).toBe("reports/r1.json");
    });

    it("deleteRow removes the row", () => {
      const p = make();
      p.write.ensureSchema();
      p.write.insertRow(row("r1"));
      p.write.deleteRow("r1");
      expect(p.read.getRowById("r1")).toBeNull();
    });
  });

  describe(`conformance 4d [${name}]: CanonicalReportReadPort`, () => {
    const row = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
      id,
      runId: `run-${id}`,
      title: `Title ${id}`,
      source: "screener",
      summary: "s",
      body: "{}",
      createdAt,
      generationId: `gen-${id}`,
      owner: "alice",
      bodyR2Key: null,
      fanoutOutcomeJson: "{}",
      ...over,
    });

    it("search matches any token (OR), owner-scoped, newest first", () => {
      const p = make();
      p.write.ensureSchema();
      p.write.insertRow(row("r1", T0, { title: "Alpha screen" }));
      p.write.insertRow(row("r2", T1, { title: "Beta screen", owner: "bob" }));
      p.write.insertRow(row("r3", T2, { title: "Gamma", summary: "alpha mention" }));
      expect(p.read.searchRows(["alpha"], "alice", 5).map((r) => r.id)).toEqual(["r3", "r1"]);
      expect(p.read.searchRows(["alpha"], undefined, 5).map((r) => r.id)).toEqual(["r3", "r1"]);
      expect(p.read.searchRows(["zzz"], undefined, 5)).toEqual([]);
    });

    it("list filters by owner and source; by-id honours owner scoping", () => {
      const p = make();
      p.write.ensureSchema();
      p.write.insertRow(row("r1", T0));
      p.write.insertRow(row("r2", T1, { source: "research_report" }));
      p.write.insertRow(row("r3", T2, { owner: "bob" }));
      expect(p.read.listRows("alice", undefined, 10).map((r) => r.id)).toEqual(["r2", "r1"]);
      expect(p.read.listRows(undefined, "research_report", 10).map((r) => r.id)).toEqual(["r2"]);
      expect(p.read.getRowByIdForOwner("r1", "bob")).toBeNull();
      expect(p.read.getRowByIdForOwner("r1", "alice")?.id).toBe("r1");
      expect(p.read.getRowByIdForOwner("r1", undefined)?.id).toBe("r1");
      expect(p.read.findIdByRunId("run-r2")).toBe("r2");
      expect(p.read.findIdByRunId("run-nope")).toBeNull();
    });

    it("the backfill page is oldest-first and pages by offset", () => {
      const p = make();
      p.write.ensureSchema();
      p.write.insertRow(row("r1", T0));
      p.write.insertRow(row("r2", T1));
      p.write.insertRow(row("r3", T2));
      expect(p.read.listIndexBackfillRows(2, 0).map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(p.read.listIndexBackfillRows(2, 2).map((r) => r.id)).toEqual(["r3"]);
    });
  });

  describe(`conformance 4d [${name}]: UsageEventPort`, () => {
    it("insert + per-tenant listing, newest first; duplicate id throws", () => {
      const p = make();
      p.usage.ensureSchema();
      const event = (id: string, user: string, createdAt: string, tenantId: string | null = null) => ({
        id,
        userLogin: user,
        runId: `run-${id}`,
        category: "research_run",
        createdAt,
        detailJson: null,
        tenantId,
      });
      p.usage.insertEvent(event("u1", "alice", T0, "tenant-a"));
      p.usage.insertEvent(event("u2", "alice", T1, "tenant-a"));
      p.usage.insertEvent(event("u3", "bob", T2, "tenant-b"));
      expect(p.usage.listByUser("alice", 10).map((e) => e.id)).toEqual(["u2", "u1"]);
      expect(p.usage.listByUser("carol", 10)).toEqual([]);
      expect(() => p.usage.insertEvent(event("u1", "alice", T2))).toThrow();
      // Issue #3185: the tenant read sees exactly its own rows,
      // newest first; NULL-stamped rows match no tenant.
      expect(p.usage.listByTenant("tenant-a", 10).map((e) => e.id)).toEqual(["u2", "u1"]);
      expect(p.usage.listByTenant("tenant-b", 10).map((e) => e.id)).toEqual(["u3"]);
      expect(p.usage.listByTenant("tenant-none", 10)).toEqual([]);
      expect(p.usage.listByUser("alice", 10).map((e) => e.tenantId)).toEqual(["tenant-a", "tenant-a"]);
    });
  });
}
