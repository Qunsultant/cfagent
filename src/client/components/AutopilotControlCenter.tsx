import React, { useState, useEffect, useCallback } from "react";
import { AGENT_DIDS } from "../../agents/did";
import { navigateToTab, parseViewFromSearch, subscribeToRouteChanges } from "../router";
import { nextTableSort, sortTableRows, tableSortAria, type TableSort } from "../tableSort";
import { EmptyState, Table, Tabs, TabPanel, Badge, Button, Card, DetailCard, Flex, Grid, KpiRibbon, PillGroup, TextInput, Select, Notice, PageSection, PageTemplate, Stack, type BadgeTone, Modal, useToast } from "./ui";
import { BRAND } from "../branding";
import { normalizeAutopilotLimits, type AutopilotPolicyLimits } from "../../services/riskPolicyEngine";
import type { TradeRecord } from "../../types";
import { csrfHeaders } from "../apiFetch";

/**
 * Limits are defined by the policy engine — the single source of truth shared
 * with the server, so the limit the UI shows is the limit that is enforced.
 */
export type { AutopilotPolicyLimits } from "../../services/riskPolicyEngine";

export interface AutonomousActionItem {
  id: string;
  timestamp: string;
  actionType: "order" | "policy_check" | "risk_guardrail" | "rebalance";
  symbol: string;
  summary: string;
  policyCheckRule: string;
  policyCheckPassed: boolean;
  status: "executed" | "routed_to_approval" | "verified" | "blocked";
  didAttestation: {
    did: string;
    signature: string;
  };
  source?: "live" | "simulated";
}

/** Issue #1333: one job-outcome row from GET /autopilot/jobs. */
export interface JobOutcomeFeedItem {
  id: string;
  kind: "stock" | "options" | "goal" | "discovery" | "corpus" | "reports" | "feed";
  trigger: "manual" | "scheduled";
  status: "completed" | "failed" | "partial";
  scanned: number | null;
  matched: number | null;
  codedError: string | null;
  reportUrl: string | null;
  pdfKey: string | null;
  xlsxKey: string | null;
  csvKey: string | null;
  deliveryStates: Record<string, string>;
  origin: string;
  createdAt: string;
}

export const JOB_OUTCOME_KIND_LABELS: Record<JobOutcomeFeedItem["kind"], string> = {
  stock: "Stock",
  options: "Options",
  goal: "Goal Screen",
  discovery: "Discovery",
  // Issue #3527 S5 — the two registered tick jobs' run rows.
  corpus: "Corpus Sync",
  reports: "Reports Index",
  // Issue #3530 slice B — feed runs recorded at settle on the
  // pipeline host: a row exists only for a run that actually ran.
  feed: "Feed Jobs",
};

export const JOB_OUTCOME_STATUS_TONES: Record<JobOutcomeFeedItem["status"], BadgeTone> = {
  completed: "success",
  failed: "danger",
  partial: "warning",
};

export interface AuditLogRawEvent {
  id: string;
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  created_at: string;
}


/** A recorded policy verdict row as served by GET /autopilot (`recentVerdicts`). */
export interface PolicyVerdictRecord {
  id?: string;
  symbol?: string;
  action?: string;
  quantity?: number;
  notional?: number | null;
  mode?: string;
  dry_run?: number | boolean;
  passed?: number | boolean;
  execution_allowed?: number | boolean;
  requires_approval?: number | boolean;
  binding_rule?: string | null;
  detail?: string | null;
  signature?: string | null;
  proposer_did?: string | null;
  authorizer_did?: string | null;
  created_at?: string;
}

/** View model for one row of the Policy decisions audit table (issue #651). */
export interface PolicyVerdictRow {
  id: string;
  timeLabel: string;
  intentLabel: string;
  notionalLabel: string;
  outcome: "allowed" | "approval_required" | "blocked";
  outcomeLabel: string;
  outcomeTone: BadgeTone;
  ruleLabel: string;
  detail: string;
  modeLabel: string;
  signed: boolean;
}

function verdictFlag(value: number | boolean | undefined): boolean {
  return value === true || value === 1;
}

/**
 * The one canonical Autopilot timestamp format (#4407): date + time
 * (the #3825 precedent). Anything that cannot be parsed renders as
 * Unparseable or missing values render as "—" — a raw stored string must never
 * reach the page, which is how two rows in the same table ended up in different
 * formats. (No log line here by design: the console-migration ratchet
 * #3515 pins this file at 1 unstructured console.* use and there is no
 * sanctioned client-side logger; the stored value stays queryable server-side
 * in mas_policy_verdicts.)
 */
export function formatAutopilotTimestamp(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return d.toLocaleString("en-US", { hour12: true });
}

/**
 * Maps a recorded verdict (mas_policy_verdicts, via GET /autopilot) to an
 * audit-table row. Outcome precedence mirrors the engine: a verdict that may
 * execute now is Allowed; one held for human approval is Approval required;
 * anything else was Blocked by its binding rule.
 */
