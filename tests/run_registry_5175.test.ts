// @vitest-environment node
/**
 * Issue #5175 slice 2 — the mas_runs registry (user ruling 2026-11-17,
 * comment 6962347431): one durable registry table per run (canonical
 * id as PK) plus an alias table mapping every legacy id to its
 * canonical run. The registry is the resolution half of the one id
 * authority: slice 1's leaf module mints, this registry records once
 * so any id resolves. Legacy ids become aliases, never rewritten;
 * the registry never mints.
 *
 * Pins:
 *  - 5175-S2-P01 record once: the first write wins — a re-record
 *    reports recorded: false and overwrites nothing; a non-run id
 *    is rejected, never recorded.
 *  - 5175-S2-P02 alias resolution: every legacy alias form resolves
 *    to its canonical run; the canonical id resolves as a run.
 *  - 5175-S2-P03 canonical-only aliases: a canonical id is never an
 *    alias row — it is refused as a conflict and never shadows the
 *    run it names.
 *  - 5175-S2-P04 alias conflicts: the first mapping wins — an alias
 *    already mapped elsewhere is refused and keeps its first run.
 *  - 5175-S2-P05 derived ids resolve to their run; unknown ids
 *    (unrecorded run, unknown legacy id, canonical id of another
 *    kind) are honestly not found.
 *  - 5175-S2-P06 the catalogue seam: both tables + the alias index
 *    live in the DO catalogue, and the DO adapter's ensure executes
 *    exactly those statements.
 *  - 5175-S2-P07 the registry never mints: no minter call and no
 *    entropy source in any registry file; resolution reuses the
 *    leaf module's parser.
 *  - 5175-S2-P08 the in-memory twin agrees with the DO adapter on
 *    the same scenario, outcome for outcome.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MockSqlStorage } from "./mock-sql";
import {
  DO_CATALOGUE,
  doIndexSql,
  doTableSql,
} from "../src/data/schemaComponent/doCatalogue";
import { DoSqliteRunRegistryStore } from "../src/data/doSqliteRunRegistryAdapter";
import {
  createInMemoryRunRegistryPorts,
  createRunRegistryPorts,
  type RunRegistryPorts,
} from "../src/data/createRunRegistryPorts";
import type { RecordRunResult } from "../src/data/runRegistryPorts";
import {
  newPaymentDraftId,
  newRunId,
  stageExecutionId,
} from "../src/services/executionTreeIds";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");

/** MockSqlStorage that records every statement it executes. */
class RecordingSqlStorage extends MockSqlStorage {
  readonly queries: string[] = [];
  override exec(query: string, ...args: unknown[]): Iterable<unknown> {
    this.queries.push(query);
    return super.exec(query, ...args);
  }
}

const NOW = "2026-11-18T14:00:00.000Z";

function freshPorts(): { ports: RunRegistryPorts; queries: string[] } {
  const storage = new RecordingSqlStorage();
  const ports = createRunRegistryPorts(storage as never);
  ports.record.ensureSchema();
  return { ports, queries: storage.queries };
}

/** The shared scenario, run against both implementations for P08. */
function runScenario(ports: RunRegistryPorts): Record<string, unknown> {
  const runA = newRunId();
  const runB = newRunId();
  const first = ports.record.recordRun({
    runId: runA,
    family: "stockscr",
    jobKind: "screener",
    trigger: "scheduled tick",
    aliases: ["run-m9x2k-1", "rsr_abc123"],
    nowIso: NOW,
  });
  const rerecord = ports.record.recordRun({
    runId: runA,
    family: "optionsscr",
    jobKind: "strategy-discovery",
    trigger: "manual Run now",
    aliases: ["screener:chat:nasdaq100:2026-11-18:abcd1234"],
    nowIso: "2026-11-18T15:00:00.000Z",
  });
  const conflict = ports.record.recordRun({
    runId: runB,
    aliases: ["run-m9x2k-1", runA],
    nowIso: NOW,
  });
  return {
    first,
    rerecord,
    conflict,
    runRow: ports.record.getRun(runA),
    resolveRun: ports.resolve.resolveId(runA),
    resolveLegacy: ports.resolve.resolveId("rsr_abc123"),
    resolveScreener: ports.resolve.resolveId(
      "screener:chat:nasdaq100:2026-11-18:abcd1234",
    ),
    resolveStage: ports.resolve.resolveId(stageExecutionId(runA, "feed")),
    resolveUnknown: ports.resolve.resolveId("run-missing-1"),
    resolvePay: ports.resolve.resolveId(newPaymentDraftId()),
  };
}

