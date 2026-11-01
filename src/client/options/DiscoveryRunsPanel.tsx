/**
 * Discovery runs (issue #126, PR-F): the review surface for the
 * PERSISTED discovery runs the scheduled-discovery backend (PR-E)
 * stores — scheduled fires and manual triggers of
 * autonomousStrategyDiscovery. Three input models produce runs and
 * are labelled distinctly everywhere (issues #533/#534):
 * "saved-request" runs re-run saved StrategyRequests verbatim;
 * "profile-derived" runs derive each symbol's target at fire time
 * from its own live chain under a Strategy Profile — the derivation
 * is shown in full beside the target, and a symbol whose target
 * could not be derived honestly renders as an abstention, never as
 * a failure or a fabricated result; "no-view" runs carry constraint
 * sets only — no thesis, no target was supplied, derived, or
 * assumed — and rank each symbol's structures by the target-free
 * score model (no-view-v1), showing the stored constraints in place
 * of a view line, the best-supported structure as research only
 * (never a recommendation), and a symbol where nothing qualified as
 * a flagged abstention, not a failure.
 *
 * This section is deliberately separate from the interactive
 * StrategyDiscoveryPanel above it: those results are computed live
 * in the moment and stored nowhere; these are stored runs with
 * provenance (trigger, schedule id, the exact inputs each symbol
 * ran with), rendered read-only. The two result streams are never
 * merged.
 *
 * Read-only by design: no order path and no Builder handoff exists
 * from this panel — a stored run is a record of what the pipeline
 * ranked at run time, reviewed as-is. Downloads (CSV of the ranked
 * candidates, JSON of the full run) come from runExport.ts and
 * always target the run being viewed.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, Spinner, type BadgeTone } from "../components/ui";
import {
  getDiscoveryRun,
  listDiscoveryRuns,
  type DiscoveryConstraintSet,
  type DiscoveryRunSummary,
  type DiscoverySymbolOutcome,
  type DiscoveryTargetDerivation,
  type StoredDiscoveryRun,
} from "../discoveryApi";
import { discoveryTriggerLabel, downloadDiscoveryExport } from "../runExport";
import {
  NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT,
  type DiscoveryInputModel,
  type DiscoveryRunStatus,
} from "../../trading";

interface DiscoveryRunsPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

export const DISCOVERY_RUN_STATUS_LABELS: Record<DiscoveryRunStatus, string> = {
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
};

/** The run-model label for each input model (issues #533/#534,
 *  plan §4): the label is driven by the run's stored inputModel —
 *  a run is never labelled as a model it did not run under. */
export const DISCOVERY_INPUT_MODEL_LABELS: Record<DiscoveryInputModel, string> = {
  "saved-request": "Saved requests",
  "profile-derived": "Profile-derived",
  "no-view": "No-view · constraints only",
};

const RUN_STATUS_TONES: Record<DiscoveryRunStatus, BadgeTone> = {
  completed: "success",
  partial: "warning",
  failed: "danger",
};

const BEST_TRADE_STATUS_LABELS: Record<string, string> = {
  recommended: "Recommended",
  research_only: "Research only",
  no_trade: "No trade",
};

