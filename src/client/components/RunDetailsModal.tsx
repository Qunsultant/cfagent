/**
 * Run Details modal (issue #2534): one modal for every run family.
 * It renders only what the GET /api/runs/details payload records;
 * a field no store recorded renders as "unknown" with its store
 * named, never guessed. Built only from components/ui primitives
 * with token-only styling (repo AGENTS.md §20).
 */
import { useState } from "react";
import { Badge, Button, CardHeader, Modal, SegmentedControl, Table } from "../components/ui";
import { formatRunDetailTimestamp, runDetailVisibleSections, type RunDetail, type RunDetailLevelFilter } from "../runDetails";
import { maskAccountId } from "../../config/accountBindings";

function Unknown({ store }: { store: string }) {
  return (
    <span title={`Not recorded in ${store}`}>
      unknown <span>({store})</span>
    </span>
  );
}

function FieldValue({ value, store }: { value: string | null; store: string }) {
  return value ? <span>{value}</span> : <Unknown store={store} />;
}

/**
 * Issue #2786 losslessness fix: the five RunDetail sections (request,
 * provenance, lineage, stages, reasons), shared by the Docs Run Details
 * modal below and by the Workflow Runs detail — one renderer for the
 * one /api/runs/details payload, never a divergent second copy. The
 * filter control stays in RunDetailsModal: it is view chrome, not
 * content, and the Workflow Runs detail always renders all sections.
 */
