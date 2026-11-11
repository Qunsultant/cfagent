/**
 * Trade execution preview (Qunsultant/cfagent#1773, item 6;
 * OWASP ASI-02 action transparency).
 *
 * Before a trade executes, the approval surface must show the EXACT
 * execution payload, the fees, and the slippage limits — not a
 * summary. The exact payload is the body
 * ETradeTradingHub.handleExecuteDraft POSTs to
 * /api/broker/order/execute. Execution itself is driven by the
 * stored draft (src/agents/routes/etradeBroker.ts re-reads the
 * record and checks the body's action/symbol/quantity against it),
 * so the preview also restates the draft terms the server will
 * execute. Fees: the draft carries exactly one fee field
 * (estimatedCommission) — the preview states it and admits other
 * fees are not itemized, rather than inventing them. Slippage: a
 * LIMIT bounds the fill at the limit price; a MARKET order has no
 * bound and the preview must say so, never imply one.
 */

export interface TradeExecutionDraft {
  orderId: string;
  previewId?: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderAction: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  brokerOrderType?: "EQ" | "OPTN" | "SPREADS" | "BUY_WRITES";
  optionLegs?: Array<{
    underlyingSymbol: string;
    securityType: "EQ" | "OPTN";
    side: "BUY" | "SELL";
    quantity: number;
    optionType?: "CALL" | "PUT";
    strike?: number;
    expirationDate?: string;
  }>;
  strategyNetDebit?: number;
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  quantity: number;
  /** Optional: voice-surface drafts may carry a subset of the full draft. */
  estimatedPrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  term?: "GOOD_FOR_DAY" | "GOOD_UNTIL_CANCEL";
  estimatedCommission: number;
  estimatedTotal?: number;
  pricingQuoteStatus?: string;
}

export interface ExecutePayload {
  orderId: string;
  draftId: string;
  decision: "approved";
  symbol: string;
  action: string;
  quantity: number;
  orderType: string;
  limitPrice?: number;
  previewId?: string;
}

/** Byte-for-byte the body handleExecuteDraft sends (undefined fields omitted, as JSON.stringify omits them). */
export function buildExecutePayload(draft: TradeExecutionDraft): ExecutePayload {
  const payload: ExecutePayload = {
    orderId: draft.orderId,
    draftId: draft.orderId,
    decision: "approved",
    symbol: draft.symbol,
    action: draft.orderAction || draft.action,
    quantity: draft.quantity,
    orderType: draft.orderType,
  };
  if (draft.limitPrice !== undefined) payload.limitPrice = draft.limitPrice;
  if (draft.previewId !== undefined && String(draft.previewId).trim() !== "") {
    payload.previewId = String(draft.previewId);
  }
  return payload;
}

function usd(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface TradeExecutionPreviewData {
  payload: ExecutePayload;
  payloadJson: string;
  terms: string[];
  fees: string[];
  slippage: { bounded: boolean; limit: string };
  warnings: string[];
}

export function buildTradeExecutionPreview(draft: TradeExecutionDraft): TradeExecutionPreviewData {
  const payload = buildExecutePayload(draft);
  const payloadJson = JSON.stringify(payload, null, 2);

  const terms = [
    `${draft.orderAction || draft.action} ${draft.quantity} ${draft.symbol} · ${draft.orderType} · ${draft.term ?? "term not stated by this draft"}`,
    ...(draft.limitPrice !== undefined ? [`Limit price: ${usd(draft.limitPrice)}`] : []),
    ...(draft.stopPrice !== undefined ? [`Stop price: ${usd(draft.stopPrice)}`] : []),
    ...(draft.optionLegs ?? []).map((leg) =>
      leg.securityType === "EQ"
        ? `${leg.side} ${leg.quantity} ${leg.underlyingSymbol} shares`
        : `${leg.side} ${leg.quantity} ${leg.underlyingSymbol} ${leg.optionType ?? ""} $${leg.strike ?? ""} ${leg.expirationDate ?? ""}`.trim(),
    ),
    ...(draft.strategyNetDebit !== undefined
      ? [
          draft.strategyNetDebit < 0
            ? `Strategy net credit: ${usd(Math.abs(draft.strategyNetDebit))} per unit`
            : `Strategy net debit: ${usd(draft.strategyNetDebit)} per unit`,
        ]
      : []),
    draft.previewId
      ? `Broker preview #${draft.previewId} (verified)`
      : "No broker preview id on this draft",
  ];

  const fees = [
    draft.estimatedCommission > 0
      ? `Commission (as stated by the preview): ${usd(draft.estimatedCommission)} broker estimate`
      : draft.optionLegs?.length
        ? "Commission (as stated by the preview): See E*TRADE account disclosure"
        : "Commission (as stated by the preview): $0.00 (E*TRADE Online)",
    draft.estimatedTotal !== undefined
      ? `Estimated total (price × quantity): ${usd(draft.estimatedTotal)}`
      : "Estimated total: not stated by this draft",
    "Other fees: not itemized by the preview response — the draft carries no other fee field; see the E*TRADE account disclosure for any additional fees.",
  ];

  let slippage: { bounded: boolean; limit: string };
  if (draft.orderType === "LIMIT" && draft.limitPrice !== undefined) {
    slippage = {
      bounded: true,
      limit: `Bounded at the limit price ${usd(draft.limitPrice)} — a limit fill cannot execute beyond it.`,
    };
  } else if (draft.orderType === "STOP_LIMIT" && draft.limitPrice !== undefined) {
    slippage = {
      bounded: true,
      limit: `Bounded at the limit price ${usd(draft.limitPrice)} once the stop price ${draft.stopPrice !== undefined ? usd(draft.stopPrice) : "triggers"} — fills cannot execute beyond the limit.`,
    };
  } else if (draft.orderType === "STOP") {
    slippage = {
      bounded: false,
      limit: `No slippage limit after the stop triggers — a stop order becomes a market order and can fill beyond the stop price ${draft.stopPrice !== undefined ? usd(draft.stopPrice) : ""}.`.trim(),
    };
  } else {
    slippage = {
      bounded: false,
      limit: "No slippage limit — a market order fills at whatever price the market offers; the estimated price is not a bound.",
    };
  }

  const warnings: string[] = [];
  if (draft.pricingQuoteStatus && draft.pricingQuoteStatus !== "REALTIME") {
    warnings.push(
      `Priced from a non-live quote (${draft.pricingQuoteStatus}) — refresh the preview before approving.`,
    );
  }
  if (!draft.previewId) {
    warnings.push("No broker preview id — this draft was not broker-verified; execution still goes through the stored draft.");
  }
  if (!slippage.bounded) {
    warnings.push("This order type carries no slippage limit (see slippage limits above).");
  }

  return { payload, payloadJson, terms, fees, slippage, warnings };
}
