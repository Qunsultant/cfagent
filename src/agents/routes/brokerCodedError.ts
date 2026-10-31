/**
 * Issue #2573: coded broker failures for the AccountPanels surfaces.
 *
 * The E*TRADE broker routes used to answer an upstream failure with
 * `Response.json({ error: upstreamError }, { status: 502 })`, where
 * `upstreamError` was `ETradeRestClient.lastError` — a hardcoded string
 * with the raw upstream body spliced in (e.g.
 * `oauth_problem=parameter_absent`). That raw body reached the UI
 * verbatim through `accountApi.ts` into `AccountPanels.tsx`.
 *
 * This module is the single translation point. It never string-matches
 * the raw error text: the broker client records a structured kind
 * (`token_missing` / `token_expired`) at the point of failure
 * (see `ETradeRestClient.getLastErrorKind`), and the route's section
 * supplies the per-section code for every other recorded failure.
 * The business message always comes from the single outcome catalog
 * via `BusinessError` — there is no second resolver and no second
 * catalog here. The raw upstream body stays in the server log lines
 * the client already emits; it never appears in the response.
 *
 * Genuine-empty semantics are unchanged: callers only call this when
 * `getLastError()` is set, so a genuine empty (no recorded error)
 * still keeps its exact previous 200 payload.
 */

import { BusinessError } from "../../outcomes/outcomeAspects";

/** The AccountPanels / portfolio sections that read the broker. */
export type BrokerSection =
  | "accounts"
  | "alerts"
  | "transactions"
  | "watchlists"
  | "orders"
  | "lookup"
  | "positions";

/** Per-section catalog code for a non-auth upstream failure. */
const SECTION_CODES: Record<BrokerSection, string> = {
  accounts: "FAILURE_ETRADE_ACCOUNTS_UNAVAILABLE",
  alerts: "FAILURE_ETRADE_ALERTS_UNAVAILABLE",
  transactions: "FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE",
  watchlists: "FAILURE_ETRADE_WATCHLISTS_UNAVAILABLE",
  orders: "FAILURE_ETRADE_ORDERS_UNAVAILABLE",
  lookup: "FAILURE_ETRADE_UPSTREAM",
  positions: "FAILURE_ETRADE_UPSTREAM",
};

/** The subset of ETradeService surface this translation needs. */
export interface BrokerCodedErrorSource {
  getLastError(): string | undefined;
  getLastErrorKind?: () => "token_missing" | "token_expired" | undefined;
}

export interface CodedBrokerFailure {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
}

/**
 * Translate a recorded broker failure into its coded form, or null
 * when no failure is recorded (genuine empty / genuine not-found).
 * Auth kinds win over the section code: a missing token is
 * `FAILURE_AUTH_TOKEN_MISSING` and a rejected token is
 * `FAILURE_AUTH_TOKEN_EXPIRED`, whatever section reported it, because
 * the remedy (reconnect) is the same in every section.
 */
export function codedBrokerFailure(
  etrade: BrokerCodedErrorSource,
  section: BrokerSection,
): CodedBrokerFailure | null {
  if (!etrade.getLastError()) return null;
  const kind = etrade.getLastErrorKind?.();
  const code =
    kind === "token_missing"
      ? "FAILURE_AUTH_TOKEN_MISSING"
      : kind === "token_expired"
        ? "FAILURE_AUTH_TOKEN_EXPIRED"
        : SECTION_CODES[section];
  const err = new BusinessError(code);
  return {
    code: err.code,
    message: err.entry ? err.entry.businessMessage : code,
    retryable: err.entry ? err.entry.retryable : false,
    status: err.entry ? err.entry.httpStatus : 502,
  };
}

/**
 * The coded failure as an HTTP response, or null when no failure is
 * recorded. The body is `{ code, message, retryable }` — the
 * `BusinessError.toJSON()` shape — never `{ error: <raw string> }`.
 */
export function brokerFailureResponse(
  etrade: BrokerCodedErrorSource,
  section: BrokerSection,
): Response | null {
  const failure = codedBrokerFailure(etrade, section);
  if (!failure) return null;
  return Response.json(
    { code: failure.code, message: failure.message, retryable: failure.retryable },
    { status: failure.status },
  );
}

/**
 * The coded failure as a single `"[CODE] message"` string, for the
 * one route that keeps a 200 envelope with an `error` field
 * (`GET /etrade/positions`, consumed by `ETradeTradingHub.tsx`).
 * Returns null when no failure is recorded.
 */
export function codedBrokerMessage(
  etrade: BrokerCodedErrorSource,
  section: BrokerSection,
): string | null {
  const failure = codedBrokerFailure(etrade, section);
  if (!failure) return null;
  return `[${failure.code}] ${failure.message}`;
}

/** Generic coded failure for an unexpected exception in a broker route. */
export function genericBrokerFailureResponse(): Response {
  const err = new BusinessError("FAILURE_ETRADE_UPSTREAM");
  return Response.json(err.toJSON(), { status: err.entry?.httpStatus ?? 502 });
}
