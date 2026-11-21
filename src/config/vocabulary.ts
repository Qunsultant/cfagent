/**
 * Issue #5515 — the whole set a job may select, as one validated reader.
 *
 * The engine had no single vocabulary for what a job can select: provider,
 * broker, universe, sector, exchange, asset and dataset values lived in
 * separate closed enums and free strings, with conflations — `nasdaq` was
 * both a data-provider id and the universe-list source, `TECH` was a
 * screener "universe" but is a sector, and a job could not declare an
 * arbitrary subset of anything.
 *
 * `config/vocabulary.json` is now the one list per axis, and this module is
 * its one reader. Follows the #5880 precedent (`src/config/jobCatalogue.ts`):
 * the list lives in config, this module validates it on every read, and a new
 * value is one entry — no engine code change. The override seam
 * (`setVocabulary`) exists so a test can prove a data-only addition reaches
 * every consumer; an invalid definition throws and the previous values stay.
 *
 * Two rules the JSON encodes and this module enforces:
 *
 *   - Sectors are the single home for the sector axis AND for the
 *     sector-as-list universes: `universeValues()` derives one `sector-*`
 *     universe per sector, so a sector cannot exist in one list and be
 *     missing in the other.
 *   - Conflations are declared data. A value that used to be accepted on the
 *     wrong axis (`TECH` as a universe, `nasdaq` as a universe) is refused by
 *     name with a pointer to the axis it belongs to — never silently resolved.
 *
 * Environment-free: JSON, types and pure functions only, so a client picker
 * and a Worker handler read the same registry.
 */
import raw from "../../config/vocabulary.json";

/** The axes a job spec may declare. */
export const AXES = [
  "provider",
  "dataset",
  "universe",
  "sector",
  "exchange",
  "broker",
  "asset",
  "mode",
] as const;
export type Axis = (typeof AXES)[number];

/** Axes whose value may be omitted, resolving to `defaults` in the JSON. */
export const DEFAULTED_AXES = ["broker", "mode", "asset", "universe"] as const;
export type DefaultedAxis = (typeof DEFAULTED_AXES)[number];

export interface VocabularyEntry {
  id: string;
  label: string;
  kind?: string;
  aliases?: string[];
  modes?: string[];
}

export interface VocabularyPointer {
  axis: Axis;
  value: string;
}

export interface Conflation {
  axis: Axis;
  value: string;
  pointer?: VocabularyPointer;
  message: string;
}

export interface Vocabulary {
  version: number;
  defaults: Partial<Record<DefaultedAxis, string>>;
  axes: Record<Axis, VocabularyEntry[]>;
  conflations: Conflation[];
}

/** Refusal codes. The message always names the axis and the value. */
export const VOCABULARY_CODES = {
  unknownAxis: "REFUSAL_VOCABULARY_UNKNOWN_AXIS",
  unknownValue: "REFUSAL_VOCABULARY_UNKNOWN_VALUE",
  notAValue: "REFUSAL_VOCABULARY_NOT_A_VALUE",
  unsupportedPair: "REFUSAL_VOCABULARY_UNSUPPORTED_PAIR",
  missingDefault: "REFUSAL_VOCABULARY_MISSING_DEFAULT",
} as const;
export type VocabularyCode = (typeof VOCABULARY_CODES)[keyof typeof VOCABULARY_CODES];

export type Resolved<T> = { ok: true; value: T } | { ok: false; code: VocabularyCode; message: string };

const SOURCE = raw as unknown as Vocabulary;

