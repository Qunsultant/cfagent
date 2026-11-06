/**
 * Issue #3422 — the in-memory implementations of the Stock
 * Copilot surface ports (test doubles). Semantics mirror the DO
 * adapters: activity lists newest first (append order breaks
 * same-timestamp ties) and prunes to the retention bound per
 * login; control is one record per login, upserted.
 */
import {
  COPILOT_ACTIVITY_RETENTION,
  COPILOT_LEARNINGS_RETENTION,
  type CopilotControlRecord,
  type CopilotCycleActivityRecord,
  type CopilotLearningRecord,
  type StockCopilotActivityPort,
  type StockCopilotControlPort,
  type StockCopilotMemoryPort,
} from "./stockCopilotStorePorts";

interface StoredActivity {
  record: CopilotCycleActivityRecord;
  seq: number;
}

export class InMemoryStockCopilotActivityStore
  implements StockCopilotActivityPort
{
  private readonly rows: StoredActivity[] = [];
  private seq = 0;

  ensureSchema(): void {}

  appendActivity(record: CopilotCycleActivityRecord): void {
    this.rows.push({
      record: {
        ...record,
        entries: [...record.entries],
        exits: record.exits.map((e) => ({ ...e })),
        mode: record.mode,
        criticVerdict: record.criticVerdict ? { ...record.criticVerdict } : null,
      },
      seq: this.seq++,
    });
    // Prune this login's records to the retention bound, newest kept.
    const mine = this.rows
      .filter((s) => s.record.userLogin === record.userLogin)
      .sort((a, b) =>
        a.record.cycleAt === b.record.cycleAt
          ? b.seq - a.seq
          : a.record.cycleAt < b.record.cycleAt
            ? 1
            : -1,
      );
    const keep = new Set(mine.slice(0, COPILOT_ACTIVITY_RETENTION).map((s) => s.seq));
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].record.userLogin === record.userLogin && !keep.has(this.rows[i].seq)) {
        this.rows.splice(i, 1);
      }
    }
  }

  listActivity(
    userLogin: string,
    limit: number,
  ): CopilotCycleActivityRecord[] {
    return this.rows
      .filter((s) => s.record.userLogin === userLogin)
      .sort((a, b) =>
        a.record.cycleAt === b.record.cycleAt
          ? b.seq - a.seq
          : a.record.cycleAt < b.record.cycleAt
            ? 1
            : -1,
      )
      .slice(0, Math.max(0, limit))
      .map((s) => ({
        ...s.record,
        entries: [...s.record.entries],
        exits: s.record.exits.map((e) => ({ ...e })),
      }));
  }
}

export class InMemoryStockCopilotControlStore
  implements StockCopilotControlPort
{
  private readonly rows = new Map<string, CopilotControlRecord>();

  ensureSchema(): void {}

  getControl(userLogin: string): CopilotControlRecord | null {
    const record = this.rows.get(userLogin);
    return record ? { ...record } : null;
  }

  setControl(record: CopilotControlRecord): void {
    this.rows.set(record.userLogin, { ...record });
  }
}

// ---------------------------------------------------------------------------
// Issue #3519 — In-Memory Learning Memory Store (Test Double)
// ---------------------------------------------------------------------------

export class InMemoryStockCopilotMemoryStore implements StockCopilotMemoryPort {
  private readonly rows: CopilotLearningRecord[] = [];

  ensureSchema(): void {}

  recordLearning(learning: CopilotLearningRecord): void {
    this.rows.unshift({ ...learning });
    if (this.rows.length > COPILOT_LEARNINGS_RETENTION * 2) {
      this.rows.splice(COPILOT_LEARNINGS_RETENTION * 2);
    }
  }

  listLearnings(
    userLogin: string,
    limit = COPILOT_LEARNINGS_RETENTION,
  ): CopilotLearningRecord[] {
    return this.rows
      .filter((r) => r.userLogin === userLogin)
      .slice(0, Math.max(0, limit))
      .map((r) => ({ ...r }));
  }
}
