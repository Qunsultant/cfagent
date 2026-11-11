/**
 * PaymentWorkflowAssurance — permanent assurance capability for the
 * PaymentWorkflow (issue #2049, Goal 1 #2013).
 *
 * This page runs the REAL flow (src/workflows/paymentWorkflowFlow.ts)
 * and the REAL gate (src/services/cfpayMonetization.ts) in the browser,
 * behind fake step / cfpay / deps seams — the same split as the flow
 * unit tests: test the flow, not the ThinkWorkflow class. It is NOT a
 * reimplementation of the flow, and it is NOT a payment surface.
 *
 * TEST ONLY, on its face:
 * - fake cfpay checkout (createCheckout returns a stub, checkoutStatus
 *   returns the selected fake status) — no cfpay key, no network call;
 * - fake screener starter (returns a fake workflow id, or throws when
 *   the screener fake is set to throw) — no real screener runs;
 * - no charge, no card, no mainnet. The gate itself is testnet-only.
 *
 * Two different toggles — do not confuse them:
 * - This page's VISIBILITY is gated by the Flagship feature flag
 *   "payment_assurance" (default OFF, fail-closed; see
 *   src/features/featureFlagPorts.ts). When that flag is OFF the page
 *   is hidden from nav and ?tab=payment-assurance renders the
 *   FeatureDisabledNotice instead (Chat's existing flag handling).
 * - The "Simulated monetization flag" toggle INSIDE this page only
 *   feeds the gate config (monetizationEnabled) for the run being
 *   tested. It is not Flagship, and flipping it charges nobody.
 *
 * All runs are scheduled behind the scenes: the one-off case sends
 * scheduleKind "one_off" (never "manual" — there is no manual
 * ScheduleKind). A recurring scheduled run, or a scheduled run with
 * no scheduleKind, is coverage-only: never an unattended charge.
 *
 * UX note (issue #2049): page chrome and controls use PageShell +
 * ui primitives only, and every inline style value is a design
 * token (var(--space-*), var(--color-*), var(--font-*)), per the
 * UX architecture primitives/token-only rule and the #1580/#470
 * ratchet gates. No raw controls, no hardcoded density literals,
 * no raw color literals (note: an issue number written as "#2024"
 * in rendered text would itself scan as a hex literal, so rendered
 * text never uses the "#NNNN" form).
 *
 * LIVE mode (issue 2059) sits next to the simulation below. It
 * calls the server routes in src/agents/routes/paymentAssuranceLive.ts
 * and runs the REAL PaymentWorkflow instance on Cloudflare with
 * test inputs (live-test run id, TEST goal screener command, test
 * account). Coverage mode needs no cfpay key; checkout mode
 * requires MONETIZATION_ENABLED and a cfpay key in the deployed
 * env, plus a test wallet payment on testnet. Live endpoints are
 * additionally restricted to PAYMENT_ASSURANCE_LIVE_LOGINS.
 */
import React, { useEffect, useState } from "react";
import {
  CfPayMonetizationGate,
  type CommercialAccount,
  type RunTrigger,
  type ScheduleKind,
  type ScreenerFamily,
} from "../services/cfpayMonetization";
import {
  PROPOSED_SEED_PRICES,
  type PriceCatalogue,
  type PriceEntry,
  type PriceFamily,
} from "../data/priceCataloguePorts";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowOutcome,
  type PaymentWorkflowParams,
} from "../workflows/paymentWorkflowFlow";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Notice,
  PageSection,
  PageShell,
  Select,
  Table,
  Tabs,
  TabPanel,
  TextInput,
  type TabOption,
} from "./components/ui";
import { StoreOperatorsPanel } from "./StoreOperatorsPanel";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { withCsrfInit, csrfHeaders } from "./apiFetch";

export interface FakeConfig {
  monetizationOn: boolean;
  family: ScreenerFamily;
  trigger: RunTrigger;
  scheduleKind: ScheduleKind;
  authorizedAtSubmission: boolean;
  tier: CommercialAccount["tier"];
  creditsUSD: number;
  includedRunsRemaining: number;
  runTenantId: string;
  accountTenantId: string;
  approval: "approve" | "reject" | "timeout";
  checkoutStatus: "fulfilled" | "pending";
  screener: "success" | "throw";
  runRequestId: string;
}

export const DEFAULT_FAKE_CONFIG: FakeConfig = {
  monetizationOn: true,
  family: "goal",
  trigger: "manual",
  scheduleKind: "one_off",
  authorizedAtSubmission: false,
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
  runTenantId: "tenant-1",
  accountTenantId: "tenant-1",
  approval: "approve",
  checkoutStatus: "fulfilled",
  screener: "success",
  runRequestId: "assurance-run-1",
};

export interface ScenarioResult {
  outcome: PaymentWorkflowOutcome | null;
  trace: string[];
  credited: boolean;
  error: string | null;
}

