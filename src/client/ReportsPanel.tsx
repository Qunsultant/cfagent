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
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Flex, Notice, PageSection, PageShell, PillGroup, SegmentedControl, Spinner, Stack, TextInput } from "./components/ui";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { PendingReviewQueue } from "./PendingReviewQueue";
import { RegeneratePdfButton } from "./RegeneratePdfButton";
import { ResearchRunDetail } from "./chat/tabs/ResearchRunDetail";
import { replayReport, replaySummary, type ReplayResponse } from "./replayReport";
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
  /** Recorded XLSX / CSV generation state + failure reason (#2911 G4):
   *  a failed tabular leg renders its unavailable notice instead of
   *  silently omitting the link, mirroring the PDF leg above. */
  xlsxStatus?: string | null;
  xlsxError?: string | null;
  csvStatus?: string | null;
  csvError?: string | null;
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
    xlsxStatus: r.xlsxStatus ?? null,
    xlsxError: r.xlsxError ?? null,
    csvStatus: r.csvStatus ?? null,
    csvError: r.csvError ?? null,
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
  // Deep links (#2776): the reports/ideas/track switch lives in
  // `?reportsTab=` via the shared hook (aliased to the old
  // panelMode/setPanelMode names, so the panel below is untouched).
  // `view` is taken by the hub tab, hence a distinct inner param.
  const { activeTab: panelMode, handleTabChange: setPanelMode } =
    useUrlSyncedTabs<"reports" | "ideas" | "track">({
      param: "reportsTab",
      isValid: (v): v is "reports" | "ideas" | "track" =>
        v === "reports" || v === "ideas" || v === "track",
      defaultTab: "reports",
    });
  const [semanticMode, setSemanticMode] = useState(false);
  // Issue #2863: per-row replay state (keyed by the row id).
  // A row replays when it names a canonical row (reportId) or a
  // screener generation (runId `screener:<timestamp>`); rows
  // naming neither get no Replay button — a replay needs a
  // persisted row to read, and this panel never invents one.
  const [replayState, setReplayState] = useState<Record<string, { loading: boolean; result?: ReplayResponse }>>({});
  const onReplayRow = async (row: ReportItem) => {
    const key = row.id;
    if (replayState[key]?.loading) return;
    setReplayState((s) => ({ ...s, [key]: { loading: true } }));
    const result = row.reportId
      ? await replayReport({ reportId: row.reportId })
      : await replayReport({ runId: row.runId });
    setReplayState((s) => ({ ...s, [key]: { loading: false, result } }));
  };

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
    <PageShell
      title="Reports"
      scopeNote="The single run-history UI — every screener run, options scan, and discovery run in one list, with keyword or semantic search and downloads."
    >
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
      <PageSection title="Search and filter">
      <Stack gap="2">
        <form onSubmit={handleSearch}>
          <Flex gap="2" align="center" wrap>
          <TextInput
            type="text"
            placeholder="Search reports… (e.g. NASDAQ100, bullish, NVDA)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <Button type="submit">🔍 Search</Button>
          <span title="Use AI semantic search instead of keyword matching">
            <Checkbox
              label="🧠 Semantic"
              checked={semanticMode}
              onChange={(e) => setSemanticMode(e.target.checked)}
            />
          </span>
          </Flex>
        </form>
        <PillGroup
          ariaLabel="Filter by source"
          size="sm"
          options={filteredSources.map((s) => ({
            id: s,
            label: s === "all" ? "All" : SOURCE_LABELS[s] || s,
          }))}
          value={sourceFilter}
          onChange={setSourceFilter}
        />
      </Stack>
      </PageSection>

      <PageSection title="Reports">
      {!selectedReportId && loading && <Spinner label="Loading reports…" />}
      {!selectedReportId && error && (
        <Notice tone="danger">
          Error: {error} <Button onClick={() => fetchReports()}>Retry</Button>
        </Notice>
      )}

      {!selectedReportId && !loading && !error && reports.length === 0 && (
        <EmptyState
          title="No reports found."
          description="Reports appear here after scheduled runs complete. The first reports will land after the next hourly screener run."
        />
      )}

      {selectedReportId ? (
        <ResearchRunDetail
          reportId={selectedReportId}
          onBack={() => setSelectedReportId(null)}
        />
      ) : (
      <Stack gap="2">
        {reports.map((r) => (
          <Card key={r.id} padding="md">
            <Flex gap="2" align="center" justify="between" wrap>
              <Badge
                style={SOURCE_BADGE_STYLES[r.source] || FALLBACK_BADGE_STYLE}
              >
                {SOURCE_LABELS[r.source] || r.source}
              </Badge>
              <span className="ui-meta">
                {new Date(r.createdAt).toLocaleString()}
                {r.status ? ` · ${r.status}` : ""}
              </span>
            </Flex>
            <CardHeader title={r.title} />
            <p>{r.summary}</p>
            <Flex gap="2" align="center" wrap>
              {r.source === "research_report" && r.reportId && (
                <Button variant="secondary" size="sm" onClick={() => setSelectedReportId(r.reportId as string)}>
                  View run
                </Button>
              )}
              {(r.reportId || r.runId.startsWith("screener:")) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onReplayRow(r)}
                  loading={replayState[r.id]?.loading}
                >
                  Replay
                </Button>
              )}
              <span className="ui-meta" title={r.runId}>
                Run: {r.runId.slice(0, 12)}…
              </span>
              {r.reportUrl && (
                <Button href={r.reportUrl} download variant="secondary" tone="subtle" size="sm">
                  📄 Download PDF
                </Button>
              )}
              {r.xlsxUrl && (
                <Button href={r.xlsxUrl} download variant="secondary" tone="subtle" size="sm">
                  📊 Download XLSX
                </Button>
              )}
              {r.csvUrl && (
                <Button href={r.csvUrl} download variant="secondary" tone="subtle" size="sm">
                  📋 Download CSV
                </Button>
              )}
              {!r.reportUrl && (r.pdfStatus || r.pdfError) && (
                <Notice tone="danger" density="compact">
                  📄 PDF unavailable{r.pdfError ? ` — ${r.pdfError}` : ""}
                </Notice>
              )}
              {!r.xlsxUrl && (r.xlsxStatus === "failed" || r.xlsxError) && (
                <Notice tone="danger" density="compact">
                  📊 XLSX unavailable{r.xlsxError ? ` — ${r.xlsxError}` : ""}
                </Notice>
              )}
              {!r.csvUrl && (r.csvStatus === "failed" || r.csvError) && (
                <Notice tone="danger" density="compact">
                  📋 CSV unavailable{r.csvError ? ` — ${r.csvError}` : ""}
                </Notice>
              )}
              {!r.reportUrl && r.pdfStatus === "failed" && (
                <RegeneratePdfButton onRegenerated={() => fetchReports()} />
              )}
            </Flex>
            {replayState[r.id]?.result && !replayState[r.id]!.result!.ok && (
              <Notice tone="danger" density="compact">
                Replay failed — {replayState[r.id]!.result!.error}
              </Notice>
            )}
            {replayState[r.id]?.result?.ok && replayState[r.id]!.result!.replay && (
              <Notice tone={replayState[r.id]!.result!.replay!.partial ? "warning" : "success"} density="compact">
                {replaySummary(replayState[r.id]!.result!.replay!)}
                {replayState[r.id]!.result!.replay!.partial &&
                  replayState[r.id]!.result!.replay!.partialReasons &&
                  replayState[r.id]!.result!.replay!.partialReasons!.length > 0 && (
                    <div>Partial: {replayState[r.id]!.result!.replay!.partialReasons!.join(" ")}</div>
                  )}
              </Notice>
            )}
          </Card>
        ))}
      </Stack>
      )}
      </PageSection>
      </>
      )}
    </PageShell>
  );
}
