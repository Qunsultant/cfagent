import { Button, Card, EmptyState, PageSection, PageShell, Spinner, Table } from "./components/ui";
import { safePriceFormat } from "./formatters";
import type { TradeRecord } from "../types";
import type { RiskSubject } from "./options/riskManagementEngine";

/**
 * Order execution ledger panel (issue #3050, PR5).
 *
 * Moved out of the Hub's inline markup: the audited trade records table,
 * rendered in its own PageShell inside the hub's shared shell. The markup
 * is the Hub's, unchanged — only the shell wrapper and section are new.
 */
interface LedgerPanelProps {
  orders: TradeRecord[];
  ordersLoading: boolean;
  fetchOrders: () => Promise<void>;
  setRiskSubject: (subject: RiskSubject | null) => void;
}

export function LedgerPanel({ orders, ordersLoading, fetchOrders, setRiskSubject }: LedgerPanelProps) {
  return (
    <PageShell
      title="Order Execution Ledger"
      scopeNote="Audited trade records: every executed order with its broker reference, proposer DID, and date — refresh to re-read the ledger."
    >
      <PageSection title="Order execution ledger">
        <Card className="trading-section">
          <div className="ledger-header-row">
            <h4>📜 Order Execution Ledger (Audited Trade Records)</h4>
            <Button
              variant="secondary"
              disabled={ordersLoading}
              onClick={fetchOrders}
             loading={ordersLoading}>
              {"🔄 Refresh Ledger"}
            </Button>
          </div>

          <div className="ledger-table-wrap">
            <Table
                      columns={[
                        { key: "id", header: "Order ID", render: (ord: any) => <code>{ord.id}</code> },
                        { key: "symbol", header: "Symbol", render: (ord: any) => <span className="ticker-badge">{ord.symbol}</span> },
                        { key: "action", header: "Action", render: (ord: any) => <span className={`action-pill ${ord.action.toLowerCase()}`}>{ord.action}</span> },
                        { key: "qty", header: "Shares", render: (ord: any) => <>{ord.quantity}</> },
                        { key: "price", header: "Price", render: (ord: any) => <>{safePriceFormat(ord.price)}</> },
                        { key: "total", header: "Total Value", render: (ord: any) => <>{ord.totalValue != null && Number.isFinite(Number(ord.totalValue)) ? `$${Number(ord.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</> },
                        { key: "status", header: "Status", render: (ord: any) => <span className={`tx-status-pill ${ord.status}`}>{ord.status.toUpperCase()}</span> },
                        { key: "ref", header: "Broker Ref", render: (ord: any) => <code className="broker-ref-snippet">{ord.orderRef || "—"}</code> },
                        { key: "did", header: "Proposer DID", render: (ord: any) => <code className="did-snippet" title={ord.proposerDid}>{ord.proposerDid.replace("did:agent:openaimp:", "")}</code> },
                        { key: "date", header: "Date & Time", render: (ord: any) => <span className="time-snippet">{new Date(ord.createdAt).toLocaleString()}</span> },
                        { key: "actions", header: "Action", render: (ord: any) => <Button variant="warning" tone="subtle" size="sm" type="button" onClick={() => { setRiskSubject({ title: `${ord.action} ${ord.quantity}x ${ord.symbol}`, underlyingSymbol: ord.symbol, underlyingPrice: ord.price, strategyType: `${ord.action} Trade`, sentiment: ord.action.toLowerCase().includes("buy") ? "bullish" : "bearish", quantity: ord.quantity, positionType: "EQUITY", maxLoss: ord.totalValue, breakevens: [ord.price], breakevenText: `Price: ${safePriceFormat(ord.price)}` }); }} title="Analyze risk profile for this ledger trade">🛡️ Risk</Button> },
                      ]}
                      rows={orders}
                      rowKey={(ord: any) => ord.id}
                      empty={ordersLoading ? <Spinner label="Loading orders ledger" /> : <EmptyState title="No trade orders recorded yet." />}
                    />
          </div>
        </Card>
      </PageSection>
    </PageShell>
  );
}
