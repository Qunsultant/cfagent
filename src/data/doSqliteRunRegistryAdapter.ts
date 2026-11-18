/**
 * Issue #5175 slice 2 — the DO-SQLite implementation of the run
 * registry ports: every statement of the registry family, moved
 * into the data layer statement-for-statement. The legacy modules
 * hold no registry statements; the resolver API + MCP resolve_id
 * (slice 5) and the call-site migration (slice 3) serve through
 * these ports.
 *
 * One class serves both ports (record / resolve are roles over
 * two tables in one instance; the composition root hands the same
 * store out under each role).
 *
 * THE RECORD-ONCE RULE: recordRun is check-then-insert, not
 * rowsWritten — the shared MockSqlStorage returns no write
 * cursor, and the DO instance's serialization makes the
 * check-then-insert safe (the same property the async-job
 * claim relies on: serialization plus a guarded statement).
 * The INSERT OR IGNORE is the backstop, never the detector:
 * a re-record reports recorded: false and overwrites nothing.
 * Alias conflicts are reported in the result, never thrown and
 * never overwritten — the first mapping wins.
 *
 * THE REGISTRY NEVER MINTS: no minter is called here. Ids arrive
 * minted (slice 1's leaf module) or as legacy aliases; parseId
 * is used only to tell a canonical id (never an alias) from a
 * legacy one.
 */
import { parseId } from "../services/executionTreeIds";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import type {
  RecordRunInput,
  RecordRunResult,
  ResolveIdResult,
  RunAliasRow,
  RunRegistryRecordPort,
  RunRegistryResolvePort,
  RunRegistryRow,
  RunRegistrySqlExecutor,
} from "./runRegistryPorts";

// Single-line statements: the shared MockSqlStorage parsers do
// not span newlines inside the column list (a multi-line
// statement silently drops the row under the mock) — the same
// lesson as the async-job adapter's single-line INSERT/SELECT.
// One literal per statement: the DO mechanism-mix pin counts
// these (2 write + 2 read).
const SELECT_RUN_SQL =
  "SELECT run_id, family, job_kind, trigger, created_at FROM mas_runs WHERE run_id = ?";
const SELECT_ALIAS_SQL =
  "SELECT alias, run_id, created_at FROM mas_run_aliases WHERE alias = ?";
const INSERT_RUN_SQL =
  "INSERT OR IGNORE INTO mas_runs (run_id, family, job_kind, trigger, created_at) VALUES (?, ?, ?, ?, ?)";
const INSERT_ALIAS_SQL =
  "INSERT OR IGNORE INTO mas_run_aliases (alias, run_id, created_at) VALUES (?, ?, ?)";

export class DoSqliteRunRegistryStore
  implements RunRegistryRecordPort, RunRegistryResolvePort
{
  constructor(private readonly sql: RunRegistrySqlExecutor) {}

  // ------------------------------------------------------------------
  // Record: DDL — the family's ONE schema home.
  // ------------------------------------------------------------------

  ensureSchema(): void {
    this.sql.exec(doTableSql("mas_runs"));
    this.sql.exec(doTableSql("mas_run_aliases"));
    this.sql.exec(doIndexSql("idx_mas_run_aliases_run_id"));
  }

  // ------------------------------------------------------------------
  // Record: record once, adopt aliases.
  // ------------------------------------------------------------------

  recordRun(input: RecordRunInput): RecordRunResult {
    // Fail-closed on the run id: only a canonical run id is ever
    // a registry row. Anything else is a caller bug, not an alias.
    const parsed = parseId(input.runId);
    if (parsed.type !== "run") {
      throw new Error(
        `run registry (#5175): runId must be a canonical run id, got "${input.runId}"`,
      );
    }
    const now = input.nowIso ?? new Date().toISOString();
    const aliasesRecorded: string[] = [];
    const aliasConflicts: RecordRunResult["aliasConflicts"] = [];

    // First write wins for the run row: a re-record changes
    // nothing (and still adopts any new aliases below).
    const existing = this.getRun(input.runId);
    let recorded = false;
    if (!existing) {
      this.sql.exec(
        INSERT_RUN_SQL,
        input.runId,
        input.family ?? null,
        input.jobKind ?? null,
        input.trigger ?? null,
        now,
      );
      recorded = true;
    }

    for (const alias of new Set(input.aliases ?? [])) {
      // The canonical id itself is not an alias of itself.
      if (alias === input.runId) continue;
      // A canonical id can never be an alias row: it resolves
      // to itself (or its run), never through the alias table.
      let canonical = false;
      try {
        parseId(alias);
        canonical = true;
      } catch {
        canonical = false;
      }
      if (canonical) {
        aliasConflicts.push({
          alias,
          existingRunId: alias,
          reason: "canonical",
        });
        continue;
      }
      const mapped = this.findAlias(alias);
      if (mapped) {
        // Already mapped to this run: idempotent re-record.
        // Mapped elsewhere: the first mapping wins, refuse.
        if (mapped.run_id !== input.runId) {
          aliasConflicts.push({
            alias,
            existingRunId: mapped.run_id,
            reason: "mapped-elsewhere",
          });
        }
        continue;
      }
      this.sql.exec(INSERT_ALIAS_SQL, alias, input.runId, now);
      aliasesRecorded.push(alias);
    }

    return {
      runId: input.runId,
      recorded,
      aliasesRecorded,
      aliasConflicts,
    };
  }

  getRun(runId: string): RunRegistryRow | undefined {
    const rows = Array.from(
      this.sql.exec(SELECT_RUN_SQL, runId),
    ) as unknown as RunRegistryRow[];
    return rows[0];
  }

  // ------------------------------------------------------------------
  // Resolve: "what is this id" — registry first.
  // ------------------------------------------------------------------

  resolveId(id: string): ResolveIdResult {
    if (id === "") return { found: false, id };
    let parsed: ReturnType<typeof parseId> | null = null;
    try {
      parsed = parseId(id);
    } catch {
      parsed = null;
    }
    if (parsed !== null) {
      if (parsed.type === "run") {
        const row = this.getRun(id);
        return row
          ? { found: true, kind: "run", runId: id, row }
          : { found: false, id };
      }
      if (parsed.runBody !== null) {
        const runId = `run:${parsed.runBody}`;
        const row = this.getRun(runId);
        return row
          ? { found: true, kind: "derived", runId, row }
          : { found: false, id };
      }
      // A canonical id of another kind (pay / goal / chain / …)
      // is not a run and never resolves through the registry.
      return { found: false, id };
    }
    // Not canonical: it can only resolve as a legacy alias.
    const mapped = this.findAlias(id);
    if (!mapped) return { found: false, id };
    const row = this.getRun(mapped.run_id);
    if (!row) return { found: false, id };
    return { found: true, kind: "alias", runId: mapped.run_id, alias: id, row };
  }

  private findAlias(alias: string): RunAliasRow | undefined {
    const rows = Array.from(
      this.sql.exec(SELECT_ALIAS_SQL, alias),
    ) as unknown as RunAliasRow[];
    return rows[0];
  }
}
