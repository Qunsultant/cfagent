/**
 * Issue #1326: one run-detail view (natural home ScreenersHub, which
 * already has run-status labels and a runs list) showing a run's full
 * story without opening Slack/email:
 *  - outcome: status, matched/total counts, trigger, universe/sector,
 *    timestamp
 *  - partial qualification (#462 stamp): prominent banner with quoted
 *    vs requested counts, failed symbols, failure reasons — a qualified
 *    partial is never a complete screen, never a failure
 *  - artifacts: PDF/XLSX/CSV links + per-format status/error (a failed
 *    artifact shows its coded error, never a silent missing link; a
 *    never-attempted or skipped format says so, never "no record")
 *  - delivery status per channel: the run's confirmations incl.
 *    held (pending) / approved / rejected / expired state
 *
 * Compliance (docs/agents/ux-architecture.md): built only from
 * src/client/components/ui/ primitives; server state is authoritative
 * (confirmations come from GET /trading/reports/confirmations, joined
 * exactly via the run's canonical row); a field the store does not
 * record renders as absent, never invented.
 */

import { useState } from "react";
import { Badge, Button, Card, EmptyState, Notice, PageSection, Spinner } from "./components/ui";
import { replayReport, replaySummary, type ReplayResponse } from "./replayReport";
import {
  resolveStockReportFormatStatus,
  type StockReportFormatStatus,
} from "../services/stockReportFormatStatus";
import { csrfHeaders } from "./apiFetch";

export interface RunDetailPartial {
  quotedCount: number;
  requestedCount: number;
  failedSymbols: string[];
  failureReasons: Record<string, number>;
}

export interface RunDetailRun {
  timestamp: string;
  trigger?: string;
  universe?: string;
  sector: string;
  /** Issue #2909 (G2): the pinned pattern for a pattern run, when the run record carries it. */
  patternRef?: string | { patternId: string; version: string };
  /** Issue #2909 (G2): run qualifications for unmapped pattern guardrails, when recorded. */
  patternQualifications?: string[];
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  partial?: RunDetailPartial;
  pdfKey?: string;
  reportUrl?: string;
  pdfStatus?: string;
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: string;
  xlsxError?: string;
  /** Issue #2911 (G4): the CSV leg joins the artifacts section. */
  csvKey?: string;
  csvStatus?: string;
  csvError?: string;
}

export interface RunDetailConfirmation {
  confirmationId: string;
  kind: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  detail: string;
}

export interface RunDetailViewProps {
  run: RunDetailRun;
  confirmations: RunDetailConfirmation[];
  confirmationsLoading: boolean;
  /**
   * Issue #2438: "bare" renders the artifacts + delivery sections
   * without the outer Card, the "Run detail" heading, or the outcome
   * section — ScreenersHub's single detail Card carries those (one
   * heading hierarchy, one outcome Badge). Default "card" preserves
   * the standalone rendering every existing consumer relies on.
   */
  chrome?: "card" | "bare";
  /**
   * Issue #2863: the stored generation id for this run
   * (`screener:<timestamp>`), when known. When present, the
   * "Replay this report" button replays the persisted report
   * for that generation — zero live re-fetch, no re-charge.
   * Absent when the caller cannot name the canonical row.
   */
  replayRunId?: string;
  /**
   * Issue #2603: the stored options run id, when this run is an options
   * run the caller can name. When present, "Regenerate this run" re-runs
   * the SAME request from the stored record as a NEW run — the original
   * row is never overwritten — and a refused regenerate names what the
   * stored record is missing.
   */
  regenerateRunId?: string;
  /** Fired after a successful regenerate so the parent refreshes its list. */
  onRegenerated?: () => void;
}

function outcomeOf(run: RunDetailRun): { label: string; tone: "success" | "warning" | "danger" } {
  if (!run.success) return { label: "Failed", tone: "danger" };
  if (run.partial) return { label: "Partial", tone: "warning" };
  return { label: "Complete", tone: "success" };
}

/**
 * Issue #2911 (G4): the no-link fallback sentence for one format, from
 * the resolved vocabulary status — a failed leg says it failed, a
 * never-attempted or skipped leg says so, and only a genuinely missing
 * leg says "no record". The coded-error Notice above this branch keeps
 * precedence: an errored leg shows its error, not this sentence.
 */
function artifactStatusText(formatLabel: string, status: StockReportFormatStatus): string {
  switch (status) {
    case "failed":
      return `${formatLabel} generation failed.`;
    case "never-attempted":
      return `${formatLabel} not attempted for this run.`;
    case "skipped":
      return `${formatLabel} skipped for this run.`;
    default:
      return `No ${formatLabel} recorded for this run.`;
  }
}