/** Run one scenario against the real flow/gate with fake seams. Pure: fresh gate + fresh account copy per run. */
export async function runAssuranceScenario(cfg: FakeConfig): Promise<ScenarioResult> {
  const trace: string[] = [];
  let credited = false;
  const fakeCfpay = {
    createCheckout: async () => ({ checkoutId: "chk-fake-1" }),
    checkoutStatus: async () => ({ status: cfg.checkoutStatus }),
  };
  // The simulation charges nobody: its catalogue is an inline
  // port implementation over the proposed seed prices (#2185) —
  // the gate never reads a code price table, even in this demo.
  const demoCatalogue: PriceCatalogue = {
    async getPrice(family: string) {
      return (PROPOSED_SEED_PRICES as Record<string, number>)[family] ?? null;
    },
    async getEntry(family: string): Promise<PriceEntry | null> {
      const all = await this.getAllPrices();
      return all.find((e) => e.family === family) ?? null;
    },
    async getApprovedPrice(family: string) {
      // Demo fixture: the seed values are treated as APPROVED so
      // the scenarios can exercise the gate (#2547). The real
      // catalogue seeds the same values as PROPOSED, and the real
      // gates refuse them until an operator approves.
      return (PROPOSED_SEED_PRICES as Record<string, number>)[family] ?? null;
    },
    async getAllPrices(): Promise<PriceEntry[]> {
      return (Object.entries(PROPOSED_SEED_PRICES) as Array<[ScreenerFamily, number]>).map(
        ([family, priceUSD]) => ({
          // Issue #3289: the demo entries are v1 rows for the
          // default segment, effective now — the same shape the
          // real catalogue seeds.
          id: `cat-${family}-default-v1`,
          family,
          priceUSD,
          updatedAtMs: Date.now(),
          approvalStatus: "approved" as const,
          approvedBy: "payment-assurance-demo",
          approvedAtMs: Date.now(),
          productId: `prod-per-run-${family}`,
          segment: "default",
          version: 1,
          effectiveFromMs: Date.now(),
          effectiveToMs: null,
        }),
      );
    },
    async getEffectiveEntry(family: string, segment?: string, nowMs?: number): Promise<PriceEntry | null> {
      void segment;
      void nowMs;
      return this.getEntry(family);
    },
    async listVersions(family: string, segment?: string): Promise<PriceEntry[]> {
      void segment;
      const entry = await this.getEntry(family);
      return entry ? [entry] : [];
    },
    async createVersion(input: {
      family: PriceFamily;
      priceUSD: number;
      segment?: string;
      effectiveFromMs?: number;
      effectiveToMs?: number | null;
    }): Promise<PriceEntry> {
      throw new Error(`Demo catalogue is read-only (family ${String(input.family)} not versioned).`);
    },
    async setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry> {
      throw new Error(`Demo catalogue is read-only (family ${String(input.family)} not set).`);
    },
    async approvePrice(input: { family: unknown; approverId: unknown }): Promise<PriceEntry> {
      throw new Error(`Demo catalogue is read-only (family ${String(input.family)} not approved).`);
    },
  };
  const gate = new CfPayMonetizationGate(fakeCfpay, {
    monetizationEnabled: cfg.monetizationOn,
    network: "base-sepolia",
    priceCatalogue: demoCatalogue,
  });
  const account: CommercialAccount = {
    userId: "assurance-user",
    email: "assurance@example.com",
    tenantId: cfg.accountTenantId,
    tier: cfg.tier,
    creditsUSD: cfg.creditsUSD,
    includedRunsRemaining: cfg.includedRunsRemaining,
  };
  const params: PaymentWorkflowParams = {
    runRequestId: cfg.runRequestId,
    family: cfg.family,
    trigger: cfg.trigger,
    scheduleKind: cfg.scheduleKind,
    authorizedAtSubmission: cfg.authorizedAtSubmission,
    tenantId: cfg.runTenantId,
    userId: "assurance-user",
    email: "assurance@example.com",
  };
  const step = {
    waitForEvent: async (name: string) => {
      trace.push(`wait ${name}`);
      if (name.includes("approval")) {
        if (cfg.approval === "timeout") throw new Error("fake wait timeout");
        return { payload: { approved: cfg.approval === "approve" } };
      }
      return { payload: { claimTxHash: "0xabc-fake" } };
    },
    do: async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      trace.push(`do ${name}`);
      return fn();
    },
  };
  try {
    const outcome = await runPaymentWorkflowFlow(
      params,
      {
        gate,
        account,
        startScreener: async (p) => {
          if (cfg.screener === "throw") throw new Error("fake screener failure");
          return { workflowId: `wf-fake-${p.runRequestId}` };
        },
        recordEvent: async (e) => {
          trace.push(`event ${e.type}`);
        },
        issueFailureCredit: async () => {
          credited = true;
        },
      },
      step,
    );
    return { outcome, trace, credited, error: null };
  } catch (err) {
    return {
      outcome: null,
      trace,
      credited,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface Preset {
  name: string;
  expected: string;
  config: FakeConfig;
}

const base: FakeConfig = { ...DEFAULT_FAKE_CONFIG };

export const PRESETS: Preset[] = [
  {
    name: "Coverage run starts screener, no wait, no checkout",
    expected: "started (subscription_included)",
    config: { ...base, tier: "Subscribed", includedRunsRemaining: 1, runRequestId: "assurance-preset-1" },
  },
  {
    name: "Checkout run waits, confirms, then starts screener",
    expected: "started (cfpay_checkout)",
    config: { ...base, runRequestId: "assurance-preset-2" },
  },
  {
    name: "Checkout wait timeout expires and starts nothing",
    expected: "expired",
    config: { ...base, approval: "timeout", runRequestId: "assurance-preset-3" },
  },
  {
    name: "Event alone is not proof: unfulfilled status does not start screener",
    expected: "payment_required",
    config: { ...base, checkoutStatus: "pending", runRequestId: "assurance-preset-4" },
  },
  {
    name: "Recurring scheduled run is coverage_required, never a checkout",
    expected: "coverage_required",
    config: { ...base, trigger: "scheduled", scheduleKind: "recurring", runRequestId: "assurance-preset-5" },
  },
  {
    name: "Tenant mismatch fails closed before any start",
    expected: "throws: Tenant mismatch",
    config: { ...base, accountTenantId: "tenant-2", runRequestId: "assurance-preset-6" },
  },
  {
    name: "Screener failure after payment issues failure credit, no cash refund claim",
    expected: "screener_failed_credit_issued (credit issued)",
    config: { ...base, screener: "throw", runRequestId: "assurance-preset-7" },
  },
  {
    name: "Approval rejected: no capture, no screener start",
    expected: "approval_rejected",
    config: { ...base, approval: "reject", runRequestId: "assurance-preset-8" },
  },
  {
    name: "One-off scheduled run authorized at submission skips the second approval wait",
    expected: "started (cfpay_checkout)",
    config: {
      ...base,
      trigger: "scheduled",
      scheduleKind: "one_off",
      authorizedAtSubmission: true,
      approval: "reject",
      runRequestId: "assurance-preset-9",
    },
  },
];

function resultLabel(r: ScenarioResult): string {
  if (r.error) return `throws: ${r.error}`;
  if (!r.outcome) return "no outcome";
  const paid = "paidVia" in r.outcome ? ` (${r.outcome.paidVia})` : "";
  const credit = r.outcome.status === "screener_failed_credit_issued" && r.credited ? " (credit issued)" : "";
  return `${r.outcome.status}${paid}${credit}`;
}

/**
 * Shared styles for the price approval section below — one definition
 * per visual pattern, reused across the section, instead of a fresh
 * inline style literal per element (the bespoke-styling ceiling counts
 * literals).
 */
const priceMutedStyle: React.CSSProperties = { color: "var(--color-text-muted)" };
const priceFlagRowStyle: React.CSSProperties = { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--space-3)" };
const priceErrorWrapStyle: React.CSSProperties = { marginTop: "var(--space-1)" };
const priceFootnoteStyle: React.CSSProperties = { margin: "var(--space-3) 0 0", color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" };
const priceEditRowStyle: React.CSSProperties = { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" };
const pageWrapperStyle: React.CSSProperties = {
  padding: "var(--space-4)",
  boxSizing: "border-box",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};
const tabsWrapperStyle: React.CSSProperties = {
  marginBottom: "var(--space-2)",
};
const formSubgridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "var(--space-3)",
};
const actionBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
  marginTop: "var(--space-4)",
  flexWrap: "wrap",
  alignItems: "center",
};
const resultListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "var(--space-5)",
  fontFamily: "var(--font-code)",
  fontSize: "var(--font-size-body-sm)",
};
const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-code)",
  fontSize: "var(--font-size-body-sm)",
  whiteSpace: "pre-wrap",
};
const monoSnippetStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-code)",
  fontSize: "var(--font-size-body-sm)",
};
const monoSnippetWithTopMarginStyle: React.CSSProperties = {
  margin: "var(--space-2) 0 0",
  fontFamily: "var(--font-code)",
  fontSize: "var(--font-size-body-sm)",
};
const suiteStackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};
const suiteExpectedStyle: React.CSSProperties = {
  margin: "var(--space-2) 0 0",
  color: "var(--color-text-muted)",
  fontSize: "var(--font-size-body)",
};
const badgeRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
  flexWrap: "wrap",
};
const marginTopSmStyle: React.CSSProperties = {
  marginTop: "var(--space-3)",
};
const sectionSubtitleStyle: React.CSSProperties = {
  margin: "0 0 var(--space-3)",
  color: "var(--color-text-muted)",
};
const stepTraceHeaderStyle: React.CSSProperties = {
  margin: "var(--space-4) 0 var(--space-2)",
};

