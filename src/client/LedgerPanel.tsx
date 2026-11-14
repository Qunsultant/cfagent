import { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Flex,
  PageSection,
  PageShell,
  Spinner,
  TabPanel,
  Table,
  Tabs,
  type TableColumn,
  type TabOption,
} from "./components/ui";
import { safePriceFormat } from "./formatters";
import {
  LEDGER_SORT_DEFAULT,
  ledgerBrokerId,
  ledgerBrokerLabel,
  ledgerBrokerTabs,
  nextLedgerSort,
  sortLedgerRows,
  type LedgerSort,
  type LedgerSortKey,
} from "./ledgerTable";
import type { TradeRecord } from "../types";
import type { RiskSubject } from "./options/riskManagementEngine";

/**
 * Order execution ledger panel (issue #3050, PR5).
 *
 * Moved out of the Hub's inline markup: the audited trade records table,
 * rendered in its own PageShell inside the hub's shared shell. The markup
 * is the Hub's, unchanged — only the shell wrapper and section are new.
 *
 * Slice 1 of the ledger enhancement: an Overview tab with every loaded
 * row plus one tab per broker present in the rows, a broker column on
 * every tab, and sortable data columns. Rows without a recorded broker
 * resolve to the legacy broker (see ledgerTable.ts); the Risk action
 * column is an action, not data, and stays unsorted.
 */
interface LedgerPanelProps {
  orders: TradeRecord[];
  ordersLoading: boolean;
  fetchOrders: () => Promise<void>;
  setRiskSubject: (subject: RiskSubject | null) => void;
}

/**
 * A sortable column header. The `th` carries `aria-sort` (from the column
 * config); this button is the control. The indicator is decorative — the
 * button's accessible name states the current direction.
 */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: LedgerSortKey;
  sort: LedgerSort;
  onSort: (key: LedgerSortKey) => void;
}) {
  const active = sort.key === sortKey;
  const direction = sort.dir === "asc" ? "ascending" : "descending";
  return (
    <Button
      variant="ghost"
      size="sm"
      className="ui-table-sort"
      onClick={() => onSort(sortKey)}
      title={active ? `Sorted ${direction} — click to reverse` : `Sort by ${label}`}
      aria-label={active ? `${label}, sorted ${direction}. Reverse order` : `Sort by ${label}`}
    >
      {label}
      <span className="ui-table-sort-indicator" aria-hidden="true">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </Button>
  );
}

