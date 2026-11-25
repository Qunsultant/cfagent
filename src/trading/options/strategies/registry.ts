import type { StrategyDefinition } from "./types";
import { catalogIdsForResearchStructure } from "../../../shared/optionsStrategyVocabulary";

export function normalizeStrategyName(name: string): string {
  return name.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "");
}

/** Registry: strategies plug in by id and alias; nothing in the engine hard-codes a strategy list. */
export class StrategyRegistry {
  private readonly byId = new Map<string, StrategyDefinition>();
  private readonly byName = new Map<string, string[]>();

  register(def: StrategyDefinition): this {
    if (this.byId.has(def.id)) throw new Error(`Strategy ${def.id} is already registered`);
    this.byId.set(def.id, def);
    this.alias(def.id, def.id);
    this.alias(def.label, def.id);
    for (const name of def.aliases) this.alias(name, def.id);
    return this;
  }

  /** Maps a free-form name to one or more strategy ids (generic names such as "Vertical Spread" map to several). */
  alias(name: string, ...ids: string[]): this {
    const key = normalizeStrategyName(name);
    const existing = this.byName.get(key) ?? [];
    this.byName.set(key, Array.from(new Set([...existing, ...ids])));
    return this;
  }

  get(id: string): StrategyDefinition | undefined {
    return this.byId.get(id);
  }

  list(): StrategyDefinition[] {
    return Array.from(this.byId.values());
  }

  ids(): string[] {
    return Array.from(this.byId.keys());
  }

  resolve(name: string): string[] {
    const registered = this.byName.get(normalizeStrategyName(name));
    if (registered && registered.length > 0) return registered;
    // Issue #6507: OODA structure names resolve through the one shared
    // vocabulary, so a research name and its screen id never diverge.
    return catalogIdsForResearchStructure(name);
  }

  /** Resolves names/ids, expanding "all"; unknown names are returned separately. */
  resolveMany(names: readonly string[]): { ids: string[]; unknown: string[] } {
    const ids = new Set<string>();
    const unknown: string[] = [];
    for (const name of names) {
      if (normalizeStrategyName(name) === "all") {
        this.ids().forEach((id) => ids.add(id));
        continue;
      }
      const resolved = this.resolve(name);
      if (resolved.length === 0) unknown.push(name);
      resolved.forEach((id) => ids.add(id));
    }
    return { ids: Array.from(ids), unknown };
  }
}