export function RunDetailSections({
  detail,
  levelFilter,
}: {
  detail: RunDetail;
  levelFilter: RunDetailLevelFilter;
}) {
  const sections = runDetailVisibleSections(levelFilter);
  const show = (s: "request" | "provenance" | "lineage" | "stages" | "reasons") => sections.includes(s);

  return (
    <>
          {show("request") && (
            <section aria-label="Request">
              <CardHeader title="Request" />
              <Table
                caption="Exact input as submitted, where recorded"
                columns={[
                  { key: "field", header: "Field", render: (r) => r.field },
                  { key: "value", header: "Value", render: (r) => <FieldValue value={r.value} store={detail.store} /> },
                  { key: "source", header: "Source", render: (r) => r.source },
                ]}
                rows={detail.request}
                rowKey={(r) => r.field}
              />
              <CardHeader title="Defaults applied" />
              {detail.defaultsApplied.length === 0 ? (
                <p>No defaults recorded for this run — defaults are unknown, not guessed.</p>
              ) : (
                <Table
                  caption="Defaults applied to this run"
                  columns={[
                    { key: "field", header: "Field", render: (r) => r.field },
                    { key: "value", header: "Value", render: (r) => <FieldValue value={r.value} store={detail.store} /> },
                  ]}
                  rows={detail.defaultsApplied}
                  rowKey={(r) => r.field}
                />
              )}
            </section>
          )}

          {show("provenance") && (
            <section aria-label="Provenance">
              <CardHeader title="Provenance" />
              <Table
                caption="Provenance tuple for this run"
                columns={[
                  { key: "field", header: "Field", render: (r) => r.field },
                  { key: "value", header: "Value", render: (r) => <FieldValue value={r.value} store={detail.store} /> },
                ]}
                rows={Object.entries(detail.provenance).map(([field, value]) => ({
                  field,
                  // Issue #5102 (F5 of #5094): the provenance tuple
                  // carries the run's recorded binding — the account id
                  // renders masked, never full. The stored record keeps
                  // the full id; only this display masks it. (The audit
                  // vault's raw-payload view is the one pre-existing
                  // explicit full-payload surface, kept per §5; this
                  // curated provenance table is not it.)
                  value:
                    value === null || value === undefined
                      ? null
                      : field === "accountId"
                        ? maskAccountId(String(value))
                        : String(value),
                }))}
                rowKey={(r) => r.field}
              />
            </section>
          )}

          {show("lineage") && (
            <section aria-label="Lineage">
              <CardHeader title="Lineage" />
              <p>
                Input hash: <FieldValue value={detail.lineage.inputHash} store={detail.store} /> · Engine:{" "}
                <FieldValue value={detail.lineage.engineVersion} store={detail.store} /> · Captures:{" "}
                {detail.lineage.captureIds.length ? detail.lineage.captureIds.join(", ") : <Unknown store={detail.store} />}
              </p>
              <p>
                Storage: <span>{detail.lineage.storageMode ?? "unknown"}</span>
                {detail.lineage.bodyR2Key ? <> (<code>{detail.lineage.bodyR2Key}</code>)</> : null}
                {" · "}Origin:{" "}
                <FieldValue value={detail.lineage.origin?.trigger ?? null} store={detail.store} /> /{" "}
                <FieldValue value={detail.lineage.origin?.channel ?? null} store={detail.store} />
                {(detail.lineage.incompleteFields?.length ?? 0) > 0 && (
                  <> · Incomplete: <span>{detail.lineage.incompleteFields.join(", ")}</span></>
                )}
              </p>
              {(detail.lineage.artifactLinks?.length ?? 0) > 0 && (
                <p>
                  Artifacts:{" "}
                  {detail.lineage.artifactLinks.map((a) => `${a.format}:${a.key ?? a.url ?? "linked"}`).join(" · ")}
                </p>
              )}
              <Table
                caption="Per-capture lineage"
                columns={[
                  { key: "field", header: "Field", render: (r) => r.field },
                  { key: "value", header: "Value", render: (r) => <FieldValue value={r.value} store={detail.store} /> },
                ]}
                rows={detail.lineage.captures}
                rowKey={(r) => r.field}
              />
            </section>
          )}

          {show("stages") && (
            <section aria-label="Stage trace">
              <CardHeader title="Stage trace" />
              <Table
                caption="Stage-by-stage trace for this run"
                columns={[
                  { key: "stage", header: "Stage", render: (r) => r.stage },
                  { key: "status", header: "Status", render: (r) => <Badge size="sm" tone={r.status === "failed" ? "danger" : r.status === "completed" ? "success" : "neutral"}>{r.status}</Badge> },
                  { key: "outputs", header: "Outputs", render: (r) => (r.outputIds.length ? r.outputIds.join(", ") : "—") },
                  { key: "error", header: "Error", render: (r) => (r.error ? `${r.errorCode ?? ""} ${r.error}` : "—") },
                ]}
                rows={detail.stages}
                rowKey={(r) => r.stage}
              />
            </section>
          )}

          {show("reasons") && (
            <section aria-label="Why this report has no data">
              <CardHeader title="Why this report has no data" />
              {detail.reasons.length === 0 ? (
                <p>No missing-data reason recorded for this run — its formats are present or were never attempted by construction (see the stage trace).</p>
              ) : (
                <ul>
                  {detail.reasons.map((reason, i) => (
                    <li key={`${reason.code}-${i}`}>
                      <strong>{reason.code}</strong> ({reason.level}): {reason.text} Action: {reason.action}
                      {reason.format ? ` Format: ${reason.format}.` : ""}
                      {reason.stage ? ` Stage: ${reason.stage}.` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <CardHeader title="Formats" />
              <Table
                caption="Per-format status for this run"
                columns={[
                  { key: "format", header: "Format", render: (r) => r.format },
                  { key: "status", header: "Status", render: (r) => r.status ?? "unknown" },
                  { key: "url", header: "Link", render: (r) => (r.url ? <a href={r.url} download>{r.format}</a> : "—") },
                ]}
                rows={detail.formats}
                rowKey={(r) => r.format}
              />
            </section>
          )}
    </>
  );
}

export function RunDetailsModal({
  open,
  onClose,
  detail,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  detail: RunDetail | null;
  loading: boolean;
  error: string | null;
}) {
  const [filter, setFilter] = useState<RunDetailLevelFilter>("all");

  return (
    <Modal open={open} onClose={onClose} size="lg" title={detail ? `Run Details — ${detail.title}` : "Run Details"}>
      {loading && <p>Loading run details…</p>}
      {error && !loading && <p role="alert">{error}</p>}
      {detail && !loading && !error && (
        <div>
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as RunDetailLevelFilter)}
            options={[
              { id: "all", label: "All levels" },
              { id: "info", label: "Info" },
              { id: "debugging", label: "Debugging" },
              { id: "error", label: "Error" },
            ]}
            ariaLabel="Filter run details by level"
          />
          <p>
            Run <code>{detail.runId}</code> · {detail.kind} / {detail.source} ·{" "}
            <time dateTime={detail.createdAt}>{formatRunDetailTimestamp(detail.createdAt)}</time>
            {detail.status ? (
              <span>
                {" "}
                <Badge size="sm" tone={detail.status === "failed" ? "danger" : "neutral"}>{detail.status}</Badge>
              </span>
            ) : null}
          </p>

          <RunDetailSections detail={detail} levelFilter={filter} />
          <p>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </p>
        </div>
      )}
    </Modal>
  );
}
