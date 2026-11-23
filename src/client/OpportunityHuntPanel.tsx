/**
 * Issue 6273 — Opportunity Hunt sub-tab panel (Stock Hub).
 *
 * Runs the hunt on demand and shows its output: the setups per
 * symbol/strategy, the scanned/skipped counts, and the run time. The
 * hunt itself is unchanged — the panel calls the synchronous run seam
 * (POST /api/opportunity-hunt/run), which reuses the hunt as-is over
 * the persisted technicals bars. A run that finds nothing is a
 * completed hunt (an empty table), not an error; only an unreadable
 * bar source fails, with its named reason shown.
 *
 * The panel also shows the latest scheduled run from the run ledger
 * (the daily scheduled goal firing, or a run triggered from the
 * ledger), so the on-demand result and the scheduled history sit side
 * by side. The on-demand run writes no ledger row — its result is
 * shown here immediately.
 *
 * Built only from src/client/components/ui primitives, token-only
 * styling. No broker or provider is named here: the hunt reads the
 * persisted technicals bars, and the run carries no venue selection.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  PageSection,
  Table,
} from "./components/ui";
import {
  listAllRuns,
  runOpportunityHuntNow,
  type JobRunRecord,
} from "./jobsApi";
import type {
  OpportunityHuntResult,
  OpportunityHuntSetup,
} from "../services/opportunityHunt";

/** The goal id the scheduled hunt records under. */
const HUNT_JOB_ID = "opportunity-hunt";

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

export function OpportunityHuntPanel() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OpportunityHuntResult | null>(null);
  const [lastRun, setLastRun] = useState<JobRunRecord | null>(null);
  const [lastRunError, setLastRunError] = useState<string | null>(null);

  const refreshLastRun = useCallback(async () => {
    try {
      const { runs } = await listAllRuns(HUNT_JOB_ID, 50);
      setLastRun(runs[0] ?? null);
    } catch (cause) {
      setLastRunError(
        cause instanceof Error
          ? cause.message
          : "Could not read the run ledger.",
      );
    }
  }, []);

  useEffect(() => {
    void refreshLastRun();
  }, [refreshLastRun]);

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await runOpportunityHuntNow();
      setResult(res);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The hunt could not run.",
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <PageSection
      title="Opportunity Hunt"
      description="Entry signals from the pattern strategies over the tradable universe's daily closes. Run it on demand here; the scheduled goal also fires daily, and its runs land in the run ledger."
    >
      <Card>
        <Button variant="primary" onClick={runNow} loading={running}>
          Run hunt now
        </Button>
        {error ? (
          <Notice tone="danger" title="The hunt could not run">
            {error}
          </Notice>
        ) : null}
        {result ? (
          <>
            <p>
              {result.summary} (as of {formatTime(result.asOf)})
            </p>
            <Table<OpportunityHuntSetup>
              columns={[
                { key: "symbol", header: "Symbol", render: (row) => row.symbol },
                {
                  key: "strategy",
                  header: "Strategy",
                  render: (row) => row.strategy,
                },
              ]}
              rows={result.setups}
              rowKey={(row) => `${row.symbol}:${row.strategy}`}
              caption="Symbols whose latest bar produced an entry signal"
              empty={
                <EmptyState
                  title="No setups"
                  description="The latest bar produced no entry signal for any symbol."
                />
              }
            />
            <p>
              Scanned {result.scanned} symbol(s)
              {result.skipped > 0
                ? `, ${result.skipped} skipped (short history)`
                : ""}
              .
            </p>
          </>
        ) : null}
      </Card>
      <Card>
        <CardHeader title="Latest scheduled run" />
        {lastRunError ? (
          <Notice tone="warning" title="The run ledger could not be read">
            {lastRunError}
          </Notice>
        ) : lastRun ? (
          <p>
            {formatTime(lastRun.finished)} — {lastRun.outcome}
            {lastRun.descriptor ? `: ${lastRun.descriptor}` : ""}
          </p>
        ) : (
          <EmptyState
            title="No scheduled run yet"
            description="The scheduled goal has not recorded a hunt run in the ledger."
          />
        )}
        <p>
          <a href="/?tab=schedules&view=runs">Open the run ledger</a>
        </p>
      </Card>
    </PageSection>
  );
}