export function LedgerPanel({ orders, ordersLoading, fetchOrders, setRiskSubject }: LedgerPanelProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const [sort, setSort] = useState<LedgerSort>(LEDGER_SORT_DEFAULT);
  const brokerTabs = useMemo(() => ledgerBrokerTabs(orders), [orders]);
  const tabs: TabOption<string>[] = useMemo(
    () => [{ id: "overview", label: "Overview" }, ...brokerTabs.map((tab) => ({ id: tab.id, label: tab.label }))],
    [brokerTabs],
  );
  const effectiveTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : "overview";

  const handleSort = useCallback((key: LedgerSortKey) => {
    setSort((current) => nextLedgerSort(current, key));
  }, []);

  const columns = useMemo<TableColumn<TradeRecord>[]>(() => {
    const ariaSort = (key: LedgerSortKey) =>
      sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
    const header = (label: string, key: LedgerSortKey) => (
      <SortHeader label={label} sortKey={key} sort={sort} onSort={handleSort} />
    );
    return [
      { key: "id", header: header("Order ID", "id"), ariaSort: ariaSort("id"), render: (ord) => <code>{ord.id}</code> },
      { key: "symbol", header: header("Symbol", "symbol"), ariaSort: ariaSort("symbol"), render: (ord) => <Badge tone="neutral">{ord.symbol}</Badge> },
      { key: "action", header: header("Action", "action"), ariaSort: ariaSort("action"), render: (ord) => <Badge tone={ord.action.toLowerCase().includes("buy") ? "success" : "danger"}>{ord.action}</Badge> },
      { key: "qty", header: header("Shares", "quantity"), ariaSort: ariaSort("quantity"), render: (ord) => <>{ord.quantity}</> },
      { key: "price", header: header("Price", "price"), ariaSort: ariaSort("price"), render: (ord) => <>{safePriceFormat(ord.price)}</> },
      { key: "total", header: header("Total Value", "totalValue"), ariaSort: ariaSort("totalValue"), render: (ord) => <>{ord.totalValue != null && Number.isFinite(Number(ord.totalValue)) ? `$${Number(ord.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</> },
      { key: "status", header: header("Status", "status"), ariaSort: ariaSort("status"), render: (ord) => <Badge tone={String(ord.status) === "completed" ? "success" : String(ord.status) === "authorized" ? "accent" : "neutral"}>{ord.status.toUpperCase()}</Badge> },
      { key: "broker", header: header("Broker", "broker"), ariaSort: ariaSort("broker"), render: (ord) => <>{ledgerBrokerLabel(ord)}</> },
      { key: "ref", header: header("Broker Ref", "orderRef"), ariaSort: ariaSort("orderRef"), render: (ord) => <code>{ord.orderRef || "—"}</code> },
      { key: "did", header: header("Proposer DID", "proposerDid"), ariaSort: ariaSort("proposerDid"), render: (ord) => <code title={ord.proposerDid}>{ord.proposerDid.replace("did:agent:openaimp:", "")}</code> },
      { key: "date", header: header("Date & Time", "createdAt"), ariaSort: ariaSort("createdAt"), render: (ord) => <span>{new Date(ord.createdAt).toLocaleString()}</span> },
      { key: "actions", header: "Action", render: (ord) => <Button variant="warning" tone="subtle" size="sm" type="button" onClick={() => { setRiskSubject({ title: `${ord.action} ${ord.quantity}x ${ord.symbol}`, underlyingSymbol: ord.symbol, underlyingPrice: ord.price, strategyType: `${ord.action} Trade`, sentiment: ord.action.toLowerCase().includes("buy") ? "bullish" : "bearish", quantity: ord.quantity, positionType: "EQUITY", maxLoss: ord.totalValue, breakevens: [ord.price], breakevenText: `Price: ${safePriceFormat(ord.price)}` }); }} title="Analyze risk profile for this ledger trade">🛡️ Risk</Button> },
    ];
  }, [handleSort, setRiskSubject, sort]);

  const sorted = useMemo(() => sortLedgerRows(orders, sort), [orders, sort]);
  const rowsFor = useCallback(
    (tabId: string) => (tabId === "overview" ? sorted : sorted.filter((order) => ledgerBrokerId(order) === tabId)),
    [sorted],
  );
  const empty = ordersLoading ? <Spinner label="Loading orders ledger" /> : <EmptyState title="No trade orders recorded yet." />;

  return (
    <PageShell
      title="Order Execution Ledger"
      scopeNote="Audited trade records: every executed order with its broker reference, proposer DID, and date — refresh to re-read the ledger."
    >
      <PageSection title="Order execution ledger">
        <Card>
          <Flex justify="between" align="center">
            <h4>📜 Order Execution Ledger (Audited Trade Records)</h4>
            <Button
              variant="secondary"
              disabled={ordersLoading}
              onClick={fetchOrders}
             loading={ordersLoading}>
              {"🔄 Refresh Ledger"}
            </Button>
          </Flex>

          <div>
            <Tabs
              tabs={tabs}
              value={effectiveTab}
              onChange={setActiveTab}
              ariaLabel="Ledger by broker"
              idBase="ledger"
            />
            <TabPanel idBase="ledger" tabId="overview" active={effectiveTab === "overview"}>
              <Table
                columns={columns}
                rows={rowsFor("overview")}
                rowKey={(ord) => ord.id}
                empty={empty}
              />
            </TabPanel>
            {brokerTabs.map((tab) => (
              <TabPanel key={tab.id} idBase="ledger" tabId={tab.id} active={effectiveTab === tab.id}>
                <Table
                  columns={columns}
                  rows={rowsFor(tab.id)}
                  rowKey={(ord) => ord.id}
                  empty={empty}
                />
              </TabPanel>
            ))}
          </div>
        </Card>
      </PageSection>
    </PageShell>
  );
}
