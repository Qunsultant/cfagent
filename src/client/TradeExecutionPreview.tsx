/**
 * Trade execution preview (Qunsultant/cfagent#1773, item 6;
 * OWASP ASI-02). Renders the exact execution payload, fees, and
 * slippage limits from src/client/tradeExecutionPreview.ts, inside
 * a Card ui primitive with no inline styles (the #2177
 * bespoke-styling ceiling counts every inline-style prop; the
 * payload block reuses the existing .code-block class) and no raw
 * controls (the #1580 freeze/density gates scan this file). The
 * payload JSON renders through React text nodes, never innerHTML,
 * so draft content cannot execute as markup.
 */
import React from "react";
import { Card } from "./components/ui";
import {
  buildTradeExecutionPreview,
  type TradeExecutionDraft,
} from "./tradeExecutionPreviewModel";

export function TradeExecutionPreview({ draft }: { draft: TradeExecutionDraft }) {
  const preview = buildTradeExecutionPreview(draft);
  return (
    <Card padding="sm">
      <h4>
        Execution preview — what approving sends
      </h4>
      <div>
        <strong>
          Exact execution payload (POST /api/broker/order/execute)
        </strong>
        <pre className="code-block">
          <code>{preview.payloadJson}</code>
        </pre>
      </div>
      <div>
        <strong>
          Terms the server will execute (from the stored draft)
        </strong>
        <ul>
          {preview.terms.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div>
        <strong>Fees</strong>
        <ul>
          {preview.fees.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div>
        <strong>Slippage limits</strong>
        <p>{preview.slippage.limit}</p>
      </div>
      {preview.warnings.length > 0 && (
        <div role="alert">
          <strong>Warnings</strong>
          <ul>
            {preview.warnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
