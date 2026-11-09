import React, { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, Flex, Notice, Spinner, Stack, Table } from "./components/ui";
import type { BrokerAccount, BrokerPosition, BrokerStatus } from "../types";
import {
  brokerCredentialGuidance,
  tradingTypeFor,
  type TradingEnvironment,
} from "../trading/brokerCatalog";
import { BrokerSurfaceGate } from "./BrokerSurfaceGate";
import { AlpacaSignInCard } from "./AlpacaSignInCard";
import { AlpacaCancelAllControl } from "./AlpacaCancelAllControl";

/**
 * Issue #2853 (gap G2): the first non-E*TRADE panel under the broker panel contract.
 *
 * Why it exists: the hub renders E*TRADE panels regardless of the selected
 * broker, so an Alpaca tenant sees another broker's screens. This panel is the
 * Alpaca surface the contract promises — accounts and positions read through
 * the neutral routes (`/broker/accounts`, `/broker/positions`, #2853), named
 * with Alpaca's own label and its trading type.
 *
 * Honesty rules, inherited from the contract:
 *   - every surface goes through `BrokerSurfaceGate`, so a capability Alpaca
 *     lacks is a named notice, not an empty table;
 *   - a failed or disabled read is stated with its code — the panel never
 *     renders placeholder accounts or positions;
 *   - nothing here reads E*TRADE state; switching brokers means switching
 *     panels, not filtering one broker's data through another's labels.
 *
 * Styling: `ui/` primitives only (Card / Flex / Stack / Table / Badge /
 * Notice / EmptyState / Spinner) — no inline styles, per the #3047 budget.
 */

type ReadState<T> =
  | { state: "loading" }
  | { state: "error"; code: string | null; message: string }
  | { state: "ready"; environment: TradingEnvironment; data: T };

interface AccountsPayload {
  broker: string;
  environment: TradingEnvironment;
  result: BrokerAccount[];
}

interface PositionsPayload {
  broker: string;
  environment: TradingEnvironment;
  result: { account: BrokerAccount; positions: BrokerPosition[] };
}

interface StatusPayload {
  broker: string;
  environment: TradingEnvironment;
  status: BrokerStatus;
}

/**
 * Issue #3359: the account-history reads. Both are the broker's own records -
 * order history from `GET /v2/orders`, activity from `GET /v2/account/activities`
 * - mapped by the adapter onto neutral rows and scoped here by the selection.
 */
interface OrderHistoryPayload {
  broker: string;
  environment: TradingEnvironment;
  status: string;
  orders: Array<{
    orderId: string | number;
    orderType: string;
    status: string;
    rawStatus?: string;
    placedTime?: number;
    quantity?: number;
    limitPrice?: number;
    symbol?: string;
    orderAction?: string;
  }>;
}

interface ActivityPayload {
  broker: string;
  environment: TradingEnvironment;
  activities: Array<{
    activityId: string;
    activityType: string;
    activityDate: number;
    symbol?: string;
    quantity?: number;
    price?: number;
    netAmount?: number;
    orderId?: string;
  }>;
}

interface WatchlistsPayload {
  broker: string;
  environment: TradingEnvironment;
  watchlists: Array<{ watchlistId: string | number; name: string; symbols: string[] }>;
}

function fmtWhen(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "-";
  return new Date(value).toLocaleString();
}

function fmtNum(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "-" : String(value);
}

