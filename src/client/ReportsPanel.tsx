/**
 * Issue #309: Reports Panel — list and search persisted screener reports.
 *
 * Issue #1057 (consolidation S5): this panel is the single run-history
 * UI. The list is served by GET /api/runs — the one Runs read surface
 * merging all four run stores (mas_reports, mas_opportunity_scans,
 * mas_discovery_runs, the ScreenerAgent feed) into the normalized
 * RunSummary shape — so options scans and discovery runs appear here
 * alongside canonical reports. Detail/download affordances are
 * unchanged: canonical-backed rows open the report detail by reportId
 * and link their stored PDF; keyword search filters the loaded runs;
 * semantic search remains a canonical-reports feature (its endpoint +
 * hydration path below are untouched).
 */

import { useState, useEffect, useCallback } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Button, Checkbox, Notice, SegmentedControl, TextInput } from "./components/ui";
import { PendingReviewQueue } from "./PendingReviewQueue";
import { RegeneratePdfButton } from "./RegeneratePdfButton";
import { ResearchRunDetail } from "./chat/tabs/ResearchRunDetail";
import { ResearchIdeasBrowser } from "./chat/tabs/ResearchIdeasBrowser";
import { ResearchTrackRecord } from "./chat/tabs/ResearchTrackRecord";
import "./reports.css";

export interface ReportItem {
  id: string;
  runId: string;
  title: string;
  source: string;
  summary: string;
  createdAt: string;
  /** Download URL of the generated PDF, when this report has one (#638). */
  reportUrl?: string;
  /** Download URLs of the stored XLSX / CSV artifacts, when the run
   *  recorded them (#1335: goal-screen rows record all three). */
  xlsxUrl?: string;
  csvUrl?: string;
  /** Recorded PDF generation state + failure reason (#1239): when a
   *  run has no reportUrl but records these, the card says the PDF is
   *  unavailable (and why) instead of silently omitting the link. */
  pdfStatus?: string | null;
  pdfError?: string | null;
  /** Partial-coverage qualification (#1850): carried through from
   *  the Runs-API row so the card model holds it; the qualifier
   *  itself renders via the row summary text, which carries the
   *  partial segment — no second badge saying the same thing. */
  partial?: {
    evaluatedCount: number;
    consideredCount: number;
    coverageErrors: number;
    truncatedCount: number;
    topSkipReason?: string;
    topSkipCount?: number;
  } | null;
  /** The Runs-API kind (#1057): screener | options_scanner | discovery | report. */
  kind?: string;
  /** The store's recorded status, when it records one (#1057). */
  status?: string | null;
  /** Canonical mas_reports id when this run has a canonical row —
   *  the detail-view key (#1057). Null/absent for detail-only runs. */
  reportId?: string | null;
}

/** Map one normalized RunSummary row (src/services/runSummaries.ts)
 *  onto the card model. */
function runToReportItem(r: any): ReportItem {
  return {
    id: String(r.id),
    runId: String(r.runId),
    title: String(r.title ?? ""),
    source: String(r.source ?? r.kind ?? ""),
    summary: String(r.summary ?? ""),
    createdAt: String(r.createdAt ?? ""),
    reportUrl: r.reportUrl ?? undefined,
    xlsxUrl: r.xlsxUrl ?? undefined,
    csvUrl: r.csvUrl ?? undefined,
    pdfStatus: r.pdfStatus ?? null,
    pdfError: r.pdfError ?? null,
    partial: r.partial ?? null,
    kind: r.kind,
    status: r.status ?? null,
    reportId: r.reportId ?? null,
  };
}

const SOURCE_LABELS: Record<string, string> = {
  screener: "📊 Stock Screener",
  options_scanner: "📈 Options Scanner",
  discovery: "🔭 Discovery",
  iv_collection: "💹 IV Collection",
  research_report: "🔬 Research",
  goal_screen: "🎯 Goal Screen",
};

// Badge colors travel as background/foreground token PAIRS (#677): each
// foreground is the WCAG-AA paired token for its background in every
// theme (white text on these backgrounds failed AA in dark/high-contrast).
const SOURCE_BADGE_STYLES: Record<string, { backgroundColor: string; color: string }> = {
  screener: { backgroundColor: "var(--color-accent)", color: "var(--color-accent-contrast)" },
  options_scanner: { backgroundColor: "var(--color-purple)", color: "var(--color-purple-foreground)" },
  discovery: { backgroundColor: "var(--color-info-subtle)", color: "var(--color-info-text)" },
  iv_collection: { backgroundColor: "var(--color-success)", color: "var(--color-success-foreground)" },
  research_report: { backgroundColor: "var(--color-warning)", color: "var(--color-warning-foreground)" },
};

// Unknown sources get the neutral sunken-surface pair (also AA-audited).
const FALLBACK_BADGE_STYLE = {
  backgroundColor: "var(--color-surface-sunken)",
  color: "var(--color-surface-sunken-foreground)",
};

