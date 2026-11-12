/**
 * IV History viewer (issue #274).
 *
 * Surfaces the daily E*TRADE option-chain IV snapshots collected by the
 * scheduled job: per-symbol coverage, IV rank over time, latest readings.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, PageSection, Select, Table } from "./components/ui";
import { brokerSupports, isBrokerId } from "../trading";
import { readTenantProvidersState } from "./tenantProviders";

/**
 * Issue #3326: IV history is collected per broker — each observation records
 * which broker's chain produced it — so the panel shows the selected broker's
 * own series. A broker that cannot collect is refused by name, and a broker
 * with no observations yet says so instead of showing another broker's rows.
 */
function ivHistoryRefusal(): string | null {
  const broker = readTenantProvidersState().brokerId;
  if (!isBrokerId(broker)) return `IV history is not available for the selected broker (${broker}).`;
  if (brokerSupports(broker, "ivHistory")) return null;
  return `IV history is not available for ${broker}; no other broker's series is shown in its place.`;
}

interface IvEntry {
  symbol: string;
  observations: number;
  coveragePct: number;
  warmingUp: boolean;
  latest: {
    date: string;
    atmIv: number;
    spot: number;
    expiryDate: string;
    dte: number;
  } | null;
  ivRank: number | null;
  ivPercentile: number | null;
}

interface IvSeriesPoint {
  date: string;
  atmIv: number;
  spot: number;
}

function IvSparkline({ series }: { series: IvSeriesPoint[] }) {
  if (series.length < 2) return <div style={{ color: "var(--color-text-muted)" }}>Not enough data for chart</div>;
  const W = 560;
  const H = 160;
  const PAD = 28;
  const vals = series.map((p) => p.atmIv * 100);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (series.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.atmIv * 100).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} style={{ border: "1px solid var(--color-border-medium)", borderRadius: 4 }}>
      <text x={PAD} y={14} fontSize={10} fill="var(--color-text-muted)">ATM IV % — {series[0].date} → {series[series.length - 1].date}</text>
      <text x={4} y={y(max) + 3} fontSize={9} fill="var(--color-text-muted)">{max.toFixed(1)}</text>
      <text x={4} y={y(min) + 3} fontSize={9} fill="var(--color-text-muted)">{min.toFixed(1)}</text>
      <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={1.8} />
    </svg>
  );
}

export function IvHistoryPanel() {
  const [names, setNames] = useState<IvEntry[]>([]);
  const [seriesBroker, setSeriesBroker] = useState<string>("");
  const [symbol, setSymbol] = useState("");
  const [detail, setDetail] = useState<(IvEntry & { series?: IvSeriesPoint[] }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadCoverage = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const refusal = ivHistoryRefusal();
      if (refusal) {
        setError(refusal);
        setLoading(false);
        return;
      }
      const res = await fetch("/api/etrade/options/iv-history");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { names?: IvEntry[]; broker?: string };
      setNames(data.names ?? []);
      setSeriesBroker(data.broker ?? "");
      if (data.names?.length && !symbol) setSymbol(data.names[0].symbol);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load IV history");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  const loadDetail = useCallback(async (sym: string) => {
    if (!sym) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/etrade/options/iv-history?symbol=${encodeURIComponent(sym)}&series=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as IvEntry & { series?: IvSeriesPoint[] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load symbol detail");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCoverage();
  }, [loadCoverage]);

  useEffect(() => {
    if (symbol) loadDetail(symbol);
  }, [symbol, loadDetail]);

  const totalObs = names.reduce((n, e) => n + e.observations, 0);

  return (
    <PageSection title="IV History">
      <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", marginBottom: "1rem" }}>
        Daily {seriesBroker ? `${seriesBroker} ` : ""}option-chain snapshots · {names.length} symbols · {totalObs} observations ·{" "}
        <Button onClick={loadCoverage} style={{ fontSize: "var(--font-size-body-sm)" }}>↻ Refresh</Button>
      </div>
      {error && <div style={{ color: "var(--color-danger)" }}>{error}</div>}
      {loading && !names.length && <div>Loading…</div>}
      {!loading && !error && names.length > 0 && totalObs === 0 && (
        <div data-iv-series-empty={seriesBroker} className="ui-empty-text">
          No observations recorded for {seriesBroker || "this broker"} yet — the series starts with the first
          collection run on this broker. Nothing is backfilled or relabelled.
        </div>
      )}

      {names.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-6)", flexWrap: "wrap" }}>
          <div style={{ minWidth: 260 }}>
            <Select label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {names.map((n) => (
                <option key={n.symbol} value={n.symbol}>
                  {n.symbol} ({n.observations} obs)
                </option>
              ))}
            </Select>
            <div style={{ marginTop: "var(--space-3)" }}>
              <Table
                columns={[
                  {
                    key: "symbol",
                    header: "Symbol",
                    render: (n) => <strong>{n.symbol}</strong>,
                    cellStyle: (n) => (n.symbol === symbol ? { background: "var(--color-surface-hover)" } : {}),
                  },
                  {
                    key: "obs",
                    header: "Obs",
                    render: (n) => n.observations,
                    cellStyle: (n) => (n.symbol === symbol ? { background: "var(--color-surface-hover)" } : {}),
                  },
                  {
                    key: "ivRank",
                    header: "IV Rank",
                    render: (n) => (n.ivRank == null ? "—" : n.ivRank.toFixed(0)),
                    cellStyle: (n) => (n.symbol === symbol ? { background: "var(--color-surface-hover)" } : {}),
                  },
                  {
                    key: "latest",
                    header: "Latest",
                    render: (n) => n.latest?.date ?? "—",
                    cellStyle: (n) => (n.symbol === symbol ? { background: "var(--color-surface-hover)" } : {}),
                  },
                ]}
                rows={names}
                rowKey={(n) => n.symbol}
                onRowClick={(n) => setSymbol(n.symbol)}
                rowClassName="clickable-row"
              />
            </div>
          </div>

          {detail && (
            <div>
              <h3 style={{ fontSize: "1rem" }}>{detail.symbol}</h3>
              <div style={{ fontSize: "var(--font-size-body)", marginBottom: "0.5rem" }}>
                {detail.observations} observations · coverage {detail.coveragePct.toFixed(0)}% ·{" "}
                {detail.warmingUp ? "warming up" : "active"} ·{" "}
                IV rank {detail.ivRank == null ? "—" : detail.ivRank.toFixed(0)} ·{" "}
                IV percentile {detail.ivPercentile == null ? "—" : detail.ivPercentile.toFixed(0)}
              </div>
              {detail.latest && (
                <div style={{ fontSize: "var(--font-size-body)", marginBottom: "0.75rem" }}>
                  Latest {detail.latest.date}: ATM IV {(detail.latest.atmIv * 100).toFixed(1)}% ·{" "}
                  spot ${detail.latest.spot.toFixed(2)} · {detail.latest.dte} DTE
                </div>
              )}
              {detail.series && <IvSparkline series={detail.series} />}
            </div>
          )}
        </div>
      )}
    </PageSection>
  );
}
