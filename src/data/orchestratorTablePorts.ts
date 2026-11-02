/**
 * Issue #2359 (#1976 step 4d, ADR 0022 D-I step 4) — the
 * orchestrator-owned table ports: FOUR ports, one per table
 * whose DDL lived in OrchestratorAgent.ensureTables
 * (step-4 audit §4d): mas_autopilot, mas_policy_verdicts,
 * mas_report_confirmations, mas_screener_presets.
 *
 * ADR D-0 residency: all four stay DO-resident behind ports —
 * (a) agent-runtime identity (the autopilot envelope and the
 * verdict ledger are the orchestrator instance's own state),
 * (b) per-instance serialization (the confirmations lazy
 * sweep + insert rides it), (e) colocated strongly-consistent
 * storage, (f) tenancy isolation by construction (presets are
 * user-scoped rows in the owner's instance). This module
 * carries the record types and the port interfaces ONLY
 * (ADR 0002 R1/R2). Adapters: doSqlite*Adapter.ts files
 * (production), inMemoryOrchestratorTableAdapters.ts (test
 * doubles). The legacy surfaces (orchestrator/autopilot.ts,
 * orchestrator/reportDispatch.ts, routes/autopilot.ts,
 * routes/screenerPresets.ts, routes/reports.ts,
 * services/screenerPresetResolution.ts) serve through these
 * ports; their domain logic (policy evaluation, criteria
 * validation, response shaping) stays where it lives.
 *
 * OUT OF THIS FAMILY (named, not silently absorbed):
 * mas_settings — its DDL stays in ensureTables and the
 * reportDispatch settings pair stays raw (owner gate G-7);
 * the legacy cf_ai_chat_agent_messages lift's logic stays in
 * the class (SDK-owned table, ADR-out per the audit); its SQL
 * moved to SqlLegacyChatStore (doSqliteLegacyChatAdapter.ts)
 * under #1776 (#1717 Adapter S2), so it is not a port here.
 *
 * TRANSACTION SEAM (ADR D-C): deliberately none. Every
 * operation is a single statement; the one multi-statement
 * sequence (createReportConfirmation's sweep-then-insert) is
 * a lazy TTL sweep followed by an insert — the sweep is
 * idempotent maintenance whose interleaving under the
 * instance's serialization cannot produce a wrong row, only
 * (at worst) sweep a row one create later. No wrap is claimed.
 */
import type { SqlStorage } from "./repositoryPorts";

export type OrchestratorTableSqlExecutor = SqlStorage;

// ---------------------------------------------------------------------------
// mas_autopilot — the server-owned autopilot envelope state (KV shape).
// ---------------------------------------------------------------------------

export interface AutopilotStatePort {
  /** The table's ONE DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /** The stored value for a key, or null when absent. */
  getValue(key: string): string | null;
  /** INSERT OR REPLACE the key's value (the legacy upsert). */
  putValue(key: string, value: string, updatedAt: string): void;
}

// ---------------------------------------------------------------------------
// mas_policy_verdicts — the append-only signed verdict ledger.
// ---------------------------------------------------------------------------

/** One verdict row as the evaluator records it (booleans map
 *  to the 0/1 columns in the adapter, per D-E convention). */
export interface PolicyVerdictInsert {
  id: string;
  sessionId: string;
  symbol: string;
  action: string;
  quantity: number;
  notional: number | null;
  mode: string;
  dryRun: boolean;
  passed: boolean;
  executionAllowed: boolean;
  requiresApproval: boolean;
  bindingRule: string | null;
  detail: string;
  limitsJson: string;
  projectionsJson: string;
  findingsJson: string;
  signature: string;
  signingKeyId: string;
  proposerDid: string;
  authorizerDid: string;
  createdAt: string;
}

/** The control-center projection (the route's exact column set). */
export interface PolicyVerdictRecentRow {
  id: string;
  symbol: string;
  action: string;
  quantity: number;
  notional: number | null;
  mode: string;
  dry_run: number;
  passed: number;
  execution_allowed: number;
  requires_approval: number;
  binding_rule: string | null;
  detail: string;
  signature: string;
  proposer_did: string;
  authorizer_did: string;
  created_at: string;
}

export interface PolicyVerdictPort {
  /** Base table + the created-at index. Idempotent. */
  ensureSchema(): void;
  /** Append one signed verdict (insert-or-throw on the id). */
  insertVerdict(row: PolicyVerdictInsert): void;
  /** Newest-first verdicts in the control-center projection. */
  listRecent(limit: number): PolicyVerdictRecentRow[];
}

// ---------------------------------------------------------------------------
// mas_report_confirmations — pending HITL dispatch confirmations.
// ---------------------------------------------------------------------------

/** The full stored row, exactly as the table holds it. */
export interface ReportConfirmationRow {
  id: string;
  kind: string;
  payload_json: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  report_id: string | null;
}

/** The pending-list projection (id, kind, payload_json, created_at). */
export type ReportConfirmationPendingRow = Pick<
  ReportConfirmationRow,
  "id" | "kind" | "payload_json" | "created_at"
>;

/** The per-report projection (the run-confirmations route's set). */
export type ReportConfirmationForReportRow = Pick<
  ReportConfirmationRow,
  "id" | "kind" | "status" | "created_at" | "decided_at" | "decided_by" | "payload_json"
>;

export interface InsertConfirmationInput {
  id: string;
  kind: string;
  payloadJson: string;
  status: string;
  createdAt: string;
  reportId: string | null;
}

export interface ReportConfirmationPort {
  /** Base table + the probed report_id migration (#308).
   *  Ensure-style additive; idempotent. */
  ensureSchema(): void;
  /** The lazy TTL sweep: drop still-pending rows created
   *  before the cutoff. Runs at confirmation creation. */
  sweepExpiredPending(cutoffIso: string): void;
  /** Insert one pending confirmation (insert-or-throw). */
  insertConfirmation(input: InsertConfirmationInput): void;
  /** The full row for an id, or null. */
  getById(id: string): ReportConfirmationRow | null;
  /** Record a decision (approved / rejected / expired). */
  decide(id: string, status: string, decidedAt: string, decidedBy: string | null): void;
  /** Every pending row, newest first (the pending queue). */
  listPending(): ReportConfirmationPendingRow[];
  /** Every row for one canonical report, newest first. */
  listByReportId(reportId: string): ReportConfirmationForReportRow[];
}

// ---------------------------------------------------------------------------
// mas_screener_presets — user-scoped screener presets (#1495).
// ---------------------------------------------------------------------------

/** The full stored row, exactly as the table holds it. */
export interface ScreenerPresetRow {
  id: string;
  user_login: string;
  name: string;
  asset_class: string;
  criteria_json: string;
  created_at: string;
  updated_at: string;
}

export interface ScreenerPresetPort {
  /** The table's ONE DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /** One user's presets, most recently updated first. */
  listByUser(userLogin: string): ScreenerPresetRow[];
  /** Insert one preset (insert-or-throw on the id). */
  insertPreset(row: ScreenerPresetRow): void;
  /** True when the id exists FOR THIS USER (no existence
   *  oracle across users — the delete path's 404 discipline). */
  existsForUser(id: string, userLogin: string): boolean;
  /** Delete one preset scoped to its owner. */
  deleteForUser(id: string, userLogin: string): void;
  /** The run-time resolution projection (asset class + stored
   *  criteria) for (id, user), or null. */
  getResolutionRow(
    id: string,
    userLogin: string
  ): { asset_class: unknown; criteria_json: unknown } | null;
}
