/**
 * Issue #654: calibration dashboard — predicted vs realized outcomes
 * surfaced from the #340 research track record.
 *
 * Read-only by construction: it renders measured direction accuracy
 * (per thesis, per strategy, per regime, per month) and takes no action,
 * so the drafts-only / HITL-preview rule for money actions has nothing
 * to gate. A thesis with fewer than the server's low-sample threshold
 * evaluated ideas is flagged, never hidden — small samples are labeled
 * as such, per #17's measurement-not-marketing rule. Portfolio-context
 * adjustments are deliberately NOT shown: they need #17's opt-in
 * position context, which is not built; the per-regime table is recorded
 * market context, not a portfolio modifier.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";
import { Badge, Card, CardHeader, EmptyState, Notice, Spinner, Table } from "./components/ui";
import type { CalibrationDashboard as CalibrationData } from "../services/calibrationReport";

function formatPct(hitRate: number | null): string {
  return hitRate == null ? "—" : `${(hitRate * 100).toFixed(1)}%`;
}

interface SliceRow {
  key: string;
  evaluated: number;
  hits: number;
  hitRate: number | null;
}

function sliceColumns(lowSampleThreshold: number) {
  return [
    { key: "key", header: "Group", render: (row: SliceRow) => row.key },
    {
      key: "evaluated",
      header: "Evaluated",
      align: "right" as const,
      render: (row: SliceRow) => String(row.evaluated),
    },
    {
      key: "hits",
      header: "Direction correct",
      align: "right" as const,
      render: (row: SliceRow) => String(row.hits),
    },
    {
      key: "hitRate",
      header: "Hit rate",
      align: "right" as const,
      render: (row: SliceRow) => (
        <>
          {formatPct(row.hitRate)}{" "}
          {row.evaluated < lowSampleThreshold && (
            <Badge tone="warning">Low sample</Badge>
          )}
        </>
      ),
    },
  ];
}

export function CalibrationDashboard({ userLogin }: { userLogin?: string }) {
  const [calibration, setCalibration] = useState<CalibrationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await apiFetch("/api/research/track-record/calibration", {
        headers: {
          "Content-Type": "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "calibration API unavailable");
      }
      const body = (await resp.json()) as { calibration?: CalibrationData };
      if (!body.calibration) throw new Error("calibration API unavailable");
      setCalibration(body.calibration);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "calibration API unavailable"
      );
    } finally {
      setLoading(false);
    }
  }, [userLogin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="Loading calibration" />;
  if (loadError) {
    return (
      <Notice tone="danger" title="Calibration unavailable">
        {loadError}
      </Notice>
    );
  }
  if (!calibration || calibration.totalEvaluated === 0) {
    return (
      <EmptyState
        title="No evaluated ideas yet"
        description="Calibration appears once published ideas have scheduled evaluations with a scored direction. Ideas published but not yet scored are counted as pending, never as misses."
      />
    );
  }

  const thesisRows: SliceRow[] = calibration.byThesis.map((t) => ({
    key: t.thesis,
    evaluated: t.evaluated,
    hits: t.hits,
    hitRate: t.hitRate,
  }));

  return (
    <section aria-label="Calibration dashboard">
      <CardHeader title="Calibration dashboard" />
      <p>
        Predicted vs realized direction, measured over the research track
        record. Hit rate is a measurement, not a promise — and a thesis
        with fewer than {calibration.lowSampleThreshold} evaluated ideas is
        flagged low-sample.
      </p>
      <Card>
        <p>
          <strong>Overall hit rate: {formatPct(calibration.overallHitRate)}</strong>
        </p>
        <p>
          {calibration.totalEvaluated} ideas evaluated
          {calibration.pending > 0 &&
            ` · ${calibration.pending} published but not yet scored`}
        </p>
        {calibration.lowSampleTheses.length > 0 && (
          <p>
            Low-sample theses: {calibration.lowSampleTheses.join(", ")}
          </p>
        )}
      </Card>
      <CardHeader title="Per thesis" />
      <Table
        columns={sliceColumns(calibration.lowSampleThreshold)}
        rows={thesisRows}
        rowKey={(row) => row.key}
        caption="Direction accuracy by thesis"
      />
      <CardHeader title="Per strategy" />
      <Table
        columns={sliceColumns(calibration.lowSampleThreshold)}
        rows={calibration.byStrategy}
        rowKey={(row) => row.key}
        caption="Direction accuracy by strategy structure"
      />
      <CardHeader title="Per regime" />
      <Table
        columns={sliceColumns(calibration.lowSampleThreshold)}
        rows={calibration.byRegime}
        rowKey={(row) => row.key}
        caption="Direction accuracy by recorded market regime"
      />
      <CardHeader title="Hit rate by month" />
      <Table
        columns={sliceColumns(calibration.lowSampleThreshold)}
        rows={calibration.byMonth}
        rowKey={(row) => row.key}
        caption="Direction accuracy by evaluation month"
      />
      <Notice tone="info">
        Portfolio-context adjustments are not shown here: they need #17&apos;s
        opt-in position context, which is not built. The per-regime table is
        recorded market context, not a portfolio modifier.
      </Notice>
    </section>
  );
}