function fmtMoney(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "-"
    : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ORDER_HISTORY_COLUMNS = [
  { key: "symbol", header: "Symbol", render: (row: OrderHistoryPayload["orders"][number]) => row.symbol ?? "-" },
  { key: "side", header: "Side", render: (row: OrderHistoryPayload["orders"][number]) => row.orderAction ?? "-" },
  {
    key: "qty",
    header: "Qty",
    align: "right" as const,
    render: (row: OrderHistoryPayload["orders"][number]) => fmtNum(row.quantity),
  },
  { key: "type", header: "Type", render: (row: OrderHistoryPayload["orders"][number]) => row.orderType },
  {
    key: "status",
    header: "Status",
    // An unrecognised broker status is shown in the broker's own words, so the
    // table never implies a state the platform did not establish.
    render: (row: OrderHistoryPayload["orders"][number]) =>
      row.status === "UNKNOWN" && row.rawStatus ? `UNKNOWN (${row.rawStatus})` : row.status,
  },
  { key: "placed", header: "Placed", render: (row: OrderHistoryPayload["orders"][number]) => fmtWhen(row.placedTime) },
];

const ACTIVITY_COLUMNS = [
  { key: "when", header: "Date", render: (row: ActivityPayload["activities"][number]) => fmtWhen(row.activityDate) },
  { key: "type", header: "Type", render: (row: ActivityPayload["activities"][number]) => row.activityType },
  { key: "symbol", header: "Symbol", render: (row: ActivityPayload["activities"][number]) => row.symbol ?? "-" },
  {
    key: "qty",
    header: "Qty",
    align: "right" as const,
    render: (row: ActivityPayload["activities"][number]) => fmtNum(row.quantity),
  },
  {
    key: "price",
    header: "Price",
    align: "right" as const,
    render: (row: ActivityPayload["activities"][number]) => fmtMoney(row.price),
  },
  {
    key: "net",
    header: "Net",
    align: "right" as const,
    render: (row: ActivityPayload["activities"][number]) => fmtMoney(row.netAmount),
  },
];

const ACCOUNT_COLUMNS = [
  { key: "accountDesc", header: "Account", render: (a: BrokerAccount) => a.accountDesc },
  { key: "accountType", header: "Type", render: (a: BrokerAccount) => a.accountType },
  { key: "accountId", header: "ID", render: (a: BrokerAccount) => a.accountId },
];

const POSITION_COLUMNS = [
  { key: "symbol", header: "Symbol", render: (p: BrokerPosition) => p.symbol },
  { key: "description", header: "Description", render: (p: BrokerPosition) => p.description },
  { key: "quantity", header: "Qty", align: "right" as const, render: (p: BrokerPosition) => String(p.quantity) },
  {
    key: "costBasis",
    header: "Cost basis",
    align: "right" as const,
    render: (p: BrokerPosition) => (p.costBasis === undefined ? "—" : String(p.costBasis)),
  },
];

function readFailure(body: unknown): { code: string | null; message: string } {
  const record = (body ?? {}) as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : null;
  const message = typeof record.message === "string" ? record.message : "The broker read did not succeed.";
  return { code, message };
}

function useBrokerRead<T>(path: string, nonce = 0): ReadState<T> {
  const [read, setRead] = useState<ReadState<T>>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api${path}`, { headers: { Accept: "application/json" } });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          const failure = readFailure(body);
          setRead({ state: "error", code: failure.code, message: failure.message });
          return;
        }
        const payload = body as T & { environment: TradingEnvironment };
        setRead({ state: "ready", environment: payload.environment, data: payload });
      } catch {
        if (!cancelled) {
          setRead({ state: "error", code: null, message: "The broker could not be reached." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  return read;
}

function ReadFailure({ code, message }: { code: string | null; message: string }) {
  const disabled = code === "FEATURE_DISABLED";
  return (
    <Notice tone={disabled ? "neutral" : "danger"} title={disabled ? "Broker panels are disabled" : "Broker read failed"}>
      <span data-broker-code={code ?? "unavailable"}>{message}</span>
      {code && <span> ({code})</span>}
    </Notice>
  );
}

export interface AlpacaBrokerPanelProps {
  /** Passed by the hub for parity; the server resolves the environment itself. */
  activeEnv?: string;
}

export function AlpacaBrokerPanel({ activeEnv }: AlpacaBrokerPanelProps) {
  // Issue #3390: a cancelled order must disappear from the table, so the read
  // is retriggered by a nonce instead of a page reload.
  const [orderHistoryNonce, setOrderHistoryNonce] = useState(0);
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const accounts = useBrokerRead<AccountsPayload>("/broker/accounts");
  const positions = useBrokerRead<PositionsPayload>("/broker/positions");
  const status = useBrokerRead<StatusPayload>("/broker/status");
  // Issue #3359: the broker's own history reads. `status=all` because a
  // reconciliation view needs closed orders as much as open ones.
  const orderHistory = useBrokerRead<OrderHistoryPayload>("/broker/orders/history?status=all", orderHistoryNonce);
  const activity = useBrokerRead<ActivityPayload>("/broker/activities");
  // Issue #3434: the account's own saved lists — a real Alpaca read, so the
  // surface is data rather than a catalogued refusal.
  const watchlists = useBrokerRead<WatchlistsPayload>("/broker/watchlists");

  /**
   * Issue #3390: cancel through the neutral route. The server resolves the
   * broker from the selection; a refusal keeps the row visible and reports the
   * broker's own words rather than a generic failure.
   */
  const cancelOrder = useCallback(async (orderId: string) => {
    setCancelBusy(orderId);
    setCancelMessage(null);
    try {
      const res = await fetch("/api/broker/order/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
      const message =
        typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : null;
      setCancelMessage(message ?? (res.ok ? "Cancel requested." : "The broker did not cancel that order."));
      if (res.ok) setOrderHistoryNonce((n) => n + 1);
    } catch {
      setCancelMessage("Alpaca could not be reached. The order may still be open.");
    } finally {
      setCancelBusy(null);
    }
  }, []);

  const environment =
    accounts.state === "ready"
      ? accounts.environment
      : positions.state === "ready"
        ? positions.environment
        : status.state === "ready"
          ? status.environment
          : null;
  const tradingType = environment ? tradingTypeFor("alpaca", environment) : null;

  // Issue #3330: Alpaca signs in with a key pair, not E*TRADE's OAuth redirect.
  // The guidance comes from the catalogue's declaration (#3232) so the surface
  // asks for the credential kind the broker actually uses — and names the
  // deployment variables, because the browser never handles the secret.
  const guidance = brokerCredentialGuidance("alpaca");
  const guidanceEnvNames = tradingType ? guidance.envNames[tradingType] : guidance.envNames.paper;
  const configured = status.state === "ready" ? status.data.status?.configured === true : null;

  return (
    <Stack gap="3" data-broker="alpaca" data-broker-panel="alpaca" data-active-env={activeEnv ?? ""}>
      {/* Issue #3351: sign-in comes first on a broker panel — whose account is
          connected is the question every number below depends on. */}
      <AlpacaSignInCard activeEnv={activeEnv} collapsedWhenConfigured={true} />

      <Card>
        <Flex align="center" gap="2">
          <h4>Connection</h4>
          {configured !== null && (
            <Badge tone={configured ? "success" : "warning"} size="sm">
              {configured ? "Configured" : "Not configured"}
            </Badge>
          )}
          {status.state === "ready" && status.data.status?.apiUrl && (
            <Badge tone="neutral" size="sm">
              {status.data.status.apiUrl}
            </Badge>
          )}
        </Flex>
        {status.state === "loading" && <Spinner size="sm" label="Loading Alpaca connection status" />}
        {status.state === "error" && <ReadFailure code={status.code} message={status.message} />}
        {status.state === "ready" && (
          <Stack gap="2">
            <p data-broker-credential-kind={guidance.kind}>{guidance.summary}</p>
            {configured === false && (
              <Notice tone="warning" title="Alpaca credentials are not set">
                <span data-broker-credential-vars={guidanceEnvNames.join(",")}>
                  Sign in above with your own key pair to trade your own Alpaca account, or configure{" "}
                  {guidanceEnvNames.join(", ")} for {tradingType ?? "paper"} trading. The server verifies a pair
                  before storing it and never shows the secret again.
                </span>
              </Notice>
            )}
          </Stack>
        )}
      </Card>

      <Card>
        <Flex align="center" gap="2">
          <h4>Alpaca</h4>
          {tradingType && (
            <Badge tone={tradingType === "live" ? "warning" : "info"} size="sm">
              {tradingType === "live" ? "Live trading" : "Paper trading"}
            </Badge>
          )}
        </Flex>

        <BrokerSurfaceGate broker="alpaca" surface="accounts">
          {accounts.state === "loading" && <Spinner size="sm" label="Loading Alpaca accounts" />}
          {accounts.state === "error" && <ReadFailure code={accounts.code} message={accounts.message} />}
          {accounts.state === "ready" && (
            <Table
              caption="Alpaca accounts"
              columns={ACCOUNT_COLUMNS}
              rows={accounts.data.result ?? []}
              rowKey={(row) => row.accountId}
              empty={<EmptyState title="No Alpaca accounts" description="The broker returned no accounts for this login." framed />}
            />
          )}
        </BrokerSurfaceGate>
      </Card>

      <Card id="section-positions" className="ui-anchor">
        <BrokerSurfaceGate broker="alpaca" surface="positions">
          {positions.state === "loading" && <Spinner size="sm" label="Loading Alpaca positions" />}
          {positions.state === "error" && <ReadFailure code={positions.code} message={positions.message} />}
          {positions.state === "ready" && (
            <Table
              caption="Alpaca positions"
              columns={POSITION_COLUMNS}
              rows={positions.data.result?.positions ?? []}
              rowKey={(row) => row.symbol}
              empty={<EmptyState title="No Alpaca positions" description="The broker reported no open positions." framed />}
            />
          )}
        </BrokerSurfaceGate>
      </Card>

      {/* Issue #3359: the broker's own order history. */}
      <Card id="section-order-history" className="ui-anchor">
        <Flex align="center" gap="2">
          <h4>Order history</h4>
          {/* Issue #3885: cancel every open order — preview first, then the
              token, then the table refreshes only on a confirmed cancel. */}
          <AlpacaCancelAllControl
            openOrders={
              orderHistory.state === "ready"
                ? (orderHistory.data.orders ?? []).filter((row) => row.status === "OPEN").length
                : 0
            }
            onCancelled={() => setOrderHistoryNonce((n) => n + 1)}
          />
        </Flex>
        <BrokerSurfaceGate broker="alpaca" surface="orderHistory">
          {orderHistory.state === "loading" && <Spinner size="sm" label="Loading Alpaca order history" />}
          {orderHistory.state === "error" && (
            <ReadFailure code={orderHistory.code} message={orderHistory.message} />
          )}
          {cancelMessage && (
            <Notice tone="neutral" title="Cancel">
              <span data-alpaca-cancel-message>{cancelMessage}</span>
            </Notice>
          )}
          {orderHistory.state === "ready" && (
            <Table
              caption="Alpaca order history"
              columns={[
                ...ORDER_HISTORY_COLUMNS,
                {
                  key: "cancel",
                  header: "",
                  render: (row: OrderHistoryPayload["orders"][number]) =>
                    row.status === "OPEN" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={cancelBusy === String(row.orderId)}
                        loading={cancelBusy === String(row.orderId)}
                        onClick={() => void cancelOrder(String(row.orderId))}
                      >
                        Cancel
                      </Button>
                    ) : null,
                },
              ]}
              rows={orderHistory.data.orders ?? []}
              rowKey={(row) => String(row.orderId)}
              empty={
                <EmptyState
                  title="No Alpaca orders"
                  description="The broker returned no orders in its retained window."
                  framed
                />
              }
            />
          )}
        </BrokerSurfaceGate>
      </Card>

      {/* Issue #3359: the broker's own account activity, in its own vocabulary. */}
      <Card id="section-activity" className="ui-anchor">
        <Flex align="center" gap="2">
          <h4>Account activity</h4>
        </Flex>
        <BrokerSurfaceGate broker="alpaca" surface="activity">
          {activity.state === "loading" && <Spinner size="sm" label="Loading Alpaca account activity" />}
          {activity.state === "error" && <ReadFailure code={activity.code} message={activity.message} />}
          {activity.state === "ready" && (
            <Table
              caption="Alpaca account activity"
              columns={ACTIVITY_COLUMNS}
              rows={activity.data.activities ?? []}
              rowKey={(row) => row.activityId}
              empty={
                <EmptyState
                  title="No Alpaca activity"
                  description="The broker returned no activity in its retained window."
                  framed
                />
              }
            />
          )}
        </BrokerSurfaceGate>
      </Card>

      {/* Issue #3359: the two surfaces Alpaca does not serve. The gate renders the
          catalogued, named refusal; these children never mount. */}
      <BrokerSurfaceGate broker="alpaca" surface="alerts">
        <Card>
          <h4>Alerts</h4>
        </Card>
      </BrokerSurfaceGate>

      <Card id="section-watchlists" className="ui-anchor">
        <Flex align="center" gap="2">
          <h4>Watchlists</h4>
        </Flex>
        <BrokerSurfaceGate broker="alpaca" surface="watchlists">
          {watchlists.state === "loading" && <Spinner size="sm" label="Loading Alpaca watchlists" />}
          {watchlists.state === "error" && <ReadFailure code={watchlists.code} message={watchlists.message} />}
          {watchlists.state === "ready" && (
            <Table
              caption="Alpaca watchlists"
              columns={[
                { key: "name", header: "Name", render: (row) => <span>{row.name}</span> },
                {
                  key: "symbols",
                  header: "Symbols",
                  render: (row) => <span>{row.symbols.length > 0 ? row.symbols.join(", ") : "None"}</span>,
                },
              ]}
              rows={watchlists.data.watchlists ?? []}
              rowKey={(row) => String(row.watchlistId)}
              empty={
                <EmptyState
                  title="No Alpaca watchlists"
                  description="Alpaca returned no saved lists for this account."
                  framed
                />
              }
            />
          )}
        </BrokerSurfaceGate>
      </Card>
    </Stack>
  );
}