function fmtUsd(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function humanizeThesis(thesis: string): string {
  return thesis.replaceAll("_", " ");
}

/** Total ranked candidates across a stored run's completed outcomes
 *  (viewed `ranked` plus no-view `rankedNoView`, issue #534). */
export function countRankedCandidates(run: StoredDiscoveryRun): number {
  return run.outcomes.reduce(
    (sum, outcome) =>
      sum +
      (outcome.status === "completed"
        ? (outcome.ranked?.length ?? 0) + (outcome.rankedNoView?.length ?? 0)
        : 0),
    0,
  );
}

/** The symbols whose saved request failed, with their recorded reasons. */
export function failedOutcomes(run: StoredDiscoveryRun): DiscoverySymbolOutcome[] {
  return run.outcomes.filter((outcome) => outcome.status === "failed");
}

/** The symbols that abstained in a profile-derived run (issue #533):
 *  no target could be derived honestly, so no request ran. */
export function abstainedOutcomes(run: StoredDiscoveryRun): DiscoverySymbolOutcome[] {
  return run.outcomes.filter((outcome) => outcome.status === "abstained");
}

/** The symbols that abstained in a no-view run (issue #534): the
 *  outcome COMPLETED with the `abstained` flag set — the chain
 *  loaded but no structure cleared the stated constraints. */
export function flagAbstainedOutcomes(run: StoredDiscoveryRun): DiscoverySymbolOutcome[] {
  return run.outcomes.filter((outcome) => outcome.abstained === true);
}

const OUTCOME_BADGES: Record<
  DiscoverySymbolOutcome["status"],
  { tone: BadgeTone; label: string }
> = {
  completed: { tone: "success", label: "Completed" },
  failed: { tone: "danger", label: "Failed" },
  abstained: { tone: "warning", label: "Abstained" },
};

/** A fraction (0.1311) as a trimmed percent number (13.11). */
function pctNumber(fraction: number): string {
  return String(Number((fraction * 100).toFixed(2)));
}

/** An EM multiple without trailing zeros (0.6, -0.6, 1.2, 0). */
function multipleLabel(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * The DERIVED block for one outcome (issue #533, spec R10): the full
 * derivation beside the target, in the settled format — a derived
 * target is never presented as a configured view.
 */
export function formatDerivationLine(derivation: DiscoveryTargetDerivation): string {
  return (
    `DERIVED target ${fmtUsd(derivation.targetPrice)} = spot ${fmtUsd(derivation.spot)} ` +
    `× (1 + ${multipleLabel(derivation.emMultiple)} × EM ${pctNumber(derivation.expectedMovePct)}%) ` +
    `· IV ${pctNumber(derivation.atmIv)}% · window: expiry ${derivation.windowExpiry} ` +
    `(${derivation.windowDays} days) · profile ${derivation.profileRef.name} v${derivation.profileRef.version}`
  );
}

/**
 * The constraint line for one no-view outcome (issue #534, plan §4):
 * the stored constraint set shown in place of a saved-view line —
 * caps, floors, DTE window, and the mode's fixed IV assumption — so
 * a reader can always see what constrained the run and that no
 * thesis or target did.
 */
export function formatConstraintSetLine(set: DiscoveryConstraintSet): string {
  const r = set.request;
  const parts = [
    `Constraints (no-view — no thesis, no target)`,
    `max planned loss ${fmtUsd(r.maxPlannedLoss)}`,
    `min reward/risk ${r.minRewardRisk}×`,
    `min POP ${pctNumber(r.minProbabilityOfProfit ?? NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT)}%`,
  ];
  if (r.minDte !== undefined && r.maxDte !== undefined) parts.push(`DTE ${r.minDte}–${r.maxDte}`);
  else if (r.maxDte !== undefined) parts.push(`DTE ≤${r.maxDte}`);
  else if (r.minDte !== undefined) parts.push(`DTE ≥${r.minDte}`);
  if (r.riskProfile !== undefined) parts.push(`risk profile ${r.riskProfile}`);
  parts.push(`IV expected ${set.expectedIvDirection}`);
  if (r.dataMode === "calibrated-demo") parts.push("calibrated-demo data");
  return parts.join(" · ");
}

/**
 * The completed body of a no-view outcome (issue #534): the ranked
 * structures under the outcome's constraint set, each score shown
 * with its model (no-view-v1 — not comparable to viewed scores);
 * the best-supported structure rendered as research only with the
 * pinned no-view rationale; and a flagged abstention rendered as an
 * abstention with its gate reasons — never as a failure and never
 * with a manufactured pick.
 */
function NoViewOutcomeBody({ outcome }: { outcome: DiscoverySymbolOutcome }) {
  const best = outcome.bestNoViewTrade;
  const bestCandidateId = best?.best?.candidate.id;
  const ranked = outcome.rankedNoView ?? [];
  const excluded = outcome.excluded ?? [];
  const excludedCount = excluded.reduce((sum, e) => sum + e.count, 0);

  return (
    <>
      {outcome.snapshot?.screen && (
        <p className="discovery-screen-line">
          Chain screen: {outcome.snapshot.screen.contractsEvaluated.toLocaleString()} contracts
          evaluated · {outcome.snapshot.screen.contractsMatched.toLocaleString()} matched
        </p>
      )}

      {outcome.abstained === true ? (
        <div className="discovery-outcome-abstained" role="alert">
          Abstained — the chain loaded, but no structure qualified under the stated constraints
          {excluded.length > 0
            ? ` (${excluded.map((e) => `${e.reason} ×${e.count}`).join(", ")})`
            : ""}
          . No pick was manufactured.
        </div>
      ) : (
        <>
          {best && (
            <div className="discovery-best">
              <span className="discovery-best-label">★ Best-supported structure (no-view)</span>
              {best.status === "no_trade" || !best.best ? (
                <span>
                  No qualifying structure —{" "}
                  {best.rationale[0] ?? "no structure cleared the stated constraints."}
                </span>
              ) : (
                <span>
                  {best.best.candidate.label} ·{" "}
                  {BEST_TRADE_STATUS_LABELS[best.status] ?? best.status} · confidence{" "}
                  {best.confidence}
                  {best.rationale[0] ? ` — ${best.rationale[0]}` : ""}
                </span>
              )}
              {best.blockers.length > 0 && (
                <span className="discovery-best-blockers">
                  Blockers: {best.blockers.join("; ")}
                </span>
              )}
            </div>
          )}

          {ranked.length > 0 ? (
            <div
              className="discovery-ranked-list"
              aria-label={`${ranked.length} ranked structures for ${outcome.symbol}`}
            >
              {ranked.map((entry) => {
                const c = entry.candidate;
                const isBest = bestCandidateId !== undefined && c.id === bestCandidateId;
                return (
                  <div key={c.id} className={`discovery-ranked-row${isBest ? " best" : ""}`}>
                    <span className="discovery-ranked-rank">#{entry.rank}</span>
                    <span className="discovery-ranked-name">
                      {c.label}
                      {isBest ? " ★" : ""}
                    </span>
                    <span className="discovery-ranked-meta">
                      Composite {entry.compositeScore.toFixed(1)} · score model {c.scoreModel} ·
                      POP {Math.round(c.modelImpliedProbabilityOfProfit * 100)}%
                    </span>
                    <span className="discovery-ranked-meta">
                      {c.netDebit >= 0 ? "Net debit" : "Net credit"} {fmtUsd(Math.abs(c.netDebit))}{" "}
                      · Max profit {c.maxProfit === null ? "Unbounded" : fmtUsd(c.maxProfit)} ·
                      Max loss {fmtUsd(c.maxLoss)} · Structure R/R{" "}
                      {c.structureRewardRisk === null
                        ? "—"
                        : `${c.structureRewardRisk.toFixed(2)}×`}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No structures ranked for this symbol under the stated constraints." />
          )}

          <p className="discovery-counts-line">
            Excluded: {excludedCount}
            {excluded.length > 0
              ? ` (${excluded.map((e) => `${e.reason} ×${e.count}`).join(", ")})`
              : ""}
          </p>
        </>
      )}
    </>
  );
}

function OutcomeView({ outcome }: { outcome: DiscoverySymbolOutcome }) {
  const request = outcome.request;
  const best = outcome.bestTrade;
  const bestCandidateId = best?.best?.candidate.id;
  const ranked = outcome.ranked ?? [];
  const screenedOutCount = outcome.screenedOut?.length ?? 0;
  const excluded = outcome.excluded ?? [];
  const excludedCount = excluded.reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="discovery-outcome">
      <div className="discovery-outcome-head">
        <strong>{outcome.symbol}</strong>
        <Badge tone={OUTCOME_BADGES[outcome.status].tone} size="sm" dot>
          {OUTCOME_BADGES[outcome.status].label}
        </Badge>
        {/* Issue #534: a no-view abstention is a COMPLETED outcome
            carrying the abstained flag (its profile-derived sibling
            uses the "abstained" status instead) — badge it as an
            abstention so it is never read as an ordinary completion. */}
        {outcome.abstained === true && (
          <Badge tone="warning" size="sm" dot>
            Abstained
          </Badge>
        )}
        {outcome.snapshot && (
          <span className="discovery-outcome-source">
            {outcome.snapshot.dataSource === "live" ? "Live broker chain" : "Calibrated demo data"}
          </span>
        )}
      </div>

      {/* Issue #533 (PR-533A): outcome.request is optional in the
          store's shape — an abstained outcome carries none. Saved-
          model outcomes always carry one, so this guard changes no
          rendering for existing runs; the derived/abstained outcome
          presentation itself is PR-533B's surface work. */}
      {request && (
        <p className="discovery-view-line">
          {outcome.derivation ? "Derived view" : "Saved view"}: {humanizeThesis(request.thesis)} ·
          target {fmtUsd(request.targetPrice)} by{" "}
          {request.targetDate} · IV expected {request.expectedIvDirection} · max planned loss{" "}
          {fmtUsd(request.maxPlannedLoss)} · min reward/risk {request.minRewardRisk}×
          {request.dataMode === "calibrated-demo" ? " · calibrated-demo data" : ""}
        </p>
      )}

      {/* Issue #533: the derivation, in full, beside the view line —
          a derived target always travels with how it was derived. */}
      {outcome.derivation && (
        <p className="discovery-derived-line">{formatDerivationLine(outcome.derivation)}</p>
      )}

      {/* Issue #534: the stored constraint set, in place of a view
          line — a no-view outcome ran under constraints only. Shown
          on every no-view outcome (completed, abstained, failed):
          the mode's input record. */}
      {outcome.constraintSet && (
        <p className="discovery-constraint-line">
          {formatConstraintSetLine(outcome.constraintSet)}
        </p>
      )}

      {outcome.status === "failed" ? (
        <div className="discovery-outcome-error" role="alert">
          ⚠️ {outcome.error ?? "Discovery failed for this symbol; no reason was recorded."}
        </div>
      ) : outcome.status === "abstained" ? (
        <div className="discovery-outcome-abstained" role="alert">
          Abstained — {outcome.error ?? "no reason was recorded."}
        </div>
      ) : outcome.constraintSet ? (
        <NoViewOutcomeBody outcome={outcome} />
      ) : (
        <>
          {outcome.snapshot?.screen && (
            <p className="discovery-screen-line">
              Chain screen: {outcome.snapshot.screen.contractsEvaluated.toLocaleString()} contracts
              evaluated · {outcome.snapshot.screen.contractsMatched.toLocaleString()} matched
            </p>
          )}

          {best && (
            <div className="discovery-best">
              <span className="discovery-best-label">★ Best trade</span>
              {best.status === "no_trade" || !best.best ? (
                <span>
                  No trade — {best.rationale[0] ?? "no candidate qualified under this view."}
                </span>
              ) : (
                <span>
                  {best.best.candidate.label} ·{" "}
                  {BEST_TRADE_STATUS_LABELS[best.status] ?? best.status} · confidence{" "}
                  {best.confidence}
                  {best.rationale[0] ? ` — ${best.rationale[0]}` : ""}
                </span>
              )}
              {best.blockers.length > 0 && (
                <span className="discovery-best-blockers">
                  Blockers: {best.blockers.join("; ")}
                </span>
              )}
            </div>
          )}

          {ranked.length > 0 ? (
            <div className="discovery-ranked-list" aria-label={`${ranked.length} ranked candidates for ${outcome.symbol}`}>
              {ranked.map((entry) => {
                const c = entry.candidate;
                const isBest = bestCandidateId !== undefined && c.id === bestCandidateId;
                return (
                  <div key={c.id} className={`discovery-ranked-row${isBest ? " best" : ""}`}>
                    <span className="discovery-ranked-rank">#{entry.rank}</span>
                    <span className="discovery-ranked-name">
                      {c.label}
                      {isBest ? " ★" : ""}
                    </span>
                    <span className="discovery-ranked-meta">
                      Composite {entry.compositeScore.toFixed(1)} · POP{" "}
                      {Math.round(c.modelImpliedProbabilityOfProfit * 100)}%
                    </span>
                    <span className="discovery-ranked-meta">
                      {c.netDebit >= 0 ? "Net debit" : "Net credit"} {fmtUsd(Math.abs(c.netDebit))} ·
                      Max profit {c.maxProfit === null ? "Unbounded" : fmtUsd(c.maxProfit)} · Max
                      loss {fmtUsd(c.maxLoss)} · Target R/R {c.targetRewardRisk.toFixed(2)}×
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No candidates ranked for this view — the pipeline found nothing that satisfied it." />
          )}

          <p className="discovery-counts-line">
            Screened out: {screenedOutCount} · Excluded: {excludedCount}
            {excluded.length > 0
              ? ` (${excluded.map((e) => `${e.reason} ×${e.count}`).join(", ")})`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}

export function DiscoveryRunsPanel({ activeEnv, userLogin }: DiscoveryRunsPanelProps) {
  const [runs, setRuns] = useState<DiscoveryRunSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StoredDiscoveryRun | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadRuns = useCallback(async () => {
    setListError(null);
    try {
      const listed = await listDiscoveryRuns(activeEnv, userLogin);
      setRuns(listed);
      // Default selection: the latest run (list is newest-first), kept
      // stable across refreshes when the run is still retained.
      setSelectedId((current) =>
        current && listed.some((r) => r.id === current) ? current : (listed[0]?.id ?? null),
      );
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load discovery runs");
    }
  }, [activeEnv, userLogin]);

  useEffect(() => {
    setRuns(null);
    setSelectedId(null);
    setDetail(null);
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    getDiscoveryRun(activeEnv, userLogin, selectedId)
      .then((run) => {
        if (!cancelled) setDetail(run);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(err instanceof Error ? err.message : "Failed to load discovery run");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeEnv, userLogin, selectedId]);

  const failed = detail ? failedOutcomes(detail) : [];
  // Both abstention representations name their symbols in the detail
  // head: the profile-derived "abstained" status (#533) and the
  // no-view completed + flagged abstention (#534). Disjoint by
  // construction (a run carries one input model).
  const abstained = detail
    ? [...abstainedOutcomes(detail), ...flagAbstainedOutcomes(detail)]
    : [];
  // CSV carries candidate rows: offered for completed and partial runs
  // (a completed run with no candidates exports the honest header-only
  // file). A failed run's export is its JSON diagnostic record only.
  const csvOffered = detail !== null && detail.status !== "failed";

  return (
    <section className="discovery-runs" aria-label="Discovery runs">
      <div className="discovery-runs-header">
        <div>
          <h3>Discovery runs</h3>
          <p>
            Persisted runs from scheduled and manually triggered discovery — saved views re-run
            verbatim, profile-derived runs derive each symbol&apos;s target at run time, and
            no-view runs rank structures under stored constraints only (no thesis, no target).
            Separate from the interactive discovery above, whose results are not stored.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void loadRuns()}>
          ↻ Refresh
        </Button>
      </div>

      {listError && (
        <div className="discovery-runs-error" role="alert">
          {listError}
        </div>
      )}

      {runs === null && !listError && (
        <div className="discovery-runs-loading" role="status">
          <Spinner size="sm" label="Loading discovery runs" /> Loading discovery runs…
        </div>
      )}

      {runs !== null && runs.length === 0 && !listError && (
        <EmptyState
          framed
          icon="🔍"
          title="No discovery runs yet"
          description="When a scheduled or manually triggered discovery run completes, it will appear here with the inputs it ran under — a saved view, a derived target, or a no-view constraint set — and the strategies it ranked."
        />
      )}

      {runs !== null && runs.length > 0 && (
        <div className="discovery-run-list" aria-label="Persisted discovery runs">
          {runs.map((run) => {
            const selected = run.id === selectedId;
            return (
              <Button
                key={run.id}
                type="button"
                className="discovery-run-item"
                aria-pressed={selected}
                aria-label={`Review discovery run from ${new Date(run.createdAt).toLocaleString()}`}
                onClick={() => setSelectedId(run.id)}
              >
                <strong>{new Date(run.createdAt).toLocaleString()}</strong>
                <span className="discovery-run-meta">{discoveryTriggerLabel(run)}</span>
                <span className="discovery-run-meta">
                  {DISCOVERY_INPUT_MODEL_LABELS[run.inputModel]}
                </span>
                <Badge tone={RUN_STATUS_TONES[run.status]} size="sm" dot>
                  {DISCOVERY_RUN_STATUS_LABELS[run.status]}
                </Badge>
                <span className="discovery-run-meta">{run.symbols.join(", ")}</span>
                {run.inputModel === "profile-derived" || run.inputModel === "no-view" ? (
                  <span>
                    {run.completedCount} of {run.symbols.length} symbols completed
                    {run.failedCount > 0 ? ` · ${run.failedCount} failed` : ""}
                    {(run.abstainedCount ?? 0) > 0 ? ` · ${run.abstainedCount} abstained` : ""}
                  </span>
                ) : (
                  <span>
                    {run.completedCount} of {run.requestCount} requests completed
                    {run.failedCount > 0 ? ` · ${run.failedCount} failed` : ""}
                  </span>
                )}
                {selected && <span className="discovery-run-viewing">● Viewing</span>}
              </Button>
            );
          })}
        </div>
      )}

      {selectedId && (
        <div className="discovery-run-detail">
          {detailLoading && (
            <div className="discovery-runs-loading" role="status">
              <Spinner size="sm" label="Loading discovery run" /> Loading run…
            </div>
          )}
          {detailError && (
            <div className="discovery-runs-error" role="alert">
              {detailError}
            </div>
          )}
          {detail && !detailLoading && (
            <>
              <div className="discovery-run-detail-head">
                <div>
                  <h4>
                    {new Date(detail.createdAt).toLocaleString()} · {discoveryTriggerLabel(detail)}
                  </h4>
                  <p>
                    {countRankedCandidates(detail)} ranked candidates across{" "}
                    {detail.completedCount} completed{" "}
                    {detail.inputModel === "saved-request" ? "request" : "symbol"}
                    {detail.completedCount === 1 ? "" : "s"}
                    {failed.length > 0
                      ? ` · Failed: ${failed.map((o) => o.symbol).join(", ")}`
                      : ""}
                    {abstained.length > 0
                      ? ` · Abstained: ${abstained.map((o) => o.symbol).join(", ")}`
                      : ""}
                  </p>
                  {detail.profileRef && (
                    <p className="discovery-run-profile">
                      Profile-derived · profile {detail.profileRef.name} v{detail.profileRef.version}{" "}
                      — targets derived at run time from each symbol&apos;s live chain, never
                      configured views.
                    </p>
                  )}
                  {detail.inputModel === "no-view" && (
                    <p className="discovery-run-noview">
                      No-view · constraints only — no thesis or target was supplied, derived, or
                      assumed for this run. Structures were ranked under the stored constraint
                      sets by the no-view-v1 score model (not comparable to viewed scores), and
                      the best-supported structure is research only, never a recommendation.
                    </p>
                  )}
                </div>
                <Badge tone={RUN_STATUS_TONES[detail.status]} size="sm" dot>
                  {DISCOVERY_RUN_STATUS_LABELS[detail.status]}
                </Badge>
                <div className="discovery-downloads">
                  {csvOffered && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => downloadDiscoveryExport(detail, "candidates-csv")}
                      title="Download this run's ranked candidates as CSV"
                    >
                      ⬇ Candidates CSV
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => downloadDiscoveryExport(detail, "run-json")}
                    title={
                      detail.status === "failed"
                        ? "Download this failed run's full record as JSON (the diagnostic record)"
                        : "Download this run's full stored record as JSON"
                    }
                  >
                    ⬇ Run JSON
                  </Button>
                </div>
              </div>

              {detail.status === "failed" && (
                <div className="discovery-runs-error" role="alert">
                  {detail.inputModel === "saved-request"
                    ? "This run failed — every saved request failed. The reasons are recorded per symbol below; the run is kept as a diagnostic record, never as a result."
                    : "This run failed — no symbol produced a result. Abstentions and failures are recorded per symbol below; the run is kept as a diagnostic record, never as a result."}
                </div>
              )}

              {detail.outcomes.map((outcome) => (
                <OutcomeView key={outcome.symbol} outcome={outcome} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
