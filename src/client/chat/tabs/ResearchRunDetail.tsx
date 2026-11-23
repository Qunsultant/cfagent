import React from "react";
import { Badge, Button, Card, CardHeader, SmallHeader, Notice, Spinner, Table } from "../../components/ui";
import { apiFetch } from "../../apiFetch";

/**
 * Issue #339: Reports-tab research views. Read-only rendering of the
 * stored canonical report body — ranked table, detailed trade cards
 * (the §4 falsification answers + §7 pre-mortem per idea), and the
 * effective filter/config snapshot the run executed with. No
 * recomputation: everything below renders what the stored copy carries.
 * Bodies that are delivery artifacts (webhook sheets / email attachment)
 * get their own faithful renderings.
 */

export interface RunIdeaView {
  rank: number;
  symbol: string;
  outlook: string;
  structure: string;
  score: number | null;
  thesis: string;
  legs: string[];
  economics: Array<[string, string]>;
  supporting: string[];
  contradicting: string[];
  falsification: Array<{ label: string; value: string }>;
  warnings: string[];
  premortem: { assumedFailure: string; causes: string[] } | null;
  entryCondition: string;
  invalidation: string;
}

export type ResearchRunDetailModel =
  | {
      kind: "run";
      summary: string;
      rulesVersion: string;
      trigger: string;
      stats: Array<[string, string]>;
      ideas: RunIdeaView[];
      watchlist: Array<{ symbol: string; outlook: string; reason: string; triggerCondition: string }>;
      rejected: Array<{ symbol: string; outlook: string; structure: string; gate: string; reason: string }>;
      configEntries: Array<[string, string]>;
    }
  | {
      kind: "sheets";
      title: string;
      query: string;
      sheets: Array<{ name: string; columns: string[]; rows: string[][] }>;
    }
  | { kind: "artifact"; title: string };

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];
}

