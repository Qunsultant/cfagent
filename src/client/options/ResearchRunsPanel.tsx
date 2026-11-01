/**
 * Issue #319 — ResearchRunsPanel: the ONE research-run surface (amendment 2).
 *
 * One set of components for both run types:
 * - filter editor bound to the typed config API (GET/POST /api/research/settings)
 * - run controls (manual "Run now"; §9 evaluation of a published run)
 * - run-detail / trade-card view (ranked table, scenarios, falsification,
 *   pre-mortem, watchlist, rejected-with-reasons)
 * Scheduled runs surface in the SAME views, labeled by trigger source
 * (manual | scheduled). No separate scheduled-run UI. Fleet-wide report
 * browsing belongs to the Reports tab (#318).
 *
 * READ-ONLY: no order path exists from this panel. Research only.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Button, Checkbox, Table, TextInput, type TableColumn } from "../components/ui";

interface ResearchRunsPanelProps {
  userLogin?: string;
  onSendPrompt?: (prompt: string) => void;
}

type TriggerSource = "manual" | "scheduled";

interface ScenarioView {
  label: string;
  underlying: number;
  pnlPerUnit: number;
  pnlTotal: number;
}

interface TradeCardView {
  rank: number;
  symbol: string;
  outlook: string;
  thesis: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  falsification: {
    whyMarketWrong: string;
    resolutionTrigger: string;
    horizon: string;
    contradictingEvidence: string[];
    invalidation: string;
    whyThisStructure: string;
  };
  falsificationWarnings: string[];
  premortem: { assumedFailure: string; causes: { category: string; description: string }[] };
  structure: string;
  legs: { optionType: string; strike: number; expiry: string; dte: number; bid: number; ask: number; quantity: number }[];
  economics: { netDebit: number; netCredit: number; maxLoss: number; maxGain: number | null; breakevens: number[] };
  pmcc?: { maxProfit: number; maxLoss: number; netDebit: number; maxProfitSpot: number } | null;
  scenarios: ScenarioView[];
  entryCondition: string;
  invalidation: string;
  contractualMaxLoss: number;
  feesNote: string;
  limitations: string[];
  sources: string[];
  score: number;
}

interface ReportView {
  runId: string;
  trigger: TriggerSource;
  createdAt: string;
  rulesVersion: string;
  summary: string;
  ideas: TradeCardView[];
  watchlist: { symbol: string; outlook: string; thesis: string; structure: string; reason: string; triggerCondition: string }[];
  rejected: { symbol: string; outlook: string; structure: string; gate: string; reason: string }[];
  stats: { qualified: number; watchlist: number; rejected: number; unverified: number; durationMs: number };
  configSnapshot: Record<string, unknown>;
}

interface RunSummaryView {
  runId: string;
  trigger: TriggerSource;
  createdAt: string;
  ideas: number;
  watchlist: number;
  rejected: number;
  summary: string;
}

const CONFIG_FIELDS: { key: string; label: string; type: "number" | "boolean" | "string"; hint: string }[] = [
  { key: "marketCapMin", label: "Min market cap ($)", type: "number", hint: "Spec default $5B for companies." },
  { key: "maxIdeas", label: "Max qualified ideas", type: "number", hint: "Spec: up to five." },
  { key: "universe", label: "Universe", type: "string", hint: "Screening universe id." },
  { key: "quoteFreshnessSeconds", label: "Quote freshness (s)", type: "number", hint: "Option quote max age (quote-quality gate)." },
  { key: "maxSpreadPct", label: "Max spread (fraction of mid)", type: "number", hint: "Quote-quality gate threshold." },
  { key: "minOptionVolume", label: "Min option volume", type: "number", hint: "Activity threshold." },
  { key: "minOpenInterest", label: "Min open interest", type: "number", hint: "Activity threshold." },
  { key: "minDte", label: "Min DTE", type: "number", hint: "Minimum days to expiry per leg." },
  { key: "ownershipStrategiesAllowed", label: "Allow cash-secured puts / covered calls", type: "boolean", hint: "Spec default OFF — needs explicit permission." },
  { key: "pmccEnabled", label: "Enable PMCC analysis", type: "boolean", hint: "Spec: optional PMCC analysis." },
  { key: "autoEmail", label: "Email report after run", type: "boolean", hint: "Off by default." },
  { key: "emailTo", label: "Report email recipient", type: "string", hint: "Empty = no email." },
];

function hdrs(userLogin?: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(userLogin ? { "x-user-login": userLogin } : {}),
  };
}

function TriggerChip({ trigger }: { trigger: TriggerSource }) {
  const style =
    trigger === "scheduled"
      ? { background: "var(--color-info-subtle)", color: "var(--color-info-text)" }
      : { background: "var(--color-warning-subtle)", color: "var(--color-warning-text)" };
  return (
    <span style={{ ...style, borderRadius: 4, padding: "var(--space-0-5) var(--space-2)", fontSize: 12, fontWeight: 600 }}>
      {trigger}
    </span>
  );
}

function TradeCardDetail({ card }: { card: TradeCardView }) {
  const [open, setOpen] = useState(false);
  const econ = card.economics;
  const debitCredit =
    econ.netDebit > 0 ? `debit $${econ.netDebit.toFixed(2)}` : `credit $${econ.netCredit.toFixed(2)}`;
  type LegRow = TradeCardView["legs"][number] & { _idx: number };
  type ScenarioRow = ScenarioView & { _idx: number };
  const legColumns: TableColumn<LegRow>[] = [
    { key: "side", header: "Side",
      render: (l) => (l.quantity > 0 ? `Long ${Math.abs(l.quantity)}` : `Short ${Math.abs(l.quantity)}`) },
    { key: "type", header: "Type", render: (l) => l.optionType },
    { key: "strike", header: "Strike", render: (l) => l.strike },
    { key: "expiry", header: "Expiry", render: (l) => `${l.expiry} (${l.dte}d)` },
    { key: "bidask", header: "Bid / Ask", render: (l) => `${l.bid.toFixed(2)} / ${l.ask.toFixed(2)}` },
  ];
  const scenarioColumns: TableColumn<ScenarioRow>[] = [
    { key: "scenario", header: "Scenario", render: (s) => s.label },
    { key: "underlying", header: "Underlying", render: (s) => s.underlying.toFixed(2) },
    { key: "pnlunit", header: "P&L / unit",
      render: (s) => (
        <span style={{ color: s.pnlPerUnit >= 0 ? "var(--color-success-text)" : "var(--color-danger-text)" }}>
          {s.pnlPerUnit.toFixed(2)}
        </span>
      ) },
    { key: "pnltotal", header: "P&L total",
      render: (s) => (
        <span style={{ color: s.pnlTotal >= 0 ? "var(--color-success-text)" : "var(--color-danger-text)" }}>
          {s.pnlTotal.toFixed(2)}
        </span>
      ) },
  ];
  return (
    <div style={{ border: "1px solid var(--color-border-medium)", borderRadius: 8, margin: "8px 0", padding: "var(--space-3)" }}>
      <div
        style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
        onClick={() => setOpen(!open)}
      >
        <strong>
          #{card.rank} {card.symbol} — {card.structure} ({debitCredit}, max loss ${card.contractualMaxLoss.toFixed(2)})
        </strong>
        <span>{open ? "▾" : "▸"}</span>
      </div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>{card.thesis}</div>
      {open && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <h5>Legs (exact contracts)</h5>
          <Table
            columns={legColumns}
            rows={card.legs.map((l, i) => ({ ...l, _idx: i }))}
            rowKey={(row) => String(row._idx)}
          />
          <h5>Economics (independently recomputed)</h5>
          <div>
            Max gain: {econ.maxGain === null ? "unbounded" : `$${econ.maxGain.toFixed(2)}`} · Breakevens:{" "}
            {econ.breakevens.length > 0 ? econ.breakevens.join(", ") : "—"}
            {card.pmcc && (
              <span>
                {" "}· PMCC max profit (modeled, long-call residual value) ${card.pmcc.maxProfit.toFixed(2)} near{" "}
                ${card.pmcc.maxProfitSpot.toFixed(2)}
              </span>
            )}
          </div>
          <h5>Scenarios</h5>
          <Table
            columns={scenarioColumns}
            rows={card.scenarios.map((s, i) => ({ ...s, _idx: i }))}
            rowKey={(row) => String(row._idx)}
          />
          <div style={{ color: "var(--color-text-muted)", fontSize: 12 }}>{card.feesNote}</div>
          <h5>Falsification (§4)</h5>
          <ul>
            <li><b>Why the market may be wrong:</b> {card.falsification.whyMarketWrong}</li>
            <li><b>Resolution:</b> {card.falsification.resolutionTrigger} ({card.falsification.horizon})</li>
            <li><b>Invalidation:</b> {card.falsification.invalidation}</li>
            <li><b>Why this structure:</b> {card.falsification.whyThisStructure}</li>
            {card.falsification.contradictingEvidence.map((e, i) => (
              <li key={i}><b>Counter-evidence:</b> {e}</li>
            ))}
          </ul>
          {card.falsificationWarnings.map((w, i) => (
            <div key={i} style={{ color: "var(--color-warning-text)", fontSize: 12 }}>⚠ {w}</div>
          ))}
          <h5>Pre-mortem (§7)</h5>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>{card.premortem.assumedFailure}</div>
          <ul>
            {card.premortem.causes.map((c, i) => (
              <li key={i}><b>{c.category}:</b> {c.description}</li>
            ))}
          </ul>
          <h5>Entry & limitations</h5>
          <div>{card.entryCondition}</div>
          <ul>
            {card.limitations.map((l, i) => (
              <li key={i} style={{ color: "var(--color-text-muted)" }}>{l}</li>
            ))}
          </ul>
          <div style={{ color: "var(--color-text-dim)", fontSize: "var(--font-size-micro)" }}>Sources: {card.sources.join(", ")}</div>
        </div>
      )}
    </div>
  );
}

export function ResearchRunsPanel({ userLogin, onSendPrompt }: ResearchRunsPanelProps) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [report, setReport] = useState<ReportView | null>(null);
  const [history, setHistory] = useState<RunSummaryView[]>([]);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/research/settings", { headers: hdrs(userLogin) });
      if (!res.ok) return;
      const data = (await res.json()) as { config?: Record<string, unknown> };
      if (data.config) {
        setConfig(data.config);
        const d: Record<string, string> = {};
        for (const [k, v] of Object.entries(data.config)) {
          d[k] = v === null || v === undefined ? "" : String(v);
        }
        setDraft(d);
      }
    } catch {
      /* panel falls back to server defaults */
    }
  }, [userLogin]);

  const loadLatest = useCallback(async () => {
    try {
      const res = await fetch("/api/research/latest", { headers: hdrs(userLogin) });
      if (!res.ok) return;
      const data = (await res.json()) as { latest?: ReportView | null };
      if (data.latest) setReport(data.latest);
    } catch {
      /* empty */
    }
  }, [userLogin]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/research/history", { headers: hdrs(userLogin) });
      if (!res.ok) return;
      const data = (await res.json()) as { history?: RunSummaryView[] };
      if (Array.isArray(data.history)) setHistory(data.history);
    } catch {
      /* empty */
    }
  }, [userLogin]);

  useEffect(() => {
    void loadConfig();
    void loadLatest();
    void loadHistory();
  }, [loadConfig, loadLatest, loadHistory]);

  const save = async () => {
    setSaving(true);
    setSaveMsg("");
    try {
      const patch: Record<string, unknown> = {};
      for (const f of CONFIG_FIELDS) {
        const raw = (draft[f.key] ?? "").trim();
        if (f.type === "boolean") patch[f.key] = raw === "1" || raw.toLowerCase() === "true";
        else if (f.type === "number") patch[f.key] = raw === "" ? null : Number(raw);
        else patch[f.key] = raw;
      }
      const res = await fetch("/api/research/settings", {
        method: "POST",
        headers: hdrs(userLogin),
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as { config?: Record<string, unknown>; errors?: string[] };
      if (data.errors && data.errors.length > 0) {
        setSaveMsg(`Rejected: ${data.errors.join("; ")}`);
      } else {
        setSaveMsg("Saved — the next run embeds this filter snapshot.");
        if (data.config) setConfig(data.config);
      }
    } catch (err) {
      setSaveMsg(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setRunMsg("Running research…");
    try {
      const res = await fetch("/api/research/run", { method: "POST", headers: hdrs(userLogin) });
      const data = (await res.json()) as { success?: boolean; error?: string; report?: ReportView; reportId?: string };
      if (data.success && data.report) {
        setReport(data.report);
        setRunMsg(`Done — canonical report ${data.reportId ?? ""} stored.`);
        void loadHistory();
      } else {
        setRunMsg(`Failed: ${data.error ?? "unknown error"}`);
      }
    } catch (err) {
      setRunMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const evaluate = async (runId: string) => {
    setRunMsg("Evaluating against later prices…");
    try {
      const res = await fetch("/api/research/evaluate", {
        method: "POST",
        headers: hdrs(userLogin),
        body: JSON.stringify({ runId }),
      });
      const data = (await res.json()) as { evaluation?: { aggregates?: Record<string, unknown> } | null };
      setRunMsg(
        data.evaluation
          ? `Evaluated (rules pinned, original untouched): ${JSON.stringify(data.evaluation.aggregates)}`
          : "No evaluation returned."
      );
    } catch (err) {
      setRunMsg(`Evaluate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div style={{ padding: "var(--space-3)" }}>
      <h3>
        Autonomous Options Research{" "}
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>(read-only — no order entry from this panel)</span>
      </h3>

      <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: 12, flexWrap: "wrap" }}>
        <Button onClick={() => void runNow()} disabled={running} loading={running}>
          {"Run research now"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            void loadConfig();
            void loadLatest();
            void loadHistory();
          }}
        >
          ↻ Refresh
        </Button>
        <Button onClick={() => setShowFilters(!showFilters)}>{showFilters ? "Hide filters" : "Edit filters"}</Button>
        {report && <Button onClick={() => void evaluate(report.runId)}>Evaluate this run (§9)</Button>}
        {onSendPrompt && (
          <Button onClick={() => onSendPrompt("Summarize the latest autonomous options research run")}>
            Ask about results
          </Button>
        )}
      </div>
      {runMsg && <div style={{ fontSize: 13, color: "var(--color-info-text)", marginBottom: 8 }}>{runMsg}</div>}

      {showFilters && config && (
        <div style={{ border: "1px solid var(--color-border-medium)", borderRadius: 8, padding: "var(--space-3)", marginBottom: 12 }}>
          <h4>Filters & thresholds — every run embeds the effective snapshot</h4>
          {CONFIG_FIELDS.map((f) => (
            <div key={f.key} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: 6 }}>
              <span id={`rrf-${f.key}`} style={{ width: 260, fontSize: 13 }}>{f.label}</span>
              {f.type === "boolean" ? (
                <Checkbox
                  aria-labelledby={`rrf-${f.key}`}
                  checked={(draft[f.key] ?? "") === "1" || (draft[f.key] ?? "").toLowerCase() === "true"}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked ? "1" : "0" })}
                />
              ) : (
                <TextInput
                  aria-labelledby={`rrf-${f.key}`}
                  style={{ width: 200 }}
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                />
              )}
              <span style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-dim)" }}>{f.hint}</span>
            </div>
          ))}
          <Button onClick={() => void save()} disabled={saving} loading={saving}>{"Save filters"}</Button>
          {saveMsg && <span style={{ marginLeft: 8, fontSize: 13 }}>{saveMsg}</span>}
        </div>
      )}

      {report ? (
        <div>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: 8 }}>
            <TriggerChip trigger={report.trigger} />
            <span style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
              {new Date(report.createdAt).toLocaleString()} · rules {report.rulesVersion} · {report.stats.durationMs}ms
            </span>
          </div>
          <p>{report.summary}</p>

          <h4>Qualified ideas ({report.ideas.length})</h4>
          {report.ideas.length === 0 && (
            <div style={{ color: "var(--color-text-muted)" }}>
              No qualifying opportunities — no candidate passed the evidence and risk gates. This is a valid outcome.
            </div>
          )}
          {report.ideas.map((c) => (
            <TradeCardDetail key={c.rank} card={c} />
          ))}

          <h4>Watchlist ({report.watchlist.length})</h4>
          {report.watchlist.map((w, i) => (
            <div key={i} style={{ fontSize: 13, borderLeft: "3px solid var(--color-warning)", paddingLeft: "var(--space-2)", marginBottom: 6 }}>
              <b>{w.symbol}</b> ({w.outlook}, {w.structure}) — {w.reason}
              <div style={{ color: "var(--color-text-muted)" }}>Trigger: {w.triggerCondition}</div>
            </div>
          ))}

          <h4>Rejected ({report.rejected.length})</h4>
          {report.rejected.slice(0, 10).map((r, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>
              <b>{r.symbol}</b> [{r.gate}] {r.reason}
            </div>
          ))}
          {report.rejected.length > 10 && (
            <div style={{ fontSize: 12, color: "var(--color-text-dim)" }}>…and {report.rejected.length - 10} more.</div>
          )}

          <h4>Run history — manual + scheduled, one view</h4>
          {history.map((h) => (
            <div key={h.runId} style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4, display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <TriggerChip trigger={h.trigger} />
              <span>{new Date(h.createdAt).toLocaleString()} — {h.summary}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: "var(--color-text-muted)" }}>
          No research run yet. Run one manually, or wait for the scheduled after-close run (21:00 UTC weekdays).
        </div>
      )}
    </div>
  );
}

export default ResearchRunsPanel;