export function mapPolicyVerdictToRow(v: PolicyVerdictRecord): PolicyVerdictRow {
  const allowed = verdictFlag(v.execution_allowed);
  const approval = verdictFlag(v.requires_approval);
  const outcome = allowed ? "allowed" : approval ? "approval_required" : "blocked";
  // #4407: one canonical format; an unparseable stored timestamp
  // renders as "—", never as the raw stored string.
  const timeLabel = formatAutopilotTimestamp(v.created_at);
  const symbol = String(v.symbol ?? "").toUpperCase();
  const intentParts = [v.action, v.quantity, symbol].filter(
    (part) => part !== undefined && part !== null && part !== ""
  );
  const notionalLabel =
    typeof v.notional === "number" && Number.isFinite(v.notional)
      ? `$${v.notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
      : "—";
  return {
    id: String(v.id ?? `${v.created_at ?? ""}-${symbol}`),
    timeLabel,
    intentLabel: intentParts.length > 0 ? intentParts.join(" ") : "—",
    notionalLabel,
    outcome,
    outcomeLabel:
      outcome === "allowed" ? "Allowed" : outcome === "approval_required" ? "Approval required" : "Blocked",
    outcomeTone: outcome === "allowed" ? "success" : outcome === "approval_required" ? "warning" : "danger",
    ruleLabel: v.binding_rule ? String(v.binding_rule) : "—",
    detail: v.detail ? String(v.detail) : "",
    modeLabel: [v.mode, verdictFlag(v.dry_run) ? "dry run" : null].filter(Boolean).join(" · "),
    signed: Boolean(v.signature),
  };
}

/**
 * Provenance of an order reference (#2389). References minted locally
 * by the old fabricated execution paths are identifiable by prefix —
 * a row carrying one was never placed with a broker and must render
 * as simulated, never live. Any other non-empty reference came from a
 * broker placement response. No reference means the provenance is
 * unknown, and the row renders with no badge rather than a claim.
 */
const FABRICATED_ORDER_REF_PREFIXES = ["et_ref_", "et_sim_", "alp_ref_", "alp_exec_"];

export function orderRefProvenance(ref: unknown): "live" | "simulated" | undefined {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (!value) return undefined;
  return FABRICATED_ORDER_REF_PREFIXES.some((prefix) => value.startsWith(prefix)) ? "simulated" : "live";
}

/**
 * Maps a backend SQLite WAL audit event (mas_events) to an autonomous action row.
 */
export function mapAuditLogToAutonomousAction(e: AuditLogRawEvent): AutonomousActionItem {
  const payload = (e.payload && typeof e.payload === "object") ? e.payload : {};
  let actionType: AutonomousActionItem["actionType"] = "policy_check";
  const typeLower = (e.type || "").toLowerCase();

  if (typeLower.includes("order") || typeLower.includes("trade") || typeLower.includes("alpaca.order")) {
    actionType = "order";
  } else if (
    typeLower.includes("risk") ||
    typeLower.includes("guardrail") ||
    typeLower.includes("drawdown") ||
    typeLower.includes("reserve")
  ) {
    actionType = "risk_guardrail";
  } else if (typeLower.includes("rebalance") || typeLower.includes("allocation")) {
    actionType = "rebalance";
  } else {
    actionType = "policy_check";
  }

  // Symbol resolution
  const symbol = String(
    payload.symbol ||
    payload.ticker ||
    (actionType === "risk_guardrail" ? "PORTFOLIO" : e.agent === "judge" ? "PORTFOLIO" : "SPY/QQQ")
  ).toUpperCase();

  // Summary generation
  let summary = "";
  if (payload.summary && typeof payload.summary === "string") {
    summary = payload.summary;
  } else if (typeLower === "alpaca.order_placed") {
    summary = `Alpaca ${payload.side || "order"} ${payload.qty || ""} shares @ ${payload.status || "placed"}`;
  } else if (typeLower === "etrade.order_executed") {
    summary = `E*TRADE Executed: ${payload.action || payload.orderAction || "Order"} ${payload.quantity || ""} ${symbol}`;
  } else if (typeLower === "etrade.order_previewed") {
    summary = `E*TRADE Previewed: ${payload.action || payload.orderAction || "Order"} ${payload.quantity || ""} ${symbol}`;
  } else if (typeLower === "route.decided") {
    summary = `Route Decided: Routed to ${payload.targetAgent || payload.agent || "specialist"}`;
  } else if (typeLower === "response.evaluated") {
    summary = `Judge Response Evaluation (Score: ${payload.qualityScore ?? "Pass"})`;
  } else if (typeLower === "etrade.screened") {
    summary = `Market Screener (${payload.count ?? 0} matches screened)`;
  } else {
    summary = `${e.type.replace(/[._]/g, " ")} (${e.agent})`;
  }

  // Policy check rule
  const policyCheckRule = String(
    payload.policyCheckRule ||
    payload.rule ||
    (actionType === "order"
      ? "Deterministic Risk Engine & Position Limit Check"
      : actionType === "risk_guardrail"
      ? "Institutional Drawdown & Reserve Guardrail"
      : "Autonomous Multi-Agent DID Verification")
  );

  // Policy check passed
  const policyCheckPassed =
    !typeLower.includes("blocked") &&
    !typeLower.includes("failed") &&
    !typeLower.includes("rejected") &&
    payload.policyCheckPassed !== false;

  // Status
  let status: AutonomousActionItem["status"] = "verified";
  if (typeLower.includes("executed") || typeLower.includes("order_placed") || payload.status === "executed") {
    status = "executed";
  } else if (
    typeLower.includes("blocked") ||
    typeLower.includes("failed") ||
    typeLower.includes("rejected") ||
    payload.status === "blocked"
  ) {
    status = "blocked";
  } else if (
    typeLower.includes("preview") ||
    payload.status === "routed_to_approval" ||
    payload.status === "previewed"
  ) {
    status = "routed_to_approval";
  }

  // DID Attestation
  const did = String(
    payload.proposerDid ||
    payload.did ||
    (e.agent === "judge" ? AGENT_DIDS.JUDGE : e.agent === "trading" ? AGENT_DIDS.TRADING : AGENT_DIDS.ORCHESTRATOR)
  );

  // No fabricated fallback (autopilot Phase 1): an unsigned ledger row must
  // read as unsigned, or the ledger cannot be trusted as evidence.
  const signature = String(payload.proofSignature || payload.signature || "");

  // Formatted timestamp — #4407: the one canonical date+time format.
  const timestamp = formatAutopilotTimestamp(e.created_at);

  return {
    id: e.id,
    timestamp,
    actionType,
    symbol,
    summary,
    policyCheckRule,
    policyCheckPassed,
    status,
    didAttestation: {
      did,
      signature,
    },
    // #2389: provenance derives from the execution reference the
    // event actually recorded — never a hardcoded "live".
    source: orderRefProvenance(payload.executionId || payload.brokerOrderRef || payload.orderRef),
  };
}

/**
 * Maps an E*TRADE persistent trade record (mas_trades) to an autonomous action row.
 */
export function mapTradeRecordToAutonomousAction(t: TradeRecord): AutonomousActionItem {
  let status: AutonomousActionItem["status"] = "verified";
  if (t.status === "executed" || t.status === "submitted") {
    status = "executed";
  } else if (t.status === "rejected" || t.status === "cancelled" || t.status === "expired") {
    status = "blocked";
  } else if (t.status === "previewed" || t.status === "draft") {
    status = "routed_to_approval";
  }

  // #4407: the one canonical date+time format.
  const timestamp = formatAutopilotTimestamp(t.createdAt);

  const priceStr = t.price ? `$${Number(t.price).toFixed(2)}` : "MKT";

  return {
    id: t.id,
    timestamp,
    actionType: "order",
    symbol: t.symbol,
    summary: `${t.action} ${t.quantity} shares @ ${priceStr} (${t.orderType || "ORDER"})`,
    policyCheckRule: t.previewNotes || "Position size ≤ Risk Engine Policy Threshold",
    policyCheckPassed: t.status !== "rejected",
    status,
    didAttestation: {
      did: t.proposerDid || AGENT_DIDS.TRADING,
      // No fabricated fallback (same principle as the ledger mapper
      // above): an unsigned trade record reads as unsigned. This used
      // to synthesize a sig_ed25519_ signature from the record id.
      signature: t.proofSignature || "",
    },
    // #2389: provenance derives from the record's broker reference —
    // a locally-minted reference renders simulated, a broker-issued
    // reference renders live, and no reference renders no claim.
    source: orderRefProvenance(t.orderRef),
  };
}

export interface AutopilotControlCenterProps {
  user?: { login: string; name?: string; avatar?: string };
  isLiveAccount?: boolean;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onNavigateOrder?: (symbol: string) => void;
}

/** Engine defaults (autopilot Phase 1) — never re-declared here. */
const DEFAULT_LIMITS: AutopilotPolicyLimits = normalizeAutopilotLimits(null);

const ACTION_TYPE_TONES: Record<string, BadgeTone> = {
  order: "info",
  policy_check: "success",
  risk_guardrail: "warning",
  rebalance: "purple",
};

/** Issue #3050 PR2: the risk-profile value keeps its profile color as a
 * token text tone (no bespoke risk-badge class). */
const RISK_PROFILE_TONE_CLASS: Record<string, string> = {
  conservative: "ui-success",
  moderate: "ui-warning",
  aggressive: "ui-danger",
};

const ACTION_STATUS_TONES: Record<string, BadgeTone> = {
  executed: "success",
  routed_to_approval: "warning",
  verified: "info",
  blocked: "danger",
};

/**
 * Issue #4409 — the Autopilot page's sections as sub-tabs. The KPI
 * ribbon stays the persistent `kpiRibbon` slot (page chrome, not
 * content): the seven #3140 blocks are six sub-tabs plus the slot.
 * The tab label is the short name; the panel keeps the full section
 * title (the chart's tab reads "Performance" while its panel keeps
 * "Strategy Equity vs S&P 500 Benchmark"). `view` is the shared
 * sub-view param (the #4168 pattern, extended from one addressable
 * target to six); an unknown or missing view falls back to the first
 * tab. Filters (`actionsFilter`, `chartTimeframe`) stay filters
 * inside their sub-tab — #4369 stands.
 */
export const AUTOPILOT_SUB_TABS = [
  { id: "performance", label: "Performance", title: "Strategy Equity vs S&P 500 Benchmark" },
  { id: "status", label: "Autopilot Status", title: "Autopilot Status" },
  { id: "limits", label: "Live policy limits", title: "Live policy limits" },
  { id: "job-outcomes", label: "Job outcomes", title: "Job outcomes" },
  { id: "actions", label: "Recent autonomous actions", title: "Recent autonomous actions" },
  { id: "policy-decisions", label: "Policy decisions", title: "Policy decisions" },
] as const;

export type AutopilotSubTabId = (typeof AUTOPILOT_SUB_TABS)[number]["id"];

const AUTOPILOT_VIEW_IDS = AUTOPILOT_SUB_TABS.map((t) => t.id);

function isAutopilotView(value: unknown): value is AutopilotSubTabId {
  return typeof value === "string" && (AUTOPILOT_VIEW_IDS as readonly string[]).includes(value);
}

/** The active sub-tab from the URL, defaulting to the first tab. */
function readAutopilotViewFromUrl(): AutopilotSubTabId {
  if (typeof window === "undefined") return "performance";
  return (
    (parseViewFromSearch(window.location.search, isAutopilotView) as AutopilotSubTabId | null) ??
    "performance"
  );
}

/**
 * Issue #4409 — the six source lines, each a single line (the
 * `.ui-single-line` treatment: nowrap + ellipsis, full text on
 * hover). One constant each so the rendered text and the title=
 * attribute can never drift apart. The jobs/actions/verdicts texts
 * are the exact texts the issue specifies.
 */
export const AUTOPILOT_SOURCE_LINES = {
  ribbon:
    "Source: GET /api/autopilot — verdict count from mas_policy_verdicts. NAV and drawdown have no live source — shown as —.",
  status:
    "Source: GET /api/autopilot — OrchestratorAgent state (run state, kill switch, limits, verdicts).",
  limits:
    "Source: GET /api/autopilot — OrchestratorAgent state; localStorage defaults only when the server has none.",
  jobs: "Source: GET /api/autopilot/jobs — mas_job_outcomes (one outcome sink); rows labeled by origin.",
  actions:
    "Source: GET /api/audit (mas_events) + /api/broker/orders (mas_trades). Simulated rows are labeled Sim, never live.",
  verdicts:
    "Source: GET /api/autopilot — mas_policy_verdicts, signed by RiskPolicyEngine. Dry-run verdicts are labeled simulated. Scheduled dry-run checks come from the monthly Autopilot evaluation schedule (Schedules home).",
} as const;

/**
 * Sortable column header (#4409): the #2213 button treatment (ghost
 * button, direction indicator, stable "Sort by" aria-label — the
 * column's aria-sort carries the direction) over the shared
 * `tableSort.ts` state (#4389). A click orders the rows; a second
 * click reverses them.
 */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: string;
  sort: TableSort<string> | null;
  onSort: (key: string) => void;
}) {
  const active = sort?.key === sortKey;
  const direction = sort?.direction === "asc" ? "ascending" : "descending";
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`ui-table-sort${active ? " active" : ""}`}
      onClick={() => onSort(sortKey)}
      title={active ? `Sorted ${direction} — click to reverse` : `Sort by ${label}`}
      aria-label={`Sort by ${label}`}
    >
      <span>{label}</span>
      <span className="ui-table-sort-indicator" aria-hidden="true">
        {active ? (sort?.direction === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </Button>
  );
}

/** Epoch ms for a canonical Autopilot timestamp — null when the stored
 * value is missing or unparseable, so empty sorts last either way. */
function autopilotTimestampEpoch(value: string): number | null {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** The notional number behind a verdict row's "$1,234.56" label. */
function verdictNotionalValue(row: PolicyVerdictRow): number | null {
  if (row.notionalLabel === "—") return null;
  const n = Number(row.notionalLabel.replace(/[^0-9.]/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** Sort values per table (#4409): every column sorts, through the
 * shared `sortTableRows` — empties last in both directions. */
function jobSortValue(job: JobOutcomeFeedItem, key: string): string | number | null {
  switch (key) {
    case "time":
      return autopilotTimestampEpoch(job.createdAt);
    case "job":
      return JOB_OUTCOME_KIND_LABELS[job.kind] ?? job.kind;
    case "outcome":
      return job.status;
    case "detail":
      return job.codedError ?? job.origin;
    default:
      return null;
  }
}

function actionSortValue(action: AutonomousActionItem, key: string): string | number | null {
  switch (key) {
    case "time":
      return autopilotTimestampEpoch(action.timestamp);
    case "action":
      return action.summary;
    case "asset":
      return action.symbol;
    case "policy":
      return action.policyCheckRule;
    case "status":
      return action.status;
    case "attestation":
      return action.didAttestation.signature || null;
    default:
      return null;
  }
}

function verdictSortValue(row: PolicyVerdictRow, key: string): string | number | null {
  switch (key) {
    case "time":
      return autopilotTimestampEpoch(row.timeLabel);
    case "intent":
      return row.intentLabel;
    case "notional":
      return verdictNotionalValue(row);
    case "outcome":
      return row.outcomeLabel;
    case "rule":
      return row.ruleLabel;
    case "detail":
      return row.detail || null;
    default:
      return null;
  }
}

export function AutopilotControlCenter({
  user,
  isLiveAccount = false,
  onSendPrompt,
  onNavigateOrder,
}: AutopilotControlCenterProps) {
  const toast = useToast();
  // Autopilot Running / Paused status
  const [isRunning, setIsRunning] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("nextgen_autopilot_running");
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  // Live Policy Limits
  const [policyLimits, setPolicyLimits] = useState<AutopilotPolicyLimits>(() => {
    try {
      const stored = localStorage.getItem("nextgen_autopilot_limits");
      if (stored) return JSON.parse(stored);
    } catch {}
    return DEFAULT_LIMITS;
  });

  // Modal for editing policy limits
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editLimitsDraft, setEditLimitsDraft] = useState<AutopilotPolicyLimits>(policyLimits);

  // Autonomous actions table state
  const [actionsFilter, setActionsFilter] = useState<"all" | "order" | "policy_check" | "risk_guardrail">("all");
  // Issue #1333: no seeded actions. A fresh browser shows an empty
  // live view; fabricated rows render only from an explicit policy
  // simulation, badged Sim. Persisted local actions still hydrate.
  const [actions, setActions] = useState<AutonomousActionItem[]>(() => {
    try {
      const stored = localStorage.getItem("nextgen_autopilot_actions");
      if (stored) return JSON.parse(stored);
    } catch {}
    return [];
  });

  const [recentVerdicts, setRecentVerdicts] = useState<PolicyVerdictRecord[]>([]);
  const [copiedDidId, setCopiedDidId] = useState<string | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [killSwitchModalOpen, setKillSwitchModalOpen] = useState(false);
  const [isKillSwitched, setIsKillSwitched] = useState(false);
  const [isServerBacked, setIsServerBacked] = useState(false);
  // Issue #1704 (A3-b): user-visible failure messages for the three
  // server-confirmed actions below. A failed action never changes
  // displayed state and never closes the dialog it started in.
  const [actionError, setActionError] = useState<string | null>(null);
  const [killSwitchError, setKillSwitchError] = useState<string | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [isLoadingLive, setIsLoadingLive] = useState(false);
  const [isLiveFeed, setIsLiveFeed] = useState(false);

  // Issue #1333: the job-outcome sink as the job feed — every job
  // producer's success/failure, labeled by origin.
  const [jobOutcomes, setJobOutcomes] = useState<JobOutcomeFeedItem[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);

  // Issue #4409: the active sub-tab, driven by the shared `view` URL
  // param (the #4168 pattern). The URL is the single source of truth:
  // a tab click navigates (pushState + routechange) and the
  // subscription below applies it; back/forward lands here the same
  // way. Unknown or missing views fall back to the first tab.
  const [activeView, setActiveView] = useState<AutopilotSubTabId>(() => readAutopilotViewFromUrl());

  // One sort state per table (#4409, tableSort.ts): null keeps the
  // fetch order; a header click orders the rows, a second reverses.
  const [jobsSort, setJobsSort] = useState<TableSort<string> | null>(null);
  const [actionsSort, setActionsSort] = useState<TableSort<string> | null>(null);
  const [verdictsSort, setVerdictsSort] = useState<TableSort<string> | null>(null);

  // Sync isRunning to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("nextgen_autopilot_running", String(isRunning));
    } catch {}
  }, [isRunning]);

  // Sync policyLimits to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("nextgen_autopilot_limits", JSON.stringify(policyLimits));
    } catch {}
  }, [policyLimits]);

  // Sync actions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("nextgen_autopilot_actions", JSON.stringify(actions));
    } catch {}
  }, [actions]);

  // Fetch live autonomous events from the audit ledger and the platform's stored
  // draft ledger. Issue #3368: `/api/broker/orders` is the same table the
  // E*TRADE route reads, with the same shape — the broker-neutral name is the
  // honest one, and it is what a non-E*TRADE tenant should be calling.
  const fetchLiveAutonomousActions = useCallback(async (_isManualRefresh = false) => {
    setIsLoadingLive(true);
    try {
      const [auditRes, ordersRes] = await Promise.allSettled([
        fetch("/api/audit?limit=50"),
        fetch("/api/broker/orders"),
      ]);

      const liveItems: AutonomousActionItem[] = [];

      // 1. Process E*TRADE / mas_trades orders
      if (ordersRes.status === "fulfilled" && ordersRes.value.ok) {
        const data = (await ordersRes.value.json().catch(() => null)) as any;
        const trades: TradeRecord[] = Array.isArray(data?.trades)
          ? data.trades
          : Array.isArray(data?.orders)
          ? data.orders
          : [];

        for (const t of trades) {
          liveItems.push(mapTradeRecordToAutonomousAction(t));
        }
      }

      // 2. Process Durable Object mas_events audit log
      if (auditRes.status === "fulfilled" && auditRes.value.ok) {
        const data = (await auditRes.value.json().catch(() => null)) as any;
        const events: AuditLogRawEvent[] = Array.isArray(data?.events) ? data.events : [];

        for (const e of events) {
          liveItems.push(mapAuditLogToAutonomousAction(e));
        }
      }

      if (liveItems.length > 0) {
        setIsLiveFeed(true);
        setActions((prev) => {
          // Keep simulated/local actions that are not yet in backend
          const liveIds = new Set(liveItems.map((i) => i.id));
          const localOnly = prev.filter((p) => !liveIds.has(p.id) && p.source === "simulated");
          return [...liveItems, ...localOnly].slice(0, 50);
        });
      } else {
        setIsLiveFeed(false);
      }
    } catch {
      setIsLiveFeed(false);
    } finally {
      setIsLoadingLive(false);
    }
  }, []);

  // Issue #1333: the job-outcome sink (GET /autopilot/jobs). Never
  // throws into the feed: an empty list reads as "no outcomes yet",
  // never as a broken panel.
  const fetchJobOutcomes = useCallback(async () => {
    setIsLoadingJobs(true);
    try {
      const res = await fetch("/api/autopilot/jobs?limit=50");
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as any;
        if (Array.isArray(data?.jobs)) setJobOutcomes(data.jobs);
      }
    } catch {
      // Sink unavailable — the feed stays at its last good state.
    } finally {
      setIsLoadingJobs(false);
    }
  }, []);

  // Server-owned autopilot state (autopilot Phase 1): the Durable Object is the
  // source of truth for run state, limits, and the kill switch — not this tab.
  // The same payload carries the recorded policy verdicts audited below (#651).
  const fetchAutopilotState = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      if (!data || typeof data !== "object") return;
      setIsServerBacked(true);
      if (typeof data.running === "boolean") setIsRunning(data.running);
      if (typeof data.killSwitch === "boolean") setIsKillSwitched(data.killSwitch);
      if (data.limits) {
        const normalized = normalizeAutopilotLimits(data.limits);
        setPolicyLimits(normalized);
        setEditLimitsDraft(normalized);
      }
      if (Array.isArray(data.recentVerdicts)) {
        setRecentVerdicts(data.recentVerdicts as PolicyVerdictRecord[]);
      }
    } catch {
      setIsServerBacked(false);
    }
  }, []);

  useEffect(() => {
    void fetchAutopilotState();
  }, [fetchAutopilotState]);

  // Initial fetch and global refresh listener
  useEffect(() => {
    fetchLiveAutonomousActions();
    void fetchJobOutcomes();

    const handleGlobalRefresh = () => {
      fetchLiveAutonomousActions(true);
      void fetchJobOutcomes();
      void fetchAutopilotState();
    };
    // #2283 stream 3: the top-bar Refresh dispatches "app-refresh"
    // (Chat.tsx) and only OptionsResearch/StrategyDiscovery listened.
    // Autopilot listened to "nextgen:refresh-all", which nothing in the
    // client ever dispatched — its global refresh was a no-op. It now
    // listens to the one live broadcast.
    window.addEventListener("app-refresh", handleGlobalRefresh);
    return () => {
      window.removeEventListener("app-refresh", handleGlobalRefresh);
    };
  }, [fetchLiveAutonomousActions, fetchJobOutcomes, fetchAutopilotState]);

  // Issue #4409: adopt the `view` param on mount and on every route
  // change (nav clicks pushState while this shell-retained panel stays
  // mounted; back/forward dispatches popstate). This replaces the
  // #4168 scroll adoption — the tab selection IS the navigation now,
  // so there is nothing to scroll to. `view` is the shared sub-view
  // param — no TAB_PARAM_OWNERS entry needed. Filters (actionsFilter)
  // are NOT views and get no URL.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const adoptFromUrl = () => {
      setActiveView(readAutopilotViewFromUrl());
    };
    adoptFromUrl();
    return subscribeToRouteChanges(adoptFromUrl);
  }, []);

  const handleToggleAutopilot = async () => {
    if (isKillSwitched) {
      toast.warning("Platform kill switch is active. Clear the kill switch before resuming Autopilot.");
      return;
    }
    const next = !isRunning;
    setActionError(null);
    try {
      const res = await fetch("/api/autopilot/state", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ running: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Issue #1704 (A3-b): displayed state changes ONLY on server
      // confirmation. The old code set the new state first and, on
      // failure, left it in place with a console warning — the UI
      // showed a running state the server never confirmed, and the
      // localStorage sync then persisted that unconfirmed state.
      setIsRunning(next);
      setIsServerBacked(true);
    } catch {
      setIsServerBacked(false);
      setActionError(
        next
          ? "Autopilot could not be resumed — it is still paused."
          : "Autopilot could not be paused — it is still running."
      );
    }
  };

  const handleSaveLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeAutopilotLimits(editLimitsDraft);
    setLimitsError(null);
    try {
      const res = await fetch("/api/autopilot/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ limits: normalized }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json().catch(() => null)) as any;
      // Issue #1704 (A3-b): same confirmation gate as the toggle — the
      // old code applied the limits and closed the dialog before the
      // PUT, so a failed save showed limits that were never stored.
      // On failure the dialog stays open with the draft intact.
      const confirmed = data?.limits ? normalizeAutopilotLimits(data.limits) : normalized;
      setPolicyLimits(confirmed);
      setEditLimitsDraft(confirmed);
      setIsServerBacked(true);
      setIsEditModalOpen(false);
      toast.success("Policy limits saved.");
    } catch {
      setIsServerBacked(false);
      setLimitsError("Policy limits could not be saved — the previous limits still apply.");
    }
  };

  const handleResetLimits = () => {
    setEditLimitsDraft(DEFAULT_LIMITS);
  };

  const handleCopyDid = (id: string, text: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedDidId(id);
      setTimeout(() => setCopiedDidId(null), 1500);
    }
  };

  // Server-side policy check (autopilot Phase 1). RiskPolicyEngine decides the
  // verdict inside the Durable Object, signs it there, and writes it to the
  // ledger; the browser no longer decides whether policy passed.
  const handleSimulateAutonomousAction = async () => {
    setIsSimulating(true);
    try {
      const intents = {
        symbol: (policyLimits.universeSymbols?.[0] || "SPY").toUpperCase(),
        action: "BUY",
        quantity: 10,
        orderType: "MARKET",
        dryRun: true,
        requestedBy: user?.login || "autopilot_trader",
      };
      const res = await fetch("/api/autopilot/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify(intents),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { verdict?: any; attestation?: any };
      const verdict = data?.verdict;
      if (!verdict) throw new Error("Malformed policy response");

      setIsServerBacked(true);
      const positionPct = verdict.projections?.positionPctOfNav;
      const newAction: AutonomousActionItem = {
        id: String(verdict.verdictId || `act-${Date.now()}`),
        timestamp: formatAutopilotTimestamp(verdict.evaluatedAt || Date.now()),
        actionType: "policy_check",
        symbol: String(verdict.intents?.symbol || intents.symbol),
        summary: `Policy check (${verdict.dryRun ? "dry run" : "live"}) — ${verdict.intents?.action || intents.action} ${
          verdict.intents?.quantity ?? intents.quantity
        } ${verdict.intents?.symbol || intents.symbol}`,
        policyCheckRule: verdict.bindingRule
          ? `Blocked: ${verdict.bindingRule}`
          : `Max position (${typeof positionPct === "number" ? positionPct.toFixed(2) : "—"}%) ≤ ${Number(
              verdict.limits?.maxPositionPct ?? policyLimits.maxPositionPct
            ).toFixed(2)}%`,
        policyCheckPassed: Boolean(verdict.passed),
        status: !verdict.passed ? "blocked" : verdict.requiresApproval ? "routed_to_approval" : "verified",
        didAttestation: {
          did: String(data?.attestation?.proposerDid || AGENT_DIDS.TRADING),
          signature: String(data?.attestation?.signature || ""),
        },
        // #2389: this surface only ever requests dry-run evaluations —
        // label the row for what the verdict says it was.
        source: verdict.dryRun ? "simulated" : "live",
      };

      setActions((prev) => [newAction, ...prev.filter((p) => p.id !== newAction.id).slice(0, 49)]);
      void fetchAutopilotState();
    } catch (err) {
      console.warn("[Autopilot] Policy check failed:", err);
      setIsServerBacked(false);
      toast.danger("Policy check failed: the policy engine did not answer, so no verdict was recorded.");
    } finally {
      setIsSimulating(false);
    }
  };

  const verdictRows = recentVerdicts.map(mapPolicyVerdictToRow);
  // #4407: the signed share is computed from the recorded verdicts —
  // never a hardcoded claim.
  const signedVerdictCount = verdictRows.filter((r) => r.signed).length;

  const filteredActions = actions.filter((act) => {
    if (actionsFilter === "all") return true;
    return act.actionType === actionsFilter;
  });

  // Sorted rows (#4409): the sort applies after the filter, so a
  // filtered table still sorts its visible rows.
  const sortedJobOutcomes = sortTableRows(jobOutcomes, jobsSort, jobSortValue);
  const sortedActions = sortTableRows(filteredActions, actionsSort, actionSortValue);
  const sortedVerdictRows = sortTableRows(verdictRows, verdictsSort, verdictSortValue);

  const handleJobsSort = (key: string) => setJobsSort((current) => nextTableSort(current, key));
  const handleActionsSort = (key: string) => setActionsSort((current) => nextTableSort(current, key));
  const handleVerdictsSort = (key: string) => setVerdictsSort((current) => nextTableSort(current, key));

  const accountLabel = isLiveAccount ? "E*TRADE Live Brokerage" : "Paper (simulated money)";

  return (
    <PageTemplate
      title="Autopilot control center"
      scopeNote={`Autonomous execution within your written policy, on the account selected at the top: ${accountLabel}.`}
      kpiRibbon={
        <>
          {/* Executive Performance Ribbon — #4407: every figure here is
              live or "—". Portfolio NAV and drawdown have no live source
              on this page (GET /api/autopilot carries no balance; there
              is no equity-history source), so they render as "—" rather
              than a generated number. */}
          <span className="ui-meta-sm ui-single-line" title={AUTOPILOT_SOURCE_LINES.ribbon}>{AUTOPILOT_SOURCE_LINES.ribbon}</span>
          <KpiRibbon
            items={[
              { label: "Portfolio NAV", value: "—", sub: "No live NAV source" },
              {
                label: "Drawdown vs Alert",
                value: "—",
                sub: `Policy Alert: ${policyLimits.drawdownAlertPct.toFixed(2)}% Max`,
              },
              {
                label: "Cash Reserve Target",
                value: `${policyLimits.cashReservePct.toFixed(2)}%`,
                sub: "✓ Protected Capital Floor",
                subTone: "success",
              },
              {
                label: "Risk Policy Engine",
                value: `${verdictRows.length} Verdicts`,
                sub:
                  verdictRows.length > 0
                    ? `${signedVerdictCount} of ${verdictRows.length} DID-signed`
                    : "No verdicts recorded",
              },
            ]}
          />
        </>
      }
    >

      {/* Issue #4409: the sections are sub-tabs now, driven by the
          shared `view` param — the tab row is the page's navigation,
          and each panel renders only its own section (an inactive
          TabPanel renders nothing). The KPI ribbon above is the
          persistent slot; it is not a tab. */}
      <Tabs
        tabs={AUTOPILOT_SUB_TABS.map((t) => ({ id: t.id, label: t.label }))}
        value={activeView}
        onChange={(view) => navigateToTab("autopilot", view)}
        ariaLabel="Autopilot sections"
        idBase="autopilot-sections"
      />

      <TabPanel idBase="autopilot-sections" tabId="performance" active={activeView === "performance"}>
      {/* Strategy performance — #4407: no live equity-history source
          feeds this chart, so it renders an empty state rather than a
          generated curve. The hardcoded chart constant, the
          timeframe switcher, the hand-drawn benchmark path and the
          hardcoded legend claims are removed. */}
      <PageSection title="Strategy Equity vs S&P 500 Benchmark">
      <DetailCard>
        <EmptyState
          framed
          icon="📈"
          title="No performance history recorded"
          description="No live equity-history source feeds this chart, so no curve is shown rather than a generated one. Performance history arrives when a live equity source is wired."
        />
      </DetailCard>
      </PageSection>
      </TabPanel>

      <TabPanel idBase="autopilot-sections" tabId="status" active={activeView === "status"}>
      <PageSection title="Autopilot Status">
        {/* Autopilot Status Card — #4409: the section finally has its
            name (it lost its title in #3140). */}
        <Card>
          <span className="ui-meta-sm ui-single-line" title={AUTOPILOT_SOURCE_LINES.status}>{AUTOPILOT_SOURCE_LINES.status}</span>
          <Flex gap="1" align="center">
            <span className="ui-meta-sm">Status</span>
            {isKillSwitched && <Badge tone="danger">KILL SWITCH TRIPPED</Badge>}
            {!isServerBacked && (
              <Badge
                tone="danger"
                title="The central orchestration service did not answer; the state shown here is this tab only."
              >
                LOCAL ONLY
              </Badge>
            )}
          </Flex>

          <Stack gap="1">
            <Flex gap="1" align="center">
              <span className={isKillSwitched ? "ui-danger" : isRunning ? "ui-success" : "ui-warning"}>●</span>
              <span>
                {isKillSwitched ? "Locked Out" : isRunning ? "Running" : "Paused"}
              </span>
            </Flex>
            <span className="ui-meta-sm">
              {isRunning && !isKillSwitched
                ? "Autonomous agent actively scanning and executing trades"
                : "New ideas route to human approval queue"}
            </span>
          </Stack>

          <Flex gap="2" align="center" wrap>
            <Button
            variant={isRunning && !isKillSwitched ? "secondary" : "primary"}
              onClick={handleToggleAutopilot}
              aria-label={isRunning ? "Pause Autopilot" : "Resume Autopilot"}
            >
              {isRunning && !isKillSwitched ? "Pause Autopilot" : "Resume Autopilot"}
            </Button>

            <Button
            variant="danger"
              onClick={() => {
                setKillSwitchError(null);
                setKillSwitchModalOpen(true);
              }}
              title="Emergency Platform Kill Switch"
            >
              🛡️ Emergency Kill Switch
            </Button>
          </Flex>

          {actionError && (
            <Notice tone="danger" density="compact" onDismiss={() => setActionError(null)}>
              {actionError}
            </Notice>
          )}
          <p className="ui-meta">
            Pausing sends new ideas to approval instead. The platform kill switch, if triggered by our
            risk team, blocks all new orders.
          </p>
        </Card>
      </PageSection>
      </TabPanel>

      <TabPanel idBase="autopilot-sections" tabId="limits" active={activeView === "limits"}>
      <PageSection>
        {/* Live Policy Limits Card — #4409: the title lives in the
            DetailCard, not the PageSection, so "Edit limits" sits in
            the same CardHeader row as the title it acts on. */}
        <DetailCard
          title="Live policy limits"
          belowSubtitle={<span className="ui-meta-sm ui-single-line" title={AUTOPILOT_SOURCE_LINES.limits}>{AUTOPILOT_SOURCE_LINES.limits}</span>}
          meta={
            <Button
            variant="secondary"
              onClick={() => {
                setEditLimitsDraft(policyLimits);
                setLimitsError(null);
                setIsEditModalOpen(true);
              }}
            >
              ⚙️ Edit limits
            </Button>
          }
        >
          <Grid columns={3} gap="2">
            <Stack gap="1">
              <span className="ui-meta-sm">Max position</span>
              <span><strong>{policyLimits.maxPositionPct.toFixed(2)}%</strong></span>
            </Stack>

            <Stack gap="1">
              <span className="ui-meta-sm">Cash reserve</span>
              <span><strong>{policyLimits.cashReservePct.toFixed(2)}%</strong></span>
            </Stack>

            <Stack gap="1">
              <span className="ui-meta-sm">Orders / day</span>
              <span><strong>{policyLimits.ordersPerDay}</strong></span>
            </Stack>

            <Stack gap="1">
              <span className="ui-meta-sm">Drawdown alert</span>
              <span><strong>{policyLimits.drawdownAlertPct.toFixed(2)}%</strong></span>
            </Stack>

            <Stack gap="1">
              <span className="ui-meta-sm">Universe</span>
              <span title={policyLimits.universe}><strong>{policyLimits.universe}</strong></span>
            </Stack>

            <Stack gap="1">
              <span className="ui-meta-sm">Risk</span>
              <span className={RISK_PROFILE_TONE_CLASS[policyLimits.riskProfile] ?? "ui-warning"}><strong>{policyLimits.riskProfile.charAt(0).toUpperCase() + policyLimits.riskProfile.slice(1)}</strong></span>
            </Stack>
          </Grid>

          <div className="ui-footer-bar">
            <span className="ui-meta-sm">
              ✓ Enforced at runtime by <strong>RiskPolicyEngine</strong> &amp; <strong>W3C Agent DID</strong>
            </span>
          </div>
        </DetailCard>
      </PageSection>
      </TabPanel>

      {/* Job Outcomes (issue #1333): every job's success/failure from
          the one outcome sink, labeled by origin — not the trading
          actions feed above, but the job-truth feed. */}
      <TabPanel idBase="autopilot-sections" tabId="job-outcomes" active={activeView === "job-outcomes"}>
      <PageSection title="Job outcomes">
      <DetailCard
        belowSubtitle={<span className="ui-meta-sm ui-single-line" title={AUTOPILOT_SOURCE_LINES.jobs}>{AUTOPILOT_SOURCE_LINES.jobs}</span>}
      >
        <Flex gap="2" align="center" justify="between" wrap>
          <Flex gap="1" align="center">
            <Badge tone="neutral">{jobOutcomes.length}</Badge>
            <Badge tone="neutral" title="One outcome sink (mas_job_outcomes): stock, options, goal-screen, discovery, corpus-sync, reports-index, and feed runs, manual and scheduled">
              {isLoadingJobs ? "🔄 Syncing…" : "Job-truth feed"}
            </Badge>
          </Flex>
          <Flex gap="1" align="center">
            <Button variant="secondary" size="sm"
              type="button"
              onClick={() => void fetchJobOutcomes()}
              disabled={isLoadingJobs}
              title="Refresh job outcomes from the backend"
             loading={isLoadingJobs}>
              {"↻ Refresh Jobs"}
            </Button>
          </Flex>
        </Flex>

        <Table
          columns={[
            {
              key: "time",
              header: <SortHeader label="DATE & TIME" sortKey="time" sort={jobsSort} onSort={handleJobsSort} />,
              ariaSort: tableSortAria(jobsSort, "time"),
              cellClassName: "time-cell",
              // #4407: one canonical date+time format; an unparseable
              // stored timestamp renders as "—", never raw.
              render: (job) => <>{formatAutopilotTimestamp(job.createdAt)}</>,
            },
            {
              key: "job",
              header: <SortHeader label="JOB" sortKey="job" sort={jobsSort} onSort={handleJobsSort} />,
              ariaSort: tableSortAria(jobsSort, "job"),
              cellClassName: "summary-cell",
              render: (job) => (
                <>
                  <Badge size="xs" uppercase tone="info">
                    {JOB_OUTCOME_KIND_LABELS[job.kind] ?? job.kind}
                  </Badge>
                  <span className="ui-meta-sm">{job.trigger === "scheduled" ? "Scheduled" : "Manual"}</span>
                </>
              ),
            },
            {
              key: "outcome",
              header: <SortHeader label="OUTCOME" sortKey="outcome" sort={jobsSort} onSort={handleJobsSort} />,
              ariaSort: tableSortAria(jobsSort, "outcome"),
              cellClassName: "status-cell ui-cell-nowrap",
              render: (job) => (
                <>
                  <Badge size="xs" tone={JOB_OUTCOME_STATUS_TONES[job.status] ?? "neutral"}>
                    {job.status.toUpperCase()}
                  </Badge>
                  <span className="ui-meta-sm">
                    {job.scanned !== null && job.scanned !== undefined ? `${job.scanned} scanned` : ""}
                    {job.matched !== null && job.matched !== undefined ? ` · ${job.matched} matched` : ""}
                  </span>
                </>
              ),
            },
            {
              key: "detail",
              header: <SortHeader label="DETAIL" sortKey="detail" sort={jobsSort} onSort={handleJobsSort} />,
              ariaSort: tableSortAria(jobsSort, "detail"),
              cellClassName: "summary-cell",
              render: (job) => (
                <>
                  {job.codedError ? (
                    <span className="ui-meta-sm ui-single-line" title={job.codedError}>{job.codedError}</span>
                  ) : job.reportUrl ? (
                    <a href={job.reportUrl} target="_blank" rel="noreferrer">Report</a>
                  ) : (
                    <span className="ui-meta-sm">—</span>
                  )}
                  <Badge size="xs" tone="neutral" title={`Outcome origin: ${job.origin}`}>
                    {job.origin}
                  </Badge>
                </>
              ),
            },
          ]}
          rows={sortedJobOutcomes}
          rowKey={(job) => job.id}
          rowClassName="action-table-row"
          containerClassName="autopilot-table-container ui-scroll-frame"
          stickyHeader
          empty={(
            <EmptyState
              framed
              icon="📋"
              title="No job outcomes recorded"
              description="As screens, goal screens, discovery runs, corpus syncs, and reports-index sweeps complete or fail, their coded outcomes will appear here — one row per job, labeled by origin."
            />
          )}
        />
      </DetailCard>
      </PageSection>
      </TabPanel>

      {/* Bottom Card: Recent Autonomous Actions */}
      <TabPanel idBase="autopilot-sections" tabId="actions" active={activeView === "actions"}>
      <PageSection title="Recent autonomous actions">
      <DetailCard
        belowSubtitle={<span className="ui-meta-sm ui-single-line" title={AUTOPILOT_SOURCE_LINES.actions}>{AUTOPILOT_SOURCE_LINES.actions}</span>}
      >
        <Flex gap="2" align="center" justify="between" wrap>
          <Flex gap="1" align="center">
            <Badge tone="neutral">{filteredActions.length}</Badge>
            <Badge
              tone={isLiveFeed ? "success" : "neutral"}
              title={
                isLiveFeed
                  ? "Connected to live SQLite audit ledger (mas_events & mas_trades)"
                  : "Using cached / local actions"
              }
            >
              {isLoadingLive ? "🔄 Syncing…" : isLiveFeed ? "● Live Audit Ledger" : "Offline / Cache"}
            </Badge>
          </Flex>

          <Flex gap="1" align="center">
            {/* Filter Pills */}
              <PillGroup
                options={[
                  { id: "all", label: "All" },
                  { id: "order", label: "Orders" },
                  { id: "policy_check", label: "Policy Checks" },
                  { id: "risk_guardrail", label: "Risk Guardrails" },
                ]}
                value={actionsFilter}
                onChange={setActionsFilter}
              />

            {/* Refresh Live Data Button */}
            <Button variant="secondary" size="sm"
              type="button"
              onClick={() => fetchLiveAutonomousActions(true)}
              disabled={isLoadingLive}
              title="Refresh autonomous actions and audit trail from backend"
             loading={isLoadingLive}>
              {"↻ Refresh Feed"}
            </Button>

            {/* Test Simulation Button */}
            <Button
            variant="secondary"
            size="sm"
              onClick={handleSimulateAutonomousAction}
              disabled={isSimulating}
              title="Run a real policy evaluation server-side and record the signed verdict"
             loading={isSimulating}>
              {"⚡ Run Policy Check"}
            </Button>
          </Flex>
        </Flex>

        {/* Actions Table / Empty State */}
        <Table
          columns={[
            {
              key: "time",
              header: <SortHeader label="DATE & TIME" sortKey="time" sort={actionsSort} onSort={handleActionsSort} />,
              ariaSort: tableSortAria(actionsSort, "time"),
              cellClassName: "time-cell",
              render: (action) => (
              <>{action.timestamp}</>
            ),
            },
            {
              key: "action",
              header: <SortHeader label="ACTION & TRIGGER" sortKey="action" sort={actionsSort} onSort={handleActionsSort} />,
              ariaSort: tableSortAria(actionsSort, "action"),
              cellClassName: "summary-cell",
              render: (action) => (
              <><Badge size="xs" uppercase tone={ACTION_TYPE_TONES[action.actionType] ?? "neutral"}>
                          {action.actionType.replace("_", " ").toUpperCase()}
                        </Badge>
                        <span className="ui-meta-sm ui-single-line" title={action.summary}>{action.summary}</span>
                        {action.source && (
                          <Badge size="xs" tone={action.source === "live" ? "success" : "purple"} title={`Action origin: ${
                              action.source === "live"
                                ? "Live SQLite Audit Ledger / Brokerage"
                                : "Local Policy Simulation"
                            }`}
                          >
                            {action.source === "live" ? "📡 Live" : "🧪 Sim"}
                          </Badge>
                        )}</>
            ),
            },
            {
              key: "asset",
              header: <SortHeader label="ASSET" sortKey="asset" sort={actionsSort} onSort={handleActionsSort} />,
              ariaSort: tableSortAria(actionsSort, "asset"),
              cellClassName: "symbol-cell ui-cell-nowrap",
              render: (action) => (
              <><Badge size="md" tone="neutral">{action.symbol}</Badge></>
            ),
            },
            {
              key: "policy",
              header: <SortHeader label="POLICY CHECK" sortKey="policy" sort={actionsSort} onSort={handleActionsSort} />,
              ariaSort: tableSortAria(actionsSort, "policy"),
              cellClassName: "policy-cell ui-cell-nowrap",
              render: (action) => (
              <><Badge size="xs" tone={action.policyCheckPassed ? "success" : "danger"}>
                          {action.policyCheckPassed ? "✓" : "✕"} {action.policyCheckRule}
                        </Badge></>
            ),
            },
            {
              key: "status",
              header: <SortHeader label="STATUS" sortKey="status" sort={actionsSort} onSort={handleActionsSort} />,
              ariaSort: tableSortAria(actionsSort, "status"),
              cellClassName: "status-cell ui-cell-nowrap",
              render: (action) => (
              <><Badge size="xs" tone={ACTION_STATUS_TONES[action.status] ?? "neutral"}>
                          {action.status.replace(/_/g, " ").toUpperCase()}
                        </Badge></>
            ),
            },
            {
              key: "attestation",
              header: <SortHeader label="DID ATTESTATION" sortKey="attestation" sort={actionsSort} onSort={handleActionsSort} />,
              ariaSort: tableSortAria(actionsSort, "attestation"),
              cellClassName: "attestation-cell ui-cell-nowrap",
              render: (action) => (
              <><Button
              variant="ghost"
              size="sm"
                          onClick={() =>
                            handleCopyDid(
                              action.id,
                              `${action.didAttestation.did}#${action.didAttestation.signature}`
                            )
                          }
                          title="Click to copy cryptographic DID signature"
                        >
                          {(copiedDidId === action.id)
                            ? "✓ Copied"
                            : action.didAttestation.signature
                            ? action.didAttestation.signature.slice(0, 14) + "…"
                            : "UNSIGNED"}
                        </Button></>
            ),
            },
          ]}
          rows={sortedActions}
          rowKey={(action) => action.id}
          rowClassName="action-table-row"
          containerClassName="autopilot-table-container ui-scroll-frame"
          stickyHeader
          empty={(
            <EmptyState
            framed
            icon="🛡️"
            title="No autonomous actions recorded"
            description={`As the ${BRAND.name} autonomous agent scans opportunities and evaluates policy limits, live order executions and cryptographic audit proofs will appear here in real time.`}
            action={
            <Button
            variant="secondary"
            size="sm"
            onClick={handleSimulateAutonomousAction}
            >
            Trigger Policy Evaluation
            </Button>
            }
            />
          )}
        />
      </DetailCard>
      </PageSection>
      </TabPanel>

      {/* Policy Decisions Audit (issue #651): recorded verdicts from mas_policy_verdicts */}
      <TabPanel idBase="autopilot-sections" tabId="policy-decisions" active={activeView === "policy-decisions"}>
      <PageSection title="Policy decisions">
      <DetailCard
        belowSubtitle={<span className="ui-meta-sm ui-single-line" title={AUTOPILOT_SOURCE_LINES.verdicts}>{AUTOPILOT_SOURCE_LINES.verdicts}</span>}
      >
        <Flex gap="2" align="center" justify="between" wrap>
          <Flex gap="1" align="center">
            <Badge tone="neutral">{verdictRows.length}</Badge>
            <Badge tone="neutral" title="Signed policy verdicts recorded by the RiskPolicyEngine (mas_policy_verdicts)">
              Verdict Audit Trail
            </Badge>
          </Flex>
        </Flex>

        <Table
          columns={[
            {
              key: "time",
              header: <SortHeader label="DATE & TIME" sortKey="time" sort={verdictsSort} onSort={handleVerdictsSort} />,
              ariaSort: tableSortAria(verdictsSort, "time"),
              cellClassName: "time-cell",
              render: (row) => (
              <>{row.timeLabel}</>
            ),
            },
            {
              key: "intent",
              header: <SortHeader label="INTENT" sortKey="intent" sort={verdictsSort} onSort={handleVerdictsSort} />,
              ariaSort: tableSortAria(verdictsSort, "intent"),
              cellClassName: "summary-cell",
              render: (row) => (
              <><span className="ui-meta-sm ui-single-line" title={row.intentLabel}>{row.intentLabel}</span>
                        {row.modeLabel && (
                          <Badge size="xs" tone="neutral">{row.modeLabel}</Badge>
                        )}</>
            ),
            },
            {
              key: "notional",
              header: <SortHeader label="NOTIONAL" sortKey="notional" sort={verdictsSort} onSort={handleVerdictsSort} />,
              ariaSort: tableSortAria(verdictsSort, "notional"),
              cellClassName: "ui-cell-nowrap",
              render: (row) => (
              <>{row.notionalLabel}</>
            ),
            },
            {
              key: "outcome",
              header: <SortHeader label="OUTCOME" sortKey="outcome" sort={verdictsSort} onSort={handleVerdictsSort} />,
              ariaSort: tableSortAria(verdictsSort, "outcome"),
              cellClassName: "ui-cell-nowrap",
              render: (row) => (
              <Badge size="xs" uppercase tone={row.outcomeTone}>
                          {row.outcomeLabel}
                        </Badge>
            ),
            },
            {
              key: "rule",
              header: <SortHeader label="BINDING RULE" sortKey="rule" sort={verdictsSort} onSort={handleVerdictsSort} />,
              ariaSort: tableSortAria(verdictsSort, "rule"),
              cellClassName: "ui-cell-nowrap",
              render: (row) => (
              <>{row.ruleLabel}</>
            ),
            },
            {
              key: "detail",
              header: <SortHeader label="DETAIL" sortKey="detail" sort={verdictsSort} onSort={handleVerdictsSort} />,
              ariaSort: tableSortAria(verdictsSort, "detail"),
              cellClassName: "summary-cell",
              render: (row) => (
              <><span className="ui-meta-sm ui-single-line" title={row.detail || "—"}>{row.detail || "—"}</span>
                        {row.signed && (
                          <Badge size="xs" tone="purple" title="Verdict carries a cryptographic attestation signature">
                            Signed
                          </Badge>
                        )}</>
            ),
            },
          ]}
          rows={sortedVerdictRows}
          rowKey={(row) => row.id}
          rowClassName="action-table-row"
          containerClassName="autopilot-table-container ui-scroll-frame"
          stickyHeader
          empty={(
            <EmptyState
            framed
            icon="⚖️"
            title="No policy decisions recorded"
            description="Every Autopilot policy evaluation records a signed verdict here — allowed, held for approval, or blocked by its binding rule — so the envelope's decisions stay auditable."
            />
          )}
        />
      </DetailCard>
      </PageSection>
      </TabPanel>

      {/* Edit Policy Limits Modal */}
      {isEditModalOpen && (
                <Modal open={isEditModalOpen} onClose={() => setIsEditModalOpen(false)} size="none" panelClassName="autopilot-edit-limits-modal" title="Edit Autopilot Policy Limits" ariaLabel="Edit Live Policy Limits">
            <form onSubmit={handleSaveLimits}>
              {limitsError && (
                <Notice tone="danger" density="compact" onDismiss={() => setLimitsError(null)}>
                  {limitsError}
                </Notice>
              )}
              <Grid columns={2} gap="2">
                <div>
                  <TextInput label="Max position size (% of equity)"
                    hint="Maximum capital committed to any single name"
                    id="maxPositionPct"
                    type="number"
                    step="0.5"
                    min="1"
                    max="50"
                    value={editLimitsDraft.maxPositionPct}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        maxPositionPct: parseFloat(e.target.value) || 0,
                      }))
                    }
                    required
                  />
                </div>

                <div>
                  <TextInput label="Minimum cash reserve (%)"
                    hint="Safety liquidity floor preserved at all times"
                    id="cashReservePct"
                    type="number"
                    step="0.5"
                    min="1"
                    max="40"
                    value={editLimitsDraft.cashReservePct}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        cashReservePct: parseFloat(e.target.value) || 0,
                      }))
                    }
                    required
                  />
                </div>

                <div>
                  <TextInput label="Max autonomous orders / day"
                    hint="Rate limit on autonomous transactions per session"
                    id="ordersPerDay"
                    type="number"
                    step="1"
                    min="1"
                    max="100"
                    value={editLimitsDraft.ordersPerDay}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        ordersPerDay: parseInt(e.target.value, 10) || 1,
                      }))
                    }
                    required
                  />
                </div>

                <div>
                  <TextInput label="Peak-to-trough drawdown alert (%)"
                    hint="Triggers immediate agent pause & email alert"
                    id="drawdownAlertPct"
                    type="number"
                    step="1"
                    min="5"
                    max="50"
                    value={editLimitsDraft.drawdownAlertPct}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        drawdownAlertPct: parseFloat(e.target.value) || 0,
                      }))
                    }
                    required
                  />
                </div>

                <div>
                  <Select label="Trading Universe"
                    id="universe"
                    value={editLimitsDraft.universe}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        universe: e.target.value,
                      }))
                    }
                  >
                    <option value="Default large caps/ETFs">Default large caps/ETFs</option>
                    <option value="S&P 500 & Mega Caps">S&P 500 & Mega Caps</option>
                    <option value="Nasdaq 100 & AI Growth">Nasdaq 100 & AI Growth</option>
                    <option value="US Equities + Crypto (BTC/ETH/SOL)">US Equities + Crypto (BTC/ETH/SOL)</option>
                    <option value="Custom Screened Watchlist">Custom Screened Watchlist</option>
                  </Select>
                </div>

                <div>
                  <Select label="Risk Profile"
                    id="riskProfile"
                    value={editLimitsDraft.riskProfile}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        riskProfile: e.target.value as any,
                      }))
                    }
                  >
                    <option value="conservative">Conservative</option>
                    <option value="moderate">Moderate</option>
                    <option value="aggressive">Aggressive</option>
                  </Select>
                </div>
              </Grid>

              <Flex gap="2" align="center" justify="between">
                <Button variant="secondary" type="button" onClick={handleResetLimits}>
                  Reset to Defaults
                </Button>
                <Flex gap="2" align="center">
                  <Button
                  variant="secondary"
                    onClick={() => setIsEditModalOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary">
                    Save Policy Limits
                  </Button>
                </Flex>
              </Flex>
            </form>
                  </Modal>
      )}

      {/* Emergency Platform Kill Switch Modal */}
      {killSwitchModalOpen && (
                <Modal open={killSwitchModalOpen} onClose={() => setKillSwitchModalOpen(false)} size="none" panelClassName="autopilot-killswitch-modal" title={<span className="ui-danger">🚨 Emergency Platform Kill Switch</span>} ariaLabel="Emergency Platform Kill Switch">
            <div>
              <p className="ui-meta">
                Activating the Emergency Kill Switch terminates all active autonomous order pipelines,
                blocks any new trade submission, and cancels pending unexecuted orders across the
                brokerage.
              </p>
              <Notice tone="danger">
                ⚠️ <strong>Kill switch status:</strong> {isKillSwitched ? "ACTIVATED (SYSTEM LOCKED)" : "DISARMED (NORMAL OPERATIONS)"}
              </Notice>
              {killSwitchError && (
                <Notice tone="danger" density="compact" onDismiss={() => setKillSwitchError(null)}>
                  {killSwitchError}
                </Notice>
              )}
            </div>
            <Flex gap="2" align="center" justify="between">
              <Button
              variant="secondary"
                onClick={() => setKillSwitchModalOpen(false)}
              >
                Dismiss
              </Button>
              <Button
              variant={isKillSwitched ? "secondary" : "danger"}
                onClick={async () => {
                  const next = !isKillSwitched;
                  setKillSwitchError(null);
                  try {
                    // Issue #1704 (A3-b): the kill switch is a safety
                    // control — its displayed state changes ONLY on
                    // server confirmation. The old code flipped the
                    // state and closed the dialog before a
                    // fire-and-forget POST, so a failed activation
                    // showed ACTIVATED (SYSTEM LOCKED) while the
                    // server never locked. On failure the dialog
                    // stays open with the true state named.
                    const res = await fetch("/api/autopilot/kill-switch", {
                      method: "POST",
                      headers: { "Content-Type": "application/json", ...csrfHeaders() },
                      body: JSON.stringify({
                        active: next,
                        reason: next ? `Activated from control center by ${user?.login || "operator"}` : null,
                      }),
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    setIsServerBacked(true);
                    setIsKillSwitched(next);
                    if (next) setIsRunning(false);
                    setKillSwitchModalOpen(false);
                  } catch {
                    setIsServerBacked(false);
                    setKillSwitchError(
                      next
                        ? "Kill switch could not be activated — the system is NOT locked."
                        : "Kill switch could not be disarmed — the system is still LOCKED."
                    );
                  }
                }}
              >
                {isKillSwitched ? "Disarm Kill Switch & Restore Access" : "ACTIVATE KILL SWITCH NOW"}
              </Button>
            </Flex>
                  </Modal>
      )}
    </PageTemplate>
  );
}
