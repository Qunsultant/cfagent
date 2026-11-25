/**
 * Issue 6273 — Opportunity Hunt sub-tab panel (Stock Hub), reworked into a
 * report-style view by issue 6406 (UX first; the report in issue 6403 is
 * deferred and must generate the same output this panel shows).
 *
 * Runs the hunt on demand and shows its output as a report. Issue 6479: the
 * report BODY is `OpportunityHuntReportView`, rendered from the one shared
 * `buildOpportunityHuntReportModel` — the same model the PDF renderer reads.
 * This module is the shell around it: run controls, the report link/Share row,
 * failures, and the latest scheduled run. It makes no content decision of its
 * own, so the page cannot drift from the downloadable report.
 *
 * The hunt itself is unchanged — the panel calls the synchronous run seam
 * (POST /api/opportunity-hunt/run), which reuses the hunt as-is over the
 * persisted technicals bars. A run that finds nothing is a completed hunt (an
 * empty table), not an error; only an unreadable bar source fails, with its
 * named reason shown.
 *
 * Exit signals come from the tenant's holdings, which the run seam loads from
 * the selected broker and feeds to the evaluator. When the holdings read is
 * unavailable the run still completes on entries only, and the report states
 * the reason — exits are never silently dropped.
 *
 * Built only from src/client/components/ui primitives, token-only styling. No
 * broker or provider is named here: the hunt reads the persisted technicals
 * bars, and the run carries no venue selection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, CardHeader, EmptyState, Notice, PageSection } from "./components/ui";
import { asyncJobErrorCode } from "./apiFetch";
import { codedMessage } from "../outcomes/outcomeAspects";
import {
  generateOpportunityHuntReport,
  listAllRuns,
  runOpportunityHuntNow,
  type JobRunRecord,
} from "./jobsApi";
import { ReportLinkRow } from "./ReportLinkRow";
import type { OpportunityHuntResult } from "../services/opportunityHunt";
import { OpportunityHuntReportView } from "./OpportunityHuntReportView";
import { buildOpportunityHuntReportModel } from "./opportunityHuntReportModel";

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
  const [errorJobId, setErrorJobId] = useState<string | null>(null);
  const [result, setResult] = useState<OpportunityHuntResult | null>(null);
  const [lastRun, setLastRun] = useState<JobRunRecord | null>(null);
  const [lastRunError, setLastRunError] = useState<string | null>(null);
  // Issue #6293 — a visible status line while a run is pending.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  // Issue 6403 — the downloadable report (PDF) for the current result.
  // Issue #6473 — the generated report is addressable: keep its URL so the
  // panel can offer the link and a Share button, not only a download.
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLink, setReportLink] = useState<string | null>(null);

  useEffect(() => {
    if (runStartedAt === null) return;
    const id = setInterval(
      () => setElapsedSec(Math.floor((Date.now() - runStartedAt) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [runStartedAt]);

  const refreshLastRun = useCallback(async () => {
    try {
      const { runs } = await listAllRuns(HUNT_JOB_ID, 50);
      setLastRun(runs[0] ?? null);
    } catch (cause) {
      setLastRunError(
        cause instanceof Error ? cause.message : "Could not read the run ledger.",
      );
    }
  }, []);

  useEffect(() => {
    void refreshLastRun();
  }, [refreshLastRun]);

  // Issue 6479 — one model for the page; the PDF builds the same one.
  const model = useMemo(
    () => (result ? buildOpportunityHuntReportModel(result) : null),
    [result],
  );

  const runNow = async () => {
    setRunning(true);
    setError(null);
    setErrorJobId(null);
    setElapsedSec(0);
    setRunStartedAt(Date.now());
    try {
      const res = await runOpportunityHuntNow();
      setResult(res);
    } catch (cause) {
      // Issue #6293 — classify structurally, never render the raw transport
      // text. A 408/500 from the 202 poll carries a job id: the caller renders
      // the catalog message for the code (`asyncJobErrorCode`), with the job id
      // so the run can be found in the ledger. A genuine hunt failure (a named
      // reason such as an unreadable bar source) has no async-job code and its
      // named reason is shown as-is.
      const failure = cause as { status?: number; data?: unknown };
      const code =
        typeof failure.status === "number"
          ? asyncJobErrorCode(failure.status, failure.data)
          : undefined;
      if (code) {
        const jobId = (failure.data as { jobId?: string } | null)?.jobId ?? null;
        setError(codedMessage(code));
        setErrorJobId(jobId);
      } else {
        setError(cause instanceof Error ? cause.message : "The hunt could not run.");
      }
    } finally {
      setRunning(false);
      setRunStartedAt(null);
    }
  };

  const downloadReport = async () => {
    if (!result || reportBusy) return;
    setReportBusy(true);
    setReportError(null);
    try {
      const { reportUrl } = await generateOpportunityHuntReport(result);
      setReportLink(reportUrl);
      const anchor = document.createElement("a");
      anchor.href = reportUrl;
      anchor.download = "";
      anchor.click();
    } catch (cause) {
      setReportError(
        cause instanceof Error ? cause.message : "The report could not be generated.",
      );
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <PageSection
      title="Opportunity Hunt"
      description="Entry and exit signals from the pattern strategies over the tradable universe's daily closes. Run it on demand here; the scheduled goal also fires daily, and its runs land in the run ledger."
    >
      <Card>
        <Button variant="primary" onClick={runNow} loading={running}>
          Run hunt now
        </Button>{" "}
        <Button
          variant="secondary"
          onClick={downloadReport}
          loading={reportBusy}
          disabled={!result}
          title={result ? "Download this run as a coloured PDF report" : "Run the hunt first"}
        >
          Download report (PDF)
        </Button>
        <Button
          variant="secondary"
          onClick={() => void downloadReport()}
          loading={reportBusy}
          disabled={!result}
          title={result ? "Get a shareable link to this run's report" : "Run the hunt first"}
        >
          Report link
        </Button>
        {reportLink ? <ReportLinkRow url={reportLink} /> : null}
        {reportError ? (
          <Notice tone="danger" title="The report could not be generated">
            {reportError}
          </Notice>
        ) : null}
        {running ? (
          <p>
            Running… {elapsedSec}s elapsed. The hunt reads the persisted bars and
            returns its setups here.
          </p>
        ) : null}
        {error ? (
          <Notice tone="danger" title="The hunt could not run">
            {error}
            {errorJobId ? (
              <p>
                <a href="/?tab=schedules&view=runs">
                  Check the run ledger for job {errorJobId}
                </a>
              </p>
            ) : null}
          </Notice>
        ) : null}
        {model ? <OpportunityHuntReportView model={model} /> : null}
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
