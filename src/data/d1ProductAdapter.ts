/**
 * Issue #3289 (sub-issue of #3241) — Drizzle D1 adapter for the
 * product port. This module is the ONLY place product-store code
 * touches a store client: all SQL-adjacent code (the Drizzle
 * query builder) lives here, behind the port interface.
 *
 * Transactions: every operation is a single statement, which is
 * atomic on any store. No multi-statement transaction is used
 * here, for the reason recorded in migrationRunner.ts
 * (drizzle-orm/d1's `db.transaction()` is sequential
 * BEGIN/COMMIT, not Postgres-equivalent atomicity on D1).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, desc, eq } from "drizzle-orm";
import { agentBulkMoves, agentProducts, agentVersionMoves } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0058_PRODUCT_VERSIONS,
  type MigrationDb,
} from "./migrationRunner";
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

/** Drizzle D1 database object carrying the product schema. */
export type ProductDb = DrizzleD1Database<{
  agentProducts: typeof agentProducts;
  agentVersionMoves: typeof agentVersionMoves;
  agentBulkMoves: typeof agentBulkMoves;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProductDb(d1: D1Database): ProductDb {
  return drizzle(d1, {
    schema: {
      agentProducts,
      agentVersionMoves,
      agentBulkMoves,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0058 if
 * unapplied. 0058's backfill reads the plans table and rebuilds
 * the catalogue, and adds columns to the journal and
 * native-ledger tables, so its prerequisites (0007
 * accounts/claims, 0008 plans, 0009 journal, 0011 catalogue,
 * 0012 native ledger, 0027 catalogue approval) ride
 * along — applyMigrations sorts by version, so list order does
 * not matter. The products seed lives in 0058 itself, not here.
 */
export async function ensureProductSchema(db: ProductDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0058_PRODUCT_VERSIONS,
  ]);
}

function toProduct(raw: typeof agentProducts.$inferSelect): ProductRecord {
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind as ProductKind,
    description: raw.description ?? null,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toMove(raw: typeof agentVersionMoves.$inferSelect): VersionMoveRecord {
  return {
    id: raw.id,
    bulkMoveId: raw.bulkMoveId ?? null,
    userId: raw.userId,
    productId: raw.productId ?? null,
    fromVersionId: raw.fromVersionId ?? null,
    toVersionId: raw.toVersionId,
    segment: raw.segment,
    movedBy: raw.movedBy,
    reason: raw.reason ?? null,
    movedAtMs: raw.movedAtMs,
  };
}

function toBulkMove(raw: typeof agentBulkMoves.$inferSelect): BulkMoveRecord {
  return {
    id: raw.id,
    productId: raw.productId,
    segmentScope: raw.segmentScope ?? null,
    targetVersionIdsJson: raw.targetVersionIdsJson,
    movedBy: raw.movedBy,
    reason: raw.reason ?? null,
    status: assertBulkMoveStatus(raw.status),
    movedCount: raw.movedCount,
    skippedCount: raw.skippedCount,
    failedCount: raw.failedCount,
    startedAtMs: raw.startedAtMs,
    finishedAtMs: raw.finishedAtMs ?? null,
  };
}

/** Product store over D1 via Drizzle. */
export class D1ProductAdapter implements ProductStore {
  constructor(readonly db: ProductDb) {}

  async createProduct(input: {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    description?: unknown;
  }): Promise<ProductRecord> {
    const product = assertProduct(input);
    const id = product.id || `prod-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const record: ProductRecord = { ...product, id, createdAtMs: now, updatedAtMs: now };
    try {
      await this.db.insert(agentProducts).values({
        id: record.id,
        name: record.name,
        kind: record.kind,
        description: record.description,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
      });
    } catch {
      const existing = await this.getProduct(id);
      if (existing) throw new Error(`Product ${id} already exists.`);
      throw new Error(`Failed to create product ${id}.`);
    }
    return record;
  }

  async getProduct(productId: string): Promise<ProductRecord | null> {
    const rows = await this.db
      .select()
      .from(agentProducts)
      .where(eq(agentProducts.id, productId))
      .limit(1);
    return rows.length === 0 ? null : toProduct(rows[0]);
  }

  async findProductByName(name: string, kind: ProductKind): Promise<ProductRecord | null> {
    const rows = await this.db
      .select()
      .from(agentProducts)
      .where(eq(agentProducts.name, name))
      .limit(10);
    const match = rows.find((r) => r.kind === kind);
    return match ? toProduct(match) : null;
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
    const rows = await this.db
      .select()
      .from(agentProducts)
      .orderBy(asc(agentProducts.createdAtMs), asc(agentProducts.id));
    return rows.map(toProduct);
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
    // The (bulkMoveId, userId) backstop, mirrored from the
    // in-memory adapter: a retry returns the EXISTING row,
    // never a phantom record whose id was never persisted.
    // The onConflictDoNothing below stays as the race backstop.
    if (move.bulkMoveId) {
      const existing = await this.db
        .select()
        .from(agentVersionMoves)
        .where(and(eq(agentVersionMoves.bulkMoveId, move.bulkMoveId), eq(agentVersionMoves.userId, move.userId)))
        .limit(1);
      if (existing.length > 0) return toMove(existing[0]);
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
    await this.db
      .insert(agentVersionMoves)
      .values({
        id: record.id,
        bulkMoveId: record.bulkMoveId,
        userId: record.userId,
        productId: record.productId,
        fromVersionId: record.fromVersionId,
        toVersionId: record.toVersionId,
        segment: record.segment,
        movedBy: record.movedBy,
        reason: record.reason,
        movedAtMs: record.movedAtMs,
      })
      .onConflictDoNothing();
    return record;
  }

  async listMovesForProduct(productId: string): Promise<VersionMoveRecord[]> {
    const rows = await this.db
      .select()
      .from(agentVersionMoves)
      .where(eq(agentVersionMoves.productId, productId))
      .orderBy(asc(agentVersionMoves.movedAtMs), asc(agentVersionMoves.id));
    return rows.map(toMove);
  }

  async listMovesForUser(userId: string): Promise<VersionMoveRecord[]> {
    const rows = await this.db
      .select()
      .from(agentVersionMoves)
      .where(eq(agentVersionMoves.userId, userId))
      .orderBy(asc(agentVersionMoves.movedAtMs), asc(agentVersionMoves.id));
    return rows.map(toMove);
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
    const record: BulkMoveRecord = {
      id:
        typeof input.id === "string" && input.id.trim()
          ? input.id.trim()
          : `bulk-${crypto.randomUUID().slice(0, 8)}`,
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
    try {
      await this.db.insert(agentBulkMoves).values({
        id: record.id,
        productId: record.productId,
        segmentScope: record.segmentScope,
        targetVersionIdsJson: record.targetVersionIdsJson,
        movedBy: record.movedBy,
        reason: record.reason,
        status: record.status,
        movedCount: record.movedCount,
        skippedCount: record.skippedCount,
        failedCount: record.failedCount,
        startedAtMs: record.startedAtMs,
        finishedAtMs: record.finishedAtMs,
      });
    } catch {
      // Same mapping as createProduct: a failed insert on an
      // existing id is a duplicate, not a raw query error.
      const existing = await this.getBulkMove(record.id);
      if (existing) throw new Error(`Bulk move ${record.id} already exists.`);
      throw new Error(`Failed to create bulk move ${record.id}.`);
    }
    return record;
  }

  async getBulkMove(bulkMoveId: string): Promise<BulkMoveRecord | null> {
    const rows = await this.db
      .select()
      .from(agentBulkMoves)
      .where(eq(agentBulkMoves.id, bulkMoveId))
      .limit(1);
    return rows.length === 0 ? null : toBulkMove(rows[0]);
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
    const set: Partial<typeof agentBulkMoves.$inferInsert> = {};
    if (patch.status !== undefined) set.status = assertBulkMoveStatus(patch.status);
    if (patch.movedCount !== undefined) set.movedCount = patch.movedCount;
    if (patch.skippedCount !== undefined) set.skippedCount = patch.skippedCount;
    if (patch.failedCount !== undefined) set.failedCount = patch.failedCount;
    if (patch.finishedAtMs !== undefined) set.finishedAtMs = patch.finishedAtMs;
    if (Object.keys(set).length > 0) {
      await this.db.update(agentBulkMoves).set(set).where(eq(agentBulkMoves.id, bulkMoveId));
    }
    const updated = await this.getBulkMove(bulkMoveId);
    if (!updated) throw new Error(`No bulk move ${bulkMoveId}.`);
    return updated;
  }

  async listBulkMoves(productId: string): Promise<BulkMoveRecord[]> {
    const rows = await this.db
      .select()
      .from(agentBulkMoves)
      .where(eq(agentBulkMoves.productId, productId))
      .orderBy(desc(agentBulkMoves.startedAtMs), desc(agentBulkMoves.id));
    return rows.map(toBulkMove);
  }

  async listMovesForBulkMove(bulkMoveId: string): Promise<VersionMoveRecord[]> {
    const rows = await this.db
      .select()
      .from(agentVersionMoves)
      .where(eq(agentVersionMoves.bulkMoveId, bulkMoveId))
      .orderBy(asc(agentVersionMoves.movedAtMs), asc(agentVersionMoves.id));
    return rows.map(toMove);
  }
}
