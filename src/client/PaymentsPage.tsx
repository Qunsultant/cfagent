/**
 * Issue #2149 (epic #2150 slice 1) — payments as a shell page.
 *
 * Moved out of Chat's TAB_CONTENT with behavior preserved: the same
 * endpoints, payloads, and messages. The six stacked blocks become five
 * URL-synced tabs (?view=) with visited tabs retained mounted-hidden,
 * and the page itself is shell-retained (SHELL_CONTENT in Chat), so
 * switching away and back preserves state. Layout comes from primitives
 * + token utilities only: no bespoke page classes, no referrals-tab
 * classes, no raw form labels — FieldShell labels the form, Badge is
 * the one pill pattern, EmptyState covers the empty ledger.
 *
 * White-label: styling resolves through tokens only; the only identity
 * strings here are functional agent DIDs, which are not brand surface.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FieldShell,
  Modal,
  Notice,
  PageShell,
  Select,
  Tabs,
  TabPanel,
  TextInput,
} from "./components/ui";
import type { TabOption } from "./components/ui";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { ErrorBoundary } from "./ErrorBoundary";
import { AgenticWalletPanel } from "./AgenticWalletPanel";
import { didProofSignatureDisplay } from "./didProofCard";
import type { GatewayInfo, TransactionItem, User } from "./chat/types";

type PaymentsTab = "gateways" | "stats" | "wallet" | "create" | "ledger";

const PAYMENTS_TABS: TabOption<PaymentsTab>[] = [
  { id: "gateways", label: "Gateways" },
  { id: "stats", label: "Stats" },
  { id: "wallet", label: "Wallet" },
  { id: "create", label: "Create" },
  { id: "ledger", label: "Ledger" },
];

function isPaymentsTab(value: unknown): value is PaymentsTab {
  return (
    value === "gateways" ||
    value === "stats" ||
    value === "wallet" ||
    value === "create" ||
    value === "ledger"
  );
}

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "completed") return "success";
  if (status === "awaiting_confirmation") return "warning";
  if (status === "rejected") return "danger";
  return "neutral";
}

export function PaymentsPage({ active, user }: { active: boolean; user: User }) {
  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<PaymentsTab>({
    param: "view",
    isValid: isPaymentsTab,
    defaultTab: "gateways",
  });

  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [gateways, setGateways] = useState<GatewayInfo[]>([]);
  const [paymentSummary, setPaymentSummary] = useState({
    totalVolume: 0,
    completedCount: 0,
    pendingCount: 0,
    verifiedDidCount: 0,
  });
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [selectedProofTx, setSelectedProofTx] = useState<TransactionItem | null>(null);
  const [creatingPayment, setCreatingPayment] = useState(false);
  const [newPayAmount, setNewPayAmount] = useState("25.00");
  const [newPayCurrency, setNewPayCurrency] = useState("USD");
  const [newPayCustomer, setNewPayCustomer] = useState(user.name || "Client");
  const [newPayGateway, setNewPayGateway] = useState<"stripe" | "paypal" | "lemonsqueezy">("stripe");
  const [newPayDesc, setNewPayDesc] = useState("");
  const [paySuccessMsg, setPaySuccessMsg] = useState("");
  const [payErrorMsg, setPayErrorMsg] = useState("");
  const fetchedRef = useRef(false);

  const fetchPaymentsData = async () => {
    setPaymentsLoading(true);
    try {
      const [txResp, gwResp] = await Promise.all([
        fetch("/api/payments/transactions").then((r) => r.json() as Promise<{ transactions?: TransactionItem[]; summary?: any }>).catch(() => ({ transactions: [], summary: {} })),
        fetch("/api/payments/gateways").then((r) => r.json() as Promise<{ gateways?: GatewayInfo[] }>).catch(() => ({ gateways: [] })),
      ]);
      setTransactions(txResp.transactions || []);
      if (txResp.summary) {
        setPaymentSummary({
          totalVolume: Number(txResp.summary.totalVolume || 0),
          completedCount: Number(txResp.summary.completedCount || 0),
          pendingCount: Number(txResp.summary.pendingCount || 0),
          verifiedDidCount: Number(txResp.summary.verifiedDidCount || 0),
        });
      }
      setGateways(gwResp.gateways || []);
    } finally {
      setPaymentsLoading(false);
    }
  };

  // Shell-retained pages mount once and stay mounted: fetch on first
  // activation (the old tab-change fetch), then only via Refresh.
  useEffect(() => {
    if (active && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchPaymentsData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handleCreatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setPayErrorMsg("");
    setPaySuccessMsg("");
    const amt = parseFloat(newPayAmount);
    if (isNaN(amt) || amt <= 0) {
      setPayErrorMsg("Please enter a valid payment amount");
      return;
    }
    setCreatingPayment(true);
    try {
      const res = await fetch("/api/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          currency: newPayCurrency,
          customer: newPayCustomer.trim(),
          gateway: newPayGateway,
          description: newPayDesc.trim(),
        }),
      });
      const data = await res.json() as { transaction?: TransactionItem; error?: string };
      if (data.transaction) {
        setTransactions((prev) => [data.transaction!, ...prev]);
        setPaymentSummary((prev) => ({
          ...prev,
          totalVolume: prev.totalVolume + amt,
          completedCount: prev.completedCount + 1,
          verifiedDidCount: prev.verifiedDidCount + 1,
        }));
        setPaySuccessMsg(`🎉 Payment initialized on ${newPayGateway.toUpperCase()} with Agent DID attestation!`);
        setTimeout(() => setPaySuccessMsg(""), 5000);
      } else {
        setPayErrorMsg(data.error || "Failed to create payment");
      }
    } catch (err: any) {
      setPayErrorMsg(err.message || "Failed to create payment");
    } finally {
      setCreatingPayment(false);
    }
  };

  const handleAuthorizeDraft = async (draftId: string, decision: "approved" | "rejected") => {
    try {
      const res = await fetch("/api/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, decision }),
      });
      const data = await res.json() as { success?: boolean; status?: string; checkoutUrl?: string };
      if (data.success) {
        setTransactions((prev) =>
          prev.map((t) => (t.id === draftId ? { ...t, status: (decision === "approved" ? "completed" : "rejected") as any, checkoutUrl: data.checkoutUrl || t.checkoutUrl } : t))
        );
        fetchPaymentsData();
      }
    } catch {
      // Ignore
    }
  };

  return (
    <PageShell
      title="Payments & Decentralized Identifiers (DID)"
      scopeNote="Enterprise payment execution across Stripe, PayPal, and Lemon Squeezy with verifiable W3C Agent DIDs, cryptographic attestation, and human-in-the-loop authorization."
    >
      <div className="ui-row">
        <div className="ui-row">
          <Badge tone="trade">🤖 <code>did:agent:openaimp:payments</code> · Signer</Badge>
          <Badge tone="neutral">⚖️ <code>did:agent:openaimp:judge</code> · Evaluator</Badge>
          <Badge tone="accent">👤 <code>did:user:github:{user.login}</code> · Authorizer</Badge>
        </div>
        <span className="ui-push">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchPaymentsData}
            disabled={paymentsLoading}
           loading={paymentsLoading}>
            {"🔄 Refresh"}
          </Button>
        </span>
      </div>

      <Tabs
        tabs={PAYMENTS_TABS}
        value={activeTab}
        onChange={handleTabChange}
        idBase="payments"
        ariaLabel="Payments sections"
      />

      {visitedTabs.has("gateways") && (
        <TabPanel idBase="payments" tabId="gateways" active={activeTab === "gateways"} retain>
          <div className="ui-stack">
            {gateways.map((gw) => (
              <Card padding="none" key={gw.id}>
                <div className="ui-row">
                  <span>{gw.id === "stripe" ? "💳" : gw.id === "paypal" ? "🅿️" : "🍋"}</span>
                  <strong>{gw.name}</strong>
                  <span className="ui-push">
                    <Badge tone={gw.mode === "live" ? "success" : "neutral"} size="sm">
                      {gw.mode.toUpperCase()}
                    </Badge>
                  </span>
                </div>
                <div className="ui-row ui-mt-1">
                  {gw.capabilities.map((c, i) => (
                    <Badge key={i} tone="neutral" size="sm">{c}</Badge>
                  ))}
                </div>
                <div className="ui-meta-sm ui-mt-1">
                  <code>Webhook: /api/payments/webhook?provider={gw.id}</code>
                </div>
              </Card>
            ))}
          </div>
        </TabPanel>
      )}

      {visitedTabs.has("stats") && (
        <TabPanel idBase="payments" tabId="stats" active={activeTab === "stats"} retain>
          <div className="ui-stat-grid">
            <Card padding="none" highlight>
              <div className="ui-row">
                <span>💰</span>
                <div>
                  <div><strong>${paymentSummary.totalVolume.toFixed(2)}</strong></div>
                  <div className="ui-meta-sm">Total Settled Volume</div>
                </div>
              </div>
            </Card>
            <Card padding="none">
              <div className="ui-row">
                <span>⚡</span>
                <div>
                  <div><strong>{paymentSummary.completedCount}</strong></div>
                  <div className="ui-meta-sm">Settled Transactions</div>
                </div>
              </div>
            </Card>
            <Card padding="none">
              <div className="ui-row">
                <span>🛡️</span>
                <div>
                  <div><strong>{paymentSummary.pendingCount}</strong></div>
                  <div className="ui-meta-sm">Pending Authorizations</div>
                </div>
              </div>
            </Card>
            <Card padding="none">
              <div className="ui-row">
                <span>🔐</span>
                <div>
                  <div><strong>{paymentSummary.verifiedDidCount}</strong></div>
                  <div className="ui-meta-sm">Verifiable DID Signatures</div>
                </div>
              </div>
            </Card>
          </div>
        </TabPanel>
      )}

      {visitedTabs.has("wallet") && (
        <TabPanel idBase="payments" tabId="wallet" active={activeTab === "wallet"} retain>
          <ErrorBoundary label="Agentic Wallet panel">
            <AgenticWalletPanel />
          </ErrorBoundary>
        </TabPanel>
      )}

      {visitedTabs.has("create") && (
        <TabPanel idBase="payments" tabId="create" active={activeTab === "create"} retain>
          <form onSubmit={handleCreatePayment}>
            <div className="ui-stack">
              <h4>➕ Initialize Payment / Checkout Link</h4>
              <p className="ui-meta">Issue a new payment intent across Stripe, PayPal, or Lemon Squeezy with cryptographic Agent DID attestation.</p>
              {paySuccessMsg && <Notice tone="success">{paySuccessMsg}</Notice>}
              {payErrorMsg && <Notice tone="danger">{payErrorMsg}</Notice>}
              <FieldShell id="pay-gateway" label="Payment Gateway Provider *">
                <Select
                  value={newPayGateway}
                  onChange={(e) => setNewPayGateway(e.target.value as any)}
                >
                  <option value="stripe">Stripe (Card, Elements, Checkout)</option>
                  <option value="paypal">PayPal (Digital Wallet & Pay Later)</option>
                  <option value="lemonsqueezy">Lemon Squeezy (Merchant of Record)</option>
                </Select>
              </FieldShell>
              <div className="ui-form-row">
                <FieldShell id="pay-amount" label="Amount *">
                  <TextInput
                    type="number"
                    step="0.01"
                    min="1"
                    placeholder="25.00"
                    value={newPayAmount}
                    onChange={(e) => setNewPayAmount(e.target.value)}
                    required
                  />
                </FieldShell>
                <FieldShell id="pay-currency" label="Currency">
                  <Select
                    value={newPayCurrency}
                    onChange={(e) => setNewPayCurrency(e.target.value)}
                  >
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="CAD">CAD ($)</option>
                  </Select>
                </FieldShell>
              </div>
              <FieldShell id="pay-customer" label="Customer Name or Account ID *">
                <TextInput
                  type="text"
                  placeholder="e.g. Acme Logistics or user@example.com"
                  value={newPayCustomer}
                  onChange={(e) => setNewPayCustomer(e.target.value)}
                  required
                />
              </FieldShell>
              <FieldShell id="pay-desc" label="Purpose / Description">
                <TextInput
                  type="text"
                  placeholder="Describe what this payment is for"
                  value={newPayDesc}
                  onChange={(e) => setNewPayDesc(e.target.value)}
                />
              </FieldShell>
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={creatingPayment || !newPayAmount || !newPayCustomer.trim()}
                 loading={creatingPayment}>
                  {`🚀 Create ${newPayGateway.toUpperCase()} Checkout Link`}
                </Button>
              </div>
            </div>
          </form>
        </TabPanel>
      )}

      {visitedTabs.has("ledger") && (
        <TabPanel idBase="payments" tabId="ledger" active={activeTab === "ledger"} retain>
          <h4>📋 Transaction Ledger & DID Provenance ({transactions.length})</h4>
          <p className="ui-meta">Stateful record of all payment operations, drafts, and cryptographic audit proofs.</p>
          {transactions.length === 0 ? (
            <EmptyState
              icon="💳"
              title="No transactions recorded yet."
              description="Ask the AI assistant to draft a payment or use the form on the left."
            />
          ) : (
            <div className="ui-stack">
              {transactions.map((tx) => (
                <Card padding="none" key={tx.id}>
                  <div className="ui-row">
                    <Badge tone="neutral" size="sm">{tx.gateway.toUpperCase()}</Badge>
                    <Badge tone={statusTone(tx.status)} size="sm">
                      {tx.status.replace("_", " ").toUpperCase()}
                    </Badge>
                  </div>
                  <div className="ui-row ui-mt-1">
                    <strong>
                      {tx.action.toUpperCase()}: ${tx.amount.toFixed(2)} {tx.currency}
                    </strong>
                    <span className="ui-meta-sm ui-push">for {tx.customer}</span>
                  </div>
                  {tx.note && <p className="ui-meta ui-mt-1">📝 {tx.note}</p>}
                  <div className="ui-meta-sm ui-mt-1">
                    <span>DID SIGNED: </span>
                    <code>{tx.proposerDid}</code>
                  </div>
                  {tx.status === "awaiting_confirmation" && (
                    <div className="ui-stack ui-mt-1">
                      <Notice tone="warning">🛡️ Human Authorization Required before gateway settlement.</Notice>
                      <div className="ui-row">
                        <Button
                          variant="primary"
                          tone="subtle"
                          onClick={() => handleAuthorizeDraft(tx.id, "approved")}
                        >
                          ✅ Authorize & Settle
                        </Button>
                        <Button
                          variant="danger"
                          tone="subtle"
                          onClick={() => handleAuthorizeDraft(tx.id, "rejected")}
                        >
                          ❌ Reject
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="ui-row ui-mt-1">
                    {tx.checkoutUrl ? (
                      <a
                        href={tx.checkoutUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ui-link"
                      >
                        Checkout Link ↗
                      </a>
                    ) : (
                      <span className="ui-meta-sm">{new Date(tx.createdAt).toLocaleTimeString()}</span>
                    )}
                    <span className="ui-push">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedProofTx(tx)}
                        title="Inspect Cryptographic DID Proof"
                      >
                        🔐 Inspect DID Proof
                      </Button>
                    </span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabPanel>
      )}

      {selectedProofTx && (
        <Modal open size="none" panelClassName="did-modal-card" title="🔐 W3C Agent Decentralized Identifier (DID) Proof" onClose={() => setSelectedProofTx(null)}>
          <FieldShell id="proof-id" label="Transaction Draft ID">
            <code>{selectedProofTx.id}</code>
          </FieldShell>
          <FieldShell id="proof-proposer" label="Proposer Agent DID">
            <code>{selectedProofTx.proposerDid}</code>
          </FieldShell>
          <FieldShell id="proof-authorizer" label="Human Authorizer DID">
            <code>{selectedProofTx.authorizerDid || `did:user:github:${user.login}`}</code>
          </FieldShell>
          <FieldShell id="proof-executor" label="Executor Agent DID">
            <code>did:agent:openaimp:orchestrator</code>
          </FieldShell>
          <FieldShell id="proof-gateway" label="Settlement Gateway">
            <code>{selectedProofTx.gateway.toUpperCase()}</code>
          </FieldShell>
          <FieldShell id="proof-sig" label="Cryptographic Signature">
            <pre className="ui-meta-sm">{didProofSignatureDisplay(selectedProofTx.proofSignature)}</pre>
          </FieldShell>
          <FieldShell id="proof-created" label="Created">
            <code>{selectedProofTx.createdAt}</code>
          </FieldShell>
        </Modal>
      )}
    </PageShell>
  );
}
