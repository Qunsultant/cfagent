/**
 * Issue #577 — durable research task ledger (transformation mandate §6;
 * design: docs/agents/agentic-architecture.md §5, §7).
 *
 * One record per delegated research run, owned by the ResearchAgent's
 * Durable Object store, tracking the run independently of conversation
 * history: explicit state transitions, idempotency deduplication,
 * heartbeat, the execution path actually taken (Think vs deterministic
 * fallback), an immutable report reference (runId), and a deterministic
 * outcome evaluation. A failed run ends in `escalated` — visible to a
 * human — instead of vanishing into an error return. Since #2761 the
 * owning agent also recovers at start-up: a fresh incarnation marks
 * every active record interrupted (same failed → escalated
 * disposition, a distinct history note), so an eviction's records are
 * truthful at first touch rather than at the next sweep.
 *
 * SDK-free, following the ResearchConfigService idiom: storage is an
 * injected key/value store, so the agent (DO SQLite) and tests
 * (in-memory) share this exact code. Claiming is safe because the
 * owning DO instance is serialized per tenant: check-and-set inside a
 * DO method is atomic for that tenant's tasks.
 */

export type ResearchTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "escalated"
  | "cancelled";

export type ResearchExecutionPath = "agent" | "fallback";

export interface ResearchTaskTransition {
  status: ResearchTaskStatus;
  at: string;
  note?: string;
}

export interface ResearchTaskEvaluationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ResearchTaskEvaluation {
  /** Deterministic verdict — never a model's self-assessment. */
  verdict: "pass" | "fail";
  evaluatedAt: string;
  checks: ResearchTaskEvaluationCheck[];
}

export interface ResearchTask {
  id: string;
  idempotencyKey: string;
  trigger: "manual" | "scheduled";
  userLogin: string;
  status: ResearchTaskStatus;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  /** Set on completion: which execution path actually produced the report. */
  path?: ResearchExecutionPath;
  /** Set on completion: immutable reference to the published report. */
  reportRunId?: string;
  /** Set on failure/escalation. */
  error?: string;
  /** Set on completion: deterministic outcome evaluation. */
  evaluation?: ResearchTaskEvaluation;
  history: ResearchTaskTransition[];
}

export interface ResearchTaskStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  list(prefix: string): Array<{ key: string; value: string }>;
  delete(key: string): void;
}

export interface ResearchOutcomeFacts {
  reportRunId?: string | null;
  previousRunId?: string | null;
  expectedTrigger: string;
  expectedUserLogin: string;
  reportTrigger?: string | null;
  reportUserLogin?: string | null;
  summary?: string | null;
  ideas?: number | null;
  watchlist?: number | null;
  rejected?: number | null;
}

/** Issue #615 (R4): default staleness threshold — 30 minutes, far
 * above observed research run durations (minutes-scale). */
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

/** Issue #635: retention tiers for terminal task records — 90 days
 * for completed/cancelled, 365 days for failed/escalated (human-review
 * items). Active records are never pruned. */
export const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_ESCALATED_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

const TASK_PREFIX = "task:";
const IDEM_PREFIX = "idem:";
const ACTIVE: ReadonlySet<ResearchTaskStatus> = new Set(["queued", "claimed", "running"]);

/**
 * Deterministic outcome evaluation for a finished research run.
 * Every check is independently verifiable from the report's own
 * fields — this is the slice's evaluator, and it is deliberately not
 * a model call (mandate §9/§14).
 */
export function evaluateResearchOutcome(
  facts: ResearchOutcomeFacts,
  evaluatedAt: string
): ResearchTaskEvaluation {
  const counts = [facts.ideas, facts.watchlist, facts.rejected];
  const checks: ResearchTaskEvaluationCheck[] = [
    {
      name: "report_present",
      ok: typeof facts.reportRunId === "string" && facts.reportRunId.length > 0,
      detail: facts.reportRunId ? `runId ${facts.reportRunId}` : "no report runId",
    },
    {
      name: "run_id_fresh",
      ok:
        typeof facts.reportRunId === "string" &&
        facts.reportRunId.length > 0 &&
        facts.reportRunId !== (facts.previousRunId ?? null),
      detail:
        facts.reportRunId && facts.reportRunId === facts.previousRunId
          ? `runId ${facts.reportRunId} is the previous run's, not a fresh report`
          : "runId differs from the previous run",
    },
    {
      name: "trigger_match",
      ok: facts.reportTrigger === facts.expectedTrigger,
      detail: `report trigger ${facts.reportTrigger ?? "none"} vs expected ${facts.expectedTrigger}`,
    },
    {
      name: "login_match",
      ok: facts.reportUserLogin === facts.expectedUserLogin,
      detail: `report login ${facts.reportUserLogin ?? "none"} vs expected ${facts.expectedUserLogin}`,
    },
    {
      name: "summary_present",
      ok: typeof facts.summary === "string" && facts.summary.trim().length > 0,
      detail: facts.summary ? "summary is non-empty" : "summary missing or empty",
    },
    {
      name: "counts_sane",
      ok: counts.every((c) => typeof c === "number" && Number.isFinite(c) && c >= 0),
      detail: `ideas=${facts.ideas ?? "?"} watchlist=${facts.watchlist ?? "?"} rejected=${facts.rejected ?? "?"}`,
    },
  ];
  return {
    verdict: checks.every((c) => c.ok) ? "pass" : "fail",
    evaluatedAt,
    checks,
  };
}

