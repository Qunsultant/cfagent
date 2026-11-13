/**
 * Issue #4332 (parent #4329 S3) — the options-run columns the "Latest Autonomous
 * Options Runs" card carried, joined onto the one ledger's rows.
 *
 * The card was the only place two fields were visible: the run's **symbols** and
 * its **actionable setups** (`withTrades`). Moving it must not drop them, but it
 * must not duplicate runs either — the ledger already carries options rows
 * (family `options` through the workflow-runs read, #4069/#4262). So this is a
 * JOIN, not a second row source:
 *
 *   - The card's runs are keyed by their recorded timestamp (normalized to an
 *     ISO instant).
 *   - A ledger row whose start matches a key gains the two fields; a row with no
 *     match renders "—", never a guessed value.
 *
 * Pure: rows and runs in, a lookup out. The panel does the reading.
 */
import type { OptionsRunSummary } from "./scheduledOptionsManager/types";

export interface OptionsRunDetail {
  symbols: string[];
  withTrades: number | null;
  summary: string | null;
  thesis: string | null;
}

function isoKey(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Build the timestamp → detail map the ledger joins on. A duplicate timestamp
 * keeps the first record: the store returns newest first, and a run is one row.
 */
export function optionsRunDetailsByStart(
  runs: readonly OptionsRunSummary[],
): Map<string, OptionsRunDetail> {
  const out = new Map<string, OptionsRunDetail>();
  for (const run of runs) {
    const key = isoKey(run?.timestamp);
    if (!key || out.has(key)) continue;
    const symbols = Array.isArray(run.symbols)
      ? run.symbols.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : [];
    out.set(key, {
      symbols,
      withTrades: typeof run.withTrades === "number" ? run.withTrades : null,
      summary: typeof run.summary === "string" && run.summary.trim() ? run.summary : null,
      thesis: typeof run.thesis === "string" && run.thesis.trim() ? run.thesis : null,
    });
  }
  return out;
}

/** Look one ledger row's start up in the map (null when there is no record). */
export function optionsDetailForStart(
  map: ReadonlyMap<string, OptionsRunDetail>,
  started: string | null | undefined,
): OptionsRunDetail | null {
  const key = isoKey(started);
  if (!key) return null;
  return map.get(key) ?? null;
}
