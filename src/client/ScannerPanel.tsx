/**
 * Opportunity Scanner panel — issue #84 slice 1.
 *
 * Surfaces, paired to their backends:
 *  - Surface 1 (mode switch, #23): the two strategy questions as an
 *    explicit segmented control — "Best strategy for a name"
 *    (per_name_best) vs "Names that fit my strategy" (strategy_fit).
 *    The mode is component state, is sent on every run, and the
 *    results header names the mode that produced them: never inferred
 *    from phrasing, never read back from live form state.
 *  - Surface 4 (strategy profiles, #28): a picker in the scan form
 *    (one tap from the fit-mode question) plus a full profile manager
 *    (list / create / edit / delete) over the profiles CRUD routes.
 *    Server validation messages (400s, duplicate names) surface
 *    verbatim; a scan run under a profile shows the server's
 *    profileRef stamp as a badge.
 *
 * Honesty rules carried from the backends: a strategy-fit run with
 * zero fits renders an explicit no-fit state with the gate accounting
 * (never an empty table); every array the payload may omit is treated
 * as empty (scannerApi coerces, this panel also guards).
 *
 *  - Slice 2 (matrix board #22 + type roll-up #26): the full
 *    names × strategy-types fit matrix renders as a board under the
 *    headline results, with the per-type screen roll-up as cards
 *    above it. A matrix "pass" is a SCREEN pass only (the scanner's
 *    risk screen) — qualification stays the fit gate's job, and the
 *    copy says so. A cell with a passing candidate hands off to the
 *    hub's existing HITL preview (onPreviewTrade) — the panel itself
 *    never calls an order endpoint.
 *
 *  - Slice 3 (trust layer): provenance on every row. The target's
 *    source rides as a chip (stated / stated % / thesis-derived /
 *    expected-move — #19, #23, #25), the results header labels its
 *    timestamp "Data as of" and carries the scan model version the
 *    server stamped on the result (#27), and every score is labelled
 *    the cross-name comparable composite it is (#25).
 *
 *  - Slice 5 (scan history, #27): persisted runs list under the
 *    profiles manager with their summary provenance (time, mode,
 *    model version, coverage, gate counts, run id). A saved run can
 *    be VIEWED — its stored result renders through the same
 *    ScanResultsView under a "saved scan" banner, without running or
 *    persisting anything — RE-RUN (its saved requestSnapshot replays
 *    through the normal scan path; see buildRerunRequest for what a
 *    replay can and cannot carry), and DIFFED against the previous
 *    run or any other run via the server's diff route. The diff
 *    renders the server's ScanRunDiff verbatim — nothing is diffed
 *    or scored client-side.
 *
 *  - Issue #103 polish on slice 5: history rows show the run's
 *    profile chip (the summary carries profileRef now), the list is
 *    scoped to the signed-in user server-side (legacy unscoped runs
 *    stay visible to everyone), and runs recorded since #103 carry
 *    their original request — re-running one of those replays it
 *    verbatim instead of mapping the snapshot (buildRerunRequest).
 *
 * All HTTP goes through scannerApi → apiFetch (the 202 async-job
 * polling convention, issue #71).
 */

import { useCallback, useEffect, useState } from "react";
import "./scannerPanel.css";
import { Button, Card, Checkbox, FieldShell, PillGroup, Select, Table, TextInput } from "./components/ui";
import { StrategyLibraryModal } from "./options/StrategyLibraryModal";
import { resolveCatalogStrategyLabels } from "./options/strategyLibrary";
import { parseSymbolList } from "./accountApi";
import {
  createProfile,
  deleteProfile,
  getScanRun,
  getScanRunDiff,
  listProfiles,
  listScanRuns,
  runOpportunityScan,
  updateProfile,
  type OpportunityScanResponse,
  type OpportunityScanResult,
  type ScanMode,
  type ScanRunDetail,
  type ScanRunDiffResult,
  type ScanRunSummary,
  type StrategyProfile,
  type StrategyProfileSpec,
} from "./scannerApi";
import type {
  OpportunityRow,
  ScanMatrixCell,
  ScanMatrixCellBest,
  ScanMatrixRow,
  ScanTargetSource,
  ScanTypeRollup,
} from "../trading/options/opportunityScanner";
import {
  downloadScanExport,
  scanExportRunFromResult,
  scanExportRunFromStored,
} from "./runExport";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import type { ExpectedIvDirection, OptionThesis } from "../trading/options/strategyEngine";
import type { UnifiedOptionsRequest } from "../trading/options/unifiedOptionsService";

// Mode switch (surface 1) -----------------------------------------------

export const MODE_LABELS: Record<ScanMode, string> = {
  per_name_best: "Best strategy for a name",
  strategy_fit: "Names that fit my strategy",
};

const THESIS_OPTIONS: Array<{ value: OptionThesis; label: string }> = [
  { value: "bullish", label: "Bullish" },
  { value: "bearish", label: "Bearish" },
  { value: "range_bound", label: "Range-bound" },
  { value: "large_move", label: "Large move" },
];

const RISK_PROFILE_OPTIONS = ["conservative", "balanced", "aggressive"] as const;
type RiskProfileValue = (typeof RISK_PROFILE_OPTIONS)[number];

export interface ScanFormInput {
  symbolsText: string;
  thesis: OptionThesis;
  riskProfile: RiskProfileValue;
  mode: ScanMode;
  profileId: string;
  fitLimit: number;
  selectedStrategies?: string[];
}

/** The exact request body a Run click sends. Mode rides on EVERY run
 *  (explicit, per #84); a chosen profile sends its id; the fit limit
 *  rides the unified request's declared `limit` field in fit mode. */
export function buildScanRequest(input: ScanFormInput): UnifiedOptionsRequest {
  const symbols = parseSymbolList(input.symbolsText);
  return {
    action: "opportunities",
    ...(symbols.length > 0 ? { symbols } : {}),
    thesis: input.thesis,
    riskProfile: input.riskProfile,
    mode: input.mode,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.mode === "strategy_fit" ? { limit: input.fitLimit } : {}),
    // Issue #391: Pass selected strategies as allowedStrategies filter
    ...(input.selectedStrategies && input.selectedStrategies.length > 0 ? { allowedStrategies: input.selectedStrategies } : {}),
  };
}

// Result view-model helpers (exported for tests) --------------------------

/** The best passing cell of a fit row: highest composite score wins. */
export function bestFitCell(row: ScanMatrixRow) {
  let best: { strategyType: string; label: string; compositeScore: number; probabilityOfProfit: number; netDebit: number; maxLoss: number } | null = null;
  for (const cell of row.cells ?? []) {
    if (!cell.best) continue;
    if (!best || cell.best.compositeScore > best.compositeScore) {
      best = {
        strategyType: cell.strategyType,
        label: cell.best.label,
        compositeScore: cell.best.compositeScore,
        probabilityOfProfit: cell.best.probabilityOfProfit,
        netDebit: cell.best.netDebit,
        maxLoss: cell.best.maxLoss,
      };
    }
  }
  return best;
}

/** Coverage accounting with honest fallbacks for partial payloads. */
export function scanCounts(result: OpportunityScanResponse) {
  const gate = result.gate ?? { fit: 0, borderline: 0, noFit: 0 };
  const evaluated = result.coverage?.evaluated ?? gate.fit + gate.borderline + gate.noFit;
  const scanned = result.coverage?.scanned ?? result.scanned ?? 0;
  const skipped = result.coverage?.errors ?? (result.skipped ?? []).length;
  return { gate, evaluated, scanned, skipped };
}

/** The explicit no-fit statement (acceptance: never an empty table). */
export function noFitMessage(result: OpportunityScanResponse): string {
  const { gate, evaluated, skipped } = scanCounts(result);
  return `No names fit under the current gate — ${evaluated} evaluated, ${gate.borderline} borderline, ${skipped} skipped.`;
}

function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtEntry(netDebit: number | null | undefined): string {
  if (netDebit === null || netDebit === undefined || !Number.isFinite(netDebit)) return "—";
  return netDebit >= 0 ? `${fmtMoney(netDebit)} debit` : `${fmtMoney(-netDebit)} credit`;
}

function fmtPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Target price + EM-units suffix as text. The target's provenance
 *  is NOT part of this string since slice 3 — it renders as a chip
 *  (TargetSourceChip) next to the target. */
function fmtTarget(price: number | null | undefined, emUnits: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return "—";
  const em = emUnits !== null && emUnits !== undefined && Number.isFinite(emUnits)
    ? ` · ${emUnits >= 0 ? "+" : ""}${emUnits.toFixed(2)} EM`
    : "";
  return `${fmtMoney(price)}${em}`;
}

