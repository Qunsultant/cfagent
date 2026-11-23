/**
 * #6151 S3 — in-memory saved-preset store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any store
 * at all, and so route tests can run without a D1 binding. No
 * migration concept applies here (there is no SQL to migrate).
 */
import { BusinessError } from "../outcomes/outcomeAspects";
import {
  assertPresetName,
  newNavPresetId,
  normalizePresetMap,
  type NavPresetRecord,
  type NavPresetStateRecord,
  type NavPresetStore,
} from "./navPresetPorts";

export class InMemoryNavPresetAdapter implements NavPresetStore {
  private presets = new Map<string, NavPresetRecord>();
  private states = new Map<string, NavPresetStateRecord>();

  async ensureSchema(): Promise<void> {
    // No SQL to migrate in memory.
  }

  async listPresets(userId: string): Promise<NavPresetRecord[]> {
    return [...this.presets.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => ({ ...p, map: { ...p.map } }));
  }

  async getPreset(userId: string, id: string): Promise<NavPresetRecord | null> {
    const preset = this.presets.get(id);
    if (!preset || preset.userId !== userId) return null;
    return { ...preset, map: { ...preset.map } };
  }

  async createPreset(
    userId: string,
    name: string,
    map: Record<string, boolean>,
  ): Promise<NavPresetRecord> {
    const cleanName = assertPresetName(name);
    const normalized = normalizePresetMap(map);
    for (const preset of this.presets.values()) {
      if (preset.userId === userId && preset.name === cleanName) {
        throw new BusinessError("FAILURE_NAV_PRESET_CONFLICT");
      }
    }
    const now = Date.now();
    const record: NavPresetRecord = {
      id: newNavPresetId(),
      userId,
      name: cleanName,
      map: normalized,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.presets.set(record.id, record);
    return { ...record, map: { ...record.map } };
  }

  async renamePreset(userId: string, id: string, name: string): Promise<NavPresetRecord> {
    const cleanName = assertPresetName(name);
    const existing = this.presets.get(id);
    if (!existing || existing.userId !== userId) {
      throw new BusinessError("FAILURE_NAV_PRESET_NOT_FOUND");
    }
    if (existing.name !== cleanName) {
      for (const preset of this.presets.values()) {
        if (preset.userId === userId && preset.name === cleanName) {
          throw new BusinessError("FAILURE_NAV_PRESET_CONFLICT");
        }
      }
    }
    const updated: NavPresetRecord = {
      ...existing,
      name: cleanName,
      updatedAtMs: Date.now(),
    };
    this.presets.set(id, updated);
    return { ...updated, map: { ...updated.map } };
  }

  async deletePreset(userId: string, id: string): Promise<boolean> {
    const existing = this.presets.get(id);
    if (!existing || existing.userId !== userId) return false;
    this.presets.delete(id);
    // Deleting the ACTIVE preset does not yank the user's current
    // tabs: the selection keeps the deleted preset's map as a
    // custom selection (activePresetId cleared).
    const state = this.states.get(userId);
    if (state && state.activePresetId === id) {
      await this.setState(userId, {
        activePresetId: null,
        map: existing.map,
      });
    }
    return true;
  }

  async getState(userId: string): Promise<NavPresetStateRecord | null> {
    const state = this.states.get(userId);
    if (!state) return null;
    return {
      ...state,
      map: state.map === null ? null : { ...state.map },
    };
  }

  async setState(
    userId: string,
    state: { activePresetId: string | null; map: Record<string, boolean> | null },
  ): Promise<NavPresetStateRecord> {
    const record: NavPresetStateRecord = {
      userId,
      activePresetId: state.activePresetId,
      map: state.map === null ? null : normalizePresetMap(state.map),
      updatedAtMs: Date.now(),
    };
    this.states.set(userId, record);
    return {
      ...record,
      map: record.map === null ? null : { ...record.map },
    };
  }
}
