/**
 * Issue #3289 (sub-issue of #3241) — in-memory product store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any store
 * at all, and so route tests can run without a D1 binding. No
 * migration concept applies here (there is no SQL to migrate);
 * the migration's seed products are NOT pre-loaded — tests that
 * need them create them, so a test can also build a store with
 * no products at all.
 */
import {
  assertBulkMoveStatus,
  assertProduct,
  assertSegment,
  type BulkMoveRecord,
  type ProductKind,
  type ProductRecord,
  type ProductStore,
  type VersionMoveRecord,
} from "./productPorts";

export class InMemoryProductAdapter implements ProductStore {
  private products = new Map<string, ProductRecord>();
  private moves: VersionMoveRecord[] = [];
  private bulkMoves = new Map<string, BulkMoveRecord>();

  async createProduct(input: {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    description?: unknown;
  }): Promise<ProductRecord> {
    const product = assertProduct(input);
    const id = product.id || `prod-${crypto.randomUUID().slice(0, 8)}`;
    if (this.products.has(id)) throw new Error(`Product ${id} already exists.`);
    const now = Date.now();
    const record: ProductRecord = { ...product, id, createdAtMs: now, updatedAtMs: now };
    this.products.set(id, record);
    return record;
  }

  async getProduct(productId: string): Promise<ProductRecord | null> {
    return this.products.get(productId) ?? null;
  }

  async findProductByName(name: string, kind: ProductKind): Promise<ProductRecord | null> {
    for (const p of this.products.values()) {
      if (p.name === name && p.kind === kind) return p;
    }
    return null;
  }

  async getOrCreateProduct(input: {
    name?: unknown;
    kind?: unknown;
    description?: unknown;
  }): Promise<ProductRecord> {
    const product = assertProduct(input);
    const existing = await this.findProductByName(product.name, product.kind);
    if (existing) return existing;
    return this.createProduct(input);
  }

  async listProducts(): Promise<ProductRecord[]> {
    return [...this.products.values()].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  async recordMove(move: {
    id?: string;
    bulkMoveId?: string | null;
    userId: string;
    productId?: string | null;
    fromVersionId?: string | null;
    toVersionId?: string | null;
    segment: string;
    movedBy: string;
    reason?: string | null;
    movedAtMs?: number;
  }): Promise<VersionMoveRecord> {
    if (!move.userId) throw new Error("Version move requires userId.");
    if (!move.movedBy) throw new Error("Version move requires movedBy.");
    const segment = assertSegment(move.segment);
    // The (bulkMoveId, userId) unique index, mirrored: a retry
    // never moves the same customer twice in one bulk move.
    if (move.bulkMoveId) {
      const dup = this.moves.find((m) => m.bulkMoveId === move.bulkMoveId && m.userId === move.userId);
      if (dup) return dup;
    }
    const record: VersionMoveRecord = {
      id:
        typeof move.id === "string" && move.id.trim()
          ? move.id.trim()
          : `move-${crypto.randomUUID().slice(0, 8)}`,
      bulkMoveId: move.bulkMoveId ?? null,
      userId: move.userId,
      productId: move.productId ?? null,
      fromVersionId: move.fromVersionId ?? null,
      toVersionId: move.toVersionId ?? null,
      segment,
      movedBy: move.movedBy,
      reason: move.reason ?? null,
      movedAtMs: move.movedAtMs ?? Date.now(),
    };
    this.moves.push(record);
    return record;
  }

  async listMovesForProduct(productId: string): Promise<VersionMoveRecord[]> {
    return this.moves
      .filter((m) => m.productId === productId)
      .sort((a, b) => a.movedAtMs - b.movedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async listMovesForUser(userId: string): Promise<VersionMoveRecord[]> {
    return this.moves
      .filter((m) => m.userId === userId)
      .sort((a, b) => a.movedAtMs - b.movedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async createBulkMove(input: {
    id?: string;
    productId: unknown;
    segmentScope?: string | null;
    targetVersionIdsJson: unknown;
    movedBy: unknown;
    reason?: string | null;
    startedAtMs?: number;
  }): Promise<BulkMoveRecord> {
    const productId = typeof input.productId === "string" && input.productId.trim() ? input.productId.trim() : "";
    if (!productId) throw new Error("Bulk move requires productId.");
    const movedBy = typeof input.movedBy === "string" && input.movedBy.trim() ? input.movedBy.trim() : "";
    if (!movedBy) throw new Error("Bulk move requires movedBy.");
    if (typeof input.targetVersionIdsJson !== "string") {
      throw new Error("Bulk move requires targetVersionIdsJson.");
    }
    const segmentScope =
      input.segmentScope === undefined || input.segmentScope === null ? null : assertSegment(input.segmentScope);
    const id =
      typeof input.id === "string" && input.id.trim() ? input.id.trim() : `bulk-${crypto.randomUUID().slice(0, 8)}`;
    if (this.bulkMoves.has(id)) throw new Error(`Bulk move ${id} already exists.`);
    const record: BulkMoveRecord = {
      id,
      productId,
      segmentScope,
      targetVersionIdsJson: input.targetVersionIdsJson,
      movedBy,
      reason: input.reason ?? null,
      status: "running",
      movedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      startedAtMs: input.startedAtMs ?? Date.now(),
      finishedAtMs: null,
    };
    this.bulkMoves.set(id, record);
    return record;
  }

  async getBulkMove(bulkMoveId: string): Promise<BulkMoveRecord | null> {
    return this.bulkMoves.get(bulkMoveId) ?? null;
  }

  async updateBulkMove(
    bulkMoveId: string,
    patch: {
      status?: BulkMoveRecord["status"];
      movedCount?: number;
      skippedCount?: number;
      failedCount?: number;
      finishedAtMs?: number | null;
    },
  ): Promise<BulkMoveRecord> {
    const existing = this.bulkMoves.get(bulkMoveId);
    if (!existing) throw new Error(`No bulk move ${bulkMoveId}.`);
    const updated: BulkMoveRecord = {
      ...existing,
      ...(patch.status !== undefined ? { status: assertBulkMoveStatus(patch.status) } : {}),
      ...(patch.movedCount !== undefined ? { movedCount: patch.movedCount } : {}),
      ...(patch.skippedCount !== undefined ? { skippedCount: patch.skippedCount } : {}),
      ...(patch.failedCount !== undefined ? { failedCount: patch.failedCount } : {}),
      ...(patch.finishedAtMs !== undefined ? { finishedAtMs: patch.finishedAtMs } : {}),
    };
    this.bulkMoves.set(bulkMoveId, updated);
    return updated;
  }

  async listBulkMoves(productId: string): Promise<BulkMoveRecord[]> {
    return [...this.bulkMoves.values()]
      .filter((b) => b.productId === productId)
      .sort((a, b) => b.startedAtMs - a.startedAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async listMovesForBulkMove(bulkMoveId: string): Promise<VersionMoveRecord[]> {
    return this.moves
      .filter((m) => m.bulkMoveId === bulkMoveId)
      .sort((a, b) => a.movedAtMs - b.movedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