// Slice 3 view-model helpers (exported for tests) -------------------------

/** Chip copy for a target's provenance (issues #19, #23, #25). The
 *  wording follows resolveScanTarget's own semantics in
 *  opportunityScanner.ts: "stated" = a target stated outright (the
 *  per-name absolute override, or the shared statedTarget scoped to
 *  its own symbol); "percent" = a per-name override stated as a
 *  percent of spot; "em" = a per-name override stated in
 *  expected-move units; "thesis" = derived from the thesis
 *  (expected-move-based when the symbol's chain yields an estimate,
 *  the legacy spot factor when not). */
export const TARGET_SOURCE_LABELS: Record<ScanTargetSource, string> = {
  stated: "stated target",
  percent: "stated % target",
  thesis: "thesis-derived target",
  em: "expected-move target",
};

/** The target-provenance chip rendered next to every displayed
 *  target. A null or unknown source renders NO chip — provenance is
 *  never guessed. */
export function TargetSourceChip({ source }: { source: ScanTargetSource | null | undefined }) {
  if (!source) return null;
  const label = TARGET_SOURCE_LABELS[source];
  if (!label) return null;
  return <span className="scp-badge scp-chip-target">{label}</span>;
}

// Slice 2 view-model helpers (exported for tests) -------------------------

/**
 * Board column order: the union of strategy types across all rows,
 * in first-appearance order (rows in matrix order, cells in cell
 * order). Derived from the matrix alone, so the board renders even
 * when a payload carries no roll-up.
 */
export function matrixStrategyTypes(rows: ScanMatrixRow[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const cell of row.cells ?? []) {
      if (!seen.includes(cell.strategyType)) seen.push(cell.strategyType);
    }
  }
  return seen;
}

/** A cell's most frequent rejection reason (ties keep the histogram's
 *  own order); null when nothing was rejected with a recorded reason. */
export function topRejectionReason(
  rejectionReasons: Record<string, number> | undefined,
): { reason: string; count: number } | null {
  let top: { reason: string; count: number } | null = null;
  for (const [reason, count] of Object.entries(rejectionReasons ?? {})) {
    if (!top || count > top.count) top = { reason, count };
  }
  return top;
}

/**
 * Build the HITL-preview handoff for a matrix cell's best candidate.
 * Faithful replication of OptionsResearchPanel's module-local
 * toTradeContext (same field mapping, same label format, quantity 1)
 * for the flattened ScanMatrixCellBest shape: the symbol comes from
 * the matrix row (the cell best carries none) and the action follows
 * the run's thesis exactly as the research panel derives it. The cell
 * best carries no spot price, so underlyingPrice is omitted — the
 * research panel's value comes from its own screened chain, not from
 * the candidate, and inventing one here would misstate the preview.
 */
export function matrixCellTradeContext(
  row: ScanMatrixRow,
  cell: ScanMatrixCell,
  thesis?: OptionThesis,
): TradeOrderContext {
  const best = cell.best as ScanMatrixCellBest;
  const optionLegs = best.legs.map((leg) => ({
    securityType: leg.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
    side: leg.side,
    quantity: leg.quantity,
    optionType: leg.optionType === "STOCK" ? undefined : leg.optionType,
    strike: leg.optionType === "STOCK" ? undefined : leg.strike,
    expirationDate: leg.optionType === "STOCK" ? undefined : leg.expirationDate,
  }));
  return {
    assetClass: optionLegs.some((leg) => leg.securityType === "OPTN") ? "options" : "equity",
    symbol: row.symbol,
    action: thesis === "bearish" ? "SELL_SHORT" : "BUY",
    quantity: 1,
    label: `${best.label} (${best.expirationDate}), max loss $${best.maxLoss}`,
    legs: best.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol} @ $${leg.entryPrice.toFixed(2)}`),
    optionLegs,
    strategyNetDebit: best.netDebit,
  };
}

// Slice 5 view-model helpers (exported for tests) ------------------------

/** History rows show a shortened run id; the full id stays in the
 *  row's title attribute (copyable), never truncated away silently. */
export function shortenRunId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Build the re-run request for a stored run, for replay through the
 * normal unified scan path.
 *
 * Runs recorded since issue #103 carry the caller's ORIGINAL request
 * (requestSnapshot.request: the resolved symbols, every expressed
 * unified field, the profile selection, the stated target and DTE
 * bounds the unified request now carries). Those replay verbatim —
 * a true re-run, nothing dropped (a screen filter, when the original
 * scan ran under one, still has no unified field and is named).
 *
 * Legacy runs (recorded before #103) have only the snapshot to map
 * from. What it carries (ScanRequestSnapshot in
 * opportunityScanner.ts): the EFFECTIVE template (thesis, targetDate,
 * minDte/maxDte, maxPlannedLoss, minRewardRisk, allowedStrategies,
 * statedTarget, perSymbol — post-profile-merge), the mode, the risk
 * profile, an optional screen filter, and the applied profile object.
 * It does NOT record the requested symbol list, the pagination
 * limit/offset, expectedIvDirection, or optimizationBias.
 *
 * For those runs the snapshot's stated target, DTE bounds, and screen
 * filter cannot be replayed faithfully — the template is the
 * post-profile-merge view, and pinning its merged bounds over a
 * re-resolved profile would freeze values the profile may have
 * legitimately changed since — so they are returned in `dropped` and
 * named in the UI's re-run note, never silently discarded. The symbol
 * list is rebuilt from the stored result's matrix rows: the batch
 * the original run actually scanned, in batch order (symbols the
 * original request asked for beyond the scan cap were truncated at
 * scan time and recorded nowhere — that loss is also named in
 * `dropped`). The applied profile replays by id, so the fresh run
 * re-resolves the profile's CURRENT version and its fit gate,
 * exactly as a new run would.
 */
export function buildRerunRequest(run: { result: OpportunityScanResult }): { body: UnifiedOptionsRequest; dropped: string[] } {
  const result = run.result;
  const snapshot = result.requestSnapshot;
  const record = snapshot?.request;
  if (record) {
    const dropped: string[] = [];
    if (snapshot?.strategyFilter) dropped.push("screen filter");
    const body: UnifiedOptionsRequest = {
      action: "opportunities",
      ...(record.symbols && record.symbols.length > 0 ? { symbols: record.symbols } : {}),
      ...(record.thesis !== undefined ? { thesis: record.thesis } : {}),
      ...(record.targetDate !== undefined ? { targetDate: record.targetDate } : {}),
      ...(record.expectedIvDirection !== undefined ? { expectedIvDirection: record.expectedIvDirection } : {}),
      ...(record.maxPlannedLoss !== undefined ? { maxPlannedLoss: record.maxPlannedLoss } : {}),
      ...(record.minRewardRisk !== undefined ? { minRewardRisk: record.minRewardRisk } : {}),
      ...(record.allowedStrategies !== undefined ? { allowedStrategies: record.allowedStrategies } : {}),
      ...(record.optimizationBias !== undefined ? { optimizationBias: record.optimizationBias } : {}),
      ...(record.perSymbol !== undefined ? { perSymbol: record.perSymbol } : {}),
      ...(record.statedTarget !== undefined ? { statedTarget: record.statedTarget } : {}),
      ...(record.minDte !== undefined ? { minDte: record.minDte } : {}),
      ...(record.maxDte !== undefined ? { maxDte: record.maxDte } : {}),
      ...(record.riskProfile !== undefined ? { riskProfile: record.riskProfile } : {}),
      ...(record.mode !== undefined ? { mode: record.mode } : {}),
      ...(record.profileId !== undefined ? { profileId: record.profileId } : {}),
      ...(record.profileName !== undefined ? { profileName: record.profileName } : {}),
      ...(record.limit !== undefined ? { limit: record.limit } : {}),
      ...(record.offset !== undefined ? { offset: record.offset } : {}),
    };
    return { body, dropped };
  }
  const template = snapshot?.template;
  const dropped: string[] = [];
  if (template?.statedTarget) dropped.push("stated target");
  if (template?.minDte !== undefined || template?.maxDte !== undefined) dropped.push("DTE bounds (min/max DTE)");
  if (snapshot?.strategyFilter) dropped.push("screen filter");
  if ((result.coverage?.truncated ?? 0) > 0) {
    dropped.push(`${result.coverage.truncated} truncated symbol(s) — the original request's full symbol list was not recorded`);
  }
  const symbols = (result.matrix ?? []).map((row) => row.symbol);
  const body: UnifiedOptionsRequest = {
    action: "opportunities",
    ...(symbols.length > 0 ? { symbols } : {}),
    ...(template?.thesis ? { thesis: template.thesis } : {}),
    ...(template?.targetDate ? { targetDate: template.targetDate } : {}),
    ...(template?.maxPlannedLoss !== undefined ? { maxPlannedLoss: template.maxPlannedLoss } : {}),
    ...(template?.minRewardRisk !== undefined ? { minRewardRisk: template.minRewardRisk } : {}),
    ...(template?.allowedStrategies && template.allowedStrategies.length > 0
      ? { allowedStrategies: template.allowedStrategies }
      : {}),
    ...(template?.perSymbol ? { perSymbol: template.perSymbol } : {}),
    ...(snapshot?.riskProfile ? { riskProfile: snapshot.riskProfile } : {}),
    mode: snapshot?.mode ?? result.mode,
    ...(snapshot?.profile?.id ? { profileId: snapshot.profile.id } : {}),
  };
  return { body, dropped };
}