function confirmationLabel(status: string): string {
  if (status === "pending") return "Held for review";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "expired") return "Expired";
  return status;
}

export function RunDetailView({
  run,
  confirmations,
  confirmationsLoading,
  chrome = "card",
  replayRunId,
  regenerateRunId,
  onRegenerated,
}: RunDetailViewProps) {
  const outcome = outcomeOf(run);
  const pdfUrl = run.reportUrl || (run.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(run.pdfKey)}` : null);
  const xlsxUrl = run.xlsxKey ? `/api/screener/report.xlsx?key=${encodeURIComponent(run.xlsxKey)}` : null;
  const csvUrl = run.csvKey ? `/api/screener/report.csv?key=${encodeURIComponent(run.csvKey)}` : null;
  const [replayLoading, setReplayLoading] = useState(false);
  const [regenerateLoading, setRegenerateLoading] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [regenerateDone, setRegenerateDone] = useState(false);
  const onRegenerate = async () => {
    if (!regenerateRunId || regenerateLoading) return;
    setRegenerateLoading(true);
    setRegenerateError(null);
    setRegenerateDone(false);
    try {
      const res = await fetch("/api/trading/options/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...csrfHeaders() },
        body: JSON.stringify({ reportId: regenerateRunId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setRegenerateError(
          typeof data?.error === "string" && data.error
            ? data.error
            : "Regenerate failed. No new run was recorded.",
        );
        return;
      }
      setRegenerateDone(true);
      onRegenerated?.();
    } catch {
      setRegenerateError("Regenerate failed. No new run was recorded.");
    } finally {
      setRegenerateLoading(false);
    }
  };
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  const onReplay = async () => {
    if (!replayRunId || replayLoading) return;
    setReplayLoading(true);
    try {
      setReplay(await replayReport({ runId: replayRunId }));
    } finally {
      setReplayLoading(false);
    }
  };

  const body = (
    <>
      {chrome === "card" && (
        <>
          <h3 style={{ margin: "0 0 0.75rem" }}>Run detail</h3>

          <section aria-label="Outcome" style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
              <Badge tone={outcome.tone}>{outcome.label}</Badge>
              <span>
                {run.matchedCount} matched of {run.totalScanned} scanned
              </span>
            </div>
            <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
              {(run.universe || "nasdaq100").toUpperCase()} · {run.sector} · {run.trigger || "unknown"} ·{" "}
              {new Date(run.timestamp).toLocaleString()}
            </div>
          </section>
        </>
      )}

      {run.partial && (
        <Notice tone="warning" variant="strip" density="compact">
          <strong>Partial run — qualified, not complete.</strong> This screen ran on {run.partial.quotedCount} of{" "}
          {run.partial.requestedCount} requested symbols; {run.partial.requestedCount - run.partial.quotedCount}{" "}
          failed to quote and were not substituted.
          {run.partial.failedSymbols.length > 0 && (
            <div style={{ marginTop: "0.25rem" }}>Failed symbols: {run.partial.failedSymbols.join(", ")}</div>
          )}
          {Object.keys(run.partial.failureReasons).length > 0 && (
            <div style={{ marginTop: "0.25rem" }}>
              Failure reasons:{" "}
              {Object.entries(run.partial.failureReasons)
                .map(([reason, count]) => `${reason}: ${count}`)
                .join(", ")}
            </div>
          )}
        </Notice>
      )}

      {(run.patternRef || (run.patternQualifications && run.patternQualifications.length > 0)) && (
        <section aria-label="Pattern" style={{ margin: "1rem 0" }}>
          <h4 style={{ margin: "0 0 0.5rem" }}>Pattern</h4>
          {run.patternRef && (
            <div>
              {typeof run.patternRef === "string"
                ? `Pattern: ${run.patternRef}`
                : `Pattern: ${run.patternRef.patternId} (v${run.patternRef.version}) — pinned at run creation.`}
            </div>
          )}
          {run.patternQualifications && run.patternQualifications.length > 0 && (
            <Notice tone="warning" density="compact">
              Qualified run — these pattern guardrails were NOT enforced by this screen and are recorded here, never silently dropped:
              <ul style={{ marginTop: "var(--space-1)", paddingLeft: "var(--space-4)" }}>
                {run.patternQualifications.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Notice>
          )}
        </section>
      )}

      <section aria-label="Artifacts" style={{ margin: "1rem 0" }}>
        <h4 style={{ margin: "0 0 0.5rem" }}>Artifacts</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div>
            {pdfUrl ? (
              <a href={pdfUrl} target="_blank" rel="noreferrer">
                📄 Download PDF report
              </a>
            ) : run.pdfError ? (
              <Notice tone="danger" density="compact">
                📄 PDF unavailable — {run.pdfError}
              </Notice>
            ) : (
              <span>
                📄{" "}
                {artifactStatusText(
                  "PDF",
                  resolveStockReportFormatStatus({ key: run.pdfKey, status: run.pdfStatus, runFailed: !run.success }),
                )}
              </span>
            )}
          </div>
          <div>
            {xlsxUrl ? (
              <a href={xlsxUrl} target="_blank" rel="noreferrer">
                📊 Download XLSX report
              </a>
            ) : run.xlsxError ? (
              <Notice tone="danger" density="compact">
                📊 XLSX unavailable — {run.xlsxError}
              </Notice>
            ) : (
              <span>
                📊{" "}
                {artifactStatusText(
                  "XLSX",
                  resolveStockReportFormatStatus({ key: run.xlsxKey, status: run.xlsxStatus, runFailed: !run.success }),
                )}
              </span>
            )}
          </div>
          <div>
            {csvUrl ? (
              <a href={csvUrl} target="_blank" rel="noreferrer">
                📋 Download CSV report
              </a>
            ) : run.csvError ? (
              <Notice tone="danger" density="compact">
                📋 CSV unavailable — {run.csvError}
              </Notice>
            ) : (
              <span>
                📋{" "}
                {artifactStatusText(
                  "CSV",
                  resolveStockReportFormatStatus({ key: run.csvKey, status: run.csvStatus, runFailed: !run.success }),
                )}
              </span>
            )}
          </div>
        </div>
      </section>

      {regenerateRunId && (
        <section aria-label="Regenerate">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onRegenerate()}
            loading={regenerateLoading}
          >
            Regenerate this run
          </Button>
          {regenerateError && (
            <Notice tone="danger" density="compact">
              {regenerateError}
            </Notice>
          )}
          {regenerateDone && (
            <Notice tone="success" density="compact">
              Regenerated as a new run. The original run is unchanged.
            </Notice>
          )}
        </section>
      )}

      {replayRunId && (
        <section aria-label="Replay" style={{ margin: "1rem 0" }}>
          <Button variant="secondary" size="sm" onClick={onReplay} loading={replayLoading}>
            Replay this report
          </Button>
          {replay && !replay.ok && (
            <div style={{ marginTop: "0.5rem" }}>
              <Notice tone="danger" density="compact">
                Replay failed — {replay.error}
              </Notice>
            </div>
          )}
          {replay?.ok && replay.replay && (
            <div style={{ marginTop: "0.5rem" }}>
              <Notice tone={replay.replay.partial ? "warning" : "success"} density="compact">
                {replaySummary(replay.replay)}
                {replay.replay.partial && replay.replay.partialReasons && replay.replay.partialReasons.length > 0 && (
                  <div style={{ marginTop: "0.25rem" }}>
                    Partial: {replay.replay.partialReasons.join(" ")}
                  </div>
                )}
                {replay.replay.patternQualifications && replay.replay.patternQualifications.length > 0 && (
                  <div style={{ marginTop: "0.25rem" }}>
                    Qualified — guardrails not enforced on this run:
                    <ul style={{ marginTop: "var(--space-1)", paddingLeft: "var(--space-4)" }}>
                      {replay.replay.patternQualifications.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </Notice>
            </div>
          )}
        </section>
      )}

      <section aria-label="Delivery status">
        <h4 style={{ margin: "0 0 0.5rem" }}>Delivery status</h4>
        {confirmationsLoading ? (
          <Spinner label="Loading delivery status…" />
        ) : confirmations.length === 0 ? (
          <EmptyState
            title="No delivery record linked to this run."
            description="This run has no held, approved, or rejected delivery confirmations on record."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {confirmations.map((c) => (
              <div
                key={c.confirmationId}
                style={{
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "8px",
                  padding: "var(--space-2) var(--space-3)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <Badge tone={c.status === "approved" ? "success" : c.status === "pending" ? "warning" : "neutral"}>
                    {confirmationLabel(c.status)}
                  </Badge>
                  <span style={{ fontWeight: 600 }}>{c.kind}</span>
                  <span style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)" }}>{c.detail}</span>
                </div>
                <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
                  Created {new Date(c.createdAt).toLocaleString()}
                  {c.decidedAt ? ` · decided ${new Date(c.decidedAt).toLocaleString()}` : ""}
                  {c.decidedBy ? ` by ${c.decidedBy}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );

  if (chrome === "bare") return <PageSection>{body}</PageSection>;
  return (
    <Card padding="md">
      <PageSection>{body}</PageSection>
    </Card>
  );
}