function labelize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fmtValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function fmtMoney(v: unknown): string {
  const n = num(v);
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

const FALSIFICATION_LABELS: Array<[string, string]> = [
  ["thesis", "Thesis"],
  ["whyMarketWrong", "Why the market may be wrong"],
  ["resolutionTrigger", "Resolution trigger"],
  ["horizon", "Horizon"],
  ["contradictingEvidence", "Contradicting evidence"],
  ["invalidation", "Invalidation"],
  ["whyThisStructure", "Why this structure"],
];

function parseIdea(raw: any, idx: number): RunIdeaView {
  const f = isObj(raw?.falsification) ? raw.falsification : {};
  const falsification = FALSIFICATION_LABELS.map(([key, label]) => ({
    label,
    value: Array.isArray(f[key]) ? strList(f[key]).join("; ") : str(f[key]),
  })).filter((row) => row.value);
  const econ = isObj(raw?.economics) ? raw.economics : {};
  const economics: Array<[string, string]> = [];
  if (num(econ.netDebit)) economics.push(["Net debit", fmtMoney(econ.netDebit)]);
  if (num(econ.netCredit)) economics.push(["Net credit", fmtMoney(econ.netCredit)]);
  if (num(econ.maxLoss) != null) economics.push(["Max loss", fmtMoney(econ.maxLoss)]);
  economics.push(["Max gain", econ.maxGain == null ? "Unbounded" : fmtMoney(econ.maxGain)]);
  if (Array.isArray(econ.breakevens) && econ.breakevens.length > 0) {
    economics.push(["Breakevens", econ.breakevens.map((b: unknown) => fmtMoney(b)).join(", ")]);
  }
  const pm = isObj(raw?.premortem) ? raw.premortem : null;
  return {
    rank: num(raw?.rank) ?? idx + 1,
    symbol: str(raw?.symbol),
    outlook: str(raw?.outlook),
    structure: str(raw?.structure),
    score: num(raw?.score),
    thesis: str(raw?.thesis),
    legs: Array.isArray(raw?.legs)
      ? raw.legs.map(
          (leg: any) =>
            `${str(leg?.optionType)} ${num(leg?.strike) ?? "?"} · exp ${str(leg?.expiry)} (${num(leg?.dte) ?? "?"} DTE) · ${num(leg?.bid) ?? "?"}/${num(leg?.ask) ?? "?"}`
        )
      : [],
    economics,
    supporting: strList(raw?.supportingEvidence),
    contradicting: strList(raw?.contradictingEvidence),
    falsification,
    warnings: strList(raw?.falsificationWarnings),
    premortem: pm
      ? {
          assumedFailure: str(pm.assumedFailure),
          causes: Array.isArray(pm.causes)
            ? pm.causes.map((c: any) => `${labelize(str(c?.category))}: ${str(c?.detail)}`)
            : [],
        }
      : null,
    entryCondition: str(raw?.entryCondition),
    invalidation: str(raw?.invalidation),
  };
}

/** Pure: stored body (already JSON-parsed) → detail view model. */
export function parseResearchRunDetail(body: unknown): ResearchRunDetailModel | null {
  if (!isObj(body)) return null;
  if (Array.isArray(body.ideas)) {
    const ideas = (body.ideas as any[]).map(parseIdea).sort((a, b) => a.rank - b.rank);
    const stats = isObj(body.stats)
      ? Object.entries(body.stats)
          .filter(([, v]) => typeof v === "number" || typeof v === "string")
          .map(([k, v]) => [labelize(k), fmtValue(v)] as [string, string])
      : [];
    const configEntries = isObj(body.configSnapshot)
      ? Object.entries(body.configSnapshot).map(
          ([k, v]) => [labelize(k), fmtValue(v)] as [string, string]
        )
      : [];
    return {
      kind: "run",
      summary: str(body.summary),
      rulesVersion: str(body.rulesVersion),
      trigger: str(body.trigger),
      stats,
      ideas,
      watchlist: Array.isArray(body.watchlist)
        ? (body.watchlist as any[]).map((w) => ({
            symbol: str(w?.symbol),
            outlook: str(w?.outlook),
            reason: str(w?.reason),
            triggerCondition: str(w?.triggerCondition),
          }))
        : [],
      rejected: Array.isArray(body.rejected)
        ? (body.rejected as any[]).map((r) => ({
            symbol: str(r?.symbol),
            outlook: str(r?.outlook),
            structure: str(r?.structure),
            gate: str(r?.gate),
            reason: str(r?.reason),
          }))
        : [],
      configEntries,
    };
  }
  if (Array.isArray(body.sheets) && body.sheets.length > 0) {
    return {
      kind: "sheets",
      title: str(body.title),
      query: str(body.query),
      sheets: (body.sheets as any[]).map((sheet) => {
        const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
        const columns = rows.length > 0 && isObj(rows[0]) ? Object.keys(rows[0]) : [];
        return {
          name: str(sheet?.name),
          columns,
          rows: rows.map((row: any) => columns.map((c) => fmtValue(row?.[c]))),
        };
      }),
    };
  }
  if (typeof body.attachmentBase64 === "string" || typeof body.fileName === "string") {
    return { kind: "artifact", title: str(body.title) };
  }
  return null;
}

function DefinitionList({ entries }: { entries: Array<[string, string]> }) {
  return (
    <dl className="research-detail-dl">
      {entries.map(([k, v]) => (
        <div key={k} className="research-detail-dl-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function TradeCardView({ idea }: { idea: RunIdeaView }) {
  return (
    <Card className="research-trade-card">
      <div className="research-trade-head">
        <strong>
          #{idea.rank} {idea.symbol}
        </strong>
        {idea.outlook ? <Badge tone="info">{idea.outlook}</Badge> : null}
        {idea.score != null ? <Badge tone="neutral">score {idea.score}</Badge> : null}
        <span className="research-trade-structure">{idea.structure}</span>
      </div>
      {idea.thesis ? <p className="research-trade-thesis">{idea.thesis}</p> : null}
      {idea.legs.length > 0 && (
        <ul className="research-detail-list">
          {idea.legs.map((leg, i) => (
            <li key={i}>{leg}</li>
          ))}
        </ul>
      )}
      {idea.economics.length > 0 && <DefinitionList entries={idea.economics} />}
      {idea.supporting.length > 0 && (
        <>
          <SmallHeader title="Supporting evidence" />
          <ul className="research-detail-list">
            {idea.supporting.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}
      {idea.contradicting.length > 0 && (
        <>
          <SmallHeader title="Contradicting evidence" />
          <ul className="research-detail-list">
            {idea.contradicting.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}
      {idea.falsification.length > 0 && (
        <>
          <SmallHeader title="Falsification (§4)" />
          <dl className="research-detail-dl">
            {idea.falsification.map((row) => (
              <div key={row.label} className="research-detail-dl-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {idea.warnings.length > 0 && (
        <Notice tone="warning" title="Falsification warnings">
          {idea.warnings.join(" ")}
        </Notice>
      )}
      {idea.premortem && (
        <>
          <SmallHeader title="Pre-mortem (§7)" />
          <p>{idea.premortem.assumedFailure}</p>
          {idea.premortem.causes.length > 0 && (
            <ul className="research-detail-list">
              {idea.premortem.causes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {(idea.entryCondition || idea.invalidation) && (
        <DefinitionList
          entries={[
            ...(idea.entryCondition ? [["Entry condition", idea.entryCondition] as [string, string]] : []),
            ...(idea.invalidation ? [["Invalidation", idea.invalidation] as [string, string]] : []),
          ]}
        />
      )}
    </Card>
  );
}

export function ResearchRunDetailView(props: {
  title: string;
  createdAt?: string;
  reportUrl?: string;
  body: unknown;
  onBack: () => void;
}) {
  const model = parseResearchRunDetail(props.body);
  return (
    <div className="research-detail">
      <div className="research-detail-topbar">
        <Button variant="secondary" size="sm" onClick={props.onBack}>
          ← All reports
        </Button>
        {props.reportUrl ? (
          <a className="report-pdf-link" href={props.reportUrl} target="_blank" rel="noreferrer">
            📄 Download PDF
          </a>
        ) : null}
      </div>
      <CardHeader title={props.title} />
      {props.createdAt ? (
        <div className="research-detail-meta">{new Date(props.createdAt).toLocaleString()}</div>
      ) : null}
      {model == null && (
        <Notice tone="warning" title="Unrecognized report body">
          This stored report's body could not be interpreted as a research run, sheet report, or
          delivery artifact, so there is nothing structured to render.
        </Notice>
      )}
      {model?.kind === "artifact" && (
        <Notice tone="info" title="Delivery artifact">
          This stored copy is a delivered research report (PDF attachment). Use the PDF download
          above to read it; run-detail views apply to research runs stored by the pipeline.
        </Notice>
      )}
      {model?.kind === "sheets" && (
        <div>
          {model.query ? <p className="research-detail-summary">Query: {model.query}</p> : null}
          {model.sheets.map((sheet) => (
            <div key={sheet.name} className="research-sheet">
              <CardHeader title={sheet.name} />
              <Table
                columns={sheet.columns.map((c) => ({
                  key: c,
                  header: c,
                  render: (row: string[]) => row[sheet.columns.indexOf(c)],
                }))}
                rows={sheet.rows}
                rowKey={(row) => `${sheet.name}:${row.join("")}`}
                empty={<Notice tone="info">This sheet has no rows.</Notice>}
              />
            </div>
          ))}
        </div>
      )}
      {model?.kind === "run" && (
        <div>
          {model.summary ? <p className="research-detail-summary">{model.summary}</p> : null}
          <div className="research-detail-meta">
            {model.rulesVersion ? <Badge tone="neutral">{model.rulesVersion}</Badge> : null}
            {model.trigger ? <Badge tone="neutral">{model.trigger}</Badge> : null}
            {model.stats.map(([k, v]) => (
              <Badge key={k} tone="neutral">
                {k}: {v}
              </Badge>
            ))}
          </div>
          <CardHeader title="Ranked ideas" />
          <Table
            columns={[
              { key: "rank", header: "#", render: (i: RunIdeaView) => i.rank, align: "right" },
              { key: "symbol", header: "Symbol", render: (i: RunIdeaView) => i.symbol },
              { key: "outlook", header: "Outlook", render: (i: RunIdeaView) => i.outlook || "—" },
              { key: "structure", header: "Structure", render: (i: RunIdeaView) => i.structure || "—" },
              { key: "score", header: "Score", render: (i: RunIdeaView) => (i.score == null ? "—" : i.score), align: "right" },
            ]}
            rows={model.ideas}
            rowKey={(i) => `${i.rank}-${i.symbol}`}
            empty={<Notice tone="info">This run qualified no ideas.</Notice>}
          />
          {model.ideas.map((idea) => (
            <TradeCardView key={`${idea.rank}-${idea.symbol}`} idea={idea} />
          ))}
          {model.configEntries.length > 0 && (
            <>
              <CardHeader title="Filter / config snapshot" />
              <DefinitionList entries={model.configEntries} />
            </>
          )}
          {model.watchlist.length > 0 && (
            <>
              <CardHeader title="Watchlist" />
              <ul className="research-detail-list">
                {model.watchlist.map((w, i) => (
                  <li key={i}>
                    <strong>{w.symbol}</strong> ({w.outlook}) — {w.reason}
                    {w.triggerCondition ? ` · trigger: ${w.triggerCondition}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          {model.rejected.length > 0 && (
            <>
              <CardHeader title="Rejected" />
              <ul className="research-detail-list">
                {model.rejected.map((r, i) => (
                  <li key={i}>
                    <strong>{r.symbol}</strong> ({r.outlook}, {r.structure}) — gate {r.gate}:{" "}
                    {r.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Fetching wrapper used by the Reports panel. */
export function ResearchRunDetail(props: { reportId: string; onBack: () => void }) {
  const [state, setState] = React.useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "loaded"; data: any }
  >({ phase: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/reports/${encodeURIComponent(props.reportId)}`);
        if (!res.ok) throw new Error(`Failed to load report (${res.status})`);
        const data = await res.json();
        if (!cancelled) setState({ phase: "loaded", data });
      } catch (err) {
        if (!cancelled) {
          setState({
            phase: "error",
            message: err instanceof Error ? err.message : "Failed to load report",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.reportId]);

  if (state.phase === "loading") {
    return (
      <div className="research-detail">
        <Button variant="secondary" size="sm" onClick={props.onBack}>
          ← All reports
        </Button>
        <div className="research-detail-loading">
          <Spinner /> Loading report…
        </div>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="research-detail">
        <Button variant="secondary" size="sm" onClick={props.onBack}>
          ← All reports
        </Button>
        <Notice tone="danger" title="Could not load this report">
          {state.message}
        </Notice>
      </div>
    );
  }
  return (
    <ResearchRunDetailView
      title={state.data.title || "Report"}
      createdAt={state.data.createdAt}
      reportUrl={state.data.reportUrl || undefined}
      body={state.data.body}
      onBack={props.onBack}
    />
  );
}
