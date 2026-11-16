import React from "react";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  PillGroup,
  SegmentedControl,
  Spinner,
  Table,
  TextInput,
} from "../../components/ui";
import { apiFetch } from "../../apiFetch";

/**
 * Issue #341: Watchlist & rejected-ideas browser — the §8 outputs beyond
 * the qualified table, as a first-class browsable view over the stored
 * canonical research reports. Filterable by kind and by rejected-gate
 * (reason) code; every row links back to the run it came from.
 */

export interface BrowseEntry {
  kind: "watchlist" | "rejected";
  symbol: string;
  outlook: string;
  structure: string;
  thesis: string;
  reason: string;
  gate: string;
  triggerCondition: string;
  reportId: string;
  reportTitle: string;
  runCreatedAt: string;
}

export function ResearchIdeasBrowser(props: {
  onOpenReport: (reportId: string) => void;
}) {
  const [entries, setEntries] = React.useState<BrowseEntry[]>([]);
  const [gates, setGates] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<"all" | "watchlist" | "rejected">("all");
  const [gate, setGate] = React.useState<string>("all");
  const [query, setQuery] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (kind !== "all") params.set("kind", kind);
      if (gate !== "all") params.set("gate", gate);
      if (query.trim()) params.set("q", query.trim());
      const res = await apiFetch(`/api/reports/research/browse?${params}`);
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = (await res.json()) as any;
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setGates(Array.isArray(data.gates) ? data.gates : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [kind, gate, query]);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="research-browse">
      <div className="research-browse-controls">
        <SegmentedControl
          ariaLabel="Entry kind"
          value={kind}
          onChange={(v) => setKind(v)}
          options={[
            { id: "all", label: "All" },
            { id: "watchlist", label: "Watchlist" },
            { id: "rejected", label: "Rejected" },
          ]}
        />
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by symbol…"
          aria-label="Filter by symbol"
        />
      </div>
      {gates.length > 0 && (
        <PillGroup
          ariaLabel="Rejected gate"
          value={gate}
          onChange={setGate}
          options={[
            { id: "all", label: "All gates" },
            ...gates.map((g) => ({ id: g, label: g })),
          ]}
        />
      )}
      {loading && (
        <div className="research-detail-loading">
          <Spinner /> Loading watchlist & rejected ideas…
        </div>
      )}
      {error && (
        <Notice tone="danger" title="Could not load the browser">
          {error}{" "}
          <Button variant="secondary" size="sm" onClick={load}>
            Retry
          </Button>
        </Notice>
      )}
      {!loading && !error && (
        <Table
          columns={[
            { key: "symbol", header: "Symbol", render: (e: BrowseEntry) => <strong>{e.symbol}</strong> },
            {
              key: "kind",
              header: "Kind",
              render: (e: BrowseEntry) => (
                <Badge tone={e.kind === "watchlist" ? "info" : "warning"}>{e.kind}</Badge>
              ),
            },
            { key: "outlook", header: "Outlook", render: (e: BrowseEntry) => e.outlook || "—" },
            { key: "structure", header: "Structure", render: (e: BrowseEntry) => e.structure || "—" },
            {
              key: "reason",
              header: "Reason",
              render: (e: BrowseEntry) => (
                <span>
                  {e.kind === "rejected" && e.gate ? <Badge tone="neutral">{e.gate}</Badge> : null}{" "}
                  {e.reason || "—"}
                  {e.kind === "watchlist" && e.triggerCondition
                    ? ` · trigger: ${e.triggerCondition}`
                    : ""}
                </span>
              ),
            },
            {
              key: "run",
              header: "Run",
              render: (e: BrowseEntry) => (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => props.onOpenReport(e.reportId)}
                  title={e.reportTitle}
                >
                  {new Date(e.runCreatedAt).toLocaleDateString()} →
                </Button>
              ),
            },
          ]}
          rows={entries}
          rowKey={(e) => `${e.reportId}-${e.kind}-${e.symbol}`}
          empty={
            <EmptyState
              title="Nothing here yet"
              description="Watchlist and rejected ideas appear after research runs complete; adjust the filters if you expected entries."
            />
          }
        />
      )}
    </div>
  );
}
