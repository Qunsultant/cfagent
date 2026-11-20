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
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  DetailCard,
  EmptyState,
  Flex,
  Notice,
  PageSection,
  Stack,
  Table,
  TextInput,
  type TableColumn,
} from "../components/ui";
import { navigateToTab } from "../router";
import { apiFetch, csrfHeaders } from "../apiFetch";
import { ScheduledOptionsRunForm } from "./ScheduledOptionsRunForm";
import { AutonomousOptionsRuns } from "./AutonomousOptionsRuns";
import { ScreeningActivityPanel } from "./ScreeningActivityPanel";

interface ResearchRunsPanelProps {
  activeEnv: "TEST" | "PROD";
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

/**
 * Issue #5625 — parse a response as JSON only when it is JSON.
 *
 * `POST /api/research/run` used to answer a bare-text 401 (`Unauthorized`)
 * from the generic `/api/*` forwarder. `res.json()` on that body throws
 * `Unexpected token 'U', "Unauthorized" is not valid JSON`, and the panel
 * rendered the parser's message as the failure reason. A 401 is now stated
 * as a session problem; any other non-JSON body is stated as `HTTP <n>` plus
 * the first line, so the next mis-typed gate is diagnosable from the UI.
 */
async function readJson<T>(res: Response): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 401) {
    throw new Error("Your session has expired — sign in again, then retry.");
  }
  if (!res.ok) {
    if (contentType.includes("application/json")) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    const text = (await res.text().catch(() => "")).trim().split("\n")[0];
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
  }
  if (!contentType.includes("application/json")) {
    const text = (await res.text().catch(() => "")).trim().split("\n")[0];
    throw new Error(`Expected JSON but got: ${text.slice(0, 160) || "(empty response)"}`);
  }
  return (await res.json()) as T;
}

function hdrs(userLogin?: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(userLogin ? { "x-user-login": userLogin } : {}),
  };
}

function TriggerChip({ trigger }: { trigger: TriggerSource }) {
  return (
    <Badge tone={trigger === "scheduled" ? "info" : "warning"} size="sm">
      {trigger}
    </Badge>
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
        <Badge tone={s.pnlPerUnit >= 0 ? "success" : "danger"} size="xs">
          {s.pnlPerUnit.toFixed(2)}
        </Badge>
      ) },
    { key: "pnltotal", header: "P&L total",
      render: (s) => (
        <Badge tone={s.pnlTotal >= 0 ? "success" : "danger"} size="xs">
          {s.pnlTotal.toFixed(2)}
        </Badge>
      ) },
  ];
  return (
    <Card padding="sm">
      <Stack gap="2">
        <Flex justify="between" align="center">
          <strong>
            #{card.rank} {card.symbol} — {card.structure} ({debitCredit}, max loss ${card.contractualMaxLoss.toFixed(2)})
          </strong>
          <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Hide ▾" : "Details ▸"}
          </Button>
        </Flex>
        <div className="ui-meta">{card.thesis}</div>
        {open && (
          <Stack gap="2">
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
            <div className="ui-meta-sm">{card.feesNote}</div>
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
              <Notice key={i} tone="warning">⚠ {w}</Notice>
            ))}
            <h5>Pre-mortem (§7)</h5>
            <div className="ui-meta-sm">{card.premortem.assumedFailure}</div>
            <ul>
              {card.premortem.causes.map((c, i) => (
                <li key={i}><b>{c.category}:</b> {c.description}</li>
              ))}
            </ul>
            <h5>Entry & limitations</h5>
            <div>{card.entryCondition}</div>
            <ul>
              {card.limitations.map((l, i) => (
                <li key={i} className="ui-meta-sm">{l}</li>
              ))}
            </ul>
            <div className="ui-meta-sm">Sources: {card.sources.join(", ")}</div>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

