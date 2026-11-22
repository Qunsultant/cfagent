/**
 * Issue #5425 (#3515 S5) — the SLO panel: the two #3515 SLOs
 * (uptime, P95 API latency) as health states against the
 * tenant's configured thresholds (`?tab=observability&view=slo`).
 *
 * A READ surface, not a configuration surface: thresholds are
 * configured per tenant in the tenant admin panel, never here.
 * The panel renders whatever GET /api/otel/v1/slo reports —
 * within / breached / unconfigured / no-data — and states
 * plainly when a threshold is unconfigured or no requests have
 * been recorded yet, instead of inventing compliance.
 *
 * Honest states: a failed fetch renders its error; an
 * unconfigured SLO shows "Unconfigured" with no measured
 * compliance; a configured SLO with no requests yet shows "No
 * data yet". Composed from ui/ primitives (ADR-0004): Stack
 * for layout, Spinner for loading, Notice for the fail-closed
 * notes, Table for the SLO rows. No bespoke className tokens,
 * no inline styles, no CSS imports.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Spinner, Stack, Table, type TableColumn } from "./components/ui";
import {
  fetchOtelSlo,
  type OtelSloResponse,
  type SloStatus,
} from "./otelSloApi";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; response: OtelSloResponse };

/** The status word the operator reads. */
export function formatSloStatus(status: SloStatus): string {
  if (status === "within") return "Within SLO";
  if (status === "breached") return "Breached";
  if (status === "unconfigured") return "Unconfigured";
  return "No data yet";
}

/** A ratio as a percent with two decimals (0.9833 → "98.33%"). */
export function formatSloPercent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

interface SloRow {
  key: "uptime" | "p95";
  slo: string;
  status: SloStatus;
  measured: string;
  target: string;
}

const SLO_COLUMNS: TableColumn<SloRow>[] = [
  { key: "slo", header: "SLO", render: (row) => row.slo },
  { key: "status", header: "Status", render: (row) => formatSloStatus(row.status) },
  { key: "measured", header: "Measured", render: (row) => row.measured, align: "right" },
  { key: "target", header: "Target", render: (row) => row.target, align: "right" },
];

function sloRows(response: OtelSloResponse): SloRow[] {
  return [
    {
      key: "uptime",
      slo: "Uptime",
      status: response.uptime.status,
      measured: formatSloPercent(response.uptime.value),
      target: formatSloPercent(response.uptime.target),
    },
    {
      key: "p95",
      slo: "P95 API latency",
      status: response.p95Latency.status,
      measured: response.p95Latency.valueMs === null ? "—" : `${response.p95Latency.valueMs} ms`,
      target: response.p95Latency.targetMs === null ? "—" : `${response.p95Latency.targetMs} ms`,
    },
  ];
}

export function SloPanel({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", response: await fetchOtelSlo(tenantId) });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load SLO compliance.",
      });
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") return <Spinner />;
  if (state.status === "error") {
    return (
      <Stack gap="2">
        <Notice tone="danger">{state.message}</Notice>
        <div>
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      </Stack>
    );
  }

  const response = state.response;
  const evaluatedAt = new Date(response.evaluatedAtMs).toLocaleString();
  return (
    <Stack gap="2">
      <Notice tone="info">
        SLO compliance for tenant {response.tenantId}, evaluated {evaluatedAt} over{" "}
        {response.sample.totalRequests} recorded requests ({response.sample.failedRequests} failed,{" "}
        {response.sample.latencySamples} latency samples). Thresholds are configured per tenant in
        the tenant admin panel — this view only reports. Each isolate evaluates the requests it
        served, so the values above are the current isolate&apos;s window.
      </Notice>
      <Table<SloRow>
        caption="SLO compliance"
        columns={SLO_COLUMNS}
        rows={sloRows(response)}
        rowKey={(row) => row.key}
      />
      <div>
        <Button onClick={() => void load()}>Refresh</Button>
      </div>
    </Stack>
  );
}