export function ReportsPanel() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"reports" | "ideas" | "track">("reports");
  const [semanticMode, setSemanticMode] = useState(false);

  const fetchReports = useCallback(async (query?: string, semantic?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      if (semantic && query?.trim()) {
        // Issue #649: semantic search via Vectorize.
        const params = new URLSearchParams({ q: query.trim() });
        const res = await fetch(`/api/reports/semantic-search?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as any;
        // Fetch the full report details for the merged hits.
        const ids = (data.hits || []).map((h: any) => h.reportId);
        if (ids.length === 0) {
          setReports([]);
        } else {
          const all = await fetch(`/api/reports?limit=100`).then((r) => r.json()) as any;
          const byId = new Map((all.reports || []).map((r: any) => [String(r.id), r]));
          setReports(ids.map((id: string) => byId.get(id)).filter(Boolean));
        }
        return;
      }
      // Issue #1057: the list comes from the one Runs read surface.
      // Kind chips map onto the API's kind filter; the two canonical-
      // only sources (iv_collection, research_report) filter the
      // merged list client-side, as does keyword search.
      const kind =
        sourceFilter === "screener" || sourceFilter === "options_scanner" || sourceFilter === "discovery"
          ? sourceFilter
          : "all";
      const res = await fetch(`/api/runs?kind=${kind}&limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      let rows: ReportItem[] = (data.runs || []).map(runToReportItem);
      if (sourceFilter === "iv_collection" || sourceFilter === "research_report" || sourceFilter === "goal_screen") {
        rows = rows.filter((r) => r.source === sourceFilter);
      }
      if (query?.trim()) {
        const q = query.trim().toLowerCase();
        rows = rows.filter((r) =>
          `${r.title} ${r.summary} ${r.runId}`.toLowerCase().includes(q),
        );
      }
      setReports(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, [sourceFilter]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchReports(searchQuery, semanticMode);
  };

  const filteredSources = ["all", "screener", "options_scanner", "discovery", "iv_collection", "research_report", "goal_screen"];

  return (
    <div className="reports-panel">
      <SegmentedControl
        ariaLabel="Reports view"
        value={panelMode}
        onChange={(v) => {
          setPanelMode(v);
          setSelectedReportId(null);
        }}
        options={[
          { id: "reports", label: "Reports" },
          { id: "ideas", label: "Watchlist & Rejected" },
          { id: "track", label: "Track Record" },
        ]}
      />
      {panelMode === "track" ? (
        <ResearchTrackRecord />
      ) : panelMode === "ideas" ? (
        <ResearchIdeasBrowser
          onOpenReport={(id) => {
            setPanelMode("reports");
            setSelectedReportId(id);
          }}
        />
      ) : (
      <>
      {!selectedReportId && <PendingReviewQueue />}
      <div className="reports-toolbar">
        <form onSubmit={handleSearch} className="reports-search">
          <TextInput
            type="text"
            placeholder="Search reports… (e.g. NASDAQ100, bullish, NVDA)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          <Button type="submit" className="search-btn">🔍 Search</Button>
          <span title="Use AI semantic search instead of keyword matching">
            <Checkbox
              label="🧠 Semantic"
              checked={semanticMode}
              onChange={(e) => setSemanticMode(e.target.checked)}
            />
          </span>
        </form>
        <div className="source-filters">
          {filteredSources.map((s) => (
            <Button
              key={s}
              className={`filter-chip ${sourceFilter === s ? "active" : ""}`}
              onClick={() => setSourceFilter(s)}
            >
              {s === "all" ? "All" : SOURCE_LABELS[s] || s}
            </Button>
          ))}
        </div>
      </div>

      {!selectedReportId && loading && <div className="loading">Loading reports…</div>}
      {!selectedReportId && error && (
        <div className="error">
          Error: {error} <Button onClick={() => fetchReports()}>Retry</Button>
        </div>
      )}

      {!selectedReportId && !loading && !error && reports.length === 0 && (
        <div className="empty">
          <p>No reports found.</p>
          <p className="hint">
            Reports appear here after scheduled runs complete.
            The first reports will land after the next hourly screener run.
          </p>
        </div>
      )}

      {selectedReportId ? (
        <ResearchRunDetail
          reportId={selectedReportId}
          onBack={() => setSelectedReportId(null)}
        />
      ) : (
      <div className="reports-list">
        {reports.map((r) => (
          <div key={r.id} className="report-card">
            <div className="report-header">
              <span
                className="source-badge"
                style={SOURCE_BADGE_STYLES[r.source] || FALLBACK_BADGE_STYLE}
              >
                {SOURCE_LABELS[r.source] || r.source}
              </span>
              <span className="report-time">
                {new Date(r.createdAt).toLocaleString()}
                {r.status ? ` · ${r.status}` : ""}
              </span>
            </div>
            <h3 className="report-title">{r.title}</h3>
            <p className="report-summary">{r.summary}</p>
            <div className="report-actions">
              {r.source === "research_report" && r.reportId && (
                <Button variant="secondary" size="sm" onClick={() => setSelectedReportId(r.reportId as string)}>
                  View run
                </Button>
              )}
              <span className="run-id" title={r.runId}>
                Run: {r.runId.slice(0, 12)}…
              </span>
              {r.reportUrl && (
                <a className="report-pdf-link" href={r.reportUrl} download>
                  📄 Download PDF
                </a>
              )}
              {r.xlsxUrl && (
                <a className="report-pdf-link" href={r.xlsxUrl} download>
                  📊 Download XLSX
                </a>
              )}
              {r.csvUrl && (
                <a className="report-pdf-link" href={r.csvUrl} download>
                  📋 Download CSV
                </a>
              )}
              {!r.reportUrl && (r.pdfStatus || r.pdfError) && (
                <Notice tone="danger" density="compact" className="report-pdf-unavailable">
                  📄 PDF unavailable{r.pdfError ? ` — ${r.pdfError}` : ""}
                </Notice>
              )}
              {!r.reportUrl && r.pdfStatus === "failed" && (
                <RegeneratePdfButton onRegenerated={() => fetchReports()} />
              )}
            </div>
          </div>
        ))}
      </div>
      )}
      </>
      )}
    </div>
  );
}
