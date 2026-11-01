import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Button, Checkbox, Select, Table, TextInput } from "./components/ui";
import { getPollingConfig } from "./pollingConfig";
import { isAutoRefreshEnabled } from "./autoRefresh";

/**
 * Goal Screen panel (consolidation C1, issue #1201, epic #1151 R1).
 *
 * The hub surface for the #1096 unified stack: pick a goal, run the
 * goal-driven screen (Phase 1 scenario → Phase 0 ScreeningProvider
 * registry → Phase 3 goal-driven semantics) via
 * POST /api/screening/goal-screen, and read the result with its
 * honesty status intact — a PARTIAL run names the failed asset
 * classes and their reasons; it is never dressed up as complete.
 * Stock hits can be backtested in place (backtest-on-screen,
 * POST /api/screening/backtest) with provenance + limitations shown.
 *
 * Issue #1997 (rebased onto #1996): the POST sends
 * async:true. When the goal_workflow flag is ON, the route
 * starts the #1996 goal workflow (one "goal" shard) and
 * answers 202 with a workflow acceptance ({workflowId,
 * statusUrl}). The panel then tracks the staged run: it
 * polls the job-history statusUrl for live stage rows,
 * keeps the previous result visible until the new one
 * lands, and fetches the stored run from /api/reports/:id
 * once the shard's analysis row carries a report id
 * (surfaced by the goal door through the shard row
 * result). Leg failures stay visible through the stored
 * result's PARTIAL rendering (failed classes + reasons),
 * never dressed up as complete. On tracking timeout the
 * previous result stays and the job link + Reports
 * guidance is the way back. Flag OFF → the POST returns
 * the direct result as before.
 *
 * Issue #2129: the tracking handle persists in sessionStorage
 * (per-tab) and resumes on mount with its original deadline;
 * with no handle, the newest stored goal run loads as the
 * previous result — a reload never shows a bare form for a run
 * that already exists.
 *
 * The goal-kind list below is presentational: the server validates
 * goalKind against the canonical GOAL_KINDS and 400s anything else.
 */
const GOAL_KIND_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "income", label: "Income" },
  { id: "directional", label: "Directional" },
  { id: "volatility_event", label: "Volatility / Event" },
  { id: "hedge_protect", label: "Hedge / Protect" },
  { id: "repair", label: "Repair" },
  { id: "deconcentrate", label: "Deconcentrate" },
  { id: "iv_harvest", label: "IV Harvest" },
  { id: "capital_efficient_leverage", label: "Capital-Efficient Leverage" },
  { id: "cash_secured_entry", label: "Cash-Secured Entry" },
];

const DIRECTION_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "", label: "Goal default" },
  { id: "bullish", label: "Bullish" },
  { id: "bearish", label: "Bearish" },
  { id: "volatile", label: "Volatile" },
  { id: "range_bound", label: "Range-bound" },
  { id: "unknown", label: "Unknown" },
];

interface GoalScreenHit {
  assetClass: "stocks" | "options";
  providerId: string;
  symbol: string;
  structures?: string[];
}

interface GoalScreenResult {
  goalKind: string;
  outlook: string;
  status: "complete" | "partial" | "failed";
  hits: GoalScreenHit[];
  counts: {
    stocksScanned: number;
    stocksMatched: number;
    optionsUnderlyingsScanned: number;
    optionsContractsMatched: number;
    hits: number;
  };
  partial?: { failedClasses: string[]; reasons: Record<string, string> };
  completedAt: string;
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
}

interface BacktestResult {
  provenance: string;
  aggregate: {
    totalTrades: number;
    totalNetPnl: number;
    totalReturnPct: number;
    winRate: number | null;
    maxDrawdownPct: number;
  };
  limitations: string[];
}

interface StageRow {
  stage: string;
  status: string;
  detail: string;
  updatedAtMs: number;
}

/** Issue #2041 S2: one pending journey gate, as the route serves it. */
interface PendingJourneyGate {
  sagaId: string;
  runRequestId: string;
  family: string;
  rail?: "stripe" | "x402";
  promptedAt: string;
  copy: { title: string; body: string; compensationLine: string };
}

