/**
 * Issue #5175 slice 2 — the in-memory implementation of the run
 * registry ports, with semantics identical to the DO-SQLite
 * adapter: record-once (first write wins), alias adoption with
 * first-mapping-wins conflicts, canonical ids never aliases,
 * and registry-first resolution. NEW with this port — the
 * registry had no in-memory twin before.
 */
import { parseId } from "../services/executionTreeIds";
import type {
  RecordRunInput,
  RecordRunResult,
  ResolveIdResult,
  RunRegistryRecordPort,
  RunRegistryResolvePort,
  RunRegistryRow,
} from "./runRegistryPorts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryRunRegistryStore
  implements RunRegistryRecordPort, RunRegistryResolvePort
{
  private runs = new Map<string, RunRegistryRow>();
  private aliases = new Map<string, { alias: string; run_id: string; created_at: string }>();

  ensureSchema(): void {
    // In-memory: nothing to ensure.
  }

  recordRun(input: RecordRunInput): RecordRunResult {
    const parsed = parseId(input.runId);
    if (parsed.type !== "run") {
      throw new Error(
        `run registry (#5175): runId must be a canonical run id, got "${input.runId}"`,
      );
    }
    const now = input.nowIso ?? new Date().toISOString();
    const aliasesRecorded: string[] = [];
    const aliasConflicts: RecordRunResult["aliasConflicts"] = [];

    let recorded = false;
    if (!this.runs.has(input.runId)) {
      this.runs.set(input.runId, {
        run_id: input.runId,
        family: input.family ?? null,
        job_kind: input.jobKind ?? null,
        trigger: input.trigger ?? null,
        created_at: now,
      });
      recorded = true;
    }

    for (const alias of new Set(input.aliases ?? [])) {
      if (alias === input.runId) continue;
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
      const mapped = this.aliases.get(alias);
      if (mapped) {
        if (mapped.run_id !== input.runId) {
          aliasConflicts.push({
            alias,
            existingRunId: mapped.run_id,
            reason: "mapped-elsewhere",
          });
        }
        continue;
      }
      this.aliases.set(alias, {
        alias,
        run_id: input.runId,
        created_at: now,
      });
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
    const row = this.runs.get(runId);
    return row ? clone(row) : undefined;
  }

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
      return { found: false, id };
    }
    const mapped = this.aliases.get(id);
    if (!mapped) return { found: false, id };
    const row = this.getRun(mapped.run_id);
    if (!row) return { found: false, id };
    return { found: true, kind: "alias", runId: mapped.run_id, alias: id, row };
  }
}
