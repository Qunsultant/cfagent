/**
 * Cloudflare Agents Durable Execution & Fibers Service
 * Repurposed from Cloudflare Agents Durable Execution standard:
 * https://developers.cloudflare.com/agents/runtime/execution/durable-execution/
 *
 * Implements:
 * - keepAlive / keepAliveWhile 30-second heartbeat to prevent DO idle eviction
 * - runFiber with durable checkpointing (ctx.stash) into SQLite
 * - checkpoint recovery (issue #2763): a run started with a runId loads
 *   its latest FIBER_CHECKPOINT on (re)start and resumes from it,
 *   skipping the steps the checkpoint proves complete. There is no
 *   onFiberRecovered hook — recovery happens inside runFiber, at the
 *   moment the run is (re)started under the same identity. A corrupt
 *   or mismatched checkpoint fails loud (FiberCheckpointError): on a
 *   trading path an unreadable checkpoint is never silently treated
 *   as a fresh run.
 * - Durable TWAP (Time-Weighted Average Price) multi-step slice order PREVIEW
 *   planning: slices are previewed with durable checkpointing, never placed
 *   (issue #135 — previews were previously counted as fills)
 */

import type { Env, FiberExecutionRecord, TWAPOrderConfig } from "../types";
import { DatabaseORM } from "../orm";
import { AGENT_DIDS } from "../agents/did";

export type FiberCheckpointErrorCode =
  | "fiber_checkpoint_corrupt"
  | "fiber_checkpoint_mismatch"
  | "fiber_run_id_invalid";

/**
 * A durable fiber run could not be resumed safely. Raised instead of
 * silently restarting the run: callers (and operators) must hear that
 * the durable state is unreadable or belongs to a different run, and
 * choose a fresh runId deliberately if a fresh run is what they want.
 */
export class FiberCheckpointError extends Error {
  readonly code: FiberCheckpointErrorCode;

  constructor(code: FiberCheckpointErrorCode, message: string) {
    super(message);
    this.name = "FiberCheckpointError";
    this.code = code;
  }
}

export interface FiberRunOptions {
  /**
   * Durable run identity. When supplied, the run's fiber id is derived
   * from it (`fib_run_<runId>`) and (re)starting the run under the
   * same session resumes from the latest checkpoint written under
   * that identity. When omitted, the run gets a fresh one-off id and
   * behaves exactly as it always has: checkpoints are written and
   * never read. Resume requires the events-backed ORM the production
   * callers pass; without one there is no durable store to read.
   */
  runId?: string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Derive the stable fiber id for a run identity (issue #2763). */
export function fiberIdForRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new FiberCheckpointError(
      "fiber_run_id_invalid",
      `Invalid durable fiber runId ${JSON.stringify(runId)}: expected 1-64 characters of [A-Za-z0-9_-], starting with a letter or digit.`
    );
  }
  return `fib_run_${runId}`;
}

/**
 * Parse a stored event payload (JSON text in mas_events) back into a
 * record. Returns null when the payload is not a JSON object — the
 * caller decides whether that is corruption (this run's own chain) or
 * an unrelated row to ignore.
 */
function parseStoredRecord(payload: unknown): Record<string, any> | null {
  let value: unknown = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, any>;
}

export class DurableFiberContext {
  constructor(
    public readonly fiberId: string,
    public readonly name: string,
    private service: ETradeDurableFiberService,
    /** True when this incarnation resumed a prior run's checkpoint. */
    public readonly recovered: boolean = false,
    /** Steps the loaded checkpoint proves complete (0 on a fresh run). */
    public readonly resumedFromStep: number = 0,
    /** The checkpoint's stashed data, restored for the fiber body. */
    public readonly restoredStash: Record<string, any> = {}
  ) {}

  stash(data: Record<string, any>): void {
    this.service.updateFiberStash(this.fiberId, data);
  }
}

export class ETradeDurableFiberService {
  private activeFibers = new Map<string, FiberExecutionRecord>();

