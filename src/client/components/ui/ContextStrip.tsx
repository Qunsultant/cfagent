import React from "react";
import { Badge } from "./Badge";
import { Flex } from "./Flex";

export type ContextStripChangeTone = "positive" | "negative" | "neutral";

export interface ContextStripProps {
  /** Company or symbol label — the strip renders nothing without it (§1.6b). */
  company: string;
  /** Price text, already formatted by the page (e.g. "$338.32"). */
  price: string;
  /** Change text, already formatted (e.g. "+1.23 (0.36%)"). */
  change?: string;
  changeTone?: ContextStripChangeTone;
  /** Bid/ask text, already formatted (e.g. "Bid: $338.30 / Ask: $338.35"). */
  bidAsk?: string;
  /** Quote freshness (e.g. "REALTIME"). */
  status?: string;
  /** Quote source (e.g. the broker name). */
  source?: string;
}

/**
 * ContextStrip (#3132, Part of #2150)
 * The live-context slot (design-system §1.6b slot 2): the order quote
 * peek (OrderTicketPanel.tsx:557) rebuilt as a primitive. Same children
 * in the same order — company + status pill, price, change, bid/ask,
 * source badge — on the same sunken strip. One deliberate delta from
 * the original: no outer margin (slot spacing is the template's Stack
 * gap, §1.6b). Pages migrate onto it in Wave 1 (#3138–#3140); this
 * slice builds the organism only.
 */
export function ContextStrip({
  company,
  price,
  change,
  changeTone = "neutral",
  bidAsk,
  status,
  source,
}: ContextStripProps) {
  if (!company) return null;
  return (
    <div className="ui-context-strip">
      <Flex justify="between" align="center">
        <span>{company}</span>
        {status && (
          <Badge tone={status === "REALTIME" ? "success" : "neutral"} dot>
            {status}
          </Badge>
        )}
      </Flex>
      <strong>{price}</strong>
      {change !== undefined ? (
        <span
          className={
            changeTone === "positive"
              ? "ui-success"
              : changeTone === "negative"
                ? "ui-danger"
                : undefined
          }
        >
          {change}
        </span>
      ) : (
        <span>—</span>
      )}
      {bidAsk && <span>{bidAsk}</span>}
      {source && <Badge tone="accent">✓ {source}</Badge>}
    </div>
  );
}
