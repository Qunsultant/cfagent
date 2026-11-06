/**
 * Issue #3417 (epic #3416): the portfolio read, in one shape, from any broker.
 *
 * Why this module exists: the hub renders one portfolio hero for every broker,
 * but the two brokers answer different payloads for the same question.
 *
 *   E*TRADE  GET /api/etrade/positions  →  { account, positions }
 *   neutral  GET /api/broker/positions  →  { broker, environment, result: { account, positions } }
 *
 * The hub read only the first shape, so an Alpaca tenant's portfolio resolved
 * `account = undefined` and `positions = []` and rendered "$0.00" for a funded
 * account. A zero is a claim; unknown is not zero. Unwrapping is therefore not
 * cosmetic — it is the difference between "you have no money" and "this read
 * did not report".
 *
 * Everything here is pure and takes `unknown`, because a broker payload is
 * untrusted input: a malformed body must degrade to "not reported", never throw
 * inside a render, and never substitute a fabricated number.
 */
import type { BrokerAccount, BrokerPosition } from "../types";

/** What a portfolio surface needs, with `null` meaning "not reported". */
export interface PortfolioSummary {
  /** Total account value, else the sum of position market values. */
  readonly equity: number | null;
  /** Cash available for investment. */
  readonly cash: number | null;
  /** Margin buying power when the broker reports it, else cash. */
  readonly buyingPower: number | null;
  /** Today's gain across open positions. */
  readonly dayGain: number | null;
  /** Unrealised gain across open positions. */
  readonly unrealisedGain: number | null;
  readonly positionCount: number;
  readonly optionCount: number;
  readonly equityCount: number;
}

export interface PortfolioRead {
  readonly account: BrokerAccount | null;
  readonly positions: BrokerPosition[];
  /**
   * True when the payload actually carried a positions array. An absent array
   * is "not reported" and must not clear a previously rendered portfolio; an
   * empty array is "you hold nothing" and must.
   */
  readonly reported: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The neutral routes wrap a platform result in `{ broker, environment, result }`
 * so a caller can tell WHICH broker answered. E*TRADE's legacy routes answer
 * the platform result directly. Accept both, and prefer the explicit wrapper
 * when both are present.
 */
function unwrap(payload: unknown): unknown {
  if (isRecord(payload) && isRecord(payload.result)) return payload.result;
  return payload;
}

/** Positions array from either payload shape. A non-array is "none reported". */
export function positionsFromPayload(payload: unknown): BrokerPosition[] {
  const body = unwrap(payload);
  if (!isRecord(body)) return [];
  const positions = body.positions;
  return Array.isArray(positions) ? (positions as BrokerPosition[]) : [];
}

/** The account embedded in a positions payload, when the broker includes one. */
export function accountFromPayload(payload: unknown): BrokerAccount | null {
  const body = unwrap(payload);
  if (!isRecord(body)) return null;
  const account = body.account;
  return isRecord(account) ? (account as unknown as BrokerAccount) : null;
}

/** One read: the account (when carried) and the positions. */
export function portfolioFromPayload(payload: unknown): PortfolioRead {
  const body = unwrap(payload);
  const reported = isRecord(body) && Array.isArray(body.positions);
  return {
    account: accountFromPayload(payload),
    positions: positionsFromPayload(payload),
    reported,
  };
}

/**
 * Accounts array from either payload shape:
 *   E*TRADE  { count, accounts }
 *   neutral  { broker, environment, result: BrokerAccount[] }
 */
export function accountsFromPayload(payload: unknown): BrokerAccount[] {
  if (!isRecord(payload)) return [];
  const direct = payload.accounts;
  if (Array.isArray(direct)) return direct as BrokerAccount[];
  const result = payload.result;
  if (Array.isArray(result)) return result as BrokerAccount[];
  return [];
}

/**
 * The numbers the hero prints. `null` means the read did not report the value —
 * the surface renders an em dash, because "$0.00" for an unread account is a
 * fabricated fact (the same rule the option chain and quote reads follow).
 */
export function portfolioSummary(
  account: BrokerAccount | null,
  positions: readonly BrokerPosition[],
): PortfolioSummary {
  const positionValue = positions.reduce((sum, position) => {
    const value = asNumber(position?.marketValue);
    return sum + (value ?? 0);
  }, 0);
  const dayGain = positions.reduce((sum, position) => sum + (asNumber(position?.daysGain) ?? 0), 0);
  const unrealisedGain = positions.reduce(
    (sum, position) => sum + (asNumber(position?.unrealizedGainLoss) ?? 0),
    0,
  );

  // Nothing was read at all: every money figure is unknown, not zero.
  const read = account !== null || positions.length > 0;

  // A reported zero beside open positions is a contradiction, not a number:
  // the broker's total yields to the sum of what it just told us it holds.
  const rawEquity = account ? asNumber(account.totalAccountValue) : null;
  const reportedEquity = rawEquity !== null && rawEquity > 0 ? rawEquity : null;
  const equity = reportedEquity ?? (positionValue > 0 ? positionValue : rawEquity ?? (read ? positionValue : null));
  const cash = account ? asNumber(account.cashAvailableForInvestment) : null;
  const reportedBuyingPower = account ? asNumber(account.marginBuyingPower) : null;
  const buyingPower = reportedBuyingPower ?? cash;

  return {
    equity,
    cash,
    buyingPower,
    dayGain: read ? dayGain : null,
    unrealisedGain: read ? unrealisedGain : null,
    positionCount: positions.length,
    optionCount: positions.filter((position) => position?.securityType === "OPTN").length,
    equityCount: positions.filter((position) => position?.securityType !== "OPTN").length,
  };
}

/**
 * Money for the hero. Unknown is an em dash with the broker's name attached by
 * the caller, so the sentence reads "not reported" rather than "zero".
 */
export function formatMoney(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed money for gain/loss lines (the sign is part of the figure). */
export function formatSignedMoney(value: number | null): string {
  if (value === null) return "—";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
