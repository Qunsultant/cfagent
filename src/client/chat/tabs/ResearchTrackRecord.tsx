import React from "react";
import { Badge, Button, EmptyState, Notice, Spinner, Table } from "../../components/ui";
import { apiFetch } from "../../apiFetch";

/**
 * Issue #340: Track-record surface — published research ideas joined to
 * their scheduled §9 evaluation outcomes. Hit rate, R multiples, and
 * by-strategy / by-period slices over what was recorded; ideas that
 * were never evaluated stay visible as "not evaluated". Nothing here is
 * recomputed or edited retrospectively.
 */

export interface TrackIdea {
  runId: string;
  runCreatedAt: string;
  symbol: string;
  structure: string;
  outlook: string;
  thesis: string;
  invalidation: string;
  entrySpot: number | null;
  evaluation: {
    evaluatedAt: string;
    invalidated: boolean;
    pnlEstimatePerUnit: number | null;
    rMultiple: number | null;
    evalSpot: number | null;
    directionCorrect: boolean | null;
    notes: string[];
  } | null;
}

export interface TrackSlice {
  key: string;
  published: number;
  evaluated: number;
  winRate: number | null;
  avgRMultiple: number | null;
}

export interface TrackRecordData {
  published: number;
  evaluated: number;
  invalidated: number;
  winRate: number | null;
  directionAccuracy: number | null;
  avgPnlPerUnit: number | null;
  avgRMultiple: number | null;
  byStrategy: TrackSlice[];
  byPeriod: TrackSlice[];
  ideas: TrackIdea[];
}

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function money(v: number | null): string {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}

function rMult(v: number | null): string {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
}

export function TrackRecordView(props: { data: TrackRecordData }) {
  const d = props.data;
  return (
    <div className="track-record">
      <div className="research-detail-meta">
        <Badge tone="neutral">Published: {d.published}</Badge>
        <Badge tone="neutral">Evaluated: {d.evaluated}</Badge>
        <Badge tone={d.invalidated > 0 ? "warning" : "neutral"}>
          Invalidated: {d.invalidated}
        </Badge>
        <Badge tone="info">Win rate: {pct(d.winRate)}</Badge>
        <Badge tone="info">Direction accuracy: {pct(d.directionAccuracy)}</Badge>
        <Badge tone="neutral">Avg P&amp;L/unit: {money(d.avgPnlPerUnit)}</Badge>
        <Badge tone="neutral">Avg R: {rMult(d.avgRMultiple)}</Badge>
      </div>

      <h4>By strategy</h4>
      <Table
        columns={[
          { key: "key", header: "Strategy", render: (s: TrackSlice) => s.key },
          { key: "published", header: "Published", render: (s: TrackSlice) => s.published, align: "right" },
          { key: "evaluated", header: "Evaluated", render: (s: TrackSlice) => s.evaluated, align: "right" },
          { key: "winRate", header: "Win rate", render: (s: TrackSlice) => pct(s.winRate), align: "right" },
          { key: "avgR", header: "Avg R", render: (s: TrackSlice) => rMult(s.avgRMultiple), align: "right" },
        ]}
        rows={d.byStrategy}
        rowKey={(s) => s.key}
        empty={<EmptyState title="No strategies recorded yet." />}
      />

      <h4>By period</h4>
      <Table
        columns={[
          { key: "key", header: "Period", render: (s: TrackSlice) => s.key },
          { key: "published", header: "Published", render: (s: TrackSlice) => s.published, align: "right" },
          { key: "evaluated", header: "Evaluated", render: (s: TrackSlice) => s.evaluated, align: "right" },
          { key: "winRate", header: "Win rate", render: (s: TrackSlice) => pct(s.winRate), align: "right" },
          { key: "avgR", header: "Avg R", render: (s: TrackSlice) => rMult(s.avgRMultiple), align: "right" },
        ]}
        rows={d.byPeriod}
        rowKey={(s) => s.key}
        empty={<EmptyState title="No periods recorded yet." />}
      />

      <h4>Published ideas vs outcomes</h4>
      <Table
        columns={[
          { key: "symbol", header: "Symbol", render: (i: TrackIdea) => <strong>{i.symbol}</strong> },
          { key: "structure", header: "Structure", render: (i: TrackIdea) => i.structure || "—" },
          {
            key: "published",
            header: "Published",
            render: (i: TrackIdea) => new Date(i.runCreatedAt).toLocaleDateString(),
          },
          { key: "entry", header: "Entry spot", render: (i: TrackIdea) => money(i.entrySpot), align: "right" },
          {
            key: "outcome",
            header: "Outcome",
            render: (i: TrackIdea) =>
              i.evaluation == null ? (
                <Badge tone="neutral">not evaluated</Badge>
              ) : i.evaluation.invalidated ? (
                <Badge tone="danger">invalidated</Badge>
              ) : (
                <Badge tone={(i.evaluation.pnlEstimatePerUnit ?? 0) > 0 ? "success" : "warning"}>
                  {money(i.evaluation.pnlEstimatePerUnit)} ({rMult(i.evaluation.rMultiple)})
                </Badge>
              ),
          },
          {
            key: "direction",
            header: "Direction",
            render: (i: TrackIdea) =>
              i.evaluation?.directionCorrect == null
                ? "—"
                : i.evaluation.directionCorrect
                  ? "✓ correct"
                  : "✗ wrong",
          },
        ]}
        rows={d.ideas}
        rowKey={(i) => `${i.runId}-${i.symbol}-${i.structure}`}
        empty={
          <EmptyState
            title="No published ideas yet"
            description="The track record fills in as research runs publish ideas and scheduled evaluations score them."
          />
        }
      />
    </div>
  );
}

export function ResearchTrackRecord() {
  const [state, setState] = React.useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "loaded"; data: TrackRecordData }
  >({ phase: "loading" });

  const load = React.useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await apiFetch(`/api/research/track-record`);
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = (await res.json()) as any;
      if (!data.trackRecord) throw new Error("Track record unavailable");
      setState({ phase: "loaded", data: data.trackRecord as TrackRecordData });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Failed to load",
      });
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <div className="research-detail-loading">
        <Spinner /> Loading track record…
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <Notice tone="danger" title="Could not load the track record">
        {state.message}{" "}
        <Button variant="secondary" size="sm" onClick={load}>
          Retry
        </Button>
      </Notice>
    );
  }
  return <TrackRecordView data={state.data} />;
}
