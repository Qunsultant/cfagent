/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the discovery-run port, with semantics identical to the
 * DO-SQLite adapter. Moved into the data layer from
 * src/trading/options/discoveryRunStore.ts (now a shim).
 */
import {
  DISCOVERY_RUN_MAX_ROWS,
  DISCOVERY_RUN_RETENTION_DAYS,
  discoveryRunVisibleToCaller,
  type DiscoveryRunInput,
  type DiscoveryRunBroker,
  normalizeDiscoveryRunBroker,
  type DiscoveryRunStore,
  type DiscoveryRunStoreOptions,
  type DiscoveryRunSummary,
  type DiscoverySymbolOutcome,
  type StoredDiscoveryRun,
} from "./discoveryRunPorts";

function summarize(input: DiscoveryRunInput, id: string): DiscoveryRunSummary {
  // An outcome counts as an abstention either by status (the
  // profile-derived model, where no request ever ran) or by the
  // abstained flag on a completed outcome (the no-view model, where
  // the chain loaded and the gates rejected everything). Abstentions
  // never count as completions or failures. Neither marker exists on
  // saved-request outcomes, so their counts are unchanged.
  const isAbstention = (o: DiscoverySymbolOutcome) => o.status === "abstained" || o.abstained === true;
  const completedCount = input.outcomes.filter((o) => o.status === "completed" && !isAbstention(o)).length;
  const abstainedCount = input.outcomes.filter(isAbstention).length;
  return {
    id,
    createdAt: input.createdAt,
    // Issue #3388: provenance lives in the summary, exactly as the SQL adapter
    // stamps it, so both implementations answer the same reads.
    broker: normalizeDiscoveryRunBroker(input.broker),
    // Issue #3655: mode provenance rides the same summary.
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    // Issue #3655 (effective mode): the resolver source rides the summary with the mode.
    ...(input.modeSource !== undefined ? { modeSource: input.modeSource } : {}),
    ...(input.userLogin !== undefined ? { userLogin: input.userLogin } : {}),
    trigger: input.trigger,
    ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    inputModel: input.inputModel,
    ...(input.profileRef !== undefined ? { profileRef: input.profileRef } : {}),
    status: input.status,
    requestCount:
      input.inputModel === "no-view" ? (input.constraintSets?.length ?? 0) : input.requests.length,
    completedCount,
    failedCount: input.outcomes.length - completedCount - abstainedCount,
    abstainedCount,
    // Every attempted symbol, in order: the outcomes are the attempt
    // record (for saved runs their symbols are the requests' own,
    // normalized identically by the service).
    symbols:
      input.outcomes.length > 0
        ? input.outcomes.map((o) => o.symbol)
        : input.requests.map((r) => r.symbol.toUpperCase().trim()),
  };
}

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/** Newest-first ordering shared by both stores: createdAt descending,
 *  id descending on ties (matches the SQL ORDER BY exactly). */
function byNewestFirst(a: DiscoveryRunSummary, b: DiscoveryRunSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export class InMemoryDiscoveryRunStore implements DiscoveryRunStore {
  private runs: StoredDiscoveryRun[] = [];
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(options: DiscoveryRunStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_RUN_MAX_ROWS;
  }

  async save(input: DiscoveryRunInput): Promise<StoredDiscoveryRun> {
    const run: StoredDiscoveryRun = {
      ...summarize(input, this.idFactory()),
      requests: input.requests,
      ...(input.constraintSets !== undefined ? { constraintSets: input.constraintSets } : {}),
      outcomes: input.outcomes,
    };
    this.runs.push(run);
    await this.prune(new Date(input.createdAt));
    return run;
  }

  async list(options: { limit?: number; offset?: number; userLogin?: string; broker?: DiscoveryRunBroker } = {}): Promise<DiscoveryRunSummary[]> {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    return [...this.runs]
      .filter((r) => discoveryRunVisibleToCaller(r, options.userLogin))
      .filter((r) => !options.broker || normalizeDiscoveryRunBroker(r.broker) === options.broker)
      .sort(byNewestFirst)
      .slice(offset, offset + limit)
      .map(({ requests: _requests, outcomes: _outcomes, ...summary }) => summary);
  }

  async get(id: string, options: { userLogin?: string; broker?: DiscoveryRunBroker } = {}): Promise<StoredDiscoveryRun | null> {
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !discoveryRunVisibleToCaller(run, options.userLogin)) return null;
    if (options.broker && normalizeDiscoveryRunBroker(run.broker) !== options.broker) return null;
    return run;
  }

  async prune(now: Date): Promise<number> {
    const cutoff = retentionCutoff(now, this.retentionDays);
    const kept = [...this.runs]
      .sort(byNewestFirst)
      .filter((r) => r.createdAt >= cutoff)
      .slice(0, this.maxRows);
    const deleted = this.runs.length - kept.length;
    this.runs = kept;
    return deleted;
  }
}
