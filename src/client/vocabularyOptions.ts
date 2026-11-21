/**
 * Issue #5965 — picker options read the whole-set vocabulary (#5515).
 *
 * Every surface used to carry its own list of what a job may select: the
 * scheduled-run forms offered `TECH` as a *universe* (a sector, per #5515) and
 * hardcoded the seven screener ids in each file; the tenant settings panel took
 * the data provider as free text. Options now come from the one reader, so a
 * value added to `config/vocabulary.json` appears here with no component change
 * and a value that is not on the axis cannot be offered.
 *
 * Client-safe by construction: `src/config/vocabulary.ts` imports only the JSON
 * and types (no env, no DOM, no node APIs), which is why a client picker and a
 * Worker handler can share it.
 */
import { axisEntries, universeValues, type Axis, type VocabularyEntry } from "../config/vocabulary";

export interface AxisOption {
  /** What the surface submits — the spelling the API already accepts. */
  value: string;
  label: string;
  /** True for a stored value no longer offered by the registry. */
  legacy?: boolean;
}

/**
 * The submitted spelling for a universe entry.
 *
 * The screener paths submit the historical upper-case ids (`NASDAQ100`), and
 * the registry carries that spelling as the entry's alias. A stored index list
 * has no upper-case history, so it submits the canonical id (`dow`). Keeping
 * the spelling the API already accepts means this slice changes *which values
 * are offered*, never how a chosen value travels.
 */
function submittedValue(entry: VocabularyEntry): string {
  const alias = (entry.aliases ?? []).find((a) => a === a.toUpperCase());
  return alias ?? entry.id;
}

/**
 * Universe options for a picker.
 *
 * `screener` is the stock/options screen family — the screener sets only, which
 * is why `TECH` is absent (it is a sector: `sector-information-technology`) and
 * why the stored index lists (`dow`, `sp400`) are not offered where the
 * criteria schema does not accept them. `index` is the stored-list family: one
 * option per index, plus the sector lists, which the refresh service serves.
 */
export function universeOptions(kind: "screener" | "index"): AxisOption[] {
  const entries = universeValues();
  const picked =
    kind === "screener"
      ? entries.filter((e) => e.kind === "screener")
      : entries.filter((e) => e.kind === "index" || e.kind === "sector-list");
  return picked.map((e) => ({
    // The stored-list family submits its canonical id (`dow`); the screener
    // family keeps the historical upper-case spelling the criteria schema and
    // the routes have always accepted (`NASDAQ100`).
    value: kind === "index" ? e.id : submittedValue(e),
    label: e.label,
  }));
}

/**
 * Options for a plain axis: one entry per registry value, with the registry's
 * label. `current` is the value the surface holds — when the registry no longer
 * offers it, it stays visible as a legacy row (never silently blanked).
 */
export function axisOptions(axis: Axis, current?: string): AxisOption[] {
  return withLegacyValue(
    axisEntries(axis).map((entry) => ({ value: entry.id, label: entry.label })),
    current,
  );
}

/**
 * The data-provider axis (#5993): what a tenant's jobs may read from.
 *
 * The option value is the canonical id the tenant settings PATCH already
 * accepts, so making the field a picker changes *which values are offered*,
 * never how a chosen value travels.
 */
export function providerOptions(current?: string): AxisOption[] {
  return axisOptions("provider", current);
}

/**
 * The broker axis — which brokers a job may select.
 *
 * Not the same question as `src/client/brokerOptions.ts`: that module answers
 * "which brokers does this platform hold credentials for" (catalog order,
 * credential kind, icon) for the Settings connection surface. This one answers
 * "which brokers may a job select" — the #5515 axis, its labels, and the modes
 * each entry declares. A surface that selects a broker for a run reads this; a
 * surface that connects one reads the catalog.
 */
export function brokerOptions(current?: string): AxisOption[] {
  return axisOptions("broker", current);
}

/**
 * A picker must not silently blank a stored value the registry no longer
 * offers (a schedule saved with `TECH`, before #5515): keep it visible as a
 * legacy row so the operator sees what the schedule holds and can change it.
 */
export function withLegacyValue(options: AxisOption[], current: string | undefined): AxisOption[] {
  const value = current?.trim();
  if (!value || options.some((o) => o.value === value)) return options;
  return [...options, { value, label: `${value} (legacy)`, legacy: true }];
}
