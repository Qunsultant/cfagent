/**
 * Issue #3246 (sub-issue of #3241), slice 3 — in-memory runs-pack
 * stores.
 *
 * Test doubles with the same port semantics as the D1 adapters.
 * They are NOT production stores and NOT a second source of truth
 * — they exist so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate). Single-threaded JS makes each method body atomic, so
 * the conditional transitions read as check-then-set; the D1
 * adapters express the same transitions as single conditional
 * statements.
 */
import {
  assertRunsPackDraftStatus,
  assertRunsPackLogin,
  assertRunsPackRail,
  assertRunsPackRuns,
  assertRunsPackVersionInput,
  RunsPackClaimRefusedError,
  type RunsPackBalancePort,
  type RunsPackConsumption,
  type RunsPackDraft,
  type RunsPackDraftStore,
  type RunsPackVersion,
  type RunsPackVersionStore,
} from "./runsPackPorts";
import { assertApproverId } from "./subscriptionPorts";

export class InMemoryRunsPackVersionAdapter implements RunsPackVersionStore {
  private rows = new Map<string, RunsPackVersion>();

  async listVersions(productId: string, segment?: string): Promise<RunsPackVersion[]> {
    const rows = [...this.rows.values()].filter(
      (v) => v.productId === productId && (segment === undefined || v.segment === segment),
    );
    rows.sort(
      (a, b) =>
        a.effectiveFromMs - b.effectiveFromMs || a.version - b.version || (a.id < b.id ? -1 : 1),
    );
    return rows.map((v) => ({ ...v }));
  }

  async getVersion(id: string): Promise<RunsPackVersion | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async createVersion(input: {
    productId: unknown;
    segment?: unknown;
    runs: unknown;
    priceUSD: unknown;
    effectiveFromMs?: unknown;
    effectiveToMs?: unknown;
  }): Promise<RunsPackVersion> {
    const now = Date.now();
    const versioned = assertRunsPackVersionInput(input, now);
    const id = `packver-${crypto.randomUUID().slice(0, 8)}`;
    const siblings = await this.listVersions(versioned.productId, versioned.segment);
    const version = siblings.reduce((max, s) => Math.max(max, s.version), 0) + 1;
    const record: RunsPackVersion = {
      id,
      productId: versioned.productId,
      version,
      segment: versioned.segment,
      runs: versioned.runs,
      priceUSD: versioned.priceUSD,
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
      active: true,
      effectiveFromMs: versioned.effectiveFromMs,
      effectiveToMs: versioned.effectiveToMs,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.rows.set(id, { ...record });
    return { ...record };
  }

  async approveVersion(id: string, approverId: string): Promise<RunsPackVersion> {
    const approver = assertApproverId(approverId);
    const row = this.rows.get(id);
    if (!row) throw new Error(`No runs-pack version ${id}.`);
    const now = Date.now();
    const next: RunsPackVersion = {
      ...row,
      approvalStatus: "approved",
      approvedBy: approver,
      approvedAtMs: now,
      updatedAtMs: now,
    };
    this.rows.set(id, { ...next });
    return { ...next };
  }

  async deactivateVersion(id: string): Promise<RunsPackVersion> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`No runs-pack version ${id}.`);
    const next: RunsPackVersion = { ...row, active: false, updatedAtMs: Date.now() };
    this.rows.set(id, { ...next });
    return { ...next };
  }
}

export class InMemoryRunsPackBalanceAdapter implements RunsPackBalancePort {
  private rows = new Map<string, number>();

  async getBalance(login: string): Promise<number> {
    return this.rows.get(assertRunsPackLogin(login)) ?? 0;
  }

  async addPackRuns(login: string, runs: number): Promise<number> {
    const validatedLogin = assertRunsPackLogin(login);
    const validatedRuns = assertRunsPackRuns(runs);
    const next = (this.rows.get(validatedLogin) ?? 0) + validatedRuns;
    this.rows.set(validatedLogin, next);
    return next;
  }

  async consumePackRun(input: { login: string }): Promise<RunsPackConsumption> {
    const login = assertRunsPackLogin(input.login);
    const balance = this.rows.get(login) ?? 0;
    if (balance <= 0) return { allowed: false, remaining: balance };
    const remaining = balance - 1;
    this.rows.set(login, remaining);
    return { allowed: true, remaining };
  }
}

export class InMemoryRunsPackDraftAdapter implements RunsPackDraftStore {
  private rows = new Map<string, RunsPackDraft>();

  async createDraft(draft: RunsPackDraft): Promise<RunsPackDraft> {
    const validated: RunsPackDraft = {
      ...draft,
      rail: assertRunsPackRail(draft.rail),
      status: assertRunsPackDraftStatus(draft.status),
    };
    this.rows.set(validated.id, { ...validated });
    return { ...validated };
  }

  async getDraft(id: string): Promise<RunsPackDraft | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async claimForCredit(id: string): Promise<RunsPackDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown runs-pack draft ${id}.`);
    if (row.status !== "minted") throw new RunsPackClaimRefusedError(id, row.status, "claim");
    const next: RunsPackDraft = { ...row, status: "crediting" };
    this.rows.set(id, next);
    return { ...next };
  }

  async releaseClaim(id: string): Promise<RunsPackDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown runs-pack draft ${id}.`);
    if (row.status !== "crediting") throw new RunsPackClaimRefusedError(id, row.status, "release");
    const next: RunsPackDraft = { ...row, status: "minted" };
    this.rows.set(id, next);
    return { ...next };
  }

  async markCredited(
    id: string,
    update: { creditedAtMs: number; paymentIntentId: string | null; checkoutSessionId: string | null },
  ): Promise<RunsPackDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown runs-pack draft ${id}.`);
    if (row.status === "credited") throw new Error(`Runs pack ${id} is already credited.`);
    if (row.status !== "crediting") throw new Error(`Runs pack ${id} is not crediting.`);
    const next: RunsPackDraft = { ...row, status: "credited", ...update };
    this.rows.set(id, next);
    return { ...next };
  }

  async listByUser(userLogin: string): Promise<RunsPackDraft[]> {
    return [...this.rows.values()]
      .filter((d) => d.userLogin === userLogin)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((d) => ({ ...d }));
  }
}