export type AssuranceTab = "simulation" | "live" | "prices" | "operators";

export const ASSURANCE_TABS: TabOption<AssuranceTab>[] = [
  { id: "simulation", label: "Simulator & Presets" },
  { id: "live", label: "Live Workflow" },
  { id: "prices", label: "Store Prices" },
  { id: "operators", label: "Store Operators" },
];

/**
 * Store price approval (issue 2677, slice A). A LIVE operator action,
 * unlike the simulation on this page: approving a family here records
 * a real price approval through POST /api/payments/agentic/commercial/prices.
 * The monetization gate treats a merely-proposed price as missing, so
 * the table shows proposed vs approved distinctly. The entries read
 * (GET /api/payments/agentic/commercial/prices) supplies real approval
 * state; a family reads Unknown only when that read fails or is
 * unavailable. The server remains authoritative: a price change
 * returns an entry to proposed, and approving after such a change
 * re-records approver and time. Rendered text never uses the "#NNNN"
 * issue-number form (the ratchet counts it as a hex literal).
 */
export type StorePriceFamily = "stock" | "goal" | "options" | "strategy";
export const STORE_PRICE_FAMILIES: Array<{ id: StorePriceFamily; label: string }> = [
  { id: "stock", label: "Stock" },
  { id: "goal", label: "Goal" },
  { id: "options", label: "Options" },
  { id: "strategy", label: "Strategy" },
];

export interface PriceApprovalInfo {
  approvedBy: string;
  approvedAtMs: number;
}

export interface PriceEntryState {
  priceUSD: number;
  approvalStatus: "proposed" | "approved";
  approvedBy: string | null;
  approvedAtMs: number | null;
  updatedAtMs: number;
}

export type OperatorProbe = "operator" | "not-operator" | "unknown";

/**
 * Maps the operator probe's HTTP status. The probe is POST
 * /api/payments/agentic/commercial/prices with an empty body: the route
 * answers 403 for a non-operator before reading the body, and 400
 * ("Nothing to do") for an operator with nothing to set — so neither
 * outcome writes anything, and no audit row is produced. Any other
 * status (or a network failure) is unknown, and approval stays
 * disabled (fail-closed). The probe exists because no route exposes
 * the session's store-operator status; the server gate on
 * COMMERCIAL_STORE_OPERATORS remains authoritative, and a 403 on a
 * real approval flips the section to not-operator even mid-session.
 */
export function mapOperatorProbeStatus(status: number): OperatorProbe {
  if (status === 403) return "not-operator";
  if (status === 400) return "operator";
  return "unknown";
}

