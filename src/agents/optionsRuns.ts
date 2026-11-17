/**
 * Issue #223: persisted autonomous options-analysis runs.
 *
 * `autonomousOptionsAnalysis` already runs on a schedule and publishes to
 * Slack/email/webhook, but its results were only ever visible in the live
 * broadcast. This module keeps the last runs in Durable Object storage so
 * `GET /api/options/latest` can show what the scheduler actually produced.
 *
 * Storage shape mirrors the screener's `screener:last_runs` (#212): newest
 * first, capped at 20 entries, and pruned by writes rather than a cron.
 */

/** DO storage key holding the run history (issue #223). */
import type { JobRunTrigger } from "../data/jobRunRecordPorts";

export const OPTIONS_RUNS_KEY = "options:last_runs";

/** Retained run count; older runs fall off the tail. */
export const OPTIONS_RUNS_LIMIT = 20;

/** One autonomous/manual options-analysis run, JSON-safe for the API. */
export interface OptionsRunRecord {
  timestamp: string;
  success: boolean;
  trigger: JobRunTrigger;
  thesis: string;
  symbols: string[];
  withTrades: number;
  summary: string;
  opportunities: unknown[];
  error?: string;
  /**
   * Issue #2091: the run's artifact keys, stamped by the serve
   * recorder when the artifacts exist. Optional deliberately: rows
   * recorded before #2091 lack them; readers treat absent as null.
   * /api/options/latest returns rows verbatim, so these surface there.
   */
  pdfKey?: string | null;
  xlsxKey?: string | null;
  csvKey?: string | null;
  reportUrl?: string;
}

/** The subset of Durable Object storage this module needs (keeps tests cheap). */
export interface OptionsRunStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

function hasStorage(storage: unknown): storage is OptionsRunStorage {
  const candidate = storage as Partial<OptionsRunStorage> | undefined;
  return Boolean(candidate && typeof candidate.get === "function" && typeof candidate.put === "function");
}

/**
 * Prepend one run and return the retained history. Never throws on storage:
 * a run that already produced market data must not fail because its history
 * could not be written (the caller also guards, this is belt and braces).
 */
export async function recordOptionsRun(
  storage: unknown,
  run: OptionsRunRecord
): Promise<OptionsRunRecord[]> {
  if (!hasStorage(storage)) return [run];
  const existing = (await storage.get<OptionsRunRecord[]>(OPTIONS_RUNS_KEY)) ?? [];
  const next = [run, ...(Array.isArray(existing) ? existing.filter((item) => item.timestamp !== run.timestamp) : [])].slice(0, OPTIONS_RUNS_LIMIT);
  await storage.put(OPTIONS_RUNS_KEY, next);
  return next;
}


/** Read the retained history, newest first. */
export async function readOptionsRuns(storage: unknown): Promise<OptionsRunRecord[]> {
  if (!hasStorage(storage)) return [];
  const runs = await storage.get<OptionsRunRecord[]>(OPTIONS_RUNS_KEY);
  return Array.isArray(runs) ? runs : [];
}
