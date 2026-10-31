/**
 * Agentic Wallet panel (issue #139) — the UI surface for the Cloudflare
 * Agentic Payments wallet (x402 / MPP), mounted in the Payments tab next
 * to the gateway cards and the multi-gateway transaction ledger.
 *
 * Before this panel the wallet was reachable only via NLQ chat, the MCP
 * `agentic_wallet_status` tool, or a raw API call — a capability with no
 * UI. This panel renders the FULL status from
 * GET /api/payments/agentic/wallet plus the wallet's ledger (the
 * x402/mpp rows of GET /api/payments/transactions).
 *
 * Honesty rules (issues #122/#139):
 *  - The balance is a SIMULATED local-ledger figure. The "Simulated"
 *    badge and the disclosure sentence render INSIDE the balance card,
 *    attached to the number — never as a detachable footnote — and the
 *    disclosure defaults to present when the payload's markers are
 *    missing (see walletSimulated in agenticWalletApi).
 *  - Ledger rows keep their recorded per-entry status: simulated local
 *    records read "Simulated", never "verified" or "settled".
 *  - A failed fetch renders an error state and NO balance — never a
 *    zero or stale figure dressed up as data.
 *
 * The panel is display-only: it never initiates a payment. (The
 * auto-approve limit is shown as the status reports it; changing it
 * stays with the existing NLQ / MCP surfaces.)
 *
 * Issue #2543 adds a "Paid-call receipts" section (GET
 * /api/payments/receipts): the caller's own meter rows, tier-decision
 * audit rows, and joined gateway rows, newest first, each with a
 * provenance chip. Simulated rows read "Simulated", never real; no
 * money total is shown (a sum over mixed provenance would read as
 * revenue); a failed receipts fetch renders an error state, never
 * dressed-up data.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui";
import {
  fetchAgenticLedger,
  fetchAgenticWalletStatus,
  fetchReceipts,
  fmtLedgerTime,
  isSimulatedLedgerEntry,
  ledgerDirectionLabel,
  ledgerStatusLabel,
  receiptKindLabel,
  receiptProvenanceLabel,
  walletDisclosureNote,
  walletSimulated,
  type AgenticLedgerEntry,
  type AgenticWalletStatus,
  type ReceiptEntry,
} from "./agenticWalletApi";
import { fmtUsd } from "./portfolioRiskApi";
import "./agenticWalletPanel.css";

export function AgenticWalletPanel() {
  const [status, setStatus] = useState<AgenticWalletStatus | null>(null);
  const [ledger, setLedger] = useState<AgenticLedgerEntry[] | null>(null);
  const [receipts, setReceipts] = useState<ReceiptEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ledgerError, setLedgerError] = useState("");
  const [receiptsError, setReceiptsError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setLedgerError("");
    setReceiptsError("");
    try {
      const [statusResult, ledgerResult, receiptsResult] = await Promise.allSettled([
        fetchAgenticWalletStatus(),
        fetchAgenticLedger(),
        fetchReceipts(),
      ]);
      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value);
      } else {
        // No status, no numbers: an error state must never be dressed
        // up with a zero balance.
        setStatus(null);
        setError(statusResult.reason?.message || "Failed to load agentic wallet status");
      }
      if (ledgerResult.status === "fulfilled") {
        setLedger(ledgerResult.value);
      } else {
        setLedger(null);
        setLedgerError(ledgerResult.reason?.message || "Failed to load the agentic payment ledger");
      }
      if (receiptsResult.status === "fulfilled") {
        setReceipts(receiptsResult.value.receipts);
      } else {
        setReceipts(null);
        setReceiptsError(receiptsResult.reason?.message || "Failed to load the paid-call receipts");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const simulated = status ? walletSimulated(status) : false;

  return (
    <section className="awp-panel" aria-label="Agentic wallet">
      <div className="awp-header">
        <h4>🤖 Agentic Wallet — x402 / MPP Micropayments</h4>
        {status && simulated && <span className="awp-sim-badge">Simulated</span>}
        <Button type="button" className="awp-refresh" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "🔄 Refresh"}
        </Button>
      </div>

      {loading && !status && !error && <p className="awp-loading">Loading agentic wallet…</p>}

      {error && (
        <div className="awp-error" role="alert">
          ⚠ Agentic wallet unavailable — {error} No balance is shown because the wallet status could not be loaded.
        </div>
      )}

      {status && (
        <>
          <div className="awp-balance-card">
            <div className="awp-balance-row">
              <span className="awp-balance-label">Wallet balance</span>
              <span className="awp-balance-amount">{fmtUsd(status.balanceUSD, 2)} USD</span>
              {simulated && <span className="awp-sim-badge">Simulated</span>}
            </div>
            {simulated && <p className="awp-disclosure">{walletDisclosureNote(status)}</p>}
            <p className="awp-source-line">
              Source: {status.source || "local-ledger"}
              {typeof status.startingCreditUSD === "number" && (
                <> · Starting credit {fmtUsd(status.startingCreditUSD, 2)} USD</>
              )}{" "}
              · Network: {status.network} · Protocol: {String(status.protocol || "hybrid").toUpperCase()}
            </p>
          </div>

          <div className="awp-grid">
            <div className="awp-card">
              <span>Auto-approve limit (per transaction)</span>
              <strong>{fmtUsd(status.autoApproveLimitUSD, 2)} USD</strong>
            </div>
            <div className="awp-card">
              <span>Total spent</span>
              <strong>{fmtUsd(status.totalSpentUSD, 2)} USD</strong>
            </div>
            <div className="awp-card">
              <span>Total earned</span>
              <strong>{fmtUsd(status.totalEarnedUSD, 2)} USD</strong>
            </div>
            <div className="awp-card">
              <span>Payments recorded</span>
              <strong>{status.transactionCount}</strong>
            </div>
          </div>

          <p className="awp-meta">
            Wallet address: <code>{status.walletAddress}</code>
            {status.facilitatorUrl && (
              <>
                {" "}· Facilitator: <code>{status.facilitatorUrl}</code>
              </>
            )}
          </p>

          <div className="awp-ledger">
            <h5>Payment ledger{ledger ? ` (${ledger.length})` : ""}</h5>
            <p className="awp-ledger-sub">
              Locally recorded agentic payments (x402 / MPP rows of the durable transaction ledger), newest first.
            </p>
            {ledgerError && (
              <div className="awp-error" role="alert">
                ⚠ The agentic payment ledger could not be loaded — {ledgerError}
              </div>
            )}
            {!ledgerError && ledger === null && <p className="awp-loading">Loading payment ledger…</p>}
            {!ledgerError && ledger !== null && ledger.length === 0 && (
              <p className="awp-empty">No agentic payments recorded yet — the local ledger is empty.</p>
            )}
            {!ledgerError && ledger !== null && ledger.length > 0 && (
              <div className="awp-ledger-list">
                {ledger.map((entry) => (
                  <div className="awp-entry" key={entry.id || `${entry.createdAt}-${entry.amount}`}>
                    <div className="awp-entry-row">
                      <span className="awp-entry-amount">
                        {fmtUsd(entry.amount, 2)} {entry.currency}
                      </span>
                      <span className="awp-entry-direction">{ledgerDirectionLabel(entry)}</span>
                      <span className={`awp-status-chip${isSimulatedLedgerEntry(entry) ? " simulated" : ""}`}>
                        {ledgerStatusLabel(entry)}
                      </span>
                      <span className="awp-entry-time">{fmtLedgerTime(entry.createdAt)}</span>
                    </div>
                    <div className="awp-entry-meta">
                      {entry.customer && <>Counterparty: {entry.customer} · </>}
                      Gateway: {entry.gateway.toUpperCase()}
                      {entry.note && <> · {entry.note}</>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="awp-ledger">
            <h5>Paid-call receipts{receipts ? ` (${receipts.length})` : ""}</h5>
            <p className="awp-ledger-sub">
              Your own paid calls, tier decisions, and joined gateway rows — newest first. Simulated rows are
              labeled, never shown as real.
            </p>
            {receiptsError && (
              <div className="awp-error" role="alert">
                ⚠ The paid-call receipts could not be loaded — {receiptsError}
              </div>
            )}
            {!receiptsError && receipts === null && <p className="awp-loading">Loading paid-call receipts…</p>}
            {!receiptsError && receipts !== null && receipts.length === 0 && (
              <p className="awp-empty">No receipts recorded yet.</p>
            )}
            {!receiptsError && receipts !== null && receipts.length > 0 && (
              <div className="awp-ledger-list">
                {receipts.map((entry) => (
                  <div className="awp-entry" key={entry.id || `${entry.createdAt}-${entry.kind}`}>
                    <div className="awp-entry-row">
                      <span className="awp-entry-amount">
                        {entry.amountUSD !== null ? `${fmtUsd(entry.amountUSD, 2)} USD` : "—"}
                      </span>
                      <span className="awp-entry-direction">{receiptKindLabel(entry)}</span>
                      <span className={`awp-status-chip${entry.provenance === "simulated" ? " simulated" : ""}`}>
                        {receiptProvenanceLabel(entry)}
                      </span>
                      <span className="awp-entry-time">{fmtLedgerTime(entry.createdAt)}</span>
                    </div>
                    <div className="awp-entry-meta">
                      {entry.tier && <>Tier: {entry.tier} · </>}
                      {entry.protocol && <>Protocol: {entry.protocol.toUpperCase()} · </>}
                      {entry.gateway && <>Gateway: {entry.gateway.toUpperCase()} · </>}
                      {entry.receiptId && <>Receipt: {entry.receiptId}</>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default AgenticWalletPanel;