export function PriceApprovalSection({ userLogin }: { userLogin?: string }) {
  const [loading, setLoading] = useState(true);
  const [operator, setOperator] = useState<OperatorProbe | "loading">("loading");
  const [prices, setPrices] = useState<Partial<Record<StorePriceFamily, number>>>({});
  const [monetizationOn, setMonetizationOn] = useState<boolean | null>(null);
  const [approvals, setApprovals] = useState<Partial<Record<StorePriceFamily, PriceApprovalInfo>>>({});
  const [entries, setEntries] = useState<Partial<Record<StorePriceFamily, PriceEntryState>>>({});
  const [entriesAvailable, setEntriesAvailable] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<StorePriceFamily, string>>>({});
  const [needsReapproval, setNeedsReapproval] = useState<Partial<Record<StorePriceFamily, boolean>>>({});
  const [busyFamily, setBusyFamily] = useState<StorePriceFamily | null>(null);
  const [rowError, setRowError] = useState<Partial<Record<StorePriceFamily, string>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    if (!userLogin) {
      setOperator("unknown");
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const headers: Record<string, string> = { "x-user-login": userLogin };
    let pricingPrices: Partial<Record<StorePriceFamily, number>> = {};
    try {
      const res = await globalThis.fetch("/api/payments/agentic/commercial/pricing", { headers });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setLoadError(typeof data["error"] === "string" ? data["error"] : `Price list failed (HTTP ${res.status}).`);
      } else {
        const raw = data["prices"] as Record<string, unknown> | undefined;
        const next: Partial<Record<StorePriceFamily, number>> = {};
        if (raw) {
          for (const { id } of STORE_PRICE_FAMILIES) {
            if (typeof raw[id] === "number") next[id] = raw[id] as number;
          }
        }
        pricingPrices = next;
        setPrices(next);
        setMonetizationOn(typeof data["monetizationEnabled"] === "boolean" ? (data["monetizationEnabled"] as boolean) : null);
      }
    } catch {
      setLoadError("Price list could not be reached.");
    }
    // Entries read (issue 2739): full approval state. A failed read
    // leaves entries unavailable and the table falls back to
    // session-recorded approvals with Unknown otherwise; it never
    // blocks the section, and for a non-operator the 403 here is
    // expected (the probe below is the gating signal).
    try {
      const res = await globalThis.fetch("/api/payments/agentic/commercial/prices", { headers });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const list = data["entries"];
      if (!res.ok || !Array.isArray(list)) {
        setEntriesAvailable(false);
      } else {
        const nextEntries: Partial<Record<StorePriceFamily, PriceEntryState>> = {};
        const nextPrices: Partial<Record<StorePriceFamily, number>> = {};
        for (const raw of list) {
          const row = raw as Record<string, unknown>;
          if (typeof row["family"] !== "string" || typeof row["priceUSD"] !== "number") continue;
          const id = row["family"] as StorePriceFamily;
          if (!STORE_PRICE_FAMILIES.some((f) => f.id === id)) continue;
          nextEntries[id] = {
            priceUSD: row["priceUSD"] as number,
            approvalStatus: row["approvalStatus"] === "approved" ? "approved" : "proposed",
            approvedBy: typeof row["approvedBy"] === "string" ? (row["approvedBy"] as string) : null,
            approvedAtMs: typeof row["approvedAtMs"] === "number" ? (row["approvedAtMs"] as number) : null,
            updatedAtMs: typeof row["updatedAtMs"] === "number" ? (row["updatedAtMs"] as number) : 0,
          };
          nextPrices[id] = row["priceUSD"] as number;
        }
        const merged = { ...pricingPrices, ...nextPrices };
        setEntries(nextEntries);
        setEntriesAvailable(true);
        setPrices(merged);
        const nextDrafts: Partial<Record<StorePriceFamily, string>> = {};
        for (const { id } of STORE_PRICE_FAMILIES) {
          if (merged[id] !== undefined) nextDrafts[id] = String(merged[id]);
        }
        setDrafts(nextDrafts);
        setNeedsReapproval({});
      }
    } catch {
      setEntriesAvailable(false);
    }
    try {
      const res = await globalThis.fetch("/api/payments/agentic/commercial/prices", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", ...csrfHeaders() },
        body: "{}",
      });
      // The probe may run schema-ensure on a FRESH store only (seeding
      // proposed defaults); it never sets a price or an approval.
      await res.json().catch(() => ({}));
      setOperator(mapOperatorProbeStatus(res.status));
    } catch {
      setOperator("unknown");
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLogin]);

  const approve = async (family: StorePriceFamily) => {
    if (!userLogin || busyFamily) return;
    setBusyFamily(family);
    setRowError((prev) => ({ ...prev, [family]: undefined }));
    try {
      const res = await globalThis.fetch("/api/payments/agentic/commercial/prices", {
        method: "POST",
        headers: { "x-user-login": userLogin, "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ family, approvalStatus: "approved" }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 403) {
        setOperator("not-operator");
        setRowError((prev) => ({ ...prev, [family]: "You are not a store operator." }));
      } else if (!res.ok) {
        setRowError((prev) => ({
          ...prev,
          [family]: typeof data["error"] === "string" ? (data["error"] as string) : `Approval failed (HTTP ${res.status}).`,
        }));
      } else {
        const entry = data["entry"] as Record<string, unknown> | undefined;
        if (!entry || typeof entry["approvedBy"] !== "string" || typeof entry["approvedAtMs"] !== "number") {
          setRowError((prev) => ({ ...prev, [family]: "Approval response was incomplete." }));
        } else {
          setApprovals((prev) => ({
            ...prev,
            [family]: { approvedBy: entry["approvedBy"] as string, approvedAtMs: entry["approvedAtMs"] as number },
          }));
          setEntries((prev) => ({
            ...prev,
            [family]: {
              priceUSD:
                typeof entry["priceUSD"] === "number"
                  ? (entry["priceUSD"] as number)
                  : (prev[family]?.priceUSD ?? prices[family] ?? 0),
              approvalStatus: "approved",
              approvedBy: entry["approvedBy"] as string,
              approvedAtMs: entry["approvedAtMs"] as number,
              updatedAtMs:
                typeof entry["updatedAtMs"] === "number"
                  ? (entry["updatedAtMs"] as number)
                  : (prev[family]?.updatedAtMs ?? 0),
            },
          }));
          setNeedsReapproval((prev) => ({ ...prev, [family]: false }));
        }
      }
    } catch {
      setRowError((prev) => ({ ...prev, [family]: "Approval could not be reached." }));
    }
    setBusyFamily(null);
  };

  /**
   * Client-side price validation mirroring the server's assertPriceUSD
   * (finite, positive; the server rounds to cents). An invalid draft
   * shows an inline error and sends no request.
   */
  const validateDraft = (family: StorePriceFamily): number | null => {
    const raw = (drafts[family] ?? "").trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || value <= 0) {
      setRowError((prev) => ({ ...prev, [family]: "Enter a positive price." }));
      return null;
    }
    return value;
  };

  const applyEntryResponse = (
    family: StorePriceFamily,
    res: Response,
    data: Record<string, unknown>,
  ): void => {
    if (res.status === 403) {
      setOperator("not-operator");
      setRowError((prev) => ({ ...prev, [family]: "You are not a store operator." }));
      return;
    }
    if (!res.ok) {
      setRowError((prev) => ({
        ...prev,
        [family]:
          typeof data["error"] === "string" ? (data["error"] as string) : `Price update failed (HTTP ${res.status}).`,
      }));
      return;
    }
    const entry = data["entry"] as Record<string, unknown> | undefined;
    if (!entry || typeof entry["priceUSD"] !== "number" || typeof entry["approvalStatus"] !== "string") {
      setRowError((prev) => ({ ...prev, [family]: "Price update response was incomplete." }));
      return;
    }
    const approved = entry["approvalStatus"] === "approved";
    setPrices((prev) => ({ ...prev, [family]: entry["priceUSD"] as number }));
    setDrafts((prev) => ({ ...prev, [family]: String(entry["priceUSD"] as number) }));
    setEntries((prev) => ({
      ...prev,
      [family]: {
        priceUSD: entry["priceUSD"] as number,
        approvalStatus: approved ? "approved" : "proposed",
        approvedBy: typeof entry["approvedBy"] === "string" ? (entry["approvedBy"] as string) : null,
        approvedAtMs: typeof entry["approvedAtMs"] === "number" ? (entry["approvedAtMs"] as number) : null,
        updatedAtMs:
          typeof entry["updatedAtMs"] === "number" ? (entry["updatedAtMs"] as number) : (prev[family]?.updatedAtMs ?? 0),
      },
    }));
    if (approved) {
      if (typeof entry["approvedBy"] === "string" && typeof entry["approvedAtMs"] === "number") {
        setApprovals((prev) => ({
          ...prev,
          [family]: { approvedBy: entry["approvedBy"] as string, approvedAtMs: entry["approvedAtMs"] as number },
        }));
      }
      setNeedsReapproval((prev) => ({ ...prev, [family]: false }));
    } else {
      // A price write lands as proposed and clears any prior approval
      // (#2547): the row must show that consequence, not hide it.
      setNeedsReapproval((prev) => ({ ...prev, [family]: true }));
    }
  };

  const postPrice = async (family: StorePriceFamily, body: Record<string, unknown>) => {
    if (!userLogin || busyFamily) return;
    setBusyFamily(family);
    setRowError((prev) => ({ ...prev, [family]: undefined }));
    try {
      const res = await globalThis.fetch("/api/payments/agentic/commercial/prices", {
        method: "POST",
        headers: { "x-user-login": userLogin, "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      applyEntryResponse(family, res, data);
    } catch {
      setRowError((prev) => ({ ...prev, [family]: "Price update could not be reached." }));
    }
    setBusyFamily(null);
  };

  const save = async (family: StorePriceFamily) => {
    const value = validateDraft(family);
    if (value === null) return;
    await postPrice(family, { family, priceUSD: value });
  };

  const saveAndApprove = async (family: StorePriceFamily) => {
    const value = validateDraft(family);
    if (value === null) return;
    await postPrice(family, { family, priceUSD: value, approvalStatus: "approved" });
  };

  const canApprove = operator === "operator";
  type ApprovalDisplay =
    | { kind: "hidden" }
    | { kind: "unknown" }
    | { kind: "approved"; approvedBy: string; approvedAtMs: number }
    | { kind: "proposed"; updatedAtMs: number; needsReapproval: boolean };
  const approvalFor = (id: StorePriceFamily): ApprovalDisplay => {
    if (operator === "not-operator") return { kind: "hidden" };
    if (entriesAvailable) {
      const entry = entries[id];
      if (!entry) return { kind: "unknown" };
      if (entry.approvalStatus === "approved" && entry.approvedBy && entry.approvedAtMs !== null) {
        return { kind: "approved", approvedBy: entry.approvedBy, approvedAtMs: entry.approvedAtMs };
      }
      return { kind: "proposed", updatedAtMs: entry.updatedAtMs, needsReapproval: !!needsReapproval[id] };
    }
    const approval = approvals[id];
    return approval ? { kind: "approved", ...approval } : { kind: "unknown" };
  };
  const rows = STORE_PRICE_FAMILIES.map(({ id, label }) => ({
    id,
    label,
    priceUSD: prices[id] ?? null,
    approval: approvalFor(id),
    draft: drafts[id] ?? "",
    error: rowError[id] ?? null,
  }));

  return (
    <PageSection title="Store price approval">
      <Notice tone="info" title="Live operator action — not a simulation">
        Approving a family here records a real price approval, unlike
        the simulation below. Until a price is approved, the gate
        treats it as missing and paid runs fail closed.
      </Notice>
      {!userLogin ? (
        <Notice tone="warning" title="Sign in to view store price approval">
          Price approval needs a session login, and only a login listed
          in the store operators list may approve. Tenant-admin and
          platform-admin roles do not grant it.
        </Notice>
      ) : loading ? (
        <p style={priceMutedStyle}>Loading prices…</p>
      ) : (
        <>
          <div style={priceFlagRowStyle}>
            <span style={priceMutedStyle}>
              Monetization flag: {monetizationOn === null ? "unknown" : monetizationOn ? "ON" : "OFF"}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Refresh prices
            </Button>
          </div>
          {loadError && <Notice tone="danger" title="Price list failed">{loadError}</Notice>}
          {operator === "not-operator" && (
            <Notice tone="warning" title="You are not a store operator">
              Price approval requires a session login listed in the
              store operators list. The server enforces this; approval
              buttons are hidden rather than offered and refused.
            </Notice>
          )}
          {operator === "unknown" && (
            <Notice tone="warning" title="Could not verify store-operator status">
              Approval is disabled until the status can be verified.
              The server gate remains authoritative.
            </Notice>
          )}
          <Table
            columns={[
              { key: "family", header: "Family", render: (row) => row.label },
              {
                key: "price",
                header: "Price per run",
                render: (row) => (row.priceUSD === null ? "—" : `$${row.priceUSD.toFixed(2)}`),
              },
              {
                key: "approval",
                header: "Approval",
                render: (row) =>
                  row.approval.kind === "hidden" ? (
                    "—"
                  ) : row.approval.kind === "approved" ? (
                    <>
                      <Badge tone="success">Approved</Badge>{" "}
                      <span style={priceMutedStyle}>
                        by {row.approval.approvedBy} · {new Date(row.approval.approvedAtMs).toLocaleString()}
                      </span>
                    </>
                  ) : row.approval.kind === "proposed" ? (
                    <>
                      <Badge tone="neutral">Proposed</Badge>{" "}
                      <span style={priceMutedStyle}>
                        updated {new Date(row.approval.updatedAtMs).toLocaleString()}
                      </span>
                      {row.approval.needsReapproval && (
                        <span style={priceMutedStyle}> · Needs re-approval</span>
                      )}
                    </>
                  ) : (
                    <Badge tone="neutral">Unknown</Badge>
                  ),
              },
              {
                key: "action",
                header: "Action",
                render: (row) => (
                  <>
                    {canApprove ? (
                      <div style={priceEditRowStyle}>
                        <TextInput
                          size="sm"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          aria-label={`Edit ${row.label} price`}
                          value={row.draft}
                          disabled={busyFamily === row.id}
                          onChange={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Save ${row.label} price`}
                          loading={busyFamily === row.id}
                          onClick={() => void save(row.id)}
                        >
                          Save
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Save and approve ${row.label} price`}
                          loading={busyFamily === row.id}
                          onClick={() => void saveAndApprove(row.id)}
                        >
                          Save & approve
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          aria-label={`Approve ${row.label} price`}
                          loading={busyFamily === row.id}
                          onClick={() => void approve(row.id)}
                        >
                          Approve
                        </Button>
                      </div>
                    ) : (
                      "—"
                    )}
                    {row.error && (
                      <div style={priceErrorWrapStyle}>
                        <Notice tone="danger">{row.error}</Notice>
                      </div>
                    )}
                  </>
                ),
              },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
          />
          <p style={priceFootnoteStyle}>
            Approval state comes from the price entries read: a family
            reads Unknown only when that read fails. Saving a price
            returns the family to proposed and clears its approval, so
            it must be approved again; Save & approve does both in
            one request.
          </p>
        </>
      )}
    </PageSection>
  );
}

export function PaymentWorkflowAssurance({ userLogin }: { userLogin?: string }) {
  const [cfg, setCfg] = useState<FakeConfig>({ ...DEFAULT_FAKE_CONFIG });
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<ScenarioResult | null>(null);
  const [suite, setSuite] = useState<Array<{ preset: Preset; result: ScenarioResult; pass: boolean }> | null>(null);

  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<AssuranceTab>({
    param: "view",
    defaultTab: "simulation",
    isValid: (v): v is AssuranceTab =>
      v === "simulation" || v === "live" || v === "prices" || v === "operators",
  });

  // Live mode (issue 2059): real workflow instance on Cloudflare.
  const [liveMode, setLiveMode] = useState<"coverage" | "checkout">("coverage");
  const [liveScheduleKind, setLiveScheduleKind] = useState<ScheduleKind>("one_off");
  const [liveAuthorized, setLiveAuthorized] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveStart, setLiveStart] = useState<Record<string, unknown> | null>(null);
  const [liveStatus, setLiveStatus] = useState<unknown>(null);
  const [liveMessage, setLiveMessage] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const liveHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(userLogin ? { "x-user-login": userLogin } : {}),
  });

  const liveCall = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await globalThis.fetch(path, withCsrfInit(init));
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  };

  const startLive = async () => {
    setLiveBusy(true);
    setLiveError(null);
    try {
      const data = await liveCall("/api/assurance/payment-workflow/start", {
        method: "POST",
        headers: liveHeaders(),
        body: JSON.stringify({ mode: liveMode, scheduleKind: liveScheduleKind, authorizedAtSubmission: liveAuthorized }),
      });
      setLiveStart(data as Record<string, unknown>);
      setLiveStatus(null);
      setLiveMessage("Live workflow instance created on Cloudflare. Refresh status to follow it.");
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  };

  const refreshLive = async () => {
    if (!liveStart || typeof liveStart.workflowId !== "string") return;
    setLiveBusy(true);
    setLiveError(null);
    try {
      setLiveStatus(await liveCall(`/api/assurance/payment-workflow/status?workflowId=${encodeURIComponent(liveStart.workflowId)}`, { headers: liveHeaders() }));
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  };

  const sendLiveEvent = async (type: "approval" | "payment_verified", extra: Record<string, unknown>) => {
    if (!liveStart || typeof liveStart.workflowId !== "string") return;
    setLiveBusy(true);
    setLiveError(null);
    try {
      const data = await liveCall("/api/assurance/payment-workflow/event", {
        method: "POST",
        headers: liveHeaders(),
        body: JSON.stringify({ workflowId: liveStart.workflowId, type, ...extra }),
      });
      setLiveMessage(`Event delivered: ${type} — ${(data as { delivered?: boolean }).delivered ? "accepted" : "see status"}.`);
      await refreshLive();
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  };

  const checkLivePayment = async () => {
    if (!liveStart || typeof liveStart.workflowId !== "string") return;
    setLiveBusy(true);
    setLiveError(null);
    try {
      const data = await liveCall("/api/assurance/payment-workflow/check-payment", {
        method: "POST",
        headers: liveHeaders(),
        body: JSON.stringify({ workflowId: liveStart.workflowId }),
      });
      setLiveMessage((data as { delivered?: boolean }).delivered
        ? "Checkout is fulfilled — payment_verified event delivered to the live workflow."
        : "Checkout is not fulfilled — no event delivered. Pay the test checkout on testnet first, then check again.");
      await refreshLive();
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  };

  const set = <K extends keyof FakeConfig>(key: K, value: FakeConfig[K]) =>
    setCfg((c) => ({ ...c, [key]: value }));

  const runOne = async () => {
    setRunning(true);
    try {
      setLast(await runAssuranceScenario(cfg));
      setSuite(null);
    } finally {
      setRunning(false);
    }
  };

  const runSuite = async () => {
    setRunning(true);
    try {
      const rows: Array<{ preset: Preset; result: ScenarioResult; pass: boolean }> = [];
      for (const preset of PRESETS) {
        const result = await runAssuranceScenario(preset.config);
        rows.push({ preset, result, pass: resultLabel(result).startsWith(preset.expected.split(" (")[0]) });
      }
      setSuite(rows);
      setLast(null);
    } finally {
      setRunning(false);
    }
  };

  const passCount = suite ? suite.filter((r) => r.pass).length : null;

  return (
    <div style={pageWrapperStyle}>
      <PageShell
        title="Payment Workflow Assurance"
        scopeNote="Permanent assurance capability for PaymentWorkflow. Live mode runs the real workflow on Cloudflare with test inputs; the simulation runs the real flow and gate behind fake seams. TEST ONLY — no real-user runs, no mainnet."
      >
        <div style={tabsWrapperStyle}>
          <Tabs<AssuranceTab>
            idBase="payment-assurance"
            ariaLabel="Payment assurance sections"
            tabs={ASSURANCE_TABS}
            value={activeTab}
            onChange={handleTabChange}
          />
        </div>

        <TabPanel idBase="payment-assurance" tabId="simulation" active={activeTab === "simulation"} retain>
          <PageSection title="What this page is (and is not)">
            <Notice tone="warning" title="Test only — not a payment surface">
              Live mode starts real workflow instances, but only with test
              inputs (live-test run ids, TEST screener command, test
              account) — never a real-user run. The simulation below it
              charges nobody and runs no real screener: its cfpay checkout
              is a stub, its screener starter returns a fake workflow id
              (or throws, on purpose), and the gate is testnet-only.
            </Notice>
            <p style={sectionSubtitleStyle}>
              Price for the selected family (proposed, not approved):{" "}
              <strong>${PROPOSED_SEED_PRICES[cfg.family].toFixed(2)}</strong> per
              run-request — never per stage, shard, leg, retry, or re-serve.
              A paid run that fails gets a one-time replacement-run credit
              as its automatic compensation — never an automatic cash
              refund. Cash refunds are operator-initiated and
              operator-approved only (the refund path of issue 2204,
              reconciled in issue 2549).
            </p>
          </PageSection>

          <PageSection title="Tunable fakes">
            <Card padding="md">
              <div style={formSubgridStyle}>
                <Select label="Simulated monetization flag (gate config)" value={cfg.monetizationOn ? "on" : "off"} onChange={(e) => set("monetizationOn", e.target.value === "on")}>
                  <option value="on">ON — gate applies</option>
                  <option value="off">OFF — free path</option>
                </Select>
                <Select label="Family" value={cfg.family} onChange={(e) => set("family", e.target.value as ScreenerFamily)}>
                  <option value="stock">stock — $0.02</option>
                  <option value="goal">goal — $0.10</option>
                  <option value="options">options — $0.05</option>
                  <option value="strategy">strategy — $0.10</option>
                </Select>
                <Select label="Trigger" value={cfg.trigger} onChange={(e) => set("trigger", e.target.value as RunTrigger)}>
                  <option value="manual">manual (one-off scheduled behind the scenes)</option>
                  <option value="scheduled">scheduled</option>
                </Select>
                <Select label="Schedule kind" value={cfg.scheduleKind} onChange={(e) => set("scheduleKind", e.target.value as ScheduleKind)}>
                  <option value="one_off">one_off</option>
                  <option value="recurring">recurring</option>
                </Select>
                <Select label="Account tier" value={cfg.tier} onChange={(e) => set("tier", e.target.value as CommercialAccount["tier"])}>
                  <option value="Free">Free</option>
                  <option value="PayPerUse">PayPerUse</option>
                  <option value="Subscribed">Subscribed</option>
                </Select>
                <TextInput label="Credits (USD)" type="number" step="0.01" value={cfg.creditsUSD} onChange={(e) => set("creditsUSD", Number(e.target.value))} />
                <TextInput label="Included runs remaining" type="number" value={cfg.includedRunsRemaining} onChange={(e) => set("includedRunsRemaining", Number(e.target.value))} />
                <Select label="Approval fake" value={cfg.approval} onChange={(e) => set("approval", e.target.value as FakeConfig["approval"])}>
                  <option value="approve">approve</option>
                  <option value="reject">reject</option>
                  <option value="timeout">timeout (wait throws)</option>
                </Select>
                <Select label="Fake checkout.status re-read" value={cfg.checkoutStatus} onChange={(e) => set("checkoutStatus", e.target.value as FakeConfig["checkoutStatus"])}>
                  <option value="fulfilled">fulfilled</option>
                  <option value="pending">pending</option>
                </Select>
                <Select label="Fake screener" value={cfg.screener} onChange={(e) => set("screener", e.target.value as FakeConfig["screener"])}>
                  <option value="success">success</option>
                  <option value="throw">throw (failure credit path)</option>
                </Select>
                <TextInput label="Run tenant" value={cfg.runTenantId} onChange={(e) => set("runTenantId", e.target.value)} />
                <TextInput label="Account tenant" value={cfg.accountTenantId} onChange={(e) => set("accountTenantId", e.target.value)} />
                <TextInput label="Run request id" value={cfg.runRequestId} onChange={(e) => set("runRequestId", e.target.value)} />
              </div>
              <div style={marginTopSmStyle}>
                <Checkbox label="Authorized at submission (one-off scheduled only — skips the second approval wait)" checked={cfg.authorizedAtSubmission} onChange={(e) => set("authorizedAtSubmission", e.target.checked)} />
              </div>
              <div style={actionBarStyle}>
                <Button variant="primary" onClick={runOne} disabled={running} loading={running}>{"Run this scenario"}</Button>
                <Button variant="secondary" onClick={runSuite} disabled={running}>Run all 9 preset tests</Button>
              </div>
            </Card>
          </PageSection>

          {last && (
            <PageSection title="Last run">
              <Card>
                <div style={badgeRowStyle}>
                  <Badge tone={last.outcome?.status === "started" ? "success" : last.error ? "danger" : "neutral"}>{resultLabel(last)}</Badge>
                  {last.credited && <Badge tone="info">failure credit issued</Badge>}
                </div>
                <h3 style={stepTraceHeaderStyle}>Step trace</h3>
                <ol style={resultListStyle}>
                  {last.trace.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ol>
                {last.trace.length === 0 && <p style={priceMutedStyle}>No steps ran — the flow failed closed before the gate.</p>}
              </Card>
            </PageSection>
          )}

          {suite && (
            <PageSection title={`Preset suite — ${passCount}/${suite.length} passing`}>
              <div style={suiteStackStyle}>
                {suite.map((row, i) => (
                  <Card key={i}>
                    <div style={badgeRowStyle}>
                      <Badge tone={row.pass ? "success" : "danger"}>{row.pass ? "PASS" : "FAIL"}</Badge>
                      <span>{row.preset.name}</span>
                    </div>
                    <p style={suiteExpectedStyle}>
                      Expected: {row.preset.expected} · Got: {resultLabel(row.result)}
                    </p>
                  </Card>
                ))}
              </div>
            </PageSection>
          )}
        </TabPanel>

        <TabPanel idBase="payment-assurance" tabId="live" active={activeTab === "live"} retain>
          <PageSection title="Live mode — real workflow on Cloudflare (issue 2059)">
            <p style={sectionSubtitleStyle}>
              Starts a real PaymentWorkflow instance through the live
              deployed binding, with test inputs only. Coverage mode needs
              no cfpay key: the test account covers the run and the
              workflow starts the real screener. Checkout mode needs
              MONETIZATION_ENABLED and a cfpay key in the deployed env,
              plus a test wallet payment on testnet — until those are in
              place it refuses with the missing piece named, instead of
              silently running free. Live endpoints also require your login
              to be listed in PAYMENT_ASSURANCE_LIVE_LOGINS.
            </p>
            <Card padding="md">
              <div style={formSubgridStyle}>
                <Select label="Live mode" value={liveMode} onChange={(e) => setLiveMode(e.target.value as "coverage" | "checkout")}>
                  <option value="coverage">coverage — test account covers the run</option>
                  <option value="checkout">checkout — real cfpay checkout (testnet)</option>
                </Select>
                <Select label="Schedule kind" value={liveScheduleKind} onChange={(e) => setLiveScheduleKind(e.target.value as ScheduleKind)}>
                  <option value="one_off">one_off</option>
                  <option value="recurring">recurring</option>
                </Select>
              </div>
              <div style={marginTopSmStyle}>
                <Checkbox label="Authorized at submission (one-off only — skips the second approval wait)" checked={liveAuthorized} onChange={(e) => setLiveAuthorized(e.target.checked)} />
              </div>
              <div style={actionBarStyle}>
                <Button variant="primary" onClick={startLive} disabled={liveBusy} loading={liveBusy}>{"Start live run"}</Button>
                <Button variant="secondary" onClick={refreshLive} disabled={liveBusy || !liveStart}>Refresh status</Button>
                <Button variant="secondary" onClick={() => sendLiveEvent("approval", { approved: true })} disabled={liveBusy || !liveStart}>Approve</Button>
                <Button variant="secondary" onClick={() => sendLiveEvent("approval", { approved: false })} disabled={liveBusy || !liveStart}>Reject</Button>
                <Button variant="secondary" onClick={checkLivePayment} disabled={liveBusy || !liveStart}>Check payment and deliver verified</Button>
              </div>
            </Card>
            {liveError && (
              <Notice tone="danger" title="Live run error">
                {liveError}
              </Notice>
            )}
            {liveMessage && (
              <p style={sectionSubtitleStyle}>{liveMessage}</p>
            )}
            {liveStart && (
              <Card>
                <p style={monoSnippetStyle}>
                  workflow: {String(liveStart.workflowId)}
                </p>
                <p style={monoSnippetWithTopMarginStyle}>
                  run: {String(liveStart.runRequestId)} · screener job: {String(liveStart.screenerJobId)} · mode: {String(liveStart.mode)}
                </p>
              </Card>
            )}
            {liveStatus !== null && (
              <Card>
                <pre style={codeBlockStyle}>
                  {JSON.stringify(liveStatus, null, 2)}
                </pre>
              </Card>
            )}
          </PageSection>
        </TabPanel>

        <TabPanel idBase="payment-assurance" tabId="prices" active={activeTab === "prices"} retain>
          <PriceApprovalSection userLogin={userLogin} />
        </TabPanel>

        <TabPanel idBase="payment-assurance" tabId="operators" active={activeTab === "operators"} retain>
          <StoreOperatorsPanel />
        </TabPanel>
      </PageShell>
    </div>
  );
}
