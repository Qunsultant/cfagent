/**
 * Account panels (issue #67; UX polish #69) — surfaces the broker account
 * endpoints that previously had no UI: alerts, transactions, watchlists,
 * and remote (broker-side) orders with cancel. Mounted in the E*TRADE
 * hub's Portfolio view next to the Portfolio Risk panel.
 *
 * UX rules (#69): every panel is collapsible and anchor-addressable from
 * the section nav; destructive actions (alert/watchlist delete, order
 * cancel) are two-step inline confirms — nothing destructive fires on a
 * single click; the unread-alert count is reported up so the app nav can
 * badge the Portfolio tab.
 *
 * Error messages (#2573): the loaders below render `err.message`
 * because `accountApi.ts` already translates every broker failure
 * into its coded form (`"[CODE] business message"`) or the generic
 * coded fallback — the raw broker error string never reaches this
 * panel. Do not reintroduce a path that renders a server `error`
 * field directly.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, TextInput } from "./components/ui";
import {
  cancelRemoteOrder,
  createWatchlist,
  deleteAlert,
  deleteWatchlist,
  fetchAlertDetails,
  fetchAlerts,
  fetchRemoteOrders,
  fetchTransactionDetails,
  fetchTransactions,
  fetchWatchlistDetails,
  fetchWatchlists,
  parseSymbolList,
  saveScreenAsWatchlist,
  type ETradeAlert,
  type ETradeAlertDetails,
  type ETradeRemoteOrder,
  type ETradeTransaction,
  type ETradeTransactionDetails,
  type ETradeWatchlist,
} from "./accountApi";
import { fmtUsd } from "./portfolioRiskApi";
import "./accountPanels.css";

const fmtTime = (epochMs: number | undefined) => (epochMs ? new Date(epochMs).toLocaleString() : "—");

interface AccountPanelsProps {
  activeEnv: string;
  onUnreadAlertsChange?: (count: number) => void;
}

export function AccountPanels({ activeEnv, onUnreadAlertsChange }: AccountPanelsProps) {
  const [open, setOpen] = useState({ alerts: true, transactions: true, watchlists: true, orders: true });
  const toggle = (key: keyof typeof open) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  // Alerts
  const [alerts, setAlerts] = useState<ETradeAlert[]>([]);
  const [alertDetail, setAlertDetail] = useState<ETradeAlertDetails | null>(null);
  const [alertsError, setAlertsError] = useState("");
  // Transactions
  const [transactions, setTransactions] = useState<ETradeTransaction[]>([]);
  const [txnDetail, setTxnDetail] = useState<ETradeTransactionDetails | null>(null);
  const [txnError, setTxnError] = useState("");
  // Watchlists
  const [watchlists, setWatchlists] = useState<ETradeWatchlist[]>([]);
  const [watchlistDetail, setWatchlistDetail] = useState<ETradeWatchlist | null>(null);
  const [watchError, setWatchError] = useState("");
  const [newListName, setNewListName] = useState("");
  const [newListSymbols, setNewListSymbols] = useState("");
  // Remote orders
  const [orders, setOrders] = useState<ETradeRemoteOrder[]>([]);
  const [ordersError, setOrdersError] = useState("");
  const [ordersMsg, setOrdersMsg] = useState("");

  const loadAlerts = useCallback(async () => {
    try {
      const data = await fetchAlerts(activeEnv);
      setAlerts(data.alerts);
      setAlertsError("");
      onUnreadAlertsChange?.(data.alerts.filter((a) => a.status === "UNREAD").length);
    } catch (err: any) {
      setAlertsError(err?.message || "Failed to load alerts");
    }
  }, [activeEnv, onUnreadAlertsChange]);

  const loadTransactions = useCallback(async () => {
    try {
      const data = await fetchTransactions(activeEnv);
      setTransactions(data.transactions);
      setTxnError("");
    } catch (err: any) {
      setTxnError(err?.message || "Failed to load transactions");
    }
  }, [activeEnv]);

  const loadWatchlists = useCallback(async () => {
    try {
      const data = await fetchWatchlists(activeEnv);
      setWatchlists(data.watchlists);
      setWatchError("");
    } catch (err: any) {
      setWatchError(err?.message || "Failed to load watchlists");
    }
  }, [activeEnv]);

  const loadOrders = useCallback(async () => {
    try {
      const data = await fetchRemoteOrders(activeEnv);
      setOrders(data.orders);
      setOrdersError("");
    } catch (err: any) {
      setOrdersError(err?.message || "Failed to load broker orders");
    }
  }, [activeEnv]);

  useEffect(() => {
    void loadAlerts();
    void loadTransactions();
    void loadWatchlists();
    void loadOrders();
  }, [loadAlerts, loadTransactions, loadWatchlists, loadOrders]);

  /** Two-step destructive action: first click arms, second click fires. */
  const destructive = (key: string, label: string, action: () => void) => (
    <Button
      type="button"
      className={confirmKey === key ? "ap-danger armed" : "ap-danger"}
      onClick={() => {
        if (confirmKey === key) {
          setConfirmKey(null);
          action();
        } else {
          setConfirmKey(key);
        }
      }}
    >
      {confirmKey === key ? `Confirm ${label}?` : label}
    </Button>
  );

  const header = (key: keyof typeof open, title: string, reload: () => void) => (
    <div className="ap-header">
      <Button type="button" className="ap-collapse" onClick={() => toggle(key)} aria-expanded={open[key]}>
        {open[key] ? "▾" : "▸"} {title}
      </Button>
      <Button type="button" onClick={reload}>↻</Button>
    </div>
  );

  const openOrders = orders.filter((o) => o.status === "OPEN");
  const unreadCount = alerts.filter((a) => a.status === "UNREAD").length;

  return (
    <>
      {/* Broker alerts */}
      <section className="ap-panel" id="section-alerts" style={{ scrollMarginTop: 80 }}>
        {header("alerts", unreadCount > 0 ? `Broker Alerts (${unreadCount} unread)` : "Broker Alerts", () => void loadAlerts())}
        {open.alerts && (
          <>
            {alertsError && <div className="ap-error">{alertsError}</div>}
            {!alertsError && alerts.length === 0 && <div className="ap-muted">No alerts.</div>}
            {alerts.map((alert) => (
              <div className="ap-row" key={String(alert.id)}>
                <Button type="button" className="ap-row-main" onClick={() => void fetchAlertDetails(activeEnv, alert.id).then(setAlertDetail).catch(() => setAlertDetail(null))}>
                  <strong className={alert.status === "UNREAD" ? "ap-unread" : undefined}>{alert.subject}</strong>
                  <span>{alert.status} · {fmtTime(alert.createTime)}</span>
                </Button>
                {destructive(`alert:${alert.id}`, "Delete", () => void deleteAlert(activeEnv, alert.id).then(() => { setAlertDetail(null); void loadAlerts(); }).catch(() => undefined))}
              </div>
            ))}
            {alertDetail && (
              <div className="ap-detail">
                <strong>{alertDetail.subject}</strong>
                {alertDetail.symbol && <span> · {alertDetail.symbol}</span>}
                <p>{alertDetail.msgText}</p>
              </div>
            )}
          </>
        )}
      </section>

      {/* Account transactions */}
      <section className="ap-panel" id="section-transactions" style={{ scrollMarginTop: 80 }}>
        {header("transactions", "Account Transactions", () => void loadTransactions())}
        {open.transactions && (
          <>
            {txnError && <div className="ap-error">{txnError}</div>}
            {!txnError && transactions.length === 0 && <div className="ap-muted">No transactions.</div>}
            {transactions.slice(0, 25).map((txn) => (
              <div className="ap-row" key={txn.transactionId}>
                <Button type="button" className="ap-row-main" onClick={() => void fetchTransactionDetails(activeEnv, txn.transactionId).then(setTxnDetail).catch(() => setTxnDetail(null))}>
                  <strong>{txn.description}</strong>
                  <span>{txn.transactionType} · {fmtTime(txn.transactionDate)} · {fmtUsd(txn.amount, 2)}</span>
                </Button>
              </div>
            ))}
            {txnDetail && (
              <div className="ap-detail">
                <strong>{txnDetail.description}</strong>
                <p>
                  {fmtUsd(txnDetail.amount, 2)}
                  {txnDetail.category ? ` · ${txnDetail.category.parentName ? `${txnDetail.category.parentName} / ` : ""}${txnDetail.category.categoryName}` : ""}
                  {txnDetail.brokerage?.product ? ` · ${txnDetail.brokerage.product.symbol} × ${txnDetail.brokerage.quantity ?? "—"} @ ${txnDetail.brokerage.price !== undefined ? fmtUsd(txnDetail.brokerage.price, 2) : "—"}` : ""}
                  {txnDetail.brokerage?.fee !== undefined ? ` · fee ${fmtUsd(txnDetail.brokerage.fee, 2)}` : ""}
                </p>
              </div>
            )}
          </>
        )}
      </section>

      {/* Watchlists */}
      <section className="ap-panel" id="section-watchlists" style={{ scrollMarginTop: 80 }}>
        {header("watchlists", "Watchlists", () => void loadWatchlists())}
        {open.watchlists && (
          <>
            {watchError && <div className="ap-error">{watchError}</div>}
            {watchlists.map((list) => (
              <div className="ap-row" key={String(list.watchlistId)}>
                <Button type="button" className="ap-row-main" onClick={() => void fetchWatchlistDetails(activeEnv, list.watchlistId).then(setWatchlistDetail).catch(() => setWatchlistDetail(null))}>
                  <strong>{list.name}</strong>
                  <span>{list.symbols.length} symbols{list.source ? ` · ${list.source === "etrade_api" ? "E*TRADE" : "local"}` : ""}</span>
                </Button>
                {destructive(`watchlist:${list.watchlistId}`, "Delete", () => void deleteWatchlist(activeEnv, list.watchlistId).then(() => { setWatchlistDetail(null); void loadWatchlists(); }).catch(() => undefined))}
              </div>
            ))}
            {watchlistDetail && (
              <div className="ap-detail">
                <strong>{watchlistDetail.name}</strong>
                <p>{(watchlistDetail.items?.map((i) => i.symbol) ?? watchlistDetail.symbols).join(", ") || "No symbols."}</p>
              </div>
            )}
            <div className="ap-form">
              <TextInput value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="New watchlist name" />
              <TextInput value={newListSymbols} onChange={(e) => setNewListSymbols(e.target.value)} placeholder="Symbols (AAPL, MSFT …)" />
              <Button type="button" disabled={!newListName.trim()} onClick={() => void createWatchlist(activeEnv, newListName.trim(), parseSymbolList(newListSymbols)).then(() => { setNewListName(""); setNewListSymbols(""); void loadWatchlists(); }).catch((err: any) => setWatchError(err?.message || "Create failed"))}>Create</Button>
              <Button type="button" disabled={!newListName.trim()} onClick={() => void saveScreenAsWatchlist(activeEnv, newListName.trim(), parseSymbolList(newListSymbols)).then(() => { setNewListName(""); setNewListSymbols(""); void loadWatchlists(); }).catch((err: any) => setWatchError(err?.message || "Save-screen failed"))}>Save as screen</Button>
            </div>
          </>
        )}
      </section>

      {/* Broker (remote) orders */}
      <section className="ap-panel" id="section-orders" style={{ scrollMarginTop: 80 }}>
        {header("orders", "Broker Orders", () => void loadOrders())}
        {open.orders && (
          <>
            {ordersError && <div className="ap-error">{ordersError}</div>}
            {ordersMsg && <div className="ap-note">{ordersMsg}</div>}
            {!ordersError && orders.length === 0 && <div className="ap-muted">No broker orders.</div>}
            {orders.slice(0, 25).map((order) => (
              <div className="ap-row" key={String(order.orderId)}>
                <div className="ap-row-main static">
                  <strong>{order.symbol ?? "—"} {order.orderAction ?? ""} {order.quantity ?? ""}</strong>
                  <span>{order.status} · {order.orderType}{order.limitPrice !== undefined ? ` @ ${fmtUsd(order.limitPrice, 2)}` : ""} · {fmtTime(order.placedTime)} · #{String(order.orderId)}</span>
                </div>
                {order.status === "OPEN" && destructive(`order:${order.orderId}`, "Cancel", () => void cancelRemoteOrder(activeEnv, order.orderId).then((res) => { setOrdersMsg(res.message); void loadOrders(); }).catch((err: any) => setOrdersError(err?.message || "Cancel failed")))}
              </div>
            ))}
            {openOrders.length > 0 && <div className="ap-note">{openOrders.length} open order(s) at the broker.</div>}
          </>
        )}
      </section>
    </>
  );
}
