/**
 * Issue #2288 (#1976 step 0) — Drizzle D1 adapter for the
 * fleet-registry port (ADR 0002 R1/R2). All SQL-adjacent code
 * for the family lives here, behind the port interface.
 *
 * Every operation is a single statement (atomic on any store);
 * no transaction is used, for the reason recorded in
 * migrationRunner.ts. The registry is a read model: upserts are
 * whole-record replacements keyed by the natural PK.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { asc, eq } from "drizzle-orm";
import {
  agentConformanceCells,
  agentFleetRegistry,
} from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  ConformanceCell,
  ConformanceStatus,
  FleetAgentRecord,
  FleetRegistryStore,
} from "./fleetRegistryPorts";

/** Drizzle D1 database object carrying the registry schema. */
export type FleetRegistryDb = DrizzleD1Database<{
  agentFleetRegistry: typeof agentFleetRegistry;
  agentConformanceCells: typeof agentConformanceCells;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1FleetRegistryDb(d1: D1Database): FleetRegistryDb {
  return createDrizzleD1Db(d1, {
    schema: { agentFleetRegistry, agentConformanceCells },
  });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureFleetRegistrySchema(
  db: FleetRegistryDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

function toAgent(raw: typeof agentFleetRegistry.$inferSelect): FleetAgentRecord {
  return {
    agentKey: raw.agentKey,
    className: raw.className,
    binding: raw.binding,
    instanceScheme: raw.instanceScheme,
    migrationTag: raw.migrationTag,
    operations: JSON.parse(raw.operationsJson) as string[],
    identity: raw.identityJson
      ? (JSON.parse(raw.identityJson) as Record<string, unknown>)
      : null,
    doSchemaVersion: raw.doSchemaVersion,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toCell(
  raw: typeof agentConformanceCells.$inferSelect,
): ConformanceCell {
  return {
    agentKey: raw.agentKey,
    dimension: raw.dimension,
    status: raw.status as ConformanceStatus,
    reference: raw.reference,
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Fleet registry + conformance matrix over D1 via Drizzle. */
export class D1FleetRegistryAdapter implements FleetRegistryStore {
  constructor(readonly db: FleetRegistryDb) {}

  async upsertAgent(record: FleetAgentRecord): Promise<void> {
    const values = {
      agentKey: record.agentKey,
      className: record.className,
      binding: record.binding,
      instanceScheme: record.instanceScheme,
      migrationTag: record.migrationTag,
      operationsJson: JSON.stringify(record.operations),
      identityJson: record.identity ? JSON.stringify(record.identity) : null,
      doSchemaVersion: record.doSchemaVersion,
      updatedAtMs: record.updatedAtMs,
    };
    await this.db
      .insert(agentFleetRegistry)
      .values(values)
      .onConflictDoUpdate({
        target: agentFleetRegistry.agentKey,
        set: values,
      });
  }

  async getAgent(agentKey: string): Promise<FleetAgentRecord | null> {
    const rows = await this.db
      .select()
      .from(agentFleetRegistry)
      .where(eq(agentFleetRegistry.agentKey, agentKey));
    return rows.length === 0 ? null : toAgent(rows[0]);
  }

  async listAgents(): Promise<FleetAgentRecord[]> {
    const rows = await this.db
      .select()
      .from(agentFleetRegistry)
      .orderBy(asc(agentFleetRegistry.agentKey));
    return rows.map(toAgent);
  }

  async upsertCell(cell: ConformanceCell): Promise<void> {
    const values = {
      agentKey: cell.agentKey,
      dimension: cell.dimension,
      status: cell.status,
      reference: cell.reference,
      updatedAtMs: cell.updatedAtMs,
    };
    await this.db
      .insert(agentConformanceCells)
      .values(values)
      .onConflictDoUpdate({
        target: [
          agentConformanceCells.agentKey,
          agentConformanceCells.dimension,
        ],
        set: values,
      });
  }

  async listCells(agentKey: string): Promise<ConformanceCell[]> {
    const rows = await this.db
      .select()
      .from(agentConformanceCells)
      .where(eq(agentConformanceCells.agentKey, agentKey))
      .orderBy(asc(agentConformanceCells.dimension));
    return rows.map(toCell);
  }

  async listMatrix(): Promise<ConformanceCell[]> {
    const rows = await this.db
      .select()
      .from(agentConformanceCells)
      .orderBy(
        asc(agentConformanceCells.agentKey),
        asc(agentConformanceCells.dimension),
      );
    return rows.map(toCell);
  }
}