interface Tracking {
  jobId: string;
  statusUrl: string;
  stages: StageRow[];
  timedOut: boolean;
}

interface GoalScreenPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

/** Issue #2129: the staged tracking handle, persisted per-tab so
 * a reload resumes the same run instead of showing a bare form.
 * sessionStorage (not localStorage): a handle must die with its
 * tab, never resurrect a stale run in a later session. All three
 * helpers are best-effort — storage failures never break tracking. */
export const GOAL_TRACKING_KEY = "goal-screen:tracking";

export interface GoalTrackingHandle {
  jobId: string;
  statusUrl: string;
  startedAtMs: number;
}

export function loadGoalTracking(): GoalTrackingHandle | null {
  try {
    const raw = sessionStorage.getItem(GOAL_TRACKING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GoalTrackingHandle>;
    if (
      typeof parsed.jobId !== "string" ||
      typeof parsed.statusUrl !== "string" ||
      typeof parsed.startedAtMs !== "number"
    ) {
      return null;
    }
    return { jobId: parsed.jobId, statusUrl: parsed.statusUrl, startedAtMs: parsed.startedAtMs };
  } catch {
    return null;
  }
}

export function persistGoalTracking(handle: GoalTrackingHandle): void {
  try {
    sessionStorage.setItem(GOAL_TRACKING_KEY, JSON.stringify(handle));
  } catch {
    // Best-effort; in-memory tracking still works.
  }
}

/** Clear only this run's handle — a superseded loop must never
 * wipe a newer run's handle (see the gen guard in trackStagedRun). */
export function clearGoalTracking(jobId?: string): void {
  try {
    if (jobId !== undefined) {
      const current = loadGoalTracking();
      if (current && current.jobId !== jobId) return;
    }
    sessionStorage.removeItem(GOAL_TRACKING_KEY);
  } catch {
    // Best-effort.
  }
}

export function GoalScreenPanel({ activeEnv, userLogin }: GoalScreenPanelProps) {
  const [goalKind, setGoalKind] = useState("income");
  const [direction, setDirection] = useState("");
  const [symbolsText, setSymbolsText] = useState("");
  const [includeStocks, setIncludeStocks] = useState(true);
  const [includeOptions, setIncludeOptions] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<GoalScreenResult | null>(null);
  const [previousResult, setPreviousResult] = useState(false);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestError, setBacktestError] = useState("");
  const [tracking, setTracking] = useState<Tracking | null>(null);
  // Generation guard: a new submit (or unmount) cancels any
  // in-flight tracking loop — its late setStates are dropped.
  const trackGen = useRef(0);
  useEffect(
    () => () => {
      trackGen.current += 1;
    },
    [],
  );

  // Issue #2041 S2: pending journey gates. The poll runs
  // unconditionally while mounted: a pending decision must
  // surface even with auto-refresh off, and the card disappears
  // on next poll once decided (state-driven dismissal — the
  // route no longer lists decided gates).
  const [journeyGates, setJourneyGates] = useState<PendingJourneyGate[]>([]);
  const [journeyGateNotice, setJourneyGateNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    const loadGates = async () => {
      try {
        const res = await fetch("/api/saga/journey-gates");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { gates?: PendingJourneyGate[] };
        if (Array.isArray(data.gates)) setJourneyGates(data.gates);
      } catch {
        // Best-effort: a failed poll leaves the previous list.
      }
    };
    void loadGates();
    const timer = setInterval(loadGates, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const answerJourneyGate = async (sagaId: string, decision: "approved" | "denied") => {
    try {
      const res = await fetch("/api/saga/journey-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sagaId, decision, surface: "panel" }),
      });
      const data = (await res.json().catch(() => null)) as {
        accepted?: boolean;
        superseded?: boolean;
        decidedBy?: string;
      } | null;
      if (res.status === 409 || data?.superseded) {
        setJourneyGateNotice(
          `Already decided (by ${data?.decidedBy ?? "another surface"}) — this answer was refused as superseded.`,
        );
      } else if (res.ok && data?.accepted) {
        setJourneyGateNotice(
          decision === "approved"
            ? "Journey approved — the saga will enter the trading leg."
            : "Journey declined — the saga ends with no trades and no proposals.",
        );
      } else {
        setJourneyGateNotice("Journey answer failed — please try again.");
        return;
      }
      setJourneyGates((prev) => prev.filter((g) => g.sagaId !== sagaId));
    } catch {
      setJourneyGateNotice("Journey answer failed — please try again.");
    }
  };

  const stockHits = useMemo(
    () =>
      result
        ? [...new Set(result.hits.filter((h) => h.assetClass === "stocks").map((h) => h.symbol))]
        : [],
    [result]
  );

  const trackStagedRun = async (jobId: string, statusUrl: string, startedAtMs: number = Date.now()) => {
    const gen = trackGen.current;
    // Issue #2419: cadence + deadline resolve through the externalized
    // polling config (defaults 2s / 10min when nothing is injected).
    const trackPollMs = getPollingConfig().goalTrackPollMs;
    const trackDeadlineMs = getPollingConfig().goalTrackDeadlineMs;
    // Issue #2129: persist at track start so a reload resumes
    // this run; the deadline stays absolute from the ORIGINAL
    // submit (a resumed loop does not get a fresh 10 minutes).
    persistGoalTracking({ jobId, statusUrl, startedAtMs });
    const deadline = startedAtMs + trackDeadlineMs;
    while (Date.now() < deadline) {
      if (trackGen.current !== gen) return;
      await new Promise((resolve) => setTimeout(resolve, trackPollMs));
      if (trackGen.current !== gen) return;
      // Issue #2419: never spend a status fetch while the tab is
      // hidden — the loop re-sleeps and the absolute deadline still
      // applies, so a hidden tab costs zero requests. (This loop is
      // bounded until-terminal, so it takes the shared treatment's
      // hidden-pause + externalized cadence rather than usePolling's
      // indefinite shape, which has no stop handle.)
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        continue;
      }
      // Issue #2481 — the global auto-refresh switch gates this
      // periodic status fetch too: while OFF the loop sleeps
      // without fetching (deadline unchanged, so tracking resumes
      // if the switch flips back ON, and the stored run stays
      // reachable via Screening → Reports).
      if (!isAutoRefreshEnabled()) {
        continue;
      }
      let history: { jobs?: Array<{ stage?: string; status?: string; detail?: string; updatedAtMs?: number; resultJson?: string }> };
      try {
        const res = await globalThis.fetch(statusUrl, {
          headers: {
            Accept: "application/json",
            ...(userLogin ? { "x-user-login": userLogin } : {}),
          },
        });
        if (!res.ok) {
          setError(
            `Could not track the staged run (HTTP ${res.status}). Your previous result is kept — find the run in Screening → Reports once it lands.`,
          );
          setTracking(null);
          clearGoalTracking(jobId);
          return;
        }
        history = (await res.json()) as typeof history;
      } catch {
        setError(
          "Could not track the staged run. Your previous result is kept — find the run in Screening → Reports once it lands.",
        );
        setTracking(null);
        clearGoalTracking(jobId);
        return;
      }
      const stages: StageRow[] = (history.jobs ?? [])
        .map((row) => ({
          stage: row.stage ?? "",
          status: row.status ?? "",
          detail: row.detail ?? "",
          updatedAtMs: row.updatedAtMs ?? 0,
        }))
        .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
      if (trackGen.current !== gen) return;
      setTracking({ jobId, statusUrl, stages, timedOut: false });
      // Issue #1997 (rebased onto #1996): a goal run is ONE
      // "goal" shard, so there is no separate store row — the
      // shard's analysis row carries the store outcome in its
      // result ({shardJobIds, result: {stored, reportId?,
      // storeError?}}). The shard row is the one whose inner
      // result has a boolean `stored` (parent collation rows
      // carry different shapes).
      const shardRow = (history.jobs ?? []).find((row) => {
        try {
          const parsed = JSON.parse(row.resultJson ?? "{}") as {
            result?: { stored?: unknown };
          };
          return typeof parsed.result?.stored === "boolean";
        } catch {
          return false;
        }
      });
      if (shardRow) {
        if (shardRow.status !== "completed") {
          setError(
            `Staged run failed at the analysis stage: ${shardRow.detail ?? "screen failed"}. Your previous result is kept.`,
          );
          setTracking(null);
          clearGoalTracking(jobId);
          return;
        }
        let inner: { stored?: boolean; reportId?: string; storeError?: string } = {};
        try {
          const parsed = JSON.parse(shardRow.resultJson ?? "{}") as {
            result?: typeof inner;
          };
          inner = parsed.result ?? {};
        } catch {
          inner = {};
        }
        if (inner.stored !== true) {
          setError(
            `Staged run could not be stored: ${inner.storeError ?? "store failed"}. Your previous result is kept.`,
          );
          setTracking(null);
          clearGoalTracking(jobId);
          return;
        }
        const reportId = inner.reportId;
        if (!reportId) {
          setError(
            "Run stored but the report could not be located — find it in Screening → Reports.",
          );
          setTracking(null);
          clearGoalTracking(jobId);
          return;
        }
        try {
          const res = await globalThis.fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
            headers: {
              Accept: "application/json",
              ...(userLogin ? { "x-user-login": userLogin } : {}),
            },
          });
          if (!res.ok) throw new Error(`Report fetch failed [HTTP ${res.status}].`);
          const data = (await res.json()) as {
            body?: {
              result?: GoalScreenResult;
              pdfKey?: string;
              xlsxKey?: string;
              csvKey?: string;
            };
          };
          if (!data.body?.result) throw new Error("Stored run has no result.");
          if (trackGen.current !== gen) return;
          const mergedResult: GoalScreenResult = {
            ...data.body.result,
            pdfKey: data.body.result.pdfKey ?? data.body.pdfKey,
            xlsxKey: data.body.result.xlsxKey ?? data.body.xlsxKey,
            csvKey: data.body.result.csvKey ?? data.body.csvKey,
          };
          setResult(mergedResult);
          setPreviousResult(false);
          setBacktest(null);
          setBacktestError("");
          setTracking(null);
          clearGoalTracking(jobId);
          const deliverRow = (history.jobs ?? []).find((row) => row.stage === "deliver");
          if (deliverRow && deliverRow.status === "failed") {
            setError(`Run complete and stored, but delivery failed: ${deliverRow.detail ?? "deliver failed"}`);
          }
        } catch (err) {
          if (trackGen.current !== gen) return;
          setError(
            err instanceof Error ? err.message : "Stored run could not be loaded.",
          );
          setTracking(null);
          clearGoalTracking(jobId);
        }
        return;
      }
    }
    if (trackGen.current !== gen) return;
    setTracking((t) => (t ? { ...t, timedOut: true } : t));
    setError(
      "The staged run is still processing. Your previous result is kept — track it via the job link below, or find the run in Screening → Reports once it lands.",
    );
    clearGoalTracking(jobId);
  };

  // Issue #2129: best-effort read-back of the newest stored goal
  // run (the proven Reports read path: /api/runs newest-first,
  // then /api/reports/:id). Failures are silent — a missing
  // previous result is not an error state, and the Reports tab
  // remains the full history.
  const loadLatestGoalResult = async () => {
    try {
      const res = await fetch(`/api/runs?kind=all&limit=100`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        runs?: Array<{ id?: unknown; reportId?: unknown; source?: unknown }>;
      };
      const newest = (data.runs ?? []).find((r) => r.source === "goal_screen");
      if (!newest) return;
      const reportId = newest.reportId ?? newest.id;
      if (typeof reportId !== "string" || !reportId) return;
      const reportRes = await globalThis.fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
        headers: {
          Accept: "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
      });
      if (!reportRes.ok) return;
      const reportData = (await reportRes.json()) as {
        body?: {
          result?: GoalScreenResult;
          pdfKey?: string;
          xlsxKey?: string;
          csvKey?: string;
        };
      };
      if (!reportData.body?.result) return;
      const mergedResult: GoalScreenResult = {
        ...reportData.body.result,
        pdfKey: reportData.body.result.pdfKey ?? reportData.body.pdfKey,
        xlsxKey: reportData.body.result.xlsxKey ?? reportData.body.xlsxKey,
        csvKey: reportData.body.result.csvKey ?? reportData.body.csvKey,
      };
      setResult(mergedResult);
      setPreviousResult(true);
    } catch {
      // Silent: no previous result to show.
    }
  };

  // Issue #2129: a reload must never show a bare form for a run
  // that already exists. Resume a persisted staged run (with its
  // ORIGINAL submit deadline), or show the newest stored goal
  // run as the previous result.
  useEffect(() => {
    const handle = loadGoalTracking();
    if (handle) {
      setTracking({ jobId: handle.jobId, statusUrl: handle.statusUrl, stages: [], timedOut: false });
      void trackStagedRun(handle.jobId, handle.statusUrl, handle.startedAtMs);
    } else {
      void loadLatestGoalResult();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runScreen = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    const assetClasses = [
      ...(includeStocks ? ["stocks"] : []),
      ...(includeOptions ? ["options"] : []),
    ];
    if (assetClasses.length === 0) {
      setError("Select at least one asset class to screen.");
      return;
    }
    const symbols = symbolsText
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    setLoading(true);
    setError("");
    // Issue #1997: the previous result stays visible until the
    // new one lands (never cleared on submit); the backtest
    // clears only when the new result arrives.
    setTracking(null);
    trackGen.current += 1;
    // Issue #2129: a new submit supersedes any stored handle; the
    // staged path re-persists its own, the direct path leaves none.
    clearGoalTracking();
    try {
      const res = await fetch("/api/screening/goal-screen", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          goalKind,
          environment: activeEnv,
          ...(direction ? { direction } : {}),
          ...(symbols.length > 0 ? { symbols } : {}),
          assetClasses,
          // Issue #1997: request the staged path. The route
          // enforces the goal_workflow flag (flag OFF → direct
          // result, flag ON → 202 workflow acceptance tracked
          // below), so sending async is safe in both states.
          async: true,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        result?: GoalScreenResult;
        workflowId?: string;
        jobId?: string;
        statusUrl?: string;
      };
      // Issue #1997: a staged run answers 202 with a workflow
      // acceptance — track it (live stage progress) instead of
      // treating the missing result as an error.
      if (typeof data.workflowId === "string" && typeof data.statusUrl === "string") {
        setLoading(false);
        setTracking({
          jobId: data.jobId ?? "",
          statusUrl: data.statusUrl,
          stages: [],
          timedOut: false,
        });
        void trackStagedRun(data.jobId ?? "", data.statusUrl);
        return;
      }
      // A failed run (every asset class down) answers 502 WITH the
      // labeled result — render it; only a body without a result is
      // a plain error.
      if (data.result) {
        setResult(data.result);
        setPreviousResult(false);
        setBacktest(null);
        setBacktestError("");
        if (!res.ok) setError(data.error || "The goal screen failed on every requested asset class.");
      } else {
        throw new Error(data.error || `Goal screen request failed [HTTP ${res.status}].`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Goal screen request failed.");
    } finally {
      setLoading(false);
    }
  };

  const runBacktest = async () => {
    if (backtestLoading || stockHits.length === 0) return;
    setBacktestLoading(true);
    setBacktestError("");
    setBacktest(null);
    try {
      const res = await fetch("/api/screening/backtest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ symbols: stockHits }),
      });
      const data = (await res.json()) as { error?: string } & BacktestResult;
      if (!res.ok) throw new Error(data.error || `Backtest request failed [HTTP ${res.status}].`);
      setBacktest(data);
    } catch (err) {
      setBacktestError(err instanceof Error ? err.message : "Backtest request failed.");
    } finally {
      setBacktestLoading(false);
    }
  };

  const statusStyle: React.CSSProperties =
    result?.status === "complete"
      ? { background: "var(--color-success-subtle)", color: "var(--color-success)" }
      : result?.status === "partial"
        ? { background: "var(--color-warning-subtle)", color: "var(--color-warning)" }
        : { background: "var(--color-danger-subtle)", color: "var(--color-danger)" };

  return (
    <div style={{ padding: "var(--space-4) 0" }}>
      <p style={{ margin: "0 0 1rem", color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
        Run a goal-driven screen through the unified screening stack: the goal&rsquo;s scenario
        drives one screen across stocks and options, executed by the shared provider registry.
        Results are recorded in Reports and the screening activity log.
      </p>
      <form onSubmit={runScreen} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)", alignItems: "flex-end" }}>
        <Select label="Goal" value={goalKind} onChange={(e) => setGoalKind(e.target.value)}>
          {GOAL_KIND_OPTIONS.map((g) => (
            <option key={g.id} value={g.id}>{g.label}</option>
          ))}
        </Select>
        <Select label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)}>
          {DIRECTION_OPTIONS.map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </Select>
        <TextInput label="Symbols (optional, comma-separated — scopes the options leg only; the stock leg always scans the full universe)"
          type="text"
          value={symbolsText}
          onChange={(e) => setSymbolsText(e.target.value)}
          placeholder="AAPL, NVDA, MSFT"
        />
        <Checkbox label="Stocks" checked={includeStocks} onChange={(e) => setIncludeStocks(e.target.checked)} />
        <Checkbox label="Options" checked={includeOptions} onChange={(e) => setIncludeOptions(e.target.checked)} />
        <Button type="submit" variant="primary" disabled={loading} loading={loading}>
          {"Run goal screen"}
        </Button>
      </form>

      {error && <div className="options-error" role="alert">{error}</div>}

      {journeyGates.length > 0 && (
        <div style={{ marginTop: "1rem" }} role="status">
          <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>Pending journey decisions</p>
          {journeyGateNotice && (
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>{journeyGateNotice}</p>
          )}
          {journeyGates.map((gate) => (
            <div key={gate.sagaId} style={{ marginBottom: "0.75rem", fontSize: "var(--font-size-body)" }}>
              <p style={{ margin: "0 0 0.25rem" }}>
                {gate.copy.title} — run {gate.runRequestId} ({gate.family})
              </p>
              <p style={{ margin: "0 0 0.25rem", color: "var(--color-text-muted)" }}>{gate.copy.body}</p>
              <p style={{ margin: "0 0 0.5rem", color: "var(--color-text-muted)" }}>{gate.copy.compensationLine}</p>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button type="button" variant="primary" onClick={() => void answerJourneyGate(gate.sagaId, "approved")}>
                  Enter trading leg
                </Button>
                <Button type="button" onClick={() => void answerJourneyGate(gate.sagaId, "denied")}>
                  Do not enter
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tracking && (
        <div style={{ marginTop: "1rem", fontSize: "var(--font-size-body)" }} role="status">
          <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>
            Staged run in progress{tracking.timedOut ? " — still processing" : ""} — live stage progress
          </p>
          {tracking.stages.length > 0 ? (
            <ul style={{ margin: "0 0 0.5rem", color: "var(--color-text-muted)" }}>
              {tracking.stages.map((row, i) => (
                <li key={`${row.stage}-${i}`}>
                  {row.stage}: {row.status}
                  {row.detail ? ` — ${row.detail}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: "0 0 0.5rem", color: "var(--color-text-muted)" }}>
              Waiting for the first stage row…
            </p>
          )}
          <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
            <a href={tracking.statusUrl}>Track this run (job history)</a>
            {tracking.timedOut
              ? " — or find the run in Screening → Reports once it lands. Your previous result is kept."
              : " — your previous result stays visible until the new one lands."}
          </p>
        </div>
      )}

      {result && (
        <div style={{ marginTop: "1rem" }}>
          {previousResult && (
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
              Previous stored run — submit a new goal screen to refresh.
            </p>
          )}
          <div
            role="status"
            style={{ ...statusStyle, padding: "var(--space-2) var(--space-3)", borderRadius: "6px", fontWeight: 600 }}
          >
            {result.status === "complete" && `Complete — ${result.goalKind} (${result.outlook})`}
            {result.status === "partial" &&
              `PARTIAL — ${result.partial?.failedClasses.join(", ")} failed: ${Object.values(result.partial?.reasons ?? {}).join("; ")}`}
            {result.status === "failed" && "Failed — the screen produced no complete result."}
          </div>
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
            Scanned {result.counts.stocksScanned} stocks ({result.counts.stocksMatched} matched),{" "}
            {result.counts.optionsUnderlyingsScanned} option underlyings ({result.counts.optionsContractsMatched}{" "}
            contracts matched); {result.counts.hits} hit(s).
          </p>
          {(() => {
            const pdfUrl = result.pdfKey
              ? `/api/screening/goal-screen/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
              : undefined;
            const xlsxUrl = result.xlsxKey
              ? `/api/screening/goal-screen/report.xlsx?key=${encodeURIComponent(result.xlsxKey)}`
              : undefined;
            const csvUrl = result.csvKey
              ? `/api/screening/goal-screen/report.csv?key=${encodeURIComponent(result.csvKey)}`
              : undefined;
            if (!pdfUrl && !xlsxUrl && !csvUrl) return null;
            return (
              <div
                className="goal-screen-report-actions"
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  margin: "var(--space-2) 0",
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                {pdfUrl && (
                  <a
                    className="ui-btn variant-secondary tone-subtle size-sm goal-screen-download-pdf"
                    href={pdfUrl}
                    download
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
                  >
                    📄 Download PDF
                  </a>
                )}
                {xlsxUrl && (
                  <a
                    className="ui-btn variant-secondary tone-subtle size-sm goal-screen-download-xlsx"
                    href={xlsxUrl}
                    download
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
                  >
                    📊 Download XLSX
                  </a>
                )}
                {csvUrl && (
                  <a
                    className="ui-btn variant-secondary tone-subtle size-sm goal-screen-download-csv"
                    href={csvUrl}
                    download
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
                  >
                    📋 Download CSV
                  </a>
                )}
              </div>
            );
          })()}
          {result.hits.length > 0 && (
            <Table
              columns={[
                {
                  key: "symbol",
                  header: "Symbol",
                  render: (hit) => <span style={{ fontWeight: 600 }}>{hit.symbol}</span>,
                },
                { key: "assetClass", header: "Asset class", render: (hit) => hit.assetClass },
                { key: "provider", header: "Provider", render: (hit) => hit.providerId },
                // Issue #1963: stock hits never carry structures — hide the
                // column unless at least one hit actually carries structures.
                ...(result.hits.some((hit) => (hit.structures?.length ?? 0) > 0)
                  ? [
                      {
                        key: "structures",
                        header: "Candidate structures",
                        render: (hit: GoalScreenHit) => hit.structures?.join(", ") ?? "—",
                      },
                    ]
                  : []),
              ]}
              rows={result.hits}
              rowKey={(hit, i) => `${hit.assetClass}-${hit.symbol}-${i}`}
            />
          )}
          {stockHits.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <Button type="button" onClick={runBacktest} disabled={backtestLoading} loading={backtestLoading}>
                {`Backtest the ${stockHits.length} stock hit(s)`}
              </Button>
              {backtestError && <div className="options-error" role="alert">{backtestError}</div>}
              {backtest && (
                <div style={{ marginTop: "0.75rem", fontSize: "var(--font-size-body)" }}>
                  <p style={{ margin: "0 0 0.5rem" }}>
                    <strong>Backtest (provenance: {backtest.provenance})</strong> — {backtest.aggregate.totalTrades}{" "}
                    trade(s), net ${backtest.aggregate.totalNetPnl.toLocaleString("en-US")} (
                    {backtest.aggregate.totalReturnPct}%), win rate{" "}
                    {backtest.aggregate.winRate === null
                      ? "n/a"
                      : `${Math.round(backtest.aggregate.winRate * 100)}%`}
                    , max drawdown {backtest.aggregate.maxDrawdownPct}%.
                  </p>
                  <ul style={{ margin: 0, color: "var(--color-text-muted)" }}>
                    {backtest.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
