/**
 * #6151 S3 — saved nav presets, server-side (part 1).
 *
 * A saved preset is a NAMED visibility map owned by one user. The
 * 8 built-in presets stay computed from the nav config by section
 * (src/client/navPresets.ts) — they are the base, never hand-listed
 * here; a saved preset is a user's own selection, stored
 * server-side so it survives browsers and reloads.
 *
 * Two tables (migration 0085): `agent_nav_presets` (one row per
 * saved preset) and `agent_nav_preset_state` (one row per user: the
 * CURRENT selection — the active saved preset id, or a custom map
 * from manual toggles). The state row is what makes the selection
 * survive a reload: the nav-availability endpoint reads it as its
 * base (a saved preset overrides the persona default, per the S1
 * plan) and gates it by subscription exactly like the persona
 * default. A saved preset never resurrects a tab the caller's
 * subscription gating removes — filtering happens at READ time
 * (the endpoint gates the stored map on every call), so a later
 * unsubscribe hides the tab without any re-apply.
 *
 * The stored map is normalized over enumerateNavAvailabilityIds():
 * unknown ids are dropped (they name no menu — the S2 rule), a
 * sub-item key follows its parent unless the map names it
 * explicitly, and missing ids read false. The map is stored full
 * and displayed as-is (visibility booleans are not sensitive).
 *
 * Port idiom: same as SubscriptionStore (ADR 0002) — the port
 * interface here, a D1 adapter (d1NavPresetAdapter) and an
 * in-memory adapter (inMemoryNavPresetAdapter) behind it, composed
 * by createNavPresetPorts. No new store type, no second context.
 */
import { BusinessError } from "../outcomes/outcomeAspects";
import { enumerateNavAvailabilityIds } from "../client/navConfig";

/** One saved preset row. */
export interface NavPresetRecord {
  id: string;
  userId: string;
  name: string;
  /** Normalized over enumerateNavAvailabilityIds() (sub-item keys included). */
  map: Record<string, boolean>;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One user's current selection: the active saved preset, or a custom map. */
export interface NavPresetStateRecord {
  userId: string;
  /** The active saved preset id, or null for a custom selection. */
  activePresetId: string | null;
  /** The current map (the active preset's map, or the custom map). Null only when no selection was ever stored. */
  map: Record<string, boolean> | null;
  updatedAtMs: number;
}

export interface NavPresetStore {
  listPresets(userId: string): Promise<NavPresetRecord[]>;
  getPreset(userId: string, id: string): Promise<NavPresetRecord | null>;
  createPreset(
    userId: string,
    name: string,
    map: Record<string, boolean>,
  ): Promise<NavPresetRecord>;
  renamePreset(userId: string, id: string, name: string): Promise<NavPresetRecord>;
  deletePreset(userId: string, id: string): Promise<boolean>;
  getState(userId: string): Promise<NavPresetStateRecord | null>;
  setState(
    userId: string,
    state: { activePresetId: string | null; map: Record<string, boolean> | null },
  ): Promise<NavPresetStateRecord>;
  /** Idempotent schema-ensure (D1 applies migration 0085; in-memory is a no-op). */
  ensureSchema(): Promise<void>;
}

/** Preset names are operator-visible labels: 1–80 chars after trimming. */
export const NAV_PRESET_NAME_MAX_LENGTH = 80;

/** Validate a preset name (trimmed, non-empty, within the length cap). */
export function assertPresetName(name: unknown): string {
  if (typeof name !== "string") {
    throw new BusinessError("FAILURE_NAV_PRESET_NAME_INVALID");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAV_PRESET_NAME_MAX_LENGTH) {
    throw new BusinessError("FAILURE_NAV_PRESET_NAME_INVALID");
  }
  return trimmed;
}

/** Server-assigned preset id (never client-supplied — same idiom as plan ids). */
export function newNavPresetId(): string {
  return `preset-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Normalize an untrusted map over the availability ids. Unknown ids
 * are dropped (they name no menu); a sub-item key follows its parent
 * unless the input names it explicitly; missing ids read false.
 * Non-boolean values read false — the map is strict booleans only.
 * Pure — the S3 test pins the expansion through this function.
 */
export function normalizePresetMap(input: unknown): Record<string, boolean> {
  const raw =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const out: Record<string, boolean> = {};
  for (const id of enumerateNavAvailabilityIds()) {
    if (id.includes(":")) {
      const parent = id.slice(0, id.indexOf(":"));
      out[id] = raw[id] === true || (raw[id] === undefined && raw[parent] === true);
    } else {
      out[id] = raw[id] === true;
    }
  }
  return out;
}

/** A request body is a map candidate iff it is a non-array object. */
export function isPresetMapInput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
