/**
 * Issue #2945 — in-memory channel draft store (test double with the
 * same port semantics as the D1 adapter). It is NOT a production
 * store: it exists so the channel contract is testable without any
 * store at all.
 */
import type { ChannelDraft, ChannelDraftStore } from "./cfpayChannelPorts";

export class InMemoryChannelDraftAdapter implements ChannelDraftStore {
  private readonly rows = new Map<string, ChannelDraft>();

  async createDraft(draft: ChannelDraft): Promise<ChannelDraft> {
    this.rows.set(draft.id, { ...draft });
    return { ...draft };
  }

  async getDraft(id: string): Promise<ChannelDraft | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async markFulfilled(
    id: string,
    update: { fulfilledAtMs: number; paymentIntentId: string | null; fulfilSkippedReason: string | null },
  ): Promise<ChannelDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown channel draft ${id}.`);
    const next: ChannelDraft = { ...row, status: "fulfilled", ...update };
    this.rows.set(id, next);
    return { ...next };
  }

  async listFulfilled(): Promise<ChannelDraft[]> {
    return [...this.rows.values()].filter((d) => d.status === "fulfilled").map((d) => ({ ...d }));
  }

  async listByUser(userLogin: string): Promise<ChannelDraft[]> {
    return [...this.rows.values()].filter((d) => d.userLogin === userLogin).map((d) => ({ ...d }));
  }
}