export class ResearchTaskLedger {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly store: ResearchTaskStore,
    opts?: { now?: () => string; newId?: () => string }
  ) {
    this.now = opts?.now ?? (() => new Date().toISOString());
    this.newId =
      opts?.newId ??
      (() =>
        `task-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);
  }

  /**
   * Create a task, or return the existing *active* task for the same
   * idempotency key (created: false) so duplicate dispatches to
   * produce the successor of the same report share one record.
   */
  create(input: {
    trigger: "manual" | "scheduled";
    userLogin: string;
    idempotencyKey: string;
  }): { task: ResearchTask; created: boolean } {
    const existingId = this.store.get(IDEM_PREFIX + input.idempotencyKey);
    if (existingId) {
      const existing = this.get(existingId);
      if (existing && ACTIVE.has(existing.status)) {
        return { task: existing, created: false };
      }
    }
    const at = this.now();
    const task: ResearchTask = {
      id: this.newId(),
      idempotencyKey: input.idempotencyKey,
      trigger: input.trigger,
      userLogin: input.userLogin,
      status: "queued",
      createdAt: at,
      updatedAt: at,
      heartbeatAt: at,
      history: [{ status: "queued", at }],
    };
    this.save(task);
    this.store.set(IDEM_PREFIX + input.idempotencyKey, task.id);
    return { task, created: true };
  }

  get(id: string): ResearchTask | null {
    const raw = this.store.get(TASK_PREFIX + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ResearchTask;
    } catch {
      return null;
    }
  }

  /** Most recent first. */
  list(limit = 50): ResearchTask[] {
    const out: ResearchTask[] = [];
    for (const { value } of this.store.list(TASK_PREFIX)) {
      try {
        out.push(JSON.parse(value) as ResearchTask);
      } catch {
        // Skip a corrupt record rather than failing the whole listing.
      }
    }
    return out
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  claim(id: string): ResearchTask {
    return this.transition(id, ["queued"], "claimed");
  }

  start(id: string): ResearchTask {
    return this.transition(id, ["claimed"], "running");
  }

  heartbeat(id: string): ResearchTask {
    const task = this.load(id);
    if (task.status !== "claimed" && task.status !== "running") {
      throw new Error(`Research task ${id} cannot heartbeat from status ${task.status}`);
    }
    task.heartbeatAt = this.now();
    task.updatedAt = task.heartbeatAt;
    this.save(task);
    return task;
  }

  complete(
    id: string,
    outcome: {
      path: ResearchExecutionPath;
      reportRunId: string;
      evaluation: ResearchTaskEvaluation;
    }
  ): ResearchTask {
    const task = this.transition(id, ["running"], "completed");
    task.path = outcome.path;
    task.reportRunId = outcome.reportRunId;
    task.evaluation = outcome.evaluation;
    this.save(task);
    return task;
  }

  fail(id: string, error: string): ResearchTask {
    const task = this.transition(id, ["claimed", "running"], "failed", error);
    task.error = error;
    this.save(task);
    return task;
  }

  escalate(id: string, reason: string): ResearchTask {
    const task = this.transition(id, ["failed"], "escalated", reason);
    task.error = task.error ? `${task.error} | escalated: ${reason}` : reason;
    this.save(task);
    return task;
  }

  cancel(id: string): ResearchTask {
    return this.transition(id, ["queued", "claimed"], "cancelled");
  }

  /**
   * Issue #615 (R4): active tasks whose heartbeat is older than
   * staleAfterMs at `at` (default: now). Read-only — a stale verdict
   * is a pure function of stored state; terminal tasks never stale.
   */
  findStale(staleAfterMs: number, at?: string): ResearchTask[] {
    const nowMs = Date.parse(at ?? this.now());
    return this.list(Number.MAX_SAFE_INTEGER).filter(
      (t) => ACTIVE.has(t.status) && nowMs - Date.parse(t.heartbeatAt) > staleAfterMs
    );
  }

  /**
   * Issue #615 (R4): close every stale task as failed → escalated
   * with the stale reason recorded. No auto-rerun: the work may have
   * partially happened, so a human reviews the escalation.
   */
  sweepStale(staleAfterMs: number, at?: string): ResearchTask[] {
    const nowMs = Date.parse(at ?? this.now());
    return this.findStale(staleAfterMs, at).map((t) => {
      const ageMs = nowMs - Date.parse(t.heartbeatAt);
      return this.markStale(
        t.id,
        `stale: no heartbeat for ${ageMs}ms (threshold ${staleAfterMs}ms)`
      );
    });
  }

  /**
   * Issue #635: delete terminal records older than their retention
   * tier (by updatedAt), plus their idempotency entry when it still
   * points at the task. Active records are never pruned — the stale
   * sweep owns those. Returns the pruned task ids.
   */
  pruneExpired(
    opts?: { retentionMs?: number; escalatedRetentionMs?: number },
    at?: string
  ): string[] {
    const retentionMs = opts?.retentionMs ?? DEFAULT_RETENTION_MS;
    const escalatedRetentionMs =
      opts?.escalatedRetentionMs ?? DEFAULT_ESCALATED_RETENTION_MS;
    const nowMs = Date.parse(at ?? this.now());
    const pruned: string[] = [];
    for (const task of this.list(Number.MAX_SAFE_INTEGER)) {
      if (ACTIVE.has(task.status)) continue;
      const tierMs =
        task.status === "failed" || task.status === "escalated"
          ? escalatedRetentionMs
          : retentionMs;
      if (nowMs - Date.parse(task.updatedAt) <= tierMs) continue;
      this.store.delete(TASK_PREFIX + task.id);
      const idemKey = IDEM_PREFIX + task.idempotencyKey;
      if (this.store.get(idemKey) === task.id) this.store.delete(idemKey);
      pruned.push(task.id);
    }
    return pruned;
  }

  /** Fail + escalate a task abandoned in any active state. */
  markStale(id: string, reason: string): ResearchTask {
    const task = this.transition(id, ["queued", "claimed", "running"], "failed", reason);
    task.error = reason;
    this.save(task);
    return this.escalate(id, "stale task sweep");
  }

  /**
   * Issue #2761 (tracker #2708 A10): fail + escalate a task whose
   * execution was interrupted — the agent incarnation that owned
   * it is gone (evicted / restarted mid-run), so no live execution
   * will ever resolve the record. The disposition is the stale
   * sweep's (#615: never auto-rerun — the run may have partially
   * happened, and persistRun may already have published its
   * report, so a human reviews the escalation), but the history
   * note is distinct: this is start-up recovery, not heartbeat
   * staleness, and the record's history is the audit trail that
   * keeps the two apart.
   */
  markInterrupted(id: string, reason: string): ResearchTask {
    const task = this.transition(id, ["queued", "claimed", "running"], "failed", reason);
    task.error = reason;
    this.save(task);
    return this.escalate(id, "interrupted run recovery; awaiting human review");
  }

  /**
   * Issue #2761: recover every active task in the ledger as
   * interrupted. Called by the owning agent's onStart: a fresh
   * incarnation has executed nothing, so each active record
   * belongs to a dead incarnation and is orphaned by construction
   * — deliberately NO heartbeat-age gate (that gate is the stale
   * sweep's, for records inside a LIVE incarnation's lifetime).
   * Terminal records are never touched, so a second pass over a
   * recovered ledger returns []. Returns the recovered tasks.
   */
  recoverInterrupted(reason: string): ResearchTask[] {
    const recovered: ResearchTask[] = [];
    for (const task of this.list(Number.MAX_SAFE_INTEGER)) {
      if (!ACTIVE.has(task.status)) continue;
      recovered.push(this.markInterrupted(task.id, reason));
    }
    return recovered;
  }

  private load(id: string): ResearchTask {
    const task = this.get(id);
    if (!task) throw new Error(`Research task ${id} not found`);
    return task;
  }

  private transition(
    id: string,
    from: ResearchTaskStatus[],
    to: ResearchTaskStatus,
    note?: string
  ): ResearchTask {
    const task = this.load(id);
    if (!from.includes(task.status)) {
      throw new Error(`Research task ${id} cannot move from ${task.status} to ${to}`);
    }
    const at = this.now();
    task.status = to;
    task.updatedAt = at;
    task.heartbeatAt = at;
    task.history.push(note ? { status: to, at, note } : { status: to, at });
    this.save(task);
    return task;
  }

  private save(task: ResearchTask): void {
    this.store.set(TASK_PREFIX + task.id, JSON.stringify(task));
  }
}
