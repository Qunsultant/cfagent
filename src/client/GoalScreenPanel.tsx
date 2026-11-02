import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
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

/**
 * Shared styles for the saga start section below — one definition per
 * visual pattern, reused across the section, instead of a fresh inline
 * style literal per element (the bespoke-styling ceiling counts
 * literals, and the section repeats the same muted paragraph often).
 */
const sagaSectionStyle: CSSProperties = { marginTop: "1rem" };
const sagaHeadingStyle: CSSProperties = { margin: "0 0 0.25rem", fontWeight: 600 };
const sagaMutedStyle: CSSProperties = { margin: "0 0 0.5rem", color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" };
const sagaMutedPlainStyle: CSSProperties = { color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" };
const sagaMutedTightStyle: CSSProperties = { margin: "0 0 0.25rem", color: "var(--color-text-muted)" };
const sagaFieldsetStyle: CSSProperties = { border: 0, margin: 0, padding: 0 };
const sagaReceiptStyle: CSSProperties = { marginTop: "1rem", fontSize: "var(--font-size-body)" };
const sagaListStyle: CSSProperties = { margin: "0 0 0.5rem", color: "var(--color-text-muted)" };

/**
 * Saga start + progress (issue 2677, slice B). The first client caller
 * of GET /api/saga/:sagaId/status: it starts a paid saga journey
 * through POST /api/saga/start (goal family only, per the saga
 * program's working default) and polls the status route until the
 * journey gate — then hands over to the existing gate cards
 * (panel/chat/Slack) and the Trading Approvals Queue, which are NOT
 * rebuilt here. Starting is a USER action (own session), never an
 * operator action: the form is not operator-gated. Rendered text
 * never uses the "#NNNN" issue-number form (the ratchet counts it
 * as a hex literal).
 */
export const SAGA_TRACKING_KEY = "saga:tracking";

export interface SagaTrackingHandle {
  sagaId: string;
  statusUrl: string;
}

export function loadSagaTracking(): SagaTrackingHandle | null {
  try {
    const raw = sessionStorage.getItem(SAGA_TRACKING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SagaTrackingHandle>;
    if (typeof parsed.sagaId !== "string" || typeof parsed.statusUrl !== "string") return null;
    return { sagaId: parsed.sagaId, statusUrl: parsed.statusUrl };
  } catch {
    return null;
  }
}

export function persistSagaTracking(handle: SagaTrackingHandle): void {
  try {
    sessionStorage.setItem(SAGA_TRACKING_KEY, JSON.stringify(handle));
  } catch {
    // Best-effort; in-memory tracking still works.
  }
}

export function clearSagaTracking(): void {
  try {
    sessionStorage.removeItem(SAGA_TRACKING_KEY);
  } catch {
    // Best-effort.
  }
}

export function generateSagaIds(): { sagaId: string; runRequestId: string; jobId: string } {
  // Mirrors the entry route's server-side default pattern
  // (saga-<ts36>-<rand>); the run request id defaults to the saga id.
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sagaId = `saga-${suffix}`;
  return { sagaId, runRequestId: sagaId, jobId: `saga-job-${suffix}` };
}

export function parseOptionLegs(text: string): { legs?: Array<Record<string, unknown>>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Legs must be a JSON array." };
  }
  if (!Array.isArray(parsed) || parsed.length < 1) {
    return { error: "Legs must be a JSON array with at least one leg." };
  }
  if (!parsed.every((leg) => !!leg && typeof leg === "object" && !Array.isArray(leg))) {
    return { error: "Each leg must be a JSON object." };
  }
  return { legs: parsed as Array<Record<string, unknown>> };
}

export interface SagaStartFields {
  userLogin: string;
  kind: "stock" | "options";
  symbol: string;
  action: "buy" | "sell";
  quantity: string;
  rail: "" | "stripe" | "x402";
  email: string;
  legsText: string;
}

export function buildSagaStartBody(
  fields: SagaStartFields,
  ids: { sagaId: string; runRequestId: string; jobId: string },
): { body?: Record<string, unknown>; error?: string } {
  const symbol = fields.symbol.trim().toUpperCase();
  if (!symbol) return { error: "Symbol is required." };
  const quantity = Number(fields.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: "Quantity must be a positive number." };
  const email = fields.email.trim();
  // Slightly stricter than the route's non-empty rule, so the form
  // never creates a run with a garbage delivery address.
  if (!email || !email.includes("@")) return { error: "Email is required." };
  let optionLegs: Array<Record<string, unknown>> | undefined;
  if (fields.kind === "options") {
    const parsed = parseOptionLegs(fields.legsText.trim());
    if (parsed.error) return { error: parsed.error };
    optionLegs = parsed.legs;
  }
  const tradeIntent: Record<string, unknown> = {
    kind: fields.kind,
    symbol,
    action: fields.action,
    quantity,
    ...(optionLegs ? { optionLegs } : {}),
  };
  return {
    body: {
      sagaId: ids.sagaId,
      runRequestId: ids.runRequestId,
      // Canonical parent screener command (the same shape the goal
      // workflow submission builds); the route validates jobId and
      // that userLogin equals the session login, nothing more.
      screenerCommand: {
        jobId: ids.jobId,
        type: "run-screen",
        source: "manual",
        trigger: "manual",
        userLogin: fields.userLogin,
        role: "parent",
        shards: [{ shardId: "goal" }],
      },
      tradeIntent,
      email,
      family: "goal",
      trigger: "manual",
      ...(fields.rail ? { rail: fields.rail } : {}),
    },
  };
}

export interface SagaStatusJob {
  stage: string;
  status: string;
  detail?: string;
  updatedAtMs?: number;
}

export function sagaProgressPhase(jobs: SagaStatusJob[]): "gate" | "done" | null {
  if (jobs.some((job) => job.stage === "done")) return "done";
  if (jobs.some((job) => job.stage === "journey")) return "gate";
  return null;
}

export function mapSagaStartError(status: number, serverError: string | null): string {
  if (status === 401) return "Sign in to start a saga.";
  if (status === 403) {
    return serverError && serverError.includes("monetization flag")
      ? "Saga start is disabled — the monetization flag is OFF. An owner enables it in the Flagship dashboard."
      : "Saga start was refused. The monetization flag may be OFF.";
  }
  if (status === 400) return serverError ?? "Saga start was rejected — check the form.";
  if (status === 503) return serverError ?? "Saga start is unavailable right now.";
  return serverError ?? `Saga start failed (HTTP ${status}).`;
}

export type SagaProgressPhase = "polling" | "gate" | "done" | "stopped" | "error";

export function SagaStartSection({ userLogin }: { userLogin?: string }) {
  const [flagState, setFlagState] = useState<"loading" | "on" | "off" | "unknown">("loading");
  const [kind, setKind] = useState<"stock" | "options">("stock");
  const [symbol, setSymbol] = useState("");
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("");
  const [rail, setRail] = useState<"" | "stripe" | "x402">("");
  const [email, setEmail] = useState("");
  const [legsText, setLegsText] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [started, setStarted] = useState<{
    sagaId: string;
    runRequestId: string;
    statusUrl: string;
    disclosure: string | null;
    existing: boolean;
  } | null>(null);
  const [jobs, setJobs] = useState<SagaStatusJob[]>([]);
  const [instanceStatus, setInstanceStatus] = useState<string | null>(null);
  const [outcomeCode, setOutcomeCode] = useState<string | null>(null);
  const [phase, setPhase] = useState<SagaProgressPhase>("polling");
  const [progressError, setProgressError] = useState("");

  // Flag pre-check via the pricing route's monetizationEnabled: the
  // flag value itself lives only in Flagship and cannot be read
  // here, but the pricing route evaluates it for the session. A
  // failed pre-check leaves the flag unknown and the form enabled —
  // a 403 from the start POST itself still surfaces the reason.
  useEffect(() => {
    if (!userLogin) {
      setFlagState("unknown");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/payments/agentic/commercial/pricing", {
          headers: { "x-user-login": userLogin },
        });
        if (cancelled) return;
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setFlagState(res.ok && data["monetizationEnabled"] === true ? "on" : res.ok ? "off" : "unknown");
      } catch {
        if (!cancelled) setFlagState("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userLogin]);

  // Resume a followed run after reload (same sessionStorage pattern
  // as goal-screen tracking); the status route is not flag-gated,
  // so resuming works even with the flag off.
  useEffect(() => {
    const handle = loadSagaTracking();
    if (handle) {
      setStarted({ sagaId: handle.sagaId, runRequestId: "", statusUrl: handle.statusUrl, disclosure: null, existing: true });
      setPhase("polling");
    }
  }, []);

  // Gate-cards' 30s setInterval pattern (not the 2s staged-run loop:
  // a saga run is long-lived — payment plus screen take minutes).
  // Stops at the gate, at a terminal outcome, on error, or on
  // "Stop following" (effect cleanup clears the interval).
  useEffect(() => {
    if (!started?.statusUrl || phase !== "polling") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(started.statusUrl, {
          headers: { ...(userLogin ? { "x-user-login": userLogin } : {}) },
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) setProgressError("Saga not found (runs are owner-scoped).");
          else if (res.status === 503) setProgressError("Saga status is unavailable (audit read failed).");
          else setProgressError(typeof data["error"] === "string" ? (data["error"] as string) : `Saga status failed (HTTP ${res.status}).`);
          setPhase("error");
          return;
        }
        const nextJobs = Array.isArray(data["jobs"]) ? (data["jobs"] as SagaStatusJob[]) : [];
        setJobs(nextJobs);
        setInstanceStatus(typeof data["instanceStatus"] === "string" ? (data["instanceStatus"] as string) : null);
        setOutcomeCode(typeof data["outcomeCode"] === "string" ? (data["outcomeCode"] as string) : null);
        const terminal = sagaProgressPhase(nextJobs);
        if (terminal) setPhase(terminal);
      } catch {
        if (!cancelled) {
          setProgressError("Saga status could not be reached.");
          setPhase("error");
        }
      }
    };
    void poll();
    const timer = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [started?.statusUrl, phase, userLogin]);

  const disabled = !userLogin || flagState === "off";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || disabled || !userLogin) return;
    const { body, error } = buildSagaStartBody(
      { userLogin, kind, symbol, action, quantity, rail, email, legsText },
      generateSagaIds(),
    );
    if (error || !body) {
      setFormError(error ?? "Saga start was rejected — check the form.");
      return;
    }
    setFormError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/saga/start", {
        method: "POST",
        headers: { "x-user-login": userLogin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setFormError(mapSagaStartError(res.status, typeof data["error"] === "string" ? (data["error"] as string) : null));
        // A flag flip between pre-check and submit surfaces here:
        // re-disable the form with the flag reason.
        if (res.status === 403) setFlagState("off");
        return;
      }
      // apiFetch intercepts a 202 only when the body has BOTH a
      // string jobId and a string statusUrl; the saga 202 has a
      // statusUrl but no jobId, so it passes through unchanged.
      // The statusUrl fallback covers a future apiFetch change.
      const sagaId = typeof data["sagaId"] === "string" ? (data["sagaId"] as string) : (body["sagaId"] as string);
      const statusUrl =
        typeof data["statusUrl"] === "string" ? (data["statusUrl"] as string) : `/api/saga/${sagaId}/status`;
      setStarted({
        sagaId,
        runRequestId: typeof data["runRequestId"] === "string" ? (data["runRequestId"] as string) : (body["runRequestId"] as string),
        statusUrl,
        disclosure: typeof data["disclosure"] === "string" ? (data["disclosure"] as string) : null,
        existing: data["existing"] === true,
      });
      persistSagaTracking({ sagaId, statusUrl });
      setPhase("polling");
      setJobs([]);
      setProgressError("");
    } catch {
      setFormError("Saga start could not be reached.");
    }
    setSubmitting(false);
  };

  return (
    <div style={sagaSectionStyle}>
      <p style={sagaHeadingStyle}>Start a paid saga journey</p>
      <p style={sagaMutedStyle}>
        Pay for a goal screen, then decide at the journey gate whether
        to enter the trading leg. Per-order approval still gates every
        trade — this start never places an order. The run costs the
        approved goal price; starting is open to any signed-in user
        for their own runs.
      </p>
      {!userLogin && (
        <p style={sagaMutedPlainStyle}>
          Sign in to start a saga.
        </p>
      )}
      {flagState === "off" && (
        <div className="options-error" role="alert">
          Saga start is disabled — the monetization flag is OFF. An
          owner enables it in the Flagship dashboard.
        </div>
      )}
      {flagState === "unknown" && userLogin && (
        <p style={sagaMutedPlainStyle}>
          Could not confirm the monetization flag — if it is OFF,
          starting will be refused with the reason.
        </p>
      )}
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={disabled} style={sagaFieldsetStyle}>
          <Select label="Trade intent kind" value={kind} onChange={(e) => setKind(e.target.value as "stock" | "options")}>
            <option value="stock">Stock</option>
            <option value="options">Options</option>
          </Select>
          <TextInput
            label="Symbol"
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="AAPL"
          />
          <Select label="Action" value={action} onChange={(e) => setAction(e.target.value as "buy" | "sell")}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </Select>
          <TextInput
            label="Quantity"
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="10"
          />
          <Select label="Payment rail (optional)" value={rail} onChange={(e) => setRail(e.target.value as "" | "stripe" | "x402")}>
            <option value="">Default</option>
            <option value="stripe">Stripe (card)</option>
            <option value="x402">x402 (crypto)</option>
          </Select>
          <TextInput
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            hint="Outcome notices go to Slack; the email is part of the saga entry."
          />
          {kind === "options" && (
            <TextInput
              label="Option legs (JSON)"
              multiline
              rows={3}
              value={legsText}
              onChange={(e) => setLegsText(e.target.value)}
              hint="A JSON array with at least one leg object. The entry route validates only that the array is non-empty."
            />
          )}
          <Button type="submit" variant="primary" disabled={disabled} loading={submitting}>
            Start paid saga
          </Button>
        </fieldset>
      </form>
      {formError && (
        <div className="options-error" role="alert">
          {formError}
        </div>
      )}
      {started && (
        <div style={sagaReceiptStyle} role="status">
          <p style={sagaHeadingStyle}>
            Saga started{started.existing && started.runRequestId === "" ? " (resumed)" : ""} — {started.sagaId}
          </p>
          {started.existing && started.runRequestId !== "" && (
            <p style={sagaMutedTightStyle}>
              Resumed an existing run for this saga id.
            </p>
          )}
          {started.runRequestId && (
            <p style={sagaMutedTightStyle}>Run request: {started.runRequestId}</p>
          )}
          <p style={sagaMutedTightStyle}>
            <a href={started.statusUrl}>{started.statusUrl}</a>
          </p>
          {started.disclosure && (
            <p style={sagaListStyle}>{started.disclosure}</p>
          )}
          {jobs.length > 0 ? (
            <ul style={sagaListStyle}>
              {jobs.map((job, i) => (
                <li key={`${job.stage}-${i}`}>
                  {job.stage}: {job.status}
                  {job.detail ? ` — ${job.detail}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            phase === "polling" && (
              <p style={sagaListStyle}>Waiting for the first stage row…</p>
            )
          )}
          {instanceStatus && (
            <p style={sagaMutedTightStyle}>Instance: {instanceStatus}</p>
          )}
          {phase === "polling" && (
            <p style={sagaListStyle}>
              Following this run (refreshes every 30 seconds)…{" "}
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  clearSagaTracking();
                  setPhase("stopped");
                }}
              >
                Stop following
              </Button>
            </p>
          )}
          {phase === "gate" && (
            <p style={sagaListStyle}>
              Gate reached — decide with the pending journey card above
              (panel, chat, or Slack). First answer wins.
            </p>
          )}
          {phase === "done" && (
            <p style={sagaListStyle}>
              Saga ended{outcomeCode ? `: ${outcomeCode}` : "."}
            </p>
          )}
          {phase === "stopped" && (
            <p style={sagaListStyle}>
              Not following — reopen via the status link above.
            </p>
          )}
          {phase === "error" && progressError && (
            <div className="options-error" role="alert">
              {progressError}
            </div>
          )}
        </div>
      )}
    </div>
  );
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

      <SagaStartSection userLogin={userLogin} />

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