/**
 * The run-over-run diff view (issue #27): renders the server's
 * ScanRunDiff verbatim — new fits, dropped fits, still fitting,
 * gate-bucket changes, added/removed symbols. When nothing changed
 * (the still-fitting set may still be non-empty), an explicit
 * no-changes state renders instead of a blank panel.
 */
export function ScanDiffView({ data }: { data: ScanRunDiffResult }) {
  const { diff } = data;
  const nothingChanged =
    diff.newFits.length === 0 &&
    diff.droppedFits.length === 0 &&
    diff.bucketChanges.length === 0 &&
    diff.addedSymbols.length === 0 &&
    diff.removedSymbols.length === 0;
  const symbolChips = (symbols: string[], className: string) => (
    <span className="scp-diff-chips">
      {symbols.map((symbol) => (
        <span key={symbol} className={`scp-badge ${className}`}>{symbol}</span>
      ))}
    </span>
  );
  return (
    <div className="scp-diff">
      <div className="scp-results-head">
        <strong>Scan diff</strong>
        <span className="scp-asof">
          {new Date(data.from.generatedAt).toLocaleString()} → {new Date(data.to.generatedAt).toLocaleString()}
        </span>
      </div>
      {nothingChanged && (
        <div className="scp-nofit" role="note">No changes between these runs.</div>
      )}
      {diff.newFits.length > 0 && (
        <div className="scp-diff-line">New fits: {symbolChips(diff.newFits, "scp-badge-fit")}</div>
      )}
      {diff.droppedFits.length > 0 && (
        <div className="scp-diff-line">Dropped fits: {symbolChips(diff.droppedFits, "scp-badge-no_fit")}</div>
      )}
      {diff.stillFitting.length > 0 && (
        <div className="scp-diff-line">
          Still fitting ({diff.stillFitting.length}): {symbolChips(diff.stillFitting, "scp-badge-fit")}
        </div>
      )}
      {diff.bucketChanges.length > 0 && (
        <div className="scp-diff-line">
          Bucket changes:{" "}
          <span className="scp-diff-chips">
            {diff.bucketChanges.map((change) => (
              <span key={change.symbol} className="scp-diff-change">
                <strong>{change.symbol}</strong>{" "}
                <span className={`scp-badge scp-badge-${change.from}`}>{change.from}</span>
                {" → "}
                <span className={`scp-badge scp-badge-${change.to}`}>{change.to}</span>
              </span>
            ))}
          </span>
        </div>
      )}
      {diff.addedSymbols.length > 0 && (
        <div className="scp-diff-line">Added symbols: {symbolChips(diff.addedSymbols, "")}</div>
      )}
      {diff.removedSymbols.length > 0 && (
        <div className="scp-diff-line">Removed symbols: {symbolChips(diff.removedSymbols, "")}</div>
      )}
    </div>
  );
}

// Results (presentational — exported for render tests) --------------------

export interface ScanRunContext {
  mode: ScanMode;
  profileLabel: string | null;
  /** The thesis the run was submitted with (snapshotted like the
   *  mode): the matrix-cell trade handoff derives its action from it,
   *  the same way the research panel derives it from its thesis. */
  thesis?: OptionThesis;
}

/**
 * Per-strategy-type roll-up cards (issue #26 surface). "Passed" on
 * this surface is the scanner's RISK SCREEN pass, counted from the
 * matrix cells — the backend keeps it distinct from the single-name
 * ledger's acceptance-rule passes and from fit-gate qualification,
 * and the copy here keeps that distinction in front of the user.
 * Renders nothing when the scan carried no roll-up.
 */
