import React, { useEffect, useState } from "react";
import { apiFetch } from "../../apiFetch";
import { Button, TextInput, Select, FileInput } from "../../components/ui";
import { buildJson, downloadTextFile } from "../../runExport";
import type { SearchTabProps } from "../searchTabTypes";

interface CorpusEntryStatus {
  title: string;
  category: string;
  bucketKey: string | null;
  status: "present" | "missing" | "mismatched" | "not-ingested";
}

interface IntegrityReport {
  ok: boolean;
  missing: string[];
  mismatched: string[];
  extra: string[];
  checkedAt: string;
  entries?: CorpusEntryStatus[];
  reason?: string;
}

interface SyncResult {
  success?: boolean;
  skipped?: boolean;
  reason?: string;
  lastFiredAt?: string;
  completed?: boolean;
  integrity?: { ok: boolean };
  backfill?: { upserted: number; skippedRetention: number; rows: number; pages: number; complete: boolean };
  error?: string;
}

interface UploadResult {
  success: boolean;
  title?: string;
  category?: string;
  sourceUrl?: string;
  r2Key?: string;
  contentHash?: string;
  fileName?: string;
  contentType?: string;
  ingestedAt?: string;
  idempotent?: boolean;
  error?: string;
}

/**
 * Corpus tab (#1169, knowledge UI — the panel the S4 survey deferred
 * as its own slice). An admin surface over the three existing
 * corpus routes; it adds no route, no store, no schedule, no
 * listing. Three sections:
 *
 * - Integrity: GET /api/knowledge/integrity (the route runs the
 *   check live; there is no stored report to display). Shows ok,
 *   checkedAt, the missing/mismatched/extra bucket-key lists, and
 *   the per-entry manifest status (expected documents with status —
 *   NOT a stored-documents catalog: the corpus deliberately has NO
 *   listing API, so the panel never presents the manifest as
 *   "stored documents"). Download exports the report JSON via the
 *   shared exporter (#1065 one-exporter rule).
 * - Sync: POST /api/knowledge/corpus-sync. Shows the completed
 *   outcome or the honest skip (skipped + reason, e.g. too-soon
 *   with lastFiredAt). The sync also runs weekly on the existing
 *   every-30-minutes tick; this button is only a manual trigger.
 * - Upload: POST /api/knowledge/corpus. Displays exactly what the
 *   API returns: 201 fresh vs 200 replay plus the returned key
 *   info (r2Key, contentHash, fileName, ingestedAt, idempotent).
 *
 * Contract note: the hub's SearchTabProps comment says no tab
 * fetches on mount — that rule exists so "Search all tabs" does not
 * fire searches. This tab ignores pendingQuery entirely (it is an
 * admin panel, not a search) and loads its audit read on mount;
 * a mount here costs one read-only integrity check, never a
 * search. All failures render as explicit UI states, never stubs.
 *
 * File picker: the ui FileInput primitive (added with this slice —
 * a raw <input type="file"> outside components/ui trips the #1580
 * primitive-usage freeze, so the picker lives with the primitives).
 */
// The four real KnowledgeCategory values (src/services/
// knowledgeCorpus.ts KNOWLEDGE_CATEGORIES). Kept as a local
// literal — the client never imports server modules — and pinned
// against the service const in tests/knowledge_ui_p1169.test.tsx,
// so a service-side category change fails the pin instead of
// silently desyncing the select.
const CATEGORY_OPTIONS = [
  "sec_filing",
  "broker_rules",
  "options_disclosure",
  "market_education",
] as const;

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function entryStatusLabel(status: CorpusEntryStatus["status"]): string {
  switch (status) {
    case "present":
      return "present";
    case "missing":
      return "missing";
    case "mismatched":
      return "mismatched";
    case "not-ingested":
      return "not ingested (no recorded hash)";
  }
}