describe("run registry (#5175 slice 2)", () => {
  it("P01: record once — first write wins, non-run ids rejected", () => {
    const { ports } = freshPorts();
    const runId = newRunId();
    const first = ports.record.recordRun({
      runId,
      family: "stockscr",
      jobKind: "screener",
      trigger: "scheduled tick",
      nowIso: NOW,
    });
    expect(first).toEqual({
      runId,
      recorded: true,
      aliasesRecorded: [],
      aliasConflicts: [],
    });
    const row = ports.record.getRun(runId);
    expect(row).toEqual({
      run_id: runId,
      family: "stockscr",
      job_kind: "screener",
      trigger: "scheduled tick",
      created_at: NOW,
    });
    // Re-record with different provenance: no-op, first write wins.
    const second = ports.record.recordRun({
      runId,
      family: "optionsscr",
      jobKind: "strategy-discovery",
      trigger: "manual Run now",
      nowIso: "2026-11-18T15:00:00.000Z",
    });
    expect(second.recorded).toBe(false);
    expect(ports.record.getRun(runId)).toEqual(row);
    // A non-run canonical id is rejected, never recorded.
    expect(() =>
      ports.record.recordRun({
        runId: newPaymentDraftId() as never,
        nowIso: NOW,
      }),
    ).toThrow(/must be a canonical run id/);
    expect(ports.record.getRun(newPaymentDraftId())).toBeUndefined();
    // A legacy id as the run id is rejected too.
    expect(() =>
      ports.record.recordRun({ runId: "run-m9x2k-1" as never, nowIso: NOW }),
    ).toThrow();
    expect(ports.resolve.resolveId("run-m9x2k-1")).toEqual({
      found: false,
      id: "run-m9x2k-1",
    });
  });

  it("P02: every legacy alias form resolves to its canonical run", () => {
    const { ports } = freshPorts();
    const runId = newRunId();
    const result = ports.record.recordRun({
      runId,
      family: "stockscr",
      jobKind: "screener",
      trigger: "scheduled tick",
      aliases: [
        "run-m9x2k-1",
        "rsr_abc123",
        "screener:chat:nasdaq100:2026-11-18:abcd1234",
      ],
      nowIso: NOW,
    });
    expect(result.aliasesRecorded).toEqual([
      "run-m9x2k-1",
      "rsr_abc123",
      "screener:chat:nasdaq100:2026-11-18:abcd1234",
    ]);
    expect(result.aliasConflicts).toEqual([]);
    expect(ports.resolve.resolveId(runId)).toEqual({
      found: true,
      kind: "run",
      runId,
      row: expect.objectContaining({ run_id: runId }),
    });
    for (const alias of [
      "run-m9x2k-1",
      "rsr_abc123",
      "screener:chat:nasdaq100:2026-11-18:abcd1234",
    ]) {
      expect(ports.resolve.resolveId(alias)).toEqual({
        found: true,
        kind: "alias",
        runId,
        alias,
        row: expect.objectContaining({ run_id: runId }),
      });
    }
  });

  it("P03: a canonical id is never an alias row", () => {
    const { ports } = freshPorts();
    const runA = newRunId();
    const runB = newRunId();
    const stageId = stageExecutionId(runA, "feed");
    const result = ports.record.recordRun({
      runId: runB,
      aliases: [runA, stageId],
      nowIso: NOW,
    });
    expect(result.aliasesRecorded).toEqual([]);
    expect(result.aliasConflicts).toEqual([
      { alias: runA, existingRunId: runA, reason: "canonical" },
      { alias: stageId, existingRunId: stageId, reason: "canonical" },
    ]);
    // Neither canonical id is shadowed: runA still resolves to
    // itself (unrecorded, so honestly not found — never to runB),
    // and the stage id still resolves to its own run.
    expect(ports.resolve.resolveId(runA)).toEqual({
      found: false,
      id: runA,
    });
    ports.record.recordRun({ runId: runA, nowIso: NOW });
    expect(ports.resolve.resolveId(stageId)).toEqual({
      found: true,
      kind: "derived",
      runId: runA,
      row: expect.objectContaining({ run_id: runA }),
    });
  });

  it("P04: alias conflicts — the first mapping wins", () => {
    const { ports } = freshPorts();
    const runA = newRunId();
    const runB = newRunId();
    ports.record.recordRun({
      runId: runA,
      aliases: ["run-m9x2k-1"],
      nowIso: NOW,
    });
    const result = ports.record.recordRun({
      runId: runB,
      aliases: ["run-m9x2k-1"],
      nowIso: NOW,
    });
    expect(result.aliasesRecorded).toEqual([]);
    expect(result.aliasConflicts).toEqual([
      {
        alias: "run-m9x2k-1",
        existingRunId: runA,
        reason: "mapped-elsewhere",
      },
    ]);
    expect(ports.resolve.resolveId("run-m9x2k-1")).toEqual({
      found: true,
      kind: "alias",
      runId: runA,
      alias: "run-m9x2k-1",
      row: expect.objectContaining({ run_id: runA }),
    });
    // Re-recording the same alias for the same run is idempotent,
    // not a conflict.
    const again = ports.record.recordRun({
      runId: runA,
      aliases: ["run-m9x2k-1"],
      nowIso: NOW,
    });
    expect(again.aliasesRecorded).toEqual([]);
    expect(again.aliasConflicts).toEqual([]);
  });

  it("P05: derived ids resolve to their run; unknown ids are not found", () => {
    const { ports } = freshPorts();
    const runId = newRunId();
    ports.record.recordRun({ runId, nowIso: NOW });
    expect(ports.resolve.resolveId(stageExecutionId(runId, "feed"))).toEqual({
      found: true,
      kind: "derived",
      runId,
      row: expect.objectContaining({ run_id: runId }),
    });
    // Unrecorded run, unknown legacy id, canonical id of another
    // kind, and the empty id: all honestly not found.
    expect(ports.resolve.resolveId(newRunId())).toEqual(
      expect.objectContaining({ found: false }),
    );
    expect(ports.resolve.resolveId("run-never-seen")).toEqual({
      found: false,
      id: "run-never-seen",
    });
    expect(ports.resolve.resolveId(newPaymentDraftId())).toEqual(
      expect.objectContaining({ found: false }),
    );
    expect(ports.resolve.resolveId("")).toEqual({ found: false, id: "" });
  });

  it("P06: the catalogue seam — tables + index, ensure executes exactly them", () => {
    expect(
      DO_CATALOGUE.get("schema.do.mas_runs.create_table").statement,
    ).toBe(doTableSql("mas_runs"));
    expect(
      DO_CATALOGUE.get("schema.do.mas_run_aliases.create_table").statement,
    ).toBe(doTableSql("mas_run_aliases"));
    expect(
      DO_CATALOGUE.get(
        "schema.index.mas_run_aliases.create_index_idx_mas_run_aliases_run_id",
      ).statement,
    ).toBe(doIndexSql("idx_mas_run_aliases_run_id"));
    const storage = new RecordingSqlStorage();
    new DoSqliteRunRegistryStore(storage as never).ensureSchema();
    expect(storage.queries).toEqual([
      doTableSql("mas_runs"),
      doTableSql("mas_run_aliases"),
      doIndexSql("idx_mas_run_aliases_run_id"),
    ]);
  });

  it("P07: the registry never mints", () => {
    for (const rel of [
      "data/runRegistryPorts.ts",
      "data/doSqliteRunRegistryAdapter.ts",
      "data/inMemoryRunRegistryAdapter.ts",
      "data/createRunRegistryPorts.ts",
    ]) {
      const text = src(rel);
      expect(text, `${rel} must not mint ids`).not.toMatch(/randomUUID/);
      expect(text, `${rel} must not call a minter`).not.toMatch(
        /\bnew(Run|AsyncJob|PaymentDraft|TaskProposal|LocalOrder|DidProof|GoalRecord|Schedule|PlatformRow)Id\s*\(/,
      );
    }
    // Resolution reuses the leaf module's parser — the registry
    // tells canonical from legacy by parsing, never by minting.
    expect(src("data/doSqliteRunRegistryAdapter.ts")).toContain("parseId(");
    expect(src("data/inMemoryRunRegistryAdapter.ts")).toContain("parseId(");
  });

  it("P08: the in-memory twin agrees with the DO adapter", () => {
    const recorded = runScenario(createInMemoryRunRegistryPorts());
    const stored = runScenario(freshPorts().ports);
    // The scenario mints fresh run ids per run, so compare shapes
    // with the ids normalized out.
    const normalize = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value
          .replace(/^run:[0-9a-z]+-[0-9a-z]+$/, "run:<id>")
          .replace(/^pay:[0-9a-f]{8}$/, "pay:<id>")
          .replace(/^stage:[0-9a-z-]+:feed:-$/, "stage:<body>:feed:-");
      }
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            normalize(v),
          ]),
        );
      }
      return value;
    };
    expect(normalize(recorded)).toEqual(normalize(stored));
    // And the recorded outcomes themselves are the honest ones.
    const first = recorded.first as RecordRunResult;
    expect(first.recorded).toBe(true);
    expect(first.aliasesRecorded).toEqual(["run-m9x2k-1", "rsr_abc123"]);
    expect((recorded.rerecord as RecordRunResult).recorded).toBe(false);
    expect((recorded.conflict as RecordRunResult).aliasConflicts).toHaveLength(
      2,
    );
  });
});
