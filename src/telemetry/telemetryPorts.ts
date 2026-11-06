/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in D1,
 * sub-issue of #1736 item 6) — telemetry/calibration port (R1).
 *
 * Domain code depends ONLY on these interfaces. This module is
 * deliberately free of any store client, any binding reference,
 * and any query language: no adapter import, no D1 reference.
 * The composition root (src/telemetry/createTelemetryPorts.ts)
 * wires store adapters to these ports; domain code never sees
 * the adapter.
 *
 * Design basis: docs/architecture/code/component-taxonomy-01.md
 * §5 (RSI roadmap: Level 3 → Level 4 closed-loop weight/prompt
 * tuning) and §11 Phase 3 (RSI transformation). The later
 * horizon, from the screener-doc mapping (§13.1 Phase 4
 * governed RSI), is mas_outcomes falsification feedback,
 * champion/challenger gating, and regime-conditioned weights —
 * this slice builds the governed telemetry + calibration core
 * that horizon consumes; it does NOT build the challenger gate
 * itself (that stays #1140's three-lock gate, reused as idiom).
 *
 * Governed calibration (the rule this port enforces):
 *  - The calibration SIGNAL is falsification (thesis outcomes vs
 *    predictions), not raw accuracy alone: a proposal triggers
 *    only when a (agent, thesis) slice is both sufficiently
 *    sampled (>= CALIBRATION_MIN_SAMPLE evaluated ideas, the
 *    same 20-sample floor the calibration dashboard uses for
 *    low-sample flagging) and majority-falsified
 *    (falsificationRate > 0.5, strictly — a tie is noise, not
 *    a signal).
 *  - Proposals attach to THESIS slices only. Agent/structure/
 *    regime/month aggregations are diagnostic metrics, not
 *    proposal triggers: a prompt note attaches to a thesis
 *    prompt slot, not to a month. A systematically wrong
 *    structure surfaces as one proposal per falsified thesis
 *    in it, each independently sampled.
 *  - A proposal's metric snapshot is FROZEN at proposal time
 *    (no update path for it — a new measurement needs a new
 *    proposal, mirroring the champion/challenger frozen-criteria
 *    lock). An open (proposed/approved) proposal for the same
 *    (tenant, actor, prompt slot) blocks a duplicate.
 *  - Approval is HUMAN-ONLY: the approver must be a non-blank,
 *    non-system actor who is not the proposer (mirroring the
 *    champion/challenger authorized-approval lock; system and
 *    nightly actors may create proposals, never approve them).
 *    Application requires an approved decision plus a human,
 *    non-proposer applier, and records the prior note so the
 *    change is reversible (supersede/expire stops resolution).
 *  - The engine never rewrites prompts by itself: the applied
 *    artifact is a deterministic, evidence-grounded calibration
 *    NOTE generated from the frozen snapshot, which the actor
 *    turn appends to the prompt via resolveCalibratedPrompt.
 *    No model call decides a proposal, an approval, or a note.
 *
 * Tenancy (R7): every method takes a tenant id resolved
 * server-side. There is no unscoped read method anywhere in
 * this module; adapters scope every query by tenant.
 *
 * Stream hooks for #1743 (named here, NOT built here): the
 * telemetry.* CloudEvents envelopes below are the stream
 * #1743's Analytics Engine pipeline will consume. Envelopes
 * carry counts and ids only — never prompt text, never thesis
 * text, never user material (the #1740/#1745 envelope
 * discipline). Emission is best-effort, swallowed + logged,
 * never failing the telemetry operation.
 *
 * Calibration never blocks a thesis run: every production
 * caller of the realization writer wraps it best-effort (see
 * the evaluateRun hook); the port itself is a plain store and
 * makes no availability promise to callers.
 */
import type { MessageEnvelope } from "../messaging/messagingPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "telemetry/telemetryPorts",
});

/** Predicted/realized thesis direction (dashboard vocabulary). */
export type ThesisDirection = "up" | "down" | "flat";

/** Metric aggregation dimensions (dashboard vocabulary). */
export type MetricDimension = "thesis" | "agent" | "structure" | "regime" | "month";

/** Sample floor for a proposal (mirrors the dashboard's low-sample threshold). */
export const CALIBRATION_MIN_SAMPLE = 20;

/** Proposer id for engine-generated proposals. */
export const CALIBRATION_PROPOSER = "system:calibration-engine";

/** Cap on falsifying example outcome ids carried in a proposal. */
export const CALIBRATION_FALSIFYING_EXAMPLES_CAP = 10;

