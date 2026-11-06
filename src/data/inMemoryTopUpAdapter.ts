/**
 * Issue #3262 — in-memory top-up draft store (test double with the
 * same port semantics as the D1 adapter). It is NOT a production
 * store: it exists so the draft contract is testable without any
 * store at all.
 */
import type { TopUpDraft, TopUpDraftStore } from "./topUpPorts";

export class InMemoryTopUpAdapter implements TopUpDraftStore {
  private readonly rows = new Map<string, TopUpDraft>();

  async createDraft(draft: TopUpDraft): Promise<TopUpDraft> {
    this.rows.set(draft.id, { ...draft });
    return { ...draft };
  }

  async getDraft(id: string): Promise<TopUpDraft | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async markCredited(
    id: string,
    update: { creditedAtMs: number; paymentIntentId: string | null; checkoutSessionId: string | null },
  ): Promise<TopUpDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown top-up draft ${id}.`);
    if (row.status !== "minted") throw new Error(`Top-up ${id} is already credited.`);
    const next: TopUpDraft = { ...row, status: "credited", ...update };
    this.rows.set(id, next);
    return { ...next };
  }

  async listByUser(userLogin: string): Promise<TopUpDraft[]> {
    return [...this.rows.values()].filter((d) => d.userLogin === userLogin).map((d) => ({ ...d }));
  }
}