export function ResearchRunsPanel({ activeEnv, userLogin, onSendPrompt }: ResearchRunsPanelProps) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [report, setReport] = useState<ReportView | null>(null);
  const [history, setHistory] = useState<RunSummaryView[]>([]);
  const [running, setRunning] = useState(false);
  // Issue #5912 — the venue/mode this run names; empty = the configured default.
  const [brokerId, setBrokerId] = useState("");
  const [mode, setMode] = useState("");
  const [runMsg, setRunMsg] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await apiFetch("/api/research/settings", { headers: hdrs(userLogin) });
      if (!res.ok) return;
      const data = await readJson<{ config?: Record<string, unknown> }>(res);
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
      const res = await apiFetch("/api/research/latest", { headers: hdrs(userLogin) });
      if (!res.ok) return;
      const data = await readJson<{ latest?: ReportView | null }>(res);
      if (data.latest) setReport(data.latest);
    } catch {
      /* empty */
    }
  }, [userLogin]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch("/api/research/history", { headers: hdrs(userLogin) });
      if (!res.ok) return;
      const data = await readJson<{ history?: RunSummaryView[] }>(res);
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
      const res = await apiFetch("/api/research/settings", {
        method: "POST",
        headers: { ...hdrs(userLogin), ...csrfHeaders() },
        body: JSON.stringify(patch),
      });
      const data = await readJson<{ config?: Record<string, unknown>; errors?: string[] }>(res);
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
      const selection = {
        ...(brokerId.trim() ? { brokerId: brokerId.trim() } : {}),
        ...(mode.trim() ? { mode: mode.trim() } : {}),
      };
      const res = await apiFetch("/api/research/run", {
        method: "POST",
        headers: { ...hdrs(userLogin), ...csrfHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      const data = await readJson<{
        success?: boolean;
        error?: string;
        reason?: string;
        message?: string;
        report?: ReportView;
        reportId?: string;
        engineJobId?: string;
        storageMode?: string;
        cutoverMode?: string;
        stages?: Array<{ stageId: string; status: string }>;
      }>(res);
      if (data.success && data.report) {
        setReport(data.report);
        const engineSuffix = data.engineJobId
          ? ` (${data.engineJobId} · ${data.cutoverMode ?? "engine"}/${data.storageMode ?? "durable"} · ${Array.isArray(data.stages) ? data.stages.length : 6}/6 stages)`
          : "";
        setRunMsg(`Done — canonical report ${data.reportId ?? ""} stored${engineSuffix}.`);
        void loadHistory();
      } else {
        setRunMsg(`Failed: ${data.error ?? data.reason ?? data.message ?? "unknown error"}`);
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
      const res = await apiFetch("/api/research/evaluate", {
        method: "POST",
        headers: { ...hdrs(userLogin), ...csrfHeaders() },
        body: JSON.stringify({ runId }),
      });
      const data = await readJson<{ evaluation?: { aggregates?: Record<string, unknown> } | null }>(res);
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
    <>
      <PageSection
        title="Autonomous Options Research"
        description="Read-only — no order entry from this panel"
      >
      <Stack gap="3">
      <Flex gap="2" wrap={true}>
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
        <TextInput
          aria-label="Broker / venue"
          placeholder="Broker (default configured)"
          value={brokerId}
          onChange={(e) => setBrokerId(e.target.value)}
        />
        <TextInput
          aria-label="Mode"
          placeholder="Mode (paper / live)"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        />
        <Button onClick={() => setShowFilters(!showFilters)}>{showFilters ? "Hide filters" : "Edit filters"}</Button>
        {report && <Button onClick={() => void evaluate(report.runId)}>Evaluate this run (§9)</Button>}
        {onSendPrompt && (
          <Button onClick={() => onSendPrompt("Summarize the latest autonomous options research run")}>
            Ask about results
          </Button>
        )}
      </Flex>
      {runMsg && <Notice tone="info">{runMsg}</Notice>}

      {showFilters && config && (
        <DetailCard title="Filters & thresholds — every run embeds the effective snapshot">
          <Stack gap="2">
          {CONFIG_FIELDS.map((f) => (
            <Flex key={f.key} gap="2" align="center" wrap={true}>
              <span id={`rrf-${f.key}`}>{f.label}</span>
              {f.type === "boolean" ? (
                <Checkbox
                  aria-labelledby={`rrf-${f.key}`}
                  checked={(draft[f.key] ?? "") === "1" || (draft[f.key] ?? "").toLowerCase() === "true"}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked ? "1" : "0" })}
                />
              ) : (
                <TextInput
                  aria-labelledby={`rrf-${f.key}`}
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                />
              )}
              <span className="ui-meta-sm">{f.hint}</span>
            </Flex>
          ))}
          <Flex gap="2" align="center">
            <Button onClick={() => void save()} disabled={saving} loading={saving}>{"Save filters"}</Button>
            {saveMsg && <Notice tone="info">{saveMsg}</Notice>}
          </Flex>
          </Stack>
        </DetailCard>
      )}

      {report ? (
        <Stack gap="3">
          <Flex gap="2" align="center" wrap={true}>
            <TriggerChip trigger={report.trigger} />
            <span className="ui-meta">
              {new Date(report.createdAt).toLocaleString()} · rules {report.rulesVersion} · {report.stats.durationMs}ms
            </span>
          </Flex>
          <p>{report.summary}</p>

          <CardHeader title={<>Qualified ideas ({report.ideas.length})</>} />
          {report.ideas.length === 0 && (
            <EmptyState
              title="No qualifying opportunities"
              description="No candidate passed the evidence and risk gates. This is a valid outcome."
              framed={true}
            />
          )}
          {report.ideas.map((c) => (
            <TradeCardDetail key={c.rank} card={c} />
          ))}

          <CardHeader title={<>Watchlist ({report.watchlist.length})</>} />
          {report.watchlist.map((w, i) => (
            <Notice key={i} tone="warning">
              <b>{w.symbol}</b> ({w.outlook}, {w.structure}) — {w.reason}
              <div className="ui-meta-sm">Trigger: {w.triggerCondition}</div>
            </Notice>
          ))}

          <CardHeader title={<>Rejected ({report.rejected.length})</>} />
          <Stack gap="1">
          {report.rejected.slice(0, 10).map((r, i) => (
            <div key={i} className="ui-meta-sm">
              <b>{r.symbol}</b> [{r.gate}] {r.reason}
            </div>
          ))}
          {report.rejected.length > 10 && (
            <div className="ui-meta-sm">…and {report.rejected.length - 10} more.</div>
          )}
          </Stack>

          {/* Issue #4262 (S3): options runs are listed in the ONE run ledger —
              this panel keeps its settings, controls and latest report, and
              links to the ledger filtered to Options instead of keeping a
              second run list. */}
          <CardHeader title="Run history" />
          <Flex gap="2" align="center" wrap={true}>
            <span className="ui-meta-sm">
              {history.length > 0
                ? `${history.length} recorded run${history.length === 1 ? "" : "s"} — listed in the one run ledger.`
                : "No research run yet — the one run ledger lists every options run."}
            </span>
            <Button variant="secondary" onClick={() => navigateToTab("schedules", "runs", { kind: "options" })}>
              Open the run ledger
            </Button>
          </Flex>
        </Stack>
      ) : (
        <EmptyState
          title="No research run yet"
          description="Run one manually, or wait for the scheduled after-close run (21:00 UTC weekdays)."
          framed={true}
        />
      )}
      </Stack>

      </PageSection>

      {/* Issue #3121 U-03 (lossless + additive): the retired OptionsHub
          schedules mode's options-research content lives here now —
          the one-shot run form (#2545), the autonomous runs record
          (#223), and the screening activity log (#1162). The
          schedules themselves live only in the consolidated home
          (?tab=schedules). */}
      <PageSection title="Run scheduling & activity">
      <ScheduledOptionsRunForm activeEnv={activeEnv} userLogin={userLogin} />
      <AutonomousOptionsRuns />
      <ScreeningActivityPanel userLogin={userLogin} />
      </PageSection>
    </>
  );
}

export default ResearchRunsPanel;
