/**
 * Issue #5965 — picker options read the whole-set vocabulary (#5515).
 *
 * Every surface used to carry its own list of what a job may select. The
 * scheduled run forms are the smallest honest slice: they offered `TECH` as a
 * *universe* (a sector, per #5515) and hardcoded the seven screener ids in each
 * file. Options now come from the one reader, so a value added to
 * `config/vocabulary.json` appears here with no component change and a value
 * that is not a universe cannot be offered.
 *
 * Client-safe by construction: `src/config/vocabulary.ts` imports only the JSON
 * and types (no env, no DOM, no node APIs), which is why a client picker and a
 * Worker handler can share it.
 */
import { universeValues, type VocabularyEntry } from "../config/vocabulary";

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
 * A picker must not silently blank a stored value the registry no longer
 * offers (a schedule saved with `TECH`, before #5515): keep it visible as a
 * legacy row so the operator sees what the schedule holds and can change it.
 */
export function withLegacyValue(options: AxisOption[], current: string | undefined): AxisOption[] {
  const value = current?.trim();
  if (!value || options.some((o) => o.value === value)) return options;
  return [...options, { value, label: `${value} (legacy)`, legacy: true }];
}
