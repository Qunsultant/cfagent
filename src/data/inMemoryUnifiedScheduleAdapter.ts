/**
 * Issue #3121 Phase 2 (#3123, reuse) — the in-memory implementation
 * of the unified schedule port, with semantics identical to the
 * DO-SQLite adapter (upsert by id, list created_at ascending,
 * clearPaused deletes paused rows only).
 */
import type {
  ScheduleStore,
  UnifiedScheduleKind,
  UnifiedScheduleRecord,
  UnifiedScheduleState,
} from "./unifiedSchedulePorts";

function byCreatedAt(a: UnifiedScheduleRecord, b: UnifiedScheduleRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class InMemoryUnifiedScheduleStore implements ScheduleStore {
  private records = new Map<string, UnifiedScheduleRecord>();

  async save(record: UnifiedScheduleRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async get(id: string): Promise<UnifiedScheduleRecord | undefined> {
    const found = this.records.get(id);
    return found ? { ...found } : undefined;
  }

  async list(): Promise<UnifiedScheduleRecord[]> {
    return [...this.records.values()].sort(byCreatedAt).map((r) => ({ ...r }));
  }

  async listByKind(kind: UnifiedScheduleKind): Promise<UnifiedScheduleRecord[]> {
    return (await this.list()).filter((r) => r.kind === kind);
  }

  async listByState(state: UnifiedScheduleState): Promise<UnifiedScheduleRecord[]> {
    return (await this.list()).filter((r) => r.state === state);
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  async clearPaused(): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.state === "paused") {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
