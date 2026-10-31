/** @vitest-environment jsdom */
/**
 * Issue #139: Agentic Wallet panel — the agentic wallet's first UI
 * surface (Payments tab). Before this, AgenticWalletStatus was reachable
 * only via NLQ chat, the MCP `agentic_wallet_status` tool, or a raw API
 * call.
 *
 * Harness follows the established panel tests (scanner_panel.test.ts):
 * the REAL apiFetch is driven against a stubbed global fetch, and — per
 * the #71 lesson — the transport contract is mocked, not just the
 * payload: one test runs the wallet fetch through the worker's actual
 * 202 async-job stub → poll statusUrl → completed flow. Component tests
 * render with react-dom/client in jsdom.
 *
 * Honesty pins (issues #122/#139):
 *  - the "Simulated" disclosure renders INSIDE the balance card, next to
 *    the number, and survives a payload whose markers are missing;
 *  - simulated ledger entries read "Simulated" — never verified/settled;
 *  - a failed fetch renders an error state and NO balance.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgenticWalletPanel } from "../src/client/AgenticWalletPanel";
import {
  AGENTIC_WALLET_DISCLOSURE_FALLBACK,
  fetchAgenticLedger,
  fetchAgenticWalletStatus,
  fetchReceipts,
  isSimulatedLedgerEntry,
  ledgerStatusLabel,
  receiptKindLabel,
  receiptProvenanceLabel,
  walletSimulated,
} from "../src/client/agenticWalletApi";
import type { AgenticWalletStatus } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures typed against the real server type so a backend shape change
// breaks these tests on purpose.
const WALLET: AgenticWalletStatus = {
  walletAddress: "0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B",
  network: "base-sepolia",
  balanceUSD: 47.5,
  autoApproveLimitUSD: 0.05,
  facilitatorUrl: "https://x402.org/facilitator",
  protocol: "hybrid",
  totalSpentUSD: 2.55,
  totalEarnedUSD: 0.05,
  transactionCount: 3,
  simulated: true,
  source: "local-ledger",
  startingCreditUSD: 50,
  note: "Simulated local-ledger balance: a $50.00 local starting credit plus/minus locally recorded agentic payment entries. This service does not read any on-chain wallet balance.",
};

const SIMULATED_ENTRY = {
  id: "tx_rcpt_out_1",
  sessionId: "default_trader",
  action: "micropayment",
  amount: 2.5,
  currency: "USD",
  customer: "0xRecipientAddress",
  gateway: "x402",
  gatewayRef: "rcpt_out_1",
  status: "simulated",
  checkoutUrl: "/api/premium/market-research",
  proposerDid: "did:agent:openaimp:trading",
  proofSignature: "none (simulated local record — no signature)",
  note: "Local record of a SIMULATED outbound payment. [Simulated local payment record — no real payment was made or verified.]",
  createdAt: "2026-10-17T12:00:00.000Z",
  updatedAt: "2026-10-17T12:00:00.000Z",
};

const COMPLETED_ENTRY = {
  id: "tx_rcpt_in_1",
  sessionId: "default_trader",
  action: "agentic_payment",
  amount: 0.05,
  currency: "USD",
  customer: "0xPayerAddress",
  gateway: "mpp",
  gatewayRef: "rcpt_in_1",
  status: "completed",
  checkoutUrl: "",
  proposerDid: "did:agent:openaimp:payments",
  proofSignature: "sig_real",
  note: "Cloudflare Agentic Payment (MPP) on base-sepolia",
  createdAt: "2026-10-17T11:00:00.000Z",
  updatedAt: "2026-10-17T11:00:00.000Z",
};

const STRIPE_ENTRY = {
  ...COMPLETED_ENTRY,
  id: "tx_stripe_1",
  action: "charge",
  customer: "Stripe Only Customer",
  gateway: "stripe",
  status: "completed",
  note: "Stripe checkout — not an agentic wallet entry",
};

interface StubState {
  wallet?: unknown;
  walletStatus?: number;
  transactions?: unknown;
  transactionsStatus?: number;
  walletViaJob?: boolean;
  receipts?: unknown;
  receiptsStatus?: number;
}

function installFetch(state: StubState) {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/jobs/")) {
      return Response.json({
        jobId: "job-wallet",
        capability: "http.request",
        status: "completed",
        statusUrl: "/api/jobs/job-wallet",
        responseStatus: 200,
        result: { body: JSON.stringify(state.wallet), headers: { "content-type": "application/json" } },
      });
    }
    if (url.endsWith("/api/payments/agentic/wallet")) {
      if (state.walletViaJob) {
        return Response.json({ jobId: "job-wallet", status: "queued", statusUrl: "/api/jobs/job-wallet" }, { status: 202 });
      }
      return Response.json(state.wallet, { status: state.walletStatus ?? 200 });
    }
    if (url.endsWith("/api/payments/transactions")) {
      return Response.json(state.transactions, { status: state.transactionsStatus ?? 200 });
    }
    if (url.endsWith("/api/payments/receipts")) {
      return Response.json(state.receipts ?? receiptsPayload([]), {
        status: state.receiptsStatus ?? 200,
      });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function ledgerPayload(transactions: unknown[]) {
  return { count: transactions.length, transactions, summary: { totalVolume: 0, completedCount: 0, pendingCount: 0, verifiedDidCount: 0 } };
}

// DOM helpers ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 600)}`);
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AgenticWalletPanel));
  });
  await flush(60);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

// API client + transport contract -------------------------------------------

describe("agenticWalletApi vs the async-job transport (issue #71 contract)", () => {
  it("fetchAgenticWalletStatus polls the 202 job stub and resolves the real status", async () => {
    installFetch({ wallet: WALLET, walletViaJob: true });
    const status = await fetchAgenticWalletStatus();
    expect(status.balanceUSD).toBe(47.5);
    expect(status.simulated).toBe(true);
    expect(status.source).toBe("local-ledger");
  });

  it("fetchAgenticWalletStatus rejects a stub-shaped body instead of returning it to the renderer", async () => {
    installFetch({ wallet: { jobId: "job-1", status: "queued", statusUrl: "/api/jobs/job-1" } });
    await expect(fetchAgenticWalletStatus()).rejects.toThrow(/response shape/);
  });

  it("fetchAgenticWalletStatus surfaces the server's error message on HTTP failure", async () => {
    installFetch({ wallet: { error: "wallet store unavailable" }, walletStatus: 500 });
    await expect(fetchAgenticWalletStatus()).rejects.toThrow(/wallet store unavailable/);
  });

  it("fetchAgenticLedger keeps only the x402/mpp wallet rows, newest first as served", async () => {
    installFetch({ transactions: ledgerPayload([SIMULATED_ENTRY, STRIPE_ENTRY, COMPLETED_ENTRY]) });
    const ledger = await fetchAgenticLedger();
    expect(ledger.map((e) => e.id)).toEqual(["tx_rcpt_out_1", "tx_rcpt_in_1"]);
    expect(ledger[0].status).toBe("simulated");
    expect(ledger[1].gateway).toBe("mpp");
  });
});

// Disclosure helpers ------------------------------------------------------------

describe("wallet disclosure helpers (issue #139)", () => {
  it("walletSimulated discloses for the real payload and for missing markers, and only an explicit false opts out", () => {
    expect(walletSimulated(WALLET)).toBe(true);
    expect(walletSimulated({ simulated: undefined as never, source: undefined as never })).toBe(true);
    expect(walletSimulated({ simulated: false, source: "on-chain" as never })).toBe(false);
    // A local-ledger source is simulated by definition, even against a stray false.
    expect(walletSimulated({ simulated: false, source: "local-ledger" })).toBe(true);
  });

  it("simulated ledger entries are labelled Simulated — never Verified or Settled", () => {
    expect(isSimulatedLedgerEntry(SIMULATED_ENTRY)).toBe(true);
    expect(ledgerStatusLabel(SIMULATED_ENTRY)).toBe("Simulated");
    expect(ledgerStatusLabel(COMPLETED_ENTRY)).toBe("Completed");
    // The note marker alone also marks an entry simulated.
    expect(isSimulatedLedgerEntry({ status: "completed", note: SIMULATED_ENTRY.note })).toBe(true);
  });
});

// Component ---------------------------------------------------------------------

describe("AgenticWalletPanel (issue #139)", () => {
  it("renders the full status with the Simulated disclosure attached to the balance", async () => {
    installFetch({ wallet: WALLET, transactions: ledgerPayload([SIMULATED_ENTRY, COMPLETED_ENTRY]) });
    await renderPanel();
    await waitForText("$47.50");

    const text = container.textContent || "";
    expect(text).toContain("Wallet balance");
    expect(text).toContain("USD");
    expect(text).toContain("local-ledger");
    expect(text).toContain("does not read any on-chain wallet balance");
    expect(text).toContain("$0.05"); // auto-approve limit
    expect(text).toContain("$2.55"); // total spent
    expect(text).toContain("base-sepolia");
    expect(text).toContain(WALLET.walletAddress);

    // Inseparability: the balance card itself carries the badge + amount.
    const card = container.querySelector(".awp-balance-card");
    expect(card?.textContent).toContain("$47.50");
    expect(card?.textContent).toContain("Simulated");
    expect(card?.textContent).toContain("Simulated local-ledger balance");
  });

  it("renders ledger entries with per-entry statuses, counterparties and notes", async () => {
    installFetch({ wallet: WALLET, transactions: ledgerPayload([SIMULATED_ENTRY, STRIPE_ENTRY, COMPLETED_ENTRY]) });
    await renderPanel();
    await waitForText("Payment ledger");

    const text = container.textContent || "";
    expect(text).toContain("0xRecipientAddress");
    expect(text).toContain("0xPayerAddress");
    expect(text).toContain("$2.50");
    expect(text).toContain("Spent");
    expect(text).toContain("Earned");
    // The stripe row is not part of the wallet's ledger.
    expect(text).not.toContain("Stripe Only Customer");

    const entries = [...container.querySelectorAll(".awp-entry")];
    expect(entries).toHaveLength(2);
    const simulatedRow = entries.find((e) => e.textContent?.includes("0xRecipientAddress"));
    expect(simulatedRow?.textContent).toContain("Simulated");
    expect(simulatedRow?.textContent).not.toContain("Verified");
    expect(simulatedRow?.textContent).not.toContain("Settled");
    const completedRow = entries.find((e) => e.textContent?.includes("0xPayerAddress"));
    expect(completedRow?.textContent).toContain("Completed");
  });

  it("renders the error state — and no balance — when the wallet fetch fails", async () => {
    installFetch({ wallet: { error: "wallet store unavailable" }, walletStatus: 500, transactions: ledgerPayload([]) });
    await renderPanel();
    await waitForText("Agentic wallet unavailable");

    const text = container.textContent || "";
    expect(text).toContain("wallet store unavailable");
    expect(container.querySelector(".awp-balance-amount")).toBeNull();
    expect(container.querySelector(".awp-balance-card")).toBeNull();
    expect(text).not.toContain("$0.00");
  });

  it("renders the honest empty state when the ledger has no entries", async () => {
    installFetch({ wallet: WALLET, transactions: ledgerPayload([]) });
    await renderPanel();
    await waitForText("No agentic payments recorded yet");
    expect(container.textContent).toContain("$47.50");
  });

  it("keeps the Simulated disclosure when the payload omits the simulated markers", async () => {
    const bare = { ...WALLET } as Record<string, unknown>;
    delete bare.simulated;
    delete bare.source;
    delete bare.note;
    installFetch({ wallet: bare, transactions: ledgerPayload([]) });
    await renderPanel();
    await waitForText("$47.50");

    const card = container.querySelector(".awp-balance-card");
    expect(card?.textContent).toContain("Simulated");
    expect(card?.textContent).toContain(AGENTIC_WALLET_DISCLOSURE_FALLBACK);
  });

  it("surfaces a ledger failure in the ledger section while the wallet still renders", async () => {
    installFetch({
      wallet: WALLET,
      transactions: { error: "ledger read failed" },
      transactionsStatus: 500,
    });
    await renderPanel();
    await waitForText("could not be loaded");

    const text = container.textContent || "";
    expect(text).toContain("$47.50");
    expect(text).toContain("ledger read failed");
    expect(text).not.toContain("No agentic payments recorded yet");
  });
});

// Paid-call receipts (issue #2543) -----------------------------------------

function receiptsPayload(receipts: unknown[]) {
  return {
    userLogin: "owner",
    limit: 50,
    receipts,
    counts: { meter: 0, tier: 0, transaction: 0, real: 0, simulated: 0, audit: 0 },
  };
}

const METER_RECEIPT = {
  id: "use_rcpt_1",
  kind: "meter",
  createdAt: "2026-10-31T10:00:00.000Z",
  provenance: "real",
  provenanceNote: "Verified x402 payment served through the premium gate",
  receiptId: "rcpt_1",
  amountUSD: 0.05,
  tier: "Free",
  protocol: "x402",
  gateway: null,
  status: "served",
};

const TIER_RECEIPT = {
  id: "e1",
  kind: "tier",
  createdAt: "2026-10-31T10:05:00.000Z",
  provenance: "audit",
  provenanceNote: "Tier-decision audit row (evidence of a decision, not a payment)",
  receiptId: "rcpt_1",
  amountUSD: 0.05,
  tier: "Free",
  protocol: "x402",
  gateway: null,
  status: null,
};

const SIMULATED_RECEIPT = {
  id: "tx_sim_1",
  kind: "transaction",
  createdAt: "2026-10-31T09:00:00.000Z",
  provenance: "simulated",
  provenanceNote: "Simulated local record — no real payment was made or verified",
  receiptId: "sim_1",
  amountUSD: 0.05,
  tier: null,
  protocol: null,
  gateway: "mpp",
  status: "simulated",
};

describe("Paid-call receipts (issue #2543)", () => {
  it("fetchReceipts returns the receipt rows in served order", async () => {
    installFetch({ receipts: receiptsPayload([TIER_RECEIPT, METER_RECEIPT, SIMULATED_RECEIPT]) });
    const data = await fetchReceipts();
    expect(data.receipts.map((r) => r.id)).toEqual(["e1", "use_rcpt_1", "tx_sim_1"]);
    expect(data.userLogin).toBe("owner");
  });

  it("receipt labels name the kind and the provenance, never Verified for simulated rows", () => {
    expect(receiptKindLabel({ kind: "meter" })).toBe("Paid call");
    expect(receiptKindLabel({ kind: "tier" })).toBe("Tier decision");
    expect(receiptKindLabel({ kind: "transaction" })).toBe("Ledger entry");
    expect(receiptProvenanceLabel({ provenance: "real" })).toBe("Real");
    expect(receiptProvenanceLabel({ provenance: "simulated" })).toBe("Simulated");
    expect(receiptProvenanceLabel({ provenance: "audit" })).toBe("Audit");
  });

  it("renders receipt rows with kind labels and provenance chips, simulated chip on the simulated row", async () => {
    installFetch({
      wallet: WALLET,
      transactions: ledgerPayload([]),
      receipts: receiptsPayload([TIER_RECEIPT, METER_RECEIPT, SIMULATED_RECEIPT]),
    });
    await renderPanel();
    await waitForText("Paid-call receipts");

    const text = container.textContent || "";
    expect(text).toContain("Paid-call receipts (3)");
    expect(text).toContain("Paid call");
    expect(text).toContain("Tier decision");
    expect(text).toContain("Ledger entry");
    expect(text).toContain("Real");
    expect(text).toContain("Audit");
    expect(text).toContain("Receipt: rcpt_1");
    // The simulated chip carries the simulated class; the row is never labeled Real.
    const simChip = container.querySelector(".awp-status-chip.simulated");
    expect(simChip?.textContent).toBe("Simulated");
    // No money total: a sum over mixed provenance would read as revenue.
    expect(text).not.toContain("Total receipts");
  });

  it("renders the honest empty state when no receipts exist", async () => {
    installFetch({ wallet: WALLET, transactions: ledgerPayload([]), receipts: receiptsPayload([]) });
    await renderPanel();
    await waitForText("No receipts recorded yet");
    expect(container.textContent).toContain("$47.50");
  });

  it("surfaces a receipts failure in the receipts section while the wallet still renders", async () => {
    installFetch({
      wallet: WALLET,
      transactions: ledgerPayload([]),
      receipts: { error: "receipts read failed" },
      receiptsStatus: 500,
    });
    await renderPanel();
    await waitForText("could not be loaded");

    const text = container.textContent || "";
    expect(text).toContain("$47.50");
    expect(text).toContain("receipts read failed");
    expect(text).not.toContain("No receipts recorded yet");
  });
});
