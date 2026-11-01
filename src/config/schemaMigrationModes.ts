/**
 * #1767 (parent #1717, slice F-37/F-38): the ONE runtime config
 * switch for the DO SQLite schema-migration framework.
 *
 * SCHEMA_MIGRATION_MODE: "managed" | "legacy" (Worker env var,
 * non-secret, owner-set; this slice sets NO production value —
 * production values are an owner action).
 *
 *  - "managed": a store's ensureSchema applies its declared,
 *    versioned migrations through src/data/doSchemaMigrations.ts
 *    and records each one in the mas_schema_migrations ledger
 *    (marker-LAST: the ledger row is written only after the
 *    migration's statements succeed).
 *  - "legacy": the store's existing inline CREATE TABLE IF NOT
 *    EXISTS path, byte-identical to current behavior.
 *
 * Built-in default is "legacy" (current behavior — unset changes
 * nothing). Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (legacy).
 * Carriers: run = the per-run value on the execution context
 * (set by the execution owner for that run, never by the request
 * caller — the switch governs schema writes, and a caller-supplied
 * run value must never flip their own execution's DDL path);
 * session / user = the optional scopedSchemaMigrationModes carrier
 * on the execution context (populated by the execution-context
 * owner); global env = the Worker env var. A blank/unset level
 * falls through to the next level. The FIRST non-blank level wins;
 * if that value is unrecognized, resolution FAILS CLOSED to
 * legacy (invalid=true, level = the winning level) and does NOT
 * fall through to a lower level. Callers must log + audit
 * schema.config_error on invalid.
 *
 * Pure module: no Cloudflare imports, no I/O, no network — the
 * port is the resolver, and the data layer consumes it
 * (port-first, cloud-native but cloud-agnostic blueprint
 * #1795/#1798). The resolver is a pure function of its levels:
 * no module state, so two runs resolving different modes can
 * never confuse each other through shared mutable state.
 *
 * SECURITY GUARD: this switch governs a schema-write mechanism,
 * not an enforcement gate, but the guard still applies in full —
 * no scoped carrier is ever populated from request input, so no
 * caller can flip their own execution between managed and legacy
 * DDL. IAAA gates are untouched by this switch in every mode.
 *
 * Boundary, stated honestly: in production today only global env
 * is settable — the run/session/user carriers are honored in
 * resolution order and unit-pinned, but no production caller
 * populates them yet (the same boundary as #1721–#1728/#1735).
 * The one production wiring in this slice is the screener's
 * run-lock composition root, which resolves from Worker env.
 */

export type SchemaMigrationMode = "managed" | "legacy";

/** One switch value, as carried at session/user level. */
export interface SchemaMigrationModeValues {
  mode?: unknown;
}

/** Session/user carriers for the schema-migration switch. */
export interface SchemaMigrationScopedModes {
  session?: SchemaMigrationModeValues;
  user?: SchemaMigrationModeValues;
}

/** One level set of the resolution order. Blank/unset falls through. */
export interface SchemaMigrationModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedSchemaMigrationMode {
  mode: SchemaMigrationMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const SCHEMA_MIGRATION_MODE_SWITCH = "SCHEMA_MIGRATION_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function schemaMigrationConfigErrorEvent(): string {
  return "schema.config_error";
}

function normalizeModeValue(raw: unknown): SchemaMigrationMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "managed" || normalized === "legacy") return normalized;
  return "invalid";
}

/**
 * Resolves SCHEMA_MIGRATION_MODE over run > session > user > env >
 * builtin (legacy). First non-blank level wins; an unrecognized
 * winning value fails closed to legacy (invalid=true) without
 * falling through to a lower level.
 */
export function resolveSchemaMigrationMode(
  levels: SchemaMigrationModeScopeLevels,
): ResolvedSchemaMigrationMode {
  const ordered: Array<{
    level: "run" | "session" | "user" | "env";
    raw: unknown;
  }> = [
    { level: "run", raw: levels.run },
    { level: "session", raw: levels.session },
    { level: "user", raw: levels.user },
    { level: "env", raw: levels.env },
  ];
  for (const { level, raw } of ordered) {
    const normalized = normalizeModeValue(raw);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      return {
        mode: "legacy",
        invalid: true,
        raw: typeof raw === "string" ? raw : undefined,
        level,
      };
    }
    return { mode: normalized, invalid: false, level };
  }
  return { mode: "legacy", invalid: false, level: "builtin" };
}

/** Resolve from a Worker-env-like carrier (global-env level only). */
export function resolveSchemaMigrationModeFromEnv(env?: {
  SCHEMA_MIGRATION_MODE?: unknown;
}): ResolvedSchemaMigrationMode {
  return resolveSchemaMigrationMode({ env: env?.SCHEMA_MIGRATION_MODE });
}
