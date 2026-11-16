/**
 * Issue #1888: enrichment dashboard panel — the existing dashboard's
 * enrichment surface, built only from the shared UI primitives with
 * token-only styling (repo UX architecture §20).
 *
 * Read + operator action: it renders the enrichment status (active
 * provider, coverage, fallbacks, breaker state, killswitch state,
 * recent runs) and offers the manual killswitch throw/clear. It
 * takes no money action and rewrites nothing: flipping providers
 * is a flag change, and calibration proposals stay proposals.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";
import { Badge, Button, Card, CardHeader, EmptyState, Notice, Spinner, Table } from "./components/ui";

interface EnrichmentRunSummary {
  id: string;
  jobId: string;
  stage: string;
  provider: string;
  mode: string;
  symbolsRequested: number;
  symbolsServed: number;
  barsFetched: number;
  fallbacks: number;
  partial: boolean;
  stopped: boolean;
  createdAt: string;
}

interface EnrichmentStatus {
  ok: boolean;
  provider: string;
  mode: string;
  flag: Record<string, boolean>;
  alpacaConfigured: boolean;
  killswitch: string;
  globalHalt: boolean;
  stopped: boolean;
  breakerState: Array<{ providerId: string; state: string }>;
  quality: {
    runs: number;
    symbolsRequested: number;
    symbolsServed: number;
    barsFetched: number;
    fallbacks: number;
    partialRuns: number;
    stoppedRuns: number;
    coveragePct: number;
  };
  recentRuns: EnrichmentRunSummary[];
}

export function EnrichmentDashboard({ userLogin }: { userLogin?: string }) {
  const [status, setStatus] = useState<EnrichmentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await apiFetch("/api/enrichment/status", {
        headers: {
          "Content-Type": "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
      });
      if (!resp.ok) throw new Error(`Enrichment status failed (${resp.status})`);
      setStatus((await resp.json()) as EnrichmentStatus);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load enrichment status.");
    } finally {
      setLoading(false);
    }
  }, [userLogin]);

  useEffect(() => {
    void load();
  }, [load]);

  const setKillswitch = useCallback(
    async (state: "halted" | "clear") => {
      setActionError(null);
      try {
        const resp = await apiFetch("/api/enrichment/killswitch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(userLogin ? { "x-user-login": userLogin } : {}),
          },
          body: JSON.stringify({ state, reason: "dashboard operator action" }),
        });
        if (!resp.ok) throw new Error(`Killswitch change failed (${resp.status})`);
        await load();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Killswitch change failed.");
      }
    },
    [load, userLogin],
  );

  if (loading) return <Spinner label="Loading enrichment status" />;
  if (loadError || !status) {
    return <Notice tone="danger">{loadError ?? "Enrichment status unavailable."}</Notice>;
  }

  const providerLabel = status.provider === "alpaca" ? "Alpaca" : "Yahoo";
  return (
    <Card>
      <CardHeader title="Daily enrichment + minute bars" />
      <p>
        Active provider: <strong>{providerLabel}</strong> ({status.mode})
        {!status.alpacaConfigured && status.provider === "yahoo" && (
          <> — Alpaca unconfigured, Yahoo is the fail-safe provider</>
        )}
      </p>
      <p>
        Killswitch:{" "}
        {status.killswitch === "halted" ? (
          <Badge tone="warning">Thrown — loop stopped</Badge>
        ) : (
          <Badge tone="success">Clear</Badge>
        )}{" "}
        {status.globalHalt && <Badge tone="warning">Global halt active</Badge>}
      </p>
      <p>
        Coverage: {status.quality.symbolsServed}/{status.quality.symbolsRequested} symbols
        ({status.quality.coveragePct}%) · {status.quality.barsFetched} bars fetched ·{" "}
        {status.quality.fallbacks} fallbacks · {status.quality.partialRuns} partial runs
      </p>
      <p>
        Breakers:{" "}
        {status.breakerState.length === 0
          ? "no breaker state reported"
          : status.breakerState.map((b) => `${b.providerId}: ${b.state}`).join(" · ")}
      </p>
      {actionError && <Notice tone="danger">{actionError}</Notice>}
      <div>
        <Button type="button" onClick={() => void setKillswitch("halted")}>
          Throw killswitch (stop loop)
        </Button>{" "}
        <Button type="button" onClick={() => void setKillswitch("clear")}>
          Clear killswitch (resume loop)
        </Button>{" "}
        <Button type="button" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {status.recentRuns.length === 0 ? (
        <EmptyState
          title="No enrichment runs yet"
          description="Runs appear here once enrichment executes for a job."
        />
      ) : (
        <Table
          columns={[
            { key: "jobId", header: "Job", render: (row: EnrichmentRunSummary) => row.jobId },
            { key: "stage", header: "Stage", render: (row: EnrichmentRunSummary) => row.stage },
            { key: "provider", header: "Provider", render: (row: EnrichmentRunSummary) => row.provider },
            {
              key: "coverage",
              header: "Coverage",
              render: (row: EnrichmentRunSummary) =>
                `${row.symbolsServed}/${row.symbolsRequested}`,
            },
            { key: "barsFetched", header: "Bars", render: (row: EnrichmentRunSummary) => String(row.barsFetched) },
            {
              key: "outcome",
              header: "Outcome",
              render: (row: EnrichmentRunSummary) =>
                row.stopped ? "Stopped" : row.partial ? "Partial" : "Complete",
            },
          ]}
          rows={status.recentRuns}
          rowKey={(row) => row.id}
        />
      )}
    </Card>
  );
}
