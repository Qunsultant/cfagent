import React, { useEffect, useState } from "react";
import { Badge, Card, EmptyState, Flex, Notice, Spinner, Stack, Table } from "./components/ui";
import type { BrokerAccount, BrokerPosition, BrokerStatus } from "../types";
import {
  brokerCredentialGuidance,
  tradingTypeFor,
  type TradingEnvironment,
} from "../trading/brokerCatalog";
import { BrokerSurfaceGate } from "./BrokerSurfaceGate";
import { AlpacaSignInCard } from "./AlpacaSignInCard";

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

function useBrokerRead<T>(path: string): ReadState<T> {
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
  }, [path]);

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
  const accounts = useBrokerRead<AccountsPayload>("/broker/accounts");
  const positions = useBrokerRead<PositionsPayload>("/broker/positions");
  const status = useBrokerRead<StatusPayload>("/broker/status");

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
      <AlpacaSignInCard activeEnv={activeEnv} />

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
                  Set {guidanceEnvNames.join(", ")} for {tradingType ?? "paper"} trading. The key and secret are deployment
                  secrets; this surface never asks for them.
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

      <Card>
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
    </Stack>
  );
}