  constructor(
    private orm?: DatabaseORM,
    private env?: Env,
    private sessionId: string = "durable_agent_session"
  ) {}

  /**
   * Issue #4202 — the keep-alive disposer contract, without the timer.
   *
   * This used to arm a 30-second `setInterval` whose callback did nothing
   * ("Alarms / heartbeat ping"). A no-op timer cannot extend a Durable Object's
   * life in any useful sense — a pending request already keeps the isolate
   * running — and a live timer is exactly what makes an object ineligible for
   * hibernation, which is the state DO duration bills for. Callers keep the
   * same shape (await a disposer, call it once); nothing about their work
   * depends on the timer that used to be here.
   */
  async keepAlive(): Promise<() => void> {
    let disposed = false;
    return () => {
      disposed = true;
    };
  }

  /**
   * Run an async function wrapped with automatic keepAlive heartbeat
   */
  async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    const dispose = await this.keepAlive();
    try {
      return await fn();
    } finally {
      dispose();
    }
  }

  /**
   * The event-id anchor for a fiber's durable rows. Run-identity
   * fibers (fib_run_*, issue #2763) scope their anchor by session:
   * the event log is shared by every session in the store and two
   * sessions may legitimately reuse the same runId, so the unscoped
   * id would collide across sessions (a fresh run's FIBER_STARTED /
   * checkpoint insert would hit the other session's row). One-off
   * fibers keep their original unscoped anchor — their ids embed a
   * timestamp + random suffix and cannot collide.
   */
  private eventAnchor(fiberId: string): string {
    return fiberId.startsWith("fib_run_")
      ? `${this.sessionId}__${fiberId}`
      : fiberId;
  }

  /**
   * Fail loud when a stored record for this run identity names a
   * different run (name / step count) than the one being started:
   * resuming it would execute the wrong plan under the wrong identity.
   */
  private assertRunMatches(
    stored: Record<string, any>,
    fiberId: string,
    name: string,
    totalSteps: number
  ): void {
    if (stored.name !== name || stored.totalSteps !== totalSteps) {
      throw new FiberCheckpointError(
        "fiber_checkpoint_mismatch",
        `Durable fiber run ${fiberId} was started as "${stored.name}" with ${stored.totalSteps} step(s); refusing to resume it as "${name}" with ${totalSteps} step(s). Use a new runId for a different run.`
      );
    }
  }

  /**
   * Load the durable state of a prior incarnation of the run
   * `fiberId` from the event log (issue #2763). Returns the record to
   * seed this incarnation from, or null when the identity has never
   * run in this session. Throws FiberCheckpointError when the run's
   * own durable chain is unreadable (corrupt) or names a different
   * run (mismatch) — never a silent fresh start.
   *
   * Identity isolation is structural: rows are selected by this
   * session's id and by the session-scoped checkpoint event-id
   * anchor (see eventAnchor), so another run's or another session's
   * checkpoints are never candidates.
   */
  private loadRunCheckpoint(
    fiberId: string,
    name: string,
    totalSteps: number
  ): { seed: FiberExecutionRecord; resumedFromStep: number } | null {
    if (!this.orm?.events) return null;
    const events = this.orm.events;

    const anchor = this.eventAnchor(fiberId);
    const checkpointRows = events.findMany({
      where: { sessionId: this.sessionId, type: "FIBER_CHECKPOINT" },
    });
    const mine = checkpointRows.filter(
      (row) => typeof row.id === "string" && row.id.startsWith(`evt_${anchor}_s`)
    );

    if (mine.length === 0) {
      // No checkpoints yet: a FIBER_STARTED under this identity means
      // a previous incarnation died before its first checkpoint. The
      // run restarts from step 0 under the same identity — nothing was
      // checkpointed, so nothing can be double-executed.
      const startedRow = events.findById(`evt_${anchor}`);
      if (!startedRow || startedRow.sessionId !== this.sessionId) return null;
      const started = parseStoredRecord(startedRow.payload);
      if (!started || started.fiberId !== fiberId) {
        throw new FiberCheckpointError(
          "fiber_checkpoint_corrupt",
          `The FIBER_STARTED record for durable fiber run ${fiberId} is unreadable; refusing to resume or silently restart it.`
        );
      }
      this.assertRunMatches(started, fiberId, name, totalSteps);
      return { seed: started as FiberExecutionRecord, resumedFromStep: 0 };
    }

    // Every link of this run's own checkpoint chain must parse and
    // carry an integer step: a damaged link means the run's durable
    // state cannot be trusted end-to-end.
    let latest: Record<string, any> | null = null;
    for (const row of mine) {
      const parsed = parseStoredRecord(row.payload);
      if (
        !parsed ||
        !Number.isInteger(parsed.currentStep) ||
        (parsed.currentStep as number) < 1
      ) {
        throw new FiberCheckpointError(
          "fiber_checkpoint_corrupt",
          `FIBER_CHECKPOINT ${row.id} for durable fiber run ${fiberId} is unreadable or shape-invalid; refusing to resume or silently restart the run.`
        );
      }
      if (!latest || (parsed.currentStep as number) > (latest.currentStep as number)) {
        latest = parsed;
      }
    }

    const checkpoint = latest as Record<string, any>;
    if (
      checkpoint.fiberId !== fiberId ||
      typeof checkpoint.name !== "string" ||
      !Number.isInteger(checkpoint.totalSteps) ||
      (checkpoint.totalSteps as number) < 1 ||
      typeof checkpoint.stashedData !== "object" ||
      checkpoint.stashedData === null ||
      Array.isArray(checkpoint.stashedData) ||
      (checkpoint.currentStep as number) > (checkpoint.totalSteps as number)
    ) {
      throw new FiberCheckpointError(
        "fiber_checkpoint_corrupt",
        `The latest FIBER_CHECKPOINT for durable fiber run ${fiberId} is shape-invalid; refusing to resume or silently restart the run.`
      );
    }
    this.assertRunMatches(checkpoint, fiberId, name, totalSteps);
    return {
      seed: checkpoint as FiberExecutionRecord,
      resumedFromStep: checkpoint.currentStep as number,
    };
  }

  /**
   * Run a durable fiber with automatic stashing and state checkpointing.
   *
   * With `options.runId`, the run is resumable (issue #2763): before
   * the body runs, the latest checkpoint stored under the same
   * session + runId is loaded and the fiber context exposes it
   * (`ctx.recovered`, `ctx.resumedFromStep`, `ctx.restoredStash`), so
   * the body can skip the steps the checkpoint proves complete. A
   * step is only ever skipped after its checkpoint was written — a
   * step interrupted before its checkpoint runs again (at-least-once
   * per step). Without a runId the behavior is the original one:
   * a fresh id, checkpoints written, never read.
   */
  async runFiber<T>(
    name: string,
    fn: (ctx: DurableFiberContext) => Promise<T>,
    totalSteps: number = 1,
    options?: FiberRunOptions
  ): Promise<T> {
    const runId = options?.runId;
    const fiberId =
      runId !== undefined
        ? fiberIdForRunId(runId)
        : `fib_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();

    let recovered = false;
    let resumedFromStep = 0;
    let restoredStash: Record<string, any> = {};
    let record: FiberExecutionRecord;

    const prior =
      runId !== undefined ? this.loadRunCheckpoint(fiberId, name, totalSteps) : null;
    if (prior) {
      recovered = true;
      resumedFromStep = prior.resumedFromStep;
      restoredStash = JSON.parse(JSON.stringify(prior.seed.stashedData ?? {}));
      record = {
        ...prior.seed,
        status: "recovered",
        stashedData: JSON.parse(JSON.stringify(prior.seed.stashedData ?? {})),
        updatedAt: now,
      };
    } else {
      record = {
        fiberId,
        name,
        status: "running",
        currentStep: 0,
        totalSteps,
        stashedData: {},
        startedAt: now,
        updatedAt: now,
      };
    }
    this.activeFibers.set(fiberId, record);

    // Save in SQLite events table for durability across worker restarts
    if (this.orm?.events) {
      const anchor = this.eventAnchor(fiberId);
      if (recovered) {
        this.orm.events.create({
          id: `evt_${anchor}_resumed_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`,
          sessionId: this.sessionId,
          type: "FIBER_RESUMED",
          agent: "durable_execution",
          payload: { fiberId, name, resumedFromStep, recoveredAt: now },
          createdAt: now,
        });
      } else {
        this.orm.events.create({
          id: `evt_${anchor}`,
          sessionId: this.sessionId,
          type: "FIBER_STARTED",
          agent: "durable_execution",
          payload: JSON.parse(JSON.stringify(record)),
          createdAt: now,
        });
      }
    }

    const ctx = new DurableFiberContext(
      fiberId,
      name,
      this,
      recovered,
      resumedFromStep,
      restoredStash
    );

    return await this.keepAliveWhile(async () => {
      try {
        const result = await fn(ctx);
        const existing = this.activeFibers.get(fiberId);
        if (existing) {
          existing.status = "completed";
          existing.updatedAt = new Date().toISOString();
        }
        return result;
      } catch (err: any) {
        const existing = this.activeFibers.get(fiberId);
        if (existing) {
          existing.status = "failed";
          existing.error = err.message || "Fiber execution failed";
          existing.updatedAt = new Date().toISOString();
        }
        throw err;
      }
    });
  }

  /**
   * Stash intermediate progress data
   */
  updateFiberStash(fiberId: string, data: Record<string, any>): void {
    const record = this.activeFibers.get(fiberId);
    if (record) {
      record.stashedData = { ...record.stashedData, ...data };
      record.currentStep++;
      record.updatedAt = new Date().toISOString();

      if (this.orm?.events) {
        this.orm.events.create({
          id: `evt_${this.eventAnchor(fiberId)}_s${record.currentStep}`,
          sessionId: this.sessionId,
          type: "FIBER_CHECKPOINT",
          agent: "durable_execution",
          payload: JSON.parse(JSON.stringify(record)),
          createdAt: record.updatedAt,
        });
      }
    }
  }

  /**
   * Preview a durable TWAP (Time-Weighted Average Price) order plan.
   *
   * Issue #135: this previously ran each slice through the broker's order
   * PREVIEW and counted every preview as a fill, shares and all.
   * A preview places no order and fills nothing. The slice callback MUST be
   * a preview operation; this method only counts previews and returns them.
   * Real execution requires the human-in-the-loop order flow (preview →
   * explicit human approval → place), which an automated plan cannot
   * substitute for.
   */
  async previewDurableTWAP(
    config: TWAPOrderConfig,
    previewSlice: (sliceNum: number, sliceQty: number) => Promise<any>,
    options?: FiberRunOptions
  ): Promise<{
    /** True when every slice preview ran. NO order was placed. */
    completed: boolean;
    /** Total quantity covered by the slice previews — NOT filled shares. */
    totalPreviewed: number;
    slicesPreviewed: number;
    previews: Array<{ slice: number; quantity: number; preview: any }>;
    fiberId: string;
    /** True when this call resumed a prior incarnation's checkpoints. */
    resumed: boolean;
    /** Slices already checkpointed when this call started (skipped). */
    resumedFromStep: number;
  }> {
    const sliceQty = Math.floor(config.totalQuantity / config.slices);
    const remainder = config.totalQuantity % config.slices;
    // The plan fingerprint every checkpoint carries, so a resume can
    // prove the stored plan is THIS plan before trusting it (#2763).
    const plan = {
      symbol: config.symbol,
      action: config.action,
      totalQuantity: config.totalQuantity,
      slices: config.slices,
    };

    return await this.runFiber(
      `twap_preview_${config.symbol}_${config.action}`,
      async (ctx) => {
        let previewedCount = 0;
        let totalPreviewedShares = 0;
        const previews: Array<{ slice: number; quantity: number; preview: any }> = [];

        if (ctx.resumedFromStep > 0) {
          // Resume (issue #2763): seed the completed slices from the
          // checkpoint instead of re-previewing them — but only after
          // the checkpoint's own trail proves itself consistent. A
          // checkpoint whose fingerprint names a different plan is a
          // mismatch; one whose trail contradicts itself is corrupt.
          // Both fail loud: restarting a trading-path run from slice
          // zero on untrusted state could re-run work the operator
          // believes is done.
          const restored = ctx.restoredStash;
          if (
            restored.plan !== undefined &&
            JSON.stringify(restored.plan) !== JSON.stringify(plan)
          ) {
            throw new FiberCheckpointError(
              "fiber_checkpoint_mismatch",
              `Checkpoint for TWAP run ${ctx.fiberId} belongs to plan ${JSON.stringify(restored.plan)}; refusing to resume it against plan ${JSON.stringify(plan)}. Use a new runId for a different plan.`
            );
          }
          const restoredPreviews = restored.previews;
          const trailIsConsistent =
            restored.sliceIndex === ctx.resumedFromStep &&
            Array.isArray(restoredPreviews) &&
            restoredPreviews.length === ctx.resumedFromStep &&
            typeof restored.previewedQty === "number" &&
            restoredPreviews.reduce(
              (sum: number, p: any) =>
                sum + (typeof p?.quantity === "number" ? p.quantity : Number.NaN),
              0
            ) === restored.previewedQty;
          if (!trailIsConsistent) {
            throw new FiberCheckpointError(
              "fiber_checkpoint_corrupt",
              `Checkpoint for TWAP run ${ctx.fiberId} does not carry a consistent preview trail (sliceIndex / previews / previewedQty disagree); refusing to resume or silently restart the run.`
            );
          }
          previews.push(...restoredPreviews);
          previewedCount = restored.sliceIndex;
          totalPreviewedShares = restored.previewedQty;
        }

        for (let i = previewedCount; i < config.slices; i++) {
          const currentSliceQty = i === config.slices - 1 ? sliceQty + remainder : sliceQty;
          const slicePreview = await previewSlice(i + 1, currentSliceQty);

          previewedCount++;
          totalPreviewedShares += currentSliceQty;
          previews.push({ slice: i + 1, quantity: currentSliceQty, preview: slicePreview });

          // Stash state checkpoint — including the previews so far and
          // the plan fingerprint, so a later incarnation can resume
          // from exactly this point and prove it is the same plan.
          ctx.stash({
            sliceIndex: i + 1,
            previewedQty: totalPreviewedShares,
            lastPreview: slicePreview,
            previews: [...previews],
            plan,
          });

          // Wait between slices if more remain (simulated in milliseconds for testability)
          if (i < config.slices - 1 && config.intervalSeconds > 0) {
            await new Promise((res) => setTimeout(res, Math.min(config.intervalSeconds * 100, 100)));
          }
        }

        return {
          completed: true,
          totalPreviewed: totalPreviewedShares,
          slicesPreviewed: previewedCount,
          previews,
          fiberId: ctx.fiberId,
          resumed: ctx.recovered,
          resumedFromStep: ctx.resumedFromStep,
        };
      },
      config.slices,
      options
    );
  }

  /**
   * Inspect status of a running or completed fiber
   */
  getFiberStatus(fiberId: string): FiberExecutionRecord | undefined {
    return this.activeFibers.get(fiberId);
  }

  /**
   * List all fibers
   */
  listFibers(): FiberExecutionRecord[] {
    return Array.from(this.activeFibers.values());
  }
}
