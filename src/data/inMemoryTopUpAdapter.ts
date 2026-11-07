/**
 * Issue #3262 — in-memory top-up draft store (test double with the
 * same port semantics as the D1 adapter). It is NOT a production
 * store: it exists so the draft contract is testable without any
 * store at all.
 */
import { TopUpClaimRefusedError, type TopUpDraft, type TopUpDraftStore } from "./topUpPorts";

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

  /**
   * Claim-before-credit (#3572): the check-and-set below is synchronous
   * (no await between them), so it is atomic in the isolate — exactly
   * one confirmer can move a minted draft to crediting.
   */
  async claimForCredit(id: string): Promise<TopUpDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown top-up draft ${id}.`);
    if (row.status !== "minted") throw new TopUpClaimRefusedError(id, row.status, "claim");
    const next: TopUpDraft = { ...row, status: "crediting" };
    this.rows.set(id, next);
    return { ...next };
  }

  /** Release a claim (crediting → minted); same synchronous mechanism. */
  async releaseClaim(id: string): Promise<TopUpDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown top-up draft ${id}.`);
    if (row.status !== "crediting") throw new TopUpClaimRefusedError(id, row.status, "release");
    const next: TopUpDraft = { ...row, status: "minted" };
    this.rows.set(id, next);
    return { ...next };
  }

  async markCredited(
    id: string,
    update: { creditedAtMs: number; paymentIntentId: string | null; checkoutSessionId: string | null },
  ): Promise<TopUpDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown top-up draft ${id}.`);
    if (row.status === "credited") throw new Error(`Top-up ${id} is already credited.`);
    if (row.status !== "crediting") throw new Error(`Top-up ${id} is not crediting.`);
    const next: TopUpDraft = { ...row, status: "credited", ...update };
    this.rows.set(id, next);
    return { ...next };
  }

  async listByUser(userLogin: string): Promise<TopUpDraft[]> {
    return [...this.rows.values()].filter((d) => d.userLogin === userLogin).map((d) => ({ ...d }));
  }
}