export function CorpusTab({ onHealth }: SearchTabProps) {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(CATEGORY_OPTIONS[0]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [contentType, setContentType] = useState("");
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadStatus, setUploadStatus] = useState<number | null>(null);

  async function loadReport() {
    const started = Date.now();
    setReportLoading(true);
    setReportError("");
    try {
      const res = await apiFetch("/api/knowledge/integrity");
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "Integrity check failed.");
      setReport(data as IntegrityReport);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      onHealth?.({
        status: "ok",
        hits: entries.length,
        latencyMs: Date.now() - started,
        message: data.ok ? "Corpus intact" : "Corpus has findings",
      });
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Integrity check failed.");
      onHealth?.({ status: "error", hits: 0, latencyMs: Date.now() - started });
    } finally {
      setReportLoading(false);
    }
  }

  useEffect(() => {
    void loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSync() {
    setSyncLoading(true);
    setSyncError("");
    try {
      const res = await apiFetch("/api/knowledge/corpus-sync", { method: "POST" });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "Corpus sync failed.");
      setSyncResult(data as SyncResult);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Corpus sync failed.");
    } finally {
      setSyncLoading(false);
    }
  }

  async function runUpload(e: React.FormEvent) {
    e.preventDefault();
    setUploadError("");
    setUploadResult(null);
    setUploadStatus(null);
    if (!title.trim() || !sourceUrl.trim()) {
      setUploadError("Title and source URL are required.");
      return;
    }
    if (!file) {
      setUploadError("Choose a file to upload.");
      return;
    }
    setUploadLoading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const body: Record<string, string> = {
        title: title.trim(),
        category,
        sourceUrl: sourceUrl.trim(),
        contentBase64,
      };
      if (contentType.trim()) body.contentType = contentType.trim();
      if (fileName.trim()) body.fileName = fileName.trim();
      const res = await apiFetch("/api/knowledge/corpus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      setUploadResult(data as UploadResult);
      setUploadStatus(res.status);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploadLoading(false);
    }
  }

  return (
    <div>
      <p>
        Corpus admin — integrity, sync, and upload for the knowledge corpus. The expected-documents list below is the seed
        manifest with per-entry status; it is not a stored-documents catalog (the corpus has no listing API, by design).
      </p>

      <h3>Integrity</h3>
      <Button type="button" onClick={() => void loadReport()} disabled={reportLoading} loading={reportLoading}>
        {"Refresh"}
      </Button>{" "}
      <Button
        type="button"
        onClick={() => downloadTextFile("corpus-integrity.json", buildJson(report), "application/json")}
        disabled={!report}
        title="Download integrity report as JSON"
      >
        Download report (JSON)
      </Button>
      {reportError && <p role="alert">{reportError}</p>}
      {report && (
        <div>
          <p>
            Integrity: {report.ok ? "ok" : "has findings"} · checked at {report.checkedAt}
          </p>
          {report.reason && <p>Check could not run: {report.reason}</p>}
          <p>Missing ({report.missing.length}): {report.missing.length > 0 ? report.missing.join(", ") : "none"}</p>
          <p>Mismatched ({report.mismatched.length}): {report.mismatched.length > 0 ? report.mismatched.join(", ") : "none"}</p>
          <p>Extra ({report.extra.length}): {report.extra.length > 0 ? report.extra.join(", ") : "none"}</p>
          <h4>Expected documents</h4>
          {report.entries && report.entries.length > 0 ? (
            report.entries.map((entry, i) => (
              <p key={i}>
                <strong>{entry.title}</strong> · {entry.category} · {entryStatusLabel(entry.status)}
                {entry.bucketKey ? ` · ${entry.bucketKey}` : ""}
              </p>
            ))
          ) : (
            <p>No per-entry status available for this report.</p>
          )}
        </div>
      )}

      <h3>Sync</h3>
      <p>The sync also runs weekly on the existing every-30-minutes tick; this button only triggers a run now.</p>
      <Button type="button" onClick={() => void runSync()} disabled={syncLoading} loading={syncLoading}>
        {"Run sync now"}
      </Button>
      {syncError && <p role="alert">{syncError}</p>}
      {syncResult && (
        <div>
          {syncResult.skipped ? (
            <p>
              Skipped: {syncResult.reason}
              {syncResult.lastFiredAt ? ` · last fired at ${syncResult.lastFiredAt}` : ""}
            </p>
          ) : (
            <p>
              Sync completed: integrity {syncResult.integrity?.ok ? "ok" : "has findings"}
              {syncResult.backfill
                ? ` · backfill ${syncResult.backfill.upserted} upserted, ${syncResult.backfill.skippedRetention} skipped (retention), ${syncResult.backfill.rows} rows in ${syncResult.backfill.pages} page(s)`
                : ""}
            </p>
          )}
        </div>
      )}

      <h3>Upload</h3>
      <form onSubmit={(e) => void runUpload(e)}>
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title (required)" />
        <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <TextInput label="Source URL" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://… (required)" />
        <TextInput label="Content type (optional)" value={contentType} onChange={(e) => setContentType(e.target.value)} placeholder="e.g. application/pdf" />
        <TextInput label="File name (optional)" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="Defaults to category + hash prefix" />
        <FileInput id="corpus-file" label="File (required)" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <p>Selected: {file.name}</p>}
        <Button type="submit" variant="primary" disabled={uploadLoading || !title.trim() || !sourceUrl.trim() || !file} loading={uploadLoading}>
          {"Upload"}
        </Button>
      </form>
      {uploadError && <p role="alert">{uploadError}</p>}
      {uploadResult && (
        <div>
          <p>
            {uploadStatus === 201 ? "Fresh ingest" : uploadStatus === 200 ? "Replay — identical bytes already stored" : "Upload result"}
            {uploadResult.idempotent !== undefined ? ` · idempotent: ${uploadResult.idempotent ? "yes" : "no"}` : ""}
          </p>
          <p>
            {uploadResult.title} · {uploadResult.category}
          </p>
          {uploadResult.r2Key && <p>Key: {uploadResult.r2Key}</p>}
          {uploadResult.contentHash && <p>Content hash: {uploadResult.contentHash}</p>}
          {uploadResult.fileName && <p>File name: {uploadResult.fileName}</p>}
          {uploadResult.contentType && <p>Content type: {uploadResult.contentType}</p>}
          {uploadResult.ingestedAt && <p>Ingested at: {uploadResult.ingestedAt}</p>}
          {uploadResult.sourceUrl && <p>Source: {uploadResult.sourceUrl}</p>}
        </div>
      )}
    </div>
  );
}