export function TypeRollupCards({ rollup }: { rollup: ScanTypeRollup[] }) {
  if (!rollup || rollup.length === 0) return null;
  return (
    <div className="scp-rollup-wrap">
      <div className="scp-subhead">By strategy type</div>
      <div className="scp-legend">
        Risk-screen roll-up: counts are candidates that passed the scanner's risk screen.
        A screen pass is not an acceptance-rule pass and not a fit-gate qualification.
      </div>
      <div className="scp-rollup">
        {rollup.map((entry) => (
          <Card padding="none" className="scp-rollup-card" key={entry.strategyType}>
            <div className="scp-rollup-type">{entry.strategyType}</div>
            <div className="scp-rollup-line">
              {entry.symbolsPassed} of {entry.symbolsEvaluated} symbols passed the screen
            </div>
            <div className="scp-rollup-meta">
              {entry.passedCount} passed · {entry.rejectedCount} rejected of {entry.evaluatedCount} candidates
            </div>
            {entry.bestOverall ? (
              <div className="scp-rollup-best">
                Best: <strong>{entry.bestOverall.symbol}</strong> — {entry.bestOverall.label} · composite{" "}
                {entry.bestOverall.compositeScore.toFixed(1)} · POP {fmtPct(entry.bestOverall.probabilityOfProfit)}
              </div>
            ) : (
              <div className="scp-rollup-best scp-muted">No passing candidate</div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

const VERDICT_LABELS: Record<ScanMatrixRow["verdict"], string> = {
  pass: "PASS",
  no_pass: "NO PASS",
  skipped: "SKIPPED",
};

/**
 * The names × strategy-types fit matrix as a board (issue #22
 * surface). Verdicts are screen verdicts only — the row's fit-gate
 * badge rides next to the verdict chip so the two layers are never
 * conflated. A cell whose type produced a passing candidate is a
 * button into the hub's existing HITL preview when the panel was
 * given onPreviewTrade; the panel itself places no orders.
 */
export function MatrixBoard({
  matrix,
  thesis,
  onPreviewTrade,
}: {
  matrix: ScanMatrixRow[];
  thesis?: OptionThesis;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
}) {
  if (!matrix || matrix.length === 0) return null;
  const types = matrixStrategyTypes(matrix);
  return (
    <div className="scp-matrix" id="scanner-matrix-board">
      <div className="scp-subhead">Fit matrix</div>
      <div className="scp-legend">
        Pass = screen pass only: at least one candidate passed the scanner's risk screen in that
        type. Qualification is the fit gate's job — see the fit / borderline / no fit badge on each row.
      </div>
      <Table
        containerClassName="scp-matrix-scroll"
        columns={[
          { key: "symbol", header: "Symbol", cellClassName: "scp-matrix-symbol", render: (row: ScanMatrixRow & { __rowKey: string }) => (<><strong>{row.symbol}</strong>{" "}<span className={`scp-badge scp-badge-verdict-${row.verdict}`}>{VERDICT_LABELS[row.verdict]}</span>{row.gateBucket && (<> <span className={`scp-badge scp-badge-${row.gateBucket}`}>{row.gateBucket}</span></>)}{row.verdict !== "skipped" && (<div className="scp-row-meta">Target {fmtTarget(row.targetPrice, row.targetEmUnits)}<TargetSourceChip source={row.targetSource} /></div>)}{row.gateReasons && row.gateReasons.length > 0 && (<div className="scp-reasons">{row.gateReasons.join("; ")}</div>)}</>) },
          ...types.map((t) => ({
            key: t,
            header: t,
            render: (row: ScanMatrixRow & { __rowKey: string }) => {
              if (row.verdict === "skipped") {
                return t === types[0] ? `Skipped — ${row.skipReason ?? "not evaluated"}` : "";
              }
              const cell = (row.cells ?? []).find((c) => c.strategyType === t);
              if (!cell) return "—";
              if (!cell.best) {
                const top = topRejectionReason(cell.rejectionReasons);
                return (<><div>{cell.passedCount}/{cell.evaluatedCount} passed · {cell.rejectedCount} rejected</div>{top && (<div className="scp-cell-reason" title={top.reason}>top rejection: {top.reason} ×{top.count}</div>)}</>);
              }
              const content = (<><div className="scp-cell-score">{cell.best.compositeScore.toFixed(1)}</div><div className="scp-cell-caption">composite</div><div>{cell.passedCount}/{cell.evaluatedCount} passed</div><div className="scp-cell-label">{cell.best.label}</div></>);
              return onPreviewTrade ? (<Button variant="ghost" className="scp-cell-btn" title={`Preview ${cell.best.label} for ${row.symbol}`} onClick={() => onPreviewTrade(matrixCellTradeContext(row, cell, thesis))}>{content}</Button>) : content;
            },
          })),
        ]}
        rows={matrix.map((row, idx) => ({ ...row, __rowKey: `${row.symbol}-${idx}` }))}
        rowKey={(row) => row.__rowKey}
      />
    </div>
  );
}

export function ScanResultsView({ result, runContext, onPreviewTrade, storedRun }: { result: OpportunityScanResponse; runContext: ScanRunContext; onPreviewTrade?: (ctx: TradeOrderContext) => void; storedRun?: ScanRunDetail | null }) {
  const mode = runContext.mode;
  const { gate, evaluated, scanned, skipped } = scanCounts(result);
  const generatedAt = result.generatedAt || result.meta?.generatedAt;
  const opportunities = result.opportunities ?? [];
  const fits = result.fits ?? [];
  const assumptions = result.assumptions ?? [];
  const borderline = result.borderline ?? [];
  const matrix = result.matrix ?? [];
  const typeRollup = result.typeRollup ?? [];

  // Issue #126 (PR-C): result-set downloads of THIS run (the one
  // being viewed), beside the PDF report. When the view shows a
  // stored run from history, the export is built from that stored
  // run — never from the latest run or the live form state.
  const exportRun = storedRun
    ? scanExportRunFromStored(storedRun)
    : scanExportRunFromResult(result);


  return (
    <div className="scp-results">
      <div className="scp-results-head">
        <strong>Mode: {MODE_LABELS[mode]}</strong>
        <Button
        variant="accent"
        tone="subtle"
        size="sm"
          className="scanner-export-csv"
          onClick={() => downloadScanExport(exportRun, "results-csv")}
          title="Download this run's result rows as CSV"
        >
          ⬇ CSV results
        </Button>
        <Button
        variant="accent"
        tone="subtle"
        size="sm"
          className="scanner-export-json"
          onClick={() => downloadScanExport(exportRun, "run-json")}
          title="Download this run's full stored result as JSON"
        >
          ⬇ JSON run
        </Button>
        {/* Issue #126 (PR-D): the PDF link exists only when THIS run
            has its own reportUrl. The previous keyless fallback
            ("/api/options/report.pdf" with no key) serves the LATEST
            run's PDF — a viewed historical run silently downloaded a
            different run's report, the wrong-run class #297 fixed
            for the stock screener. No reportUrl → no PDF link. */}
        {result.reportUrl && (
          <a
            href={result.reportUrl}
            download
            style={{
              fontSize: "var(--font-size-body-sm)",
              padding: "var(--space-1-5) var(--space-3)",
              borderRadius: "4px",
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              textDecoration: "none",
              marginLeft: "auto",
            }}
          >
            📄 Download PDF report
          </a>
        )}
        {result.profileRef && (
          <span className="scp-badge scp-badge-profile">Profile: {result.profileRef.name} v{result.profileRef.version}</span>
        )}
        {!result.profileRef && runContext.profileLabel && (
          <span className="scp-badge">Profile: {runContext.profileLabel}</span>
        )}
        {generatedAt && <span className="scp-asof">Data as of {new Date(generatedAt).toLocaleString()}</span>}
        {result.modelVersion && <span className="scp-asof">scan model v{result.modelVersion}</span>}
      </div>
      <div className="scp-counts">
        {scanned} scanned · {evaluated} evaluated · {skipped} skipped
        {mode === "strategy_fit" && (
          <> · <strong>{result.fitsTotal ?? 0} fits</strong> · gate: {gate.fit} fit / {gate.borderline} borderline / {gate.noFit} no fit</>
        )}
        {mode === "per_name_best" && (
          <> · gate: {gate.fit} fit / {gate.borderline} borderline / {gate.noFit} no fit</>
        )}
        {result.persisted && result.scanRunId && <> · saved as scan run {result.scanRunId}</>}
      </div>
      <div className="scp-legend">
        Composite scores are normalized 0–100 and comparable across names; targets are
        volatility-normalized — shown in expected-move (EM) units where the target is EM-based.
      </div>

      <TypeRollupCards rollup={typeRollup} />

      {mode === "per_name_best" && (
        opportunities.length > 0 ? (
          <Table
            columns={[
              { key: "symbol", header: "Symbol", render: (row) => (<strong>{row.symbol}</strong>) },
              { key: "strategy", header: "Strategy", render: (row) => { const candidate = row.pick?.best?.candidate; return candidate ? candidate.label : row.pick?.status === "no_trade" ? "No qualifying trade" : "—"; } },
              { key: "score", header: "Composite score", render: (row) => { const score = row.pick?.best?.compositeScore ?? row.score; return typeof score === "number" && Number.isFinite(score) ? score.toFixed(1) : "—"; } },
              { key: "pop", header: "POP", render: (row) => fmtPct(row.pick?.best?.candidate?.modelImpliedProbabilityOfProfit) },
              { key: "target", header: "Target", render: (row) => (<>{fmtTarget(row.targetPrice, row.targetEmUnits)}<TargetSourceChip source={row.targetSource} /></>) },
              { key: "entry", header: "Entry", render: (row) => fmtEntry(row.pick?.best?.candidate?.netDebit) },
              { key: "maxloss", header: "Max loss", render: (row) => fmtMoney(row.pick?.best?.candidate?.maxLoss) },
              { key: "gate", header: "Gate", render: (row) => (<><span className={`scp-badge scp-badge-${row.gateBucket ?? "none"}`}>{row.gateBucket ?? "—"}</span>{row.gateReasons && row.gateReasons.length > 0 && (<div className="scp-reasons">{row.gateReasons.join("; ")}</div>)}</>) },
            ]}
            rows={opportunities.map((row, idx) => ({ ...row, __rowKey: `${row.symbol}-${idx}` }))}
            rowKey={(row) => row.__rowKey}
          />
        ) : (
          <div className="scp-nofit" role="note">No qualifying trades were returned for this scan.</div>
        )
      )}

      {mode === "strategy_fit" && (
        (result.fitsTotal ?? 0) === 0 ? (
          <div className="scp-nofit" role="note">{noFitMessage(result)}</div>
        ) : fits.length > 0 ? (
          <Table
            columns={[
              { key: "symbol", header: "Symbol", render: (row) => (<strong>{row.symbol}</strong>) },
              { key: "strategy", header: "Best fit strategy", render: (row) => { const best = bestFitCell(row); return best ? best.label : "—"; } },
              { key: "score", header: "Composite score", render: (row) => { const best = bestFitCell(row); return best ? best.compositeScore.toFixed(1) : "—"; } },
              { key: "pop", header: "POP", render: (row) => fmtPct(bestFitCell(row)?.probabilityOfProfit) },
              { key: "target", header: "Target", render: (row) => (<>{fmtTarget(row.targetPrice, row.targetEmUnits)}<TargetSourceChip source={row.targetSource} /></>) },
              { key: "entry", header: "Entry", render: (row) => fmtEntry(bestFitCell(row)?.netDebit) },
              { key: "maxloss", header: "Max loss", render: (row) => fmtMoney(bestFitCell(row)?.maxLoss) },
              { key: "gate", header: "Gate", render: (row) => (<><span className={`scp-badge scp-badge-${row.gateBucket ?? "none"}`}>{row.gateBucket ?? "—"}</span>{row.gateReasons && row.gateReasons.length > 0 && (<div className="scp-reasons">{row.gateReasons.join("; ")}</div>)}</>) },
            ]}
            rows={fits.map((row, idx) => ({ ...row, __rowKey: `${row.symbol}-${idx}` }))}
            rowKey={(row) => row.__rowKey}
          />
        ) : (
          <div className="scp-nofit" role="note">{noFitMessage(result)}</div>
        )
      )}

      {mode === "strategy_fit" && borderline.length > 0 && (
        <div className="scp-note scp-borderline">
          Borderline (evaluated, below the gate):{" "}
          {borderline.map((r, idx) => (
            <span key={`${r.symbol}-${idx}`} className="scp-badge scp-badge-borderline">{r.symbol}</span>
          ))}
        </div>
      )}

      <MatrixBoard matrix={matrix} thesis={runContext.thesis} onPreviewTrade={onPreviewTrade} />

      {assumptions.length > 0 && (
        <div className="scp-assumptions">
          <div className="scp-subhead">Assumptions &amp; disclosures</div>
          <ul>
            {assumptions.map((line, idx) => <li key={idx}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// Profile form model (exported for tests) ---------------------------------

export interface ProfileFormState {
  name: string;
  thesis: string;
  allowedStrategies: string;
  maxPlannedLoss: string;
  minRewardRisk: string;
  minDte: string;
  maxDte: string;
  eventPolicy: string;
  expectedIvDirection: string;
  optimizationBias: string;
  riskProfile: string;
  mode: string;
  gateEnabled: boolean;
  gateMinCompositeScore: string;
  gateMinProbabilityOfProfit: string;
  gateRequireFresh: boolean;
  gateMinConfidence: string;
}

export function emptyProfileForm(): ProfileFormState {
  return {
    name: "", thesis: "", allowedStrategies: "", maxPlannedLoss: "", minRewardRisk: "",
    minDte: "", maxDte: "", eventPolicy: "", expectedIvDirection: "", optimizationBias: "",
    riskProfile: "", mode: "",
    gateEnabled: false, gateMinCompositeScore: "", gateMinProbabilityOfProfit: "",
    gateRequireFresh: true, gateMinConfidence: "",
  };
}

export function profileToForm(profile: StrategyProfile): ProfileFormState {
  const num = (v: number | undefined) => (v === undefined ? "" : String(v));
  return {
    name: profile.name,
    thesis: profile.thesis ?? "",
    allowedStrategies: (profile.allowedStrategies ?? []).join(", "),
    maxPlannedLoss: num(profile.maxPlannedLoss),
    minRewardRisk: num(profile.minRewardRisk),
    minDte: num(profile.minDte),
    maxDte: num(profile.maxDte),
    eventPolicy: profile.eventPolicy ?? "",
    expectedIvDirection: profile.expectedIvDirection ?? "",
    optimizationBias: num(profile.optimizationBias),
    riskProfile: profile.riskProfile ?? "",
    mode: profile.mode ?? "",
    gateEnabled: !!profile.fitGate,
    gateMinCompositeScore: num(profile.fitGate?.minCompositeScore),
    gateMinProbabilityOfProfit: num(profile.fitGate?.minProbabilityOfProfit),
    gateRequireFresh: profile.fitGate?.requireFresh ?? true,
    gateMinConfidence: profile.fitGate?.minConfidence ?? "",
  };
}

/**
 * Assemble the spec a Save click submits. Empty optional fields are
 * OMITTED (undefined — never null/"") so the profile constrains only
 * what the user actually set. Non-numeric text in a numeric field is a
 * local problem (named, never silently dropped or sent as NaN); all
 * semantic validation (ranges, unknown strategy ids, DTE ordering) is
 * the server's, and its 400 message surfaces verbatim.
 */
export function buildProfileSpec(form: ProfileFormState): { spec: StrategyProfileSpec; problems: string[] } {
  const spec: StrategyProfileSpec = {};
  const problems: string[] = [];
  const num = (text: string, field: string, label: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      problems.push(`${label} must be a number.`);
      return;
    }
    (spec as Record<string, unknown>)[field] = value;
  };
  if (form.thesis) spec.thesis = form.thesis as OptionThesis;
  const types = form.allowedStrategies.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  if (types.length > 0) spec.allowedStrategies = types;
  num(form.maxPlannedLoss, "maxPlannedLoss", "Max planned loss");
  num(form.minRewardRisk, "minRewardRisk", "Min reward/risk");
  num(form.minDte, "minDte", "Min DTE");
  num(form.maxDte, "maxDte", "Max DTE");
  if (form.eventPolicy) spec.eventPolicy = form.eventPolicy as "warn" | "exclude";
  if (form.expectedIvDirection) spec.expectedIvDirection = form.expectedIvDirection as ExpectedIvDirection;
  num(form.optimizationBias, "optimizationBias", "Optimization bias");
  if (form.riskProfile) spec.riskProfile = form.riskProfile as RiskProfileValue;
  if (form.mode) spec.mode = form.mode as ScanMode;
  if (form.gateEnabled) {
    const gate: NonNullable<StrategyProfileSpec["fitGate"]> = { requireFresh: form.gateRequireFresh };
    const gateNum = (text: string, field: "minCompositeScore" | "minProbabilityOfProfit", label: string) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      const value = Number(trimmed);
      if (!Number.isFinite(value)) {
        problems.push(`${label} must be a number.`);
        return;
      }
      gate[field] = value;
    };
    gateNum(form.gateMinCompositeScore, "minCompositeScore", "Gate min score");
    gateNum(form.gateMinProbabilityOfProfit, "minProbabilityOfProfit", "Gate min POP");
    if (form.gateMinConfidence) gate.minConfidence = form.gateMinConfidence as "LOW" | "MEDIUM" | "HIGH";
    spec.fitGate = gate;
  }
  return { spec, problems };
}

/** One-line constraint summary for a profile list row: only the
 *  constraints the profile actually sets, in a fixed order. */
export function profileSummary(profile: StrategyProfile): string {
  const parts: string[] = [];
  if (profile.thesis) parts.push(`thesis ${profile.thesis}`);
  if (profile.maxPlannedLoss !== undefined) parts.push(`max loss $${profile.maxPlannedLoss}`);
  if (profile.minRewardRisk !== undefined) parts.push(`min R/R ${profile.minRewardRisk}`);
  if (profile.minDte !== undefined || profile.maxDte !== undefined) {
    parts.push(profile.minDte !== undefined && profile.maxDte !== undefined
      ? `DTE ${profile.minDte}–${profile.maxDte}`
      : profile.minDte !== undefined ? `DTE ≥${profile.minDte}` : `DTE ≤${profile.maxDte}`);
  }
  if (profile.allowedStrategies && profile.allowedStrategies.length > 0) parts.push(`types: ${profile.allowedStrategies.join(", ")}`);
  if (profile.eventPolicy) parts.push(`events ${profile.eventPolicy}`);
  if (profile.expectedIvDirection) parts.push(`IV ${profile.expectedIvDirection}`);
  if (profile.optimizationBias !== undefined) parts.push(`bias ${profile.optimizationBias}`);
  if (profile.riskProfile) parts.push(profile.riskProfile);
  if (profile.mode) parts.push(MODE_LABELS[profile.mode]);
  if (profile.fitGate) {
    const g: string[] = [];
    if (profile.fitGate.minCompositeScore !== undefined) g.push(`score ≥${profile.fitGate.minCompositeScore}`);
    if (profile.fitGate.minProbabilityOfProfit !== undefined) g.push(`POP ≥${(profile.fitGate.minProbabilityOfProfit * 100).toFixed(0)}%`);
    if (profile.fitGate.requireFresh !== undefined) g.push(profile.fitGate.requireFresh ? "fresh only" : "stale ok");
    if (profile.fitGate.minConfidence !== undefined) g.push(`≥${profile.fitGate.minConfidence}`);
    if (g.length > 0) parts.push(`gate: ${g.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No constraints set";
}

// Panel -------------------------------------------------------------------

export interface ScannerPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  /** HITL preview handoff (the hub's existing order-ticket handler):
   *  matrix cells with a passing candidate offer a preview through
   *  it. Absent → cells render non-interactive. */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
}


// Strategy catalog browser (issue #275) ------------------------------------

interface CatalogStrategy {
  id: string;
  label: string;
  category: string;
  description: string;
  theses: string[];
  aliases: string[];
}

const THESIS_COLORS: Record<string, string> = {
  bullish: "var(--color-success)",
  bearish: "var(--color-danger)",
  range_bound: "var(--color-warning)",
  large_move: "var(--color-purple)",
};

function StrategyCatalogBrowser() {
  const [strategies, setStrategies] = useState<CatalogStrategy[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/trading/options/catalog");
      if (!res.ok) return;
      const data = (await res.json()) as { strategies?: CatalogStrategy[] };
      // Issue #1334: never render a label-less entry — resolve labels
      // by id from the client library as a backstop.
      setStrategies(resolveCatalogStrategyLabels(data.strategies ?? []));
      setLoaded(true);
    } catch {
      // Catalog unavailable — browser stays empty.
    }
  }, []);

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  const filtered =
    filter === "all" ? strategies : strategies.filter((st) => st.theses.includes(filter));
  const theses = ["all", "bullish", "bearish", "range_bound", "large_move"];

  return (
    <div style={{ margin: "1rem 0", border: "1px solid var(--color-border-medium)", borderRadius: 6, padding: "var(--space-3)" }}>
      <Button
      variant="ghost"
        onClick={() => setOpen(!open)}
      >
        {open ? "▼" : "▶"} Strategy catalog ({strategies.length || "…" } strategies)
      </Button>
      {open && (
        <div style={{ marginTop: "0.75rem" }}>
          <div style={{ marginBottom: "0.5rem" }}>
                        <PillGroup
              options={theses.map((t) => ({ id: t, label: t === "all" ? "All" : t.replace("_", " ") }))}
              value={filter}
              onChange={setFilter}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "var(--space-2)" }}>
            {filtered.map((st) => (
              <Card padding="sm" key={st.id}>
                <div style={{ fontWeight: 700 }}>{st.label}</div>
                <div style={{ color: "var(--color-text-muted)", margin: "0.25rem 0" }}>{st.description}</div>
                <div>
                  {st.theses.map((th) => (
                    <span
                      key={th}
                      style={{
                        display: "inline-block",
                        marginRight: "0.3rem",
                        padding: "var(--space-0-5) var(--space-2)",
                        borderRadius: 10,
                        fontSize: "var(--font-size-caption)",
                        fontWeight: 600,
                        color: THESIS_COLORS[th] ?? "var(--color-text-muted)",
                        border: `1px solid ${THESIS_COLORS[th] ?? "var(--color-border-medium)"}`,
                      }}
                    >
                      {th.replace("_", " ")}
                    </span>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ScannerPanel({ activeEnv, userLogin, onPreviewTrade }: ScannerPanelProps) {
  // Scan form state
  const [mode, setMode] = useState<ScanMode>("per_name_best");
  const [symbolsText, setSymbolsText] = useState("AAPL, MSFT, NVDA, AMZN, GOOGL");
  const [thesis, setThesis] = useState<OptionThesis>("bullish");
  const [riskProfile, setRiskProfile] = useState<RiskProfileValue>("balanced");
  const [profileId, setProfileId] = useState("");
  const [fitLimit, setFitLimit] = useState(25);
  // Issue #391: Selected strategy IDs for filtering (empty = all strategies)
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
  // Issue #391: Strategy catalog for the picker (loaded from API)
  const [strategyCatalog, setStrategyCatalog] = useState<CatalogStrategy[]>([]);
  // Issue #450: strategy selection happens in the shared StrategyLibraryModal
  const [strategyModalOpen, setStrategyModalOpen] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // Load strategy catalog on mount
  useEffect(() => {
    if (catalogLoaded) return;
    (async () => {
      try {
        const res = await fetch("/api/trading/options/catalog");
        if (!res.ok) return;
        const data = (await res.json()) as { strategies?: CatalogStrategy[] };
        // Issue #1334: same backstop as the browser list — the modal
        // renders `label`, so a label-less entry must never reach it.
        setStrategyCatalog(resolveCatalogStrategyLabels(data.strategies ?? []));
        setCatalogLoaded(true);
      } catch {
        // Catalog unavailable — multi-select stays empty.
      }
    })();
  }, [catalogLoaded]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [result, setResult] = useState<OpportunityScanResponse | null>(null);
  const [runContext, setRunContext] = useState<ScanRunContext | null>(null);

  // Profiles state
  const [profiles, setProfiles] = useState<StrategyProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profilesError, setProfilesError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormState>(emptyProfileForm());
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Scan history state (surface 5). The results area shows ONE thing
  // at a time: a fresh run (historicalNote null, diffResult null), a
  // stored run under its banner (historicalNote set), or a diff
  // (diffResult set, replacing the results). Any new scan clears the
  // other two, so a banner never lingers over a fresh run.
  const [history, setHistory] = useState<ScanRunSummary[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const [historicalNote, setHistoricalNote] = useState<string | null>(null);
  // The stored run currently being viewed (issue #126 PR-C): the
  // results view's CSV/JSON exports target THIS run. Set by viewRun,
  // cleared whenever a fresh scan result replaces the view.
  const [viewedRun, setViewedRun] = useState<ScanRunDetail | null>(null);
  const [rerunNote, setRerunNote] = useState("");
  const [diffResult, setDiffResult] = useState<ScanRunDiffResult | null>(null);
  const [diffError, setDiffError] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const runs = await listScanRuns(activeEnv, userLogin);
      setHistory(runs);
      setHistoryError("");
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "Failed to load scan history.");
    } finally {
      setHistoryLoaded(true);
    }
  }, [activeEnv, userLogin]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const loadProfiles = useCallback(async () => {
    try {
      const list = await listProfiles(activeEnv, userLogin);
      setProfiles(list);
      setProfilesError("");
      setProfileId((current) => (current && !list.some((p) => p.id === current) ? "" : current));
    } catch (cause) {
      setProfilesError(cause instanceof Error ? cause.message : "Failed to load strategy profiles.");
    } finally {
      setProfilesLoaded(true);
    }
  }, [activeEnv, userLogin]);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  const runScan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (scanning) return;
    const input: ScanFormInput = { symbolsText, thesis, riskProfile, mode, profileId, fitLimit, selectedStrategies };
    const chosen = profiles.find((p) => p.id === profileId);
    // Snapshot the run's context BEFORE the request: the results header
    // describes the run that produced them, not the live form.
    const context: ScanRunContext = {
      mode,
      profileLabel: chosen ? `${chosen.name} v${chosen.version}` : null,
      thesis,
    };
    setScanning(true);
    setScanError("");
    // A fresh run replaces whatever the results area showed — a
    // stored run's banner or a diff must never linger over it.
    setHistoricalNote(null);
    setViewedRun(null);
    setRerunNote("");
    setDiffResult(null);
    setDiffError("");
    try {
      const scan = await runOpportunityScan(activeEnv, userLogin, buildScanRequest(input));
      setResult(scan);
      setRunContext(context);
      // The run persists server-side (store attached on the unified
      // route), so the history list gains it.
      void loadHistory();
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : "Scanner request failed.");
    } finally {
      setScanning(false);
    }
  };

  /** View a stored run: its result renders through ScanResultsView
   *  under the saved-scan banner. Read-only — no scan runs and
   *  nothing new persists. The cell handoff's thesis comes from the
   *  stored result's requestSnapshot when it carries one. */
  const viewRun = async (summary: ScanRunSummary) => {
    setHistoryBusyId(summary.id);
    setHistoryError("");
    try {
      const run = await getScanRun(activeEnv, userLogin, summary.id);
      const stored = run.result;
      setResult(stored);
      setViewedRun(run);
      setRunContext({
        mode: stored.mode,
        profileLabel: stored.profileRef ? `${stored.profileRef.name} v${stored.profileRef.version}` : null,
        thesis: stored.requestSnapshot?.template?.thesis,
      });
      setHistoricalNote(stored.generatedAt || run.generatedAt);
      setRerunNote("");
      setScanError("");
      setDiffResult(null);
      setDiffError("");
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "Failed to load the saved scan run.");
    } finally {
      setHistoryBusyId(null);
    }
  };

  /** Re-run a stored run: replay its saved request through the same
   *  scan path the Run button uses (verbatim for runs recorded since
   *  issue #103; the snapshot mapping for legacy runs — see
   *  buildRerunRequest). The fresh result lands as a normal new run
   *  (and persists as a new history entry); anything a replay cannot
   *  carry is named in the note, never dropped silently. */
  const rerunRun = async (summary: ScanRunSummary) => {
    if (scanning) return;
    setHistoryBusyId(summary.id);
    setHistoryError("");
    try {
      const run = await getScanRun(activeEnv, userLogin, summary.id);
      const { body, dropped } = buildRerunRequest(run);
      const snapshotProfile = run.result.requestSnapshot?.profile;
      const context: ScanRunContext = {
        mode: body.mode ?? run.result.mode,
        profileLabel: snapshotProfile ? `${snapshotProfile.name} v${snapshotProfile.version}` : null,
        thesis: body.thesis,
      };
      setScanning(true);
      setScanError("");
      try {
        const scan = await runOpportunityScan(activeEnv, userLogin, body);
        setResult(scan);
        setRunContext(context);
        setHistoricalNote(null);
        setViewedRun(null);
        setDiffResult(null);
        setDiffError("");
        setRerunNote(
          `Re-ran the scan from ${new Date(run.generatedAt).toLocaleString()}.` +
          (dropped.length > 0
            ? ` Not replayed (the unified scan request cannot carry them): ${dropped.join("; ")}.`
            : ""),
        );
        void loadHistory();
      } catch (cause) {
        setScanError(cause instanceof Error ? cause.message : "Scanner request failed.");
      } finally {
        setScanning(false);
      }
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "Failed to load the saved scan run.");
    } finally {
      setHistoryBusyId(null);
    }
  };

  /** Diff two runs through the server route: fromId is the older run
   *  (the diff's `a`), toId the newer (its `b`). */
  const loadDiff = async (fromId: string, toId: string) => {
    setDiffError("");
    try {
      const data = await getScanRunDiff(activeEnv, userLogin, fromId, toId);
      setDiffResult(data);
    } catch (cause) {
      setDiffResult(null);
      setDiffError(cause instanceof Error ? cause.message : "Failed to diff scan runs.");
    }
  };

  const diffVsPrevious = (summary: ScanRunSummary, index: number) => {
    const previous = history[index + 1];
    if (!previous) return;
    void loadDiff(previous.id, summary.id);
  };

  const toggleCompare = (id: string) => {
    setCompareIds((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      // Keep at most two picks; a third pick replaces the oldest.
      return [...current.slice(-1), id];
    });
  };

  const compareSelected = () => {
    if (compareIds.length !== 2) return;
    const picked = compareIds
      .map((id) => history.find((run) => run.id === id))
      .filter((run): run is ScanRunSummary => !!run);
    if (picked.length !== 2) return;
    const [older, newer] = picked[0].generatedAt <= picked[1].generatedAt
      ? [picked[0], picked[1]]
      : [picked[1], picked[0]];
    void loadDiff(older.id, newer.id);
  };

  const openCreateForm = () => {
    setEditingId(null);
    setForm(emptyProfileForm());
    setFormError("");
    setSavedNote("");
    setConfirmDeleteId(null);
    setFormOpen(true);
  };

  const openEditForm = (profile: StrategyProfile) => {
    setEditingId(profile.id);
    setForm(profileToForm(profile));
    setFormError("");
    setSavedNote("");
    setConfirmDeleteId(null);
    setFormOpen(true);
  };

  const saveProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const name = form.name.trim();
    if (!name) {
      setFormError("Profile name is required.");
      return;
    }
    const { spec, problems } = buildProfileSpec(form);
    if (problems.length > 0) {
      setFormError(problems.join(" "));
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const saved = editingId
        ? await updateProfile(activeEnv, userLogin, editingId, name, spec)
        : await createProfile(activeEnv, userLogin, name, spec);
      await loadProfiles();
      setFormOpen(false);
      setEditingId(null);
      setSavedNote(`Saved profile "${saved.name}" — now v${saved.version}.`);
    } catch (cause) {
      // Server validation / duplicate-name 400s land here verbatim.
      setFormError(cause instanceof Error ? cause.message : "Failed to save strategy profile.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (profile: StrategyProfile) => {
    if (confirmDeleteId !== profile.id) {
      setConfirmDeleteId(profile.id);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await deleteProfile(activeEnv, userLogin, profile.id);
      if (editingId === profile.id) {
        setFormOpen(false);
        setEditingId(null);
      }
      await loadProfiles();
      setSavedNote(`Deleted profile "${profile.name}".`);
    } catch (cause) {
      setProfilesError(cause instanceof Error ? cause.message : "Failed to delete strategy profile.");
    }
  };

  const setField = (field: keyof ProfileFormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = event.target.type === "checkbox" ? (event.target as HTMLInputElement).checked : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  // Strategy picker button label (#2283 stream 4): computed once, rendered
  // static — the trailing "…" is a truncation suffix for the "N selected"
  // list, not a progress label, so it must not live in a Button ternary.
  const strategyPickerLabel =
    selectedStrategies.length === 0
      ? "Select strategies…"
      : `${selectedStrategies.length} selected: ${selectedStrategies
          .map((id) => strategyCatalog.find((s) => s.id === id)?.label || id)
          .slice(0, 3)
          .join(", ")}${selectedStrategies.length > 3 ? "…" : ""}`;

  return (
    <section className="scp-panel" id="section-opportunity-scanner" style={{ scrollMarginTop: 80 }}>
      <div className="scp-header">
        <h3>📈 Strategy/Symbol Scanner</h3>
        <span className="scp-asof">{activeEnv} environment</span>
      </div>
      <StrategyCatalogBrowser />

      <PillGroup
        ariaLabel="Scan mode"
        options={(Object.keys(MODE_LABELS) as ScanMode[]).map((value) => ({ id: value, label: MODE_LABELS[value] }))}
        value={mode}
        onChange={setMode}
      />

      <form className="scp-form" onSubmit={runScan}>
        <div className="scp-field scp-field-wide">
          <TextInput label="Symbols"
            id="scp-symbols"
            type="text"
            value={symbolsText}
            onChange={(e) => setSymbolsText(e.target.value)}
            placeholder="AAPL, MSFT, NVDA"
          />
        </div>
        <div className="scp-field">
          <Select label="Thesis" id="scp-thesis" value={thesis} onChange={(e) => setThesis(e.target.value as OptionThesis)}>
            {THESIS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
        <div className="scp-field scp-field-strategies">
          {/* Issue #450: one shared StrategyLibraryModal (multi-select).
              Names, descriptions and thesis tags preserved from the catalog. */}
          <FieldShell id="scp-strategies" label="Strategies" hint="(empty = all)">
            <Button
            variant="secondary"
              className="scp-strategy-picker-btn"
              onClick={() => setStrategyModalOpen(true)}
              disabled={strategyCatalog.length === 0}
             loading={strategyCatalog.length === 0}>
              {strategyPickerLabel}
            </Button>
          </FieldShell>
          {selectedStrategies.length > 0 && (
            <Button
            variant="secondary"
            size="sm"
              className="scp-clear-btn"
              onClick={() => setSelectedStrategies([])}
            >
              Clear ({selectedStrategies.length})
            </Button>
          )}
          <StrategyLibraryModal
            isOpen={strategyModalOpen}
            onClose={() => setStrategyModalOpen(false)}
            strategies={strategyCatalog}
            multiSelect
            selectedIds={selectedStrategies}
            onApply={setSelectedStrategies}
          />
        </div>
        <div className="scp-field">
          <Select label="Risk profile" id="scp-risk" value={riskProfile} onChange={(e) => setRiskProfile(e.target.value as RiskProfileValue)}>
            {RISK_PROFILE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </div>
        <div className="scp-field">
          <Select label="Strategy profile" id="scp-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">No profile</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>
            ))}
          </Select>
        </div>
        {mode === "strategy_fit" && (
          <div className="scp-field">
            <Select label="Show fits up to" id="scp-fit-limit" value={fitLimit} onChange={(e) => setFitLimit(Number(e.target.value))}>
              {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </div>
        )}
        <div className="scp-field scp-field-btn">
          <Button type="submit" className="scp-run" disabled={scanning} loading={scanning} variant="primary">
            {"Run scan"}
          </Button>
        </div>
      </form>
      <div className="scp-note">
        {mode === "per_name_best"
          ? "Per-name best: the strongest trade for each symbol, ranked — the gate still grades every pick."
          : "Strategy fit: only names whose best pick clears the fit gate are listed as fits; borderline and skipped names are accounted, not hidden."}
      </div>

      {scanError && <div className="scp-error" role="alert">{scanError}</div>}
      {diffError && <div className="scp-error" role="alert">{diffError}</div>}
      {diffResult ? (
        <ScanDiffView data={diffResult} />
      ) : (
        <>
          {result && historicalNote && (
            <div className="scp-note scp-historical" role="note">
              Saved scan from {new Date(historicalNote).toLocaleString()} — viewing the stored result, not a new run.
            </div>
          )}
          {result && rerunNote && <div className="scp-note" role="note">{rerunNote}</div>}
          {result && runContext && <ScanResultsView result={result} runContext={runContext} onPreviewTrade={onPreviewTrade} storedRun={viewedRun} />}
        </>
      )}

      {/* Strategy profiles manager (surface 4) */}
      <div className="scp-subhead">
        Strategy Profiles
        <Button variant="secondary" size="sm" className="scp-mini-btn" onClick={openCreateForm}>+ New profile</Button>
      </div>
      {profilesError && (
        <div className="scp-error" role="alert">
          {profilesError}{" "}
          <Button variant="secondary" size="sm" onClick={() => void loadProfiles()}>
            Retry
          </Button>
        </div>
      )}
      {savedNote && <div className="scp-note">{savedNote}</div>}
      {!profilesLoaded && <div className="scp-muted">Loading strategy profiles…</div>}
      {profilesLoaded && profiles.length === 0 && !profilesError && (
        <div className="scp-muted">No saved profiles yet. Create one to scan by “my strategy” instead of re-stating constraints each time.</div>
      )}
      {profiles.map((profile) => (
        <div className="scp-row" key={profile.id}>
          <div className="scp-row-main">
            <strong>{profile.name}</strong> <span className="scp-badge">v{profile.version}</span>
            <span className="scp-row-summary">{profileSummary(profile)}</span>
            <span className="scp-row-meta">updated {new Date(profile.updatedAt).toLocaleString()}</span>
          </div>
          <Button variant="secondary" size="sm" className="scp-mini-btn" onClick={() => setProfileId(profile.id)}>Use in scan</Button>
          <Button variant="secondary" size="sm" className="scp-mini-btn" onClick={() => openEditForm(profile)}>Edit</Button>
          <Button
          variant="danger"
          tone={confirmDeleteId === profile.id ? "solid" : "subtle"}
            onClick={() => void handleDelete(profile)}
          >
            {confirmDeleteId === profile.id ? "Confirm delete?" : "Delete"}
          </Button>
        </div>
      ))}

      {formOpen && (
        <form className="scp-profile-form" id="scp-profile-form" onSubmit={saveProfile}>
          <div className="scp-subhead">{editingId ? "Edit profile" : "New profile"}</div>
          {formError && <div className="scp-error" role="alert">{formError}</div>}
          <div className="scp-form-grid">
            <div className="scp-field scp-field-wide">
              <TextInput label="Name *" id="scp-pf-name" type="text" value={form.name} onChange={setField("name")} placeholder="Income" />
            </div>
            <div className="scp-field">
              <Select label="Thesis" id="scp-pf-thesis" value={form.thesis} onChange={setField("thesis")}>
                <option value="">(unset)</option>
                {THESIS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
            <div className="scp-field scp-field-wide">
              <TextInput label="Allowed strategy types (comma-separated ids)" id="scp-pf-types" type="text" value={form.allowedStrategies} onChange={setField("allowedStrategies")} placeholder="put_credit_spread, iron_condor" />
            </div>
            <div className="scp-field">
              <TextInput label="Max planned loss ($)" id="scp-pf-maxloss" type="number" min="0" step="any" value={form.maxPlannedLoss} onChange={setField("maxPlannedLoss")} />
            </div>
            <div className="scp-field">
              <TextInput label="Min reward / risk" id="scp-pf-minrr" type="number" min="0" step="any" value={form.minRewardRisk} onChange={setField("minRewardRisk")} />
            </div>
            <div className="scp-field">
              <TextInput label="Min DTE" id="scp-pf-mindte" type="number" min="0" step="1" value={form.minDte} onChange={setField("minDte")} />
            </div>
            <div className="scp-field">
              <TextInput label="Max DTE" id="scp-pf-maxdte" type="number" min="0" step="1" value={form.maxDte} onChange={setField("maxDte")} />
            </div>
            <div className="scp-field">
              <Select label="Event policy" id="scp-pf-events" value={form.eventPolicy} onChange={setField("eventPolicy")}>
                <option value="">(unset)</option>
                <option value="warn">warn</option>
                <option value="exclude">exclude</option>
              </Select>
            </div>
            <div className="scp-field">
              <Select label="Expected IV direction" id="scp-pf-iv" value={form.expectedIvDirection} onChange={setField("expectedIvDirection")}>
                <option value="">(unset)</option>
                <option value="rise">rise</option>
                <option value="unchanged">unchanged</option>
                <option value="fall">fall</option>
              </Select>
            </div>
            <div className="scp-field">
              <TextInput label="Optimization bias (0–100)" id="scp-pf-bias" type="number" min="0" max="100" step="1" value={form.optimizationBias} onChange={setField("optimizationBias")} />
            </div>
            <div className="scp-field">
              <Select label="Risk profile posture" id="scp-pf-risk" value={form.riskProfile} onChange={setField("riskProfile")}>
                <option value="">(unset)</option>
                {RISK_PROFILE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            </div>
            <div className="scp-field">
              <Select label="Default scan mode" id="scp-pf-mode" value={form.mode} onChange={setField("mode")}>
                <option value="">(unset)</option>
                {(Object.keys(MODE_LABELS) as ScanMode[]).map((value) => (
                  <option key={value} value={value}>{MODE_LABELS[value]}</option>
                ))}
              </Select>
            </div>
          </div>

          <label className="scp-check">
            <Checkbox checked={form.gateEnabled} onChange={setField("gateEnabled")} />
            Set fit-gate thresholds (issue #24)
          </label>
          {form.gateEnabled && (
            <div className="scp-form-grid">
              <div className="scp-field">
                <TextInput label="Gate min score (0–100)" id="scp-pf-gate-score" type="number" min="0" max="100" step="any" value={form.gateMinCompositeScore} onChange={setField("gateMinCompositeScore")} />
              </div>
              <div className="scp-field">
                <TextInput label="Gate min POP (0–1)" id="scp-pf-gate-pop" type="number" min="0" max="1" step="0.05" value={form.gateMinProbabilityOfProfit} onChange={setField("gateMinProbabilityOfProfit")} />
              </div>
              <div className="scp-field">
                <Select label="Gate min confidence" id="scp-pf-gate-conf" value={form.gateMinConfidence} onChange={setField("gateMinConfidence")}>
                  <option value="">(unset)</option>
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                </Select>
              </div>
              <div className="scp-field">
                <label className="scp-check scp-check-inline">
                  <Checkbox checked={form.gateRequireFresh} onChange={setField("gateRequireFresh")} />
                  Require fresh quotes
                </label>
              </div>
            </div>
          )}

          <div className="scp-form-actions">
            <Button type="submit" className="scp-run" disabled={saving} loading={saving} variant="primary">
              {editingId ? "Save changes" : "Create profile"}
            </Button>
            <Button className="scp-mini-btn" onClick={() => { setFormOpen(false); setEditingId(null); }} variant="secondary" size="sm">
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Scan history (surface 5, issue #27) */}
      <div className="scp-history">
        <div className="scp-subhead">Scan history</div>
        {historyError && (
          <div className="scp-error" role="alert">
            {historyError}{" "}
            <Button variant="secondary" size="sm" onClick={() => void loadHistory()}>
              Retry
            </Button>
          </div>
        )}
        {!historyLoaded && <div className="scp-muted">Loading scan history…</div>}
        {historyLoaded && history.length === 0 && !historyError && (
          <div className="scp-muted">
            No saved scan runs yet. Runs are saved automatically when a scan completes — run a scan and it will appear here.
          </div>
        )}
        {compareIds.length > 0 && (
          <div className="scp-note scp-compare-bar">
            Comparing {compareIds.length} of 2 runs picked.
            <Button className="scp-mini-btn" disabled={compareIds.length !== 2} onClick={compareSelected} variant="secondary" size="sm">
              Show diff
            </Button>
            <Button className="scp-mini-btn" onClick={() => setCompareIds([])} variant="secondary" size="sm">
              Clear
            </Button>
          </div>
        )}
        {history.map((run, idx) => (
          <div className="scp-row" key={run.id}>
            <div className="scp-row-main">
              <strong>{new Date(run.generatedAt).toLocaleString()}</strong>{" "}
              <span className="scp-badge">{MODE_LABELS[run.mode] ?? run.mode}</span>
              {run.profileRef && (
                <span className="scp-badge scp-badge-profile">Profile: {run.profileRef.name} v{run.profileRef.version}</span>
              )}
              <span className="scp-row-summary">
                model v{run.modelVersion} · {run.coverage?.scanned ?? 0} scanned · {run.coverage?.evaluated ?? 0} evaluated
                {" "}· gate: {run.gate?.fit ?? 0} fit / {run.gate?.borderline ?? 0} borderline / {run.gate?.noFit ?? 0} no fit
              </span>
              <span className="scp-row-meta" title={run.id}>run {shortenRunId(run.id)}</span>
            </div>
            <Button
            variant="secondary"
            size="sm"
              className="scp-mini-btn"
              disabled={historyBusyId === run.id}
              onClick={() => void viewRun(run)}
            >
              View
            </Button>
            <Button
            variant="secondary"
            size="sm"
              className="scp-mini-btn"
              disabled={historyBusyId === run.id || scanning}
              onClick={() => void rerunRun(run)}
            >
              Re-run
            </Button>
            {idx < history.length - 1 && (
              <Button className="scp-mini-btn" onClick={() => diffVsPrevious(run, idx)} variant="secondary" size="sm">
                Diff vs previous
              </Button>
            )}
            <label className="scp-compare">
              <Checkbox
                checked={compareIds.includes(run.id)}
                onChange={() => toggleCompare(run.id)}
              />
              Compare
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

export default ScannerPanel;