/** Business error: a calibration rule refused the operation. */
export class CalibrationError extends Error {
  /** "not-found" maps to 404 at the route layer; anything else maps to 400. */
  readonly code: "not-found" | "rule";
  constructor(message: string, code: "not-found" | "rule" = "rule") {
    super(message);
    this.name = "CalibrationError";
    this.code = code;
  }
}

/** True for system/nightly actors, which may propose but never approve/apply. */
export function isSystemActor(actor: string): boolean {
  return actor === "system" || actor.startsWith("system:") || actor.startsWith("nightly:");
}

function requireHumanActor(actor: string, role: string): void {
  if (typeof actor !== "string" || actor.trim() === "") {
    throw new CalibrationError(`${role} must be a non-empty actor id.`);
  }
  if (isSystemActor(actor)) {
    throw new CalibrationError(`${role} must be a human actor, not a system actor.`);
  }
}

/** One evaluated thesis outcome, as recorded. */
export interface ThesisRealizationInput {
  tenantId: string;
  /** Deterministic outcome id: `${runId}:${symbol}:${structure}` — the idempotency key. */
  outcomeId: string;
  thesis: string;
  /** Actor that produced the thesis (e.g. "research"). */
  agentKey: string;
  structure: string;
  regime: string;
  symbol: string;
  runId: string;
  /** agent_reports link when the realization derives from a canonical report. */
  reportId?: string | null;
  /** agent_chains link when the realization derives from a chain job. */
  chainId?: string | null;
  predictedDirection: ThesisDirection;
  realizedDirection: ThesisDirection;
  directionCorrect: boolean;
  /** Directional theses only: true exactly when directionCorrect is false. */
  falsified: boolean;
  invalidated?: boolean;
  pnlEstimatePerUnit?: number | null;
  rMultiple?: number | null;
  evaluatedAtMs: number;
}

/** A stored realization row (adapter stamps createdAtMs). */
export interface ThesisRealizationRow extends ThesisRealizationInput {
  createdAtMs: number;
}

/** One metric slice: evaluated ideas, hits, rates (null rates when empty). */
export interface MetricSlice {
  key: string;
  evaluated: number;
  hits: number;
  hitRate: number | null;
  falsificationRate: number | null;
}

export interface MetricWindow {
  fromMs?: number;
  toMs?: number;
}