/** Canonical key for lookup: ids and aliases are case-insensitive. */
function canon(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Validate a vocabulary definition. Throws on anything that would make two
 * sources of truth: a duplicate id, an alias that collides with another
 * id/alias, an unknown axis, a default naming a value that does not exist, or
 * a conflation that shadows a real value.
 */
export function validateVocabulary(candidate: Vocabulary): Vocabulary {
  const axes = candidate?.axes;
  if (!axes || typeof axes !== "object") {
    throw new Error("[vocabulary] axes missing — the registry must declare every axis");
  }
  for (const axis of AXES) {
    const entries = axes[axis];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`[vocabulary] axis "${axis}" is empty — every axis is a registry, never a gap`);
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry?.id || typeof entry.id !== "string") {
        throw new Error(`[vocabulary] axis "${axis}" has an entry without an id`);
      }
      const id = canon(entry.id);
      // Ids keep their existing spelling (`optionsChains`, `nasdaq100`): the
      // registry must resolve today's strings identically (#5515 req. 4).
      // Lookup is case-insensitive through aliases and canon(), so a picker
      // can render `NASDAQ100` for the id `nasdaq100`.
      if (seen.has(id)) {
        throw new Error(`[vocabulary] axis "${axis}" declares "${id}" twice — one value, one entry`);
      }
      seen.add(id);
      for (const alias of entry.aliases ?? []) {
        const a = canon(alias);
        if (a === id) continue;
        if (seen.has(a)) {
          throw new Error(`[vocabulary] axis "${axis}" alias "${alias}" collides with another value`);
        }
        seen.add(a);
      }
    }
  }
  // Cross-axis shares are legitimate (the exchange NASDAQ and the provider
  // nasdaq are different axes); what is not allowed is a value that claims to
  // be two values on the SAME axis, which the per-axis check above rejects.
  const defaults = candidate.defaults ?? {};
  for (const axis of DEFAULTED_AXES) {
    const value = defaults[axis];
    if (!value) throw new Error(`[vocabulary] default for "${axis}" is missing`);
    if (!axes[axis].some((e) => canon(e.id) === canon(value))) {
      throw new Error(`[vocabulary] default "${axis}=${value}" names a value the registry does not hold`);
    }
  }
  const conflicts = candidate.conflations ?? [];
  for (const c of conflicts) {
    if (!axes[c.axis].some((e) => canon(e.id) === canon(c.value))) continue;
    throw new Error(
      `[vocabulary] conflation "${c.axis}=${c.value}" shadows a real value — a conflation names a value that is NOT on that axis`,
    );
  }
  return { version: candidate.version ?? 1, defaults, axes, conflations: conflicts };
}

let current: Vocabulary = validateVocabulary(SOURCE);

/** The validated registry. Never mutate the returned object. */
export function getVocabulary(): Vocabulary {
  return current;
}

/**
 * Override the registry (tests prove a data-only addition; an operator
 * override would land here). Validates before replacing: an invalid
 * definition throws and the previous values stay in force.
 */
export function setVocabulary(next: Vocabulary | null): void {
  current = next === null ? validateVocabulary(SOURCE) : validateVocabulary(next);
}

/** Every id on an axis, canonical and in registry order. */
export function axisIds(axis: Axis): string[] {
  return getVocabulary().axes[axis].map((e) => e.id);
}

/** Every entry on an axis, labelled for a picker. */
export function axisEntries(axis: Axis): VocabularyEntry[] {
  return getVocabulary().axes[axis].map((e) => ({ ...e, aliases: [...(e.aliases ?? [])] }));
}

/**
 * The universe axis, including the sector-as-list universes derived from the
 * sector axis (one source: a sector is declared once and appears in both).
 */
export function universeValues(): VocabularyEntry[] {
  const vocab = getVocabulary();
  const sectors = vocab.axes.sector.map<VocabularyEntry>((s) => ({
    id: s.id,
    label: `${s.label} (sector list)`,
    kind: "sector-list",
    aliases: [],
  }));
  return [...vocab.axes.universe.map((e) => ({ ...e })), ...sectors];
}

/** The declared defaults, as canonical ids. */
export function vocabularyDefaults(): Record<DefaultedAxis, string> {
  const d = getVocabulary().defaults;
  return {
    broker: d.broker as string,
    mode: d.mode as string,
    asset: d.asset as string,
    universe: d.universe as string,
  };
}

function findConflation(axis: Axis, value: string): Conflation | undefined {
  return getVocabulary().conflations.find((c) => c.axis === axis && canon(c.value) === canon(value));
}

