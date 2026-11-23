/**
 * #6151 S3 — composition root for the saved-preset store port.
 * This is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createNavPresetAdapter` returns null and callers keep their
 * fail direction — the nav-availability read degrades to the
 * persona default (presets are UX narrowing, never an auth gate),
 * while preset mutations fail closed with a 503.
 */
import {
  createD1NavPresetDb,
  D1NavPresetAdapter,
  ensureNavPresetSchema,
  type NavPresetDb,
} from "./d1NavPresetAdapter";
import type { NavPresetStore } from "./navPresetPorts";

/** Build the saved-preset store adapter from Worker env, or null if unbound. */
export function createNavPresetAdapter(env: { AGENT_DB?: unknown }): D1NavPresetAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1NavPresetAdapter(createD1NavPresetDb(env.AGENT_DB as D1Database));
}

export { ensureNavPresetSchema };
export type { NavPresetDb, NavPresetStore };