/** Pure aggregation over realization rows (shared by both adapters). */
export function aggregateMetrics(
  rows: ThesisRealizationRow[],
  dimension: MetricDimension,
  window?: MetricWindow,
): MetricSlice[] {
  const inWindow = (r: ThesisRealizationRow): boolean =>
    (window?.fromMs === undefined || r.evaluatedAtMs >= window.fromMs) &&
    (window?.toMs === undefined || r.evaluatedAtMs < window.toMs);
  const keyOf = (r: ThesisRealizationRow): string => {
    switch (dimension) {
      case "thesis":
        return r.thesis;
      case "agent":
        return r.agentKey;
      case "structure":
        return r.structure;
      case "regime":
        return r.regime;
      case "month":
        return new Date(r.evaluatedAtMs).toISOString().slice(0, 7);
    }
  };
  const buckets = new Map<string, { evaluated: number; hits: number }>();
  for (const row of rows) {
    if (!inWindow(row)) continue;
    const entry = buckets.get(keyOf(row)) ?? { evaluated: 0, hits: 0 };
    entry.evaluated += 1;
    if (row.directionCorrect) entry.hits += 1;
    buckets.set(keyOf(row), entry);
  }
  return [...buckets.entries()]
    .map(([key, { evaluated, hits }]) => ({
      key,
      evaluated,
      hits,
      hitRate: evaluated > 0 ? hits / evaluated : null,
      falsificationRate: evaluated > 0 ? (evaluated - hits) / evaluated : null,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Deterministic calibration note text from a frozen snapshot. */
export function buildCalibrationNote(
  dimension: MetricDimension,
  sliceKey: string,
  slice: MetricSlice,
): string {
  const subject =
    dimension === "thesis"
      ? `thesis "${sliceKey}"`
      : dimension === "agent"
        ? `agent "${sliceKey}"`
        : dimension === "structure"
          ? `strategy "${sliceKey}"`
          : dimension === "regime"
            ? `regime "${sliceKey}"`
            : `ideas evaluated in ${sliceKey}`;
  if (slice.evaluated === 0) {
    return `Calibration note: ${subject} has no evaluated ideas yet.`;
  }
  const hitPct = ((slice.hits / slice.evaluated) * 100).toFixed(1);
  const falsPct = (((slice.evaluated - slice.hits) / slice.evaluated) * 100).toFixed(1);
  return (
    `Calibration note: ${subject} matched its predicted direction in only ` +
    `${hitPct}% of ${slice.evaluated} evaluated ideas (falsification rate ${falsPct}%). ` +
    `Require additional confirmation before acting on this thesis family.`
  );
}

/** Realization store surface (D1 + in-memory adapters). */
export interface ThesisRealizationStore {
  recordRealizations(
    rows: ThesisRealizationInput[],
  ): Promise<{ recorded: number; duplicates: number }>;
  queryRealizations(
    tenantId: string,
    filters?: MetricWindow & { thesis?: string; agentKey?: string },
  ): Promise<ThesisRealizationRow[]>;
  metrics(
    tenantId: string,
    dimension: MetricDimension,
    opts?: MetricWindow,
  ): Promise<MetricSlice[]>;
}

export type CalibrationDecisionStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "applied"
  | "superseded"
  | "expired";

/** One governed calibration decision (frozen snapshot + audit trail in-row). */
export interface CalibrationDecisionRow {
  id: string;
  tenantId: string;
  actorKey: string;
  /** Prompt slot the note rides with, e.g. "thesis:<thesis>". */
  promptKey: string;
  dimension: MetricDimension;
  sliceKey: string;
  /** Frozen at proposal time; never updated. */
  snapshot: MetricSlice;
  falsifyingOutcomeIds: string[];
  calibrationNote: string;
  proposedBy: string;
  proposedAtMs: number;
  status: CalibrationDecisionStatus;
  decidedBy?: string | null;
  decidedAtMs?: number | null;
  appliedBy?: string | null;
  appliedAtMs?: number | null;
  /** Note that resolve returned before this application (reversibility record). */
  priorNote?: string | null;
  /** Replacement decision id, when superseded by one. */
  supersededBy?: string | null;
  expiredBy?: string | null;
  expiredAtMs?: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Decision store surface (D1 + in-memory adapters). */
export interface CalibrationDecisionStore {
  recordDecision(row: CalibrationDecisionRow): Promise<void>;
  getDecision(tenantId: string, id: string): Promise<CalibrationDecisionRow | null>;
  updateDecision(row: CalibrationDecisionRow): Promise<void>;
  listDecisions(
    tenantId: string,
    filters?: {
      status?: CalibrationDecisionStatus;
      actorKey?: string;
      promptKey?: string;
    },
  ): Promise<CalibrationDecisionRow[]>;
}

/** The telemetry store: realizations + decisions, one port. */
export interface TelemetryStore
  extends ThesisRealizationStore,
    CalibrationDecisionStore {}

export interface CalibrationEngineOptions {
  nowMs?: () => number;
  /** Best-effort stream emission; failures swallowed + logged, never thrown. */
  emit?: (envelope: MessageEnvelope) => void | Promise<void>;
}

/**
 * The calibration engine: deterministic proposal/decision logic
 * over a TelemetryStore. The engine holds no store client of its
 * own — it is pure domain logic, testable against either adapter.
 */
export class TelemetryCalibrationEngine {
  private readonly nowMs: () => number;
  private readonly emit?: (envelope: MessageEnvelope) => void | Promise<void>;

  constructor(
    private readonly store: TelemetryStore,
    opts: CalibrationEngineOptions = {},
  ) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.emit = opts.emit;
  }

  private emitBestEffort(envelope: MessageEnvelope): void {
    if (!this.emit) return;
    try {
      const result = this.emit(envelope);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          structuredLog.warn("telemetry.stream_emission_failed", {
            message: `[telemetry] stream emission failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      structuredLog.warn("telemetry.stream_emission_failed", {
        message: `[telemetry] stream emission failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Scan (agent, thesis) groups for the falsification trigger.
   * Returns created proposals plus open proposals that blocked
   * a duplicate for the same (tenant, actor, prompt slot).
   */
  async proposeCalibrations(
    tenantId: string,
    window?: MetricWindow,
  ): Promise<{
    created: CalibrationDecisionRow[];
    skippedOpen: CalibrationDecisionRow[];
  }> {
    const rows = await this.store.queryRealizations(tenantId, window);
    const groups = new Map<string, ThesisRealizationRow[]>();
    for (const row of rows) {
      const key = `${row.agentKey}\n${row.thesis}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const created: CalibrationDecisionRow[] = [];
    const skippedOpen: CalibrationDecisionRow[] = [];
    for (const group of groups.values()) {
      const slice = aggregateMetrics(group, "thesis")[0];
      if (!slice) continue;
      if (slice.evaluated < CALIBRATION_MIN_SAMPLE) continue;
      if (slice.falsificationRate === null || slice.falsificationRate <= 0.5) continue;
      const actorKey = group[0].agentKey;
      const promptKey = `thesis:${group[0].thesis}`;
      const open = (await this.store.listDecisions(tenantId, { actorKey, promptKey })).filter(
        (d) => d.status === "proposed" || d.status === "approved",
      );
      if (open.length > 0) {
        skippedOpen.push(open[0]);
        continue;
      }
      const falsifying = group
        .filter((r) => r.falsified)
        .sort((a, b) =>
          a.evaluatedAtMs !== b.evaluatedAtMs
            ? a.evaluatedAtMs - b.evaluatedAtMs
            : a.outcomeId < b.outcomeId
              ? -1
              : a.outcomeId > b.outcomeId
                ? 1
                : 0,
        )
        .slice(0, CALIBRATION_FALSIFYING_EXAMPLES_CAP)
        .map((r) => r.outcomeId);
      const now = this.nowMs();
      const decision: CalibrationDecisionRow = {
        id: crypto.randomUUID(),
        tenantId,
        actorKey,
        promptKey,
        dimension: "thesis",
        sliceKey: group[0].thesis,
        snapshot: slice,
        falsifyingOutcomeIds: falsifying,
        calibrationNote: buildCalibrationNote("thesis", group[0].thesis, slice),
        proposedBy: CALIBRATION_PROPOSER,
        proposedAtMs: now,
        status: "proposed",
        createdAtMs: now,
        updatedAtMs: now,
      };
      await this.store.recordDecision(decision);
      created.push(decision);
      this.emitBestEffort(toCalibrationProposedEnvelope(decision));
    }
    return { created, skippedOpen };
  }

  private async loadDecisionOrThrow(
    tenantId: string,
    decisionId: string,
  ): Promise<CalibrationDecisionRow> {
    const decision = await this.store.getDecision(tenantId, decisionId);
    if (!decision) {
      throw new CalibrationError("Calibration decision not found.", "not-found");
    }
    return decision;
  }

  async decideCalibration(
    tenantId: string,
    decisionId: string,
    verdict: "approved" | "rejected",
    actor: string,
  ): Promise<CalibrationDecisionRow> {
    requireHumanActor(actor, "Approver");
    const decision = await this.loadDecisionOrThrow(tenantId, decisionId);
    if (decision.status !== "proposed") {
      throw new CalibrationError(
        `Only a proposed decision can be decided (current status: ${decision.status}).`,
      );
    }
    if (actor === decision.proposedBy) {
      throw new CalibrationError("The proposer cannot decide their own proposal.");
    }
    const now = this.nowMs();
    const updated: CalibrationDecisionRow = {
      ...decision,
      status: verdict,
      decidedBy: actor,
      decidedAtMs: now,
      updatedAtMs: now,
    };
    await this.store.updateDecision(updated);
    return updated;
  }

  async applyCalibration(
    tenantId: string,
    decisionId: string,
    actor: string,
  ): Promise<CalibrationDecisionRow> {
    requireHumanActor(actor, "Applier");
    const decision = await this.loadDecisionOrThrow(tenantId, decisionId);
    if (decision.status !== "approved") {
      throw new CalibrationError(
        `Only an approved decision can be applied (current status: ${decision.status}).`,
      );
    }
    if (actor === decision.proposedBy) {
      throw new CalibrationError("The proposer cannot apply their own proposal.");
    }
    const priorNote = await this.resolveCalibratedPrompt(
      tenantId,
      decision.actorKey,
      decision.promptKey,
    );
    const now = this.nowMs();
    const updated: CalibrationDecisionRow = {
      ...decision,
      status: "applied",
      appliedBy: actor,
      appliedAtMs: now,
      priorNote,
      updatedAtMs: now,
    };
    await this.store.updateDecision(updated);
    this.emitBestEffort(toCalibrationAppliedEnvelope(updated));
    return updated;
  }

  async supersedeCalibration(
    tenantId: string,
    decisionId: string,
    actor: string,
    replacementId?: string,
  ): Promise<CalibrationDecisionRow> {
    requireHumanActor(actor, "Operator");
    const decision = await this.loadDecisionOrThrow(tenantId, decisionId);
    if (
      decision.status !== "proposed" &&
      decision.status !== "approved" &&
      decision.status !== "applied"
    ) {
      throw new CalibrationError(
        `Only a proposed, approved, or applied decision can be superseded (current status: ${decision.status}).`,
      );
    }
    const now = this.nowMs();
    const updated: CalibrationDecisionRow = {
      ...decision,
      status: "superseded",
      supersededBy: replacementId ?? null,
      updatedAtMs: now,
    };
    await this.store.updateDecision(updated);
    return updated;
  }

  async expireCalibration(
    tenantId: string,
    decisionId: string,
    actor: string,
  ): Promise<CalibrationDecisionRow> {
    requireHumanActor(actor, "Operator");
    const decision = await this.loadDecisionOrThrow(tenantId, decisionId);
    if (decision.status !== "applied") {
      throw new CalibrationError(
        `Only an applied decision can be expired (current status: ${decision.status}).`,
      );
    }
    const now = this.nowMs();
    const updated: CalibrationDecisionRow = {
      ...decision,
      status: "expired",
      expiredBy: actor,
      expiredAtMs: now,
      updatedAtMs: now,
    };
    await this.store.updateDecision(updated);
    return updated;
  }

  /** Latest applied note for (tenant, actor, prompt slot), else null. */
  async resolveCalibratedPrompt(
    tenantId: string,
    actorKey: string,
    promptKey: string,
  ): Promise<string | null> {
    const applied = (await this.store.listDecisions(tenantId, { actorKey, promptKey })).filter(
      (d) => d.status === "applied",
    );
    if (applied.length === 0) return null;
    applied.sort((a, b) =>
      (b.appliedAtMs ?? 0) !== (a.appliedAtMs ?? 0)
        ? (b.appliedAtMs ?? 0) - (a.appliedAtMs ?? 0)
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
    return applied[0].calibrationNote;
  }

  async listDecisions(
    tenantId: string,
    filters?: {
      status?: CalibrationDecisionStatus;
      actorKey?: string;
      promptKey?: string;
    },
  ): Promise<CalibrationDecisionRow[]> {
    return this.store.listDecisions(tenantId, filters);
  }
}

/**
 * Stream envelope builders for #1743 (counts and ids only —
 * never prompt text, never thesis text, never user material).
 * Ids are deterministic per entity, so the id IS the
 * idempotency key (the #1739 CloudEvents discipline).
 */
export function toRealizationRecordedEnvelope(input: {
  tenantId: string;
  outcomeId: string;
  agentKey: string;
  structure: string;
  regime: string;
  directionCorrect: boolean;
  falsified: boolean;
  time?: string;
}): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `telemetry-realization:${input.tenantId}:${input.outcomeId}`,
    source: "telemetry/calibration",
    type: "telemetry.realization_recorded",
    time: input.time ?? new Date().toISOString(),
    subject: input.outcomeId,
    correlationid: `telemetry:${input.outcomeId}`,
    data: {
      tenantId: input.tenantId,
      outcomeId: input.outcomeId,
      agentKey: input.agentKey,
      structure: input.structure,
      regime: input.regime,
      directionCorrect: input.directionCorrect,
      falsified: input.falsified,
    },
  };
}

export function toCalibrationProposedEnvelope(
  decision: CalibrationDecisionRow,
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `telemetry-calibration-proposed:${decision.id}`,
    source: "telemetry/calibration",
    type: "telemetry.calibration_proposed",
    time: new Date(decision.proposedAtMs).toISOString(),
    subject: decision.id,
    correlationid: `telemetry:${decision.id}`,
    data: {
      tenantId: decision.tenantId,
      decisionId: decision.id,
      actorKey: decision.actorKey,
      promptKey: decision.promptKey,
      dimension: decision.dimension,
      sliceKey: decision.sliceKey,
      evaluated: decision.snapshot.evaluated,
      hits: decision.snapshot.hits,
      hitRate: decision.snapshot.hitRate,
      falsificationRate: decision.snapshot.falsificationRate,
    },
  };
}

export function toCalibrationAppliedEnvelope(
  decision: CalibrationDecisionRow,
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `telemetry-calibration-applied:${decision.id}`,
    source: "telemetry/calibration",
    type: "telemetry.calibration_applied",
    time: new Date(decision.appliedAtMs ?? decision.updatedAtMs).toISOString(),
    subject: decision.id,
    correlationid: `telemetry:${decision.id}`,
    data: {
      tenantId: decision.tenantId,
      decisionId: decision.id,
      actorKey: decision.actorKey,
      promptKey: decision.promptKey,
      appliedBy: decision.appliedBy ?? null,
    },
  };
}