function findEntry(axis: Axis, value: string): VocabularyEntry | undefined {
  const wanted = canon(value);
  return getVocabulary().axes[axis].find(
    (e) => canon(e.id) === wanted || (e.aliases ?? []).some((a) => canon(a) === wanted),
  );
}

/**
 * Resolve one declared value: an id or an alias resolves to the canonical id;
 * a declared conflation refuses with its own message and pointer; anything
 * else refuses by name.
 */
export function resolveValue(axis: Axis, value: string): Resolved<string> {
  if (!(AXES as readonly string[]).includes(axis)) {
    return {
      ok: false,
      code: VOCABULARY_CODES.unknownAxis,
      message: `"${axis}" is not a vocabulary axis (#5515). Axes: ${AXES.join(", ")}.`,
    };
  }
  const conflation = findConflation(axis, value);
  if (conflation) {
    const pointer = conflation.pointer ? ` (${conflation.pointer.axis}=${conflation.pointer.value})` : "";
    return {
      ok: false,
      code: VOCABULARY_CODES.notAValue,
      message: `${conflation.message}${pointer}`,
    };
  }
  const entry = findEntry(axis, value);
  if (entry) return { ok: true, value: entry.id };
  return {
    ok: false,
    code: VOCABULARY_CODES.unknownValue,
    message: `"${value}" is not a ${axis} (#5515). Known ${axis} values: ${axisIds(axis).join(", ")}.`,
  };
}

/**
 * Resolve a job's declared subset.
 *
 * - A declared axis resolves through `resolveValue` (alias in, canonical out).
 * - An absent axis that has an externalized default resolves to that default.
 * - An absent axis with no default refuses by name — nothing is invented.
 * - A broker/mode/asset/mode combination the registry does not support refuses
 *   as a pair (e.g. a broker that does not offer paper).
 */
export function resolveJobSubset(
  declared: Partial<Record<Axis, string>>,
): Resolved<Record<Axis, string | undefined>> {
  const resolved: Partial<Record<Axis, string>> = {};
  // Declared values first: a bad declaration is the error worth naming, even
  // when another axis is also missing a default.
  for (const axis of AXES) {
    const declaredValue = declared[axis];
    if (declaredValue === undefined || declaredValue === null || `${declaredValue}`.trim() === "") continue;
    const one = resolveValue(axis, `${declaredValue}`);
    if (!one.ok) return one;
    resolved[axis] = one.value;
  }
  for (const axis of AXES) {
    if (resolved[axis] !== undefined) continue;
    const defaults = getVocabulary().defaults as Partial<Record<Axis, string>>;
    const fallback = defaults[axis];
    if (fallback !== undefined) resolved[axis] = fallback;
    // Otherwise the axis stays undeclared: a subset names what it needs, and an
    // axis it does not name is a consumer's decision, never an invented value.
  }
  const broker = resolved.broker as string | undefined;
  const mode = resolved.mode as string | undefined;
  if (broker && mode) {
    const entry = getVocabulary().axes.broker.find((b) => b.id === broker);
    if (entry && entry.modes && entry.modes.length > 0 && !entry.modes.includes(mode)) {
      return {
        ok: false,
        code: VOCABULARY_CODES.unsupportedPair,
        message: `broker ${broker} has no ${mode} mode (#5515). Supported: ${entry.modes.join(", ")}.`,
      };
    }
  }
  return { ok: true, value: { ...resolved } as Record<Axis, string | undefined> };
}

/**
 * A consumer that needs an axis says so: an undeclared axis with no default
 * refuses by name instead of resolving to a guess.
 */
export function requireAxis(
  resolved: Record<Axis, string | undefined>,
  axis: Axis,
): Resolved<string> {
  const value = resolved[axis];
  if (value !== undefined) return { ok: true, value };
  return {
    ok: false,
    code: VOCABULARY_CODES.missingDefault,
    message: `No ${axis} declared and no externalized default exists (#5515). Declare ${axis}; nothing is invented.`,
  };
}
