/**
 * Issue #3605 — the one job-detail view, shared by the queue panel
 * (`AsyncJobsPanel`) and the Run ledger (`ScheduleRunLedgerPanel`).
 *
 * One UX, reuse over reinvent (#1069): the fetch (`GET
 * /api/jobs/<id>`) and the result rendering live here exactly once.
 * Both call sites render this component; neither fetches a job detail
 * itself, and no second detail page exists.
 *
 * Variants preserve the queue panel's two existing presentations:
 * - "embedded": the settings-box presentation (Task header, Export
 *   JSON button, 10k preview).
 * - "standalone": the details-panel presentation (Download button,
 *   100k preview).
 * `onClose` is optional: the ledger passes it (the viewer sits below
 * the table and closes back to the ledger); the queue panel does not
 * (its selection persists, as before).
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "./components/ui";

export interface AsyncJobResultViewerProps {
  jobId: string | null | undefined;
  variant?: "embedded" | "standalone";
  onClose?: () => void;
}

export function AsyncJobResultViewer({
  jobId,
  variant = "standalone",
  onClose,
}: AsyncJobResultViewerProps) {
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const resultJson = useMemo(
    () => (result === undefined ? "" : JSON.stringify(result, null, 2)),
    [result],
  );

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    setLoading(true);
    setResult(undefined);
    setError("");
    void (async () => {
      try {
        const response = await globalThis.fetch(`/api/jobs/${jobId}`);
        const job = (await response.json()) as {
          result?: unknown;
          error?: string;
          status?: string;
        };
        if (!response.ok) throw new Error(job.error || "Could not load job result.");
        if (job.status === "failed") throw new Error(job.error || "Async job failed.");
        if (!cancelled) setResult(job.result);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load job result.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!jobId) return null;

  const previewChars = variant === "embedded" ? 10_000 : 100_000;
  const truncatedNote =
    variant === "embedded"
      ? "\n… preview truncated; download full JSON."
      : "\n… preview truncated; download the full result.";

  const downloadResult = () => {
    if (result === undefined) return;
    const blobUrl = URL.createObjectURL(new Blob([resultJson], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `async-job-${jobId}.json`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  };

  if (variant === "embedded") {
    return (
      <div className="settings-async-result-container">
        <div className="async-result-header">
          <span className="result-job-id" title={jobId}>
            Task: {jobId.slice(0, 14)}…
          </span>
          <Button
            type="button"
            className="btn-async-download"
            onClick={downloadResult}
            title="Export JSON result"
          >
            📥 Export JSON
          </Button>
          {onClose && (
            <Button type="button" className="btn-async-download" onClick={onClose} title="Close the job detail">
              Close
            </Button>
          )}
        </div>
        {loading && <p className="async-jobs-error">Loading job result…</p>}
        {error && (
          <p className="async-jobs-error" role="alert">
            {error}
          </p>
        )}
        {result !== undefined && (
          <pre className="settings-async-result-body">
            {resultJson.slice(0, previewChars)}
            {resultJson.length > previewChars ? truncatedNote : ""}
          </pre>
        )}
      </div>
    );
  }

  return (
    <>
      <Button type="button" onClick={downloadResult}>
        Download full result
      </Button>
      {onClose && (
        <Button type="button" onClick={onClose} title="Close the job detail">
          Close
        </Button>
      )}
      {loading && <p className="async-jobs-error">Loading job result…</p>}
      {error && (
        <p className="async-jobs-error" role="alert">
          {error}
        </p>
      )}
      {result !== undefined && (
        <pre className="async-jobs-result">
          {resultJson.slice(0, previewChars)}
          {resultJson.length > previewChars ? truncatedNote : ""}
        </pre>
      )}
    </>
  );
}
