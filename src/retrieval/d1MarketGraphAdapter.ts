/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — Drizzle D1 adapter for the
 * market graph ports (R1/R2). This module is the ONLY place
 * retrieval graph code touches a store client: all query-builder
 * code lives here, behind the port interfaces.
 *
 * Transactions: every operation is one statement per row (one
 * upsert, one SELECT batch), which is atomic on any store — the
 * same reasoning as the slice-0/1 adapters. Cross-store
 * consistency is the R5 story (idempotent writes), not a
 * distributed transaction. Timestamps are adapter-internal
 * (the port rows carry no timestamps): inserts stamp both,
 * conflict updates refresh updated_at_ms only.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "../data/d1QueryLogger";
import { and, eq, inArray } from "drizzle-orm";
import {
  agentMarketEdges,
  agentMarketNodes,
} from "../data/drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "../data/migrationRunner";
import type {
  GraphContextRow,
  MarketEdge,
  MarketGraphStore,
  MarketNode,
  MarketRelation,
} from "./retrievalPorts";

/** Drizzle D1 database object carrying the market graph schema. */
export type MarketGraphDb = DrizzleD1Database<{
  agentMarketNodes: typeof agentMarketNodes;
  agentMarketEdges: typeof agentMarketEdges;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1MarketGraphDb(d1: D1Database): MarketGraphDb {
  return createDrizzleD1Db(d1, {
    schema: { agentMarketNodes, agentMarketEdges },
  });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureMarketGraphSchema(
  db: MarketGraphDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

export class D1MarketGraphAdapter implements MarketGraphStore {
  constructor(readonly db: MarketGraphDb) {}

  async upsertNodes(nodes: MarketNode[]): Promise<void> {
    const nowMs = Date.now();
    for (const node of nodes) {
      await this.db
        .insert(agentMarketNodes)
        .values({
          tenantId: node.tenantId,
          nodeType: node.nodeType,
          nodeKey: node.nodeKey,
          label: node.label,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .onConflictDoUpdate({
          target: [
            agentMarketNodes.tenantId,
            agentMarketNodes.nodeType,
            agentMarketNodes.nodeKey,
          ],
          set: { label: node.label, updatedAtMs: nowMs },
        });
    }
  }

  async upsertEdges(edges: MarketEdge[]): Promise<void> {
    const nowMs = Date.now();
    for (const edge of edges) {
      await this.db
        .insert(agentMarketEdges)
        .values({
          tenantId: edge.tenantId,
          fromType: edge.fromType,
          fromKey: edge.fromKey,
          relation: edge.relation,
          toType: edge.toType,
          toKey: edge.toKey,
          weight: edge.weight,
          provenance: edge.provenance,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .onConflictDoUpdate({
          target: [
            agentMarketEdges.tenantId,
            agentMarketEdges.fromType,
            agentMarketEdges.fromKey,
            agentMarketEdges.relation,
            agentMarketEdges.toType,
            agentMarketEdges.toKey,
          ],
          set: {
            weight: edge.weight,
            provenance: edge.provenance,
            updatedAtMs: nowMs,
          },
        });
    }
  }

  async adjacent(
    tenantId: string,
    seedKeys: string[],
    opts?: { relations?: MarketRelation[]; limit?: number },
  ): Promise<GraphContextRow[]> {
    if (seedKeys.length === 0) return [];
    const edgeConditions = [
      eq(agentMarketEdges.tenantId, tenantId),
      inArray(agentMarketEdges.fromKey, seedKeys),
    ];
    if (opts?.relations) {
      edgeConditions.push(inArray(agentMarketEdges.relation, opts.relations));
    }
    const edges = await this.db
      .select()
      .from(agentMarketEdges)
      .where(and(...edgeConditions));
    if (edges.length === 0) return [];
    const toKeys = [...new Set(edges.map((e) => e.toKey))];
    const nodes = await this.db
      .select()
      .from(agentMarketNodes)
      .where(
        and(
          eq(agentMarketNodes.tenantId, tenantId),
          inArray(agentMarketNodes.nodeKey, toKeys),
        ),
      );
    const byTypeKey = new Map(
      nodes.map((n) => [`${n.nodeType}:${n.nodeKey}`, n]),
    );
    const rows: GraphContextRow[] = [];
    for (const edge of edges) {
      const node = byTypeKey.get(`${edge.toType}:${edge.toKey}`);
      if (!node) continue;
      rows.push({
        node: {
          tenantId: node.tenantId,
          nodeType: node.nodeType as MarketNode["nodeType"],
          nodeKey: node.nodeKey,
          label: node.label,
        },
        viaRelation: edge.relation as MarketRelation,
        viaSeedKey: edge.fromKey,
        weight: edge.weight,
      });
    }
    return opts?.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  }

  async resolveSymbols(
    tenantId: string,
    candidates: string[],
  ): Promise<string[]> {
    if (candidates.length === 0) return [];
    const rows = await this.db
      .select({ nodeKey: agentMarketNodes.nodeKey })
      .from(agentMarketNodes)
      .where(
        and(
          eq(agentMarketNodes.tenantId, tenantId),
          eq(agentMarketNodes.nodeType, "symbol"),
          inArray(agentMarketNodes.nodeKey, candidates),
        ),
      );
    const known = new Set(rows.map((r) => r.nodeKey));
    return candidates.filter((c) => known.has(c));
  }
}
