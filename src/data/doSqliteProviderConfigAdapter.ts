/**
 * Issue #2303 (#1976 step 1) — the DO-SQLite implementation of
 * the provider-configuration port: the #1116 platform's original
 * store (P1, issue #1118), moved into the data layer unchanged.
 *
 * This module IS the implementation that used to live in
 * src/trading/dataProviders/providerConfigStore.ts; that module
 * is now a re-export shim over this one, so every existing
 * import path and every sync call signature is preserved. The
 * sync functions below remain the surface for unbound/test
 * contexts; the class at the bottom exposes the same store
 * behind the async ProviderConfigStore port.
 *
 * One row per provider instance in `mas_data_providers`, plus
 * the capability routing table `mas_data_provider_routes`
 * (screening COMPOSES providers in one run — owner correction,
 * comment 6358714200 on #1116 — so each capability is routed to
 * a primary provider plus an optional DECLARED gap-fill
 * provider; precedence remains the default resolution order
 * where no route is declared).
 *
 * Security invariant: the store holds credential REFERENCES
 * only (e.g. "sessionstore:etrade:token", "env:ALPACA_API_KEY")
 * — the key under which the secret lives in the SessionStore /
 * Worker env, never a secret value. Nothing in this module
 * accepts, stores, or logs a credential value.
 *
 * Lifecycle states (provisioning lifecycle; transitions are
 * driven by lifecycle.ts):
 *
 *   registered → configured → verified → enabled ⇄ disabled
 *     → deprovisioned
 *
 * The registry (registry.ts) resolves a capability ONLY to a
 * provider whose record is in state "enabled" with the enabled
 * flag on; every other state is invisible to resolution, so a
 * half-provisioned provider can never serve data.
 */
import type { SqlStorage } from "../orm";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import type { DataProviderCapability, DataProviderId } from "../trading";
import {
  DEFAULT_CAPABILITY_ROUTES,
  DEFAULT_PROVIDER_SEEDS,
  PROVIDER_CONFIG_TABLE,
  PROVIDER_ROUTING_TABLE,
  mergeCapabilityRouteInput,
  mergeProviderConfigInput,
  type CapabilityRouteInput,
  type CapabilityRouteRecord,
  type ProviderConfigInput,
  type ProviderConfigRecord,
  type ProviderConfigStore,
  type ProviderConfigWrite,
  type ProviderLifecycleState,
} from "./providerConfigPorts";
import { remainderAlterSql } from "./schemaComponent/remainderCatalogue";

export function ensureProviderConfigTable(sql: SqlStorage): void {
  sql.exec(doTableSql("mas_data_providers"));
  sql.exec(
    doIndexSql("idx_mas_data_providers_precedence")
  );
}

function parseConfig(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function recordFromRow(r: any): ProviderConfigRecord {
  return {
    id: r.id,
    adapterKind: r.adapter_kind,
    lifecycleState: r.lifecycle_state,
    enabled: Number(r.enabled) === 1 || r.enabled === true,
    precedence: Number(r.precedence),
    credentialRef: r.credential_ref ?? null,
    config: parseConfig(r.config_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Insert or update the config record for a provider id (§17.3
 * write→read: returns the record as stored). created_at is preserved
 * across updates.
 */
export function upsertProviderConfig(
  sql: SqlStorage,
  input: ProviderConfigInput
): ProviderConfigRecord {
  ensureProviderConfigTable(sql);
  const existing = getProviderConfig(sql, input.id);
  const record = mergeProviderConfigInput(
    input,
    existing,
    new Date().toISOString()
  );
  if (existing) {
    sql.exec(
      `UPDATE ${PROVIDER_CONFIG_TABLE}
       SET adapter_kind = ?, lifecycle_state = ?, enabled = ?, precedence = ?,
           credential_ref = ?, config_json = ?, updated_at = ?
       WHERE id = ?`,
      record.adapterKind,
      record.lifecycleState,
      record.enabled ? 1 : 0,
      record.precedence,
      record.credentialRef,
      JSON.stringify(record.config),
      record.updatedAt,
      record.id
    );
  } else {
    sql.exec(
      `INSERT INTO ${PROVIDER_CONFIG_TABLE}
       (id, adapter_kind, lifecycle_state, enabled, precedence, credential_ref, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.adapterKind,
      record.lifecycleState,
      record.enabled ? 1 : 0,
      record.precedence,
      record.credentialRef,
      JSON.stringify(record.config),
      record.createdAt,
      record.updatedAt
    );
  }
  return getProviderConfig(sql, input.id) ?? record;
}

export function getProviderConfig(
  sql: SqlStorage,
  id: DataProviderId
): ProviderConfigRecord | null {
  ensureProviderConfigTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM ${PROVIDER_CONFIG_TABLE} WHERE id = ?`, id)
  ) as any[];
  return rows.length > 0 ? recordFromRow(rows[0]) : null;
}

/** All provider records in configured precedence order (precedence ASC, id as tiebreak). */
export function listProviderConfigs(sql: SqlStorage): ProviderConfigRecord[] {
  ensureProviderConfigTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${PROVIDER_CONFIG_TABLE} ORDER BY precedence ASC, id ASC`
    )
  ) as any[];
  return rows.map(recordFromRow);
}

export function setProviderLifecycleState(
  sql: SqlStorage,
  id: DataProviderId,
  state: ProviderLifecycleState
): ProviderConfigRecord | null {
  const existing = getProviderConfig(sql, id);
  if (!existing) return null;
  return upsertProviderConfig(sql, {
    ...existing,
    lifecycleState: state,
    config: existing.config,
  });
}

export function setProviderEnabled(
  sql: SqlStorage,
  id: DataProviderId,
  enabled: boolean
): ProviderConfigRecord | null {
  const existing = getProviderConfig(sql, id);
  if (!existing) return null;
  return upsertProviderConfig(sql, {
    ...existing,
    enabled,
    config: existing.config,
  });
}

/**
 * Clear a provider's credential reference (E3, issue #1170). A
 * dedicated UPDATE because upsertProviderConfig treats a null
 * credentialRef as "keep existing" (its merge rule) — deprovision
 * and an explicit configure-to-null need the reference actually
 * gone: a tombstoned or re-provisioning record must not retain a
 * pointer to a secret it no longer owns.
 */
export function clearProviderCredentialRef(
  sql: SqlStorage,
  id: DataProviderId
): ProviderConfigRecord | null {
  const existing = getProviderConfig(sql, id);
  if (!existing) return null;
  sql.exec(
    `UPDATE ${PROVIDER_CONFIG_TABLE} SET credential_ref = NULL, updated_at = ? WHERE id = ?`,
    new Date().toISOString(),
    id
  );
  return getProviderConfig(sql, id);
}

export function ensureProviderRoutingTable(sql: SqlStorage): void {
  sql.exec(doTableSql("mas_data_provider_routes"));
  // Pre-E5 tables lack min_tier: add it in place (the scan-run
  // store's ensure-column idiom). The column DEFAULT backfills
  // existing rows to freemium — the tier they always effectively had.
  const columns = Array.from(
    sql.exec(`PRAGMA table_info(${PROVIDER_ROUTING_TABLE})`)
  ) as any[];
  if (!columns.some((c) => c.name === "min_tier")) {
    sql.exec(remainderAlterSql("mas_data_provider_routes", "min_tier"));
  }
}

function routeFromRow(r: any): CapabilityRouteRecord {
  return {
    capability: r.capability,
    primaryProviderId: r.primary_provider_id,
    gapFillProviderId: r.gap_fill_provider_id ?? null,
    minTier: r.min_tier === "premium" ? "premium" : "freemium",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Insert or replace the route for a capability; returns the record as stored. */
export function upsertCapabilityRoute(
  sql: SqlStorage,
  input: CapabilityRouteInput
): CapabilityRouteRecord {
  ensureProviderRoutingTable(sql);
  const existing = getCapabilityRoute(sql, input.capability);
  const record = mergeCapabilityRouteInput(
    input,
    existing,
    new Date().toISOString()
  );
  if (existing) {
    sql.exec(
      `UPDATE ${PROVIDER_ROUTING_TABLE}
       SET primary_provider_id = ?, gap_fill_provider_id = ?, min_tier = ?, updated_at = ?
       WHERE capability = ?`,
      record.primaryProviderId,
      record.gapFillProviderId,
      record.minTier,
      record.updatedAt,
      record.capability
    );
  } else {
    sql.exec(
      `INSERT INTO ${PROVIDER_ROUTING_TABLE}
       (capability, primary_provider_id, gap_fill_provider_id, min_tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.capability,
      record.primaryProviderId,
      record.gapFillProviderId,
      record.minTier,
      record.createdAt,
      record.updatedAt
    );
  }
  return getCapabilityRoute(sql, input.capability) ?? record;
}

export function getCapabilityRoute(
  sql: SqlStorage,
  capability: DataProviderCapability
): CapabilityRouteRecord | null {
  ensureProviderRoutingTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${PROVIDER_ROUTING_TABLE} WHERE capability = ?`,
      capability
    )
  ) as any[];
  return rows.length > 0 ? routeFromRow(rows[0]) : null;
}

/** All routes, ordered by capability for a deterministic composition view. */
export function listCapabilityRoutes(sql: SqlStorage): CapabilityRouteRecord[] {
  ensureProviderRoutingTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM ${PROVIDER_ROUTING_TABLE} ORDER BY capability ASC`)
  ) as any[];
  return rows.map(routeFromRow);
}

/**
 * Withdraw every routing assignment that names a provider (E3,
 * issue #1170 — the deprovision side effect). Rows where the
 * provider is the PRIMARY are deleted outright (the capability
 * loses its routed assignment and resolution fails explicitly
 * until an operator re-routes it); rows where the provider is
 * only the declared GAP-FILL keep their primary and have the
 * gap-fill slot cleared — withdrawing a supplementary provider
 * must not take down the primary's route. Returns what was done
 * so the lifecycle audit can report it.
 */
export function deleteCapabilityRoutesForProvider(
  sql: SqlStorage,
  providerId: DataProviderId
): { deleted: number; gapFillCleared: number } {
  ensureProviderRoutingTable(sql);
  let deleted = 0;
  let gapFillCleared = 0;
  for (const route of listCapabilityRoutes(sql)) {
    if (route.primaryProviderId === providerId) {
      sql.exec(
        `DELETE FROM ${PROVIDER_ROUTING_TABLE} WHERE capability = ?`,
        route.capability
      );
      deleted++;
    } else if (route.gapFillProviderId === providerId) {
      upsertCapabilityRoute(sql, {
        capability: route.capability,
        primaryProviderId: route.primaryProviderId,
        gapFillProviderId: null,
      });
      gapFillCleared++;
    }
  }
  return { deleted, gapFillCleared };
}

/**
 * Idempotently insert any missing seed records; existing records are
 * left untouched (seeding never resets an operator's lifecycle state).
 * Also seeds the capability routes (seedCapabilityRoutes) so a fresh
 * store carries the full composition. Returns the full config list in
 * precedence order.
 */
export function seedProviderConfigs(sql: SqlStorage): ProviderConfigRecord[] {
  ensureProviderConfigTable(sql);
  for (const seed of DEFAULT_PROVIDER_SEEDS) {
    if (!getProviderConfig(sql, seed.id)) {
      upsertProviderConfig(sql, seed);
    }
  }
  seedCapabilityRoutes(sql);
  return listProviderConfigs(sql);
}

/** Idempotently insert any missing default routes; existing routes are left untouched. */
export function seedCapabilityRoutes(sql: SqlStorage): CapabilityRouteRecord[] {
  ensureProviderRoutingTable(sql);
  for (const route of DEFAULT_CAPABILITY_ROUTES) {
    if (!getCapabilityRoute(sql, route.capability)) {
      upsertCapabilityRoute(sql, route);
    }
  }
  return listCapabilityRoutes(sql);
}

/**
 * Bootstrap this store for platform-routed screening (E2, issue
 * #1157): seed the provider configs + capability routes (idempotent,
 * above) and enable E*TRADE — the one provider whose full lifecycle
 * the #1116 vertical implements first.
 *
 * Enablement here is deliberately narrow: etrade's record is moved
 * to lifecycleState "enabled" with the enabled flag on, via the
 * store's own setters, and ONLY when it is not already in that state
 * — so a second bootstrap writes nothing at all (pinned: the stored
 * records are byte-identical across a repeat call). No other
 * provider's seeded state is touched.
 *
 * Returns the full config list in precedence order, as stored.
 */
export function bootstrapDataProviders(sql: SqlStorage): ProviderConfigRecord[] {
  seedProviderConfigs(sql);
  const etrade = getProviderConfig(sql, "etrade");
  if (etrade && (etrade.lifecycleState !== "enabled" || !etrade.enabled)) {
    if (etrade.lifecycleState !== "enabled") {
      setProviderLifecycleState(sql, "etrade", "enabled");
    }
    if (!etrade.enabled) {
      setProviderEnabled(sql, "etrade", true);
    }
  }
  return listProviderConfigs(sql);
}

/* ------------------------------------------------------------------ */
/* Full-row writes (the write-set seam)                                */
/* ------------------------------------------------------------------ */

function writeProviderRow(sql: SqlStorage, record: ProviderConfigRecord): void {
  if (getProviderConfig(sql, record.id)) {
    sql.exec(
      `UPDATE ${PROVIDER_CONFIG_TABLE}
       SET adapter_kind = ?, lifecycle_state = ?, enabled = ?, precedence = ?,
           credential_ref = ?, config_json = ?, created_at = ?, updated_at = ?
       WHERE id = ?`,
      record.adapterKind,
      record.lifecycleState,
      record.enabled ? 1 : 0,
      record.precedence,
      record.credentialRef,
      JSON.stringify(record.config),
      record.createdAt,
      record.updatedAt,
      record.id
    );
  } else {
    sql.exec(
      `INSERT INTO ${PROVIDER_CONFIG_TABLE}
       (id, adapter_kind, lifecycle_state, enabled, precedence, credential_ref, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.adapterKind,
      record.lifecycleState,
      record.enabled ? 1 : 0,
      record.precedence,
      record.credentialRef,
      JSON.stringify(record.config),
      record.createdAt,
      record.updatedAt
    );
  }
}

function writeRouteRow(sql: SqlStorage, record: CapabilityRouteRecord): void {
  if (getCapabilityRoute(sql, record.capability)) {
    sql.exec(
      `UPDATE ${PROVIDER_ROUTING_TABLE}
       SET primary_provider_id = ?, gap_fill_provider_id = ?, min_tier = ?, created_at = ?, updated_at = ?
       WHERE capability = ?`,
      record.primaryProviderId,
      record.gapFillProviderId,
      record.minTier,
      record.createdAt,
      record.updatedAt,
      record.capability
    );
  } else {
    sql.exec(
      `INSERT INTO ${PROVIDER_ROUTING_TABLE}
       (capability, primary_provider_id, gap_fill_provider_id, min_tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.capability,
      record.primaryProviderId,
      record.gapFillProviderId,
      record.minTier,
      record.createdAt,
      record.updatedAt
    );
  }
}

/** Apply one write set sequentially over the sync store. */
export function applyProviderConfigWrites(
  sql: SqlStorage,
  writes: readonly ProviderConfigWrite[]
): void {
  ensureProviderConfigTable(sql);
  ensureProviderRoutingTable(sql);
  for (const write of writes) {
    if (write.kind === "upsertProvider") writeProviderRow(sql, write.record);
    else if (write.kind === "upsertRoute") writeRouteRow(sql, write.record);
    else {
      sql.exec(
        `DELETE FROM ${PROVIDER_ROUTING_TABLE} WHERE capability = ?`,
        write.capability
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* The async port over the sync store                                  */
/* ------------------------------------------------------------------ */

/**
 * The DO-SQLite store behind the async ProviderConfigStore port.
 * Every method delegates to the sync functions above — the port
 * shape changes, the behaviour does not. applyConfigWrites is
 * sequential on this leg: `transactionSync` lives on the storage
 * object behind the SqlStorage handle and is unreachable from
 * the handle itself (the friction recorded in step 1's audit) —
 * sequential application is exactly today's DO behaviour.
 */
export class DoSqliteProviderConfigAdapter implements ProviderConfigStore {
  constructor(private readonly sql: SqlStorage) {}

  async upsertProviderConfig(input: ProviderConfigInput): Promise<ProviderConfigRecord> {
    return upsertProviderConfig(this.sql, input);
  }
  async getProviderConfig(id: DataProviderId): Promise<ProviderConfigRecord | null> {
    return getProviderConfig(this.sql, id);
  }
  async listProviderConfigs(): Promise<ProviderConfigRecord[]> {
    return listProviderConfigs(this.sql);
  }
  async setProviderLifecycleState(
    id: DataProviderId,
    state: ProviderLifecycleState
  ): Promise<ProviderConfigRecord | null> {
    return setProviderLifecycleState(this.sql, id, state);
  }
  async setProviderEnabled(
    id: DataProviderId,
    enabled: boolean
  ): Promise<ProviderConfigRecord | null> {
    return setProviderEnabled(this.sql, id, enabled);
  }
  async clearProviderCredentialRef(id: DataProviderId): Promise<ProviderConfigRecord | null> {
    return clearProviderCredentialRef(this.sql, id);
  }
  async upsertCapabilityRoute(input: CapabilityRouteInput): Promise<CapabilityRouteRecord> {
    return upsertCapabilityRoute(this.sql, input);
  }
  async getCapabilityRoute(
    capability: DataProviderCapability
  ): Promise<CapabilityRouteRecord | null> {
    return getCapabilityRoute(this.sql, capability);
  }
  async listCapabilityRoutes(): Promise<CapabilityRouteRecord[]> {
    return listCapabilityRoutes(this.sql);
  }
  async deleteCapabilityRoutesForProvider(
    providerId: DataProviderId
  ): Promise<{ deleted: number; gapFillCleared: number }> {
    return deleteCapabilityRoutesForProvider(this.sql, providerId);
  }
  async seedProviderConfigs(): Promise<ProviderConfigRecord[]> {
    return seedProviderConfigs(this.sql);
  }
  async seedCapabilityRoutes(): Promise<CapabilityRouteRecord[]> {
    return seedCapabilityRoutes(this.sql);
  }
  async bootstrapDataProviders(): Promise<ProviderConfigRecord[]> {
    return bootstrapDataProviders(this.sql);
  }
  async applyConfigWrites(writes: readonly ProviderConfigWrite[]): Promise<void> {
    applyProviderConfigWrites(this.sql, writes);
  }
}
